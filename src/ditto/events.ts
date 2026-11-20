/**
 * Підписка на події Eclipse Ditto про зміну двійників через Server-Sent Events.
 *
 * Ditto надсилає подію на кожну зміну двійника у вигляді Thing JSON, що містить лише змінену частину.
 * Тут кожна подія розгортається в окремі зміни властивостей: «двійник, feature/властивість, нове значення».
 */
import type { DittoClient, Thing } from './client.ts';
import { NAMESPACE } from './models.ts';

export interface PropertyChange {
  thingId: string;
  /** Назва двійника (attributes/name), яку Ditto додає до події на наше прохання (extraFields). */
  thingName: string;
  /** feature/властивість, наприклад condition/vibrationLevel. */
  path: string;
  value: unknown;
}

const RECONNECT_DELAY_MS = 2000;

/**
 * Слухає зміни всіх двійників станції й викликає onChange для кожної зміненої властивості.
 * Якщо з’єднання обірвалося, перепідключається. Працює, доки не завершиться процес.
 */
export async function watchPropertyChanges(
  client: DittoClient,
  onChange: (change: PropertyChange) => void,
  onStatus: (message: string) => void,
): Promise<void> {
  const path = `/things?namespaces=${NAMESPACE}&extraFields=attributes/name`;

  for (;;) {
    try {
      const stream = await client.openEventStream(path);
      onStatus(`підписано на події двійників ${NAMESPACE}`);
      for await (const thing of readEvents(stream)) {
        for (const change of toPropertyChanges(thing)) onChange(change);
      }
      onStatus('потік подій закрито, перепідключення…');
    } catch (error) {
      onStatus(`немає з’єднання з Ditto (${(error as Error).message}), перепідключення…`);
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

/**
 * Розбирає потік SSE: події розділені порожнім рядком, корисні дані — у рядках «data:».
 * Порожні події (Ditto надсилає їх, щоб тримати з’єднання) пропускаються.
 */
async function* readEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<Thing> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const event = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      if (data !== '') yield JSON.parse(data) as Thing;
      separator = buffer.indexOf('\n\n');
    }
  }
}

function toPropertyChanges(thing: Thing): PropertyChange[] {
  const thingName = String(thing.attributes?.['name'] ?? thing.thingId);
  const changes: PropertyChange[] = [];
  for (const [feature, content] of Object.entries(thing.features ?? {})) {
    for (const [property, value] of Object.entries(content.properties ?? {})) {
      changes.push({ thingId: thing.thingId, thingName, path: `${feature}/${property}`, value });
    }
  }
  return changes;
}
