/**
 * Адаптер інтеграції конвеєра даних (КП 3) з Eclipse Ditto.
 *
 * Підписується на зміни стану двійника в сервісі синхронізації й переносить їх
 * у властивості відповідних двійників Ditto. Зміни групуються за двійниками:
 * один запит на двійник замість одного запиту на властивість.
 */
import type { StateUpdate } from '../sync/state-store.ts';
import type { DittoClient } from './client.ts';
import { DITTO_TARGETS, readStateValue } from './mapping.ts';
import { thingId } from './models.ts';

/** Незаписані зміни: двійник → feature → властивість → значення. */
type PendingChanges = Map<string, Map<string, Map<string, unknown>>>;

/** Через скільки повторювати запис, якщо Ditto недоступний, мс. */
const RETRY_DELAY_MS = 2000;

export class DittoAdapter {
  private pending: PendingChanges = new Map();
  private sending = false;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Чи передано в Ditto повний стан хоча б раз. */
  private initialSyncDone = false;

  /** Статистика для виводу в консоль: скільки запитів надіслано й скільки помилок. */
  readonly stats = { requests: 0, properties: 0, errors: 0 };

  constructor(private readonly client: DittoClient) {}

  /** Підписник стану двійника: додає зміни в чергу й запускає відправку. */
  handle(update: StateUpdate): void {
    // Перше оновлення — повна синхронізація: у Ditto потрапляють і значення, які ще жодного разу
    // не змінювалися (наприклад, рівень вібрації normal), і застарілі значення з попередніх запусків
    if (!this.initialSyncDone) {
      this.initialSyncDone = true;
      for (const [path, target] of DITTO_TARGETS) {
        this.setPending(thingId(target.thing), target.feature, target.property, readStateValue(update.state, path));
      }
    }

    for (const change of update.changes) {
      const target = DITTO_TARGETS.get(change.path);
      if (!target) continue;
      this.setPending(thingId(target.thing), target.feature, target.property, change.value);
    }
    void this.send();
  }

  /**
   * Надсилає накопичені зміни. Поки йде відправка, нові зміни чекають у черзі
   * й підуть наступною порцією. Якщо Ditto недоступний, зміни повертаються в чергу.
   */
  private async send(): Promise<void> {
    if (this.sending || this.pending.size === 0) return;
    this.sending = true;
    const batch = this.pending;
    this.pending = new Map();

    const entries = [...batch];
    const results = await Promise.allSettled(entries.map(([id, features]) => this.sendThing(id, features)));

    const failed = entries.filter((_, index) => results[index]?.status === 'rejected');
    const firstError = results.find((result) => result.status === 'rejected');
    if (firstError) {
      this.stats.errors += failed.length;
      console.error(`Ditto: не вдалося оновити двійники (${String(firstError.reason)}), повторю пізніше`);
    }

    // Невдалі зміни повертаємо в чергу, але не перезаписуємо новіші значення, що встигли надійти
    for (const [id, features] of failed) {
      for (const [feature, properties] of features) {
        for (const [property, value] of properties) {
          if (!this.pending.get(id)?.get(feature)?.has(property)) this.setPending(id, feature, property, value);
        }
      }
    }

    this.sending = false;
    if (failed.length > 0) this.scheduleRetry();
    else void this.send(); // за час відправки могли накопичитися нові зміни
  }

  /**
   * Оновлює один двійник. Ненульові значення — одним запитом JSON Merge Patch.
   * Значення null окремими запитами: у Merge Patch null означає «видалити поле»,
   * а нам потрібно зберегти властивість зі значенням null («немає даних»).
   */
  private async sendThing(id: string, features: Map<string, Map<string, unknown>>): Promise<void> {
    const patch: Record<string, { properties: Record<string, unknown> }> = {};
    const nulls: [string, string][] = [];

    for (const [feature, properties] of features) {
      for (const [property, value] of properties) {
        if (value === null) {
          nulls.push([feature, property]);
        } else {
          patch[feature] ??= { properties: {} };
          patch[feature].properties[property] = value;
        }
        this.stats.properties++;
      }
    }

    if (Object.keys(patch).length > 0) {
      await this.client.mergeThing(id, { features: patch });
      this.stats.requests++;
    }
    for (const [feature, property] of nulls) {
      await this.client.putProperty(id, feature, property, null);
      this.stats.requests++;
    }
  }

  private setPending(id: string, feature: string, property: string, value: unknown): void {
    const features = this.pending.get(id) ?? new Map<string, Map<string, unknown>>();
    const properties = features.get(feature) ?? new Map<string, unknown>();
    properties.set(property, value);
    features.set(feature, properties);
    this.pending.set(id, features);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.send();
    }, RETRY_DELAY_MS);
  }
}
