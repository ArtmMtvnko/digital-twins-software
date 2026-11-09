import type { SensorValue } from '../shared/telemetry.ts';
import { SIGNALS_BY_ID, type Signal } from './signals.ts';

export type DomainCheck = { ok: true; signal: Signal } | { ok: false; reason: string };

/**
 * Перевірка за змістом (структуру повідомлення вже перевірено при прийманні):
 * датчик відомий, тип значення правильний, число в межах фізичного діапазону.
 */
export function validateValue(sensorId: string, value: SensorValue): DomainCheck {
  const signal = SIGNALS_BY_ID.get(sensorId);
  if (!signal) return { ok: false, reason: `невідомий датчик ${sensorId}` };

  if (signal.kind === 'discrete') {
    return signal.isValid(value)
      ? { ok: true, signal }
      : { ok: false, reason: `недопустиме значення ${JSON.stringify(value)}` };
  }

  if (typeof value !== 'number') return { ok: false, reason: 'очікувалось число' };
  const [min, max] = signal.range;
  if (value < min || value > max) return { ok: false, reason: `значення ${value} поза діапазоном ${min}…${max}` };
  return { ok: true, signal };
}
