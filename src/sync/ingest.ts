import { connect, type MqttClient } from 'mqtt';
import { config } from '../config.ts';
import {
  STATION_SUBSCRIPTION,
  STATUS_TOPIC,
  validateTelemetry,
  type TelemetryMessage,
} from '../shared/telemetry.ts';

/** Повідомлення телеметрії, прийняте сервісом синхронізації. */
export interface IncomingTelemetry {
  message: TelemetryMessage;
  /** Час вимірювання на станції, мс від епохи (з поля timestamp). */
  measuredAt: number;
  /** Час отримання сервісом синхронізації, мс від епохи. */
  receivedAt: number;
  /** true — це збережене брокером останнє значення (retained), а не нове вимірювання. */
  retained: boolean;
}

export interface IngestHandlers {
  onTelemetry: (item: IncomingTelemetry) => void;
  onInvalid: (topic: string, errors: string[]) => void;
  onStatus: (status: string) => void;
}

/** Підключається до брокера, приймає потік телеметрії станції й перевіряє структуру повідомлень. */
export function startIngest(handlers: IngestHandlers): MqttClient {
  const client = connect(config.mqtt.url, {
    clientId: `${config.mqtt.stationId}-sync`,
    // Постійна сесія: після обриву зв’язку брокер віддасть накопичені повідомлення QoS 1 і 2
    clean: false,
  });

  client.on('connect', async () => {
    console.log(`MQTT: підключено до ${config.mqtt.url}`);
    await client.subscribeAsync(STATION_SUBSCRIPTION, { qos: config.mqtt.qos });
  });
  client.on('error', (error) => console.error(`MQTT: ${error.message}`));

  client.on('message', (topic, payload, packet) => {
    const text = payload.toString();
    if (topic === STATUS_TOPIC) {
      handlers.onStatus(text);
      return;
    }

    const result = validateTelemetry(topic, text);
    if (!result.ok) {
      handlers.onInvalid(topic, result.errors);
      return;
    }

    handlers.onTelemetry({
      message: result.message,
      measuredAt: Date.parse(result.message.timestamp),
      receivedAt: Date.now(),
      retained: packet.retain,
    });
  });

  return client;
}
