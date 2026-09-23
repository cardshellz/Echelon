import { createServer, request } from "node:http";
import express from "express";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdvisoryLockRunner } from "../../../infrastructure/scheduler-lock";
import type { ChannelFulfillmentAuthorityService } from "../../../modules/oms/channel-fulfillment-authority.service";
import { resetChannelFulfillmentCommandWorkerForTest, runChannelFulfillmentCommandWorkerOnce,
  runChannelLabelLifecycleWorkerOnce } from "../../../modules/oms/channel-fulfillment-command.worker";
import { startShipStationLabelReconciliationScheduler } from "../../../modules/oms/shipstation-label-reconciliation.scheduler";
import { observeRuntimeRequests, startRuntimeMemoryTelemetry } from "../runtime-memory";

let stop: () => void = () => undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stop(); resetChannelFulfillmentCommandWorkerForTest(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("enabled diagnostics preserve runtime contracts", () => {
  it("observes acquired advisory-lock work, not skipped work, and still releases after failure", async () => {
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: { NODE_ENV: "production" }, emit });
    let acquired = true;
    const query = vi.fn(async (sql: string) => ({ rows: [{ acquired: sql.includes("pg_try_advisory_lock") && acquired }] }));
    const release = vi.fn();
    // This adapter implements the two string-query operations exercised below,
    // not pg's unrelated streaming/callback overloads.
    const client = { query, release } as unknown as Pick<PoolClient, "query" | "release">;
    const runner = createAdvisoryLockRunner({ connect: async () => client }, { log: vi.fn(), error: vi.fn() });
    const result = { private: "not logged" };
    expect(await runner(8484, async () => result)).toBe(result);
    acquired = false;
    const skipped = vi.fn(async () => result);
    expect(await runner(8484, skipped)).toBeNull();
    expect(skipped).not.toHaveBeenCalled();
    acquired = true;
    const original = new Error("private provider error");
    await expect(runner(8484, async () => { throw original; })).rejects.toBe(original);
    expect(release).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_unlock"))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ name: "scheduler.lock_8484", started: 2, completed: 1, failed: 1, active: 0 });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });

  it("keeps fulfillment and label correction independent and preserves service binding and results", async () => {
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: { NODE_ENV: "production" }, emit });
    let finish!: () => void;
    const batch = { claimed: 0, succeeded: 0, ignored: 0, retryScheduled: 0, reviewRequired: 0, deadLettered: 0 };
    const service: ChannelFulfillmentAuthorityService = {
      recordPhysicalPackage: vi.fn(), ensureLegacyShipment: vi.fn(),
      materializeAndActivatePackageAllocationCommercialFulfillment: vi.fn(), projectPhysicalPackage: vi.fn(),
      runDueBatch: vi.fn(async function (this: ChannelFulfillmentAuthorityService, input) {
        expect(this).toBe(service);
        expect(input).toEqual({ limit: 7 });
        return batch;
      }),
      runLabelLifecycleBatch: vi.fn(function (this: ChannelFulfillmentAuthorityService) {
        expect(this).toBe(service);
        return new Promise<void>(resolve => { finish = resolve; });
      }),
    };
    const correction = runChannelLabelLifecycleWorkerOnce(service);
    await runChannelLabelLifecycleWorkerOnce(service);
    expect(service.runLabelLifecycleBatch).toHaveBeenCalledTimes(1);
    expect(await runChannelFulfillmentCommandWorkerOnce(service, 7)).toBe(batch);
    finish(); await correction;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emit.mock.calls).toEqual(expect.arrayContaining([
      ["runtime.work_memory", expect.objectContaining({ name: "shipping.label_lifecycle", started: 1, completed: 1 })],
      ["runtime.work_memory", expect.objectContaining({ name: "shipping.channel_commands", completed: 1, overlappingStarts: 1 })],
    ]));
  });

  it("preserves void-recovery timing, single flight, and stop even when telemetry fails", async () => {
    const emit = vi.fn(() => { throw new Error("telemetry unavailable"); });
    stop = startRuntimeMemoryTelemetry({ environment: { NODE_ENV: "production" }, emit });
    let finish!: () => void;
    const runOnce = vi.fn(() => new Promise<{ outcome: "idle"; voids: number; orders: number }>(resolve => {
      finish = () => resolve({ outcome: "idle", voids: 0, orders: 0 });
    }));
    const log = { info: vi.fn(), error: vi.fn() };
    const scheduler = startShipStationLabelReconciliationScheduler({ runOnce }, log);
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(runOnce).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runOnce).toHaveBeenCalledTimes(1);
      finish(); await vi.advanceTimersByTimeAsync(0);
      expect(log.error).not.toHaveBeenCalled();
    } finally { scheduler.stop(); }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("observes real HTTP lifecycle without changing the request body, response, or error status", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const emit = vi.fn();
    stop = startRuntimeMemoryTelemetry({ environment: { NODE_ENV: "production" }, emit });
    const app = express();
    app.use(observeRuntimeRequests);
    app.use(express.json());
    app.post("/api/echo", (req, res) => res.json(req.body));
    app.get("/api/failure", (_req, res) => res.status(503).json({ error: "synthetic failure" }));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const call = (path: string, body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path,
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" } }, res => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { response += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: response }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(body);
    });
    try {
      const payload = JSON.stringify({ customer: "private-customer", token: "private-token" });
      expect(await call("/api/echo?secret=private-query", payload)).toEqual({ status: 200, body: payload });
      expect((await call("/api/failure")).status).toBe(503);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(emit.mock.calls).toEqual(expect.arrayContaining([
        ["runtime.work_memory", expect.objectContaining({ name: "http.api_write", completed: 1, active: 0 })],
        ["runtime.work_memory", expect.objectContaining({ name: "http.api_read", failed: 1, active: 0 })],
      ]));
      expect(JSON.stringify(emit.mock.calls)).not.toContain("private-");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
