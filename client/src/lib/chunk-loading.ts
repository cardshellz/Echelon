/**
 * Loading of route chunks (the `import()` behind each lazy page).
 *
 * React.lazy remembers a failed import for good: once a chunk fails to load,
 * that page stays broken until the whole app is reloaded. A staff member who
 * opens a page they have not visited yet while the connection is down would
 * be stuck there even after it comes back. So a chunk that fails while the
 * browser is offline waits for the connection and tries again, and a failure
 * while online is retried a few times before it is reported.
 */

/** Attempts made while the browser reports a connection, before giving up. */
export const CHUNK_LOAD_ONLINE_ATTEMPTS = 3;
/** Wait before the second attempt; each later wait grows by the same amount. */
export const CHUNK_RETRY_BASE_DELAY_MS = 1_000;

export interface ChunkLoadEnvironment {
  isOnline(): boolean;
  /** Resolves when the browser next reports a connection. */
  waitForOnline(): Promise<void>;
  delay(ms: number): Promise<void>;
}

export const browserChunkLoadEnvironment: ChunkLoadEnvironment = {
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  waitForOnline: () => new Promise<void>((resolve) => {
    window.addEventListener("online", () => resolve(), { once: true });
  }),
  delay: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};

export async function loadChunkWithRetry<T>(
  load: () => Promise<T>,
  environment: ChunkLoadEnvironment = browserChunkLoadEnvironment,
): Promise<T> {
  let onlineFailures = 0;
  for (;;) {
    try {
      return await load();
    } catch (error) {
      if (!environment.isOnline()) {
        // Being offline is not the chunk's fault: wait, and do not count it.
        await environment.waitForOnline();
        continue;
      }
      onlineFailures += 1;
      if (onlineFailures >= CHUNK_LOAD_ONLINE_ATTEMPTS) {
        // A chunk that keeps failing with a connection is most likely gone
        // (a new release replaced it). Report it instead of spinning forever.
        throw error;
      }
      await environment.delay(CHUNK_RETRY_BASE_DELAY_MS * onlineFailures);
    }
  }
}
