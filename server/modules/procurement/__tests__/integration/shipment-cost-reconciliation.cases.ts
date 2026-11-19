import type { LandedCostHealth } from "@shared/procurement/landed-cost-health";
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
import { readPurchaseCostApplications } from "../../purchase-cost-application-read.repository";
import { projectPurchaseCostApplications } from "../../purchase-cost-application-read.service";
import type { Transaction } from "../../purchase-workspace-read";
import { readShipmentCostReview } from "../../shipment-cost-review.repository";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import { readPoShipmentCosts } from "../../po-shipment-cost-summary.repository";
import { inventoryCostReportEventSchema } from "@shared/procurement/cost-report-delivery";
import { reconciliationPreview, reconciliationResultSchema, type ReconciliationRequest } from "@shared/procurement/cost-reconciliation";
import { readUnallocatedLotCosts } from "../../../inventory/infrastructure/cost-quantity.repository";
import { prepareShipmentCostRevisions, recordShipmentCostRevisions } from "../../shipment-cost-application.service";
import { recordCostRevision } from "../../cost-source-revision.repository";
import { readReconciliationLedger, readReconciliationRecords, visitShipmentReconciliationEvidence,
  type ShipmentReconciliationReadRequest } from "../../../inventory/infrastructure/cost-reconciliation.repository";
import { readShipmentExceptionFacts } from "../../shipment-cost-exception.repository";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";

/** Runs inside the real receiving/AP/freight fixture with synthetic records. */
export function registerShipmentReconciliationCases(fixture: {
  pool: () => pg.Pool;
  database: () => AmendmentDatabase & Pick<AmendmentTransaction, "execute">;
  at: Date;
  prepareGaps: () => Promise<void>;
  updateCosts: () => Promise<unknown>;
  physicalSnapshot: () => Promise<unknown>;
  costHealth: () => Promise<LandedCostHealth>;
}) {
  const service = () => createShipmentCostReconciliationService(fixture.database(), () => fixture.at);
  const context = () => service().context(11, "admin-user");
  const history = () => fixture.database().transaction(async (tx) =>
    projectPurchaseCostApplications(await readPurchaseCostApplications(tx as Transaction, 10), 10),
    { isolationLevel: "repeatable read", accessMode: "read only" });
  const shipmentLinePosted = async () => {
    const review = await readShipmentCostReview(fixture.database(), 1);
    const line = review?.lines.find((line) => line.lineId === 11);
    expect(line).toBeDefined();
    return isShipmentCostLinePosted(line!);
  };
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

  async function readRequest(): Promise<ShipmentReconciliationReadRequest> {
    return fixture.database().transaction(async tx => {
      const [facts] = await readShipmentExceptionFacts(tx, [11]);
      const source = costSourceRevisionSchema.parse(facts.contract);
      const review = await context();
      return { source, issues: review.issues };
    });
  }
  async function compareReconciliationReads(tx: AmendmentTransaction, requests: ShipmentReconciliationReadRequest[]) {
    const expected = new Map<number, unknown>();
    for (const request of requests) {
      if (request.source.scope.kind !== "shipment_line") throw new Error("Expected shipment fixture scope");
      const id = request.source.scope.inboundShipmentLineId;
      expected.set(id, { ledger: await readReconciliationLedger(tx, id),
        records: await readReconciliationRecords(tx, request.source, request.issues) });
    }
    const actual = new Map<number, unknown>();
    await visitShipmentReconciliationEvidence(tx, requests, (id, value) => { actual.set(id, value); });
    expect(actual).toEqual(expected);
    return actual;
  }

  it("keeps batched exception evidence identical through real approval and destination replacement", async () => {
    const { request: initial } = await prepare(true);
    const inputs = [await readRequest()];
    await fixture.database().transaction(tx => compareReconciliationReads(tx, inputs),
      { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(await post(initial)).toMatchObject({ httpStatus: 200, body: { state: { status: "posted", destination: "inventory_variance" } } });
    await fixture.database().transaction(tx => compareReconciliationReads(tx, inputs),
      { isolationLevel: "repeatable read", accessMode: "read only" });
    const current = await context();
    expect(await post({ ...initial, sourceVersion: current.sourceVersion, destination: "historical_cogs" }))
      .toMatchObject({ httpStatus: 200, body: { state: { status: "posted", destination: "historical_cogs" } } });
    await fixture.database().transaction(tx => compareReconciliationReads(tx, inputs),
      { isolationLevel: "repeatable read", accessMode: "read only" });
    const review = await readShipmentCostReview(fixture.database(), 1);
    expect(review?.lines[0].exceptionReview?.reconciliation).toMatchObject({ status: "posted", destination: "historical_cogs" });
    await query("UPDATE procurement.inbound_freight_costs SET actual_cents=actual_cents+1 WHERE id=31");
    const stale = await readShipmentCostReview(fixture.database(), 1);
    expect(stale?.lines[0].exceptionReview?.reconciliation?.status).toBe("review_required");
    expect(await shipmentLinePosted()).toBe(false);
  });

  it("retains two complete 1000-record scopes and fails a single 1001-record scope without truncation", async () => {
    await prepare(true);
    const first = await readRequest(), second = structuredClone(first);
    if (second.source.scope.kind !== "shipment_line") throw new Error("Expected shipment fixture scope");
    second.source.scope.inboundShipmentId = 2; second.source.scope.inboundShipmentLineId = 12;
    await query(`INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES(2,'SECOND-RECONCILIATION-SCOPE','closed');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,
        product_variant_id,sku,qty_shipped) VALUES(12,2,10,21,200,'AUDIT-PRODUCT',100);
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,po_line_id,inbound_shipment_id,
        qty_received,qty_on_hand,received_at)
      SELECT 10000+n,'FIRST-RECONCILIATION-'||n,200,99,21,1,1,0,'2026-01-01' FROM generate_series(1,999) n;
      INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,po_line_id,inbound_shipment_id,
        qty_received,qty_on_hand,received_at)
      SELECT 20000+n,'SECOND-RECONCILIATION-'||n,200,99,21,2,1,0,'2026-01-01' FROM generate_series(1,1000) n`);
    await fixture.database().transaction(async tx => {
      const evidence = await compareReconciliationReads(tx, [first, second]);
      expect([...evidence.values()].map(value => (value as { records: unknown[] }).records.length)).toEqual([1000, 1000]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await query(`INSERT INTO inventory.inventory_lots(id,lot_number,product_variant_id,warehouse_location_id,po_line_id,inbound_shipment_id,
      qty_received,qty_on_hand,received_at) VALUES(30000,'RECONCILIATION-OVER-LIMIT',200,99,21,1,1,0,'2026-01-01')`);
    await expect(fixture.database().transaction(tx => readReconciliationRecords(tx, first.source, first.issues),
      { isolationLevel: "repeatable read", accessMode: "read only" })).rejects.toMatchObject({ code: "COST_RECONCILIATION_LIMIT" });
    await expect(fixture.database().transaction(tx => visitShipmentReconciliationEvidence(tx, [second, first], () => undefined),
      { isolationLevel: "repeatable read", accessMode: "read only" })).rejects.toMatchObject({ code: "COST_RECONCILIATION_LIMIT" });
  });

  it("retains one read snapshot across a committed approval and sees it on the next read", async () => {
    const { request: approvalRequest } = await prepare(true);
    const request = await readRequest();
    let prior: Awaited<ReturnType<typeof readReconciliationLedger>>;
    await fixture.database().transaction(async tx => {
      prior = await readReconciliationLedger(tx, 11);
      expect(prior.approval).toBeNull();
      expect(await post(approvalRequest)).toMatchObject({ httpStatus: 200, body: { state: { status: "posted" } } });
      await visitShipmentReconciliationEvidence(tx, [request], (_id, value) => { expect(value.ledger).toEqual(prior); });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await fixture.database().transaction(async tx => {
      const values = await compareReconciliationReads(tx, [request]);
      expect(values.get(11)).toMatchObject({ ledger: { approval: { destination: "inventory_variance" },
        balances: { historical_cogs: 0, inventory_variance: 500000 } } });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  });

  it.each([false, true])("keeps pre-link-field approvals posted across every reader and retry (missing origin: %s)", async missing => {
    const amount = missing ? 5000 : 335007;
    await query(`INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,inbound_shipment_id,status,invoiced_amount_cents,balance_cents)
      VALUES(73,'SYNTHETIC-FREIGHT-INVOICE',5,1,'approved',$1,$1)`, [amount]);
    await query(`INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,freight_cost_id,qty_invoiced,unit_cost_cents,line_total_cents)
      VALUES(74,73,1,31,1,$1,$1)`, [amount]);
    await query("UPDATE procurement.inbound_freight_costs SET vendor_id=5,vendor_invoice_id=73 WHERE id=31");
    await prepare(missing);
    // Reproduce the immutable source format that existed before the reader
    // selected the two nullable product-link columns. Do not modify old rows.
    const legacyRevision = await fixture.database().transaction(async tx => {
      const { proposals } = await prepareShipmentCostRevisions(tx, 1);
      const proposal = structuredClone(proposals[0]);
      const evidence = proposal.sourceEvidence as { invoices: Array<Record<string, unknown>> };
      for (const invoice of evidence.invoices) {
        delete invoice.purchase_order_line_id;
        delete invoice.product_variant_id;
      }
      proposal.input.sources = proposal.input.sources.map(source => source.kind === "vendor_invoice_line"
        ? { ...source, version: costFingerprint(evidence.invoices.find(row => row.id === source.lineId && row.vendor_invoice_id === source.documentId)) }
        : source);
      return recordCostRevision(tx, proposal.input, "admin-user", fixture.at, proposal.sourceEvidence);
    });
    await fixture.updateCosts();
    const review = await context();
    const request = { sourceVersion: review.sourceVersion, destination: "historical_cogs" as const,
      reason: "Supplier evidence and historical sold goods checked by administrator." };
    expect(await post(request)).toMatchObject({ httpStatus: 200, body: { state: { status: "posted" } } });
    await query("UPDATE procurement.purchase_orders SET status='closed' WHERE id=10");
    const physical = await fixture.physicalSnapshot(), approvedPostings = await postings();
    const approvals = (await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows;
    const revisions = (await query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows;
    const currentContext = await context();
    expect(currentContext).toMatchObject({ blockedReason: null, state: { status: "posted", unassignedMills: 0 } });
    expect(await shipmentLinePosted()).toBe(true);
    expect((await readPoShipmentCosts(fixture.database(), 10))?.summary).toMatchObject({ reviewLines: 0, inventoryCosting: "applied" });
    expect((await fixture.costHealth()).items.filter(item => item.shipmentId === 1).every(item =>
      item.action !== "push_costs_to_lots" && !["posting_review_required", "finalized_not_pushed", "stale_provisional_lots"].includes(item.type))).toBe(true);
    expect((await history()).revisions.find(revision => revision.id === legacyRevision.id)?.currentResolution)
      .toMatchObject({ destination: "historical_cogs", postings: [expect.objectContaining({ reason: request.reason })] });
    // Reads and repeated owner commands preserve the revision, approval and
    // money. No second approval or compensating posting clears this regression.
    expect(await fixture.database().transaction(tx => recordShipmentCostRevisions(tx, 1, "admin-user", fixture.at)))
      .toMatchObject({ revisions: [{ id: legacyRevision.id }] });
    await fixture.updateCosts();
    await fixture.updateCosts();
    expect(await postings()).toEqual(approvedPostings);
    expect((await query("SELECT * FROM inventory.cost_reconciliation_approvals ORDER BY id")).rows).toEqual(approvals);
    expect((await query("SELECT * FROM procurement.cost_source_revisions ORDER BY id")).rows).toEqual(revisions);
    expect(await fixture.physicalSnapshot()).toEqual(physical);
    expect((await query("SELECT status FROM procurement.purchase_orders WHERE id=10")).rows[0].status).toBe("closed");

    // An actual product link is not equivalent to an absent/null link. Every
    // consumer must still surface the conflicting billing ownership.
    await query("UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=21 WHERE id=74");
    expect((await readPoShipmentCosts(fixture.database(), 10))?.summary.reviewLines).toBe(1);
    expect(await shipmentLinePosted()).toBe(false);
    expect((await context()).state.status).toBe("review_required");
    expect((await history()).revisions.every(revision => revision.currentResolution == null)).toBe(true);
    expect((await fixture.costHealth()).items.some(item => item.shipmentId === 1 && item.action === "review_cost_evidence")).toBe(true);
    expect(await postings()).toEqual(approvedPostings);
  });

  it.each([false, true])(
    "posts actual balanced costs, preserves stock, and replays approval (missing receipt links: %s)",
    async (missing) => {
      const { before, request } = await prepare(missing),
        physical = await fixture.physicalSnapshot(),
        key = randomUUID();
      const unresolvedHealth = await fixture.costHealth();
      expect(unresolvedHealth.items.some((item) => item.shipmentId === 1 && item.action === "review_cost_evidence")).toBe(true);
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
      const savedResult = reconciliationResultSchema.parse(saved.body);
      const currentHistory = await history();
      const currentRevision = currentHistory.revisions.find((revision) => revision.shipmentLineId === 11 && revision.latestRecordedSourceRevision)!;
      expect(currentRevision.currentResolution).toMatchObject({ sourceRevisionId: currentRevision.id,
        applicationId: savedResult.applicationId, destination: request.destination, postedMills: before.historicalAmountMills,
        postings: [expect.objectContaining({ actorName: expect.any(String), reason: request.reason })] });
      expect(currentRevision.applications.every((application) => application.status === "review_required")).toBe(true);
      expect(currentRevision.applications.find((application) => application.id === savedResult.applicationId)?.reportingEvent?.evidenceState).toBe("verified_record");
      expect(currentRevision.applications.flatMap((application) => application.issues).some((issue) => issue.code === "COST_REPORTING_EVENT_UNVERIFIED")).toBe(false);
      expect(await shipmentLinePosted()).toBe(true);
      const postedHealth = await fixture.costHealth();
      expect(postedHealth.items.filter((item) => item.shipmentId === 1).every((item) =>
        !["stale_provisional_lots", "finalized_not_pushed", "posting_review_required"].includes(item.type) && item.action !== "push_costs_to_lots")).toBe(true);
      const rows = await postings();
      expect(rows).toHaveLength(1);
      expect(BigInt(rows[0].delta_mills) + BigInt(rows[0].unassigned_delta_mills)).toBe(BigInt(0));
      expect(Number(rows[0].after_mills)).toBe(before.historicalAmountMills);
      const approved = (await query("SELECT evidence FROM inventory.cost_reconciliation_approvals")).rows[0].evidence;
      expect(approved.preview).toEqual(preview);
      expect(approved).toMatchObject({ inventoryQuantityDelta: 0, approval: { userId: "admin-user", active: true } });
      const poCosts = await readPoShipmentCosts(fixture.database(), 10);
      expect(poCosts?.lines[0]).toMatchObject({ status: "applied", exceptionReview: { reconciliation: { status: "posted" } } });
      expect(poCosts?.summary.reviewLines).toBe(poCosts?.lines.filter(line => line.status === "review_required").length);
      expect(poCosts?.summary.appliedLines).toBe(poCosts?.lines.filter(line => line.status === "applied").length);
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
        // The modal and PO must agree immediately, before the next cost update.
        expect((await context()).state.status).toBe("review_required");
        expect(await shipmentLinePosted()).toBe(false);
        expect((await fixture.costHealth()).items.some((item) => item.shipmentId === 1
          && ["review_cost_evidence", "review_allocation"].includes(item.action))).toBe(true);
        expect((await history()).revisions.every((revision) => revision.currentResolution == null)).toBe(true);
        const stalePo = await readPoShipmentCosts(fixture.database(), 10);
        expect(stalePo?.lines[0]).toMatchObject({ status: "review_required", exceptionReview: { reconciliation: { status: "review_required" } } });
        await fixture.updateCosts();
        const updated = await context();
        expect(updated.state).toMatchObject({
          status: "posted",
          unassignedMills: 0,
          postedMills: updated.historicalAmountMills,
        });
        expect(await shipmentLinePosted()).toBe(true);
        const revisedHistory = await history();
        const resolved = revisedHistory.revisions.filter((revision) => revision.currentResolution != null);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({ latestRecordedSourceRevision: true, currentResolution: { postedMills: updated.historicalAmountMills } });
        expect(revisedHistory.revisions.filter((revision) => !revision.latestRecordedSourceRevision).every((revision) => revision.currentResolution == null)).toBe(true);
        const currentPo = await readPoShipmentCosts(fixture.database(), 10);
        expect(currentPo?.lines[0].status, JSON.stringify({ cents, line: currentPo?.lines[0], summary: currentPo?.summary })).toBe("applied");
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
