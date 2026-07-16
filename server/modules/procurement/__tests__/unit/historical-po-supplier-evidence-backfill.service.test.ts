import { describe, expect, it, vi } from "vitest";

import {
  applyHistoricalPoSupplierEvidence,
  previewHistoricalPoSupplierEvidence,
} from "../../historical-po-supplier-evidence-backfill.service";

const evidenceRow = {
  vendor_id: 2,
  vendor_name: "Supplier",
  product_id: 36,
  product_name: "Sleeves",
  product_variant_id: 73,
  sku: "SLV-C10000",
  purchase_order_id: 115,
  po_number: "PO-115",
  completed_at: "2026-07-08T14:11:25.932",
  received_qty: 300_000,
  last_cost_mills: 60,
  last_cost_cents: 1,
  line_ids: [167],
  vendor_product_id: null,
  current_last_purchased_at: null,
  current_last_cost_mills: null,
  current_last_cost_cents: null,
  lines_to_link: [167],
  conflicting_line_ids: [],
};

describe("historical PO supplier evidence backfill", () => {
  it("previews exact mills without manufacturing quote or preference data", async () => {
    const queryable = {
      query: vi.fn(async (sql: string) =>
        sql.includes("nonpositive_cost_lines_excluded")
          ? {
            rows: [{ vendor_id: 2, nonpositive_cost_lines_excluded: 0 }],
            rowCount: 1,
          }
          : { rows: [evidenceRow], rowCount: 1 }
      ),
    };
    const preview = await previewHistoricalPoSupplierEvidence(queryable as any);

    expect(preview.summary).toEqual({
      targetCount: 1,
      mappingsToCreate: 1,
      mappingsToUpdate: 0,
      mappingsUnchanged: 0,
      linesToLink: 1,
      conflictingLines: 0,
      nonpositiveCostLinesExcluded: 0,
    });
    expect(preview.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "COALESCE(pol.unit_cost_mills, pol.unit_cost_cents * 100) > 0",
      ),
    );
    expect(preview.targets[0]).toMatchObject({
      action: "create_mapping",
      sourceCompletedAt: "2026-07-08T14:11:25.932000",
      lastCostMills: 60,
      lastCostCents: 1,
      productVariantId: 73,
      linesToLink: [167],
    });
  });

  it("atomically creates a legacy mapping, links the PO line, and audits the source", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("SELECT id FROM public.users")) {
          return { rows: [{ id: "user-1" }], rowCount: 1 };
        }
        if (sql.includes("WITH raw_lines AS")) {
          return { rows: [evidenceRow], rowCount: 1 };
        }
        if (sql.includes("nonpositive_cost_lines_excluded")) {
          return {
            rows: [{ vendor_id: 2, nonpositive_cost_lines_excluded: 0 }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO procurement.vendor_products")) {
          return {
            rows: [{
              id: 501,
              vendor_id: 2,
              product_id: 36,
              product_variant_id: 73,
              pricing_basis: "legacy_unknown",
              quoted_at: null,
              is_preferred: 0,
              last_cost_mills: 60,
              last_cost_cents: 1,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("UPDATE procurement.purchase_order_lines")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: null };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const preview = await previewHistoricalPoSupplierEvidence({
      query: vi.fn(async (sql: string) =>
        sql.includes("nonpositive_cost_lines_excluded")
          ? {
            rows: [{ vendor_id: 2, nonpositive_cost_lines_excluded: 0 }],
            rowCount: 1,
          }
          : { rows: [evidenceRow], rowCount: 1 }
      ),
    } as any);

    const result = await applyHistoricalPoSupplierEvidence({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: preview.previewHash,
    });

    expect(result).toMatchObject({
      createdMappings: 1,
      updatedMappings: 0,
      linkedLines: 1,
      conflictingLinesSkipped: 0,
      nonpositiveCostLinesExcluded: 0,
      unchangedTargets: 0,
    });
    const insert = calls.find((call) =>
      call.sql.includes("INSERT INTO procurement.vendor_products")
    );
    expect(insert?.sql).toContain("'legacy_unknown'");
    expect(insert?.sql).toContain("NULL, NULL, NULL");
    expect(insert?.sql).toContain("0, 1");
    expect(insert?.values).toEqual([
      2,
      36,
      73,
      1,
      60,
      "2026-07-08T14:11:25.932000",
    ]);
    const audit = calls.find((call) => call.sql.includes("INSERT INTO public.audit_events"));
    expect(audit?.values?.[1]).toBe("vendor_catalog.historical_purchase_mapping_created");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects apply when evidence changed after preview", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM public.users")) {
          return { rows: [{ id: "user-1" }], rowCount: 1 };
        }
        if (sql.includes("WITH raw_lines AS")) {
          return {
            rows: [{ ...evidenceRow, last_cost_mills: 61 }],
            rowCount: 1,
          };
        }
        if (sql.includes("nonpositive_cost_lines_excluded")) {
          return {
            rows: [{ vendor_id: 2, nonpositive_cost_lines_excluded: 0 }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: null };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const preview = await previewHistoricalPoSupplierEvidence({
      query: vi.fn(async (sql: string) =>
        sql.includes("nonpositive_cost_lines_excluded")
          ? {
            rows: [{ vendor_id: 2, nonpositive_cost_lines_excluded: 0 }],
            rowCount: 1,
          }
          : { rows: [evidenceRow], rowCount: 1 }
      ),
    } as any);

    await expect(applyHistoricalPoSupplierEvidence({
      pool: pool as any,
      actorId: "user-1",
      expectedPreviewHash: preview.previewHash,
    })).rejects.toThrow("changed after preview");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
