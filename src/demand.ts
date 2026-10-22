/**
 * Добовий профіль водоспоживання кварталу: у скільки разів витрата
 * в цю годину більша за середню. Пік уранці (07–09) і ввечері (18–21), мінімум уночі.
 */
const HOURLY_FACTOR = [
  0.3, 0.25, 0.25, 0.25, 0.3, 0.5, // 00–05
  1.2, 2.0, 2.2, 1.6, 1.1, 1.0, //    06–11
  1.0, 1.0, 0.9, 0.9, 1.0, 1.3, //    12–17
  1.8, 2.0, 2.0, 1.6, 1.0, 0.5, //    18–23
];

export const MAX_DEMAND_FACTOR = Math.max(...HOURLY_FACTOR);

/**
 * Коефіцієнт споживання для моменту доби. Між годинами значення
 * плавно інтерполюється, щоб витрата не змінювалась стрибками.
 */
export function demandFactor(hourOfDay: number): number {
  const hour = Math.floor(hourOfDay);
  const fraction = hourOfDay - hour;
  return factorAt(hour) * (1 - fraction) + factorAt(hour + 1) * fraction;
}

function factorAt(hour: number): number {
  const factor = HOURLY_FACTOR[hour % 24];
  if (factor === undefined) throw new Error(`Немає коефіцієнта споживання для години ${hour}`);
  return factor;
}
