import type { PublishingStatus, Target, View } from "./model";

/** Known server blockers get operator language; unknown failures retain their diagnostic details in the view. */
export function describeResumeIssue(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    INVENTORY_PUBLICATION_TARGET_RESUME_MAPPING_MISSING: "No active listing links were found. Check the listing setup before resuming.",
    INVENTORY_PUBLICATION_TARGET_RESUME_HISTORICAL_IDENTITY_UNCOVERED: "An earlier listing link is not covered by the current setup. Resolve the listing link before resuming.",
    INVENTORY_PUBLICATION_TARGET_RESUME_ACTIVE_CONFIGURATION_MISSING: "Applied settings for this account could not be loaded. Check warehouses and stock rules, then review saved changes below.",
    INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_MISSING: "A marketplace stock check is missing for a listing. A recorded check is needed before updates can resume.",
    INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_STALE: "A recorded marketplace stock check is too old or has an invalid date. A current stock check is needed before updates can resume.",
    INVENTORY_PUBLICATION_TARGET_RESUME_READBACK_IDENTITY_CHANGED: "A recorded stock check belongs to a different listing or account setup. A matching check is needed before updates can resume.",
    CHANNEL_EXPOSURE_POLICY_INCOMPLETE: "Complete the stock rules and apply the saved changes before resuming.",
    CHANNEL_SOURCE_BINDING_MISSING: "Choose the warehouses that supply this account and apply the saved changes.",
    PUBLICATION_TARGET_VARIANT_MAPPING_MISSING: "Link the affected SKUs to their channel listings and apply the saved changes.",
  };
  return messages[code] ?? "Another stock check failed. Open Check details for the returned error.";
}

/** Display only: being enabled is permission to send, never proof of delivery. */
export function describeStockUpdates(target: Target, runtimeAuthority: View["runtimeAuthority"], globalEnabled: boolean | null): PublishingStatus {
  if (target.publicationAuthority !== "echelon") {
    return {
      label: "Managed elsewhere", tone: "external",
      explanation: target.publicationAuthority === "manual"
        ? "Stock quantities are updated by hand in the marketplace. Echelon does not send stock updates for this account."
        : "Another system manages stock for this account. Echelon does not send its stock updates.",
    };
  }
  if (runtimeAuthority !== "canonical") {
    return { label: "Setup only", tone: "preview", explanation: "Your previous stock settings still control updates. Settings saved here are not in use yet." };
  }
  if (target.state === "disabled") {
    return { label: "Off", tone: "off", explanation: "Automatic stock updates are off for this account. Stock already shown in the marketplace is unchanged." };
  }
  if (target.state === "preview") {
    return { label: "Off", tone: "preview", explanation: "Automatic stock updates are off. This account is included in the checks before updates can start or resume." };
  }
  if (globalEnabled === null) {
    return { label: "Status unavailable", tone: "off", explanation: "This account is enabled, but the all-channel stock-update control could not be confirmed." };
  }
  if (!globalEnabled) {
    return { label: "Paused for all channels", tone: "off", explanation: "The all-channel control is off. This account remains enabled, but automatic stock updates are paused." };
  }
  if (target.hold) {
    return { label: "Holding at zero", tone: "held", explanation: "Stock updates are enabled, but this account is held at zero. Stock rules do not override this hold." };
  }
  return { label: "Enabled", tone: "live", explanation: "Echelon is enabled to send stock quantities for this account as availability changes. Check Stock preview for recorded update results." };
}
