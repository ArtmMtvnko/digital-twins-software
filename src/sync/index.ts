/**
 * Сервіс синхронізації (КП 3).
 * Конвеєр: приймання → буфер переупорядкування → валідація → фільтр викидів → ресемплінг до 1 Гц.
 */
import { config } from '../config.ts';
import { startIngest, type IncomingTelemetry } from './ingest.ts';
import { OutlierFilter } from './outlier-filter.ts';
import { ReorderBuffer } from './reorder-buffer.ts';
import { Resampler, type Frame } from './resampler.ts';
import { validateValue } from './validation.ts';

const buffer = new ReorderBuffer<IncomingTelemetry>(
  { delayMs: config.sync.reorderDelayMs, maxSize: config.sync.bufferMaxSize },
  (item) => item.measuredAt,
);
const outlierFilter = new OutlierFilter();
const resampler = new Resampler(handleFrame);

/** Лічильники за останню секунду. */
const stats = { received: 0, late: 0, rejected: 0, outliers: 0, frames: 0 };

const client = startIngest({
  onTelemetry(item) {
    stats.received++;

    // Retained — знімок останнього відомого значення: одразу запам’ятовуємо як початковий стан
    if (item.retained) {
      const check = validateValue(item.message.sensorId, item.message.value);
      if (check.ok) resampler.seed(item.message.sensorId, item.message.value, item.measuredAt);
      return;
    }

    // Запізніле повідомлення (наприклад, з черги брокера після обриву зв’язку) у потік не йде
    if (!buffer.push(item)) stats.late++;
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

/** Кадр на сітці 1 Гц. Поки що виводимо його коротко; на наступних кроках він оновлюватиме стан двійника. */
function handleFrame(frame: Frame): void {
  stats.frames++;
  const show = (id: string) => {
    const entry = frame.values[id];
    if (!entry || entry.value === null) return '∅';
    const mark = entry.quality === 'held' ? '*' : '';
    return `${typeof entry.value === 'number' ? entry.value.toFixed(2) : entry.value}${mark}`;
  };
  const qualities = Object.values(frame.values).map((entry) => entry.quality);
  const count = (quality: string) => qualities.filter((q) => q === quality).length;

  console.log(
    `кадр ${new Date(frame.time).toISOString().slice(11, 19)} | ` +
      `p_in ${show('inlet.pressure')} p_out ${show('outlet.pressure')} Q ${show('outlet.flow')} | ` +
      `Н1 ${show('pump1.state')} v ${show('pump1.vibration')} T ${show('pump1.bearing_temperature')} | ` +
      `якість: ${count('measured')} виміряно, ${count('held')} утримано, ${count('missing')} немає`,
  );
}

setInterval(() => {
  console.log(
    `— отримано ${stats.received} | запізнілих ${stats.late} | відхилено ${stats.rejected} | ` +
      `викидів ${stats.outliers} | кадрів ${stats.frames} | у буфері ${buffer.size}`,
  );
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}, 1000);

process.on('SIGINT', async () => {
  await client.endAsync();
  process.exit(0);
});
