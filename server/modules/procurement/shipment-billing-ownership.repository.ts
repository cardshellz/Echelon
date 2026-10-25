import { sql } from "drizzle-orm";
import { invoiceSourceCapabilitiesSchema, type InvoiceSourceCapabilities, type ShipmentCostBillingOwnership } from "@shared/procurement/shipment-billing-ownership";
import { resolveShipmentBillingOwnership, type BillingCostEvidence, type BillingInvoiceEvidence, type BillingLineEvidence } from "./domain/shipment-billing-ownership";
import type { ApLedgerDbClient } from "./ap-ledger.service";

export type BillingCostRow = { id: number; inboundShipmentId: number; vendorId: number | null; vendorInvoiceId: number | null; currency: string | null; actualCents?: number | string | null; estimatedCents?: number | string | null };
// Raw PostgreSQL bigint reads are strings, while Drizzle reads are numbers.
// Invalid amounts remain invalid evidence rather than being rounded or defaulted.
function billingAmount(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const amount = BigInt(value);
    if (amount >= BigInt(Number.MIN_SAFE_INTEGER) && amount <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(amount);
  }
  return Number.NaN;
}

type BillingOwnershipRow = { lineId: number | null; invoiceId: number; freightCostId: number; purchaseOrderLineId: number | null;
  productVariantId: number | null; headerId: number; vendorId: number; shipmentId: number | null; currency: string;
  status: string; invoiceNumber: string; replacesInvoiceId: number | null; hasProductSources: boolean };

/** Read all candidate owners, including orphan source lines and voided history.
 * Mutation callers already hold the cost graph lock; read callers use their
 * existing transaction snapshot. Never choose only the header pointer. */
export async function readShipmentBillingOwnership(client: ApLedgerDbClient, costs: readonly BillingCostRow[]): Promise<Map<number, ShipmentCostBillingOwnership>> {
  if (costs.length === 0) return new Map();
  const costIds = costs.map(cost => cost.id);
  const pointerIds = [...new Set(costs.flatMap(cost => cost.vendorInvoiceId === null ? [] : [cost.vendorInvoiceId]))];
  const result = await client.execute(sql`
    SELECT line.id AS "lineId",line.vendor_invoice_id AS "invoiceId",line.freight_cost_id AS "freightCostId",
      line.purchase_order_line_id AS "purchaseOrderLineId",line.product_variant_id AS "productVariantId",
      invoice.id AS "headerId",invoice.vendor_id AS "vendorId",invoice.inbound_shipment_id AS "shipmentId",
      invoice.currency,invoice.status,invoice.invoice_number AS "invoiceNumber",invoice.replaces_invoice_id AS "replacesInvoiceId",
      EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines product_source WHERE product_source.vendor_invoice_id=invoice.id
        AND (product_source.purchase_order_line_id IS NOT NULL OR product_source.product_variant_id IS NOT NULL)) AS "hasProductSources"
    FROM procurement.vendor_invoices invoice
    LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
      AND line.freight_cost_id=ANY(${sql.param(costIds)}::int[])
    WHERE invoice.id=ANY(${sql.param(pointerIds)}::int[])
      OR EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines source WHERE source.vendor_invoice_id=invoice.id
        AND source.freight_cost_id=ANY(${sql.param(costIds)}::int[]))
    ORDER BY invoice.id,line.id
  `);
  const invoices = new Map<number, BillingInvoiceEvidence>();
  const lines: BillingLineEvidence[] = [];
  for (const row of result.rows as unknown as BillingOwnershipRow[]) {
    invoices.set(row.headerId, { id: row.headerId, vendorId: row.vendorId, shipmentId: row.shipmentId,
      currency: row.currency, status: row.status, invoiceNumber: row.invoiceNumber, replacesInvoiceId: row.replacesInvoiceId, hasProductSources: row.hasProductSources });
    if (row.lineId !== null) lines.push({ id: row.lineId, invoiceId: row.invoiceId, freightCostId: row.freightCostId,
      purchaseOrderLineId: row.purchaseOrderLineId, productVariantId: row.productVariantId });
  }
  return new Map(costs.map(cost => {
    const evidence: BillingCostEvidence = { id: cost.id, shipmentId: cost.inboundShipmentId,
      vendorId: cost.vendorId, invoiceId: cost.vendorInvoiceId, currency: cost.currency,amountCents: billingAmount(cost.actualCents ?? cost.estimatedCents) };
    return [cost.id, resolveShipmentBillingOwnership({ cost: evidence, invoices: [...invoices.values()], lines })];
  }));
}

export async function readInvoiceSourceCapabilities(client: ApLedgerDbClient, invoiceId: number): Promise<InvoiceSourceCapabilities> {
  const result = await client.execute(sql`
    SELECT cost.id,cost.inbound_shipment_id AS "inboundShipmentId",cost.vendor_id AS "vendorId",
      cost.vendor_invoice_id AS "vendorInvoiceId",cost.currency
    FROM procurement.inbound_freight_costs cost
    WHERE cost.vendor_invoice_id=${invoiceId} OR EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines line
      WHERE line.vendor_invoice_id=${invoiceId} AND line.freight_cost_id=cost.id)
    ORDER BY cost.id
  `);
  const footprint = await client.execute(sql`
    SELECT invoice.inbound_shipment_id AS "shipmentId",line.id AS "lineId",line.freight_cost_id AS "freightCostId",
      line.purchase_order_line_id AS "purchaseOrderLineId",line.product_variant_id AS "productVariantId"
    FROM procurement.vendor_invoices invoice LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
    WHERE invoice.id=${invoiceId} ORDER BY line.id
  `);
  const rows = footprint.rows as Array<{ shipmentId: number | null; lineId: number | null; freightCostId: number | null; purchaseOrderLineId: number | null; productVariantId: number | null }>;
  const freightSourceLineIds = rows.filter(row => row.freightCostId !== null && row.lineId !== null).map(row => row.lineId!);
  const costs = result.rows as BillingCostRow[];
  const ownership = await readShipmentBillingOwnership(client, costs);
  const shipmentOwned = costs.length > 0 || freightSourceLineIds.length > 0 || rows.some(row => row.shipmentId !== null);
  const mixedProductSources = shipmentOwned && rows.some(row => row.purchaseOrderLineId !== null || row.productVariantId !== null);
  const sourceValid = rows.length > 0 && !mixedProductSources && (!shipmentOwned || (costs.length > 0 && freightSourceLineIds.length > 0
    && costs.every(cost => { const owner = ownership.get(cost.id)!; return owner.state === "billed" && owner.activeInvoiceId === invoiceId; })));
  const allowed = { allowed: true, code: "AP_INVOICE_SOURCE_VERIFIED", reason: "Invoice source ownership is consistent." };
  const review = { allowed: false, code: "AP_INVOICE_BILLING_REVIEW_REQUIRED", reason: "Shipment charge ownership is incomplete or conflicting. Review its invoice source lines before approval or payment." };
  return invoiceSourceCapabilitiesSchema.parse({ purchaseOrderLinks: shipmentOwned
    ? { allowed: false, code: "AP_INVOICE_SHIPMENT_SOURCE_OWNED", reason: "Shipment invoice ownership comes from its charge lines. Purchase-order links cannot change that financial source." }
    : rows.length ? allowed : review,
    approval: sourceValid ? allowed : review, payment: sourceValid ? allowed : review, freightSourceLineIds });
}