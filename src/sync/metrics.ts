/** Накопичує значення затримки (мс) за період і видає середнє та максимум. */
export class LatencyStats {
  private sum = 0;
  private count = 0;
  private max = 0;

  add(ms: number): void {
    this.sum += ms;
    this.count++;
    this.max = Math.max(this.max, ms);
  }

  /** Підсумок за період; після виклику лічильники обнуляються. */
  takeSummary(): string {
    const summary =
      this.count === 0
        ? 'немає даних'
        : `середня ${(this.sum / this.count).toFixed(0)} мс, макс. ${this.max.toFixed(0)} мс (n = ${this.count})`;
    this.sum = 0;
    this.count = 0;
    this.max = 0;
    return summary;
  }
}
