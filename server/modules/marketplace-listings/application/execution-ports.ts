import type { CanonicalJsonValue } from "../domain/canonical-hash";
import type {
  ListingActor,
  ListingOwnerRef,
  PlannedListingMember,
  SourceListingPublicationSnapshot,
} from "../domain/listing-replacement-plan";

export const LISTING_REPLACEMENT_FORWARD_STEP_KEYS = [
  "preflight.validate_plan",
  "cutover.quiesce_source",
  "publish.create_target",
  "verify.target_publication",
  "switch_mapping.activate_target",
] as const;
export const LISTING_REPLACEMENT_COMPENSATION_STEP_KEYS = [
  "compensate.ensure_target_not_sellable",
  "compensate.ensure_source_live",
] as const;
export type ListingReplacementExecutionStepKey =
  | (typeof LISTING_REPLACEMENT_FORWARD_STEP_KEYS)[number]
  | (typeof LISTING_REPLACEMENT_COMPENSATION_STEP_KEYS)[number];

export interface ListingReplacementExecutionMember extends PlannedListingMember {
  readonly externalVariantId: string | null;
  readonly externalOfferId: string | null;
  readonly externalInventoryItemId: string | null;
}

export interface ListingReplacementExecutionContext {
  readonly operationId: number;
  readonly operationStateVersion: number;
  readonly owner: ListingOwnerRef;
  readonly sourcePublication: SourceListingPublicationSnapshot;
  readonly targetPublicationId: number;
  readonly targetGeneration: number;
  readonly targetProviderPublicationKey: string | null;
  readonly targetExternalListingId: string | null;
  readonly desiredStateHash: string;
  /** Provider-owned recovery state captured durably during preflight. */
  readonly sourceProviderSnapshot: CanonicalJsonValue | null;
  readonly sourceMembers: readonly ListingReplacementExecutionMember[];
  readonly targetMembers: readonly ListingReplacementExecutionMember[];
  readonly actor: ListingActor;
  readonly correlationId: string | null;
}

export interface ClaimedListingReplacementStep {
  readonly operation: ListingReplacementExecutionContext;
  readonly executor: ListingActor;
  readonly stepId: number;
  readonly stepStateVersion: number;
  readonly stepKey: ListingReplacementExecutionStepKey;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly attempt: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface ListingReplacementStepSuccess {
  readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
  readonly externalListingId?: string;
  readonly providerPublicationKey?: string | null;
  readonly memberIdentities?: readonly Readonly<{
    productVariantId: number;
    externalVariantId: string | null;
    externalOfferId: string | null;
    externalInventoryItemId: string | null;
  }>[];
  readonly externalUrl?: string | null;
}

export interface TerminalListingReplacementOperation {
  readonly kind: "terminal";
  readonly status: "completed" | "failed" | "cancelled";
}

export interface MarketplaceListingReplacementExecutionRepository {
  claimNextStep(input: {
    readonly operationId: number;
    readonly expectedOwner: ListingOwnerRef;
    readonly actor: ListingActor;
    readonly leaseToken: string | null;
    readonly now: Date;
    readonly leaseDurationMs: number;
  }): Promise<
    ClaimedListingReplacementStep | TerminalListingReplacementOperation
  >;
  completeStep(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly result: ListingReplacementStepSuccess;
    readonly completedAt: Date;
  }): Promise<void>;
  activateTargetAndCompleteOperation(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly result: ListingReplacementStepSuccess;
    readonly completedAt: Date;
  }): Promise<void>;
  failPreflight(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
    readonly failedAt: Date;
  }): Promise<void>;
  beginCompensation(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
    readonly failedAt: Date;
  }): Promise<void>;
  completeCompensationAndFailOperation(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly result: ListingReplacementStepSuccess;
    readonly completedAt: Date;
  }): Promise<void>;
  requireManualRecovery(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
    readonly failedAt: Date;
  }): Promise<void>;
}

/** Provider mutation boundary shared by Channel and Dropship eBay owners. */
export interface MarketplaceListingReplacementProvider {
  preflight(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess>;
  quiesceSource(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess>;
  createTarget(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess>;
  verifyTarget(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess>;
  ensureTargetNotSellable(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess>;
  ensureSourceLive(
    context: ListingReplacementExecutionContext,
    idempotencyKey: string,
  ): Promise<ListingReplacementStepSuccess>;
}

export interface MarketplaceListingReplacementProviderResolver {
  forOwner(owner: ListingOwnerRef): MarketplaceListingReplacementProvider;
}

export interface MarketplaceListingReplacementExecutionClock {
  now(): Date;
}
