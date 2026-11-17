import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_LOAD_ONLINE_ATTEMPTS,
  CHUNK_RETRY_BASE_DELAY_MS,
  loadChunkWithRetry,
  type ChunkLoadEnvironment,
} from "@/lib/chunk-loading";

function environment(overrides: Partial<ChunkLoadEnvironment> = {}): ChunkLoadEnvironment & {
  delay: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  waitForOnline: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    isOnline: () => true,
    waitForOnline: vi.fn<() => Promise<void>>(async () => undefined),
    delay: vi.fn<(ms: number) => Promise<void>>(async () => undefined),
    ...overrides,
  } as ReturnType<typeof environment>;
}

const failure = (message: string) => new TypeError(message);

describe("loadChunkWithRetry", () => {
  it("returns the chunk on the first attempt without waiting", async () => {
    const env = environment();
    const load = vi.fn(async () => "chunk");

    await expect(loadChunkWithRetry(load, env)).resolves.toBe("chunk");
    expect(load).toHaveBeenCalledOnce();
    expect(env.delay).not.toHaveBeenCalled();
    expect(env.waitForOnline).not.toHaveBeenCalled();
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
    const env = environment({
      isOnline: () => online,
      waitForOnline: vi.fn(async () => undefined),
    });
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
  });

  it("retries an online failure with a growing delay and then succeeds", async () => {
    const env = environment();
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure("first"))
      .mockRejectedValueOnce(failure("second"))
      .mockResolvedValueOnce("chunk");

    await expect(loadChunkWithRetry(load, env)).resolves.toBe("chunk");
    expect(env.delay.mock.calls).toEqual([[CHUNK_RETRY_BASE_DELAY_MS], [CHUNK_RETRY_BASE_DELAY_MS * 2]]);
  });

  it("reports the last error once the online attempts are used up, so a missing chunk is not retried forever", async () => {
    const env = environment();
    const last = failure("still missing");
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure("missing"))
      .mockRejectedValueOnce(failure("missing"))
      .mockRejectedValueOnce(last);

    await expect(loadChunkWithRetry(load, env)).rejects.toBe(last);
    expect(load).toHaveBeenCalledTimes(CHUNK_LOAD_ONLINE_ATTEMPTS);
    expect(env.delay).toHaveBeenCalledTimes(CHUNK_LOAD_ONLINE_ATTEMPTS - 1);
  });
});
