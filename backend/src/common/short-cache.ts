/**
 * Results that may be up to `ttlMs` old, kept in this process. The same work
 * asked for twice at once runs once (the second caller gets the same promise);
 * a failure is never kept. Holds at most `max` entries, oldest out first.
 */
export class ShortCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 200,
  ) {}

  get(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    const entry = { at: now, value };
    this.entries.delete(key);
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
