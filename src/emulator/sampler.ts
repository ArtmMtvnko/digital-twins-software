import { config } from '../config.ts';
import type { SensorValue } from '../shared/telemetry.ts';
import { measure, type Frequency, type Sensor } from './sensors.ts';

/** Одне вимірювання — те, що далі піде в MQTT. */
export interface Reading {
  sensorId: string;
  value: SensorValue;
  unit: string;
  /** Реальний час вимірювання (ISO 8601). Потрібен, щоб на КП 2 рахувати затримку доставки. */
  timestamp: string;
}

/** Період опитування в секундах для кожної частоти. */
const PERIOD_SECONDS: Record<Exclude<Frequency, 'event'>, number> = {
  fast: 0.1, //  10 Гц
  normal: 1, //  1 Гц
  slow: 10, //   0,1 Гц
};

/**
 * Вирішує, які датчики опитати на поточному кроці:
 * періодичні — за своєю частотою, подієві — лише коли значення змінилося.
 */
export class Sampler {
  private readonly lastEventValues = new Map<string, SensorValue>();

  constructor(
    private readonly sensors: Sensor[],
    private readonly onReading: (reading: Reading, sensor: Sensor) => void,
  ) {}

  /** `tick` — номер кроку симуляції (крок = config.tickMs мілісекунд реального часу). */
  sample(tick: number): void {
    const timestamp = new Date().toISOString();

    for (const sensor of this.sensors) {
      if (sensor.frequency === 'event') {
        this.sampleEvent(sensor, timestamp);
      } else if (this.isDue(sensor.frequency, tick)) {
        this.emit(sensor, measure(sensor), timestamp);
      }
    }
  }

  private isDue(frequency: Exclude<Frequency, 'event'>, tick: number): boolean {
    const ticksPerPeriod = Math.round((PERIOD_SECONDS[frequency] * 1000) / config.tickMs);
    return tick % ticksPerPeriod === 0;
  }

  private sampleEvent(sensor: Sensor, timestamp: string): void {
    const value = measure(sensor);
    if (this.lastEventValues.get(sensor.id) === value) return;
    this.lastEventValues.set(sensor.id, value);
    this.emit(sensor, value, timestamp);
  }

  private emit(sensor: Sensor, value: SensorValue, timestamp: string): void {
    this.onReading({ sensorId: sensor.id, value, unit: sensor.unit, timestamp }, sensor);
  }
}
