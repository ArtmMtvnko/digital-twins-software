import { gaussian } from './random.ts';
import type { Pump } from './pump.ts';
import type { Station } from './station.ts';

/** fast = 10 Гц, normal = 1 Гц, slow = 0,1 Гц, event = лише коли значення змінилося. */
export type Frequency = 'fast' | 'normal' | 'slow' | 'event';

export type SensorValue = number | string | boolean;

export interface Sensor {
  /** Ідентифікатор у форматі «компонент.величина», наприклад pump1.vibration. */
  id: string;
  unit: string;
  frequency: Frequency;
  /** Повертає справжнє значення величини з моделі станції. */
  read: () => SensorValue;
  /** Межі вимірювання датчика: значення за ними обрізаються. */
  range?: [min: number, max: number];
  /** Стандартне відхилення шуму датчика в одиницях сигналу. */
  noise?: number;
  /** Скільки знаків після коми залишати. */
  decimals?: number;
}

function pumpSensors(pump: Pump): Sensor[] {
  return [
    { id: `${pump.id}.vibration`, unit: 'mm/s', frequency: 'fast', read: () => pump.vibration, range: [0, 20], noise: 0.1 },
    { id: `${pump.id}.speed`, unit: 'rpm', frequency: 'normal', read: () => pump.speed, range: [0, 3000], noise: 5, decimals: 0 },
    { id: `${pump.id}.power`, unit: 'kW', frequency: 'normal', read: () => pump.power, range: [0, 15], noise: 0.1 },
    { id: `${pump.id}.bearing_temperature`, unit: '°C', frequency: 'slow', read: () => pump.bearingTemperature, range: [0, 120], noise: 0.2, decimals: 1 },
    { id: `${pump.id}.state`, unit: '', frequency: 'event', read: () => pump.state },
  ];
}

export function createSensors(station: Station): Sensor[] {
  return [
    { id: 'inlet.pressure', unit: 'bar', frequency: 'normal', read: () => station.inletPressure, range: [0, 10], noise: 0.02 },
    { id: 'inlet.dry_run', unit: '', frequency: 'event', read: () => station.dryRun },
    { id: 'outlet.pressure', unit: 'bar', frequency: 'normal', read: () => station.outletPressure, range: [0, 10], noise: 0.02 },
    { id: 'outlet.flow', unit: 'm3/h', frequency: 'normal', read: () => station.flow, range: [0, 200], noise: 1 },
    { id: 'cabinet.setpoint', unit: 'bar', frequency: 'event', read: () => station.setpoint },
    { id: 'cabinet.mode', unit: '', frequency: 'event', read: () => station.mode },
    ...station.pumps.flatMap((pump) => pumpSensors(pump)),
  ];
}

/** Те, що «показує» датчик: справжнє значення + шум, обрізане межами вимірювання й округлене. */
export function measure(sensor: Sensor): SensorValue {
  const trueValue = sensor.read();
  if (typeof trueValue !== 'number') return trueValue;

  // Зупинений насос показує рівно нуль, шум додаємо лише до ненульових значень
  const noisy = trueValue === 0 ? 0 : trueValue + gaussian(0, sensor.noise ?? 0);
  const [min, max] = sensor.range ?? [-Infinity, Infinity];
  const clamped = Math.min(Math.max(noisy, min), max);

  const factor = 10 ** (sensor.decimals ?? 2);
  return Math.round(clamped * factor) / factor;
}
