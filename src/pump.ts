import { config } from './config.ts';

/**
 * running — працює; standby — у резерві, автоматика може запустити;
 * fault — аварія; stopped — виведений з роботи оператором.
 */
export type PumpState = 'running' | 'standby' | 'fault' | 'stopped';

/** Перетворює напір у метрах водяного стовпа на тиск у барах. */
export const METERS_PER_BAR = 10.2;

export class Pump {
  state: PumpState;
  /** Оберти, об/хв. */
  speed = 0;
  /** Електрична потужність, кВт. */
  power = 0;
  /** Температура підшипника, °C. */
  bearingTemperature = config.pump.ambientTemperature;
  /** Додаткова вібрація через знос підшипника, мм/с. Росте з часом (тренд). */
  wear = 0;

  constructor(
    readonly id: string,
    initialState: PumpState,
  ) {
    this.state = initialState;
  }

  /** Вібрація без шуму: базова складова росте з квадратом обертів, плюс знос. */
  get vibration(): number {
    if (this.speed === 0) return 0;
    const { baseVibration, nominalSpeed } = config.pump;
    return baseVibration * (this.speed / nominalSpeed) ** 2 + this.wear;
  }

  /**
   * Підбирає оберти, щоб подати `flow` (м³/год) з напором `requiredHead` (м).
   * Повертає фактичний напір: він менший за потрібний, якщо насосу не вистачає обертів.
   */
  operate(flow: number, requiredHead: number): number {
    const { nominalSpeed, shutoffHead, curveCoefficient, idlePower, efficiency } = config.pump;
    const headLoss = curveCoefficient * flow ** 2;

    // Характеристика насоса: H = H0 · (n / n0)² − k · Q²  →  n = n0 · √((H + k · Q²) / H0)
    const neededSpeed = nominalSpeed * Math.sqrt((requiredHead + headLoss) / shutoffHead);
    this.speed = Math.min(neededSpeed, nominalSpeed);

    const actualHead = shutoffHead * (this.speed / nominalSpeed) ** 2 - headLoss;
    // Гідравлічна потужність Q · H / 367 (Q у м³/год, H у м, результат у кВт)
    this.power = idlePower + (flow * actualHead) / (367 * efficiency);
    return actualHead;
  }

  stop(): void {
    this.speed = 0;
    this.power = 0;
  }

  /**
   * Температура не стрибає, а плавно наближається до рівноважної
   * (інерційна ланка першого порядку): T += (Tцільова − T) · dt / τ.
   */
  updateTemperature(dt: number): void {
    const p = config.pump;
    const wearHeat = this.speed > 0 ? this.wear * p.wearHeatPerVibration : 0;
    const target =
      p.ambientTemperature + p.temperatureRiseAtFullLoad * (this.power / p.fullLoadPower) + wearHeat;
    this.bearingTemperature += ((target - this.bearingTemperature) * dt) / p.thermalTimeConstant;
  }
}
