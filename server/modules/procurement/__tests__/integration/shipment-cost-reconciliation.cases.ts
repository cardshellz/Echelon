import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { it, expect } from "vitest";
import type { AmendmentDatabase, AmendmentTransaction } from "../../po-quantity-amendment.repository";
import {
  createShipmentCostReconciliationService,
  shipmentReconciliationScope,
} from "../../shipment-cost-reconciliation.service";
import { costFingerprint, recordReceiptCostOrigin } from "../../../inventory/infrastructure/cost-evidence.repository";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { inventoryCostReportEventSchema } from "@shared/procurement/cost-report-delivery";
import { reconciliationPreview, type ReconciliationRequest } from "@shared/procurement/cost-reconciliation";
import { readUnallocatedLotCosts } from "../../../inventory/infrastructure/cost-quantity.repository";

/** Runs inside the real receiving/AP/freight fixture with synthetic records. */
export function registerShipmentReconciliationCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">;
  at: Date;
  prepareGaps: () => Promise<void>;
  updateCosts: () => Promise<unknown>;
  physicalSnapshot: () => Promise<unknown>;
}) {
  const service = () => createShipmentCostReconciliationService(fixture.database(), () => fixture.at);
  const context = () => service().context(11, "admin-user");
  const query = (text: string, params: unknown[] = []) => fixture.pool().query(text, params);
  const post = (request: ReconciliationRequest, key = randomUUID(), actor = "admin-user") =>
    service().reconcile(11, request, actor, {
      ...shipmentReconciliationScope(11),
      actorType: "user",
      actorId: actor,
      contractVersion: 1,
      idempotencyKey: key,
      requestHash: costFingerprint(request),
    });
  async function prepare(missing = false) {
    if (missing) {
      await query(`INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status) VALUES(60,'SYNTHETIC-OLD-RECEIPT','shipment','closed');
        INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,sku,product_variant_id,expected_qty,received_qty)
          VALUES(61,60,21,'AUDIT-PRODUCT',200,2,2);
        INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
          po_line_id,inbound_shipment_id,receiving_order_id,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_precision_version,cost_source,received_at)
          VALUES(501,'SYNTHETIC-DEPLETED',200,99,2,0,21,1,60,500000,500000,0,0,500000,1,'po','2026-01-01');`);
    } else await fixture.prepareGaps();
    await query("UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1");
    await fixture.updateCosts();
    const before = await context();
    expect(before).toMatchObject({ canApprove: true, blockedReason: null, state: { status: "unresolved" } });
    return {
      before,
      request: {
        sourceVersion: before.sourceVersion,
        destination: "inventory_variance" as const,
        reason: "Historical stock records reviewed; destination cannot be attributed to individual sales.",
      },
    };
  }
  const postings = async () => (await query("SELECT * FROM inventory.cost_reconciliation_postings ORDER BY id")).rows;

  it.each([false, true])(
    "posts actual balanced costs, preserves stock, and replays approval (missing receipt links: %s)",
    async (missing) => {
      const { before, request } = await prepare(missing),
        physical = await fixture.physicalSnapshot(),
        key = randomUUID();
      const preview = reconciliationPreview(before, request.destination);
      expect(preview.before.unassignedMills).toBeGreaterThan(0);
      expect(preview.after.unassignedMills).toBe(0);
      const saved = await post(request, key);
      expect(saved).toMatchObject({
        httpStatus: 200,
        replayed: false,
        body: { state: { status: "posted", unassignedMills: 0, postedMills: before.historicalAmountMills } },
      });
      expect(await post(request, key)).toMatchObject({ replayed: true, body: saved.body });
      expect(await fixture.physicalSnapshot()).toEqual(physical);
      const rows = await postings();
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0].delta_mills) + BigInt(rows[0].unassigned_delta_mills)).toBe(BigInt(0));
      expect(Number(rows[0].after_mills)).toBe(before.historicalAmountMills);
      const approved = (await query("SELECT evidence FROM inventory.cost_reconciliation_approvals")).rows[0].evidence;
      expect(approved.preview).toEqual(preview);
      expect(approved).toMatchObject({ inventoryQuantityDelta: 0, approval: { userId: "admin-user", active: true } });
      expect(
        (await readPoShipmentCosts(fixture.database(), 10))?.lines[0].exceptionReview?.reconciliation?.status,
      ).toBe("posted");
      const event = inventoryCostReportEventSchema.parse(
        (await query("SELECT payload FROM inventory.cost_reporting_events ORDER BY id DESC LIMIT 1")).rows[0].payload,
      );
      expect(event.historicalCostAdjustments).toEqual([
        expect.objectContaining({ destination: "inventory_variance", deltaMills: before.historicalAmountMills }),
      ]);
      await fixture.updateCosts();
      expect(await postings()).toEqual(rows);
      await expect(query("UPDATE inventory.cost_reconciliation_postings SET after_mills=0")).rejects.toThrow(
        /immutable/,
      );
      await expect(query("DELETE FROM inventory.cost_reconciliation_approvals")).rejects.toThrow(/immutable/);
      await expect(query("TRUNCATE inventory.cost_reconciliation_postings")).rejects.toThrow(/immutable/);
      expect((await service().report()).balances.inventory_variance).toBe(before.historicalAmountMills);
      if (!missing) {
        const remaining = await fixture.database().transaction(async (tx) =>
          readUnallocatedLotCosts(
            tx,
            (await tx.execute(sql`SELECT * FROM inventory.inventory_lots ORDER BY id`)).rows.map((row) => ({
              ...row,
              id: row.id,
            })),
          ),
        );
        const stock = [...remaining.values()].reduce((sum, lot) => sum + lot.costs.landedMills, BigInt(0));
        const sold = BigInt(
          (await query("SELECT sum(landed_total_cost_mills)::text AS amount FROM oms.order_item_costs")).rows[0].amount,
        );
        expect(stock + sold + BigInt(before.historicalAmountMills)).toBe(BigInt(before.sourceAmountMills));
      }
    },
  );

  it.each([false, true])(
    "revalues approved costs up, down and to zero without another expense or stock movement (%s)",
    async (missing) => {
      const { request } = await prepare(missing);
      await post(request);
      const physical = await fixture.physicalSnapshot();
      for (const cents of [140000, 10000, 0]) {
        await query("UPDATE procurement.inbound_freight_costs SET actual_cents=$1 WHERE id=31", [cents]);
        await fixture.updateCosts();
        const updated = await context();
        expect(updated.state).toMatchObject({
          status: "posted",
          unassignedMills: 0,
          postedMills: updated.historicalAmountMills,
        });
        const rows = await postings();
        expect(rows.reduce((sum, row) => sum + BigInt(row.delta_mills), BigInt(0))).toBe(
          BigInt(updated.historicalAmountMills),
        );
        await fixture.updateCosts();
        expect(await postings()).toEqual(rows);
        expect(await fixture.physicalSnapshot()).toEqual(physical);
      }
    },
  );

  it("reclassifies with an equal reversal, without dropping the first approval", async () => {
    const { request, before } = await prepare();
    await post(request);
    const updated = await context();
    const result = await post({
      ...request,
      sourceVersion: updated.sourceVersion,
      destination: "historical_cogs",
      reason: "Additional supplier and sales records prove that the historical goods were sold.",
    });
    expect(result).toMatchObject({
      httpStatus: 200,
      body: { state: { status: "posted", destination: "historical_cogs", postedMills: before.historicalAmountMills } },
    });
    const rows = await postings();
    expect(rows).toHaveLength(3);
    expect(
      rows
        .filter((row) => row.destination === "inventory_variance")
        .reduce((sum, row) => sum + BigInt(row.delta_mills), BigInt(0)),
    ).toBe(BigInt(0));
    expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals")).rows).toHaveLength(2);
  });

  it.each([false, true])(
    "restores recorded receipt and sold costs without duplicate expense (partial history: %s)",
    async (partial) => {
      const { request, before } = await prepare(true);
      await post(request);
      const unitsPerVariant = partial ? 25 : 50;
      await query(`UPDATE procurement.receiving_lines SET inbound_shipment_line_id=11,units_per_variant_snapshot=${unitsPerVariant},cost_source_kind='purchase_order_line' WHERE id=61;
      INSERT INTO oms.order_item_costs(order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_cents,total_cost_cents,unit_cost_mills,total_cost_mills,cost_precision_version)
        VALUES(1,1,501,200,2,5000,10000,500000,1000000,1)`);
      await fixture.database().transaction(async (tx) => {
        await recordReceiptCostOrigin(
          tx,
          {
            inventoryLotId: 501,
            receivingLineId: 61,
            purchaseOrderLineId: 21,
            inboundShipmentLineId: 11,
            unitsPerVariantSnapshot: unitsPerVariant,
            receivedVariantQty: 2,
          },
          "admin-user",
          fixture.at,
        );
      });
      const physical = await fixture.physicalSnapshot();
      if (partial) {
        expect(await fixture.updateCosts()).toMatchObject({
          httpStatus: 409,
          body: { code: "COST_RECONCILIATION_PARTIAL_HISTORY" },
        });
        expect(await postings()).toHaveLength(1);
        expect(
          (await query("SELECT landed_total_cost_mills FROM oms.order_item_costs")).rows[0].landed_total_cost_mills,
        ).toBeNull();
        expect(await fixture.physicalSnapshot()).toEqual(physical);
        return;
      }
      await fixture.updateCosts();
      const rows = await postings();
      expect(rows).toHaveLength(2);
      expect(Number(rows[1].delta_mills)).toBe(-before.historicalAmountMills);
      expect(rows[1].after_mills).toBe("0");
      expect(
        Number((await query("SELECT sum(landed_total_cost_mills) AS amount FROM oms.order_item_costs")).rows[0].amount),
      ).toBe(before.sourceAmountMills);
      expect(await fixture.physicalSnapshot()).toEqual(physical);
      await fixture.updateCosts();
      expect(await postings()).toEqual(rows);
    },
  );

  it.each(["lead-user", "custom-user", "scoped-user", "missing-user"])("denies %s without posting", async (actor) => {
    const { request } = await prepare();
    expect(await post(request, randomUUID(), actor)).toMatchObject({ httpStatus: 403 });
    expect(await postings()).toEqual([]);
  });
  it.each(["membership", "permission", "active"])("rechecks revoked %s on approval", async (field) => {
    const { request } = await prepare();
    if (field === "membership") await query("DELETE FROM identity.auth_user_roles WHERE user_id='admin-user'");
    if (field === "permission") await query("DELETE FROM identity.auth_role_permissions WHERE role_id=1");
    if (field === "active") await query("UPDATE identity.users SET active=0 WHERE id='admin-user'");
    expect(await post(request)).toMatchObject({ httpStatus: 403 });
    expect(await postings()).toEqual([]);
  });
  it("rejects a changed source and serializes competing approvals", async () => {
    const { request } = await prepare();
    await query("UPDATE procurement.inbound_freight_costs SET actual_cents=7000 WHERE id=31");
    expect(await post(request)).toMatchObject({ httpStatus: 409 });
    await fixture.updateCosts();
    const current = { ...request, sourceVersion: (await context()).sourceVersion };
    expect((await Promise.all([post(current), post(current)])).map((result) => result.httpStatus).sort()).toEqual([
      200, 409,
    ]);
    expect(await postings()).toHaveLength(1);
  });
  it("rolls back approval and posting together if report persistence fails, then retries safely", async () => {
    const { request } = await prepare(),
      key = randomUUID(),
      physical = await fixture.physicalSnapshot();
    await query(`CREATE FUNCTION inventory.fail_reconciliation_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic report failure'; END $$;
      CREATE TRIGGER fail_reconciliation_report BEFORE INSERT ON inventory.cost_reporting_events FOR EACH ROW EXECUTE FUNCTION inventory.fail_reconciliation_report()`);
    try {
      await expect(post(request, key)).rejects.toThrow();
    } finally {
      await query(
        "DROP TRIGGER fail_reconciliation_report ON inventory.cost_reporting_events; DROP FUNCTION inventory.fail_reconciliation_report()",
      );
    }
    expect(await postings()).toEqual([]);
    expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals")).rows).toEqual([]);
    expect(await fixture.physicalSnapshot()).toEqual(physical);
    await query(
      "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp()))+0.01) FROM public.financial_command_results WHERE idempotency_key=$1",
      [key],
    );
    expect(await post(request, key)).toMatchObject({ httpStatus: 200 });
  });
  it("refuses a missing-history adjustment for stock still present", async () => {
    const { request } = await prepare(true);
    await query("UPDATE inventory.inventory_lots SET qty_on_hand=1 WHERE id=501");
    expect((await context()).blockedReason).toContain("stock or existing costs");
    expect(await post(request)).toMatchObject({ httpStatus: 409 });
    expect(await postings()).toEqual([]);
  });
  it("refuses legacy sold-cost records instead of booking their expense again", async () => {
    const { request } = await prepare(true);
    await query(`INSERT INTO inventory.order_line_costs(order_id,order_item_id,product_variant_id,lot_id,qty_consumed,unit_cost_cents,total_cost_cents)
      VALUES(1,1,200,501,2,10,20)`);
    expect((await context()).blockedReason).toContain("Older order cost records");
    expect(await post(request)).toMatchObject({ httpStatus: 409 });
    expect(await postings()).toEqual([]);
  });
  it("reopens the financial review immediately when previously absent cost evidence appears", async () => {
    const { request } = await prepare(true);
    await post(request);
    await query(`INSERT INTO inventory.order_line_costs(order_id,order_item_id,product_variant_id,lot_id,qty_consumed,unit_cost_cents,total_cost_cents)
      VALUES(1,1,200,501,2,10,20)`);
    expect((await context()).state.status).toBe("review_required");
    expect((await readPoShipmentCosts(fixture.database(), 10))?.lines[0].exceptionReview?.reconciliation?.status).toBe(
      "review_required",
    );
    await fixture.updateCosts();
    const rows = await postings();
    expect(rows).toHaveLength(2);
    expect(rows[1].after_mills).toBe("0");
  });
  it("reopens changed historical attribution with an explicit reversal rather than reusing the old approval", async () => {
    const { request, before } = await prepare(true);
    await post(request);
    await query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
      po_line_id,inbound_shipment_id,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_precision_version,cost_source,received_at)
      VALUES(502,'SYNTHETIC-NEW-EVIDENCE',200,99,1,0,21,1,500000,500000,0,0,500000,1,'po','2026-01-01')`);
    await fixture.updateCosts();
    const rows = await postings();
    expect(rows).toHaveLength(2);
    expect(Number(rows[1].delta_mills)).toBe(-before.historicalAmountMills);
    expect((await context()).state).toMatchObject({
      status: "unresolved",
      unassignedMills: before.historicalAmountMills,
    });
  });
}
