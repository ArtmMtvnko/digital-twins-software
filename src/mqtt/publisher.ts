import { connect, type MqttClient } from 'mqtt';
import { config } from '../config.ts';
import type { Reading } from '../emulator/sampler.ts';
import type { Sensor } from '../emulator/sensors.ts';
import { STATUS_TOPIC, telemetryTopic, type TelemetryMessage } from '../shared/telemetry.ts';

/** Видавець: перетворює вимірювання емулятора на MQTT-повідомлення й надсилає їх у брокер. */
export class Publisher {
  private readonly client: MqttClient;
  /** Останній порядковий номер для кожного датчика. */
  private readonly sequences = new Map<string, number>();

  constructor() {
    this.client = connect(config.mqtt.url, {
      clientId: `${config.mqtt.stationId}-emulator`,
      // Last Will: якщо емулятор зникне без попередження, брокер сам опублікує «connection_lost»
      will: { topic: STATUS_TOPIC, payload: Buffer.from('connection_lost'), qos: 1, retain: true },
    });

    this.client.on('connect', () => {
      console.log(`MQTT: підключено до ${config.mqtt.url}`);
      this.client.publish(STATUS_TOPIC, 'online', { qos: 1, retain: true });
    });
    // Поки зв’язку немає, клієнт складає повідомлення в чергу й відправить їх після відновлення
    this.client.on('offline', () => console.log('MQTT: зв’язок втрачено, повідомлення накопичуються в черзі'));
    this.client.on('error', (error) => console.error(`MQTT: ${error.message}`));
  }

  publish(reading: Reading, sensor: Sensor): void {
    const seq = (this.sequences.get(reading.sensorId) ?? 0) + 1;
    this.sequences.set(reading.sensorId, seq);

    const message: TelemetryMessage = { ...reading, seq };
    this.client.publish(telemetryTopic(reading.sensorId), JSON.stringify(message), {
      qos: config.mqtt.qos,
      // Подієві сигнали рідкісні: брокер запам’ятовує останнє значення для нових підписників
      retain: sensor.frequency === 'event',
    });
  }

  /** Коректне завершення: самі повідомляємо «offline», тому Last Will не спрацює. */
  async close(): Promise<void> {
    await this.client.publishAsync(STATUS_TOPIC, 'offline', { qos: 1, retain: true });
    await this.client.endAsync();
  }
}
