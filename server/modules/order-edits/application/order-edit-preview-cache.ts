import { OrderEditError } from "../domain/order-edit-error";

interface Entry<T> {
  value: T;
  expiresAt: number;
}
/** Process-local, bounded and disposable. Never used by quote, commit or recovery. */
export class OrderEditPreviewCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<Entry<T>>>();
  constructor(
    private readonly clock: () => Date,
    private readonly maxEntries: number,
    private readonly maxConcurrent: number,
  ) {
    if (
      ![maxEntries, maxConcurrent].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new OrderEditError(
        "ORDER_EDIT_PREVIEW_CONFIGURATION_INVALID",
        "Preview cache limits must be positive integers.",
        503,
      );
  }
  private now(): number {
    const now = this.clock().getTime();
    if (!Number.isFinite(now))
      throw new OrderEditError(
        "ORDER_EDIT_PREVIEW_CLOCK_INVALID",
        "Preview expiry could not be verified.",
        503,
      );
    return now;
  }
  async getOrLoad(
    key: string,
    load: () => Promise<Entry<T>>,
  ): Promise<Entry<T>> {
    const now = this.now();
    for (const [id, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(id);
    const cached = this.entries.get(key);
    if (cached) return structuredClone(cached);
    const existing = this.pending.get(key);
    if (existing) return structuredClone(await existing);
    if (this.pending.size >= this.maxConcurrent)
      throw new OrderEditError(
        "ORDER_EDIT_PREVIEW_BUSY",
        "Background preview is busy. Review can still verify the changes.",
        503,
      );
    const work = Promise.resolve()
      .then(load)
      .then((entry) => {
        if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= this.now())
          throw new OrderEditError(
            "ORDER_EDIT_PREVIEW_EXPIRED",
            "The background preview expired. Review will verify the current changes.",
          );
        while (this.entries.size >= this.maxEntries)
          this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, structuredClone(entry));
        return entry;
      });
    this.pending.set(key, work);
    try {
      return structuredClone(await work);
    } finally {
      this.pending.delete(key);
    }
  }
}
