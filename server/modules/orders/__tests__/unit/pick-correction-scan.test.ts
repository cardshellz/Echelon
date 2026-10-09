import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { completeCorrectivePickSchema, type PickCorrection } from "@shared/pick-corrections";
import { PickCorrectionService } from "../../pick-correction.service";

// 2026-10-09, #63936/#63938: the corrective-pick card refused a scan of the
// product's real barcode. It compared only against the order line's copied
// barcode (blank) and the exact SKU text, and offered no manual mark-picked.

function fixture() {
  const correction: PickCorrection = { id: 169, orderId: 70, orderItemId: 71, orderNumber: "#63938",
    sku: "SHLZ-TOP-180PT-BLU-P10", name: "Toploaders", barcode: null, location: "A-06", declaredQuantity: 1,
    pickedQuantity: 0, revision: 5, state: "picking_required", answer: "no", assignedPickerId: "picker-2",
    reviewReason: null, updatedAt: new Date("2026-10-09T15:00:00Z") };
  const tx = {
    execute: async (statement: any) => {
      const { sql: text } = new PgDialect().sqlToQuery(statement);
      if (text.includes('AS "orderNumber"')) return { rows: [{ ...correction }] };
      if (text.includes("FROM wms.orders")) return { rows: [{ warehouse_status: "ready", on_hold: 0 }] };
      if (text.includes("catalog_barcode")) {
        return { rows: [{ sku: "SHLZ-TOP-180PT-BLU-P10", barcode: null, catalog_barcode: "850041227105", catalog_sku: "SHLZ-TOP-180PT-BLU-P10" }] };
      }
      if (text.includes("FROM wms.pick_correction_events")) return { rows: [] };
      return { rows: [{ id: 1 }] };
    },
  };
  const db = { ...tx, transaction: async <T>(work: (executor: typeof tx) => Promise<T>) => work(tx) };
  const pick = vi.fn(async () => undefined);
  return { service: new PickCorrectionService(db as any, pick, () => new Date("2026-10-09T16:00:00Z")), pick };
}

const command = (overrides: Record<string, unknown>) => ({
  commandId: "6a1d2c3b-4e5f-4a7b-8c9d-0e1f2a3b4c5d", expectedRevision: 5, pickedQuantity: 1, ...overrides,
});

describe("recording a corrective pick", () => {
  it.each([" 850041227105 ", "shlz-top-180pt-blu-p10"])("accepts the catalog barcode or SKU however it is scanned: %j", async (code) => {
    const { service, pick } = fixture();
    await service.complete(169, command({ barcode: code }), "picker-2");
    expect(pick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetQuantity: 1, method: "scan" }));
  });

  it("refuses a code that belongs to another item", async () => {
    const { service, pick } = fixture();
    await expect(service.complete(169, command({ barcode: "999999999999" }), "picker-2"))
      .rejects.toMatchObject({ code: "WRONG_ITEM" });
    expect(pick).not.toHaveBeenCalled();
  });

  it("records a manual mark-picked without a scan, as the normal pick screen does", async () => {
    const { service, pick } = fixture();
    await service.complete(169, command({ method: "manual" }), "picker-2");
    expect(pick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetQuantity: 1, method: "manual" }));
  });

  it("still requires the scanned code for a scan", () => {
    expect(completeCorrectivePickSchema.safeParse(command({ method: "scan" })).success).toBe(false);
    expect(completeCorrectivePickSchema.safeParse(command({ barcode: "850041227105" })).success).toBe(true);
  });
});
