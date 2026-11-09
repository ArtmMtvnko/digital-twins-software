import type { SensorValue } from '../shared/telemetry.ts';
import { SIGNALS, type Signal } from './signals.ts';

/**
 * measured — виміряно в цю секунду;
 * held — утримано останнє відоме значення (пропуск або рідкісний сигнал);
 * missing — даних немає довше, ніж дозволено утримувати.
 */
export type Quality = 'measured' | 'held' | 'missing';

export interface FrameValue {
  value: SensorValue | null;
  quality: Quality;
}

/** Кадр: значення всіх сигналів на одну секунду спільної сітки 1 Гц. */
export interface Frame {
  /** Початок секунди, мс від епохи. */
  time: number;
  values: Record<string, FrameValue>;
}

interface SecondBucket {
  sum: number;
  count: number;
  last: SensorValue;
}

const SECOND_MS = 1000;

/**
 * Зводить потік вимірювань з різною частотою до сітки 1 Гц.
 * Неперервні сигнали усереднюються за секунду, дискретні — беруть останнє значення.
 * Якщо за секунду значення не надійшло, утримується останнє відоме (zero-order hold).
 */
export class Resampler {
  /** Вимірювання поточної (ще не закритої) секунди за датчиками. */
  private buckets = new Map<string, SecondBucket>();
  /** Остання відома величина кожного датчика й секунда, коли її виміряно. */
  private readonly lastKnown = new Map<string, { value: SensorValue; second: number }>();
  /** Початок секунди, яку зараз наповнюємо. */
  private currentSecond: number | null = null;

  constructor(private readonly onFrame: (frame: Frame) => void) {}

  /**
   * Додає впорядковане вимірювання. Повертає false, якщо його секунду вже закрито
   * (вимірювання запізнилося і в кадр не потрапить).
   */
  add(sensorId: string, value: SensorValue, measuredAt: number): boolean {
    const second = Math.floor(measuredAt / SECOND_MS) * SECOND_MS;
    if (this.currentSecond !== null && second < this.currentSecond) return false;
    this.advanceTo(second);
    this.currentSecond ??= second;

    const bucket = this.buckets.get(sensorId);
    if (bucket) {
      bucket.sum += typeof value === 'number' ? value : 0;
      bucket.count++;
      bucket.last = value;
    } else {
      this.buckets.set(sensorId, { sum: typeof value === 'number' ? value : 0, count: 1, last: value });
    }
    return true;
  }

  /** Запам’ятовує знімок останнього значення (retained), не створюючи кадрів. */
  seed(sensorId: string, value: SensorValue, measuredAt: number): void {
    const second = Math.floor(measuredAt / SECOND_MS) * SECOND_MS;
    const known = this.lastKnown.get(sensorId);
    if (!known || known.second < second) this.lastKnown.set(sensorId, { value, second });
  }

  /**
   * Закриває всі секунди до `time` (не включно) і видає по кадру на кожну.
   * Викликається і з надходженням даних, і за таймером — тож кадри йдуть
   * навіть тоді, коли дані перестали надходити (пропуски стануть held, потім missing).
   */
  advanceTo(time: number): void {
    if (this.currentSecond === null) return;
    while (this.currentSecond + SECOND_MS <= time) {
      this.onFrame(this.closeSecond(this.currentSecond));
      this.currentSecond += SECOND_MS;
    }
  }

  private closeSecond(second: number): Frame {
    const values: Record<string, FrameValue> = {};
    for (const signal of SIGNALS) {
      values[signal.id] = this.valueFor(signal, second);
    }
    this.buckets = new Map();
    return { time: second, values };
  }

  private valueFor(signal: Signal, second: number): FrameValue {
    const bucket = this.buckets.get(signal.id);
    if (bucket) {
      const value = signal.kind === 'continuous' ? round(bucket.sum / bucket.count) : bucket.last;
      this.lastKnown.set(signal.id, { value, second });
      return { value, quality: 'measured' };
    }

    const known = this.lastKnown.get(signal.id);
    if (known && (second - known.second) / SECOND_MS <= signal.maxHoldS) {
      return { value: known.value, quality: 'held' };
    }
    return { value: null, quality: 'missing' };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
