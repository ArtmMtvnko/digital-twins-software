/**
 * Аналіз журналу підписника: втрати, дублікати й затримки по кожному датчику.
 * Запуск: pnpm analyze [шлях до журналу]  →  scripts/analyze-report.md (Markdown).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Звіт зберігається поруч зі скриптом, незалежно від того, з якої папки його запущено. */
const REPORT_PATH = new URL('./analyze-report.md', import.meta.url);

/** Запис журналу logs/telemetry.jsonl (поля, потрібні для аналізу). */
interface JournalEntry {
  receivedAt: string;
  topic: string;
  sensorId?: string;
  timestamp?: string;
  seq?: number;
  status?: string;
  invalid?: boolean;
  retained?: boolean;
}

interface SensorStats {
  received: number;
  lost: number;
  duplicates: number;
  latenciesMs: number[];
  /** Скільки інтервалів між першим і останнім seq (сума по всіх прогонах). */
  seqSpan: number;
  /** Скільки часу датчик реально публікував дані (сума по всіх прогонах, без пауз між ними), мс. */
  activeMs: number;
}

const journalPath = process.argv[2] ?? 'logs/telemetry.jsonl';
const entries = readFileSync(journalPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as JournalEntry);

const invalidCount = entries.filter((entry) => entry.invalid).length;
const statusChanges = entries.filter((entry) => entry.status !== undefined && !entry.retained);

// Retained-повідомлення — повтори останнього значення при підписці, а не нова телеметрія
const telemetry = entries.filter((entry) => !entry.invalid && !entry.retained && entry.sensorId !== undefined);

const statsBySensor = new Map<string, SensorStats>();
for (const [sensorId, sensorEntries] of groupBy(telemetry, (entry) => entry.sensorId ?? '')) {
  statsBySensor.set(sensorId, analyzeSensor(sensorEntries));
}

const report = buildReport();
writeFileSync(REPORT_PATH, report);
console.log(report);
console.log(`Звіт збережено у ${fileURLToPath(REPORT_PATH)}`);

/**
 * Рахує показники одного датчика. Записи йдуть у порядку отримання.
 * Емулятор після перезапуску починає нумерацію з 1, тож seq = 1 відкриває новий «прогін»,
 * і втрати рахуються в межах кожного прогону окремо.
 */
function analyzeSensor(sensorEntries: JournalEntry[]): SensorStats {
  const stats: SensorStats = {
    received: sensorEntries.length,
    lost: 0,
    duplicates: 0,
    latenciesMs: [],
    seqSpan: 0,
    activeMs: 0,
  };

  // Номери й мітки часу поточного прогону
  let seenInRun = new Set<number>();
  let runTimestamps: number[] = [];

  const closeRun = () => {
    if (seenInRun.size === 0) return;
    const span = Math.max(...seenInRun) - Math.min(...seenInRun);
    stats.seqSpan += span;
    stats.lost += span + 1 - seenInRun.size;
    stats.activeMs += Math.max(...runTimestamps) - Math.min(...runTimestamps);
  };

  for (const entry of sensorEntries) {
    const seq = entry.seq ?? 0;
    if (seq === 1 && seenInRun.size > 0) {
      closeRun();
      seenInRun = new Set();
      runTimestamps = [];
    }
    if (seenInRun.has(seq)) stats.duplicates++;
    seenInRun.add(seq);

    const sentAt = Date.parse(entry.timestamp ?? '');
    runTimestamps.push(sentAt);
    stats.latenciesMs.push(Date.parse(entry.receivedAt) - sentAt);
  }
  closeRun();
  return stats;
}

/** Збирає звіт у форматі Markdown. */
function buildReport(): string {
  // Активний час — скільки емулятор реально працював, без пауз між запусками.
  // Найточніше його показує найчастіший датчик, тож беремо максимум.
  const activeS = Math.max(0, ...[...statsBySensor.values()].map((stats) => stats.activeMs)) / 1000;
  const statusHistory = statusChanges.map((entry) => entry.status).join(' → ') || 'немає';

  const lines = [
    '## Аналіз каналу телеметрії',
    '',
    `- Журнал: \`${journalPath}\``,
    `- Час роботи емулятора (без пауз між запусками): ${activeS.toFixed(0)} с`,
    `- Повідомлень телеметрії: ${telemetry.length} (≈ ${(telemetry.length / activeS).toFixed(1)} за секунду)`,
    `- Некоректних повідомлень: ${invalidCount}`,
    `- Змін статусу джерела: ${statusHistory}`,
    '',
    '| Датчик | Частота, Гц | Отримано | Втрачено | Втрати, % | Дублікати | Затримка сер., мс | p95, мс | Макс., мс |',
    '|---|---|---|---|---|---|---|---|---|',
  ];

  for (const sensorId of [...statsBySensor.keys()].sort()) {
    const stats = statsBySensor.get(sensorId);
    if (stats) lines.push(tableRow(sensorId, stats, frequencyHz(stats)));
  }
  lines.push(tableRow('**Усього**', mergeStats([...statsBySensor.values()]), '—'));

  return lines.join('\n') + '\n';
}

function tableRow(name: string, stats: SensorStats, frequency: string): string {
  const total = stats.received - stats.duplicates + stats.lost;
  const lossPercent = total > 0 ? (100 * stats.lost) / total : 0;
  const latencies = [...stats.latenciesMs].sort((a, b) => a - b);
  return [
    name,
    frequency,
    stats.received,
    stats.lost,
    lossPercent.toFixed(2),
    stats.duplicates,
    average(latencies).toFixed(1),
    percentile(latencies, 95).toFixed(0),
    (latencies.at(-1) ?? 0).toFixed(0),
  ]
    .join(' | ')
    .replace(/^/, '| ')
    .concat(' |');
}

/**
 * Частота публікації за номерами seq (враховує й втрачені повідомлення).
 */
function frequencyHz(stats: SensorStats): string {
  const activeS = stats.activeMs / 1000;
  // Менше двох повідомлень за запуск (подієвий датчик або занадто короткий запуск) — частоту не визначити
  if (stats.seqSpan === 0 || activeS <= 0) return '—';
  // Дві значущі цифри: 9.998 → 10, 0.0999 → 0.1
  return String(Number((stats.seqSpan / activeS).toPrecision(2)));
}

function mergeStats(all: SensorStats[]): SensorStats {
  return {
    received: sum(all.map((stats) => stats.received)),
    lost: sum(all.map((stats) => stats.lost)),
    duplicates: sum(all.map((stats) => stats.duplicates)),
    latenciesMs: all.flatMap((stats) => stats.latenciesMs),
    seqSpan: sum(all.map((stats) => stats.seqSpan)),
    activeMs: Math.max(0, ...all.map((stats) => stats.activeMs)),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item)) ?? [];
    group.push(item);
    groups.set(key(item), group);
  }
  return groups;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  return values.length > 0 ? sum(values) / values.length : 0;
}

/** Значення, якого не перевищують `p` відсотків вимірювань (масив має бути відсортований). */
function percentile(sortedValues: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(index, 0)] ?? 0;
}
