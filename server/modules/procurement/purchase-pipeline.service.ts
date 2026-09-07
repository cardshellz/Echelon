import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import { purchasePipelineSchema, supplierProgressSchema, type PurchasePipeline, type PurchasePipelineCost, type PurchasePipelineRow } from "@shared/procurement/purchase-pipeline";
import { resolvePurchaseOrderArrival } from "./purchase-order-arrival";
import { purchaseReceiptMirrorIssue, resolvePurchaseReceiptQuantities } from "./purchase-receipt-quantity-evidence";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const date = z.string().datetime({ offset: true });
const money = z.string().regex(/^-?\d+$/).max(100).nullable();
export const PIPELINE_EVIDENCE_LIMIT = 10_000;
const DAY_MS = 86_400_000;
export const pipelineEvidenceSchema = z.object({
  lines: z.array(z.object({
    id, purchaseOrderId: id, poNumber: z.string(), vendorName: z.string(), poStatus: z.string(), status: z.string(),
    sku: z.string().nullable(), productName: z.string().nullable(), currency: z.string().nullable(),
    ordered: quantity, received: quantity, cancelled: quantity,
    pricingBasis: z.string(), quotedUnitMills: money, quotedTotalCents: money, purchaseUomQuantity: quantity.nullable(), piecesPerPurchaseUom: quantity.nullable(), packagingCents: money,
    quoteReference: z.string().nullable(), expectedDate: date.nullable(), promisedDate: date.nullable(), confirmedDate: date.nullable(), purchaseExpectedDate: date.nullable(),
    progress: supplierProgressSchema,
  })).max(PIPELINE_EVIDENCE_LIMIT),
  shipments: z.array(z.object({
    id, shipmentId: id, purchaseOrderId: id.nullable(), purchaseOrderLineId: id.nullable(), shipmentNumber: z.string(), status: z.string(), quantity,
    eta: date.nullable(), deliveredAt: date.nullable(),
  })).max(PIPELINE_EVIDENCE_LIMIT),
  receipts: z.array(z.object({
    id, receivingOrderId: id, purchaseOrderId: id.nullable(), purchaseOrderLineId: id.nullable(), shipmentId: id.nullable(), shipmentLineId: id.nullable(),
    received: quantity, reversed: quantity, units: quantity.positive().nullable(), status: z.literal("closed"),
  })).max(PIPELINE_EVIDENCE_LIMIT),
  postings: z.array(z.object({ receivingLineId: id, receivingOrderId: id, purchaseOrderId: id, purchaseOrderLineId: id, qtyReceived: quantity })).max(PIPELINE_EVIDENCE_LIMIT),
  reversals: z.array(z.object({ id, receivingLineId: id, receivingOrderId: id, qty: quantity.positive(), baseUnitsReversed: quantity.positive().nullable() })).max(PIPELINE_EVIDENCE_LIMIT),
  revisions: z.array(z.object({ id: z.number().int().positive().safe(), purchaseOrderLineId: id, shipmentLineId: id.nullable(), component: z.enum(["product", "packaging", "landed"]), revision: quantity.positive(), fingerprint: z.string(), contract: z.unknown(), sourceEvidence: z.unknown(), recordedAt: date })).max(PIPELINE_EVIDENCE_LIMIT),
});
export type PipelineEvidence = z.infer<typeof pipelineEvidenceSchema>;
type Line = PipelineEvidence["lines"][number];
type Shipment = PipelineEvidence["shipments"][number];
export class PurchasePipelineError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422) { super(message); this.name = "PurchasePipelineError"; }
}
function indexed<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const result = new Map<number, T[]>();
  for (const row of rows) { const id = key(row); const group = result.get(id) ?? []; group.push(row); result.set(id, group); }
  return result;
}
function exactSum(values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + BigInt(value), BigInt(0));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new PurchasePipelineError("PIPELINE_QUANTITY_OVERFLOW", "Pipeline quantities exceed the supported exact range.");
  return Number(result);
}
function uniqueIds(rows: readonly { id: number }[], label: string): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new PurchasePipelineError("PIPELINE_DUPLICATE_EVIDENCE", `Duplicate ${label} identities require review.`);
}

// Compatibility export for existing pipeline consumers; planning uses the same
// minimal physical-receipt authority without constructing cost/progress evidence.
export const resolvePipelineReceiptQuantities = resolvePurchaseReceiptQuantities;

// Cumulative proportional preview allocates every mill once, including signed
// credit residuals. It never changes the inventory owner's accounting entries.
export function pipelineIntervalMills(total: bigint, denominator: number, start: number, count: number): string {
  if (!Number.isSafeInteger(denominator) || denominator <= 0 || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0 || start + count > denominator) throw new PurchasePipelineError("PIPELINE_COST_INTERVAL_INVALID", "The cost quantity interval is outside its captured source.");
  return ((total * BigInt(start + count)) / BigInt(denominator) - (total * BigInt(start)) / BigInt(denominator)).toString();
}
function quoteProduct(line: Line): bigint | null {
  if (line.pricingBasis === "per_piece" && line.quotedUnitMills !== null) return BigInt(line.quotedUnitMills) * BigInt(line.ordered);
  if (line.pricingBasis === "per_purchase_uom" && line.quotedUnitMills !== null && line.purchaseUomQuantity !== null && line.piecesPerPurchaseUom !== null && BigInt(line.purchaseUomQuantity) * BigInt(line.piecesPerPurchaseUom) === BigInt(line.ordered)) return BigInt(line.quotedUnitMills) * BigInt(line.purchaseUomQuantity);
  if (line.pricingBasis === "extended_total" && line.quotedTotalCents !== null) return BigInt(line.quotedTotalCents) * BigInt(100);
  return null;
}
function componentCost(revisions: ReadonlyMap<string, PipelineEvidence["revisions"][number]>, line: Line, component: PurchasePipelineCost["component"], shipment: Shipment | null, start: number, count: number, issues: string[]): PurchasePipelineCost {
  const missing: PurchasePipelineCost = { component, amountMills: null, evidence: "unknown", source: "missing", sourceRevisionId: null, recordedAt: null, reference: null };
  if (!/^[A-Z]{3}$/.test(line.currency ?? "")) return missing;
  const row = revisions.get(`${line.id}:${component === "landed" ? shipment?.id ?? 0 : 0}:${component}`);
  if (row) {
    const parsed = costSourceRevisionSchema.safeParse(row.contract);
    if (parsed.success) {
      const { fingerprint, revision, ...input } = parsed.data;
      const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
      const matches = fingerprint === hash({ input, sourceEvidence: row.sourceEvidence }) || (row.sourceEvidence === null && fingerprint === hash(input));
      const source = parsed.data;
      const scopeMatches = source.scope.purchaseOrderLineId === line.id && source.scope.purchaseOrderId === line.purchaseOrderId && (component === "landed"
        ? source.scope.kind === "shipment_line" && source.scope.inboundShipmentLineId === shipment?.id && source.scope.inboundShipmentId === shipment.shipmentId
        : source.scope.kind === "purchase_order_line");
      const denominator = component === "landed" ? shipment?.quantity : line.ordered;
      if (matches && fingerprint === row.fingerprint && revision === row.revision && source.component === component && scopeMatches && source.currency === line.currency && source.basePieces === denominator && source.totalMills !== null && ["estimated", "confirmed"].includes(source.evidence) && source.issue === null) {
        return { component, amountMills: pipelineIntervalMills(BigInt(source.totalMills), denominator!, start, count), evidence: source.evidence as "estimated" | "confirmed", source: "recorded_revision", sourceRevisionId: row.id, recordedAt: row.recordedAt, reference: `Revision ${source.revision}` };
      }
    }
    issues.push(`${component} revision ${row.id} has unresolved, partial or conflicting evidence; no full-value extrapolation was made.`);
    // A newer unresolved revision must never be replaced by an older quote and
    // presented as a resolved component value.
    return { ...missing, source: "recorded_revision", sourceRevisionId: row.id, recordedAt: row.recordedAt, evidence: "review_required" };
  }
  const product = quoteProduct(line);
  const total = component === "product" ? product : component === "packaging" && product !== null && line.packagingCents !== null ? BigInt(line.packagingCents) * BigInt(100) : null;
  if (total === null || total < BigInt(0)) return missing;
  return { component, amountMills: pipelineIntervalMills(total, line.ordered, start, count), evidence: "estimated", source: "purchase_quote", sourceRevisionId: null, recordedAt: null, reference: line.quoteReference };
}

function arrival(line: Line, shipment: Shipment | null, asOf: Date, horizonDays: 30 | 90): Pick<PurchasePipelineRow, "arrivalDate" | "arrivalSource" | "arrivalBucket" | "arrivalDestination"> {
  const selected = shipment?.eta ? { date: shipment.eta, source: "shipment_eta" as const } : resolvePurchaseOrderArrival(line);
  const arrivalDate = selected.date;
  const arrivalSource = selected.source;
  const day = asOf.toISOString().slice(0, 10); const dateDay = arrivalDate?.slice(0, 10);
  return { arrivalDate, arrivalSource, arrivalDestination: arrivalSource === "shipment_eta" ? "shipment_destination" : arrivalDate ? "warehouse" : "unknown",
    arrivalBucket: shipment?.deliveredAt ? "arrived" : !dateDay ? "unknown" : dateDay < day ? "overdue" : new Date(dateDay).getTime() < new Date(day).getTime() + horizonDays * DAY_MS ? "within_horizon" : "later" };
}
function shipmentStage(status: string): PurchasePipelineRow["stage"] | null {
  if (["in_transit"].includes(status)) return "in_transit";
  if (["at_port", "customs_clearance"].includes(status)) return "port_customs";
  if (["delivered", "costing", "closed"].includes(status)) return "awaiting_receipt";
  return null;
}
export function projectPurchasePipeline(input: PipelineEvidence, asOf: Date, horizonDays: 30 | 90): PurchasePipeline {
  if (!Number.isFinite(asOf.getTime()) || ![30, 90].includes(horizonDays)) throw new PurchasePipelineError("PIPELINE_INPUT_INVALID", "A valid snapshot time and 30/90 day horizon are required.");
  const data = pipelineEvidenceSchema.parse(input);
  for (const [rows, label] of [[data.lines, "purchase lines"], [data.shipments, "shipment lines"], [data.receipts, "receipts"], [data.reversals, "reversals"], [data.revisions, "cost revisions"]] as const) uniqueIds(rows, label);
  const receipts = resolvePipelineReceiptQuantities(data);
  const shipmentsByLine = indexed(data.shipments, (row) => row.purchaseOrderLineId ?? 0);
  const unlinkedShipmentPurchases = new Set(data.shipments.filter((row) => row.purchaseOrderLineId === null && !["draft", "cancelled"].includes(row.status)).map((row) => row.purchaseOrderId));
  const costRevisions = new Map<string, PipelineEvidence["revisions"][number]>();
  for (const revision of data.revisions) {
    const key = `${revision.purchaseOrderLineId}:${revision.shipmentLineId ?? 0}:${revision.component}`;
    const existing = costRevisions.get(key);
    if (existing?.revision === revision.revision) throw new PurchasePipelineError("PIPELINE_DUPLICATE_REVISION", "A cost component has conflicting revisions for the same source version.");
    if (!existing || existing.revision < revision.revision) costRevisions.set(key, revision);
  }
  const rows: PurchasePipelineRow[] = []; const issues: string[] = [];
  const lineIds = new Set(data.lines.map((line) => line.id));
  for (const shipment of data.shipments) if (shipment.purchaseOrderLineId === null || !lineIds.has(shipment.purchaseOrderLineId)) issues.push(`Shipment ${shipment.shipmentNumber}, line ${shipment.id}: no active exact purchase line; quantity and value are not added by SKU.`);
  for (const line of data.lines) {
    if (!["approved", "sent", "acknowledged", "partially_received"].includes(line.poStatus) || ["received", "closed", "cancelled"].includes(line.status)) continue;
    const lineIssues = [...receipts.issues.get(line.id) ?? []];
    const physical = receipts.byLine.get(line.id) ?? 0;
    const netOrdered = line.ordered - line.cancelled;
    const mirrorIssue = purchaseReceiptMirrorIssue(line.id, line.received, receipts);
    if (mirrorIssue) lineIssues.push(mirrorIssue);
    if (receipts.unlinkedPurchaseIds.has(line.purchaseOrderId)) lineIssues.push("A closed receipt on this purchase lacks an exact product-line link.");
    if (netOrdered < 0 || physical > netOrdered) lineIssues.push("Received/cancelled quantities exceed the ordered quantity.");
    const remaining = lineIssues.length ? null : netOrdered - physical;
    if (remaining === 0) continue;
    const linked = (shipmentsByLine.get(line.id) ?? []).filter((shipment) => !["cancelled", "draft"].includes(shipment.status));
    if (linked.some((shipment) => shipment.status !== "booked" && shipmentStage(shipment.status) === null)) lineIssues.push("An active shipment has an unsupported physical stage.");
    const dispatched = linked.filter((shipment) => shipmentStage(shipment.status) !== null).sort((a, b) => a.id - b.id);
    const receivedInShipments = exactSum(dispatched.map((shipment) => receipts.byShipmentLine.get(shipment.id) ?? 0));
    const dispatchedPieces = exactSum(dispatched.map((shipment) => shipment.quantity));
    const directReceived = physical - receivedInShipments;
    if (linked.some((shipment) => (shipment.purchaseOrderId !== null && shipment.purchaseOrderId !== line.purchaseOrderId) || (receipts.byShipmentLine.get(shipment.id) ?? 0) > shipment.quantity)) lineIssues.push("Shipment source identities or received quantities conflict.");
    if (exactSum(linked.map((shipment) => shipment.quantity)) + directReceived > netOrdered || directReceived < 0) lineIssues.push("Shipment coverage exceeds the remaining order; no overlapping stage quantities were assigned.");
    if (unlinkedShipmentPurchases.has(line.purchaseOrderId)) lineIssues.push("This purchase has an active shipment line without an exact purchase-line link.");
    if (physical > line.received) issues.push(`${line.poNumber}, ${line.sku ?? line.id}: ${physical - line.received} physically received pieces are awaiting PO reconciliation and excluded from the pipeline.`);
    const base = { purchaseOrderId: line.purchaseOrderId, purchaseOrderLineId: line.id, poNumber: line.poNumber, vendorName: line.vendorName, sku: line.sku, productName: line.productName,
      currency: /^[A-Z]{3}$/.test(line.currency ?? "") ? line.currency : null, orderedPieces: line.ordered, cancelledPieces: line.cancelled, receivedPieces: remaining === null ? null : physical, remainingPieces: remaining, progress: line.progress };
    const add = (stage: PurchasePipelineRow["stage"], count: number | null, start: number, shipment: Shipment | null, moreIssues: string[] = []) => {
      if (count === 0) return;
      const rowIssues = [...lineIssues, ...moreIssues];
      const costs = (["product", "packaging", "landed"] as const).map((component) => count === null || stage === "review"
        ? ({ component, amountMills: null, evidence: "review_required", source: "missing", sourceRevisionId: null, recordedAt: null, reference: null } as PurchasePipelineCost)
        : componentCost(costRevisions, line, component, shipment, component === "landed" ? receipts.byShipmentLine.get(shipment?.id ?? 0) ?? 0 : start, count, rowIssues));
      rows.push({ ...base, key: `${line.id}:${shipment?.id ?? 0}:${stage}`, stage, quantityPieces: count, shipmentId: shipment?.shipmentId ?? null, shipmentLineId: shipment?.id ?? null, shipmentNumber: shipment?.shipmentNumber ?? null,
        ...arrival(line, shipment, asOf, horizonDays), costs, issues: rowIssues });
    };
    if (lineIssues.length) { add("review", remaining, 0, null); continue; }
    let offset = physical;
    for (const shipment of dispatched) {
      const count = shipment.quantity - (receipts.byShipmentLine.get(shipment.id) ?? 0);
      add(shipmentStage(shipment.status)!, count, offset, shipment); offset += count;
    }
    const supplierPieces = netOrdered - offset;
    if (supplierPieces === 0) continue;
    const report = line.progress.report;
    const progressIssues: string[] = [];
    if (report && (report.startedPieces > netOrdered || report.completedPieces < dispatchedPieces + directReceived)) progressIssues.push("Supplier progress conflicts with current ordered, dispatched or received quantities; update the report.");
    if (report && new Date(report.asOf).getTime() > asOf.getTime()) progressIssues.push("Supplier progress is future-dated; confirm its reported time.");
    if (!report || progressIssues.length) { add("supplier_unconfirmed", supplierPieces, offset, null, progressIssues.length ? progressIssues : ["Production has not been reported. Sent or acknowledged does not prove production."]); continue; }
    const ready = report.completedPieces - dispatchedPieces - directReceived;
    const production = report.startedPieces - report.completedPieces;
    add("ready_to_ship", ready, offset, null); offset += ready;
    add("in_production", production, offset, null); offset += production;
    add("supplier_unconfirmed", netOrdered - offset, offset, null);
  }
  const totalMap = new Map<string, PurchasePipeline["totals"][number]>();
  for (const row of rows) {
    const key = `${row.currency ?? "unknown"}:${row.stage}`;
    const total = totalMap.get(key) ?? { currency: row.currency, stage: row.stage, knownPieces: 0, quantityReviewRows: 0, confirmedMills: "0", estimatedMills: "0", unknownComponentCount: 0 };
    if (row.quantityPieces === null) total.quantityReviewRows++; else total.knownPieces = exactSum([total.knownPieces, row.quantityPieces]);
    for (const cost of row.costs) {
      if (cost.amountMills === null) total.unknownComponentCount++;
      else if (cost.evidence === "confirmed") total.confirmedMills = (BigInt(total.confirmedMills) + BigInt(cost.amountMills)).toString();
      else total.estimatedMills = (BigInt(total.estimatedMills) + BigInt(cost.amountMills)).toString();
    }
    totalMap.set(key, total);
  }
  return purchasePipelineSchema.parse({ contractVersion: 1, asOf: asOf.toISOString(), horizonDays, rows, totals: [...totalMap.values()], issues: [...new Set(issues)] });
}
