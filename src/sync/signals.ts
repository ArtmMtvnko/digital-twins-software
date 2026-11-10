/**
 * Довідник сигналів, які знає двійник: як їх перевіряти, фільтрувати
 * й зводити до єдиної частоти 1 Гц.
 */
import type { SensorValue } from '../shared/telemetry.ts';

interface SignalBase {
  id: string;
  /**
   * Скільки секунд після останнього вимірювання значення можна утримувати.
   * Для подієвих сигналів — без обмеження: вони надходять лише при зміні.
   */
  maxHoldS: number;
}

/** Неперервна величина: тиск, витрата, вібрація… Зводиться до 1 Гц середнім за секунду. */
export interface ContinuousSignal extends SignalBase {
  kind: 'continuous';
  /** Фізичний діапазон датчика: значення поза ним некоректні. */
  range: [min: number, max: number];
  /** Найменше відхилення від медіани, яке може вважатися викидом (в одиницях сигналу). */
  outlierMinDeviation: number;
  /** Поріг синхронізації: стан оновлюється, якщо значення змінилося більше ніж на цю величину. */
  syncThreshold: number;
}

/** Дискретний (подієвий) сигнал: стан, режим, уставка. Береться останнє значення за секунду. */
export interface DiscreteSignal extends SignalBase {
  kind: 'discrete';
  /** Перевіряє, чи значення допустиме для цього сигналу. */
  isValid: (value: SensorValue) => boolean;
}

export type Signal = ContinuousSignal | DiscreteSignal;

const oneOf =
  (...allowed: SensorValue[]) =>
  (value: SensorValue) =>
    allowed.includes(value);

const numberIn =
  (min: number, max: number) =>
  (value: SensorValue) =>
    typeof value === 'number' && value >= min && value <= max;

/** Звичайний пропуск: значення 1 Гц утримується не довше 3 с. */
const SHORT_HOLD_S = 3;

function pumpSignals(pump: 'pump1' | 'pump2'): Signal[] {
  return [
    { id: `${pump}.vibration`, kind: 'continuous', range: [0, 20], outlierMinDeviation: 2, syncThreshold: 0.2, maxHoldS: SHORT_HOLD_S },
    { id: `${pump}.speed`, kind: 'continuous', range: [0, 3000], outlierMinDeviation: 300, syncThreshold: 20, maxHoldS: SHORT_HOLD_S },
    { id: `${pump}.power`, kind: 'continuous', range: [0, 15], outlierMinDeviation: 2, syncThreshold: 0.2, maxHoldS: SHORT_HOLD_S },
    // Температура приходить раз на 10 с, тож між вимірюваннями її утримуємо до 15 с
    { id: `${pump}.bearing_temperature`, kind: 'continuous', range: [0, 120], outlierMinDeviation: 5, syncThreshold: 0.5, maxHoldS: 15 },
    { id: `${pump}.state`, kind: 'discrete', isValid: oneOf('running', 'standby', 'fault', 'stopped'), maxHoldS: Infinity },
  ];
}

export const SIGNALS: Signal[] = [
  { id: 'inlet.pressure', kind: 'continuous', range: [0, 10], outlierMinDeviation: 0.5, syncThreshold: 0.05, maxHoldS: SHORT_HOLD_S },
  { id: 'inlet.dry_run', kind: 'discrete', isValid: oneOf(true, false), maxHoldS: Infinity },
  { id: 'outlet.pressure', kind: 'continuous', range: [0, 10], outlierMinDeviation: 0.5, syncThreshold: 0.05, maxHoldS: SHORT_HOLD_S },
  { id: 'outlet.flow', kind: 'continuous', range: [0, 200], outlierMinDeviation: 20, syncThreshold: 2, maxHoldS: SHORT_HOLD_S },
  { id: 'cabinet.setpoint', kind: 'discrete', isValid: numberIn(0, 10), maxHoldS: Infinity },
  { id: 'cabinet.mode', kind: 'discrete', isValid: oneOf('auto', 'night', 'service'), maxHoldS: Infinity },
  ...pumpSignals('pump1'),
  ...pumpSignals('pump2'),
];

export const SIGNALS_BY_ID = new Map(SIGNALS.map((signal) => [signal.id, signal]));
