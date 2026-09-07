import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { assemblyPackageReviewSchema, type AssemblyPackageReview } from "@shared/assembly-package-review";
import { projectPersistedDeclaredPackageLifecycleShadow } from "../../../shipping/declared-package-lifecycle-shadow.domain";
import type { LockedPackageAllocationAuthorityEvidence } from "../../../shipping/package-allocation-ledger.repository";
import type { PackingSource } from "../../../wms/packing-source-reader";

/** Display persisted provider evidence. This does not upgrade shadow allocation authority. */
export function buildAssemblyPackageReview(input: {
  taskId: string; orderId: number; warehouseId: number;
  sources: readonly PackingSource[]; packages: readonly LockedPackageAllocationAuthorityEvidence[];
}): AssemblyPackageReview {
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  if (sources.size !== input.sources.length) throw new Error("Duplicate packing source identity");
  const packages = input.packages.map(({ persistedEvidence }) => {
    const projection = projectPersistedDeclaredPackageLifecycleShadow(persistedEvidence);
    const issues: string[] = [];
    const items: AssemblyPackageReview["packages"][number]["items"] = [];
    if (persistedEvidence.currentLabelStatus !== "active") issues.push("label_not_active");
    if (projection.outcome !== "projected") {
      issues.push("label_evidence_unusable");
    } else {
      const state = projection.projection;
      if (state.contentsStatus !== "authoritative" || !state.authoritativeContents?.length) issues.push("contents_not_proven");
      if (state.reconciliationStatus !== "clear") issues.push("provider_evidence_requires_review");
      if (state.carrierStatus !== "not_confirmed") issues.push("carrier_possession_already_reported");
      for (const line of state.authoritativeContents ?? []) {
        const source = sources.get(line.wmsShipmentItemId);
        if (!source) { issues.push("package_contains_sources_outside_this_order"); continue; }
        if (!["planned", "queued", "labeled"].includes(source.shipmentStatus)) issues.push("source_shipment_not_open");
        if (line.quantity > source.quantity) issues.push("declared_quantity_exceeds_source");
        items.push({ sourceShipmentItemId: source.id, orderItemId: source.orderItemId, sku: source.sku, quantity: line.quantity });
      }
    }
    return {
      labelId: String(persistedEvidence.shippingProviderLabelId), provider: persistedEvidence.provider,
      providerPackageId: persistedEvidence.providerPhysicalShipmentId,
      trackingNumber: persistedEvidence.currentTrackingNumber, labelStatus: persistedEvidence.currentLabelStatus,
      evidenceHash: createHash("sha256").update(canonicalJson(persistedEvidence)).digest("hex"),
      status: issues.length ? "review_required" as const : "observed_contents" as const,
      issues: [...new Set(issues)].sort(),
      // Never present a partial list as this package's complete instructions.
      items: issues.length ? [] : items.sort((a, b) => a.sourceShipmentItemId - b.sourceShipmentItemId),
    };
  });
  return assemblyPackageReviewSchema.parse({ taskId: input.taskId, orderId: input.orderId,
    warehouseId: input.warehouseId, readOnly: true, closesPackage: false, discoveryComplete: false, packages });
}
