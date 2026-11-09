import type { ContinuousSignal } from './signals.ts';

/** Скільки попередніх значень брати для медіани. */
const WINDOW_SIZE = 3;
/** Поріг у «розкидах» (MAD), як у класичному фільтрі Гампеля. */
const THRESHOLD_SIGMAS = 3;
/** Множник, що перетворює MAD на оцінку стандартного відхилення для нормального розподілу. */
const MAD_TO_SIGMA = 1.4826;

/**
 * Фільтр Гампеля: значення вважається викидом, якщо воно відхиляється від медіани
 * кількох попередніх значень більше, ніж на 3 розкиди (але не менше за outlierMinDeviation).
 * Викид замінюється медіаною.
 *
 * Обмеження: при справжній різкій зміні (насос зупинився) перші 2 значення після неї
 * теж буде замінено, доки медіана не «наздожене» новий рівень.
 */
export class OutlierFilter {
  /** Останні сирі (не замінені) значення кожного датчика. */
  private readonly history = new Map<string, number[]>();

  /** Повертає відфільтроване значення й ознаку, чи був це викид. */
  apply(signal: ContinuousSignal, value: number): { value: number; isOutlier: boolean } {
    const window = this.history.get(signal.id) ?? [];
    this.history.set(signal.id, [...window, value].slice(-WINDOW_SIZE));

    if (window.length < WINDOW_SIZE) return { value, isOutlier: false };

    const windowMedian = median(window);
    const mad = median(window.map((x) => Math.abs(x - windowMedian)));
    const threshold = Math.max(THRESHOLD_SIGMAS * MAD_TO_SIGMA * mad, signal.outlierMinDeviation);

    return Math.abs(value - windowMedian) > threshold
      ? { value: windowMedian, isOutlier: true }
      : { value, isOutlier: false };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}
