/**
 * Two claims permit parallel work while leaving room for other connections in
 * the four-client PostgreSQL regression pool. Cooperating job repositories use
 * matching database permits to enforce this bound across processes; unrelated
 * consumers and provider rate limits remain independent.
 */
export const LISTING_WORK_CONCURRENCY = 2;

/** Claims only work that can start immediately and drains every acquired claim
 * before returning or propagating a failure. Claim ownership and retries remain
 * with each listing's durable job owner. */
export async function runDueListingWork<T>(options: {
  limit: number;
  claim(): Promise<T | null>;
  process(claim: T): Promise<void>;
}): Promise<void> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error("Invalid listing work limit.");
  const running = new Set<Promise<void>>();
  let started = 0;
  let failed = false;
  let firstFailure: unknown;
  const fail = (error: unknown) => {
    if (!failed) { failed = true; firstFailure = error; }
  };

  try {
    while (started < options.limit && !failed) {
      while (running.size < LISTING_WORK_CONCURRENCY && started < options.limit && !failed) {
        const claim = await options.claim();
        if (!claim) break;
        started += 1;
        // A claim that arrives while another job fails is still processed and
        // released. Never abandon a durable owner after acquiring it.
        let task: Promise<void>;
        task = Promise.resolve().then(() => options.process(claim)).catch(fail).finally(() => running.delete(task));
        running.add(task);
      }
      if (running.size === 0) break;
      await Promise.race(running);
    }
  } catch (error) {
    fail(error);
  } finally {
    await Promise.all(running);
  }
  if (failed) throw firstFailure;
}
