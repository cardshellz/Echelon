import { sql, type SQL } from "drizzle-orm";
import { buildPoShipmentCosts } from "./domain/po-shipment-cost-summary";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import type { PoShipmentCostSummary } from "@shared/procurement/po-shipment-cost-summary";
import type { PoShipmentCosts } from "@shared/procurement/po-shipment-costs";
import { resolveShipmentChargeEvidence } from "./domain/shipment-charge-evidence";
import { dateValues } from "./purchase-workspace-read";
import { readShipmentCostPostingEvidence } from "./shipment-cost-posting-read.repository";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
import { readSupplierCreditCostRows } from "./supplier-credit-source.repository";
import { resolveShipmentSupplierCredits } from "./domain/shipment-supplier-credits";
import { isUnresolvedPhysicalAllocation } from "@shared/procurement/shipment-allocation";
import { readPurchaseTaxCosts } from "./purchase-tax-costs.repository";
import { readIntegerCents } from "@shared/money-read";
import { attachSupplierHeaderInvoiceEvidence } from "./supplier-header-invoice-evidence";
import { attachSupplierInvoiceTaxEvidence } from "./supplier-invoice-tax-evidence";
import { shipmentHeaderExclusions } from "./domain/shipment-header-exclusions";

type SummaryReader = {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
};
export interface PoShipmentCostSummaryDatabase extends SummaryReader {
  transaction<T>(
    fn: (tx: SummaryReader) => Promise<T>,
    options: { isolationLevel: "repeatable read"; accessMode: "read only" },
  ): Promise<T>;
}

export async function readPoShipmentCosts(
  db: PoShipmentCostSummaryDatabase,
  poId: number,
): Promise<PoShipmentCosts | null> {
  costInteger(poId, "poId", 1);
  return db.transaction(
    async (tx) => {
      const header = await tx.execute(
        sql`SELECT currency,total_cents,shipping_cost_cents,tax_cents,
          (tax_type_id IS NOT NULL OR COALESCE(tax_cents,0)<>0 OR COALESCE(po.discount_cents,0)<>0 OR COALESCE(po.shipping_cost_cents,0)<>0
            OR EXISTS(SELECT 1 FROM procurement.supplier_header_cost_reviews review WHERE review.purchase_order_id=po.id)
            OR EXISTS(SELECT 1 FROM procurement.supplier_header_cost_reviews review JOIN procurement.vendor_invoice_lines invoice_line ON invoice_line.vendor_invoice_id=review.vendor_invoice_id
              JOIN procurement.inbound_freight_costs charge ON charge.id=invoice_line.freight_cost_id
              JOIN procurement.inbound_shipment_lines shipment_line ON shipment_line.inbound_shipment_id=charge.inbound_shipment_id WHERE shipment_line.purchase_order_id=po.id)
            OR EXISTS(SELECT 1 FROM procurement.vendor_invoice_lines line JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
              JOIN procurement.purchase_order_lines product ON product.id=line.purchase_order_line_id WHERE product.purchase_order_id=po.id AND invoice.status IN ('approved','partially_paid','paid'))
            OR EXISTS(SELECT 1 FROM procurement.purchase_order_lines line WHERE line.purchase_order_id=po.id
              AND line.status<>'cancelled' AND (line.tax_type_id IS NOT NULL OR COALESCE(line.tax_cents,0)<>0 OR line.line_type='tax'))
            OR EXISTS(SELECT 1 FROM procurement.vendor_invoice_line_taxes tax JOIN procurement.vendor_invoice_lines line ON line.id=tax.vendor_invoice_line_id
              JOIN procurement.purchase_order_lines po_line ON po_line.id=line.purchase_order_line_id WHERE po_line.purchase_order_id=po.id)
            OR EXISTS(SELECT 1 FROM procurement.inbound_freight_costs cost JOIN procurement.inbound_shipment_lines line ON line.inbound_shipment_id=cost.inbound_shipment_id
              WHERE line.purchase_order_id=po.id AND cost.tax_type_id IS NOT NULL)) AS tax_active
          FROM procurement.purchase_orders po WHERE id=${poId}`,
      );
      if (!header.rows[0]) return null;
      const linked =
        await tx.execute(sql`SELECT line.id,line.inbound_shipment_id,line.purchase_order_line_id,line.qty_shipped,line.sku,
          shipment.shipment_number,shipment.status AS shipment_status
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
      const supplier = {
        freightCents: costInteger(
          header.rows[0].shipping_cost_cents ?? 0,
          "supplierFreightCents",
          -Number.MAX_SAFE_INTEGER,
        ),
        dutyCents: costInteger(
          header.rows[0].tax_cents ?? 0,
          "supplierDutyCents",
          -Number.MAX_SAFE_INTEGER,
        ),
      };
      if (shipmentIds.length === 0) {
        const costs = buildPoShipmentCosts(
          {
            poId,
            currency,
            poAmountCents,
            shipmentIds,
            charges: [],
            allocations: [],
            lines: [],
          },
          supplier,
          [],
        );
        return { ...costs, ...(header.rows[0].tax_active === true ? { taxCosts: await readPurchaseTaxCosts(tx, poId,
          { lines: [], recoverableByShipmentLine: new Map(), complete: true }) } : {}) };
      }
      const charges =
        await tx.execute(sql`SELECT cost.id,cost.inbound_shipment_id,cost.cost_type,cost.currency,cost.actual_cents,cost.estimated_cents,
      cost.vendor_id,cost.vendor_invoice_id,cost.allocation_method,
      cost.cost_status,invoice.status AS invoice_status,kind.treatment AS tax_treatment FROM procurement.inbound_freight_costs cost
      LEFT JOIN procurement.vendor_invoices invoice ON invoice.id=cost.vendor_invoice_id
      LEFT JOIN procurement.purchase_tax_types kind ON kind.id=cost.tax_type_id
      WHERE cost.inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb)) ORDER BY cost.id`);
      const invoices = await tx.execute(sql`WITH selected AS (
      SELECT vendor_invoice_id AS id FROM procurement.inbound_freight_costs
      WHERE inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb)) AND vendor_invoice_id IS NOT NULL
      UNION SELECT invoice_line.vendor_invoice_id FROM procurement.vendor_invoice_lines invoice_line
      JOIN procurement.inbound_freight_costs cost ON cost.id=invoice_line.freight_cost_id
      WHERE cost.inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb))
    ) SELECT line.id,invoice.id AS invoice_id,line.freight_cost_id,line.purchase_order_line_id,line.product_variant_id,invoice.vendor_id,invoice.inbound_shipment_id,
      invoice.currency,invoice.status,invoice.invoiced_amount_cents,invoice.invoice_number,invoice.replaces_invoice_id,line.qty_invoiced,line.unit_cost_mills,line.unit_cost_cents,line.line_total_cents,
      SUM(line.line_total_cents) OVER (PARTITION BY invoice.id)::text AS document_total
      FROM selected JOIN procurement.vendor_invoices invoice ON invoice.id=selected.id
      LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id ORDER BY invoice.id,line.id`);
      invoices.rows = await attachSupplierHeaderInvoiceEvidence(tx, await attachSupplierInvoiceTaxEvidence(tx, invoices.rows.map(row => ({ ...row, vendor_invoice_id: row.invoice_id }))));
      const invoiceEvidence = invoices.rows.map((row) => ({
        id: row.id,
        invoiceId: row.invoice_id,
        invoiceNumber: row.invoice_number ?? null,
        replacesInvoiceId: row.replaces_invoice_id ?? null,
        freightCostId: row.freight_cost_id,
        purchaseOrderLineId: row.purchase_order_line_id, productVariantId: row.product_variant_id,
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
        ...(row.header_authority ? { headerAuthority: row.header_authority, headerShares: row.header_cost_evidence } : {}),
      }));
      const allocations =
        await tx.execute(sql`SELECT allocation.shipment_cost_id,allocation.inbound_shipment_line_id,allocation.allocated_cents,allocation.basis_evidence,line.purchase_order_id
      FROM procurement.inbound_freight_allocations allocation JOIN procurement.inbound_freight_costs cost ON cost.id=allocation.shipment_cost_id
      JOIN procurement.inbound_shipment_lines line ON line.id=allocation.inbound_shipment_line_id
      WHERE cost.inbound_shipment_id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(shipmentIds)}::jsonb)) ORDER BY allocation.id`);
      const readiness =
        await tx.execute(sql`SELECT line.id,line.qty_shipped,revision.contract,application.status,
          application.id AS application_id,application.recorded_at,
          application.evidence->'result'->'issues' AS application_issues
      FROM procurement.inbound_shipment_lines line
      LEFT JOIN LATERAL (SELECT contract,id FROM procurement.cost_source_revisions revision WHERE revision.inbound_shipment_line_id=line.id
        AND component='landed' ORDER BY revision.revision DESC,revision.id DESC LIMIT 1) revision ON true
      LEFT JOIN LATERAL (SELECT id,status,recorded_at,evidence FROM inventory.cost_applications application WHERE application.source_revision_id=revision.id
        ORDER BY application.id DESC LIMIT 1) application ON true
      WHERE line.id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(linked.rows.map((row) => costInteger(row.id, "lineId", 1)))}::jsonb)) ORDER BY line.id`);
      const signed = (value: unknown, label: string) =>
        costInteger(value, label, -Number.MAX_SAFE_INTEGER);
      const linkedById = new Map(
        linked.rows.map((row) => [costInteger(row.id, "lineId", 1), row]),
      );
      const { exceptions, sourceIssues } = await readShipmentCostPostingEvidence(tx, readiness.rows.map(row => {
        const lineId = costInteger(row.id, "lineId", 1);
        const linkedLine = linkedById.get(lineId);
        if (!linkedLine) throw new Error("Shipment costing review refers to an unlinked line.");
        return { lineId, shipmentId: costInteger(linkedLine.inbound_shipment_id, "shipmentId", 1), contract: row.contract };
      }));
      const supplierCredits = await readSupplierCreditCostRows(tx, { freightCostIds: charges.rows.map(row => Number(row.id)) });
      const creditAdjustment = resolveShipmentSupplierCredits({ purpose: "supplier_balance", charges: charges.rows, allocations: allocations.rows,
        invoices: invoices.rows.map(row => ({ ...row, vendor_invoice_id: row.invoice_id })), credits: supplierCredits });
      const chargeTaxes = new Map(charges.rows.filter(row => row.tax_treatment != null).map(row => [Number(row.id), { treatment: String(row.tax_treatment) }]));
      const headerExclusions = shipmentHeaderExclusions(invoices.rows, allocations.rows, chargeTaxes);
      const recoverableIds = new Set(charges.rows.filter(row => row.tax_treatment === "recoverable" && !headerExclusions.replacedTaxChargeIds.has(Number(row.id))).map(row => Number(row.id)));
      const inventoryCredits = resolveShipmentSupplierCredits({ charges: charges.rows.filter(row => !recoverableIds.has(Number(row.id))),
        allocations: allocations.rows.filter(row => !recoverableIds.has(Number(row.shipment_cost_id))),
        invoices: invoices.rows.map(row => ({ ...row, vendor_invoice_id: row.invoice_id })),
        credits: supplierCredits.filter(row => !recoverableIds.has(Number(row.freight_cost_id))) });
      const recoverableByShipmentLine = new Map(headerExclusions.taxByLine);
      for (const row of allocations.rows.filter(row => recoverableIds.has(Number(row.shipment_cost_id)) && Number(row.purchase_order_id) === poId)) {
        const lineId = Number(row.inbound_shipment_line_id);
        recoverableByShipmentLine.set(lineId, readIntegerCents(BigInt(recoverableByShipmentLine.get(lineId) ?? 0) + BigInt(readIntegerCents(row.allocated_cents, "recoverable tax share", true)), "recoverable tax share", true));
      }
      for (const [id, amount] of recoverableByShipmentLine) recoverableByShipmentLine.set(id,
        readIntegerCents(BigInt(amount) - BigInt(creditAdjustment.creditedCentsByLine.get(id) ?? 0) + BigInt(inventoryCredits.creditedCentsByLine.get(id) ?? 0), "net recoverable tax share", true));
      const costs = buildPoShipmentCosts(
        {
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
                    ) - (creditAdjustment.creditedCentsByCharge.get(Number(row.id)) ?? 0),
              confirmed: authority.evidence === "confirmed",
              issue: authority.issue?.code ?? creditAdjustment.issues[0]?.code ?? null,
            };
          }),
          allocations: creditAdjustment.allocations.filter(row => !isUnresolvedPhysicalAllocation(row.basis_evidence)).map((row) => ({
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
              issue: sourceIssues.get(costInteger(row.id, "shipmentLineId", 1))?.code ?? null,
            };
          }),
        },
        supplier,
        readiness.rows.map((row) => {
          const lineId = costInteger(row.id, "lineId", 1);
          const line = linkedById.get(lineId);
          if (!line)
            throw new Error(
              "Shipment costing review refers to an unlinked line.",
            );
          const contract = row.contract as Record<string, unknown> | null;
          return {
            lineId,
            purchaseOrderLineId: line.purchase_order_line_id == null
              ? null : costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1),
            exceptionReview: exceptions.get(lineId) ?? null,
            shipmentId: costInteger(line.inbound_shipment_id, "shipmentId", 1),
            shipmentNumber:
              line.shipment_number == null
                ? null
                : String(line.shipment_number),
            shipmentStatus: String(line.shipment_status),
            sku: line.sku == null ? null : String(line.sku),
            applicationId:
              row.application_id == null
                ? null
                : costInteger(row.application_id, "applicationId", 1),
            recordedAt: dateValues({ recordedAt: row.recorded_at ?? null }, [
              "recordedAt",
            ]).recordedAt as string | null,
            sourceIssue: sourceIssues.get(lineId) ?? null,
            applicationIssues: row.application_issues ?? null,
          };
        }),
      );
      return {
        ...costs,
        supplierCosts: await readPurchaseCostStatus(tx, linked.rows.flatMap(line => line.purchase_order_line_id == null
          ? [] : [costInteger(line.purchase_order_line_id, "purchaseOrderLineId", 1)])),
        ...(header.rows[0].tax_active === true ? { taxCosts: await readPurchaseTaxCosts(tx, poId, {
          lines: costs.lines, recoverableByShipmentLine, excludedByShipmentLine: headerExclusions.otherByLine,
          complete: costs.summary.combinedCostCents !== null && inventoryCredits.issues.length === 0,
        }) } : {}),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Preserve the existing summary endpoint and its response contract. */
export async function readPoShipmentCostSummary(
  db: PoShipmentCostSummaryDatabase,
  poId: number,
): Promise<PoShipmentCostSummary | null> {
  return (await readPoShipmentCosts(db, poId))?.summary ?? null;
}
