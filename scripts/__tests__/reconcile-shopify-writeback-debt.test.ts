import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  parseFlags,
  runReconciliation,
  type Flags,
} from "../reconcile-shopify-writeback-debt";
import type { ShopifyFulfillmentSnapshot } from "../../server/modules/oms/shopify-fulfillment-snapshot";

function flags(overrides: Partial<Flags> = {}): Flags {
  return {
    help: false,
    mode: "dry-run",
    limit: 100,
    confirmCount: null,
    operator: null,
    reason: null,
    json: true,
    ...overrides,
  };
}

function candidate() {
  return {
    id: 5001,
    external_order_id: "1200001",
    external_order_number: "#60001",
    channel_id: 36,
    provider: "shopify" as const,
    dead_retry_count: 2,
    first_failed_at: new Date("2026-07-20T12:00:00.000Z"),
  };
}

function snapshot(complete = true): ShopifyFulfillmentSnapshot {
  return {
    sourceOrderId: "1200001",
    observedAt: new Date("2026-07-27T12:00:00.000Z"),
    complete,
    packages: complete ? [{
      sourceFulfillmentId: "7001",
      trackingNumbers: ["TRACK101"],
      items: [{
        sourceFulfillmentLineId: "8001",
        channelOrderLineId: "9001",
        quantity: 2,
      }],
    }] : [],
    incompleteReasons: complete ? [] : ["shopify_fulfillment_snapshot_truncated_or_count_missing"],
  };
}

function resolution(overrides: Record<string, unknown> = {}) {
  return {
    omsOrderId: 5001,
    candidateShipmentCount: 1,
    resolvedShipmentIds: [101],
    resolvedRetryIds: [201, 202],
    resolvedSourceInboxIds: [301],
    unresolved: [],
    retryRowsResolved: 2,
    inboxRowsResolved: 1,
    reviewMarkersCleared: 1,
    eventRecorded: true,
    ...overrides,
  };
}

describe("reconcile-shopify-writeback-debt operator script", () => {
  it("loads database configuration only after the help gate", () => {
    const source = readFileSync(
      resolve(__dirname, "../reconcile-shopify-writeback-debt.ts"),
      "utf8",
    );
    expect(source).not.toContain('import { db, pool } from "../server/db"');
    expect(source.indexOf('if (flags.help)')).toBeLessThan(
      source.indexOf('await import("../server/db")'),
    );
    expect(source).toContain("pathToFileURL(process.argv[1]).href");
  });

  it("defaults to dry-run and requires attributed exact-count execution", () => {
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 100,
      confirmCount: null,
    });
    expect(() => parseFlags(["--execute"])).toThrow(/--confirm-count/);
    expect(() => parseFlags([
      "--execute",
      "--confirm-count=1",
      "--operator=owner@example.com",
    ])).toThrow(/--reason/);
    expect(parseFlags([
      "--execute",
      "--limit=50",
      "--confirm-count=1",
      "--operator=owner@example.com",
      "--reason=verified-provider-package-reconciliation",
    ])).toMatchObject({
      mode: "execute",
      limit: 50,
      confirmCount: 1,
      operator: "owner@example.com",
    });
  });

  it("reads provider evidence in dry-run but never calls the mutating resolver", async () => {
    const fetchSnapshot = vi.fn(async () => snapshot());
    const evaluateOrder = vi.fn(async () => resolution({
      retryRowsResolved: 0,
      inboxRowsResolved: 0,
      reviewMarkersCleared: 0,
      eventRecorded: false,
    }));
    const resolveOrder = vi.fn();

    const result = await runReconciliation(flags(), {
      loadCandidates: vi.fn(async () => [candidate()]),
      fetchSnapshot,
      evaluateOrder,
      resolveOrder,
    });

    expect(result).toMatchObject({
      mode: "dry-run",
      candidates: 1,
      providerSnapshotsComplete: 1,
      unresolvedShipments: 0,
      retryRowsResolved: 0,
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(evaluateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5001 }),
      expect.objectContaining({ complete: true }),
    );
    expect(resolveOrder).not.toHaveBeenCalled();
  });

  it("reads Shopify before resolving and enforces the confirmed candidate count", async () => {
    const loadCandidates = vi.fn(async () => [candidate()]);
    const fetchSnapshot = vi.fn(async () => snapshot());
    const resolveOrder = vi.fn(async () => resolution());

    await expect(runReconciliation(flags({
      mode: "execute",
      confirmCount: 2,
      operator: "owner@example.com",
      reason: "verified-reconciliation",
    }), {
      loadCandidates,
      fetchSnapshot,
      evaluateOrder: vi.fn(),
      resolveOrder,
    })).rejects.toThrow(/does not match selected candidate count 1/);

    const result = await runReconciliation(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@example.com",
      reason: "verified-reconciliation",
    }), {
      loadCandidates,
      fetchSnapshot,
      evaluateOrder: vi.fn(),
      resolveOrder,
    });

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(resolveOrder).toHaveBeenCalledTimes(1);
    expect(fetchSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      resolveOrder.mock.invocationCallOrder[0],
    );
    expect(resolveOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5001 }),
      expect.stringContaining("verified-reconciliation"),
      expect.objectContaining({ complete: true }),
    );
    expect(result).toMatchObject({
      providerSnapshotsComplete: 1,
      ordersResolved: 1,
      retryRowsResolved: 2,
      inboxRowsResolved: 1,
      reviewMarkersCleared: 1,
      failed: 0,
    });
  });

  it("fails closed on an incomplete provider snapshot", async () => {
    const evaluateOrder = vi.fn();
    const resolveOrder = vi.fn();
    const result = await runReconciliation(flags(), {
      loadCandidates: vi.fn(async () => [candidate()]),
      fetchSnapshot: vi.fn(async () => snapshot(false)),
      evaluateOrder,
      resolveOrder,
    });

    expect(result).toMatchObject({
      candidates: 1,
      providerSnapshotsComplete: 0,
      unresolvedShipments: 1,
      failed: 0,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        code: "SHOPIFY_FULFILLMENT_SNAPSHOT_INCOMPLETE",
      }),
    ]);
    expect(evaluateOrder).not.toHaveBeenCalled();
    expect(resolveOrder).not.toHaveBeenCalled();
  });
});
