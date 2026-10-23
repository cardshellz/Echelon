/** Coalesce concurrent reads of the same channel projection. No completed
 * result is cached: the next request always reads current owner state. This
 * is process-local load control, not a correctness lock or write authority. */
export class ChannelReadCoordinator<T> {
  private readonly pending = new Map<number, Promise<T>>();

  read(channelId: number, load: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(channelId) || channelId <= 0) throw new TypeError("A channel ID is required.");
    const existing = this.pending.get(channelId);
    if (existing) return existing;
    const request = Promise.resolve().then(load).finally(() => {
      if (this.pending.get(channelId) === request) this.pending.delete(channelId);
    });
    this.pending.set(channelId, request);
    return request;
  }
}
