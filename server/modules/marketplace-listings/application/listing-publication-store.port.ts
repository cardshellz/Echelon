import type {
  ListingAccount,
  ListingDraft,
} from "@shared/types/channel-listing-publication";
import type {
  ListingProgress,
  ListingSnapshot,
  StoredListingOperation,
} from "../domain/listing-publication";

export interface ListingPublicationStore {
  draft(channelId: number): Promise<ListingDraft>;
  saveDraft(
    account: ListingAccount,
    draft: ListingDraft,
    actor: string,
    now: Date,
  ): Promise<ListingDraft>;
  saveReview(
    snapshot: ListingSnapshot,
    actor: string,
    now: Date,
  ): Promise<void>;
  review(channelId: number, reviewId: string): Promise<ListingSnapshot>;
  replay(
    channelId: number,
    commandKey: string,
    requestHash: string,
  ): Promise<StoredListingOperation | null>;
  createOperation(input: {
    id: string;
    snapshot: ListingSnapshot;
    progress: ListingProgress;
    commandKey: string;
    requestHash: string;
    actor: string;
    now: Date;
  }): Promise<StoredListingOperation>;
  operations(channelId: number): Promise<StoredListingOperation[]>;
  operation(channelId: number, id: string): Promise<StoredListingOperation>;
  claim(now: Date, leaseToken: string): Promise<StoredListingOperation | null>;
  renewLease(operation: StoredListingOperation, now: Date): Promise<void>;
  saveProgress(
    operation: StoredListingOperation,
    progress: ListingProgress,
    input: {
      now: Date;
      nextAttemptAt: Date;
      releaseLease: boolean;
      actor: string;
    },
  ): Promise<StoredListingOperation>;
  requestReconciliation(
    channelId: number,
    id: string,
    actor: string,
    now: Date,
  ): Promise<StoredListingOperation>;
}
