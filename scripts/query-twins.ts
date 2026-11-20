/**
 * Запити до графа двійників у Eclipse Ditto (крок 5 КП 4):
 * поточний стан, пошук за значенням властивості, обхід зв’язків.
 *
 * Запуск: DITTO_URL=http://<адреса>:8080 pnpm twins:query [поріг вібрації, мм/с]
 */
import { config } from '../src/config.ts';
import { DittoClient, type Thing } from '../src/ditto/client.ts';
import { thingId } from '../src/ditto/models.ts';

const VIBRATION_THRESHOLD = Number(process.argv[2] ?? 1.4);
const ditto = new DittoClient();

console.log(`Ditto: ${config.ditto.url}`);

// ─── 1. Поточний стан ────────────────────────────────────────────────────────

section('1.1 Зведений стан станції', `GET /api/2/things/${thingId('station')}/features/summary`);
const station = await ditto.getThing(thingId('station'));
printProperties(station.features?.['summary']?.properties);

section('1.2 Поточний стан насоса Н1', `GET /api/2/things/${thingId('pump1')}`);
const pump1 = await ditto.getThing(thingId('pump1'));
for (const [feature, value] of Object.entries(pump1.features ?? {})) {
  console.log(`  ${feature}:`);
  printProperties(value.properties, '    ');
}

// ─── 2. Пошук за значенням властивості ───────────────────────────────────────

await searchAndPrint('2.1 Усі насоси', 'eq(attributes/type,"Pump")');
await searchAndPrint('2.2 Насоси, що зараз працюють', 'eq(features/operation/properties/state,"running")');
await searchAndPrint(
  `2.3 Насоси з вібрацією понад ${VIBRATION_THRESHOLD} мм/с`,
  `gt(features/condition/properties/vibration,${VIBRATION_THRESHOLD})`,
  'features/condition/properties/vibration',
);
await searchAndPrint(
  '2.4 Насоси з відхиленням від норми (рівень вібрації або температури не normal)',
  'and(eq(attributes/type,"Pump"),or(ne(features/condition/properties/vibrationLevel,"normal"),ne(features/condition/properties/temperatureLevel,"normal")))',
);

// ─── 3. Обхід зв’язків ───────────────────────────────────────────────────────

section('3.1 Склад станції (вниз за partOf)', 'eq(attributes/relations/partOf,"<двійник>") — рекурсивно від станції');
console.log(`  ${nameOf(station)} (${station.thingId})`);
await printChildren(thingId('station'), '  ');

section(
  '3.2 Від насоса Н1 до кореня графа (вгору за partOf)',
  `GET /api/2/things/<двійник> → attributes/relations/partOf`,
);
const upward: string[] = [];
let current: string | undefined = thingId('pump1');
while (current) {
  const thing = await ditto.getThing(current);
  upward.push(`${nameOf(thing)} (${thing.thingId})`);
  current = relationsOf(thing).partOf;
}
console.log(`  ${upward.join('\n  → ')}`);

section('3.3 Шлях води (за fedBy)', 'eq(attributes/relations/fedBy,"<двійник>") — від вхідного вузла');
const waterPath: string[] = [];
let node: Thing | undefined = await ditto.getThing(thingId('inlet'));
while (node) {
  waterPath.push(nameOf(node));
  const next = await ditto.search(`eq(attributes/relations/fedBy,"${node.thingId}")`, 'thingId,attributes');
  node = next[0];
}
console.log(`  ${waterPath.join(' → ')}`);

await searchAndPrint(
  '3.4 Двійники, якими керує шафа керування (controlledBy)',
  `eq(attributes/relations/controlledBy,"${thingId('cabinet')}")`,
);

// ─── Допоміжні функції ───────────────────────────────────────────────────────

function section(title: string, query: string): void {
  console.log(`\n${title}\n  запит: ${query}`);
}

function printProperties(properties: Record<string, unknown> | undefined, indent = '  '): void {
  for (const [name, value] of Object.entries(properties ?? {})) {
    console.log(`${indent}${name} = ${JSON.stringify(value)}`);
  }
}

async function searchAndPrint(title: string, filter: string, extraField?: string): Promise<void> {
  section(title, `GET /api/2/search/things?filter=${filter}`);
  const fields = ['thingId', 'attributes', ...(extraField ? [extraField] : [])].join(',');
  const things = await ditto.search(filter, fields);
  if (things.length === 0) console.log('  (нічого не знайдено)');
  for (const thing of things) {
    const extra = extraField ? `, ${extraField.split('/').at(-1)} = ${JSON.stringify(valueAt(thing, extraField))}` : '';
    console.log(`  ${thing.thingId} — ${nameOf(thing)}${extra}`);
  }
}

async function printChildren(parentId: string, indent: string): Promise<void> {
  const children = await ditto.search(`eq(attributes/relations/partOf,"${parentId}")`, 'thingId,attributes');
  for (const child of children) {
    console.log(`${indent}└─ ${nameOf(child)} (${child.thingId})`);
    await printChildren(child.thingId, `${indent}   `);
  }
}

function nameOf(thing: Thing | string): string {
  if (typeof thing === 'string') return thing;
  return String(thing.attributes?.['name'] ?? thing.thingId);
}

function relationsOf(thing: Thing): { partOf?: string; fedBy?: string; controlledBy?: string } {
  return (thing.attributes?.['relations'] ?? {}) as { partOf?: string; fedBy?: string; controlledBy?: string };
}

/** Значення за шляхом на кшталт features/condition/properties/vibration. */
function valueAt(thing: Thing, path: string): unknown {
  let value: unknown = thing;
  for (const key of path.split('/')) value = (value as Record<string, unknown> | undefined)?.[key];
  return value;
}
