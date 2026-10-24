/** Coalesce concurrent reads of the same channel projection. No completed
 * result is cached: the next request always reads current owner state. This
 * is process-local load control, not a correctness lock or write authority. */
export class ChannelReadCoordinator<T> {
  private readonly pending = new Map<number, Promise<T>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency = 4) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20)
      throw new RangeError("Channel read concurrency must be between one and twenty.");
  }

  read(projectionId: number, load: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(projectionId) || projectionId <= 0) throw new TypeError("A projection ID is required.");
    const existing = this.pending.get(projectionId);
    if (existing) return existing;
    const request = Promise.resolve().then(() => this.run(load)).finally(() => {
      if (this.pending.get(projectionId) === request) this.pending.delete(projectionId);
    });
    this.pending.set(projectionId, request);
    return request;
  }

  private async run(load: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await load(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
