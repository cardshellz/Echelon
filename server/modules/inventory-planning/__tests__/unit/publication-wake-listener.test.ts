import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLICATION_WAKE_CHANNEL, startPublicationWakeListener } from "../../infrastructure/publication-wake-listener";

class FakeClient extends EventEmitter {
  query = vi.fn(async (_sql: string) => ({ rows: [] }));
  release = vi.fn();
}
const RECONNECT_DELAY_MS = 1_000;

describe("publication wake listener", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness(connect?: () => Promise<FakeClient>) {
    const clients: FakeClient[] = [];
    const pool = { connect: vi.fn(connect ?? (async () => { const client = new FakeClient(); clients.push(client); return client; })) };
    const onWake = vi.fn();
    const log = vi.fn();
    const listener = startPublicationWakeListener(pool as never, onWake, { reconnectDelayMs: RECONNECT_DELAY_MS, log });
    return { clients, pool, onWake, log, listener };
  }

  it("listens on the publication channel and wakes once on connect to catch missed work", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.clients[0].query).toHaveBeenCalledWith(`LISTEN ${PUBLICATION_WAKE_CHANNEL}`);
    expect(h.onWake).toHaveBeenCalledTimes(1);
    await h.listener.stop();
  });

  it("wakes for its own channel only", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.clients[0].emit("notification", { channel: PUBLICATION_WAKE_CHANNEL });
    h.clients[0].emit("notification", { channel: "shopify_order_ingested" });
    expect(h.onWake).toHaveBeenCalledTimes(2);
    await h.listener.stop();
  });

  it("discards a lost connection, reconnects after the delay, and wakes again", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.clients[0].emit("error", new Error("terminated"));
    h.clients[0].emit("end");
    expect(h.clients[0].release).toHaveBeenCalledTimes(1);
    expect(h.clients[0].release).toHaveBeenCalledWith(true);
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "disconnected", error_code: "PUBLICATION_WAKE_LISTENER_LOST" }));
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS - 1);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pool.connect).toHaveBeenCalledTimes(2);
    expect(h.onWake).toHaveBeenCalledTimes(2);
    await h.listener.stop();
  });

  it("keeps retrying when the database cannot be reached", async () => {
    let attempts = 0;
    const healthy = new FakeClient();
    const h = harness(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connection refused");
      return healthy;
    });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 2);
    expect(attempts).toBe(3);
    expect(h.onWake).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(expect.objectContaining({ error_code: "PUBLICATION_WAKE_LISTENER_CONNECT_FAILED" }));
    await h.listener.stop();
  });

  it("releases a connection whose LISTEN failed and retries", async () => {
    const broken = new FakeClient();
    broken.query.mockRejectedValueOnce(new Error("permission denied"));
    const healthy = new FakeClient();
    const queue = [broken, healthy];
    const h = harness(async () => queue.shift()!);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(broken.release).toHaveBeenCalledWith(true);
    expect(h.onWake).toHaveBeenCalledTimes(1);
    await h.listener.stop();
  });

  it("stops listening and never reconnects after stop", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    await h.listener.stop();
    expect(h.clients[0].release).toHaveBeenCalledWith(true);
    h.clients[0].emit("notification", { channel: PUBLICATION_WAKE_CHANNEL });
    h.clients[0].emit("end");
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS * 5);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    expect(h.onWake).toHaveBeenCalledTimes(1);
  });

  it("rejects a reconnect delay that is not a positive integer", () => {
    expect(() => startPublicationWakeListener({ connect: vi.fn() } as never, vi.fn(), { reconnectDelayMs: 0 })).toThrow();
  });
});
