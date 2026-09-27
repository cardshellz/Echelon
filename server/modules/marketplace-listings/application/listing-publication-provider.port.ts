import type {
  ListingAccount,
  ListingCatalogItem,
  ListingDraftItem,
  ListingIssue,
  ListingRequirements,
} from "@shared/types/channel-listing-publication";
import type { ChannelCatalogItem } from "@shared/types/channel-catalog";
import { ChannelProviderError } from "../../channels/channel-provider.error";
import type { ListingSetupZeroIntent } from "../../inventory-planning/application/listing-setup-zero-intent";

/** Only adapter evidence may distinguish a terminal rejection from an unknown write. */
export class ListingSubmissionError extends ChannelProviderError {
  constructor(
    code: string,
    message: string,
    readonly effect: "not_sent" | "rejected" | "uncertain",
  ) {
    super(code, message, effect !== "uncertain");
    this.name = "ListingSubmissionError";
  }
}

export interface ListingPublicationInput {
  catalog: ListingCatalogItem;
  draft: ListingDraftItem;
  priceCents: number;
}
export interface PreparedListingItem {
  variantId: number;
  sku: string;
  feedType: string;
  schemaVersion: string;
  schemaHash: string;
  payload: Record<string, unknown>;
  issues: ListingIssue[];
}
export interface ListingSubmissionObservation {
  state: "processing" | "processed" | "error";
  items: Array<{
    sku: string;
    state: "processing" | "accepted" | "needs_attention";
    externalProductId: string | null;
    issues: ListingIssue[];
    retryable?: boolean;
  }>;
}
export interface ListingPublicationProvider {
  account(channelId: number): Promise<ListingAccount>;
  taxonomy(account: ListingAccount): Promise<string[]>;
  requirements(
    account: ListingAccount,
    productType: string,
    method: "create" | "match",
  ): Promise<ListingRequirements>;
  prepare(
    account: ListingAccount,
    item: ListingPublicationInput,
  ): Promise<PreparedListingItem>;
  /** Must reject a mixed feed family/version; the owner makes separate durable jobs. */
  submit(
    account: ListingAccount,
    input: {
      operationId: string;
      correlationId: string;
      items: PreparedListingItem[];
      zeroStockAdmission: Readonly<ListingSetupZeroIntent>;
      /** Recheck the durable worker lease immediately before the HTTP write. */
      beforeSubmit(): Promise<void>;
    },
  ): Promise<{ submissionId: string }>;
  status(
    account: ListingAccount,
    submissionId: string,
  ): Promise<ListingSubmissionObservation>;
  observe(
    account: ListingAccount,
    sku: string,
  ): Promise<{ item: ChannelCatalogItem; priceCents: number | null }>;
}
