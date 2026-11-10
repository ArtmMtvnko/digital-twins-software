/**
 * Правила синхронізації: вирішують, які значення кадру переносити в стан двійника.
 *
 * - event     — за подією: дискретне значення змінилося (або значення з’явилося чи зникло);
 * - threshold — за порогом: неперервне значення відійшло від записаного в стан більше ніж на syncThreshold;
 * - periodic  — періодично: неперервне значення не оновлювалося periodicSyncS секунд.
 */
import { config } from '../config.ts';
import type { SensorValue } from '../shared/telemetry.ts';
import type { Frame, FrameValue, Quality } from './resampler.ts';
import { SIGNALS, type Signal } from './signals.ts';

export type SyncReason = 'event' | 'threshold' | 'periodic';

/** Зміна одного атрибута стану двійника. */
export interface StateChange {
  signalId: string;
  value: SensorValue | null;
  quality: Quality;
  reason: SyncReason;
}

/** Що й коли востаннє записано в стан для кожного сигналу. */
interface Synced {
  value: SensorValue | null;
  time: number;
}

export class SyncRules {
  private readonly synced = new Map<string, Synced>();

  /** Повертає список змін, які кадр вносить у стан двійника. */
  evaluate(frame: Frame): StateChange[] {
    const changes: StateChange[] = [];
    for (const signal of SIGNALS) {
      const entry = frame.values[signal.id];
      if (!entry) continue;

      const reason = this.reasonToSync(signal, entry, frame.time);
      if (reason) {
        changes.push({ signalId: signal.id, value: entry.value, quality: entry.quality, reason });
        this.synced.set(signal.id, { value: entry.value, time: frame.time });
      }
    }
    return changes;
  }

  /** Чи треба оновити атрибут у стані, і за яким правилом. null — не оновлювати. */
  private reasonToSync(signal: Signal, entry: FrameValue, frameTime: number): SyncReason | null {
    const last = this.synced.get(signal.id);

    // Значення вперше з’явилося, зникло (missing) або повернулося — це подія для будь-якого сигналу
    if (last === undefined) return entry.value === null ? null : 'event';
    if ((last.value === null) !== (entry.value === null)) return 'event';
    if (entry.value === null) return null;

    if (signal.kind === 'discrete') {
      return entry.value !== last.value ? 'event' : null;
    }

    if (typeof entry.value === 'number' && typeof last.value === 'number') {
      if (Math.abs(entry.value - last.value) >= signal.syncThreshold) return 'threshold';
    }
    if (frameTime - last.time >= config.sync.periodicSyncS * 1000) return 'periodic';
    return null;
  }
}
