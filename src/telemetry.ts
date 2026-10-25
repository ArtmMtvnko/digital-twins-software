/**
 * Спільний «контракт» між видавцем і підписником:
 * структура топіків і формат повідомлення телеметрії (крок 4).
 */
import { config } from './config.ts';
import type { SensorValue } from './sensors.ts';

export interface TelemetryMessage {
  sensorId: string;
  value: SensorValue;
  unit: string;
  /** Момент вимірювання, ISO 8601 UTC. */
  timestamp: string;
  /** Порядковий номер повідомлення цього датчика: дає змогу помітити втрати. */
  seq: number;
}

const ROOT_TOPIC = `nspt/${config.mqtt.stationId}`;

/** Службовий топік: online / offline. Сюди ж брокер публікує Last Will. */
export const STATUS_TOPIC = `${ROOT_TOPIC}/status`;

/** Підписка на всі топіки станції. */
export const STATION_SUBSCRIPTION = `${ROOT_TOPIC}/#`;

/** pump1.vibration → nspt/station1/pump1/vibration */
export function telemetryTopic(sensorId: string): string {
  return `${ROOT_TOPIC}/${sensorId.replace('.', '/')}`;
}

/** nspt/station1/pump1/vibration → pump1.vibration */
export function sensorIdFromTopic(topic: string): string {
  return topic.slice(ROOT_TOPIC.length + 1).replace('/', '.');
}

export type ValidationResult =
  | { ok: true; message: TelemetryMessage }
  | { ok: false; errors: string[] };

/** Перевіряє, що повідомлення — JSON-об’єкт з усіма полями потрібних типів. */
export function validateTelemetry(topic: string, payload: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return { ok: false, errors: ['повідомлення не є коректним JSON'] };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['повідомлення має бути JSON-об’єктом'] };
  }

  const message = data as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof message.sensorId !== 'string') {
    errors.push('sensorId має бути рядком');
  } else if (message.sensorId !== sensorIdFromTopic(topic)) {
    errors.push(`sensorId «${message.sensorId}» не відповідає топіку`);
  }

  const value = message.value;
  const valueIsValid =
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'string' ||
    typeof value === 'boolean';
  if (!valueIsValid) errors.push('value має бути числом, рядком або логічним значенням');

  if (typeof message.unit !== 'string') errors.push('unit має бути рядком');

  const timestamp = message.timestamp;
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    errors.push('timestamp має бути датою у форматі ISO 8601');
  }

  const seq = message.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    errors.push('seq має бути цілим додатним числом');
  }

  if (errors.length > 0) return { ok: false, errors };
  // Усі поля перевірено вище, тож приведення типу безпечне
  return { ok: true, message: message as unknown as TelemetryMessage };
}
