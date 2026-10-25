import { it, expect } from "vitest";
import type pg from "pg";
import type { drizzle } from "drizzle-orm/node-postgres";
import type * as schema from "@shared/schema";
import type { NewRecommendationPurchaseOrder } from "../../recommendation-po-handoff.service";
import type { createPurchasingService } from "../../purchasing.service";

interface NumberingFixture {
  pool: pg.Pool;
  database: ReturnType<typeof drizzle<typeof schema>>;
  purchasingOwner: ReturnType<typeof createPurchasingService>;
  actorId: string;
  now: Date;
}

/** Real recommendation repository and purchasing owner share the fixture's SQL
 * transport. No allocator, advisory lock or insert is mocked. */
export function registerRecommendationPoNumberingCases(context: () => NumberingFixture): void {
  const prefix = "PO-20260907-";

  function values(fixture: NumberingFixture): NewRecommendationPurchaseOrder {
    return {
      vendorId: 5, status: "draft", physicalStatus: "draft", financialStatus: "unbilled",
      poType: "standard", priority: "normal", currency: "USD", paymentTermsDays: null,
      paymentTermsType: null, shipFromAddress: null, incoterms: null, subtotalCents: 500,
      totalCents: 500, lineCount: 0, source: "auto_draft", autoDraftDate: "2026-09-07",
      createdBy: fixture.actorId, updatedBy: fixture.actorId, metadata: { numberingFixture: true },
      createdAt: fixture.now, updatedAt: fixture.now,
    };
  }

  async function repository(fixture: NumberingFixture) {
    const { createDrizzleRecommendationPoHandoffRepository } = await import("../../recommendation-po-handoff.repository");
    return createDrizzleRecommendationPoHandoffRepository(fixture.database);
  }

  async function seed(numbers: ReadonlyArray<{ suffix: string; status?: "draft" | "cancelled" }>): Promise<void> {
    const { pool } = context();
    for (const number of numbers) {
      await pool.query("INSERT INTO procurement.purchase_orders(po_number,vendor_id,status) VALUES($1,5,$2)",
        [`${prefix}${number.suffix}`, number.status ?? "draft"]);
    }
  }

  it("recommendation numbering crosses 999 using cancelled numbers and ignores manual reference labels", async () => {
    const fixture = context();
    await seed([{ suffix: "999" }, { suffix: "1000", status: "cancelled" }, { suffix: "9999-reference" }, { suffix: "1e8" }]);
    const prior = (await fixture.pool.query("SELECT id,po_number,status FROM procurement.purchase_orders ORDER BY id")).rows;
    const owner = await repository(fixture);
    const created = await owner.transaction(unit => unit.createPurchaseOrder(values(fixture), fixture.now));
    expect(created.poNumber).toBe(`${prefix}1001`);
    expect((await fixture.pool.query("SELECT id,po_number,status FROM procurement.purchase_orders WHERE id<>$1 ORDER BY id", [created.id])).rows).toEqual(prior);
  });

  it("recommendation numbering preserves every digit above JavaScript's safe integer range", async () => {
    const fixture = context();
    await seed([{ suffix: "9007199254740993" }]);
    const owner = await repository(fixture);
    const created = await owner.transaction(unit => unit.createPurchaseOrder(values(fixture), fixture.now));
    expect(created.poNumber).toBe(`${prefix}9007199254740994`);
    expect((await fixture.pool.query("SELECT po_number FROM procurement.purchase_orders ORDER BY id")).rows.map(row => row.po_number))
      .toEqual([`${prefix}9007199254740993`, `${prefix}9007199254740994`]);
  });

  it("recommendation and manual PO owners allocate distinct numbers in concurrent committed transactions", async () => {
    const fixture = context();
    await seed([{ suffix: "999" }, { suffix: "1000" }]);
    const owner = await repository(fixture);
    const created = await Promise.all([
      ...Array.from({ length: 4 }, () => owner.transaction(unit => unit.createPurchaseOrder(values(fixture), fixture.now))),
      fixture.purchasingOwner.createPurchaseOrderWithLines({ vendorId: 5, warehouseId: 1, lines: [{
        productId: 100, productVariantId: 200, expectedReceiveVariantId: 200, expectedReceiveUnitsPerVariant: 50,
        orderQty: 50, pricingSource: "manual", pricing: { basis: "per_piece", quantityPieces: 50, unitCostMills: 10_000 },
      }] }, fixture.actorId),
    ]);
    expect(created.map(po => po.poNumber).sort()).toEqual([1001, 1002, 1003, 1004, 1005].map(number => `${prefix}${number}`));
    expect(new Set(created.map(po => po.id)).size).toBe(5);
    const stored = (await fixture.pool.query("SELECT po_number,source,total_cents FROM procurement.purchase_orders WHERE id=ANY($1::int[])", [created.map(po => po.id)])).rows;
    expect(stored).toHaveLength(5);
    expect(stored.filter(row => row.source === "auto_draft").map(row => row.total_cents)).toEqual(["500", "500", "500", "500"]);
  });

  it("recommendation numbering rolls back header and audit writes and retries the unused number", async () => {
    const fixture = context();
    const owner = await repository(fixture);
    const failure = new Error("Synthetic failure after recommendation header and audit writes");
    await expect(owner.transaction(async unit => {
      const po = await unit.createPurchaseOrder(values(fixture), fixture.now);
      expect(po.poNumber).toBe(`${prefix}001`);
      await unit.createStatusHistory({ purchaseOrderId: po.id, fromStatus: null, toStatus: "draft",
        changedBy: fixture.actorId, changedAt: fixture.now, notes: "Synthetic rollback evidence" });
      await unit.createPoEvent({ poId: po.id, eventType: "created", actorType: "user", actorId: fixture.actorId,
        payloadJson: { source: "numbering-rollback-test" }, createdAt: fixture.now });
      throw failure;
    })).rejects.toBe(failure);
    for (const table of ["purchase_orders", "po_status_history", "po_events"] as const) {
      expect((await fixture.pool.query(`SELECT count(*)::int AS count FROM procurement.${table}`)).rows[0].count).toBe(0);
    }
    const retried = await owner.transaction(unit => unit.createPurchaseOrder(values(fixture), fixture.now));
    expect(retried.poNumber).toBe(`${prefix}001`);
  });

  it("recommendation numbering refuses exhausted capacity without changing historical identifiers", async () => {
    const fixture = context();
    await seed([{ suffix: "999999999999999999" }]);
    const owner = await repository(fixture);
    const before = (await fixture.pool.query("SELECT to_jsonb(po) AS record FROM procurement.purchase_orders po ORDER BY id")).rows;
    await expect(owner.transaction(unit => unit.createPurchaseOrder(values(fixture), fixture.now)))
      .rejects.toMatchObject({ code: "DOCUMENT_NUMBER_EXHAUSTED", statusCode: 409 });
    expect((await fixture.pool.query("SELECT to_jsonb(po) AS record FROM procurement.purchase_orders po ORDER BY id")).rows).toEqual(before);
  });

  it.each([new Date(Number.NaN), new Date("+010000-01-01T00:00:00.000Z")])("recommendation numbering rejects invalid calendar evidence %s before inserting", async numberDate => {
    const fixture = context();
    const owner = await repository(fixture);
    await expect(owner.transaction(unit => unit.createPurchaseOrder(values(fixture), numberDate))).rejects.toBeInstanceOf(TypeError);
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM procurement.purchase_orders")).rows[0].count).toBe(0);
  });
}
