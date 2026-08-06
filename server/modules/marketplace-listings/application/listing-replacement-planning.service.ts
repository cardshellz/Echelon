import { z } from "zod";

import { MarketplaceListingReplacementError } from "../domain/errors";
import {
  buildListingReplacementPlan,
  buildListingReplacementRequestHash,
  type ListingOwnerRef,
  type ListingReplacementPlan,
} from "../domain/listing-replacement-plan";
import {
  createOrReplayListingReplacementResultSchema,
  listingOwnerSnapshotSchema,
  listingReplacementOperationSchema,
  planListingReplacementInputSchema,
  type CreateOrReplayListingReplacementResult,
  type ListingReplacementOperation,
} from "./dtos";
import type {
  ListingReplacementReplayLookup,
  MarketplaceListingOwnerReader,
  MarketplaceListingReplacementClock,
  MarketplaceListingReplacementRepository,
} from "./ports";

export type PlanListingReplacementResult =
  | Readonly<{
      kind: "created";
      operation: ListingReplacementOperation;
      plan: ListingReplacementPlan;
    }>
  | Readonly<{
      kind: "replay";
      operation: ListingReplacementOperation;
      plan: null;
    }>;

export class ListingReplacementPlanningService {
  constructor(
    private readonly dependencies: {
      repository: MarketplaceListingReplacementRepository;
      ownerReader: MarketplaceListingOwnerReader;
      clock: MarketplaceListingReplacementClock;
    },
  ) {}

  async plan(input: unknown): Promise<PlanListingReplacementResult> {
    const parsed = parseBoundary(
      planListingReplacementInputSchema,
      input,
      "MARKETPLACE_LISTING_REPLACEMENT_INPUT_INVALID",
      "Marketplace listing replacement planning input failed validation.",
    );
    const requestHash = buildListingReplacementRequestHash({
      owner: parsed.owner,
      requestedMembers: parsed.targetMembers,
      requestedBy: parsed.requestedBy,
    });
    const replayValue = await this.findReplay({
      owner: parsed.owner,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
    });
    if (replayValue !== null) {
      const operation = parseBoundary(
        listingReplacementOperationSchema,
        replayValue,
        "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_RESULT_INVALID",
        "Marketplace listing replacement repository returned an invalid replay result.",
      );
      assertOperationMatchesRequest(
        operation,
        parsed.idempotencyKey,
        requestHash,
      );
      return { kind: "replay", operation, plan: null };
    }

    const snapshotValue = await this.loadOwnerSnapshot(parsed.owner);
    const snapshot = parseBoundary(
      listingOwnerSnapshotSchema,
      snapshotValue,
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_INVALID",
      "Marketplace listing owner returned an invalid planning snapshot.",
    );
    if (!sameOwner(snapshot.owner, parsed.owner)) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_MISMATCH",
        "Marketplace listing owner snapshot does not match the requested owner.",
        {
          requestedOwnerKind: parsed.owner.kind,
          snapshotOwnerKind: snapshot.owner.kind,
        },
      );
    }

    const plan = buildListingReplacementPlan({
      snapshot,
      requestedMembers: parsed.targetMembers,
      idempotencyKey: parsed.idempotencyKey,
      requestedBy: parsed.requestedBy,
      correlationId: parsed.correlationId ?? null,
      requestedAt: this.readRequestedAt(),
    });
    if (plan.requestHash !== requestHash) {
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_HASH_INCONSISTENT",
        "Marketplace listing replacement request hash changed during planning.",
        { scopeId: plan.scopeId },
      );
    }

    const repositoryValue = await this.createOrReplay(plan);
    const persisted = parseBoundary(
      createOrReplayListingReplacementResultSchema,
      repositoryValue,
      "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_RESULT_INVALID",
      "Marketplace listing replacement repository returned an invalid result.",
    );
    if (persisted.kind === "replay") {
      assertOperationCanResumePlan(persisted.operation, plan);
      return { kind: "replay", operation: persisted.operation, plan: null };
    }
    assertOperationMatchesRequest(
      persisted.operation,
      plan.idempotencyKey,
      plan.requestHash,
    );

    assertCreatedOperationMatchesPlan(persisted.operation, plan);
    return {
      kind: "created",
      operation: persisted.operation,
      plan,
    };
  }

  private readRequestedAt(): Date {
    try {
      return this.dependencies.clock.now();
    } catch (error) {
      if (error instanceof MarketplaceListingReplacementError) throw error;
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_CLOCK_FAILED",
        "Marketplace listing replacement clock could not provide the request time.",
        {},
        { cause: error },
      );
    }
  }

  private async findReplay(
    lookup: ListingReplacementReplayLookup,
  ): Promise<unknown> {
    try {
      return await this.dependencies.repository.findReplay(lookup);
    } catch (error) {
      if (error instanceof MarketplaceListingReplacementError) throw error;
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_REPLAY_LOOKUP_FAILED",
        "Marketplace listing replacement idempotency lookup failed.",
        { ownerKind: lookup.owner.kind },
        { cause: error },
      );
    }
  }

  private async loadOwnerSnapshot(owner: ListingOwnerRef): Promise<unknown> {
    try {
      return await this.dependencies.ownerReader.loadSnapshot(owner);
    } catch (error) {
      if (error instanceof MarketplaceListingReplacementError) throw error;
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_OWNER_READ_FAILED",
        "Marketplace listing owner snapshot could not be loaded.",
        { ownerKind: owner.kind },
        { cause: error },
      );
    }
  }

  private async createOrReplay(plan: ListingReplacementPlan): Promise<unknown> {
    try {
      return await this.dependencies.repository.createOrReplayPlan(plan);
    } catch (error) {
      if (error instanceof MarketplaceListingReplacementError) throw error;
      throw new MarketplaceListingReplacementError(
        "MARKETPLACE_LISTING_REPLACEMENT_PERSISTENCE_FAILED",
        "Marketplace listing replacement plan could not be persisted.",
        { scopeId: plan.scopeId },
        { cause: error },
      );
    }
  }
}

function parseBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
  message: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new MarketplaceListingReplacementError(code, message, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function sameOwner(left: ListingOwnerRef, right: ListingOwnerRef): boolean {
  if (left.kind !== right.kind) return false;
  if (
    left.productId !== right.productId ||
    left.provider !== right.provider ||
    left.marketplaceId !== right.marketplaceId
  ) {
    return false;
  }
  if (left.kind === "channel" && right.kind === "channel") {
    return left.channelId === right.channelId;
  }
  if (left.kind === "dropship" && right.kind === "dropship") {
    return left.storeConnectionId === right.storeConnectionId;
  }
  return false;
}

function assertOperationMatchesRequest(
  operation: ListingReplacementOperation,
  idempotencyKey: string,
  requestHash: string,
): void {
  if (
    operation.idempotencyKey === idempotencyKey &&
    operation.requestHash === requestHash
  ) {
    return;
  }
  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_INTEGRITY_ERROR",
    "Marketplace listing replacement repository result does not match the requested command.",
    { operationId: operation.operationId },
  );
}

function assertOperationCanResumePlan(
  operation: ListingReplacementOperation,
  plan: ListingReplacementPlan,
): void {
  const exactReplay =
    operation.idempotencyKey === plan.idempotencyKey &&
    operation.requestHash === plan.requestHash;
  const matchingActivePlan =
    operation.scopeId === plan.scopeId &&
    operation.sourcePublicationId === plan.sourcePublication.publicationId &&
    operation.desiredStateHash === plan.desiredStateHash &&
    ["planned", "running", "compensating", "manual_recovery_required"].includes(
      operation.status,
    );
  if (exactReplay || matchingActivePlan) return;
  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_INTEGRITY_ERROR",
    "Marketplace listing replacement replay does not match the requested plan.",
    { operationId: operation.operationId, scopeId: plan.scopeId },
  );
}

function assertCreatedOperationMatchesPlan(
  operation: ListingReplacementOperation,
  plan: ListingReplacementPlan,
): void {
  const mismatch =
    operation.scopeId !== plan.scopeId ||
    operation.sourcePublicationId !== plan.sourcePublication.publicationId ||
    operation.targetPublicationId === plan.sourcePublication.publicationId ||
    operation.desiredStateHash !== plan.desiredStateHash ||
    operation.status !== "planned" ||
    operation.currentPhase !== "preflight" ||
    operation.stateVersion !== 1;
  if (mismatch) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_INTEGRITY_ERROR",
      "Marketplace listing replacement repository result does not match the planned command.",
      {
        operationId: operation.operationId,
        scopeId: plan.scopeId,
      },
    );
  }
}
