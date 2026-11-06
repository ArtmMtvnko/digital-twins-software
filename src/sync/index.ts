/**
 * Сервіс синхронізації (КП 3): приймає потік телеметрії, упорядковує його
 * за часом вимірювання й передає далі на обробку.
 */
import { config } from '../config.ts';
import { startIngest, type IncomingTelemetry } from './ingest.ts';
import { ReorderBuffer } from './reorder-buffer.ts';

const buffer = new ReorderBuffer<IncomingTelemetry>(
  { delayMs: config.sync.reorderDelayMs, maxSize: config.sync.bufferMaxSize },
  (item) => item.measuredAt,
);

/** Лічильники за останню секунду. */
const stats = { received: 0, arrivedOutOfOrder: 0, late: 0, released: 0, releasedOutOfOrder: 0, invalid: 0 };
let latestArrivedAt = -Infinity;
let latestReleasedAt = -Infinity;

const client = startIngest({
  onTelemetry(item) {
    stats.received++;

    // Retained — знімок останнього відомого значення, а не подія потоку: передаємо одразу
    if (item.retained) {
      handleOrdered(item);
      return;
    }

    if (item.measuredAt < latestArrivedAt) stats.arrivedOutOfOrder++;
    latestArrivedAt = Math.max(latestArrivedAt, item.measuredAt);

    if (!buffer.push(item)) {
      // Запізніле повідомлення (наприклад, з черги брокера після обриву зв’язку):
      // для поточного стану воно застаріле. На наступних кроках воно піде лише в історію.
      stats.late++;
    }
  },
  onInvalid(topic, errors) {
    stats.invalid++;
    console.warn(`✗ ${topic}: ${errors.join('; ')}`);
  },
  onStatus(status) {
    console.log(`◆ Джерело даних: ${status}`);
  },
});

setInterval(() => {
  for (const item of buffer.release(Date.now())) handleOrdered(item);
}, config.sync.releaseIntervalMs);

/** Обробка впорядкованого повідомлення. Поки що лише перевіряємо порядок; далі тут буде оновлення стану. */
function handleOrdered(item: IncomingTelemetry): void {
  stats.released++;
  if (!item.retained) {
    if (item.measuredAt < latestReleasedAt) stats.releasedOutOfOrder++;
    latestReleasedAt = item.measuredAt;
  }
}

setInterval(() => {
  console.log(
    `отримано ${stats.received} | не по порядку ${stats.arrivedOutOfOrder} | запізнілих ${stats.late} | ` +
      `видано ${stats.released} | порушень порядку на виході ${stats.releasedOutOfOrder} | у буфері ${buffer.size}`,
  );
  for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
}, 1000);

process.on('SIGINT', async () => {
  await client.endAsync();
  process.exit(0);
});
