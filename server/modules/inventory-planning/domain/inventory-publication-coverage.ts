import type { CurrentPublicationEvidence } from "@shared/types/inventory-availability-phase4";
import type {
  InventoryChannelExposureAdminView,
  InventoryChannelExposurePreview,
} from "@shared/types/inventory-channel-exposure";

type PublicationScope = Pick<InventoryChannelExposurePreview,
  "publicationTargetId" | "channelId" | "membership"> & {
  rows: readonly Pick<InventoryChannelExposurePreview["rows"][number], "productVariantId">[];
};
type RegisteredTarget = Pick<InventoryChannelExposureAdminView["publicationTargets"][number], "channelId">;

/** Legacy allocation comparisons do not create listing obligations. Only skip
 * coverage when both captures prove there is no configured destination, or every
 * configured destination explicitly omits this inactive/unlisted SKU. Active
 * feeds, quarantine, selected rows and incomplete target evidence still validate.
 */
export function isComparisonOnlyPublicationEvidence(
  evidence: CurrentPublicationEvidence,
  scopes: readonly PublicationScope[],
  registeredTargets: readonly RegisteredTarget[],
): boolean {
  if (evidence.mappingState !== "missing" && evidence.mappingState !== "inactive") return false;
  if (evidence.mappingState === "missing" && evidence.feedId !== null) return false;
  if (evidence.mappingState === "inactive" && evidence.feedId === null) return false;

  if (evidence.configuredTargets.length === 0) {
    // A disappeared/disabled known target is not an unconfigured channel.
    return evidence.mappingState === "missing"
      && !registeredTargets.some(target => target.channelId === evidence.channelId)
      && !scopes.some(scope => scope.channelId === evidence.channelId);
  }
  return evidence.configuredTargets.every(target => {
    const scope = scopes.find(candidate => candidate.publicationTargetId === target.publicationTargetId
      && candidate.channelId === evidence.channelId);
    return scope?.membership?.mode === "explicit"
      && !scope.membership.includedVariantIds.includes(evidence.productVariantId)
      && !scope.rows.some(row => row.productVariantId === evidence.productVariantId);
  });
}
