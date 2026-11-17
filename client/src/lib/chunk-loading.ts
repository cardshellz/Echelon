/**
 * Loading of route chunks (the `import()` behind each lazy page).
 *
 * React.lazy remembers a failed import for good: once a chunk fails to load,
 * that page stays broken until the whole app is reloaded. A staff member who
 * opens a page they have not visited yet while the connection is down would
 * be stuck there even after it comes back. So:
 *
 *   1. a chunk that fails while the browser is offline waits for the
 *      connection and tries again;
 *   2. a failure while online is retried a few times;
 *   3. if it still fails, the page is reloaded once. Some browsers remember a
 *      failed module fetch, so repeating the same import() cannot succeed, and
 *      after a release the old chunk files no longer exist. A reload fixes
 *      both. The page that failed never rendered, so it holds nothing to lose.
 *   4. if a reload already happened moments ago, the error is reported
 *      instead, so a chunk that is really broken cannot cause a reload loop.
 */

/** Attempts made while the browser reports a connection, before reloading. */
export const CHUNK_LOAD_ONLINE_ATTEMPTS = 3;
/** Wait before the second attempt; each later wait grows by the same amount. */
export const CHUNK_RETRY_BASE_DELAY_MS = 1_000;
/** A second automatic reload within this window is refused. */
export const CHUNK_RELOAD_GUARD_MS = 60_000;
export const CHUNK_RELOAD_STORAGE_KEY = "echelon:chunk-reload-at";

export interface ChunkLoadEnvironment {
  isOnline(): boolean;
  /** Resolves when the browser next reports a connection. */
  waitForOnline(): Promise<void>;
  delay(ms: number): Promise<void>;
  /**
   * Reloads the page unless it was already reloaded for a chunk failure within
   * CHUNK_RELOAD_GUARD_MS. Returns whether a reload was started.
   */
  reloadOnce(): boolean;
}

export interface ReloadGuardDependencies {
  now(): number;
  readLastReload(): string | null;
  writeLastReload(value: string): void;
  reload(): void;
}

export function reloadUnlessRecent(dependencies: ReloadGuardDependencies): boolean {
  try {
    const now = dependencies.now();
    const last = Number(dependencies.readLastReload());
    if (Number.isFinite(last) && last > 0 && now - last < CHUNK_RELOAD_GUARD_MS) return false;
    // Record first: if the marker cannot be stored, do not reload at all,
    // because nothing would then stop a loop.
    dependencies.writeLastReload(String(now));
  } catch {
    return false;
  }
  dependencies.reload();
  return true;
}

export const browserChunkLoadEnvironment: ChunkLoadEnvironment = {
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  waitForOnline: () => new Promise<void>((resolve) => {
    window.addEventListener("online", () => resolve(), { once: true });
  }),
  delay: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  reloadOnce: () => reloadUnlessRecent({
    now: () => Date.now(),
    readLastReload: () => window.sessionStorage.getItem(CHUNK_RELOAD_STORAGE_KEY),
    writeLastReload: (value) => window.sessionStorage.setItem(CHUNK_RELOAD_STORAGE_KEY, value),
    reload: () => window.location.reload(),
  }),
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
        if (environment.reloadOnce()) {
          // The page is reloading; stay pending so the loading state remains
          // on screen until it does.
          return new Promise<T>(() => {});
        }
        throw error;
      }
      await environment.delay(CHUNK_RETRY_BASE_DELAY_MS * onlineFailures);
    }
  }
}
