/**
 * Тест пропускної здатності конвеєра синхронізації (крок 7).
 * Проганяє синтетичні повідомлення через ті самі етапи, що й сервіс
 * (буфер → валідація → фільтр викидів → ресемплінг → правила → стан), але без MQTT і бази,
 * якомога швидше. Результат — скільки повідомлень за секунду здатен обробити конвеєр.
 *
 * Запуск: pnpm throughput [кількість повідомлень]
 */
import { OutlierFilter } from '../src/sync/outlier-filter.ts';
import { ReorderBuffer } from '../src/sync/reorder-buffer.ts';
import { Resampler } from '../src/sync/resampler.ts';
import { SIGNALS, type Signal } from '../src/sync/signals.ts';
import { TwinStateStore } from '../src/sync/state-store.ts';
import { SyncRules } from '../src/sync/sync-rules.ts';
import { validateValue } from '../src/sync/validation.ts';
import type { SensorValue } from '../src/shared/telemetry.ts';

const MESSAGE_COUNT = Number(process.argv[2] ?? 1_000_000);
/** Інтенсивність синтетичного потоку: повідомлень на секунду симульованого часу. */
const MESSAGES_PER_SIMULATED_SECOND = 1000;
const REORDER_DELAY_MS = 200;

interface Message {
  sensorId: string;
  value: SensorValue;
  measuredAt: number;
}

const buffer = new ReorderBuffer<Message>({ delayMs: REORDER_DELAY_MS, maxSize: 10_000 }, (m) => m.measuredAt);
const outlierFilter = new OutlierFilter();
const syncRules = new SyncRules();
const store = new TwinStateStore('benchmark');
let frames = 0;
let stateUpdates = 0;
store.subscribe(() => stateUpdates++);
const resampler = new Resampler((frame) => {
  frames++;
  store.apply(frame, syncRules.evaluate(frame));
});

/** Правдоподібне значення сигналу: середина діапазону з невеликим шумом або допустимий стан. */
function syntheticValue(signal: Signal): SensorValue {
  if (signal.kind === 'continuous') {
    const [min, max] = signal.range;
    return min + (max - min) * (0.4 + 0.02 * Math.random());
  }
  if (signal.id.endsWith('.state')) return 'running';
  if (signal.id === 'cabinet.mode') return 'auto';
  if (signal.id === 'cabinet.setpoint') return 5;
  return false;
}

function processMessage(message: Message): void {
  const check = validateValue(message.sensorId, message.value);
  if (!check.ok) return;
  let value = message.value;
  if (check.signal.kind === 'continuous' && typeof value === 'number') {
    value = outlierFilter.apply(check.signal, value).value;
  }
  resampler.add(message.sensorId, value, message.measuredAt);
}

// Повідомлення генеруються заздалегідь, щоб вимірювати лише роботу конвеєра
const start = Date.UTC(2026, 0, 1);
const messages: Message[] = Array.from({ length: MESSAGE_COUNT }, (_, i) => {
  const signal = SIGNALS[i % SIGNALS.length] as Signal;
  return { sensorId: signal.id, value: syntheticValue(signal), measuredAt: start + (i * 1000) / MESSAGES_PER_SIMULATED_SECOND };
});

const startedAt = performance.now();
for (const [i, message] of messages.entries()) {
  buffer.push(message);
  // Симульований час рухається разом із потоком: буфер видає «дозрілі» повідомлення
  if (i % 100 === 0) {
    const simulatedNow = message.measuredAt;
    for (const ripe of buffer.release(simulatedNow)) processMessage(ripe);
    resampler.advanceTo(simulatedNow - REORDER_DELAY_MS);
  }
}
const elapsedS = (performance.now() - startedAt) / 1000;

console.log(`Оброблено ${MESSAGE_COUNT.toLocaleString('uk-UA')} повідомлень за ${elapsedS.toFixed(2)} с`);
console.log(`Пропускна здатність конвеєра: ≈ ${Math.round(MESSAGE_COUNT / elapsedS).toLocaleString('uk-UA')} повідомлень/с`);
console.log(`Кадрів: ${frames}, оновлень стану: ${stateUpdates}`);
