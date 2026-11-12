/**
 * Сценарій «сплеск інтенсивності даних» (крок 8): протягом заданого часу публікує в топіки
 * станції значно більше повідомлень, ніж емулятор. Значення правдоподібні (типові для штатної
 * роботи), щоб навантажити конвеєр, не спотворюючи стан двійника.
 *
 * Запуск: pnpm burst [повідомлень за секунду] [тривалість, с]   (за замовчуванням 1000 і 10)
 */
import { connect } from 'mqtt';
import { config } from '../src/config.ts';
import { telemetryTopic, type TelemetryMessage } from '../src/shared/telemetry.ts';

const RATE = Number(process.argv[2] ?? 1000);
const DURATION_S = Number(process.argv[3] ?? 10);
const TICK_MS = 10;

/** Типові значення неперервних сигналів у штатному режимі (Н2 у резерві; повільну температуру не чіпаємо). */
const TYPICAL: Record<string, { value: number; unit: string; noise: number }> = {
  'inlet.pressure': { value: 2.15, unit: 'bar', noise: 0.02 },
  'outlet.pressure': { value: 5.0, unit: 'bar', noise: 0.02 },
  'outlet.flow': { value: 60, unit: 'm3/h', noise: 1 },
  'pump1.vibration': { value: 1.35, unit: 'mm/s', noise: 0.1 },
  'pump1.speed': { value: 2500, unit: 'rpm', noise: 5 },
  'pump1.power': { value: 7.2, unit: 'kW', noise: 0.1 },
};
const SENSOR_IDS = Object.keys(TYPICAL);

const client = connect(config.mqtt.url, { clientId: `${config.mqtt.stationId}-burst` });
await new Promise<void>((resolve) => client.on('connect', () => resolve()));
console.log(`Сплеск: ${RATE} повідомлень/с протягом ${DURATION_S} с → ${config.mqtt.url}`);

// Номери seq сплеску починаються з мільйона, щоб в історії їх легко відрізнити від емулятора
const sequences = new Map<string, number>();
const messagesPerTick = Math.max(1, Math.round((RATE * TICK_MS) / 1000));
const totalTicks = Math.round((DURATION_S * 1000) / TICK_MS);
let sent = 0;

for (let tick = 0; tick < totalTicks; tick++) {
  for (let i = 0; i < messagesPerTick; i++) {
    const sensorId = SENSOR_IDS[sent % SENSOR_IDS.length] ?? 'outlet.flow';
    const typical = TYPICAL[sensorId] ?? { value: 0, unit: '', noise: 0 };
    const seq = (sequences.get(sensorId) ?? 1_000_000) + 1;
    sequences.set(sensorId, seq);

    const message: TelemetryMessage = {
      sensorId,
      value: Math.round((typical.value + (Math.random() - 0.5) * 2 * typical.noise) * 100) / 100,
      unit: typical.unit,
      timestamp: new Date().toISOString(),
      seq,
    };
    client.publish(telemetryTopic(sensorId), JSON.stringify(message), { qos: config.mqtt.qos });
    sent++;
  }
  await new Promise((resolve) => setTimeout(resolve, TICK_MS));
}

await client.endAsync();
console.log(`Надіслано ${sent} повідомлень`);
