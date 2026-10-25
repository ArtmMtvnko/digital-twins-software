import { config } from './config.ts';
import { pickRandom } from './random.ts';
import type { Station } from './station.ts';

/** Відхилення, яке на деякий час змінює поведінку станції. */
interface Anomaly {
  name: string;
  durationHours: number;
  start(station: Station): void;
  end(station: Station): void;
}

const ANOMALIES: Anomaly[] = [
  {
    name: 'Аварія робочого насоса',
    durationHours: 1,
    start(station) {
      const runningPump = station.pumps.find((pump) => pump.state === 'running');
      if (runningPump) runningPump.state = 'fault';
    },
    end(station) {
      // Насос відремонтували — він повертається в резерв
      for (const pump of station.pumps) {
        if (pump.state === 'fault') pump.state = 'standby';
      }
    },
  },
  {
    name: 'Сухий хід: зник тиск у міському водогоні',
    durationHours: 0.5,
    start(station) {
      station.inletPressureOverride = 0.3;
    },
    end(station) {
      station.inletPressureOverride = null;
    },
  },
  {
    name: 'Витік у мережі кварталу',
    durationHours: 4,
    start(station) {
      station.leakFlow = 8;
    },
    end(station) {
      station.leakFlow = 0;
    },
  },
];

/**
 * Запускає аномалії періодично (раз на `intervalHours`) і веде тренд зносу підшипника Н1.
 */
export class AnomalyScheduler {
  private active: { anomaly: Anomaly; endsAt: number } | null = null;
  private nextStartAt: number;

  constructor(
    private readonly station: Station,
    private readonly log: (message: string) => void,
  ) {
    this.nextStartAt = station.time + config.anomalies.intervalHours * 3600;
  }

  step(dt: number): void {
    this.updateBearingWear(dt);

    if (this.active && this.station.time >= this.active.endsAt) {
      this.active.anomaly.end(this.station);
      this.log(`Завершено: ${this.active.anomaly.name}`);
      this.active = null;
    }

    if (!this.active && this.station.time >= this.nextStartAt) {
      const anomaly = pickRandom(ANOMALIES);
      anomaly.start(this.station);
      this.active = { anomaly, endsAt: this.station.time + anomaly.durationHours * 3600 };
      this.nextStartAt += config.anomalies.intervalHours * 3600;
      this.log(`Почалося: ${anomaly.name}`);
    }
  }

  /** Тренд: підшипник Н1 поступово зношується, поки насос працює. */
  private updateBearingWear(dt: number): void {
    const [pump1] = this.station.pumps;
    if (pump1.speed > 0) {
      pump1.wear += (config.anomalies.bearingWearPerHour * dt) / 3600;
    }
  }
}
