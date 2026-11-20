/**
 * Будує граф двійників станції в Eclipse Ditto (крок 3 КП 4):
 * створює всі двійники з models.ts разом зі зв’язками й перевіряє зв’язки пошуком.
 * Скрипт можна запускати повторно: наявні двійники просто перезаписуються.
 *
 * Запуск: DITTO_URL=http://<адреса>:8080 pnpm twins:create
 */
import { config } from '../src/config.ts';
import { DittoClient } from '../src/ditto/client.ts';
import { NAMESPACE, THING_MODELS } from '../src/ditto/models.ts';

const ditto = new DittoClient();
console.log(`Ditto: ${config.ditto.url}\n`);

for (const model of THING_MODELS) {
  const created = await ditto.putThing(model);
  console.log(`${created ? 'створено   ' : 'оновлено   '} ${model.thingId}`);
}

// Пошуковий індекс Ditto оновлюється асинхронно, тож даємо йому кілька секунд
console.log('\nОчікування оновлення пошукового індексу…');
await new Promise((resolve) => setTimeout(resolve, 3000));

// Перевірка графа: для кожного двійника — які двійники пов’язані з ним кожним типом зв’язку
console.log('\nЗв’язки в графі:');
for (const model of THING_MODELS) {
  for (const relation of ['partOf', 'fedBy', 'controlledBy'] as const) {
    const related = await ditto.search(`eq(attributes/relations/${relation},"${model.thingId}")`, 'thingId');
    if (related.length > 0) {
      console.log(`  ${model.thingId} ← ${relation} ← ${related.map((thing) => thing.thingId).join(', ')}`);
    }
  }
}

const all = await ditto.search(`like(thingId,"${NAMESPACE}:*")`, 'thingId');
console.log(`\nУсього двійників станції в Ditto: ${all.length}`);