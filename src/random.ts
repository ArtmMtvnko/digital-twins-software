/** Випадкове число з нормальним розподілом (метод Бокса — Мюллера). */
export function gaussian(mean = 0, standardDeviation = 1): number {
  const u = 1 - Math.random(); // (0, 1], щоб не отримати log(0)
  const v = Math.random();
  const standardNormal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + standardDeviation * standardNormal;
}

/** Випадковий елемент непорожнього масиву. */
export function pickRandom<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('pickRandom: масив порожній');
  return item;
}
