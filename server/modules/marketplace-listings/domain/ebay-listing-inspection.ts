import { z } from "zod";
import { channelProviderReadDiagnosticSchema, type ChannelProviderReadDiagnostic } from "@shared/channel-provider-read";
import type { MarketplaceObservedListingPublication, MarketplaceProviderAccountObservation } from "./listing-registration-plan";

export interface EbayListingInspectionIssue {
  readonly code: string; readonly message: string; readonly status?: number;
  readonly sku?: string; readonly listingId?: string; readonly groupKey?: string; readonly listingStatus?: string;
  readonly groupVariantSkus?: readonly string[];
  readonly providerRead?: ChannelProviderReadDiagnostic;
}
/** The observer and all consumers validate the same diagnostic DTO. */
export const ebayListingInspectionIssueSchema: z.ZodType<EbayListingInspectionIssue> = z.object({
  code: z.string().min(1).max(150), message: z.string().min(1).max(1000),
  status: z.number().int().min(100).max(599).optional(),
  sku: z.string().max(255).optional(), listingId: z.string().max(255).optional(),
  groupKey: z.string().max(255).optional(), listingStatus: z.string().max(255).optional(),
  groupVariantSkus: z.array(z.string().max(255)).max(10000).optional(),
  providerRead: channelProviderReadDiagnosticSchema.optional(),
}).strict();

export interface EbayListingInspectedOffer {
  readonly sku: string | null;
  readonly offerId: string;
  readonly status: "PUBLISHED" | "UNPUBLISHED";
  readonly listingId: string | null;
  readonly listingStatus: string | null;
}
export interface EbayListingInspectedSku {
  readonly sku: string;
  readonly inventoryItemExists: boolean | null;
  readonly offers: readonly EbayListingInspectedOffer[];
  readonly issue: EbayListingInspectionIssue | null;
}
/** Diagnostic reads are not publication proof. Only publication carries the
 * existing canonical observer's complete account/group/member verification. */
export interface EbayListingInspection {
  readonly providerAccount: MarketplaceProviderAccountObservation;
  readonly observedAt: Date;
  readonly skus: readonly EbayListingInspectedSku[];
  readonly publication: MarketplaceObservedListingPublication | null;
  readonly publicationIssue: EbayListingInspectionIssue | null;
  readonly groupKey: string | null;
  readonly groupSkus: readonly string[] | null;
  /** Existing unpublished offers with fully observed, exact group membership.
   * This is a publication target, never evidence that publication succeeded. */
  readonly unpublishedTarget?: { readonly groupKey: string | null; readonly skus: readonly string[] } | null;
}
