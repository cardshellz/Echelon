import { publicationSelectionBusyIssue } from "./publication-selection-work";

const DEFAULT_RETRY_DELAYS_MS = [50, 150, 350] as const;

/** Retry only a complete, rolled-back database write. Never wrap provider calls
 * or a sequence that has already committed unrelated catalog mutations. */
export async function retryPublicationSelectionWrite<T>(
  write: () => Promise<T>,
  options: { sleep?: (milliseconds: number) => Promise<void>; delaysMs?: readonly number[];
    isRetryable?: (error: unknown) => boolean } = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  if (delays.length > 5 || delays.some(delay => !Number.isSafeInteger(delay) || delay < 0 || delay > 1_000)) {
    throw new TypeError("Publication selection retries require at most five bounded delays.");
  }
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const isRetryable = options.isRetryable ?? (error => publicationSelectionBusyIssue(error) !== null);
  for (let attempt = 0; ; attempt += 1) {
    try { return await write(); }
    catch (error) {
      if (!isRetryable(error) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
