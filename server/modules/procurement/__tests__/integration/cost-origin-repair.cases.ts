import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type pg from "pg";
import type {
  AmendmentDatabase,
  AmendmentTransaction,
} from "../../po-quantity-amendment.repository";
import {
  createCostOriginRepairService,
  originRepairScope,
} from "../../cost-origin-repair.service";
import {
  createShipmentCostReconciliationService,
  shipmentReconciliationScope,
} from "../../shipment-cost-reconciliation.service";
import {
  costFingerprint,
  recordReceiptCostOrigin,
} from "../../../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { readCostReconciliationReport } from "../../../inventory/infrastructure/cost-reconciliation-report.repository";
import { inventoryCostReportEventSchema } from "@shared/procurement/cost-report-delivery";
import { originRepairContextSchema } from "@shared/procurement/cost-origin-repair";
import { readPurchaseCostApplications } from "../../purchase-cost-application-read.repository";
import { projectPurchaseCostApplications } from "../../purchase-cost-application-read.service";
import { reconcilePurchaseCostEvidence } from "../../purchase-cost-application.service";
import { COGSService } from "../../../inventory/cogs.service";
import { readReceiptCostQueue } from "../../receipt-cost-queue-read.repository";
import { projectReceiptCostQueue } from "../../receipt-cost-queue-read.service";

export function registerOriginRepairCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">;
  at: Date;
  updateCosts: () => Promise<unknown>;
  physicalSnapshot: () => Promise<unknown>;
  costHealth: () => Promise<unknown>;
  shipmentReview: () => Promise<unknown>;
}) {
  const service = () =>
    createCostOriginRepairService(fixture.database(), () => fixture.at);
  const query = (text: string, args: unknown[] = []) => {
    // PostgreSQL's extended protocol disallows multiple statements. Fixture
    // batches interpolate only validated integer literals, never application input.
    if (args.length && text.includes(";"))
      return fixture.pool().query(
        text.replace(/\$(\d+)/g, (_match, n: string) => {
          const value = args[Number(n) - 1];
          if (typeof value !== "number" || !Number.isSafeInteger(value))
            throw new Error("Fixture requires exact integer literals");
          return String(value);
        }),
      );
    return fixture.pool().query(text, args);
  };
  const descriptor = (
    scope: ReturnType<typeof originRepairScope>,
    input: unknown,
    key = randomUUID(),
    actorId = "admin-user",
  ) => ({
    ...scope,
    actorType: "user" as const,
    actorId,
    contractVersion: 1,
    idempotencyKey: key,
    requestHash: costFingerprint(input),
  });
  const cases = [
    {
      name: "ten historical 50-piece cases",
      units: 50,
      old: 10,
      later: 40,
      product: 1250000,
      packaging: 250000,
      freight: 1234,
    },
    {
      name: "five historical 250-piece cases",
      units: 250,
      old: 5,
      later: 20,
      product: 2000000,
      packaging: 125000,
      freight: 2345,
    },
  ];
  async function prepare(values = cases[0]) {
    const base = (values.old + values.later) * values.units;
    const productCents = values.product / 100,
      packagingCents = values.packaging / 100;
    // Recorded July receipt lacks snapshots; the September receipt already owns
    // interval zero. All identifiers and financial amounts are fictional.
    await query(
      `UPDATE procurement.purchase_orders SET status='received' WHERE id=10;
      UPDATE procurement.purchase_order_lines SET order_qty=$1,received_qty=$1,status='received',total_product_cost_cents=$2,
        packaging_cost_cents=$3,line_total_cents=$2+$3,expected_receive_units_per_variant=$4 WHERE id=21`,
      [base, productCents, packagingCents, values.units],
    );
    await query(
      `UPDATE procurement.inbound_shipment_lines SET qty_shipped=$1 WHERE id=11;
      UPDATE procurement.inbound_freight_costs SET actual_cents=$2 WHERE id=31`,
      [values.old * values.units, values.freight],
    );
    await query(
      `UPDATE procurement.vendor_invoices SET status='paid',currency='USD',invoiced_amount_cents=$1,paid_amount_cents=$1,balance_cents=0 WHERE id=71;
      UPDATE procurement.vendor_invoice_lines SET qty_invoiced=$2,line_total_cents=$1,cost_component_evidence=NULL WHERE id=72`,
      [productCents + packagingCents, base],
    );
    await query(
      `INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES(2,'LATER-SHIP','closed');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,product_variant_id,sku,qty_shipped)
        VALUES(12,2,10,21,200,'AUDIT-PRODUCT',$1);
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,purchase_order_id,inbound_shipment_id)
        VALUES(60,'JULY-RECEIPT','shipment','closed',10,1),(61,'SEPTEMBER-RECEIPT','shipment','closed',10,2);
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,sku,product_variant_id,expected_qty,received_qty)
        VALUES(62,60,21,'AUDIT-PRODUCT',200,$2,$2),(63,61,21,'AUDIT-PRODUCT',200,$3,$3);
      UPDATE procurement.receiving_lines SET units_per_variant_snapshot=$4,inbound_shipment_line_id=12,cost_source_kind='purchase_order_line' WHERE id=63;
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,qty_received,qty_on_hand,
        purchase_order_id,po_line_id,inbound_shipment_id,receiving_order_id,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_precision_version,cost_source,received_at)
        VALUES(501,'JULY-DEPLETED',200,99,$2,0,10,21,1,60,$5+$6,$5,$6,0,$5+$6,1,'po','2026-07-01'),
          (502,'SEPTEMBER-STOCK',200,99,$3,$3,10,21,2,61,$5+$6,$5,$6,0,$5+$6,1,'po','2026-09-15')`,
      [
        values.later * values.units,
        values.old,
        values.later,
        values.units,
        values.product / (values.old + values.later),
        values.packaging / (values.old + values.later),
      ],
    );
    await fixture.database().transaction((tx) =>
      recordReceiptCostOrigin(
        tx,
        {
          inventoryLotId: 502,
          receivingLineId: 63,
          purchaseOrderLineId: 21,
          inboundShipmentLineId: 12,
          unitsPerVariantSnapshot: values.units,
          receivedVariantQty: values.later,
        },
        "admin-user",
        fixture.at,
      ),
    );
    await query(
      "UPDATE procurement.inbound_shipments SET status='closed' WHERE id=1",
    );
    await fixture.updateCosts();
    const freight = createShipmentCostReconciliationService(
      fixture.database(),
      () => fixture.at,
    );
    const freightContext = await freight.context(11, "admin-user");
    const freightRequest = {
      sourceVersion: freightContext.sourceVersion,
      destination: "historical_cogs" as const,
      reason: "Confirmed sold historical shipment goods.",
    };
    expect(
      await freight.reconcile(
        11,
        freightRequest,
        "admin-user",
        descriptor(shipmentReconciliationScope(11), freightRequest),
      ),
    ).toMatchObject({ httpStatus: 200 });
    const context = await service().context(501, "admin-user");
    expect(context.blockedReason).toBeNull();
    return {
      sourceVersion: context.sourceVersion,
      unitsPerCase: values.units,
      productMills: values.product,
      packagingMills: values.packaging,
      destination: "historical_cogs" as const,
      reason: "Verified original cases and supplier invoice; goods were sold.",
      evidenceConfirmed: true as const,
    };
  }
  async function financialSnapshot() {
    const tables = [
      "inventory.cost_origin_repairs",
      "inventory.lot_cost_origins",
      "inventory.cost_reconciliation_postings",
      "inventory.cost_reconciliation_approvals",
      "inventory.cost_applications",
      "inventory.cost_reporting_events",
      "inventory.inventory_lots",
      "procurement.receiving_lines",
      "procurement.vendor_invoice_lines",
      "inventory.lot_cost_quantity_allocations",
    ];
    return Promise.all(
      tables.map(
        async (table) =>
          (
            await query(
              `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
      ),
    );
  }
  it.each(cases)(
    "repairs historical origin $name with preview, admin approval, exact postings and unchanged stock",
    async (values) => {
      const request = await prepare(values),
        before = await financialSnapshot(),
        physical = await fixture.physicalSnapshot();
      const preview = await service().preview(501, request, "admin-user");
      expect(await financialSnapshot()).toEqual(before);
      expect(preview.summary).toMatchObject({
        stockQuantityChange: 0,
        basePieces: values.old * values.units,
        components: [
          expect.objectContaining({
            component: "product",
            historicalBeforeMills: 0,
            historicalAfterMills: values.product / 5,
          }),
          expect.objectContaining({
            component: "packaging",
            historicalBeforeMills: 0,
            historicalAfterMills: values.packaging / 5,
          }),
          expect.objectContaining({
            component: "landed",
            historicalBeforeMills: values.freight * 100,
            historicalAfterMills: values.freight * 100,
          }),
        ],
      });
      const input = { ...request, previewVersion: preview.previewVersion },
        command = descriptor(originRepairScope(501), input);
      const result = await service().approve(501, input, "admin-user", command);
      expect(result.httpStatus).toBe(200);
      const saved = originRepairContextSchema.parse(result.body);
      expect(saved.approval).toMatchObject({
        actorName: expect.any(String),
        summary: preview.summary,
        destination: "historical_cogs",
      });
      expect(
        await service().approve(501, input, "admin-user", command),
      ).toMatchObject({ replayed: true, body: result.body });
      expect(await fixture.physicalSnapshot()).toEqual(physical);
      expect(
        (
          await query(
            "SELECT purchase_start_base_piece,shipment_start_base_piece FROM inventory.lot_cost_origins WHERE inventory_lot_id=501",
          )
        ).rows,
      ).toEqual([
        {
          purchase_start_base_piece: String(values.later * values.units),
          shipment_start_base_piece: "0",
        },
      ]);
      const current = await fixture
        .database()
        .transaction((tx) => readPurchaseCostStatus(tx, [21]));
      expect(current.lines[0].components.map((row) => row.status)).toEqual([
        "applied",
        "applied",
      ]);
      expect(current.lines[0].originRepairs).toHaveLength(1);
      const history = await fixture
        .database()
        .transaction(async (tx) =>
          projectPurchaseCostApplications(
            await readPurchaseCostApplications(tx, 10),
            10,
          ),
        );
      const latest = history.revisions.filter(
        (row) => row.latestRecordedSourceRevision,
      );
      expect(latest).toHaveLength(3);
      expect(
        latest.every(
          (row) => row.currentResolution?.destination === "historical_cogs",
        ),
      ).toBe(true);
      expect(
        latest.every((row) =>
          row.applications.some((app) => app.resolvedByCurrentPosting),
        ),
      ).toBe(true);
      expect(
        (await readPoShipmentCosts(fixture.database(), 10))?.supplierCosts,
      ).toEqual(current);
      expect(await fixture.shipmentReview()).toMatchObject({
        supplierCosts: current,
      });
      const events = (
        await query("SELECT payload FROM inventory.cost_reporting_events")
      ).rows;
      for (const row of events)
        expect(
          inventoryCostReportEventSchema.safeParse(row.payload).success,
        ).toBe(true);
      const report = await fixture
        .database()
        .transaction((tx) => readCostReconciliationReport(tx));
      expect(report.balances.historical_cogs).toBe(
        values.freight * 100 + values.product / 5 + values.packaging / 5,
      );
      const health = (await fixture.costHealth()) as {
        items: { type: string; shipmentId: number | null }[];
      };
      expect(
        health.items
          .filter((item) => item.shipmentId === 1)
          .map((item) => item.type),
      ).not.toEqual(expect.arrayContaining(["provisional_other_costs"]));
      // Receipt processing reads the same posted components, not its old failure.
      await query(
        "INSERT INTO procurement.receipt_cost_requests(receiving_order_id,purchase_order_line_id,requested_by,requested_at) VALUES(60,21,'admin-user',$1)",
        [fixture.at],
      );
      const queue = await fixture
        .database()
        .transaction((tx) => readReceiptCostQueue(tx, 10));
      expect(projectReceiptCostQueue(queue, new Map(), current)[0].state).toBe(
        "applied",
      );
      // A later supplier correction follows the approved quantity/destination and
      // posts only the difference. The immutable origin approval remains intact.
      await query(
        "UPDATE procurement.vendor_invoice_lines SET cost_component_evidence=jsonb_set(jsonb_set(cost_component_evidence,'{productMills}',to_jsonb($1::bigint)),'{packagingMills}',to_jsonb($2::bigint)) WHERE id=72",
        [values.product + 1000, values.packaging - 1000],
      );
      await fixture
        .database()
        .transaction((tx) =>
          reconcilePurchaseCostEvidence(
            tx,
            21,
            new COGSService(tx),
            "admin-user",
            fixture.at,
          ),
        );
      const revised = await fixture
        .database()
        .transaction((tx) => readPurchaseCostStatus(tx, [21]));
      expect(revised.lines[0].components.map((row) => row.status)).toEqual([
        "applied",
        "applied",
      ]);
      expect(
        revised.lines[0].components[0].historicalPosting?.amountMills,
      ).toBe(values.product / 5 + 200);
      const revisedReport = await fixture
        .database()
        .transaction((tx) => readCostReconciliationReport(tx));
      expect(revisedReport.balances).toEqual(report.balances);
      for (const sql of [
        "UPDATE inventory.cost_origin_repairs SET reason='changed'",
        "DELETE FROM inventory.cost_origin_repairs",
        "TRUNCATE inventory.cost_origin_repairs",
      ])
        await expect(query(sql)).rejects.toThrow(/immutable/);
    },
  );
  it("posts explicit zero product cost and inventory expense without reclassifying approved freight", async () => {
    const values = { ...cases[0], product: 0 };
    const request = {
      ...(await prepare(values)),
      destination: "inventory_variance" as const,
    };
    const preview = await service().preview(501, request, "admin-user");
    const input = { ...request, previewVersion: preview.previewVersion };
    expect(
      await service().approve(
        501,
        input,
        "admin-user",
        descriptor(originRepairScope(501), input),
      ),
    ).toMatchObject({ httpStatus: 200 });
    const report = await fixture
      .database()
      .transaction((tx) => readCostReconciliationReport(tx));
    expect(report.balances).toEqual({
      historical_cogs: values.freight * 100,
      inventory_variance: values.packaging / 5,
    });
    const current = await fixture
      .database()
      .transaction((tx) => readPurchaseCostStatus(tx, [21]));
    expect(current.lines[0].components.map((row) => row.status)).toEqual([
      "applied",
      "applied",
    ]);
    expect(current.lines[0].components[0].historicalPosting).toEqual({
      destination: "inventory_variance",
      amountMills: 0,
    });
  });
  it("rejects non-admins, stale evidence, invalid quantities and forged previews without changing financial records", async () => {
    const request = await prepare(),
      before = await financialSnapshot();
    for (const actor of ["lead-user", "custom-user", "scoped-user"])
      await expect(
        service().preview(501, request, actor),
      ).rejects.toMatchObject({ code: "COST_ORIGIN_ADMIN" });
    await expect(
      service().preview(501, { ...request, unitsPerCase: 501 }, "admin-user"),
    ).rejects.toMatchObject({ code: "COST_ORIGIN_REPAIR_COVERAGE" });
    await expect(
      service().preview(
        501,
        { ...request, productMills: request.productMills + 1 },
        "admin-user",
      ),
    ).rejects.toMatchObject({ code: "COST_ORIGIN_REPAIR_INVOICE" });
    await expect(
      service().preview(
        501,
        { ...request, sourceVersion: "0".repeat(64) },
        "admin-user",
      ),
    ).rejects.toMatchObject({ code: "COST_ORIGIN_STALE" });
    const input = { ...request, previewVersion: "a".repeat(64) };
    expect(
      await service().approve(
        501,
        input,
        "admin-user",
        descriptor(originRepairScope(501), input),
      ),
    ).toMatchObject({
      httpStatus: 409,
      body: { code: "COST_ORIGIN_PREVIEW_CHANGED" },
    });
    expect(await financialSnapshot()).toEqual(before);
  });
  it("serializes competing approvals and rolls back a failed immutable approval write", async () => {
    const request = await prepare(),
      preview = await service().preview(501, request, "admin-user");
    const input = { ...request, previewVersion: preview.previewVersion },
      before = await financialSnapshot();
    await query(`CREATE FUNCTION inventory.fail_origin_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected origin audit failure'; END $$;
      CREATE TRIGGER fail_origin_test BEFORE INSERT ON inventory.cost_origin_repairs FOR EACH ROW EXECUTE FUNCTION inventory.fail_origin_test()`);
    try {
      await expect(
        service().approve(
          501,
          input,
          "admin-user",
          descriptor(originRepairScope(501), input),
        ),
      ).rejects.toThrow();
    } finally {
      await query(
        "DROP TRIGGER fail_origin_test ON inventory.cost_origin_repairs; DROP FUNCTION inventory.fail_origin_test()",
      );
    }
    expect(await financialSnapshot()).toEqual(before);
    const results = await Promise.all(
      [1, 2].map(() =>
        service().approve(
          501,
          input,
          "admin-user",
          descriptor(originRepairScope(501), input),
        ),
      ),
    );
    expect(results.map((row) => row.httpStatus).sort()).toEqual([200, 409]);
    expect(
      (await query("SELECT * FROM inventory.cost_origin_repairs")).rows,
    ).toHaveLength(1);
  });
  it("requires a new preview after downstream stock changes and rechecks admin access at approval", async () => {
    const request = await prepare(),
      preview = await service().preview(501, request, "admin-user");
    const input = { ...request, previewVersion: preview.previewVersion };
    await query(
      "UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-1 WHERE id=502",
    );
    const afterStockChange = await financialSnapshot();
    expect(
      await service().approve(
        501,
        input,
        "admin-user",
        descriptor(originRepairScope(501), input),
      ),
    ).toMatchObject({ httpStatus: 409, body: { code: "COST_ORIGIN_STALE" } });
    expect(await financialSnapshot()).toEqual(afterStockChange);
    await query(
      "UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand+1 WHERE id=502",
    );
    await query("UPDATE identity.users SET active=0 WHERE id='admin-user'");
    expect(
      await service().approve(
        501,
        input,
        "admin-user",
        descriptor(originRepairScope(501), input),
      ),
    ).toMatchObject({ httpStatus: 403, body: { code: "COST_ORIGIN_ADMIN" } });
    expect(
      (await query("SELECT * FROM inventory.cost_origin_repairs")).rows,
    ).toEqual([]);
  });
  it("cannot bundle another lot's unresolved movement into the receipt approval", async () => {
    const request = await prepare();
    await query(
      "UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-1 WHERE id=502",
    );
    request.sourceVersion = (
      await service().context(501, "admin-user")
    ).sourceVersion;
    const before = await financialSnapshot();
    await expect(
      service().preview(501, request, "admin-user"),
    ).rejects.toMatchObject({ code: "COST_ORIGIN_APPLICATION_REVIEW" });
    expect(await financialSnapshot()).toEqual(before);
  });
}
