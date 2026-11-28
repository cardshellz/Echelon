import { sql } from "drizzle-orm";
import {
  poLandedCostRecordSchema,
  type PoLandedCostCreateInput,
  type PoLandedCostPatchInput,
  type PoLandedCostRecord,
} from "@shared/procurement/po-landed-cost";
import {
  costInteger,
  type CostEvidenceTransaction,
} from "../../inventory/cost-evidence.repository.api";
import type { PoLandedProductLineInput } from "../domain/po-landed-cost-allocation";

function toIsoString(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string" && val.trim()) return new Date(val).toISOString();
  return new Date(0).toISOString();
}

function toNullableIsoString(val: unknown): string | null {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string" && val.trim()) return new Date(val).toISOString();
  return null;
}

export async function hasPoLandedCostsTable(tx: CostEvidenceTransaction): Promise<boolean> {
  const res = await tx.execute(sql`SELECT to_regclass('procurement.po_landed_costs') AS rel`);
  return Boolean(res.rows?.[0]?.rel);
}

export async function lockPurchaseOrderForLandedCosts(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
): Promise<{ id: number; currency: string; status: string } | null> {
  const res = await tx.execute(sql`
    SELECT id, currency, status
    FROM procurement.purchase_orders
    WHERE id = ${purchaseOrderId}
    FOR UPDATE
  `);
  const row = res.rows?.[0];
  if (!row) return null;
  return {
    id: costInteger(row.id, "po.id", 1),
    currency: String(row.currency ?? "USD"),
    status: String(row.status ?? "draft"),
  };
}

export async function readPurchaseOrderHeaderForLandedCosts(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
): Promise<{ id: number; currency: string; status: string } | null> {
  const res = await tx.execute(sql`
    SELECT id, currency, status
    FROM procurement.purchase_orders
    WHERE id = ${purchaseOrderId}
  `);
  const row = res.rows?.[0];
  if (!row) return null;
  return {
    id: costInteger(row.id, "po.id", 1),
    currency: String(row.currency ?? "USD"),
    status: String(row.status ?? "draft"),
  };
}

export async function hasActiveInboundShipmentForPo(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
): Promise<{ hasShipment: boolean; firstShipmentId: number | null; firstShipmentNumber: string | null }> {
  const res = await tx.execute(sql`
    SELECT s.id, s.shipment_number
    FROM procurement.inbound_shipment_lines sl
    JOIN procurement.inbound_shipments s ON s.id = sl.inbound_shipment_id
    WHERE sl.purchase_order_id = ${purchaseOrderId}
      AND s.status <> 'cancelled'
    ORDER BY s.id ASC
    LIMIT 1
  `);
  const row = res.rows?.[0];
  if (!row) return { hasShipment: false, firstShipmentId: null, firstShipmentNumber: null };
  return {
    hasShipment: true,
    firstShipmentId: costInteger(row.id, "shipment.id", 1),
    firstShipmentNumber: row.shipment_number == null ? null : String(row.shipment_number),
  };
}

export async function readPoProductLinesForLandedCosts(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
): Promise<PoLandedProductLineInput[]> {
  const res = await tx.execute(sql`
    SELECT
      line.id,
      line.purchase_order_id,
      line.sku,
      line.product_name,
      line.order_qty,
      COALESCE(line.received_qty, 0) AS received_qty,
      line.status,
      COALESCE(line.total_product_cost_cents, 0) AS total_product_cost_cents,
      po.currency
    FROM procurement.purchase_order_lines line
    JOIN procurement.purchase_orders po ON po.id = line.purchase_order_id
    WHERE line.purchase_order_id = ${purchaseOrderId}
      AND COALESCE(line.line_type, 'product') = 'product'
      AND COALESCE(line.status, 'open') <> 'cancelled'
    ORDER BY line.id ASC
  `);

  return res.rows.map((row) => ({
    id: costInteger(row.id, "poLine.id", 1),
    purchaseOrderId: costInteger(row.purchase_order_id, "poLine.purchaseOrderId", 1),
    sku: row.sku == null ? null : String(row.sku),
    productName: row.product_name == null ? null : String(row.product_name),
    orderQty: costInteger(row.order_qty, "poLine.orderQty", 1),
    receivedQty: costInteger(row.received_qty ?? 0, "poLine.receivedQty", 0),
    status: String(row.status ?? "open"),
    totalProductCostCents: costInteger(row.total_product_cost_cents ?? 0, "poLine.totalProductCostCents", 0),
    currency: String(row.currency ?? "USD"),
  }));
}

function parsePoLandedCostRow(row: Record<string, unknown>): PoLandedCostRecord {
  return poLandedCostRecordSchema.parse({
    id: costInteger(row.id, "poLandedCost.id", 1),
    purchaseOrderId: costInteger(row.purchase_order_id, "poLandedCost.purchaseOrderId", 1),
    costType: String(row.cost_type),
    description: row.description == null ? null : String(row.description),
    amountCents: costInteger(row.amount_cents, "poLandedCost.amountCents", 0),
    currency: String(row.currency ?? "USD"),
    allocationMethod: String(row.allocation_method ?? "by_value"),
    vendorId: row.vendor_id == null ? null : costInteger(row.vendor_id, "poLandedCost.vendorId", 1),
    vendorName: row.vendor_name == null ? null : String(row.vendor_name),
    vendorInvoiceId: row.vendor_invoice_id == null ? null : costInteger(row.vendor_invoice_id, "poLandedCost.vendorInvoiceId", 1),
    invoiceNumber: row.invoice_number == null ? null : String(row.invoice_number),
    costDate: toNullableIsoString(row.cost_date),
    notes: row.notes == null ? null : String(row.notes),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

export async function readPoLandedCostRecords(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
): Promise<PoLandedCostRecord[]> {
  if (!(await hasPoLandedCostsTable(tx))) return [];
  const res = await tx.execute(sql`
    SELECT
      c.*,
      v.name AS vendor_name
    FROM procurement.po_landed_costs c
    LEFT JOIN procurement.vendors v ON v.id = c.vendor_id
    WHERE c.purchase_order_id = ${purchaseOrderId}
    ORDER BY c.id ASC
  `);
  return res.rows.map((row) => parsePoLandedCostRow(row));
}

export async function readPoIdForPurchaseOrderLine(
  tx: CostEvidenceTransaction,
  purchaseOrderLineId: number,
): Promise<number | null> {
  const res = await tx.execute(sql`
    SELECT purchase_order_id
    FROM procurement.purchase_order_lines
    WHERE id = ${purchaseOrderLineId}
  `);
  const row = res.rows?.[0];
  if (!row || row.purchase_order_id == null) return null;
  return costInteger(row.purchase_order_id, "purchaseOrderId", 1);
}

export async function insertPoLandedCostRecord(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
  input: PoLandedCostCreateInput,
  actorId: string,
  now: Date,
): Promise<PoLandedCostRecord> {
  const costDate = input.costDate ? new Date(input.costDate) : null;
  const inserted = await tx.execute(sql`
    INSERT INTO procurement.po_landed_costs (
      purchase_order_id,
      cost_type,
      description,
      amount_cents,
      currency,
      allocation_method,
      vendor_id,
      invoice_number,
      cost_date,
      notes,
      created_by,
      created_at,
      updated_at
    ) VALUES (
      ${purchaseOrderId},
      ${input.costType},
      ${input.description ?? null},
      ${input.amountCents},
      ${input.currency},
      ${input.allocationMethod},
      ${input.vendorId ?? null},
      ${input.invoiceNumber ?? null},
      ${costDate},
      ${input.notes ?? null},
      ${actorId},
      ${now},
      ${now}
    )
    RETURNING id
  `);
  const id = costInteger(inserted.rows?.[0]?.id, "inserted.id", 1);
  const rows = await readPoLandedCostRecords(tx, purchaseOrderId);
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error("Inserted PO landed cost record could not be reloaded.");
  return found;
}

export async function updatePoLandedCostRecord(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
  chargeId: number,
  patch: PoLandedCostPatchInput,
  now: Date,
): Promise<PoLandedCostRecord | null> {
  const existingRows = await readPoLandedCostRecords(tx, purchaseOrderId);
  const current = existingRows.find((r) => r.id === chargeId);
  if (!current) return null;

  const nextCostType = patch.costType ?? current.costType;
  const nextDescription = patch.description !== undefined ? patch.description : current.description;
  const nextAmountCents = patch.amountCents ?? current.amountCents;
  const nextAllocationMethod = patch.allocationMethod ?? current.allocationMethod;
  const nextVendorId = patch.vendorId !== undefined ? patch.vendorId : current.vendorId;
  const nextInvoiceNumber = patch.invoiceNumber !== undefined ? patch.invoiceNumber : current.invoiceNumber;
  const nextCostDate =
    patch.costDate !== undefined
      ? patch.costDate === null
        ? null
        : new Date(patch.costDate)
      : current.costDate
        ? new Date(current.costDate)
        : null;
  const nextNotes = patch.notes !== undefined ? patch.notes : current.notes;

  await tx.execute(sql`
    UPDATE procurement.po_landed_costs
    SET
      cost_type = ${nextCostType},
      description = ${nextDescription},
      amount_cents = ${nextAmountCents},
      allocation_method = ${nextAllocationMethod},
      vendor_id = ${nextVendorId},
      invoice_number = ${nextInvoiceNumber},
      cost_date = ${nextCostDate},
      notes = ${nextNotes},
      updated_at = ${now}
    WHERE id = ${chargeId}
      AND purchase_order_id = ${purchaseOrderId}
  `);

  const updatedRows = await readPoLandedCostRecords(tx, purchaseOrderId);
  return updatedRows.find((r) => r.id === chargeId) ?? null;
}

export async function deletePoLandedCostRecord(
  tx: CostEvidenceTransaction,
  purchaseOrderId: number,
  chargeId: number,
): Promise<boolean> {
  const res = await tx.execute(sql`
    DELETE FROM procurement.po_landed_costs
    WHERE id = ${chargeId}
      AND purchase_order_id = ${purchaseOrderId}
    RETURNING id
  `);
  return (res.rows?.length ?? 0) > 0;
}

export async function readPoLandedRevisionsReadiness(
  tx: CostEvidenceTransaction,
  purchaseOrderLineIds: readonly number[],
): Promise<
  Map<
    number,
    {
      contract: Record<string, unknown> | null;
      applicationStatus: string | null;
      applicationId: number | null;
      recordedAt: string | null;
      applicationIssues: unknown;
    }
  >
> {
  const out = new Map<
    number,
    {
      contract: Record<string, unknown> | null;
      applicationStatus: string | null;
      applicationId: number | null;
      recordedAt: string | null;
      applicationIssues: unknown;
    }
  >();
  if (purchaseOrderLineIds.length === 0) return out;
  const res = await tx.execute(sql`
    SELECT
      line.id,
      revision.contract,
      application.status,
      application.id AS application_id,
      application.recorded_at,
      application.evidence->'result'->'issues' AS application_issues
    FROM procurement.purchase_order_lines line
    LEFT JOIN LATERAL (
      SELECT contract, id
      FROM procurement.cost_source_revisions rev
      WHERE rev.purchase_order_line_id = line.id
        AND rev.inbound_shipment_line_id IS NULL
        AND rev.component = 'landed'
      ORDER BY rev.revision DESC, rev.id DESC
      LIMIT 1
    ) revision ON true
    LEFT JOIN LATERAL (
      SELECT id, status, recorded_at, evidence
      FROM inventory.cost_applications app
      WHERE app.source_revision_id = revision.id
      ORDER BY app.id DESC
      LIMIT 1
    ) application ON true
    WHERE line.id = ANY(${sql.param([...purchaseOrderLineIds])}::int[])
    ORDER BY line.id ASC
  `);

  for (const row of res.rows) {
    const lineId = costInteger(row.id, "poLine.id", 1);
    out.set(lineId, {
      contract: (row.contract as Record<string, unknown> | null) ?? null,
      applicationStatus: row.status == null ? null : String(row.status),
      applicationId: row.application_id == null ? null : costInteger(row.application_id, "applicationId", 1),
      recordedAt: toNullableIsoString(row.recorded_at),
      applicationIssues: row.application_issues ?? null,
    });
  }
  return out;
}
