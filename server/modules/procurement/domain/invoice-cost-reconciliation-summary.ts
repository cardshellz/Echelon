import { costSourceRevisionSchema, costInventoryEffectProofSchema, type CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { canonicalJson } from "@shared/utils/canonical-json";

type ComponentReconciliation = {
  costSources: Array<{ id: number; contract: CostSourceRevision }>;
  costApplications: Array<{ status: "applied" | "review_required"; inventoryEffectProof?: unknown;
    lotsUpdated?: number; cogsRowsUpdated?: number; totalCogsDeltaCents?: number }>;
};
export type InvoiceCostReconciliationSummary = {
  state: "confirmed_invoice_cost" | "estimated_purchase_cost" | "review_required";
  costSourceState: "confirmed" | "estimated" | "review_required";
  costApplicationState: "applied" | "review_required";
  /** Exact product-component mills per base piece, absent if it requires rounding or review. */
  authoritativeUnitCostMills: number | null;
};

/** Source evidence and application completion are independent. Quantity matches
 * and legacy unit prices cannot establish either authority. */
export function summarizeInvoiceCostReconciliation(result: ComponentReconciliation): InvoiceCostReconciliationSummary {
  const contracts = result.costSources.map((source) => costSourceRevisionSchema.safeParse(source.contract));
  const sources = contracts.flatMap((parsed) => parsed.success ? [parsed.data] : []);
  const completeSources = sources.length === 2 && contracts.every((parsed) => parsed.success)
    && sources.filter((source) => source.component === "product").length === 1
    && sources.filter((source) => source.component === "packaging").length === 1;
  const knownCurrency = sources.every((source) => source.currency === "USD");
  const confirmed = completeSources && knownCurrency && sources.every((source) => source.evidence === "confirmed"
    && source.issue === null && source.sources.some((reference) => reference.kind === "vendor_invoice_line")
    && source.sources.every((reference) => reference.kind === "vendor_invoice_line" || reference.kind === "supplier_credit_line"));
  const estimated = completeSources && knownCurrency && sources.every((source) => source.evidence === "estimated"
    && source.issue === null && source.sources.every((reference) => reference.kind === "purchase_order_line"));
  const noEffect = sources.find(source => source.inventoryEffect)?.inventoryEffect;
  const applied = completeSources && result.costApplications.length === sources.length
    && result.costApplications.every((application) => {
      if (application.status !== "applied") return false;
      if (!noEffect) return true;
      const proof = costInventoryEffectProofSchema.safeParse(application.inventoryEffectProof);
      return proof.success && sources.every(source => source.scope.purchaseOrderLineId === proof.data.purchaseOrderLineId
        && canonicalJson(source.inventoryEffect ?? null) === canonicalJson(proof.data.inventoryEffect))
        && application.lotsUpdated === 0 && application.cogsRowsUpdated === 0 && application.totalCogsDeltaCents === 0;
    });
  const sourceState = confirmed ? "confirmed" : estimated ? "estimated" : "review_required";
  const product = sources.find((source) => source.component === "product");
  let exactUnit: number | null = null;
  if (sourceState !== "review_required" && applied && product?.totalMills != null && product.basePieces != null
    && product.basePieces > 0 && !product.inventoryEffect) {
    const total = BigInt(product.totalMills), pieces = BigInt(product.basePieces);
    if (total >= BigInt(0) && total % pieces === BigInt(0)) exactUnit = Number(total / pieces);
  }
  return {
    state: sourceState === "review_required" || !applied ? "review_required" : confirmed ? "confirmed_invoice_cost" : "estimated_purchase_cost",
    costSourceState: sourceState, costApplicationState: applied ? "applied" : "review_required",
    authoritativeUnitCostMills: exactUnit,
  };
}
