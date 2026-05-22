import {
  generatePurchasingRecommendations,
  type PurchasingRecommendationItem,
  type PurchasingRecommendationQualityControl,
} from "./purchasing-recommendation.engine";

const supplierSetupGapCodes = new Set([
  "missing_vendor",
  "missing_supplier_cost",
  "last_purchase_cost",
  "stale_supplier_cost",
  "unverified_supplier_cost",
  "default_lead_time",
  "product_lead_time_fallback",
]);

const supplierSetupGapActions: Record<string, { action: string; label: string; href: string }> = {
  missing_vendor: { action: "assign_preferred_vendor", label: "Assign vendor", href: "/suppliers" },
  missing_supplier_cost: { action: "update_supplier_cost", label: "Update cost", href: "/suppliers" },
  last_purchase_cost: { action: "verify_supplier_cost", label: "Verify cost", href: "/suppliers" },
  stale_supplier_cost: { action: "verify_supplier_cost", label: "Verify cost", href: "/suppliers" },
  unverified_supplier_cost: { action: "verify_supplier_cost", label: "Verify cost", href: "/suppliers" },
  default_lead_time: { action: "set_vendor_lead_time", label: "Set lead time", href: "/suppliers" },
  product_lead_time_fallback: { action: "set_vendor_lead_time", label: "Set lead time", href: "/suppliers" },
};

function supplierSetupGapPriority(code: string): number {
  switch (code) {
    case "missing_vendor":
      return 0;
    case "missing_supplier_cost":
      return 1;
    case "last_purchase_cost":
    case "stale_supplier_cost":
    case "unverified_supplier_cost":
      return 2;
    case "default_lead_time":
    case "product_lead_time_fallback":
      return 3;
    default:
      return 4;
  }
}

function supplierGapControls(item: PurchasingRecommendationItem): PurchasingRecommendationQualityControl[] {
  const controlsByCode = new Map<string, PurchasingRecommendationQualityControl>();
  for (const control of [...(item.qualityControls ?? []), ...(item.autopilotBlockers ?? [])]) {
    if (supplierSetupGapCodes.has(control.code) && !controlsByCode.has(control.code)) {
      controlsByCode.set(control.code, control);
    }
  }
  return Array.from(controlsByCode.values()).sort((a, b) => supplierSetupGapPriority(a.code) - supplierSetupGapPriority(b.code));
}

export function buildSupplierSetupGaps(result: ReturnType<typeof generatePurchasingRecommendations>) {
  const sourceItems = new Map<string, PurchasingRecommendationItem>();
  for (const item of [...result.items, ...result.skippedItems]) {
    sourceItems.set(item.recommendationId, item);
  }

  const counts = {
    missingVendor: 0,
    missingSupplierCost: 0,
    lastPurchaseCost: 0,
    staleSupplierCost: 0,
    unverifiedSupplierCost: 0,
    defaultLeadTime: 0,
    productLeadTimeFallback: 0,
    blockedRecommendations: 0,
    reviewRecommendations: 0,
  };
  const codeCounts: Record<string, number> = {};

  const items = Array.from(sourceItems.values()).flatMap((item) => {
    const controls = supplierGapControls(item);
    if (controls.length === 0) return [];

    for (const control of controls) {
      codeCounts[control.code] = (codeCounts[control.code] ?? 0) + 1;
      if (control.code === "missing_vendor") counts.missingVendor++;
      if (control.code === "missing_supplier_cost") counts.missingSupplierCost++;
      if (control.code === "last_purchase_cost") counts.lastPurchaseCost++;
      if (control.code === "stale_supplier_cost") counts.staleSupplierCost++;
      if (control.code === "unverified_supplier_cost") counts.unverifiedSupplierCost++;
      if (control.code === "default_lead_time") counts.defaultLeadTime++;
      if (control.code === "product_lead_time_fallback") counts.productLeadTimeFallback++;
    }

    if (controls.some((control) => control.severity === "block")) {
      counts.blockedRecommendations++;
    } else {
      counts.reviewRecommendations++;
    }

    const primaryControl = controls[0];
    const action = supplierSetupGapActions[primaryControl.code] ?? {
      action: "review_supplier_setup",
      label: "Review",
      href: "/suppliers",
    };

    return [{
      recommendationId: item.recommendationId,
      productId: item.productId,
      productVariantId: item.productVariantId ?? null,
      sku: item.sku,
      productName: item.productName,
      status: item.status,
      actionable: item.actionable,
      skippedReason: item.skippedReason,
      preferredVendorId: item.preferredVendorId,
      preferredVendorName: item.preferredVendorName,
      suggestedOrderQty: item.suggestedOrderQty,
      orderUomLabel: item.orderUomLabel,
      candidateScore: item.recommendationCandidateScore,
      qualityGate: item.qualityGate,
      gaps: controls.map((control) => ({
        area: control.area,
        severity: control.severity,
        code: control.code,
        label: control.label,
        detail: control.detail,
      })),
      action,
    }];
  }).sort((a, b) => {
    const aSeverity = a.gaps.some((gap) => gap.severity === "block") ? 0 : 1;
    const bSeverity = b.gaps.some((gap) => gap.severity === "block") ? 0 : 1;
    if (aSeverity !== bSeverity) return aSeverity - bSeverity;
    const aPriority = supplierSetupGapPriority(a.gaps[0]?.code ?? "");
    const bPriority = supplierSetupGapPriority(b.gaps[0]?.code ?? "");
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (b.candidateScore?.score ?? 0) - (a.candidateScore?.score ?? 0);
  });

  return {
    scannedRecommendations: result.items.length,
    skippedRecommendations: result.skippedItems.length,
    totalGapItems: items.length,
    counts,
    codeCounts,
    items: items.slice(0, 25),
  };
}

export type SupplierSetupGaps = ReturnType<typeof buildSupplierSetupGaps>;
