import type { ListingMemberConflictList, ListingMemberIdentity, ListingMemberRetirement } from "@shared/types/listing-member-lifecycle";

export interface ListingMemberObservation {
  identity: ListingMemberIdentity;
  retired: boolean;
}

/** Finality describes the exact dispatched operation, not current listing state. */
export interface ListingMemberDispatchReceipt {
  finality: "pending" | "terminal";
}

/** Adapters translate one exact identity. They cannot enumerate local siblings,
 * choose eligibility, create ATP mappings, schedule retries, or save completion. */
export interface ListingMemberLifecycleAdapter {
  observe(identity: ListingMemberIdentity): Promise<ListingMemberObservation>;
  retire(identity: ListingMemberIdentity, operationId: string): Promise<ListingMemberDispatchReceipt>;
}

export interface ListingMemberProgress {
  dispatchStatus?: NonNullable<ListingMemberRetirement["dispatchStatus"]>;
  dispatchKey?: string;
  dispatchFinality?: ListingMemberDispatchReceipt["finality"];
  verificationAttempts?: number;
  recoveryRequired?: boolean;
  retryAfterMs?: number;
}
export interface ListingMemberRecoveryAuthorization {
  commandKey: string; actor: string; reviewHash: string; observation: ListingMemberObservation;
}
export interface ListingMemberLifecycleSession {
  current: ListingMemberRetirement;
  /** The retained source needs correction; discovery wakes its replacement. */
  retryDeferred?: boolean;
  isCurrent(): Promise<boolean>;
  /** True only when the complete immutable event history proves no send marker. */
  hasProvenNoDispatch?(): Promise<boolean>;
  save(state: ListingMemberRetirement["state"], code: string | null, message: string, now: Date, progress?: ListingMemberProgress): Promise<ListingMemberRetirement>;
  recoveryCommand?(commandKey: string): Promise<{ operationId: string; actor: string; reviewHash: string } | null>;
  authorizeRecovery?(input: ListingMemberRecoveryAuthorization, now: Date): Promise<ListingMemberRetirement>;
}
export interface ListingMemberLifecycleStore {
  listConflictsForChannel?(channelId: number, offset: number): Promise<ListingMemberConflictList>;
  listForChannel(channelId: number, productId: number, limit: number): Promise<ListingMemberRetirement[]>;
  listForDropship?(connectionId: number, vendorId: number, productId: number, limit: number): Promise<ListingMemberRetirement[]>;
  due(now: Date, limit: number): Promise<string[]>;
  withMember<T>(id: string, work: (session: ListingMemberLifecycleSession) => Promise<T>): Promise<T | null>;
}

export interface ListingMemberLifecycleDependencies {
  store: ListingMemberLifecycleStore;
  adapter(identity: ListingMemberIdentity): Promise<ListingMemberLifecycleAdapter>;
  /** Reuse the channel publication owner's lock and pending-work evidence. */
  withPublicationFence?<T>(identity: ListingMemberIdentity, work: (pending: boolean) => Promise<T>): Promise<T>;
}
