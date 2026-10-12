import type { ListingAccount } from "@shared/types/channel-listing-publication";
import type {
  ListingLifecycleView,
  ListingLifecycleCommand,
} from "@shared/types/channel-listing-lifecycle";

/** Outgoing listing/content/positive-stock writes share a per-account/SKU lock;
 * retirement takes it exclusively. Zero stock can still drain the listing. */
export interface ListingWriteGuard {
  withAllowed<T>(
    account: ListingAccount,
    skus: readonly string[],
    work: () => Promise<T>,
  ): Promise<T>;
}
export interface StoredListingLifecycle {
  account: ListingAccount;
  actor: string;
  view: ListingLifecycleView;
}
export interface ListingLifecycleSession {
  find(sku: string): Promise<StoredListingLifecycle | null>;
  request(
    command: ListingLifecycleCommand,
    title: string,
    actor: string,
    id: string,
    now: Date,
  ): Promise<StoredListingLifecycle>;
  progress(
    record: StoredListingLifecycle,
    state: ListingLifecycleView["state"],
    message: string | null,
    now: Date,
  ): Promise<StoredListingLifecycle>;
  hasPendingFeed(sku: string): Promise<boolean>;
}
export interface ListingLifecycleStore extends ListingWriteGuard {
  withListing<T>(
    account: ListingAccount,
    sku: string,
    work: (session: ListingLifecycleSession) => Promise<T>,
  ): Promise<T>;
  list(
    account: ListingAccount,
    skus: readonly string[],
  ): Promise<ListingLifecycleView[]>;
  history(
    account: ListingAccount,
    afterSku: string | null,
    sku: string | null,
    limit: number,
  ): Promise<ListingLifecycleView[]>;
  due(now: Date, limit: number): Promise<StoredListingLifecycle[]>;
}
export interface ListingLifecycleProvider {
  account(channelId: number): Promise<ListingAccount>;
  observe(
    account: ListingAccount,
    sku: string,
  ): Promise<{ sku: string; title: string; retired: boolean }>;
  holdStock(
    account: ListingAccount,
    sku: string,
    operationId: string,
    actor: string,
  ): Promise<void>;
  retire(
    account: ListingAccount,
    sku: string,
    correlationId: string,
  ): Promise<void>;
}
