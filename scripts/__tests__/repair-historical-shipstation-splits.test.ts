import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchShipStationShipmentById,
  parseFlags,
} from "../repair-historical-shipstation-splits";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "scripts/repair-historical-shipstation-splits.ts"),
  "utf8",
);

describe("repair-historical-shipstation-splits CLI", () => {
  beforeEach(() => {
    process.env.SHIPSTATION_API_KEY = "test-key";
    process.env.SHIPSTATION_API_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.SHIPSTATION_API_KEY;
    delete process.env.SHIPSTATION_API_SECRET;
    vi.restoreAllMocks();
  });

  it("routes repaired labels through carrier tracking instead of direct fulfillment materialization", () => {
    expect(source).toContain("observeShipStationLabel");
    expect(source).toContain("reconcileShipStationLabel");
    expect(source).toContain("proveProviderPackageLinks");
    expect(source).toContain("hydrateShipStationTrackingIdentity");
    expect(source).not.toContain("materializePhysicalPackage");
    expect(source).not.toContain("projectPhysicalShipment");
  });
  it("defaults to a bounded dry-run", () => {
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 25,
      providerShipmentId: null,
      afterProviderShipmentId: null,
      concurrency: 2,
      delayMs: 250,
      requestTimeoutMs: 20_000,
      maxRetries: 3,
      progressEvery: 10,
      json: false,
    });
  });

  it("parses a full execute authorization envelope", () => {
    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--confirm-count=268",
      "--operator=owner@cardshellz.com",
      "--reason=historical split repair",
      "--idempotency-key=historical-split-repair-2026-07-30",
      "--concurrency=4",
      "--delay-ms=500",
      "--request-timeout-ms=15000",
      "--max-retries=2",
      "--retry-base-delay-ms=1000",
      "--max-rate-limit-errors=8",
      "--progress-every=5",
      "--json",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      confirmCount: 268,
      operator: "owner@cardshellz.com",
      reason: "historical split repair",
      idempotencyKey: "historical-split-repair-2026-07-30",
      afterProviderShipmentId: null,
      concurrency: 4,
      delayMs: 500,
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      retryBaseDelayMs: 1_000,
      maxRateLimitErrors: 8,
      progressEvery: 5,
      json: true,
    });
  });

  it("rejects a resume cursor in execute mode", () => {
    expect(() => parseFlags([
      "--execute",
      "--confirm-count=1",
      "--after-provider-shipment-id=440000000",
    ])).toThrow("--after-provider-shipment-id is dry-run only");
  });

  it("requires an exact confirmation count for execute", () => {
    expect(() => parseFlags(["--execute"])).toThrow(
      "--confirm-count is required with --execute",
    );
  });

  it("rejects conflicting exact and resume provider filters", () => {
    expect(() => parseFlags([
      "--provider-shipment-id=440000001",
      "--after-provider-shipment-id=440000000",
    ])).toThrow("cannot be combined");
  });

  it.each([
    ["--unknown", "Unknown flag"],
    ["--limit=0", "--limit must be"],
    ["--provider-shipment-id=-1", "--provider-shipment-id must be"],
    ["--after-provider-shipment-id=0", "--after-provider-shipment-id must be"],
    ["--concurrency=5", "--concurrency must be"],
    ["--delay-ms=-1", "--delay-ms must be"],
    ["--request-timeout-ms=0", "--request-timeout-ms must be"],
    ["--max-retries=-1", "--max-retries must be"],
    ["--progress-every=-1", "--progress-every must be"],
  ])("rejects invalid flag %s", (flag, message) => {
    expect(() => parseFlags([flag])).toThrow(message);
  });

  it("aborts a provider lookup at the configured timeout", async () => {
    const fetchImpl = vi.fn((_url: URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
    );
    await expect(fetchShipStationShipmentById(
      442730042,
      {
        requestTimeoutMs: 5,
        maxRetries: 0,
        retryBaseDelayMs: 0,
        maxRateLimitErrors: 20,
      },
      { rateLimitResponses: 0, stoppedEarlyReason: null },
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toMatchObject({ code: "SHIPSTATION_REQUEST_TIMEOUT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient provider errors and returns the exact shipment", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        shipments: [{ shipmentId: 442730042 }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await fetchShipStationShipmentById(
      442730042,
      {
        requestTimeoutMs: 1_000,
        maxRetries: 1,
        retryBaseDelayMs: 0,
        maxRateLimitErrors: 20,
      },
      { rateLimitResponses: 0, stoppedEarlyReason: null },
      {
        fetchImpl: fetchImpl as typeof fetch,
        sleep: vi.fn(async () => undefined),
      },
    );
    expect(result?.shipmentId).toBe(442730042);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("opens the circuit at the configured rate-limit threshold", async () => {
    const circuit = { rateLimitResponses: 0, stoppedEarlyReason: null as string | null };
    const fetchImpl = vi.fn(async () => new Response("slow down", {
      status: 429,
      headers: { "retry-after": "0" },
    }));
    await expect(fetchShipStationShipmentById(
      442730042,
      {
        requestTimeoutMs: 1_000,
        maxRetries: 3,
        retryBaseDelayMs: 0,
        maxRateLimitErrors: 1,
      },
      circuit,
      { fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toMatchObject({ code: "SHIPSTATION_RATE_LIMIT_CIRCUIT_OPEN" });
    expect(circuit).toMatchObject({ rateLimitResponses: 1 });
    expect(circuit.stoppedEarlyReason).toContain("breaker opened");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

});
