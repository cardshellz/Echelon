import type { InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import type { ActiveInventoryPublicationTargetSnapshot, ActivePublicationSourceBindingSnapshot, ActivePublicationVariantMappingSnapshot } from "../application/inventory-channel-exposure-runtime.service";
import { selectPublicationVariants } from "./inventory-publication-scope";

/** Only mappings consumed by selected publication members require promotion.
 * An excluded mapping stays a draft and cannot accidentally become a listing. */
export function selectedCutoverPublicationMappings(target: ActiveInventoryPublicationTargetSnapshot): ActivePublicationVariantMappingSnapshot[] {
  return selectPublicationVariants(target.mappings.map(mapping => ({ id: mapping.productVariantId, mapping })),
    target.membership ?? { mode: "whole_product" }).selected.map(row => row.mapping);
}

/** A read-only projection of the exact node transitions the final transaction
 * will perform. Ordinary runtime reads still require actually active sources. */
export function projectCutoverSourceActivation(
  targets: readonly ActiveInventoryPublicationTargetSnapshot[],
  manifest: InventoryCutoverManifest,
): ActiveInventoryPublicationTargetSnapshot[] {
  const selected = new Map((manifest.sourceNodes ?? []).map(node => [node.nodeId, node]));
  type Member = ActivePublicationSourceBindingSnapshot["members"][number];
  const projectMember = (member: Member): Member => {
    const reviewed = selected.get(member.fulfillmentNodeId);
    return reviewed?.lifecycleStatus === "draft" && reviewed.warehouseActive === 1
      && reviewed.warehouseId === member.warehouseId && member.fulfillmentNodeLifecycleStatus === "draft"
      ? { ...member, fulfillmentNodeLifecycleStatus: "active" } : { ...member };
  };
  return targets.map(target => ({ ...target,
    sourceBinding: target.sourceBinding ? { ...target.sourceBinding,
      members: target.sourceBinding.members.map(projectMember) } : null,
    ...(target.sourceOverrideMembers ? { sourceOverrideMembers: target.sourceOverrideMembers.map(projectMember) } : {}),
  }));
}
