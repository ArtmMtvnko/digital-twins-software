import { config } from './config.js';
import { demandFactor, MAX_DEMAND_FACTOR } from './demand.js';
import { METERS_PER_BAR, Pump } from './pump.js';

export type Mode = 'auto' | 'night' | 'service';

/**
 * Фізична модель станції та логіка її контролера (ПЛК):
 * підтримання тиску, перехід на резервний насос, захист від сухого ходу.
 */
export class Station {
  /** Симульований час у секундах від півночі першої доби. */
  time: number;
  readonly pumps: readonly [Pump, Pump] = [new Pump('pump1', 'running'), new Pump('pump2', 'standby')];

  mode: Mode = 'auto';
  /** Тиск, який підтримує ПЛК, бар. */
  setpoint = config.station.daySetpoint;
  inletPressure = config.station.inletPressureNominal;
  outletPressure = config.station.inletPressureNominal;
  /** Витрата в мережу кварталу, м³/год. */
  flow = 0;
  dryRun = false;

  // Зовнішні впливи, якими керують аномалії
  /** Додаткова витрата через витік у мережі, м³/год. */
  leakFlow = 0;
  /** Якщо задано, тиск у водогоні примусово дорівнює цьому значенню, бар. */
  inletPressureOverride: number | null = null;

  // Таймери логіки ПЛК, с
  private lowInletTimer = 0;
  private normalInletTimer = 0;
  private noPumpTimer = 0;

  constructor(startHour: number) {
    this.time = startHour * 3600;
  }

  get hourOfDay(): number {
    return (this.time / 3600) % 24;
  }

  /** Просуває симуляцію на `dt` симульованих секунд. */
  step(dt: number): void {
    this.time += dt;
    this.updateMode();
    this.updateInletPressure();
    this.updateDryRunProtection(dt);
    this.updatePumps(dt);
  }

  /** Добовий цикл режимів: уночі уставка знижується. Сервісний режим не перемикається автоматично. */
  private updateMode(): void {
    if (this.mode === 'service') return;
    const { nightStartHour, nightEndHour, daySetpoint, nightSetpoint } = config.station;
    const isNight = this.hourOfDay >= nightStartHour && this.hourOfDay < nightEndHour;
    this.mode = isNight ? 'night' : 'auto';
    this.setpoint = isNight ? nightSetpoint : daySetpoint;
  }

  /** У години пік місто споживає більше, тому тиск у водогоні трохи падає. */
  private updateInletPressure(): void {
    if (this.inletPressureOverride !== null) {
      this.inletPressure = this.inletPressureOverride;
      return;
    }
    const { inletPressureNominal, inletPressureDropAtPeak } = config.station;
    const peakShare = demandFactor(this.hourOfDay) / MAX_DEMAND_FACTOR;
    this.inletPressure = inletPressureNominal - inletPressureDropAtPeak * peakShare;
  }

  private updateDryRunProtection(dt: number): void {
    const { dryRunPressure, dryRunDelay, restartPressure, restartDelay } = config.protection;

    if (!this.dryRun) {
      this.lowInletTimer = this.inletPressure < dryRunPressure ? this.lowInletTimer + dt : 0;
      if (this.lowInletTimer >= dryRunDelay) {
        this.dryRun = true;
        this.normalInletTimer = 0;
      }
      return;
    }

    this.normalInletTimer = this.inletPressure > restartPressure ? this.normalInletTimer + dt : 0;
    if (this.normalInletTimer >= restartDelay) {
      this.dryRun = false;
      this.lowInletTimer = 0;
    }
  }

  private updatePumps(dt: number): void {
    const demand = config.station.averageFlow * demandFactor(this.hourOfDay) + this.leakFlow;
    let runningPump = this.pumps.find((pump) => pump.state === 'running');

    // Захист від сухого ходу: робочий насос зупиняється і переходить у резерв
    if (this.dryRun && runningPump) {
      runningPump.state = 'standby';
      runningPump = undefined;
    }

    // Якщо жоден насос не працює, через кілька секунд ПЛК запускає резервний
    if (!runningPump && !this.dryRun) {
      this.noPumpTimer += dt;
      const standbyPump = this.pumps.find((pump) => pump.state === 'standby');
      if (standbyPump && this.noPumpTimer >= config.protection.standbyStartDelay) {
        standbyPump.state = 'running';
        runningPump = standbyPump;
      }
    }

    if (runningPump) {
      this.noPumpTimer = 0;
      const requiredHead = (this.setpoint - this.inletPressure) * METERS_PER_BAR;
      const actualHead = runningPump.operate(demand, requiredHead);
      this.outletPressure = this.inletPressure + actualHead / METERS_PER_BAR;
      this.flow = demand;
    } else {
      // Насоси стоять: вода йде лише під тиском міського водогону (або її немає зовсім)
      this.outletPressure = this.inletPressure;
      this.flow = this.dryRun ? 0 : demand;
    }

    for (const pump of this.pumps) {
      if (pump !== runningPump) pump.stop();
      pump.updateTemperature(dt);
    }
  }
}
