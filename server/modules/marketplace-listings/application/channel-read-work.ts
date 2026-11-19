/** Bound read fan-out without holding a database lease across another owner.
 * The result keeps input order; one rejection drains already-running work before
 * propagating so a retry cannot overlap abandoned reads. */
export async function mapChannelReads<T, R>(items: readonly T[], concurrency: number,
  read: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20)
    throw new RangeError("Channel read concurrency must be between one and twenty.");
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await read(items[index]); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
