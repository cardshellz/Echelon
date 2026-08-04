import {
  compareCanonicalText,
  sha256Canonical,
  type CanonicalJsonValue,
} from "./canonical-hash";
import { MarketplaceListingReplacementError } from "./errors";
import type { ListingReplacementPhase } from "./lifecycle";

export const LISTING_OWNER_KINDS = ["channel", "dropship"] as const;
export type ListingOwnerKind = (typeof LISTING_OWNER_KINDS)[number];

export const LISTING_ACTOR_TYPES = ["user", "service", "system"] as const;
export type ListingActorType = (typeof LISTING_ACTOR_TYPES)[number];

export const LISTING_MEMBER_DISPOSITIONS = ["included", "excluded"] as const;
export type ListingMemberDisposition =
  (typeof LISTING_MEMBER_DISPOSITIONS)[number];

export type ListingOwnerRef =
  | Readonly<{
      kind: "channel";
      channelId: number;
      productId: number;
      provider: string;
      marketplaceId: string;
    }>
  | Readonly<{
      kind: "dropship";
      storeConnectionId: number;
      productId: number;
      provider: string;
      marketplaceId: string;
    }>;

export interface ListingActor {
  readonly type: ListingActorType;
  readonly id: string;
}

export interface SourceListingPublicationSnapshot {
  readonly publicationId: number;
  readonly generation: number;
  readonly status: "active";
  readonly desiredStateHash: string;
  readonly providerPublicationKey: string | null;
  readonly externalListingId: string;
}

export interface ListingMemberCandidate {
  readonly productVariantId: number;
  readonly sku: string;
  readonly currentlyPublished: boolean;
}

export interface ListingOwnerSnapshot {
  readonly owner: ListingOwnerRef;
  readonly scopeId: number;
  readonly sourcePublication: SourceListingPublicationSnapshot;
  readonly nextGeneration: number;
  readonly memberCandidates: readonly ListingMemberCandidate[];
}

export interface RequestedListingMember {
  readonly productVariantId: number;
  readonly disposition: ListingMemberDisposition;
  readonly reasonCode: string | null;
}

export interface PlannedListingMember extends RequestedListingMember {
  readonly skuSnapshot: string;
}

export const LISTING_REPLACEMENT_STEP_PATHS = [
  "forward",
  "compensation",
] as const;
export type ListingReplacementStepPath =
  (typeof LISTING_REPLACEMENT_STEP_PATHS)[number];

export type ListingReplacementForwardStepPhase = Exclude<
  ListingReplacementPhase,
  "compensate" | "complete"
>;
export type ListingReplacementStepPhase =
  ListingReplacementForwardStepPhase | "compensate";

interface PlannedListingReplacementStepBase {
  readonly sequence: number;
  readonly stepKey: string;
  readonly status: "pending";
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestPayload: Readonly<Record<string, CanonicalJsonValue>>;
  readonly attemptLimit: number;
}

export type PlannedListingReplacementStep = PlannedListingReplacementStepBase &
  (
    | Readonly<{
        executionPath: "forward";
        phase: ListingReplacementForwardStepPhase;
      }>
    | Readonly<{ executionPath: "compensation"; phase: "compensate" }>
  );

export interface ListingReplacementPlan {
  readonly planVersion: 1;
  readonly owner: ListingOwnerRef;
  readonly scopeId: number;
  readonly sourcePublication: SourceListingPublicationSnapshot;
  readonly targetGeneration: number;
  readonly targetMembers: readonly PlannedListingMember[];
  readonly desiredStateHash: string;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  readonly requestedBy: ListingActor;
  readonly correlationId: string | null;
  readonly requestedAt: Date;
  readonly steps: readonly PlannedListingReplacementStep[];
}

export interface BuildListingReplacementPlanInput {
  readonly snapshot: ListingOwnerSnapshot;
  readonly requestedMembers: readonly RequestedListingMember[];
  readonly idempotencyKey: string;
  readonly requestedBy: ListingActor;
  readonly correlationId: string | null;
  readonly requestedAt: Date;
}

export interface BuildListingReplacementRequestHashInput {
  readonly owner: ListingOwnerRef;
  readonly requestedMembers: readonly RequestedListingMember[];
  readonly requestedBy: ListingActor;
}

interface StepBlueprintBase {
  readonly stepKey: string;
  readonly attemptLimit: number;
  readonly orderWithinPhase: number;
}

type StepBlueprint = StepBlueprintBase &
  (
    | Readonly<{
        executionPath: "forward";
        phase: ListingReplacementForwardStepPhase;
      }>
    | Readonly<{ executionPath: "compensation"; phase: "compensate" }>
  );

const PHASE_ORDER: Readonly<Record<ListingReplacementPhase, number>> = {
  preflight: 1,
  cutover: 2,
  publish: 3,
  verify: 4,
  switch_mapping: 5,
  compensate: 6,
  complete: 7,
};

const EXECUTION_PATH_ORDER: Readonly<
  Record<ListingReplacementStepPath, number>
> = {
  forward: 1,
  compensation: 2,
};

// Provider adapters will implement these semantic steps in a later stage.
// Stage 1 only persists a deterministic, provider-neutral plan.
const REPLACEMENT_STEP_BLUEPRINTS: readonly StepBlueprint[] = [
  {
    executionPath: "forward",
    phase: "verify",
    stepKey: "verify.target_publication",
    attemptLimit: 5,
    orderWithinPhase: 1,
  },
  {
    executionPath: "forward",
    phase: "preflight",
    stepKey: "preflight.validate_plan",
    attemptLimit: 3,
    orderWithinPhase: 1,
  },
  {
    executionPath: "compensation",
    phase: "compensate",
    stepKey: "compensate.ensure_target_not_sellable",
    attemptLimit: 5,
    orderWithinPhase: 1,
  },
  {
    executionPath: "compensation",
    phase: "compensate",
    stepKey: "compensate.ensure_source_live",
    attemptLimit: 5,
    orderWithinPhase: 2,
  },
  {
    executionPath: "forward",
    phase: "publish",
    stepKey: "publish.create_target",
    attemptLimit: 5,
    orderWithinPhase: 1,
  },
  {
    executionPath: "forward",
    phase: "switch_mapping",
    stepKey: "switch_mapping.activate_target",
    attemptLimit: 3,
    orderWithinPhase: 1,
  },
  {
    executionPath: "forward",
    phase: "cutover",
    stepKey: "cutover.quiesce_source",
    attemptLimit: 5,
    orderWithinPhase: 1,
  },
] as const;

export function buildListingReplacementPlan(
  input: BuildListingReplacementPlanInput,
): ListingReplacementPlan {
  assertValidDate(input.requestedAt, "requestedAt");
  const targetMembers = buildDeterministicMemberPlan(
    input.snapshot.memberCandidates,
    input.requestedMembers,
  );
  const targetGeneration = input.snapshot.nextGeneration;
  if (
    !Number.isSafeInteger(targetGeneration) ||
    targetGeneration <= input.snapshot.sourcePublication.generation
  ) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_GENERATION_INVALID",
      "Next listing publication generation must be a safe integer after the active source.",
      {
        sourceGeneration: input.snapshot.sourcePublication.generation,
        nextGeneration: targetGeneration,
      },
    );
  }

  const desiredStateHash = sha256Canonical({
    owner: canonicalOwner(input.snapshot.owner),
    targetMembers: targetMembers.map(canonicalMember),
  });
  const sortedBlueprints = sortStepBlueprints(REPLACEMENT_STEP_BLUEPRINTS);
  const requestHash = buildListingReplacementRequestHash({
    owner: input.snapshot.owner,
    requestedMembers: input.requestedMembers,
    requestedBy: input.requestedBy,
  });
  const nextSequenceByPath = new Map<ListingReplacementStepPath, number>();
  const steps = sortedBlueprints.map((blueprint) => {
    const sequence = (nextSequenceByPath.get(blueprint.executionPath) ?? 0) + 1;
    nextSequenceByPath.set(blueprint.executionPath, sequence);
    const requestPayload = {
      planVersion: 1,
      executionPath: blueprint.executionPath,
      stepKey: blueprint.stepKey,
      phase: blueprint.phase,
      sourcePublicationId: input.snapshot.sourcePublication.publicationId,
      targetGeneration,
      desiredStateHash,
    } as const satisfies Readonly<Record<string, CanonicalJsonValue>>;
    const stepRequestHash = sha256Canonical(requestPayload);
    const commonStep = {
      sequence,
      stepKey: blueprint.stepKey,
      status: "pending" as const,
      idempotencyKey: `marketplace-replacement-step:${sha256Canonical({
        operationRequestHash: requestHash,
        operationIdempotencyKey: input.idempotencyKey,
        scopeId: input.snapshot.scopeId,
        sourcePublicationId: input.snapshot.sourcePublication.publicationId,
        targetGeneration,
        executionPath: blueprint.executionPath,
        sequence,
        stepKey: blueprint.stepKey,
        stepRequestHash,
      })}`,
      requestHash: stepRequestHash,
      requestPayload,
      attemptLimit: blueprint.attemptLimit,
    } satisfies PlannedListingReplacementStepBase;
    if (blueprint.executionPath === "forward") {
      return {
        ...commonStep,
        executionPath: "forward",
        phase: blueprint.phase,
      } satisfies PlannedListingReplacementStep;
    }
    return {
      ...commonStep,
      executionPath: "compensation",
      phase: blueprint.phase,
    } satisfies PlannedListingReplacementStep;
  });

  return {
    planVersion: 1,
    owner: cloneOwner(input.snapshot.owner),
    scopeId: input.snapshot.scopeId,
    sourcePublication: { ...input.snapshot.sourcePublication },
    targetGeneration,
    targetMembers,
    desiredStateHash,
    requestHash,
    idempotencyKey: input.idempotencyKey,
    requestedBy: { ...input.requestedBy },
    correlationId: input.correlationId,
    requestedAt: new Date(input.requestedAt.getTime()),
    steps,
  };
}

export function buildListingReplacementRequestHash(
  input: BuildListingReplacementRequestHashInput,
): string {
  const requestedMembers = sortRequestedMembersForHash(input.requestedMembers);
  return sha256Canonical({
    idempotencyContractVersion: 1,
    owner: canonicalOwner(input.owner),
    targetMembers: requestedMembers.map(canonicalRequestedMember),
    requestedBy: canonicalActor(input.requestedBy),
  });
}

export function buildDeterministicMemberPlan(
  candidates: readonly ListingMemberCandidate[],
  requestedMembers: readonly RequestedListingMember[],
): readonly PlannedListingMember[] {
  const candidateByVariantId = new Map<number, ListingMemberCandidate>();
  const candidateVariantIdsBySku = new Map<string, number[]>();
  for (const candidate of candidates) {
    if (candidateByVariantId.has(candidate.productVariantId)) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_DUPLICATE_MEMBER",
        "Owner listing snapshot contains a duplicate product variant.",
        { productVariantId: candidate.productVariantId },
      );
    }

    const skuSnapshot = normalizeSkuSnapshot(candidate.sku);
    const variantIds = candidateVariantIdsBySku.get(skuSnapshot) ?? [];
    variantIds.push(candidate.productVariantId);
    candidateVariantIdsBySku.set(skuSnapshot, variantIds);
    candidateByVariantId.set(candidate.productVariantId, {
      ...candidate,
      sku: skuSnapshot,
    });
  }

  const duplicateSku = [...candidateVariantIdsBySku.entries()]
    .filter(([, variantIds]) => variantIds.length > 1)
    .map(([skuSnapshot, variantIds]) => ({
      skuSnapshot,
      productVariantIds: [...variantIds].sort((left, right) => left - right),
    }))
    .sort((left, right) =>
      compareCanonicalText(left.skuSnapshot, right.skuSnapshot),
    )[0];
  if (duplicateSku !== undefined) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_DUPLICATE_SKU",
      "Owner listing snapshot contains duplicate SKU snapshots after normalization.",
      duplicateSku,
    );
  }

  const requestByVariantId = new Map<number, RequestedListingMember>();
  for (const member of requestedMembers) {
    if (requestByVariantId.has(member.productVariantId)) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_DUPLICATE_MEMBER",
        "Listing replacement request contains a duplicate product variant.",
        { productVariantId: member.productVariantId },
      );
    }
    requestByVariantId.set(member.productVariantId, member);
  }

  const unknownVariantIds = [...requestByVariantId.keys()]
    .filter((variantId) => !candidateByVariantId.has(variantId))
    .sort((left, right) => left - right);
  if (unknownVariantIds.length > 0) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_UNKNOWN_MEMBER",
      "Listing replacement request contains a variant outside the owner snapshot.",
      { productVariantIds: unknownVariantIds },
    );
  }

  const omittedVariantIds = [...candidateByVariantId.keys()]
    .filter((variantId) => !requestByVariantId.has(variantId))
    .sort((left, right) => left - right);
  if (omittedVariantIds.length > 0) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_MEMBER_PLAN_INCOMPLETE",
      "Listing replacement request must explicitly include or exclude every owner snapshot variant.",
      { productVariantIds: omittedVariantIds },
    );
  }

  const members = requestedMembers.map((requested) => {
    const candidate = candidateByVariantId.get(requested.productVariantId)!;
    return {
      productVariantId: requested.productVariantId,
      skuSnapshot: candidate.sku,
      disposition: requested.disposition,
      reasonCode: requested.reasonCode,
    } satisfies PlannedListingMember;
  });
  if (!members.some((member) => member.disposition === "included")) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_INCLUDED_MEMBER_REQUIRED",
      "Replacement publication must include at least one product variant.",
    );
  }

  return members.sort((left, right) => {
    const byVariantId = left.productVariantId - right.productVariantId;
    if (byVariantId !== 0) return byVariantId;
    const bySku = compareCanonicalText(left.skuSnapshot, right.skuSnapshot);
    if (bySku !== 0) return bySku;
    return compareCanonicalText(left.disposition, right.disposition);
  });
}

function sortRequestedMembersForHash(
  requestedMembers: readonly RequestedListingMember[],
): RequestedListingMember[] {
  const seen = new Set<number>();
  for (const member of requestedMembers) {
    if (seen.has(member.productVariantId)) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_DUPLICATE_MEMBER",
        "Listing replacement request contains a duplicate product variant.",
        { productVariantId: member.productVariantId },
      );
    }
    seen.add(member.productVariantId);
  }
  return [...requestedMembers].sort((left, right) => {
    const byVariantId = left.productVariantId - right.productVariantId;
    return byVariantId !== 0
      ? byVariantId
      : compareCanonicalText(left.disposition, right.disposition);
  });
}

function sortStepBlueprints(steps: readonly StepBlueprint[]): StepBlueprint[] {
  return [...steps].sort((left, right) => {
    const byPath =
      EXECUTION_PATH_ORDER[left.executionPath] -
      EXECUTION_PATH_ORDER[right.executionPath];
    if (byPath !== 0) return byPath;
    const byPhase = PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase];
    if (byPhase !== 0) return byPhase;
    const byOrder = left.orderWithinPhase - right.orderWithinPhase;
    return byOrder !== 0
      ? byOrder
      : compareCanonicalText(left.stepKey, right.stepKey);
  });
}

function canonicalOwner(owner: ListingOwnerRef): CanonicalJsonValue {
  if (owner.kind === "channel") {
    return {
      kind: owner.kind,
      channelId: owner.channelId,
      productId: owner.productId,
      provider: owner.provider,
      marketplaceId: owner.marketplaceId,
    };
  }
  return {
    kind: owner.kind,
    storeConnectionId: owner.storeConnectionId,
    productId: owner.productId,
    provider: owner.provider,
    marketplaceId: owner.marketplaceId,
  };
}

function canonicalActor(actor: ListingActor): CanonicalJsonValue {
  return { type: actor.type, id: actor.id };
}

function canonicalRequestedMember(
  member: RequestedListingMember,
): CanonicalJsonValue {
  return {
    productVariantId: member.productVariantId,
    disposition: member.disposition,
    reasonCode: member.reasonCode,
  };
}

function canonicalMember(member: PlannedListingMember): CanonicalJsonValue {
  return {
    productVariantId: member.productVariantId,
    skuSnapshot: member.skuSnapshot,
    disposition: member.disposition,
    reasonCode: member.reasonCode,
  };
}

function cloneOwner(owner: ListingOwnerRef): ListingOwnerRef {
  return owner.kind === "channel" ? { ...owner } : { ...owner };
}

function normalizeSkuSnapshot(value: string): string {
  if (typeof value !== "string") {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_SKU_INVALID",
      "Owner listing snapshot SKU must be a string.",
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_SKU_INVALID",
      "Owner listing snapshot SKU must contain between 1 and 100 normalized characters.",
      { skuLength: normalized.length },
    );
  }
  return normalized;
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_TIMESTAMP_INVALID",
      `Marketplace listing replacement ${field} must be a valid Date.`,
      { field },
    );
  }
}
