/**
 * Модель стану цифрового двійника насосної станції.
 * Структура повторює декомпозицію станції: вхідний вузол, насоси Н1 і Н2,
 * напірний вузол, шафа керування.
 */

export type PumpId = 'pump1' | 'pump2';
export type PumpState = 'running' | 'standby' | 'fault' | 'stopped';
export type StationMode = 'auto' | 'night' | 'service';
/** Рівень відхилення від норми для вібрації й температури. */
export type Level = 'normal' | 'warning' | 'critical';
export type PressureStatus = 'normal' | 'low';

/** Виміряне значення разом із часом вимірювання на станції. */
export interface Measured<T> {
  value: T;
  /** Час вимірювання (ISO 8601, UTC) — поле timestamp з повідомлення телеметрії. */
  measuredAt: string;
}

/** `null` означає, що значення від станції ще не надходило. */
type Attribute<T> = Measured<T> | null;

export interface InletState {
  /** Тиск на вході, бар. */
  pressure: Attribute<number>;
  dryRun: Attribute<boolean>;
}

export interface PumpTwinState {
  // Виміряні атрибути
  /** СКЗ віброшвидкості, мм/с. */
  vibration: Attribute<number>;
  /** Частота обертання, об/хв. */
  speed: Attribute<number>;
  /** Електрична потужність, кВт. */
  power: Attribute<number>;
  /** Температура підшипника, °C. */
  bearingTemperature: Attribute<number>;
  state: Attribute<PumpState>;

  // Похідні показники
  /** Ковзне середнє вібрації за вікно STATE_RULES.vibrationAverageWindowS, мм/с. */
  vibrationAvg10s: number | null;
  vibrationLevel: Level;
  temperatureLevel: Level;
}

export interface OutletState {
  /** Тиск на виході, бар. */
  pressure: Attribute<number>;
  /** Витрата в мережу кварталу, м³/год. */
  flow: Attribute<number>;
  /** Ковзне середнє витрати за вікно STATE_RULES.flowAverageWindowS, м³/год. */
  flowAvg1min: number | null;
}

export interface CabinetState {
  /** Поточна уставка тиску, бар. */
  setpoint: Attribute<number>;
  mode: Attribute<StationMode>;
}

/** Показники рівня всієї станції, що обчислюються з атрибутів кількох компонентів. */
export interface StationDerived {
  /** Підвищення тиску p_out − p_in, бар. */
  pressureBoost: number | null;
  /** Питома енерговитрата (P_Н1 + P_Н2) / Q, кВт·год/м³. */
  specificEnergy: number | null;
  /** Кількість насосів у стані running. */
  runningPumps: number;
  pressureStatus: PressureStatus;
}

export interface TwinState {
  stationId: string;
  inlet: InletState;
  pumps: Record<PumpId, PumpTwinState>;
  outlet: OutletState;
  cabinet: CabinetState;
  derived: StationDerived;

  /** true, якщо від станції довше за STATE_RULES.staleAfterS не надходило даних. */
  stale: boolean;
  /** Коли стан двійника востаннє змінився (час оновлення у двійнику, не вимірювання). */
  updatedAt: string | null;
  /** Порядковий номер стану: збільшується на 1 з кожною зміною. */
  version: number;
}

/** Параметри правил обчислення похідних показників. */
export const STATE_RULES = {
  vibrationAverageWindowS: 10,
  flowAverageWindowS: 60,
  /** Межі рівнів вібрації, мм/с: < warning — норма, > critical — критично. */
  vibrationWarning: 4.5,
  vibrationCritical: 7.1,
  /** Межі рівнів температури підшипника, °C. */
  temperatureWarning: 70,
  temperatureCritical: 85,
  /** Тиск вважається низьким, якщо p_out < setpoint − lowPressureMargin довше за lowPressureDelayS. */
  lowPressureMargin: 0.3,
  lowPressureDelayS: 30,
  staleAfterS: 5,
} as const;

function createPumpState(): PumpTwinState {
  return {
    vibration: null,
    speed: null,
    power: null,
    bearingTemperature: null,
    state: null,
    vibrationAvg10s: null,
    vibrationLevel: 'normal',
    temperatureLevel: 'normal',
  };
}

/** Початковий стан двійника: даних від станції ще немає. */
export function createInitialState(stationId: string): TwinState {
  return {
    stationId,
    inlet: { pressure: null, dryRun: null },
    pumps: { pump1: createPumpState(), pump2: createPumpState() },
    outlet: { pressure: null, flow: null, flowAvg1min: null },
    cabinet: { setpoint: null, mode: null },
    derived: { pressureBoost: null, specificEnergy: null, runningPumps: 0, pressureStatus: 'normal' },
    stale: true,
    updatedAt: null,
    version: 0,
  };
}
