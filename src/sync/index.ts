/**
 * Сервіс синхронізації (КП 3).
 * Конвеєр: приймання → буфер переупорядкування → валідація → фільтр викидів → ресемплінг до 1 Гц
 * → правила синхронізації → стан двійника в пам’яті → сповіщення підписників.
 * Історія телеметрії й змін стану записується в TimescaleDB.
 */
import { config } from '../config.ts';
import { HistoryWriter } from './history.ts';
import { startIngest, type IncomingTelemetry } from './ingest.ts';
import { OutlierFilter } from './outlier-filter.ts';
import { ReorderBuffer } from './reorder-buffer.ts';
import { Resampler, type Frame } from './resampler.ts';
import { TwinStateStore, type TwinChange } from './state-store.ts';
import { SyncRules } from './sync-rules.ts';
import { validateValue } from './validation.ts';

const buffer = new ReorderBuffer<IncomingTelemetry>(
  { delayMs: config.sync.reorderDelayMs, maxSize: config.sync.bufferMaxSize },
  (item) => item.measuredAt,
);
const outlierFilter = new OutlierFilter();
const resampler = new Resampler(handleFrame);
const syncRules = new SyncRules();
const store = new TwinStateStore(config.mqtt.stationId);
const history = new HistoryWriter();
await history.init();

// Підписник: кожна зміна стану двійника йде в історію
store.subscribe((update) => history.addStateUpdate(update));

// Підписник для демонстрації: виводить кожну зміну стану двійника
store.subscribe(({ state, changes }) => {
  console.log(`стан v${state.version}: ${changes.map(describeChange).join(', ')}`);
});

/** Лічильники за останню секунду. */
const stats = {
  received: 0,
  late: 0,
  rejected: 0,
  outliers: 0,
  frames: 0,
  event: 0,
  threshold: 0,
  periodic: 0,
  savedTelemetry: 0,
  savedStateChanges: 0,
};

const REASON_LABELS = { event: 'подія', threshold: 'поріг', periodic: 'періодично' } as const;

function describeChange(change: TwinChange): string {
  const value = change.value === null ? '∅' : String(change.value);
  return `${change.path} = ${value} (${REASON_LABELS[change.reason]})`;
}

const client = startIngest({
  onTelemetry(item) {
    stats.received++;

    // Retained — знімок останнього відомого значення: одразу запам’ятовуємо як початковий стан
    if (item.retained) {
      const check = validateValue(item.message.sensorId, item.message.value);
      if (check.ok) resampler.seed(item.message.sensorId, item.message.value, item.measuredAt);
      return;
    }

    // Запізніле повідомлення (наприклад, з черги брокера після обриву зв’язку) у потік стану не йде,
    // але в історію телеметрії записується з позначкою late
    const accepted = buffer.push(item);
    if (!accepted) stats.late++;
    history.addTelemetry(item, !accepted);
  },
  onInvalid(topic, errors) {
    stats.rejected++;
    console.warn(`✗ ${topic}: ${errors.join('; ')}`);
  },
  onStatus(status) {
    console.log(`◆ Джерело даних: ${status}`);
  },
});

setInterval(() => {
  const watermark = Date.now() - config.sync.reorderDelayMs;
  for (const item of buffer.release(Date.now())) preprocess(item);
  // Закриваємо секунди за таймером, щоб кадри йшли навіть без нових даних
  resampler.advanceTo(watermark);
}, config.sync.releaseIntervalMs);

/** Попередня обробка одного впорядкованого вимірювання. */
function preprocess(item: IncomingTelemetry): void {
  const { sensorId, value } = item.message;

  const check = validateValue(sensorId, value);
  if (!check.ok) {
    stats.rejected++;
    console.warn(`✗ ${sensorId}: ${check.reason}`);
    return;
  }

  let cleanValue = value;
  if (check.signal.kind === 'continuous' && typeof value === 'number') {
    const filtered = outlierFilter.apply(check.signal, value);
    if (filtered.isOutlier) {
      stats.outliers++;
      console.log(`  викид ${sensorId}: ${value} → ${filtered.value}`);
    }
    cleanValue = filtered.value;
  }

  if (!resampler.add(sensorId, cleanValue, item.measuredAt)) stats.late++;
}

/** Кадр на сітці 1 Гц: правила синхронізації вирішують, які значення переносити в стан двійника. */
function handleFrame(frame: Frame): void {
  stats.frames++;
  const changes = syncRules.evaluate(frame);
  for (const change of changes) stats[change.reason]++;
  store.apply(frame, changes);
}

setInterval(async () => {
  const saved = await history.flush();
  stats.savedTelemetry += saved.telemetry;
  stats.savedStateChanges += saved.stateChanges;
}, config.database.flushIntervalMs);

setInterval(() => {
  console.log(
    `— отримано ${stats.received} | запізнілих ${stats.late} | відхилено ${stats.rejected} | ` +
      `викидів ${stats.outliers} | кадрів ${stats.frames} | ` +
      `оновлень стану: за подією ${stats.event}, за порогом ${stats.threshold}, періодичних ${stats.periodic} | ` +
      `у БД: телеметрія ${stats.savedTelemetry}, зміни стану ${stats.savedStateChanges}`,
  );
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}, 1000);

process.on('SIGINT', async () => {
  await client.endAsync();
  await history.close(); // дописуємо в базу все, що встигли накопичити
  process.exit(0);
});
