/**
 * Зовнішній компонент, що реагує на події Eclipse Ditto (крок 6 КП 4).
 * Підписується на зміни двійників станції й піднімає тривогу, коли властивість
 * переходить у небезпечний стан: аварія насоса, сухий хід, відхилення вібрації чи температури,
 * низький тиск, втрата зв’язку зі станцією. Тривоги також дописуються у logs/alarms.log.
 *
 * Запуск: DITTO_URL=http://<адреса>:8080 pnpm twins:watch [--alarms-only]
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { config } from '../src/config.ts';
import { DittoClient } from '../src/ditto/client.ts';
import { watchPropertyChanges, type PropertyChange } from '../src/ditto/events.ts';

const ALARMS_ONLY = process.argv.includes('--alarms-only');
const ALARM_LOG = 'logs/alarms.log';
mkdirSync('logs', { recursive: true });

interface Reaction {
  /** Яку властивість відстежуємо (feature/властивість). */
  path: string;
  /** Повертає текст тривоги для нового значення або null, якщо значення в нормі. */
  alarm: (value: unknown) => string | null;
  /** Текст, коли значення повернулося до норми. */
  recovered: string;
}

const REACTIONS: Reaction[] = [
  {
    path: 'operation/state',
    alarm: (v) => (v === 'fault' ? 'АВАРІЯ НАСОСА' : null),
    recovered: 'насос вийшов зі стану аварії',
  },
  {
    path: 'hydraulics/dryRun',
    alarm: (v) => (v === true ? 'СУХИЙ ХІД: немає води на вході' : null),
    recovered: 'вода на вході відновлена',
  },
  {
    path: 'condition/vibrationLevel',
    alarm: (v) => (v === 'warning' || v === 'critical' ? `підвищена вібрація (${String(v)})` : null),
    recovered: 'вібрація в нормі',
  },
  {
    path: 'condition/temperatureLevel',
    alarm: (v) => (v === 'warning' || v === 'critical' ? `перегрів підшипника (${String(v)})` : null),
    recovered: 'температура в нормі',
  },
  {
    path: 'summary/pressureStatus',
    alarm: (v) => (v === 'low' ? 'НИЗЬКИЙ ТИСК у мережі кварталу' : null),
    recovered: 'тиск у нормі',
  },
  {
    path: 'summary/stale',
    alarm: (v) => (v === true ? 'ВТРАЧЕНО ЗВ’ЯЗОК зі станцією' : null),
    recovered: 'зв’язок зі станцією відновлено',
  },
];

/** Які тривоги зараз активні: щоб повідомляти лише про початок і завершення, а не про кожне повторення. */
const activeAlarms = new Set<string>();

function react(change: PropertyChange): void {
  if (!ALARMS_ONLY) {
    console.log(`${time()}  ${change.thingName}: ${change.path} = ${JSON.stringify(change.value)}`);
  }

  const reaction = REACTIONS.find((candidate) => candidate.path === change.path);
  if (!reaction) return;

  const key = `${change.thingId}/${change.path}`;
  const alarm = reaction.alarm(change.value);
  if (alarm && !activeAlarms.has(key)) {
    activeAlarms.add(key);
    report(`⚠ ТРИВОГА  ${change.thingName}: ${alarm}`);
  } else if (!alarm && activeAlarms.has(key)) {
    activeAlarms.delete(key);
    report(`✓ НОРМА    ${change.thingName}: ${reaction.recovered}`);
  }
}

function report(message: string): void {
  const line = `${new Date().toISOString()}  ${message}`;
  console.log(`\n${time()}  ${message}\n`);
  appendFileSync(ALARM_LOG, line + '\n');
}

function time(): string {
  return new Date().toLocaleTimeString('uk-UA');
}

console.log(`Ditto: ${config.ditto.url}, тривоги записуються в ${ALARM_LOG}`);
await watchPropertyChanges(new DittoClient(), react, (message) => console.log(`${time()}  SSE: ${message}`));
