/**
 * Мінімальний клієнт HTTP API Eclipse Ditto (версія API 2).
 * Автентифікація — basic auth через nginx демо-конфігурації Ditto.
 */
import { config } from '../config.ts';
import type { ThingModel } from './models.ts';

/** Двійник у тому вигляді, в якому його повертає Ditto. */
export interface Thing {
  thingId: string;
  policyId?: string;
  attributes?: Record<string, unknown>;
  features?: Record<string, { properties?: Record<string, unknown> }>;
}

export class DittoClient {
  private readonly apiUrl = `${config.ditto.url}/api/2`;
  private readonly authorization =
    'Basic ' + Buffer.from(`${config.ditto.username}:${config.ditto.password}`).toString('base64');

  /** Створює двійник або повністю замінює наявний. Повертає true, якщо двійник створено вперше. */
  async putThing(thing: ThingModel): Promise<boolean> {
    const { thingId, ...content } = thing;
    const response = await this.request('PUT', `/things/${thingId}`, content);
    return response.status === 201;
  }

  async getThing(thingId: string): Promise<Thing> {
    const response = await this.request('GET', `/things/${thingId}`);
    return (await response.json()) as Thing;
  }

  /**
   * Частково оновлює двійник (JSON Merge Patch): змінюються лише передані поля.
   * Так одним запитом можна оновити кілька властивостей різних features.
   */
  async mergeThing(thingId: string, patch: Partial<Omit<Thing, 'thingId'>>): Promise<void> {
    await this.request('PATCH', `/things/${thingId}`, patch, 'application/merge-patch+json');
  }

  /** Записує одну властивість feature. Використовується для значення null (див. DittoAdapter). */
  async putProperty(thingId: string, feature: string, property: string, value: unknown): Promise<void> {
    await this.request('PUT', `/things/${thingId}/features/${feature}/properties/${property}`, value);
  }

  /**
   * Пошук двійників за умовою мовою RQL, наприклад eq(attributes/type,"Pump").
   * `fields` обмежує, які частини двійників повернути (наприклад, "thingId,attributes/name").
   */
  async search(filter: string, fields?: string): Promise<Thing[]> {
    const params = new URLSearchParams({ filter, option: 'size(200)' });
    if (fields) params.set('fields', fields);
    const response = await this.request('GET', `/search/things?${params}`);
    const result = (await response.json()) as { items: Thing[] };
    return result.items;
  }

  /**
   * Відкриває потік подій Server-Sent Events (Accept: text/event-stream).
   * Наприклад, /things?namespaces=… — сповіщення про всі зміни двійників простору імен.
   */
  async openEventStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      headers: { Authorization: this.authorization, Accept: 'text/event-stream' },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ditto SSE ${path}: ${response.status} ${await response.text()}`);
    }
    return response.body;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    contentType = 'application/json',
  ): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authorization,
        ...(body === undefined ? {} : { 'Content-Type': contentType }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`Ditto ${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  }
}
