import { sql } from "drizzle-orm";
import { z } from "zod";
import { poLineAmountCents, type PoLineProductIdentity, type PoQuantityPreviewRequest } from "@shared/procurement/po-quantity-amendment";
import { preparePurchaseOrderLine, preparePurchaseOrderLineIdentity, PurchaseOrderLineCommandError } from "./purchase-order-line-commands";
import { PoQuantityAmendmentError, type AmendmentHeader, type AmendmentLine, type PreparedPoAddition, type PreparedPoProductChange } from "./po-quantity-amendment.policy";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { costFingerprint, costInteger } from "../inventory/infrastructure/cost-evidence-values";

/** Bounds the document names quoted in one reason; the full set stays in the documents. */
const MAX_NAMED_DOCUMENTS = 5;

function namedDocuments(value: unknown, field: string): string[] {
  const parsed = z.array(z.string()).nullable().safeParse(value);
  if (!parsed.success) throw new PoQuantityAmendmentError(`Recorded ${field} evidence is invalid. Review the source documents first.`, "PO_AMENDMENT_SOURCE_INVALID");
  const names = parsed.data ?? [];
  return names.length > MAX_NAMED_DOCUMENTS ? [...names.slice(0, MAX_NAMED_DOCUMENTS), `${names.length - MAX_NAMED_DOCUMENTS} more`] : names;
}

/** Documents that recorded the line's current product as a physical or cost
 * fact. Receiving lines cover custody too: an identified quarantine observation
 * always carries the receiving line of the same PO line. Cancelled shipments
 * and invoices are history only and keep their own recorded descriptions. */
export async function readPoLineProductChangeBlocks(tx: AmendmentTransaction, lineIds: number[]): Promise<Record<number, string>> {
  if (!lineIds.length) return {};
  const result = await tx.execute(sql`SELECT l.id,
    (SELECT array_agg(DISTINCT COALESCE(s.shipment_number, 'shipment #' || s.id::text) ORDER BY COALESCE(s.shipment_number, 'shipment #' || s.id::text))
      FROM procurement.inbound_shipment_lines sl JOIN procurement.inbound_shipments s ON s.id=sl.inbound_shipment_id
      WHERE sl.purchase_order_line_id=l.id AND s.status <> 'cancelled') AS shipments,
    (SELECT array_agg(DISTINCT COALESCE(r.receipt_number, 'receipt #' || r.id::text) ORDER BY COALESCE(r.receipt_number, 'receipt #' || r.id::text))
      FROM procurement.receiving_lines rl JOIN procurement.receiving_orders r ON r.id=rl.receiving_order_id
      WHERE rl.purchase_order_line_id=l.id) AS receipts,
    EXISTS(SELECT 1 FROM procurement.po_receipts r WHERE r.purchase_order_line_id=l.id) AS posted_receipt,
    EXISTS(SELECT 1 FROM inventory.inventory_lots i WHERE i.po_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.landed_cost_snapshots s WHERE s.purchase_order_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.landed_cost_adjustments a WHERE a.purchase_order_line_id=l.id) AS inventory
    FROM procurement.purchase_order_lines l WHERE l.id=ANY(${sql.param(lineIds)}::int[]) ORDER BY l.id`);
  const blocks: Record<number, string> = {};
  for (const row of result.rows) {
    const shipments = namedDocuments(row.shipments, "shipment"), receipts = namedDocuments(row.receipts, "receipt");
    const reasons = [
      shipments.length ? `This line is on shipment ${shipments.join(", ")}. Correct or remove it on the shipment before changing its product.` : null,
      receipts.length || row.posted_receipt === true ? `This line has receiving history${receipts.length ? ` (${receipts.join(", ")})` : ""}. Received goods keep the product they were received as; correct them from Receiving.` : null,
      row.inventory === true ? "This line has inventory or posted landed costs, which keep the product they were costed as." : null,
    ].filter((reason): reason is string => reason !== null);
    if (reasons.length) blocks[costInteger(row.id, "PO line", 1)] = reasons.join(" ");
  }
  return blocks;
}

async function readReceiveUnitLabels(tx: AmendmentTransaction, variantIds: number[]): Promise<Map<number, { sku: string | null; name: string | null }>> {
  if (!variantIds.length) return new Map();
  const result = await tx.execute(sql`SELECT id, sku, name FROM catalog.product_variants WHERE id=ANY(${sql.param(variantIds)}::int[]) ORDER BY id`);
  return new Map(result.rows.map((row) => [costInteger(row.id, "receive variant", 1),
    { sku: row.sku === null ? null : String(row.sku), name: row.name === null ? null : String(row.name) }]));
}

function identityView(line: Pick<AmendmentLine, "productId" | "sku" | "productName" | "lineNumber" | "expectedReceiveVariantId" | "expectedReceiveUnitsPerVariant" | "vendorProductId" | "vendorSku">,
  unit: { sku: string | null; name: string | null } | undefined): PoLineProductIdentity {
  return { productId: line.productId ?? null, sku: line.sku ?? null, name: line.productName || line.sku || `Line ${line.lineNumber}`,
    receiveVariantId: line.expectedReceiveVariantId ?? null, receiveVariantSku: unit?.sku ?? null, receiveVariantName: unit?.name ?? null,
    receiveUnitsPerVariant: line.expectedReceiveUnitsPerVariant ?? null, vendorProductId: line.vendorProductId ?? null, vendorSku: line.vendorSku ?? null };
}

/** Verifies each requested product, receiving unit and supplier item against the
 * locked catalog, exactly as line creation does. Prepares values only; the
 * amendment policy decides eligibility and the repository persists. */
export async function preparePoProductChanges(tx: AmendmentTransaction, header: AmendmentHeader, lines: AmendmentLine[], request: PoQuantityPreviewRequest): Promise<PreparedPoProductChange[]> {
  const changes = request.productChanges ?? [];
  if (!changes.length) return [];
  const prepared: PreparedPoProductChange[] = [];
  const changedLines = lines.filter((line) => changes.some((change) => change.lineId === line.id));
  const labels = await readReceiveUnitLabels(tx, [...new Set([...changes.map((change) => change.expectedReceiveVariantId),
    ...changedLines.flatMap((line) => line.expectedReceiveVariantId === null ? [] : [line.expectedReceiveVariantId])])].sort((a, b) => a - b));
  for (const change of changes) {
    const line = lines.find((candidate) => candidate.id === change.lineId);
    if (!line) throw new PoQuantityAmendmentError("The line to change does not belong to this PO.", "PO_AMENDMENT_LINE_NOT_FOUND", 404);
    try {
      const { values, context } = await preparePurchaseOrderLineIdentity(tx, header, change);
      const after = { ...values, vendorSku: change.vendorSku };
      prepared.push({ lineId: line.id, values: after,
        before: identityView(line, line.expectedReceiveVariantId === null ? undefined : labels.get(line.expectedReceiveVariantId)),
        after: identityView({ ...after, lineNumber: line.lineNumber }, labels.get(change.expectedReceiveVariantId)),
        sourceFingerprint: costFingerprint(context) });
    } catch (error) {
      if (error instanceof PurchaseOrderLineCommandError) throw new PoQuantityAmendmentError(error.message, String(error.details?.code ?? "PO_AMENDMENT_PRODUCT_CHANGE_INVALID"), error.statusCode);
      throw error;
    }
  }
  return prepared;
}

/** Never detach an actual receipt, invoice, movement or cost from its PO line.
 * Even voided/cancelled downstream records retain document provenance. */
export async function readPoLineRemovalBlocks(tx: AmendmentTransaction, lineIds: number[]): Promise<Record<number, string>> {
  if (!lineIds.length) return {};
  const result = await tx.execute(sql`SELECT l.id,
    EXISTS(SELECT 1 FROM procurement.inbound_shipment_lines s WHERE s.purchase_order_line_id=l.id) AS shipment,
    EXISTS(SELECT 1 FROM procurement.receiving_lines r WHERE r.purchase_order_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.po_receipts r WHERE r.purchase_order_line_id=l.id) AS receipt,
    EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines i WHERE i.purchase_order_line_id=l.id) AS invoice,
    EXISTS(SELECT 1 FROM inventory.inventory_lots i WHERE i.po_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.landed_cost_snapshots s WHERE s.purchase_order_line_id=l.id)
      OR EXISTS(SELECT 1 FROM procurement.landed_cost_adjustments a WHERE a.purchase_order_line_id=l.id) AS inventory
    FROM procurement.purchase_order_lines l WHERE l.id=ANY(${sql.param(lineIds)}::int[]) ORDER BY l.id`);
  const blocks: Record<number, string> = {};
  for (const row of result.rows) {
    const dependencies = [row.shipment && "shipment lines", row.receipt && "receipts", row.invoice && "invoices", row.inventory && "inventory or posted costs"].filter(Boolean);
    if (dependencies.length) blocks[costInteger(row.id, "PO line", 1)] = `This line is linked to ${dependencies.join(", ")} and must retain that history. Correct its values here or reverse the actual transaction from its linked document.`;
  }
  return blocks;
}

export async function preparePoAdditions(tx: AmendmentTransaction, header: AmendmentHeader, firstLineNumber: number, request: PoQuantityPreviewRequest): Promise<PreparedPoAddition[]> {
  const prepared: PreparedPoAddition[] = [];
  for (const addition of request.additions ?? []) {
    try {
      const { clientKey, discountCents, taxCents, ...input } = addition;
      const source = await preparePurchaseOrderLine(tx, header, firstLineNumber + prepared.length, { ...input, pricingSource: "manual" });
      // Approval supplies its injected timestamp; the draft owner uses SQL time.
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...preparedValues } = source.values;
      const values = { ...preparedValues, discountCents, taxCents,
        lineTotalCents: poLineAmountCents(source.values.totalProductCostCents, addition.packagingCostCents, discountCents, taxCents) };
      prepared.push({ values, review: {
        clientKey, lineNumber: values.lineNumber, productId: addition.productId,
        name: values.productName, sku: values.sku, expectedReceiveVariantId: addition.expectedReceiveVariantId,
        expectedReceiveUnitsPerVariant: addition.expectedReceiveUnitsPerVariant, orderQty: values.orderQty,
        unitCostMills: values.unitCostMills, totalProductCostCents: values.totalProductCostCents,
        packagingCostCents: values.packagingCostCents, discountCents, taxCents, lineTotalCents: values.lineTotalCents,
        sourceFingerprint: costFingerprint(source.context),
      } });
    } catch (error) {
      if (error instanceof PurchaseOrderLineCommandError) throw new PoQuantityAmendmentError(error.message, String(error.details?.code ?? "PO_AMENDMENT_ADDITION_INVALID"), error.statusCode);
      throw error;
    }
  }
  return prepared;
}
