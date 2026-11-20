/**
 * Моделі двійників насосної станції для Eclipse Ditto.
 *
 * Кожна складова станції — окремий Thing:
 * - attributes — те, що майже не змінюється (тип, назва, паспортні дані);
 * - features   — функціональні частини з властивостями, які оновлюються з конвеєра даних.
 * Поки даних від станції немає, властивості мають значення null.
 */
import { config } from '../config.ts';

/** Простір імен двійників станції: nspt.station1 */
export const NAMESPACE = `nspt.${config.mqtt.stationId}`;

export type ThingName = 'station' | 'inlet' | 'pump-unit' | 'pump1' | 'pump2' | 'outlet' | 'cabinet';

/** Повний ідентифікатор двійника в Ditto: nspt.station1:pump1 */
export function thingId(name: ThingName): string {
  return `${NAMESPACE}:${name}`;
}

export interface Feature {
  properties: Record<string, unknown>;
}

export interface ThingModel {
  thingId: string;
  attributes: Record<string, unknown>;
  features: Record<string, Feature>;
}

/** Насосна станція загалом: зведені показники роботи. */
function stationModel(): ThingModel {
  return {
    thingId: thingId('station'),
    attributes: {
      type: 'PumpingStation',
      name: 'Насосна станція підвищення тиску',
      buildingsServed: 12,
      residents: 6000,
    },
    features: {
      summary: {
        properties: {
          runningPumps: null, // кількість працюючих насосів
          pressureStatus: null, // normal / low
          pressureBoost: null, // підвищення тиску p_out − p_in, бар
          specificEnergy: null, // питома енерговитрата, кВт·год/м³
          stale: null, // true — дані від станції не надходять
        },
      },
    },
  };
}

/** Вхідний вузол: вода з міського водогону. */
function inletModel(): ThingModel {
  return {
    thingId: thingId('inlet'),
    attributes: { type: 'InletNode', name: 'Вхідний вузол', pressureRange: [0, 10] },
    features: {
      hydraulics: {
        properties: {
          pressure: null, // тиск на вході, бар
          dryRun: null, // сухий хід (немає води на вході)
        },
      },
    },
  };
}

/** Насосний агрегат: об’єднує робочий і резервний насоси. */
function pumpUnitModel(): ThingModel {
  return {
    thingId: thingId('pump-unit'),
    attributes: { type: 'PumpUnit', name: 'Насосний агрегат', redundancy: '1 робочий + 1 резервний' },
    features: {},
  };
}

function pumpModel(name: 'pump1' | 'pump2', displayName: string): ThingModel {
  return {
    thingId: thingId(name),
    attributes: {
      type: 'Pump',
      name: displayName,
      nominalSpeed: 2900, // номінальні оберти, об/хв
      ratedPower: 12, // номінальна потужність, кВт
    },
    features: {
      operation: {
        properties: { state: null }, // running / standby / fault / stopped
      },
      hydraulics: {
        properties: { speed: null }, // оберти, об/хв
      },
      electrical: {
        properties: { power: null }, // потужність, кВт
      },
      condition: {
        properties: {
          vibration: null, // вібрація, мм/с
          vibrationAvg10s: null, // середня вібрація за 10 с, мм/с
          bearingTemperature: null, // температура підшипника, °C
          vibrationLevel: null, // normal / warning / critical
          temperatureLevel: null, // normal / warning / critical
        },
      },
    },
  };
}

/** Напірний вузол: вода, що йде в мережу кварталу. */
function outletModel(): ThingModel {
  return {
    thingId: thingId('outlet'),
    attributes: { type: 'OutletNode', name: 'Напірний вузол', pressureRange: [0, 10], flowRange: [0, 200] },
    features: {
      hydraulics: {
        properties: {
          pressure: null, // тиск на виході, бар
          flow: null, // витрата, м³/год
          flowAvg1min: null, // середня витрата за 1 хв, м³/год
        },
      },
    },
  };
}

/** Шафа керування: уставка й режим роботи станції. */
function cabinetModel(): ThingModel {
  return {
    thingId: thingId('cabinet'),
    attributes: { type: 'ControlCabinet', name: 'Шафа керування' },
    features: {
      control: {
        properties: {
          setpoint: null, // уставка тиску, бар
          mode: null, // auto / night / service
        },
      },
    },
  };
}

/** Усі двійники станції. */
export const THING_MODELS: ThingModel[] = [
  stationModel(),
  inletModel(),
  pumpUnitModel(),
  pumpModel('pump1', 'Насос Н1'),
  pumpModel('pump2', 'Насос Н2'),
  outletModel(),
  cabinetModel(),
];