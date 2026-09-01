import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PgHistoricalShipStationContentsCorrectionRepository,
} from "../../historical-shipstation-contents-correction.repository";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function poolWithQuery(
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): Pool {
  return {
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  } as unknown as Pool;
}

function request() {
  return {
    exceptionId: "91",
    reviewPreviewEvidenceHash: HASH_A,
    orderNumber: "1001",
    trackingNumber: "1Z-CORRECTION",
    providerLines: [{ sku: "SKU-A", quantity: 1 }],
  } as const;
}

function reviewDetails() {
  return {
    contract: "historical_shipstation_contents_review_v1",
    decision: "provider_confirmed_pending_inventory_correction",
    inventoryCorrectionRequired: true,
    decisionPreviewEvidenceHash: HASH_A,
    decisionHash: HASH_B,
    providerEvidence: { evidenceHash: HASH_B },
    wmsEvidence: {
      kind: "available",
      lines: [{ wmsShipmentItemId: 701, sku: "SKU-A", quantity: 2 }],
    },
  };
}

describe("PgHistoricalShipStationContentsCorrectionRepository", () => {
  it("loads confirmed WMS, active ship-ledger, and catalog evidence without writes", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("BEGIN")) return { rows: [] };
      if (sql === "COMMIT") return { rows: [] };
      if (sql.includes("FROM wms.reconciliation_exceptions")) {
        return { rows: [{ id: "91", details: reviewDetails() }] };
      }
      if (sql.includes("FROM wms.outbound_shipment_items")) {
        return { rows: [{
          id: 701,
          shipment_id: 801,
          order_item_id: 901,
          product_variant_id: 101,
          qty: 2,
          from_location_id: 301,
          variant_sku: "SKU-A",
          variant_name: "Regular A",
        }] };
      }
      if (sql.includes("FROM inventory.inventory_transactions")) {
        return { rows: [{
          id: 401,
          shipment_id: 801,
          shipment_item_id: 701,
          order_item_id: 901,
          product_variant_id: 101,
          from_location_id: 301,
          variant_qty_delta: -2,
        }] };
      }
      if (sql.includes("FROM catalog.product_variants")) {
        return { rows: [{
          id: 101,
          sku: "SKU-A",
          name: "Regular A",
          is_active: true,
          requires_shipping: true,
          track_inventory: true,
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PgHistoricalShipStationContentsCorrectionRepository(
      poolWithQuery(query),
    );

    await expect(repository.loadFacts(request())).resolves.toMatchObject({
      exceptionId: "91",
      wmsLines: [{
        wmsShipmentItemId: 701,
        inventoryShipTransactions: [{
          inventoryTransactionId: 401,
          evidenceKind: "exact_shipment_item",
          quantity: 2,
        }],
      }],
      catalogVariants: [{ productVariantId: 101, sku: "SKU-A" }],
    });
    expect(statements.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(statements[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("does not load operational evidence without the exact provider-confirmed decision", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("BEGIN")) return { rows: [] };
      if (sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM wms.reconciliation_exceptions")) {
        return { rows: [{
          id: "91",
          details: { ...reviewDetails(), decision: "cannot_prove" },
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PgHistoricalShipStationContentsCorrectionRepository(
      poolWithQuery(query),
    );

    await expect(repository.loadFacts(request())).rejects.toMatchObject({
      code: "CORRECTION_NOT_AUTHORIZED",
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects stale WMS quantities instead of planning from changed evidence", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM wms.reconciliation_exceptions")) {
        return { rows: [{ id: "91", details: reviewDetails() }] };
      }
      if (sql.includes("FROM wms.outbound_shipment_items")) {
        return { rows: [{
          id: 701,
          shipment_id: 801,
          order_item_id: 901,
          product_variant_id: 101,
          qty: 3,
          from_location_id: 301,
          variant_sku: "SKU-A",
          variant_name: "Regular A",
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PgHistoricalShipStationContentsCorrectionRepository(
      poolWithQuery(query),
    );

    await expect(repository.loadFacts(request())).rejects.toMatchObject({
      code: "INVALID_DATABASE_EVIDENCE",
    });
  });
});
