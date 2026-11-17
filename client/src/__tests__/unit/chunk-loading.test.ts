import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_LOAD_ONLINE_ATTEMPTS,
  CHUNK_RELOAD_GUARD_MS,
  CHUNK_RETRY_BASE_DELAY_MS,
  loadChunkWithRetry,
  reloadUnlessRecent,
  type ChunkLoadEnvironment,
} from "@/lib/chunk-loading";

function environment(overrides: Partial<ChunkLoadEnvironment> = {}) {
  const base = {
    isOnline: (): boolean => true,
    waitForOnline: vi.fn<() => Promise<void>>(async () => undefined),
    delay: vi.fn<(ms: number) => Promise<void>>(async () => undefined),
    reloadOnce: vi.fn<() => boolean>(() => false),
  };
  // Overrides keep the mock types, so tests can still inspect the calls.
  return { ...base, ...overrides } as typeof base;
}

const failure = (message: string) => new TypeError(message);
const failingLoad = (last: Error) => vi.fn<() => Promise<string>>()
  .mockRejectedValueOnce(failure("missing"))
  .mockRejectedValueOnce(failure("missing"))
  .mockRejectedValueOnce(last);

describe("loadChunkWithRetry", () => {
  it("returns the chunk on the first attempt without waiting", async () => {
    const env = environment();
    const load = vi.fn(async () => "chunk");

    await expect(loadChunkWithRetry(load, env)).resolves.toBe("chunk");
    expect(load).toHaveBeenCalledOnce();
    expect(env.delay).not.toHaveBeenCalled();
    expect(env.waitForOnline).not.toHaveBeenCalled();
    expect(env.reloadOnce).not.toHaveBeenCalled();
  });

  it("waits for the connection when a chunk fails offline, then loads it", async () => {
    let online = false;
    const env = environment({
      isOnline: () => online,
      waitForOnline: vi.fn(async () => { online = true; }),
    });
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce("chunk");

    await expect(loadChunkWithRetry(load, env)).resolves.toBe("chunk");
    expect(env.waitForOnline).toHaveBeenCalledOnce();
    expect(env.delay).not.toHaveBeenCalled();
  });

  it("does not count offline failures against the online attempt limit", async () => {
    let offlineFailuresLeft = CHUNK_LOAD_ONLINE_ATTEMPTS + 2;
    let online = false;
    const env = environment({ isOnline: () => online });
    // More offline failures than the online limit allows, then a connection.
    const load = vi.fn(async () => {
      if (offlineFailuresLeft > 0) {
        offlineFailuresLeft -= 1;
        throw failure("offline");
      }
      online = true;
      return "chunk";
    });

    await expect(loadChunkWithRetry(load, env)).resolves.toBe("chunk");
    expect(env.waitForOnline).toHaveBeenCalledTimes(CHUNK_LOAD_ONLINE_ATTEMPTS + 2);
    expect(env.reloadOnce).not.toHaveBeenCalled();
  });

  it("retries an online failure with a growing delay and then succeeds", async () => {
    const env = environment();
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure("first"))
      .mockRejectedValueOnce(failure("second"))
      .mockResolvedValueOnce("chunk");

    await expect(loadChunkWithRetry(load, env)).resolves.toBe("chunk");
    expect(env.delay.mock.calls).toEqual([[CHUNK_RETRY_BASE_DELAY_MS], [CHUNK_RETRY_BASE_DELAY_MS * 2]]);
    expect(env.reloadOnce).not.toHaveBeenCalled();
  });

  it("reloads the page once the online attempts are used up, and stays pending while it does", async () => {
    const env = environment({ reloadOnce: vi.fn(() => true) });
    const load = failingLoad(failure("still missing"));
    const settled = vi.fn();

    void loadChunkWithRetry(load, env).then(settled, settled);
    await vi.waitFor(() => expect(env.reloadOnce).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(CHUNK_LOAD_ONLINE_ATTEMPTS);
    expect(env.delay).toHaveBeenCalledTimes(CHUNK_LOAD_ONLINE_ATTEMPTS - 1);
    expect(settled).not.toHaveBeenCalled();
  });

  it("reports the last error when a reload was already used, so a broken chunk cannot loop", async () => {
    const env = environment({ reloadOnce: vi.fn(() => false) });
    const last = failure("still missing");

    await expect(loadChunkWithRetry(failingLoad(last), env)).rejects.toBe(last);
    expect(env.reloadOnce).toHaveBeenCalledOnce();
  });
});

describe("reloadUnlessRecent", () => {
  function dependencies(lastReload: string | null, now = 1_000_000) {
    return {
      now: () => now,
      readLastReload: vi.fn(() => lastReload),
      writeLastReload: vi.fn<(value: string) => void>(),
      reload: vi.fn(),
    };
  }

  it("reloads and records the time when no reload happened before", () => {
    const deps = dependencies(null);
    expect(reloadUnlessRecent(deps)).toBe(true);
    expect(deps.writeLastReload).toHaveBeenCalledWith("1000000");
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it("reloads again once the guard window has passed", () => {
    const deps = dependencies(String(1_000_000 - CHUNK_RELOAD_GUARD_MS));
    expect(reloadUnlessRecent(deps)).toBe(true);
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it("refuses a second reload inside the guard window", () => {
    const deps = dependencies(String(1_000_000 - CHUNK_RELOAD_GUARD_MS + 1));
    expect(reloadUnlessRecent(deps)).toBe(false);
    expect(deps.writeLastReload).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("treats an unreadable marker value as no earlier reload", () => {
    const deps = dependencies("not-a-number");
    expect(reloadUnlessRecent(deps)).toBe(true);
  });

  it.each([
    ["the marker cannot be read", (deps: ReturnType<typeof dependencies>) => deps.readLastReload.mockImplementation(() => { throw new Error("blocked"); })],
    ["the marker cannot be stored", (deps: ReturnType<typeof dependencies>) => deps.writeLastReload.mockImplementation(() => { throw new Error("quota"); })],
  ])("does not reload when %s, because nothing would stop a loop", (_label, arrange) => {
    const deps = dependencies(null);
    arrange(deps);
    expect(reloadUnlessRecent(deps)).toBe(false);
    expect(deps.reload).not.toHaveBeenCalled();
  });
});
