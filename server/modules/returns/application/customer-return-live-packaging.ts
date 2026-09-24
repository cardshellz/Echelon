import { createHash } from "node:crypto";
import { customerReturnDimensionsSchema, MAX_RETURN_ORIGINAL_BOXES,
  type CustomerReturnBoxOption } from "../../../../shared/returns/customer-return-parcel";
import { customerReturnPackageDimensionsInputSchema, CustomerReturnPackageDimensionsError,
  type CustomerReturnPackageDimensionsInput, type CustomerReturnPackageDimensionsReader } from "./customer-return-package-dimensions.ports";
import { customerReturnLocalInspectionSnapshotSchema, type CustomerReturnLocalInspectionSnapshot } from "./customer-return-local-inspection.ports";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";

interface BoxCandidate extends CustomerReturnPackageDimensionsInput {
  id: string;
  items: CustomerReturnBoxOption["items"];
}
export type ReturnBoxDiagnostic = { operation: "original_box_dimensions"; code: string };
export type ReturnBoxReporter = (event: ReturnBoxDiagnostic) => void;
const DIMENSIONS_PHASE_TIMEOUT_MS = 15_000;
const DIMENSIONS_CONCURRENCY = 2;

export function customerReturnPublicLineId(channelId: number, orderId: string, lineId: string): string {
  return `line-${createHash("sha256").update(JSON.stringify([channelId, orderId, lineId])).digest("hex")}`;
}

/** Exact whole original packages only. No SKU, pack-plan or tracking-only joins. */
export function projectCustomerReturnOriginalBoxCandidates(raw: CustomerReturnLocalInspectionSnapshot): BoxCandidate[] {
  const local = customerReturnLocalInspectionSnapshotSchema.parse(raw);
  if (local.issues.some(issue => issue.omsOrderLineId === null)) return [];
  const orderId = providerId("Order", local.order.externalOrderId);
  if (orderId === null) return [];
  const lines = new Map(local.lines.map(line => [line.omsOrderLineId, line]));
  const wms = new Map(local.wmsItems.map(item => [item.wmsOrderItemId, item]));
  const affectedLines = new Set(local.issues.map(issue => issue.omsOrderLineId));
  const groups = new Map<number, typeof local.packageItems>();
  for (const item of local.packageItems) {
    const existing = groups.get(item.physicalShipmentId);
    if (existing) existing.push(item); else groups.set(item.physicalShipmentId, [item]);
  }
  const activeLabels = new Map<number, typeof local.packageLabels>();
  for (const label of local.packageLabels) {
    if (label.status !== "active") continue;
    const existing = activeLabels.get(label.physicalShipmentId);
    if (existing) existing.push(label); else activeLabels.set(label.physicalShipmentId, [label]);
  }
  const candidates: Array<BoxCandidate & { quantities: Map<number, number>; wmsQuantities: Map<number, number> }> = [];
  for (const [physicalShipmentId, items] of groups) {
    const first = items[0];
    const input = customerReturnPackageDimensionsInputSchema.safeParse({
      providerPhysicalShipmentId: first.providerPhysicalShipmentId, trackingNumber: first.trackingNumber,
    });
    if (!input.success || first.provider !== "shipstation" || first.status !== "shipped") continue;
    const labels = activeLabels.get(physicalShipmentId) ?? [];
    if (labels.length === 0 || labels.some(label => label.direction !== "outbound" || label.voidedAt !== null
      || label.provider !== first.provider || tracking(label.trackingNumber) !== tracking(first.trackingNumber))) continue;
    const quantities = new Map<number, number>(), wmsQuantities = new Map<number, number>();
    let valid = true;
    for (const item of items) {
      const source = item.wmsOrderItemId === null ? undefined : wms.get(item.wmsOrderItemId);
      const line = source?.omsOrderLineId == null ? undefined : lines.get(source.omsOrderLineId);
      if (!source || !line || line.externalLineItemId === null || line.requiresShipping === false
        || (source.channelId !== null && source.channelId !== local.shop.channelId)
        || providerId("LineItem", line.externalLineItemId) === null
        || (source.externalOrderId !== null && providerId("Order", source.externalOrderId) !== orderId)
        || (source.externalLineItemId !== null && providerId("LineItem", source.externalLineItemId) !== providerId("LineItem", line.externalLineItemId))
        || (item.omsOrderLineId !== null && item.omsOrderLineId !== line.omsOrderLineId)
        || affectedLines.has(line.omsOrderLineId)
        || item.provider !== first.provider || item.providerPhysicalShipmentId !== first.providerPhysicalShipmentId
        || item.status !== "shipped" || tracking(item.trackingNumber) !== tracking(first.trackingNumber)
        || item.purpose !== "customer_fulfillment" || item.replacementForOrderItemId !== null
        || item.correctionForPhysicalShipmentItemId !== null || item.effectiveQuantity <= 0
        || item.effectiveQuantity > item.originalQuantity || item.effectiveQuantity > source.quantity) { valid = false; break; }
      quantities.set(line.omsOrderLineId, (quantities.get(line.omsOrderLineId) ?? 0) + item.effectiveQuantity);
      wmsQuantities.set(source.wmsOrderItemId, (wmsQuantities.get(source.wmsOrderItemId) ?? 0) + item.effectiveQuantity);
    }
    if (!valid) continue;
    const id = createHash("sha256").update(JSON.stringify([local.shop.channelId, local.order.externalOrderId,
      physicalShipmentId, first.providerPhysicalShipmentId])).digest("hex");
    const contents = [...quantities].map(([lineId, quantity]) => {
      const purchasedId = providerId("LineItem", lines.get(lineId)!.externalLineItemId!)!;
      return { quantity, lineId: customerReturnPublicLineId(local.shop.channelId, orderId, purchasedId) };
    }).sort((a, b) => a.lineId.localeCompare(b.lineId));
    candidates.push({ ...input.data, id: `box-${id}`, quantities, wmsQuantities, items: contents });
  }
  const totals = new Map<number, number>(), wmsTotals = new Map<number, number>();
  const providerUses = new Map<string, number>();
  for (const candidate of candidates) {
    for (const [id, quantity] of candidate.quantities) totals.set(id, (totals.get(id) ?? 0) + quantity);
    for (const [id, quantity] of candidate.wmsQuantities) wmsTotals.set(id, (wmsTotals.get(id) ?? 0) + quantity);
    providerUses.set(candidate.providerPhysicalShipmentId, (providerUses.get(candidate.providerPhysicalShipmentId) ?? 0) + 1);
  }
  return candidates.filter(candidate => providerUses.get(candidate.providerPhysicalShipmentId) === 1
    && [...candidate.quantities].every(([id]) => Number.isSafeInteger(totals.get(id)) && totals.get(id)! <= lines.get(id)!.quantity)
    && [...candidate.wmsQuantities].every(([id]) => Number.isSafeInteger(wmsTotals.get(id)) && wmsTotals.get(id)! <= wms.get(id)!.quantity))
    .map(({ quantities: _quantities, wmsQuantities: _wmsQuantities, ...candidate }) => candidate)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Optional measurements never change eligibility. Abort bounds the whole phase,
 * including adapters that ignore cancellation, and never reserves or buys labels. */
export async function readCustomerReturnOriginalBoxes(local: CustomerReturnLocalInspectionSnapshot,
  reader: CustomerReturnPackageDimensionsReader, report: ReturnBoxReporter = defaultReporter): Promise<CustomerReturnBoxOption[]> {
  const candidates = projectCustomerReturnOriginalBoxCandidates(local);
  if (candidates.length > MAX_RETURN_ORIGINAL_BOXES) { safeReport(report, "RETURN_BOX_DIMENSIONS_LIMIT"); return []; }
  if (candidates.length === 0) return [];
  const controller = new AbortController();
  const cancelled = new Promise<null>(resolve => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
  const timer = setTimeout(() => { safeReport(report, "RETURN_BOX_DIMENSIONS_BUDGET_EXCEEDED"); controller.abort(); }, DIMENSIONS_PHASE_TIMEOUT_MS);
  const results: CustomerReturnBoxOption[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (!controller.signal.aborted && next < candidates.length) {
      const candidate = candidates[next++];
      try {
        const raw = await Promise.race([reader.read({ providerPhysicalShipmentId: candidate.providerPhysicalShipmentId,
          trackingNumber: candidate.trackingNumber }, controller.signal), cancelled]);
        if (controller.signal.aborted) return;
        if (raw === null) { safeReport(report, "RETURN_BOX_DIMENSIONS_MISSING"); continue; }
        const parsed = customerReturnDimensionsSchema.safeParse(raw);
        if (!parsed.success) { safeReport(report, "RETURN_BOX_DIMENSIONS_INVALID"); continue; }
        results.push({ id: candidate.id, dimensions: parsed.data, items: candidate.items });
      } catch (cause) {
        safeReport(report, cause instanceof CustomerReturnPackageDimensionsError ? cause.code : "RETURN_BOX_DIMENSIONS_READ_FAILED");
        // A configuration/transport outage should not trigger up to 100 failed calls.
        if (!(cause instanceof CustomerReturnPackageDimensionsError) || cause.failureClass !== "permanent") controller.abort();
      }
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(DIMENSIONS_CONCURRENCY, candidates.length) }, worker)); }
  finally { clearTimeout(timer); controller.abort(); }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

function tracking(value: string | null): string | null { return value?.replace(/[^a-z0-9]/gi, "").toUpperCase() || null; }
function providerId(resource: "Order" | "LineItem", value: string): string | null {
  try { return gid(resource, value); } catch { return null; }
}
function defaultReporter(event: ReturnBoxDiagnostic): void { console.warn(JSON.stringify(event)); }
function safeReport(report: ReturnBoxReporter, code: string): void {
  try { report({ operation: "original_box_dimensions", code }); }
  catch { defaultReporter({ operation: "original_box_dimensions", code: "RETURN_BOX_DIAGNOSTIC_FAILED" }); }
}
