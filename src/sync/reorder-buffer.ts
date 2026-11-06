/**
 * Буфер переупорядкування: утримує елементи `delayMs` мілісекунд
 * і видає їх у порядку часових міток вимірювання, а не в порядку надходження.
 *
 * Вотермарка W = now − delayMs: усі елементи з міткою часу ≤ W вважаються «дозрілими»
 * й видаються. Елемент, мітка якого ≤ вже досягнутої вотермарки, — запізнілий:
 * поставити його в правильне місце вже неможливо, бо новіші елементи видано.
 */
export class ReorderBuffer<T> {
  /** Елементи, відсортовані за часом. */
  private readonly items: T[] = [];
  private watermark = -Infinity;

  constructor(
    private readonly options: { delayMs: number; maxSize: number },
    private readonly timeOf: (item: T) => number,
  ) {}

  get size(): number {
    return this.items.length;
  }

  /** Додає елемент у буфер. Повертає false, якщо елемент запізнився. */
  push(item: T): boolean {
    const time = this.timeOf(item);
    if (time <= this.watermark) return false;
    this.items.splice(this.insertionIndex(time), 0, item);
    return true;
  }

  /** Видає дозрілі елементи в хронологічному порядку. */
  release(now: number): T[] {
    this.watermark = Math.max(this.watermark, now - this.options.delayMs);

    const ripeCount = this.insertionIndex(this.watermark);
    // Захист від переповнення: якщо буфер завеликий, найстаріші елементи видаються достроково
    const overflowCount = this.items.length - this.options.maxSize;
    const released = this.items.splice(0, Math.max(ripeCount, overflowCount));

    // Після дострокової видачі вотермарка зсувається до останнього виданого елемента,
    // щоб старіші за нього елементи надалі вважалися запізнілими
    const lastReleased = released.at(-1);
    if (lastReleased !== undefined) {
      this.watermark = Math.max(this.watermark, this.timeOf(lastReleased));
    }
    return released;
  }

  /**
   * Позиція, куди вставити елемент із часом `time`, щоб масив лишився відсортованим.
   * Елементи з однаковим часом зберігають порядок надходження (вставка після них).
   */
  private insertionIndex(time: number): number {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const item = this.items[middle];
      if (item !== undefined && this.timeOf(item) <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
