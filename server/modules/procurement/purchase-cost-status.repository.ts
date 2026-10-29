import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  purchaseCostStatusSchema,
  type PurchaseCostStatus,
} from "@shared/procurement/purchase-cost-status";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  costFingerprint,
  costInteger,
  CostEvidenceError,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseCostSources } from "./purchase-cost-source.repository";
import { purchaseCostReviewFacts, resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import { projectPurchaseComponentStatus } from "./domain/purchase-cost-status";
import { costIssueSchema, costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import { originRepairApprovalSchema } from "@shared/procurement/cost-origin-repair";
import { planCostReconciliation } from "../inventory/application/plan-cost-reconciliation";
import { readNoInventoryEffectEvidence } from "../inventory/infrastructure/no-inventory-effect.repository";

const MAX_LINES = 500;
const MAX_LOTS = 10_000;
const idSchema = z.number().int().positive().safe();
function bounded<T>(rows: T[], limit: number, kind: string): T[] {
  if (rows.length > limit)
    throw new CostEvidenceError(
      "COST_REVIEW_LIMIT",
      `The complete ${kind} exceeds this review's supported scope.`,
    );
  return rows;
}

/** Keep the exact same boundary on direct reads and snapshot-reader hits. A
 * duplicate ID does not enlarge the review scope; a string is never an ID. */
export function normalizePurchaseCostStatusLineIds(purchaseOrderLineIds: readonly number[]): number[] {
  const values = z.array(idSchema).parse(purchaseOrderLineIds);
  const ids = [...new Set(values)].sort((a, b) => a - b);
  bounded(ids, MAX_LINES, "purchase line set");
  return ids;
}

/** Shared current supplier-cost read for receipt processing, shipment review and
 * health. Callers own a read-only repeatable-read transaction. No flag is cleared. */
export async function readPurchaseCostStatus(
  tx: CostEvidenceTransaction,
  purchaseOrderLineIds: readonly number[],
): Promise<PurchaseCostStatus> {
  const ids = normalizePurchaseCostStatusLineIds(purchaseOrderLineIds);
  if (!ids.length) return { lines: [] };
  const lines = (
    await tx.execute(sql`SELECT line.id,line.purchase_order_id,line.sku,po.po_number FROM procurement.purchase_order_lines line
    JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
    WHERE line.id=ANY(${sql.param(ids)}::int[]) AND line.line_type='product' ORDER BY line.id`)
  ).rows;
  if (lines.length !== ids.length)
    throw new CostEvidenceError(
      "COST_SOURCE_MISSING",
      "Some purchase cost sources could not be read completely.",
    );
  const sources = await readPurchaseCostSources(tx, ids);
  const resolvedSources = new Map([...sources].map(([id, source]) => [id, resolvePurchaseCostSource(source)]));
  const noInventoryEffects = await readNoInventoryEffectEvidence(tx, [...resolvedSources]
    .filter(([, inputs]) => inputs.some(input => input.inventoryEffect)).map(([id]) => id));
  const revisions = (
    await tx.execute(sql`SELECT revision.id,revision.purchase_order_line_id,revision.component,revision.contract,
    application.id AS application_id,application.status,application.evidence,application.recorded_at,
    COALESCE(NULLIF(btrim(actor.display_name),''),actor.username,application.recorded_by) AS actor_name,
    event.payload AS reporting_payload
    FROM procurement.cost_source_revisions revision
    LEFT JOIN LATERAL (SELECT id,status,evidence,recorded_by,recorded_at FROM inventory.cost_applications WHERE source_revision_id=revision.id ORDER BY id DESC LIMIT 1) application ON true
    LEFT JOIN identity.users actor ON actor.id=application.recorded_by
    LEFT JOIN inventory.cost_reporting_events event ON event.application_id=application.id
    WHERE revision.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) AND revision.component IN ('product','packaging')
      AND NOT EXISTS(SELECT 1 FROM procurement.cost_source_revisions newer WHERE newer.purchase_order_line_id=revision.purchase_order_line_id
        AND newer.component=revision.component AND newer.inbound_shipment_line_id IS NULL AND newer.revision>revision.revision)
      AND revision.inbound_shipment_line_id IS NULL ORDER BY revision.purchase_order_line_id,revision.component`)
  ).rows;
  const lots = bounded(
    (
      await tx.execute(sql`WITH RECURSIVE descendants(line_id,id) AS (
      SELECT purchase_order_line_id,inventory_lot_id FROM inventory.lot_cost_origins WHERE purchase_order_line_id=ANY(${sql.param(ids)}::int[])
      UNION SELECT d.line_id,edge.output_lot_id FROM inventory.lot_cost_contributions edge JOIN descendants d ON edge.source_lot_id=d.id
    ), scoped AS (SELECT line_id,id FROM descendants UNION SELECT po_line_id,id FROM inventory.inventory_lots WHERE po_line_id=ANY(${sql.param(ids)}::int[]))
    SELECT scoped.line_id,lot.id,lot.lot_number,lot.qty_on_hand,lot.inbound_shipment_id,lot.cost_provisional,
      lot.po_unit_cost_mills,lot.packaging_cost_mills,lot.product_total_cost_mills,lot.packaging_total_cost_mills,
      EXISTS(SELECT 1 FROM inventory.lot_cost_origins origin WHERE origin.inventory_lot_id=lot.id) AS receipt_origin,
      EXISTS(SELECT 1 FROM inventory.lot_cost_contributions edge WHERE edge.output_lot_id=lot.id) AS transformed,
      EXISTS(SELECT 1 FROM descendants d WHERE d.line_id=scoped.line_id AND d.id=lot.id) AS graph_member
    FROM scoped JOIN inventory.inventory_lots lot ON lot.id=scoped.id ORDER BY scoped.line_id,lot.id LIMIT ${MAX_LOTS + 1}`)
    ).rows,
    MAX_LOTS,
    "cost lot graph",
  );
  const applicationIds = revisions.flatMap((row) =>
    row.application_id == null
      ? []
      : [costInteger(row.application_id, "application.id", 1)],
  );
  const changes =
    applicationIds.length === 0
      ? []
      : bounded(
          (
            await tx.execute(sql`SELECT application_id,inventory_lot_id,after_state
    FROM inventory.cost_application_lots WHERE application_id=ANY(${sql.param(applicationIds)}::bigint[]) ORDER BY application_id,inventory_lot_id LIMIT ${MAX_LOTS * 2 + 1}`)
          ).rows,
          MAX_LOTS * 2,
          "component snapshots",
        );
  const invoices = bounded(
    (
      await tx.execute(sql`SELECT line.id,line.line_number,line.purchase_order_line_id,line.vendor_invoice_id,
    invoice.invoice_number FROM procurement.vendor_invoice_lines line
    JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    WHERE line.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) AND invoice.status IN ('approved','partially_paid','paid')
    ORDER BY line.id LIMIT ${MAX_LOTS + 1}`)
    ).rows,
    MAX_LOTS,
    "invoice evidence",
  );
  const receipts = bounded(
    (
      await tx.execute(sql`SELECT DISTINCT line.purchase_order_line_id,receipt.id,receipt.receipt_number,receipt.status
    FROM procurement.receiving_lines line JOIN procurement.receiving_orders receipt ON receipt.id=line.receiving_order_id
    WHERE line.purchase_order_line_id=ANY(${sql.param(ids)}::int[]) AND receipt.status='closed' ORDER BY line.purchase_order_line_id,receipt.id LIMIT ${MAX_LOTS + 1}`)
    ).rows,
    MAX_LOTS,
    "receipt evidence",
  );
  const result: PurchaseCostStatus = { lines: [] };
  const repairs = (await tx.execute(sql`SELECT * FROM inventory.cost_origin_repairs
    WHERE purchase_order_line_id=ANY(${sql.param(ids)}::int[]) ORDER BY id LIMIT ${MAX_LOTS + 1}`)).rows;
  bounded(repairs, MAX_LOTS, "origin repairs");
  for (const line of lines) {
    const lineId = costInteger(line.id, "purchaseOrderLineId", 1);
    const source = sources.get(lineId);
    if (!source)
      throw new CostEvidenceError(
        "COST_SOURCE_MISSING",
        "The purchase cost source changed during its read.",
      );
    const lineLots = lots.filter((lot) => Number(lot.line_id) === lineId);
    const components: PurchaseCostStatus["lines"][number]["components"] = [];
    for (const input of resolvedSources.get(lineId)!) {
      const matches = revisions.filter(
        (row) =>
          Number(row.purchase_order_line_id) === lineId &&
          row.component === input.component,
      );
      if (matches.length > 1)
        throw new CostEvidenceError(
          "COST_REVISION_AMBIGUOUS",
          "More than one current component revision was recorded.",
        );
      const row = matches[0];
      const currentFingerprint = costFingerprint({
        input,
        sourceEvidence: source,
      });
      const contract = costSourceRevisionSchema.safeParse(row?.contract);
      const savedIssues = z.array(costIssueSchema).safeParse(row?.evidence?.result?.issues);
      const plan = contract.success && savedIssues.success && savedIssues.data.length > 0 && contract.data.fingerprint === currentFingerprint
        ? await planCostReconciliation(tx, { id: costInteger(row.id, "revisionId", 1), contract: contract.data }, savedIssues.data, false) : null;
      const historicalPosting = plan?.matches && plan.ledger.approval && savedIssues.success && savedIssues.data.length > 0
        && savedIssues.data.every(issue => issue.code === "COST_UNRESOLVED_QUANTITY_RETAINED")
        && BigInt(plan.identity.historicalAmountMills) === savedIssues.data.reduce((sum, issue) => sum + BigInt(issue.unresolvedQuantity?.amountMills ?? 0), BigInt(0))
        ? { destination: plan.ledger.approval.destination, amountMills: plan.identity.historicalAmountMills } : undefined;
      const event = row?.reporting_payload as Record<string, unknown> | null;
      const recorded = row?.evidence as {
        result?: { lotsUpdated?: number; totalCogsDeltaCents?: number; inventoryEffectProof?: unknown };
      } | null;
      const snapshotRows = changes.filter(
        (change) =>
          String(change.application_id) === String(row?.application_id),
      );
      const reportingVerified =
        event?.contractVersion === 1 &&
        event?.sourceRevisionId === Number(row?.id) &&
        event?.sourceFingerprint === currentFingerprint &&
        event?.component === input.component &&
        event?.currency === input.currency &&
        event?.cogsDeltaCents === recorded?.result?.totalCogsDeltaCents &&
        (!input.inventoryEffect || canonicalJson(event?.inventoryEffectProof ?? null) === canonicalJson(recorded?.result?.inventoryEffectProof ?? null)) &&
        Array.isArray(event?.changes) &&
        event.changes.length === snapshotRows.length &&
        event.changes.every((change: { lotId?: unknown; after?: unknown }) =>
          snapshotRows.some(
            (snapshot) =>
              Number(snapshot.inventory_lot_id) === change.lotId &&
              canonicalJson(snapshot.after_state) ===
                canonicalJson(change.after),
          ),
        );
      const component = projectPurchaseComponentStatus({
        input,
        noInventoryEffectEvidence: noInventoryEffects.get(lineId),
        historicalPosting,
        currentFingerprint,
        revision: row
          ? {
              id: costInteger(row.id, "revision.id", 1),
              contract: row.contract,
            }
          : null,
        application: row?.application_id
          ? {
              id: costInteger(row.application_id, "application.id", 1),
              status: String(row.status),
              evidence: row.evidence,
              reportingVerified,
            }
          : null,
        lotIds: lineLots
          .filter((lot) => lot.graph_member === true)
          .map((lot) => costInteger(lot.id, "lot.id", 1)),
        unprovenLotIds: lineLots
          .filter(
            (lot) =>
              lot.graph_member !== true ||
              lot.receipt_origin === lot.transformed,
          )
          .map((lot) => costInteger(lot.id, "lot.id", 1)),
        changedLots: snapshotRows.map((snapshot) => {
          const lot = lineLots.find(
            (lot) => Number(lot.id) === Number(snapshot.inventory_lot_id),
          );
          const after = snapshot.after_state as Record<string, unknown>;
          const unit =
            input.component === "product"
              ? "po_unit_cost_mills"
              : "packaging_cost_mills";
          const total =
            input.component === "product"
              ? "product_total_cost_mills"
              : "packaging_total_cost_mills";
          const afterUnit =
            input.component === "product" ? "productMills" : "packagingMills";
          return {
            lotId: costInteger(snapshot.inventory_lot_id, "lot.id", 1),
            component: String(after?.component),
            amountMatches:
              !!lot &&
              String(lot[unit]) === String(after?.[afterUnit]) &&
              lot[total] != null &&
              String(lot[total]) === String(after?.allocatedMills),
          };
        }),
      });
      components.push({ ...component,
        ...(component.status === "applied" && row?.recorded_at != null && row.actor_name != null && input.totalMills !== null
          ? { postingReceipt: { applicationId: costInteger(row.application_id, "applicationId", 1), actorName: String(row.actor_name),
            recordedAt: new Date(row.recorded_at).toISOString(), amountMills: input.totalMills } } : {}),
      });
    }
    result.lines.push({
      purchaseOrderId: costInteger(
        line.purchase_order_id,
        "purchaseOrderId",
        1,
      ),
      purchaseOrderLineId: lineId,
      sku: line.sku == null ? null : String(line.sku),
      poNumber: line.po_number == null ? null : String(line.po_number),
      reviewFacts: purchaseCostReviewFacts(source),
      components,
      originRepairs: repairs.filter(repair => Number(repair.purchase_order_line_id) === lineId).map(repair => ({
        ...originRepairApprovalSchema.parse({ id: costInteger(repair.id, "repairId", 1), actorName: repair.actor_name,
          reason: repair.reason, recordedAt: new Date(repair.recorded_at).toISOString(), destination: repair.evidence.choices.destination,
          summary: repair.evidence.summary }), lotId: costInteger(repair.inventory_lot_id, "lotId", 1),
      })),
      invoices: invoices
        .filter((invoice) => Number(invoice.purchase_order_line_id) === lineId)
        .map((invoice) => ({
          invoiceId: costInteger(invoice.vendor_invoice_id, "invoice.id", 1),
          invoiceNumber: String(invoice.invoice_number),
          lineId: costInteger(invoice.id, "invoiceLine.id", 1),
          lineNumber: costInteger(invoice.line_number, "lineNumber", 1),
        })),
      receipts: receipts
        .filter((receipt) => Number(receipt.purchase_order_line_id) === lineId)
        .map((receipt) => ({
          receiptId: costInteger(receipt.id, "receipt.id", 1),
          receiptNumber: String(receipt.receipt_number),
          status: String(receipt.status),
        })),
      lots: lineLots.map((lot) => ({
        id: costInteger(lot.id, "lot.id", 1),
        lotNumber: String(lot.lot_number),
        onHandUnits: costInteger(lot.qty_on_hand, "lot.onHand"),
        shipmentId:
          lot.inbound_shipment_id == null
            ? null
            : costInteger(lot.inbound_shipment_id, "shipment.id", 1),
        provisional: lot.cost_provisional === 1,
        origin:
          lot.receipt_origin === true && lot.transformed !== true
            ? "receipt"
            : lot.transformed === true && lot.receipt_origin !== true
              ? "transformation"
              : "unproven",
      })),
    });
  }
  return purchaseCostStatusSchema.parse(result);
}
