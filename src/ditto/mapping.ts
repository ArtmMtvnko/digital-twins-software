/**
 * Відповідність атрибутів стану двійника (шляхи зі state-store.ts)
 * властивостям двійників у Ditto: який двійник, яка feature, яка властивість.
 */
import type { TwinState } from '../sync/state.ts';
import type { ThingName } from './models.ts';

export interface DittoTarget {
  thing: ThingName;
  feature: string;
  property: string;
}

const target = (thing: ThingName, feature: string, property: string): DittoTarget => ({ thing, feature, property });

function pumpTargets(pump: 'pump1' | 'pump2'): [string, DittoTarget][] {
  return [
    [`${pump}.state`, target(pump, 'operation', 'state')],
    [`${pump}.speed`, target(pump, 'hydraulics', 'speed')],
    [`${pump}.power`, target(pump, 'electrical', 'power')],
    [`${pump}.vibration`, target(pump, 'condition', 'vibration')],
    [`${pump}.vibrationAvg10s`, target(pump, 'condition', 'vibrationAvg10s')],
    [`${pump}.bearing_temperature`, target(pump, 'condition', 'bearingTemperature')],
    [`${pump}.vibrationLevel`, target(pump, 'condition', 'vibrationLevel')],
    [`${pump}.temperatureLevel`, target(pump, 'condition', 'temperatureLevel')],
  ];
}

export const DITTO_TARGETS = new Map<string, DittoTarget>([
  // Виміряні атрибути
  ['inlet.pressure', target('inlet', 'hydraulics', 'pressure')],
  ['inlet.dry_run', target('inlet', 'hydraulics', 'dryRun')],
  ['outlet.pressure', target('outlet', 'hydraulics', 'pressure')],
  ['outlet.flow', target('outlet', 'hydraulics', 'flow')],
  ['cabinet.setpoint', target('cabinet', 'control', 'setpoint')],
  ['cabinet.mode', target('cabinet', 'control', 'mode')],
  ...pumpTargets('pump1'),
  ...pumpTargets('pump2'),

  // Похідні показники
  ['outlet.flowAvg1min', target('outlet', 'hydraulics', 'flowAvg1min')],
  ['derived.runningPumps', target('station', 'summary', 'runningPumps')],
  ['derived.pressureStatus', target('station', 'summary', 'pressureStatus')],
  ['derived.pressureBoost', target('station', 'summary', 'pressureBoost')],
  ['derived.specificEnergy', target('station', 'summary', 'specificEnergy')],
  ['stale', target('station', 'summary', 'stale')],
]);

/** Значення атрибута стану за його шляхом (для повної синхронізації при старті адаптера). */
export function readStateValue(state: TwinState, path: string): unknown {
  const measured = (attribute: { value: unknown } | null) => attribute?.value ?? null;
  const [component, field] = path.split('.');

  if (component === 'pump1' || component === 'pump2') {
    const pump = state.pumps[component];
    const pumpValues: Record<string, unknown> = {
      state: measured(pump.state),
      speed: measured(pump.speed),
      power: measured(pump.power),
      vibration: measured(pump.vibration),
      bearing_temperature: measured(pump.bearingTemperature),
      vibrationAvg10s: pump.vibrationAvg10s,
      vibrationLevel: pump.vibrationLevel,
      temperatureLevel: pump.temperatureLevel,
    };
    return pumpValues[field ?? ''] ?? null;
  }

  const values: Record<string, unknown> = {
    'inlet.pressure': measured(state.inlet.pressure),
    'inlet.dry_run': measured(state.inlet.dryRun),
    'outlet.pressure': measured(state.outlet.pressure),
    'outlet.flow': measured(state.outlet.flow),
    'outlet.flowAvg1min': state.outlet.flowAvg1min,
    'cabinet.setpoint': measured(state.cabinet.setpoint),
    'cabinet.mode': measured(state.cabinet.mode),
    'derived.runningPumps': state.derived.runningPumps,
    'derived.pressureStatus': state.derived.pressureStatus,
    'derived.pressureBoost': state.derived.pressureBoost,
    'derived.specificEnergy': state.derived.specificEnergy,
    stale: state.stale,
  };
  return values[path] ?? null;
}
