import { supplierCreditDispositionSchema } from "@shared/procurement/supplier-credit";
import type { CostIssue, CostSourceReference } from "@shared/procurement/cost-source-contracts";
import { costFingerprint, costInteger } from "../../inventory/infrastructure/cost-evidence-values";
import { allocateCentsFromNumericBasis } from "./shipment-allocation-basis";
import { supplierCreditDispositionMatches, supplierCreditInvoiceSourceFingerprint, supplierCreditIssue, supplierCreditSourceEvidenceSchema, type SupplierCreditCostRow } from "./supplier-credit-source";

/** A credit reduces a specific positive original charge. Its cents are allocated
 * over that charge's saved positive allocations, with the existing exact integer
 * allocator. Aggregate first so repeated one-cent credits cannot overdraw a line.
 * The original charge and saved allocation rows remain unchanged. */
export function resolveShipmentSupplierCredits(input: {
  charges: readonly Record<string, unknown>[];
  allocations: readonly Record<string, unknown>[];
  invoices: readonly Record<string, unknown>[];
  credits: readonly SupplierCreditCostRow[];
}) {
  const issues: CostIssue[] = [];
  const sources: CostSourceReference[] = [];
  const creditedCentsByCharge = new Map<number, number>();
  const creditedCentsByLine = new Map<number, number>();
  const totals = new Map<number, bigint>();
  const identities = new Set<number>();
  for (const credit of input.credits) {
    if (supplierCreditDispositionSchema.safeParse(credit.disposition).data?.kind === "accepted_stock_return") continue;
    const creditLineId = costInteger(credit.id, "creditLineId", 1);
    if (identities.has(creditLineId)) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_DUPLICATE", "A supplier credit source line appears more than once."));
      continue;
    }
    identities.add(creditLineId);
    sources.push({ kind: "supplier_credit_line", documentId: costInteger(credit.supplier_credit_id, "creditId", 1),
      lineId: costInteger(credit.id, "creditLineId", 1), version: costFingerprint(credit) });
    if (credit.status === "voided") continue;
    const invoice = input.invoices.find(row => Number(row.id) === Number(credit.invoice_line_id));
    const parsed = supplierCreditSourceEvidenceSchema.safeParse(credit.source_evidence);
    if (credit.status !== "approved" || !invoice || !parsed.success
      || parsed.data.invoiceLineId !== Number(invoice.id) || parsed.data.invoiceId !== Number(invoice.vendor_invoice_id)
      || parsed.data.invoiceSourceFingerprint !== supplierCreditInvoiceSourceFingerprint(invoice)
      || parsed.data.freightCostId !== Number(invoice.freight_cost_id)
      || parsed.data.purchaseOrderLineId !== null || invoice.purchase_order_line_id != null || credit.purchase_order_line_id != null
      || credit.freight_cost_id !== undefined && parsed.data.freightCostId !== Number(credit.freight_cost_id)) {
      issues.push(supplierCreditIssue("CREDIT_LANDED_SOURCE_CHANGED", "The landed credit no longer matches its original approved invoice charge evidence."));
      continue;
    }
    const evidence = parsed.data;
    if (!supplierCreditDispositionMatches(credit, evidence)) {
      issues.push(supplierCreditIssue("CREDIT_SOURCE_DISPOSITION_MISMATCH", "The landed credit disagrees with its frozen cost disposition."));
      continue;
    }
    issues.push(...evidence.issues);
    const amount = costInteger(credit.amount_cents, "creditAmountCents", 1);
    if (evidence.issues.length) continue;
    if (evidence.reduction.productMills !== 0 || evidence.reduction.packagingMills !== 0 || evidence.reduction.basePieces !== 0
      || BigInt(evidence.reduction.landedMills) !== BigInt(amount) * BigInt(100)) {
      issues.push(supplierCreditIssue("CREDIT_LANDED_AMOUNT_MISMATCH", "The landed credit must reconcile exactly to its recorded original charge reduction."));
      continue;
    }
    const chargeId = evidence.freightCostId!;
    totals.set(chargeId, (totals.get(chargeId) ?? BigInt(0)) + BigInt(amount));
  }
  for (const [chargeId, credited] of totals) {
    const charge = input.charges.find(row => Number(row.id) === chargeId);
    const saved = input.allocations.filter(row => Number(row.shipment_cost_id) === chargeId);
    const gross = charge ? costInteger(charge.actual_cents ?? charge.estimated_cents, "grossChargeCents", -Number.MAX_SAFE_INTEGER) : null;
    const allocationAmounts = saved.map(row => costInteger(row.allocated_cents, "grossAllocationCents", -Number.MAX_SAFE_INTEGER));
    if (gross === null || gross <= 0 || credited > BigInt(gross) || allocationAmounts.some(amount => amount < 0)
      || allocationAmounts.reduce((sum, amount) => sum + BigInt(amount), BigInt(0)) !== BigInt(gross)) {
      issues.push(supplierCreditIssue("CREDIT_LANDED_ALLOCATION_REVIEW", "The credit requires a positive original charge and complete nonnegative allocations, and cannot exceed that charge."));
      continue;
    }
    const amount = costInteger(credited.toString(), "creditedChargeCents");
    const allocated = allocateCentsFromNumericBasis(amount, saved.map((row, index) => ({
      lineId: costInteger(row.inbound_shipment_line_id, "shipmentLineId", 1), basis: allocationAmounts[index],
    })));
    creditedCentsByCharge.set(chargeId, amount);
    for (const row of allocated) creditedCentsByLine.set(row.lineId, costInteger(
      (BigInt(creditedCentsByLine.get(row.lineId) ?? 0) + BigInt(row.allocatedCents)).toString(), "lineCreditCents"));
  }
  const allocations = input.allocations.map(row => ({ ...row }));
  for (const [chargeId, amount] of creditedCentsByCharge) {
    const scoped = allocations.filter(row => Number(row.shipment_cost_id) === chargeId);
    const credited = new Map(allocateCentsFromNumericBasis(amount, scoped.map(row => ({
      lineId: costInteger(row.inbound_shipment_line_id, "shipmentLineId", 1), basis: costInteger(row.allocated_cents, "allocationCents"),
    }))).map(row => [row.lineId, row.allocatedCents]));
    for (const row of scoped) row.allocated_cents = costInteger(row.allocated_cents, "allocationCents") - credited.get(Number(row.inbound_shipment_line_id))!;
  }
  return { issues, sources, creditedCentsByCharge, creditedCentsByLine, allocations };
}
