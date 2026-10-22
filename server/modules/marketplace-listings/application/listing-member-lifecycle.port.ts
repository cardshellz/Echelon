import type { ListingMemberIdentity, ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";

export interface ListingMemberObservation {
  identity: ListingMemberIdentity;
  retired: boolean;
}

/** Adapters translate one exact identity. They cannot enumerate local siblings,
 * choose eligibility, create ATP mappings, schedule retries, or save completion. */
export interface ListingMemberLifecycleAdapter {
  observe(identity: ListingMemberIdentity): Promise<ListingMemberObservation>;
  retire(identity: ListingMemberIdentity, operationId: string): Promise<void>;
}

export interface ListingMemberProgress {
  dispatchStatus?: NonNullable<ListingMemberRetirement["dispatchStatus"]>;
  dispatchKey?: string;
  verificationAttempts?: number;
  recoveryRequired?: boolean;
}
export interface ListingMemberRecoveryAuthorization {
  commandKey: string; actor: string; reviewHash: string; observation: ListingMemberObservation;
}
export interface ListingMemberLifecycleSession {
  current: ListingMemberRetirement;
  isCurrent(): Promise<boolean>;
  save(state: ListingMemberRetirement["state"], code: string | null, message: string, now: Date, progress?: ListingMemberProgress): Promise<ListingMemberRetirement>;
  recoveryCommand?(commandKey: string): Promise<{ operationId: string; actor: string; reviewHash: string } | null>;
  authorizeRecovery?(input: ListingMemberRecoveryAuthorization, now: Date): Promise<ListingMemberRetirement>;
}
export interface ListingMemberLifecycleStore {
  listForChannel(channelId: number, productId: number, limit: number): Promise<ListingMemberRetirement[]>;
  listForDropship?(connectionId: number, vendorId: number, productId: number, limit: number): Promise<ListingMemberRetirement[]>;
  discover(now: Date, limit: number): Promise<void>;
  due(now: Date, limit: number): Promise<string[]>;
  withMember<T>(id: string, work: (session: ListingMemberLifecycleSession) => Promise<T>): Promise<T | null>;
}

export interface ListingMemberLifecycleDependencies {
  store: ListingMemberLifecycleStore;
  adapter(identity: ListingMemberIdentity): Promise<ListingMemberLifecycleAdapter>;
  /** Reuse the channel publication owner's lock and pending-work evidence. */
  withPublicationFence?<T>(identity: ListingMemberIdentity, work: (pending: boolean) => Promise<T>): Promise<T>;
}
