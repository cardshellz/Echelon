import { sql, type SQL } from "drizzle-orm";
import { buildPoShipmentCostSummary } from "./domain/po-shipment-cost-summary";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import type { PoShipmentCostSummary } from "@shared/procurement/po-shipment-cost-summary";
import { resolveShipmentChargeEvidence } from "./domain/shipment-charge-evidence";

type SummaryReader = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};
export interface PoShipmentCostSummaryDatabase extends SummaryReader {
  transaction<T>(
    fn: (tx: SummaryReader) => Promise<T>,
    options: { isolationLevel: "repeatable read"; accessMode: "read only" },
  ): Promise<T>;
}

export async function readPoShipmentCostSummary(
  db: PoShipmentCostSummaryDatabase,
  poId: number,
): Promise<PoShipmentCostSummary | null> {
  costInteger(poId, "poId", 1);
  return db.transaction(
    async (tx) => {
      const header = await tx.execute(
        sql`SELECT currency,total_cents FROM procurement.purchase_orders WHERE id=${poId}`,
      );
      if (!header.rows[0]) return null;
      const linked =
        await tx.execute(sql`SELECT line.id,line.inbound_shipment_id,line.qty_shipped
      FROM procurement.inbound_shipment_lines line JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id
      WHERE line.purchase_order_id=${poId} AND shipment.status<>'cancelled' ORDER BY line.id`);
      const shipmentIds = [
        ...new Set(
          linked.rows.map((row) =>
            costInteger(row.inbound_shipment_id, "shipmentId", 1),
          ),
        ),
      ];
      const currency = String(header.rows[0].currency);
      const poAmountCents = costInteger(
        header.rows[0].total_cents ?? 0,
        "poAmountCents",
        -Number.MAX_SAFE_INTEGER,
      );
      if (shipmentIds.length === 0)
        return buildPoShipmentCostSummary({
          poId,
          currency,
          poAmountCents,
          shipmentIds,
          charges: [],
          allocations: [],
          lines: [],
        });
      const charges =
        await tx.execute(sql`SELECT cost.id,cost.inbound_shipment_id,cost.cost_type,cost.currency,cost.actual_cents,cost.estimated_cents,
      cost.vendor_id,cost.vendor_invoice_id,cost.allocation_method,
      cost.cost_status,invoice.status AS invoice_status FROM procurement.inbound_freight_costs cost
      LEFT JOIN procurement.vendor_invoices invoice ON invoice.id=cost.vendor_invoice_id
      WHERE cost.inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb)) ORDER BY cost.id`);
      const invoices = await tx.execute(sql`WITH selected AS (
      SELECT vendor_invoice_id AS id FROM procurement.inbound_freight_costs
      WHERE inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb)) AND vendor_invoice_id IS NOT NULL
      UNION SELECT invoice_line.vendor_invoice_id FROM procurement.vendor_invoice_lines invoice_line
      JOIN procurement.inbound_freight_costs cost ON cost.id=invoice_line.freight_cost_id
      WHERE cost.inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb))
    ) SELECT line.id,invoice.id AS invoice_id,line.freight_cost_id,invoice.vendor_id,invoice.inbound_shipment_id,
      invoice.currency,invoice.status,invoice.invoiced_amount_cents,line.qty_invoiced,line.unit_cost_mills,line.unit_cost_cents,line.line_total_cents,
      SUM(line.line_total_cents) OVER (PARTITION BY invoice.id)::text AS document_total
      FROM selected JOIN procurement.vendor_invoices invoice ON invoice.id=selected.id
      LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id ORDER BY invoice.id,line.id`);
      const invoiceEvidence = invoices.rows.map((row) => ({
        id: row.id,
        invoiceId: row.invoice_id,
        freightCostId: row.freight_cost_id,
        vendorId: row.vendor_id,
        shipmentId: row.inbound_shipment_id,
        currency: row.currency,
        status: row.status,
        invoiceTotalCents: row.invoiced_amount_cents,
        documentLinesTotalCents: row.document_total,
        quantity: row.qty_invoiced,
        unitCostMills: row.unit_cost_mills,
        unitCostCents: row.unit_cost_cents,
        lineTotalCents: row.line_total_cents,
      }));
      const allocations =
        await tx.execute(sql`SELECT allocation.shipment_cost_id,allocation.inbound_shipment_line_id,allocation.allocated_cents,line.purchase_order_id
      FROM procurement.inbound_freight_allocations allocation JOIN procurement.inbound_freight_costs cost ON cost.id=allocation.shipment_cost_id
      JOIN procurement.inbound_shipment_lines line ON line.id=allocation.inbound_shipment_line_id
      WHERE cost.inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb)) ORDER BY allocation.id`);
      const readiness =
        await tx.execute(sql`SELECT line.id,line.qty_shipped,revision.contract,application.status
      FROM procurement.inbound_shipment_lines line
      LEFT JOIN LATERAL (SELECT contract,id FROM procurement.cost_source_revisions revision WHERE revision.inbound_shipment_line_id=line.id
        AND component='landed' ORDER BY revision.revision DESC,revision.id DESC LIMIT 1) revision ON true
      LEFT JOIN LATERAL (SELECT status FROM inventory.cost_applications application WHERE application.source_revision_id=revision.id
        ORDER BY application.id DESC LIMIT 1) application ON true
      WHERE line.id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(linked.rows.map((row) => Number(row.id)))}::jsonb)) ORDER BY line.id`);
      const signed = (value: unknown, label: string) =>
        costInteger(value, label, -Number.MAX_SAFE_INTEGER);
      return buildPoShipmentCostSummary({
        poId,
        currency,
        poAmountCents,
        shipmentIds,
        charges: charges.rows.map((row) => {
          const authority = resolveShipmentChargeEvidence({
            charge: {
              id: row.id,
              shipmentId: row.inbound_shipment_id,
              vendorId: row.vendor_id,
              invoiceId: row.vendor_invoice_id,
              costType: row.cost_type,
              allocationMethod: row.allocation_method,
              currency: row.currency,
              actualCents: row.actual_cents,
              estimatedCents: row.estimated_cents,
              status: row.cost_status,
            },
            invoices: invoiceEvidence,
            priorConfirmedCharge: null,
          });
          return {
            id: costInteger(row.id, "cost.id", 1),
            shipmentId: costInteger(row.inbound_shipment_id, "shipmentId", 1),
            costType: String(row.cost_type),
            currency: row.currency == null ? null : String(row.currency),
            amountCents:
              row.actual_cents == null && row.estimated_cents == null
                ? null
                : signed(
                    row.actual_cents ?? row.estimated_cents,
                    "charge.amountCents",
                  ),
            confirmed: authority.evidence === "confirmed",
            issue: authority.issue?.code ?? null,
          };
        }),
        allocations: allocations.rows.map((row) => ({
          costId: costInteger(row.shipment_cost_id, "costId", 1),
          poId:
            row.purchase_order_id == null
              ? 0
              : costInteger(row.purchase_order_id, "allocatedPoId", 1),
          lineId: costInteger(
            row.inbound_shipment_line_id,
            "shipmentLineId",
            1,
          ),
          allocatedCents: signed(row.allocated_cents ?? 0, "allocatedCents"),
        })),
        lines: readiness.rows.map((row) => {
          const contract = row.contract as Record<string, unknown> | null;
          return {
            id: costInteger(row.id, "shipmentLineId", 1),
            quantity: costInteger(row.qty_shipped, "qtyShipped", 1),
            sourceTotalMills:
              contract?.totalMills == null
                ? null
                : signed(contract.totalMills, "sourceTotalMills"),
            sourceQuantity:
              contract?.basePieces == null
                ? null
                : costInteger(contract.basePieces, "sourceQuantity", 1),
            evidence:
              contract?.evidence == null ? null : String(contract.evidence),
            applicationStatus: row.status == null ? null : String(row.status),
            issue:
              contract?.issue == null
                ? null
                : String((contract.issue as { code: unknown }).code),
          };
        }),
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
