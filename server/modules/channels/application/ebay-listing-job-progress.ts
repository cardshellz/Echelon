import type { EbayListingSyncJob } from "@shared/types/ebay-listing-sync";

type Phase = NonNullable<EbayListingSyncJob["progress"]>["phase"];

/** A phase describes recorded work, never inferred completion or an ETA. */
export function ebayListingPhaseFromStage(key: string | null): Phase {
  if (!key) return null;
  if (key === "prepare_listing" || key === "prepared_intent" || key === "provider_identity" || key === "publication_target") return "prepare_listing";
  if (key === "recover_prior_requests") return "recover_prior_requests";
  if (key === "inspection") return "inspect_content";
  if (key === "prepare_inventory") return "prepare_inventory";
  if (key.startsWith("offer:")) return "update_offer";
  if (key.startsWith("item:")) return "update_item";
  if (key.startsWith("group:")) return "update_group";
  if (key === "publish" || key === "publication_accepted" || key === "publication_rejected") return "publish";
  if (key === "publication_readback") return "publication_readback";
  if (key === "verification") return "verify";
  if (key === "withdraw") return "withdraw";
  return null;
}
