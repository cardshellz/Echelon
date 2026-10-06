import type {
  ListingAccount,
  ListingIssue,
  ListingTaxonomy,
} from "@shared/types/channel-listing-publication";
import type {
  ListingUpdateChanges,
  ListingUpdateObservation,
  ListingUpdateState,
  ListingUpdateView,
  ReviewListingUpdate,
} from "@shared/types/channel-listing-update";

export interface PreparedListingUpdate {
  payload: Record<string, unknown>;
  schemaHash: string;
  issues: ListingIssue[];
}
export interface ListingUpdateIntent {
  account: ListingAccount;
  source: ListingUpdateObservation;
  command: ReviewListingUpdate;
  prepared: PreparedListingUpdate;
}
export interface StoredListingUpdate {
  view: ListingUpdateView;
  intent: ListingUpdateIntent;
  version: number;
  leaseToken: string | null;
  commandKey: string | null;
}
export interface ListingUpdateProvider {
  account(channelId: number): Promise<ListingAccount>;
  observe(
    account: ListingAccount,
    sku: string,
  ): Promise<ListingUpdateObservation>;
  taxonomy(account: ListingAccount): Promise<ListingTaxonomy>;
  requirements(
    account: ListingAccount,
    productType: string,
  ): Promise<Record<string, unknown>>;
  prepare(
    account: ListingAccount,
    source: ListingUpdateObservation,
    command: ReviewListingUpdate,
  ): Promise<PreparedListingUpdate>;
  send(
    intent: ListingUpdateIntent,
    correlationId: string,
    beforeSend: () => Promise<void>,
  ): Promise<string>;
  status(
    account: ListingAccount,
    submissionId: string,
    sku: string,
    externalProductId: string,
  ): Promise<{
    state: "processing" | "accepted" | "needs_attention";
    message: string | null;
  }>;
}
export interface ListingUpdateStore {
  insert(record: StoredListingUpdate, actor: string): Promise<void>;
  get(channelId: number, id: string): Promise<StoredListingUpdate>;
  list(
    channelId: number,
    sku?: string,
    accountKey?: string,
  ): Promise<StoredListingUpdate[]>;
  lastSubmitted(
    account: ListingAccount,
    sku: string,
    externalProductId: string,
  ): Promise<{ productType: string; changes: ListingUpdateChanges } | null>;
  acceptedPrice(
    account: ListingAccount,
    sku: string,
    externalProductId: string,
    since: Date,
  ): Promise<number | null>;
  queue(
    record: StoredListingUpdate,
    commandKey: string,
    actor: string,
    now: Date,
  ): Promise<StoredListingUpdate>;
  claim(
    leaseToken: string,
    now: Date,
    id?: string,
  ): Promise<StoredListingUpdate | null>;
  renew(record: StoredListingUpdate, now: Date): Promise<void>;
  progress(
    record: StoredListingUpdate,
    state: ListingUpdateState,
    submissionId: string | null,
    message: string | null,
    now: Date,
    release: boolean,
  ): Promise<StoredListingUpdate>;
  refresh(
    channelId: number,
    id: string,
    actor: string,
    now: Date,
  ): Promise<StoredListingUpdate>;
}
