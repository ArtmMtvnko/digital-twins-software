/**
 * Сховище стану двійника: тримає актуальний стан у пам’яті, застосовує до нього зміни
 * від правил синхронізації, перераховує похідні показники й сповіщає підписників.
 */
import { config } from '../config.ts';
import type { SensorValue } from '../shared/telemetry.ts';
import type { Frame } from './resampler.ts';
import { createInitialState, STATE_RULES, type Level, type PumpId, type TwinState } from './state.ts';
import type { StateChange, SyncReason } from './sync-rules.ts';

/** Одна зміна стану двійника: атрибут (шлях у стані), нове значення й правило, що її спричинило. */
export interface TwinChange {
  path: string;
  value: unknown;
  reason: SyncReason;
}

export interface StateUpdate {
  /** Копія стану після змін: підписник може читати її, не боячись зіпсувати оригінал. */
  state: TwinState;
  changes: TwinChange[];
}

export type StateListener = (update: StateUpdate) => void;

const PUMP_IDS: PumpId[] = ['pump1', 'pump2'];

export class TwinStateStore {
  private readonly state: TwinState;
  private readonly listeners = new Set<StateListener>();

  // Ковзні вікна значень посекундних кадрів для середніх
  private readonly vibrationWindows: Record<PumpId, number[]> = { pump1: [], pump2: [] };
  private flowWindow: number[] = [];
  /** Коли востаннє оновлювалися періодичні похідні показники, мс. */
  private lastPeriodicDerivedAt = -Infinity;
  /** З якої секунди тиск на виході тримається нижче норми, мс. */
  private lowPressureSince: number | null = null;
  /** Остання секунда, в якій від станції було хоч одне виміряне значення, мс. */
  private lastMeasuredAt: number | null = null;

  constructor(stationId: string) {
    this.state = createInitialState(stationId);
  }

  /** Поточний стан (копія). */
  get current(): TwinState {
    return structuredClone(this.state);
  }

  /** Реєструє підписника. Повертає функцію, яка скасовує підписку. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Застосовує зміни одного кадру. Якщо стан змінився — збільшує версію й сповіщає підписників. */
  apply(frame: Frame, syncChanges: StateChange[]): void {
    const measuredAt = new Date(frame.time).toISOString();
    const changes: TwinChange[] = [];

    for (const change of syncChanges) {
      this.setAttribute(change.signalId, change.value, measuredAt);
      changes.push({ path: change.signalId, value: change.value, reason: change.reason });
    }

    this.updateWindows(frame);
    changes.push(...this.updateDerived(frame));
    changes.push(...this.updateStale(frame));

    if (changes.length === 0) return;
    this.state.version++;
    this.state.updatedAt = new Date().toISOString();
    this.notify({ state: this.current, changes });
  }

  /** Записує виміряне значення у відповідне поле стану: pump1.vibration → state.pumps.pump1.vibration. */
  private setAttribute(signalId: string, value: SensorValue | null, measuredAt: string): void {
    // Значення вже перевірено валідацією на кроці 3, тож приведення типів безпечне
    const attribute = value === null ? null : { value: value as never, measuredAt };
    const [component, field] = signalId.split('.');

    if (component === 'pump1' || component === 'pump2') {
      const pump = this.state.pumps[component];
      if (field === 'vibration') pump.vibration = attribute;
      else if (field === 'speed') pump.speed = attribute;
      else if (field === 'power') pump.power = attribute;
      else if (field === 'bearing_temperature') pump.bearingTemperature = attribute;
      else if (field === 'state') pump.state = attribute;
      return;
    }

    if (signalId === 'inlet.pressure') this.state.inlet.pressure = attribute;
    else if (signalId === 'inlet.dry_run') this.state.inlet.dryRun = attribute;
    else if (signalId === 'outlet.pressure') this.state.outlet.pressure = attribute;
    else if (signalId === 'outlet.flow') this.state.outlet.flow = attribute;
    else if (signalId === 'cabinet.setpoint') this.state.cabinet.setpoint = attribute;
    else if (signalId === 'cabinet.mode') this.state.cabinet.mode = attribute;
  }

  /** Додає значення кадру в ковзні вікна (беруться всі кадри, а не лише записані в стан зміни). */
  private updateWindows(frame: Frame): void {
    for (const pump of PUMP_IDS) {
      const vibration = numberOf(frame, `${pump}.vibration`);
      if (vibration !== null) {
        this.vibrationWindows[pump] = [...this.vibrationWindows[pump], vibration].slice(
          -STATE_RULES.vibrationAverageWindowS,
        );
      }
    }
    const flow = numberOf(frame, 'outlet.flow');
    if (flow !== null) this.flowWindow = [...this.flowWindow, flow].slice(-STATE_RULES.flowAverageWindowS);
  }

  /**
   * Похідні показники за правилами синхронізації:
   * середні, підвищення тиску й енерговитрата — періодично; рівні й статуси — за подією (коли змінилися).
   */
  private updateDerived(frame: Frame): TwinChange[] {
    const changes: TwinChange[] = [];
    const track = <T>(path: string, reason: SyncReason, current: T, next: T): T => {
      if (current !== next) changes.push({ path, value: next, reason });
      return next;
    };
    const { pumps, outlet, derived } = this.state;

    // Періодичні показники: раз на periodicSyncS секунд
    if (frame.time - this.lastPeriodicDerivedAt >= config.sync.periodicSyncS * 1000) {
      this.lastPeriodicDerivedAt = frame.time;
      for (const id of PUMP_IDS) {
        const vibrationAvg = average(this.vibrationWindows[id]);
        pumps[id].vibrationAvg10s = track(`${id}.vibrationAvg10s`, 'periodic', pumps[id].vibrationAvg10s, vibrationAvg);
      }
      outlet.flowAvg1min = track('outlet.flowAvg1min', 'periodic', outlet.flowAvg1min, average(this.flowWindow));
      derived.pressureBoost = track('derived.pressureBoost', 'periodic', derived.pressureBoost, pressureBoost(frame));
      derived.specificEnergy = track(
        'derived.specificEnergy',
        'periodic',
        derived.specificEnergy,
        specificEnergy(frame),
      );
    }

    // Показники за подією: записуються, щойно змінилися
    for (const id of PUMP_IDS) {
      const pump = pumps[id];
      const { vibrationWarning, vibrationCritical, temperatureWarning, temperatureCritical } = STATE_RULES;
      const vibrationLevel = levelOf(pump.vibrationAvg10s, vibrationWarning, vibrationCritical);
      const temperatureLevel = levelOf(
        numberOf(frame, `${id}.bearing_temperature`),
        temperatureWarning,
        temperatureCritical,
      );
      pump.vibrationLevel = track(`${id}.vibrationLevel`, 'event', pump.vibrationLevel, vibrationLevel);
      pump.temperatureLevel = track(`${id}.temperatureLevel`, 'event', pump.temperatureLevel, temperatureLevel);
    }
    const runningPumps = PUMP_IDS.filter((id) => pumps[id].state?.value === 'running').length;
    derived.runningPumps = track('derived.runningPumps', 'event', derived.runningPumps, runningPumps);
    derived.pressureStatus = track(
      'derived.pressureStatus',
      'event',
      derived.pressureStatus,
      this.pressureStatus(frame),
    );

    return changes;
  }

  /** Тиск низький, якщо p_out нижче уставки більш як на lowPressureMargin довше за lowPressureDelayS. */
  private pressureStatus(frame: Frame): 'normal' | 'low' {
    const outletPressure = numberOf(frame, 'outlet.pressure');
    const setpoint = numberOf(frame, 'cabinet.setpoint');
    const isLow =
      outletPressure !== null && setpoint !== null && outletPressure < setpoint - STATE_RULES.lowPressureMargin;

    if (!isLow) {
      this.lowPressureSince = null;
      return 'normal';
    }
    this.lowPressureSince ??= frame.time;
    return frame.time - this.lowPressureSince >= STATE_RULES.lowPressureDelayS * 1000 ? 'low' : 'normal';
  }

  /** Стан застарілий, якщо від станції довше за staleAfterS не було жодного виміряного значення. */
  private updateStale(frame: Frame): TwinChange[] {
    const hasMeasured = Object.values(frame.values).some((entry) => entry.quality === 'measured');
    if (hasMeasured) this.lastMeasuredAt = frame.time;

    const stale = this.lastMeasuredAt === null || frame.time - this.lastMeasuredAt >= STATE_RULES.staleAfterS * 1000;
    if (stale === this.state.stale) return [];
    this.state.stale = stale;
    return [{ path: 'stale', value: stale, reason: 'event' }];
  }

  private notify(update: StateUpdate): void {
    for (const listener of this.listeners) {
      // Помилка одного підписника не повинна заважати іншим
      try {
        listener(update);
      } catch (error) {
        console.error('Помилка підписника стану:', error);
      }
    }
  }
}

function numberOf(frame: Frame, signalId: string): number | null {
  const value = frame.values[signalId]?.value;
  return typeof value === 'number' ? value : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function pressureBoost(frame: Frame): number | null {
  const inlet = numberOf(frame, 'inlet.pressure');
  const outlet = numberOf(frame, 'outlet.pressure');
  return inlet === null || outlet === null ? null : round(outlet - inlet);
}

/** Питома енерговитрата: сумарна потужність насосів (кВт) / витрата (м³/год) = кВт·год/м³. */
function specificEnergy(frame: Frame): number | null {
  const flow = numberOf(frame, 'outlet.flow');
  if (flow === null || flow <= 0) return null;
  const power = (numberOf(frame, 'pump1.power') ?? 0) + (numberOf(frame, 'pump2.power') ?? 0);
  return round(power / flow);
}

function levelOf(value: number | null, warning: number, critical: number): Level {
  if (value === null || value < warning) return 'normal';
  return value > critical ? 'critical' : 'warning';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
