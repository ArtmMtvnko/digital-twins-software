import { createWriteStream, mkdirSync } from 'node:fs';
import { connect } from 'mqtt';
import { config } from '../config.ts';
import { STATION_SUBSCRIPTION, STATUS_TOPIC, validateTelemetry } from '../shared/telemetry.ts';

/** Журнал у форматі JSON Lines: кожен рядок — окремий JSON-запис. */
const JOURNAL_PATH = 'logs/telemetry.jsonl';
mkdirSync('logs', { recursive: true });
const journal = createWriteStream(JOURNAL_PATH, { flags: 'a' });

const client = connect(config.mqtt.url, {
  clientId: `${config.mqtt.stationId}-subscriber`,
  // Постійна сесія: після перепідключення брокер упізнає підписника за clientId
  // і віддасть повідомлення QoS 1 і 2, які накопичились, поки його не було
  clean: false,
});

let validCount = 0;
let invalidCount = 0;

client.on('connect', async () => {
  console.log(`MQTT: підключено до ${config.mqtt.url}`);
  await client.subscribeAsync(STATION_SUBSCRIPTION, { qos: config.mqtt.qos });
  console.log(`Підписано на ${STATION_SUBSCRIPTION}, журнал: ${JOURNAL_PATH}`);
});
client.on('error', (error) => console.error(`MQTT: ${error.message}`));

client.on('message', (topic, payload) => {
  const receivedAt = new Date().toISOString();
  const text = payload.toString();

  if (topic === STATUS_TOPIC) {
    console.log(`${receivedAt}  ◆ Джерело даних: ${text}`);
    writeToJournal({ receivedAt, topic, status: text });
    return;
  }

  const result = validateTelemetry(topic, text);
  if (result.ok) {
    validCount++;
    writeToJournal({ receivedAt, topic, ...result.message });
  } else {
    invalidCount++;
    console.warn(`${receivedAt}  ✗ ${topic}: ${result.errors.join('; ')}`);
    writeToJournal({ receivedAt, topic, invalid: true, errors: result.errors, payload: text });
  }
});

function writeToJournal(entry: object): void {
  journal.write(JSON.stringify(entry) + '\n');
}

setInterval(() => {
  console.log(`Отримано за секунду: ${validCount} коректних, ${invalidCount} некоректних`);
  validCount = 0;
  invalidCount = 0;
}, 1000);

process.on('SIGINT', async () => {
  await client.endAsync();
  journal.end(() => process.exit(0));
});
