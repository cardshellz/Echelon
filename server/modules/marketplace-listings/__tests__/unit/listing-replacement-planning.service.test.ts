import { describe, expect, it } from "vitest";

import type {
  CreateOrReplayListingReplacementResult,
  ListingReplacementOperation,
} from "../../application/dtos";
import { ListingReplacementPlanningService } from "../../application/listing-replacement-planning.service";
import type {
  ListingReplacementReplayLookup,
  MarketplaceListingOwnerReader,
  MarketplaceListingReplacementClock,
  MarketplaceListingReplacementRepository,
} from "../../application/ports";
import { MarketplaceListingReplacementError } from "../../domain/errors";
import type {
  ListingOwnerRef,
  ListingOwnerSnapshot,
  ListingReplacementPlan,
} from "../../domain/listing-replacement-plan";

describe("ListingReplacementPlanningService", () => {
  it("replays before reading mutable owner state again", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = new InMemoryPlanningRepository();
    const service = createService(repository, ownerReader);

    const first = await service.plan(command());
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("Expected a created result.");

    ownerReader.setSnapshot(advancedOwnerSnapshot());
    const replay = await service.plan(
      command({ correlationId: "retry-correlation" }),
    );

    expect(replay.kind).toBe("replay");
    if (replay.kind !== "replay") throw new Error("Expected a replay result.");
    expect(replay.operation).toEqual(first.operation);
    expect(replay.plan).toBeNull();
    expect(repository.createdCount).toBe(1);
    expect(repository.lookupCount).toBe(2);
    expect(ownerReader.calls).toBe(1);
    expect(ownerReader.lastOwner).toEqual({
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    });
    expect(
      first.plan.targetMembers.map((member) => member.productVariantId),
    ).toEqual([66, 67, 438]);
  });

  it("rejects a changed command before reading owner state again", async () => {
    const repository = new InMemoryPlanningRepository();
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const service = createService(repository, ownerReader);
    await service.plan(command());

    await expect(
      service.plan(
        command({
          targetMembers: [
            { productVariantId: 66, disposition: "included", reasonCode: null },
            {
              productVariantId: 67,
              disposition: "excluded",
              reasonCode: "replaced_by_case_750",
            },
            {
              productVariantId: 438,
              disposition: "included",
              reasonCode: null,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_IDEMPOTENCY_CONFLICT",
    });
    expect(repository.createdCount).toBe(1);
    expect(ownerReader.calls).toBe(1);
  });

  it("validates a strict command before repository or owner reads", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = new InMemoryPlanningRepository();
    const service = createService(repository, ownerReader);

    await expect(
      service.plan({ ...command(), unexpected: true }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_INPUT_INVALID",
    });
    expect(repository.lookupCount).toBe(0);
    expect(ownerReader.calls).toBe(0);
  });

  it("rejects an owner snapshot for a different internal owner", async () => {
    const snapshot = ownerSnapshot();
    const ownerReader = new FakeOwnerReader({
      ...snapshot,
      owner: { ...snapshot.owner, channelId: 999 },
    });
    const service = createService(
      new InMemoryPlanningRepository(),
      ownerReader,
    );

    await expect(service.plan(command())).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_MISMATCH",
    });
  });

  it("classifies an unstructured replay lookup failure", async () => {
    const failure = new Error("replay storage unavailable");
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async findReplay() {
        throw failure;
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_REPLAY_LOOKUP_FAILED",
      cause: failure,
    });
    expect(ownerReader.calls).toBe(0);
  });

  it("classifies an unstructured owner snapshot read failure", async () => {
    const failure = new Error("owner storage unavailable");
    const repository = new InMemoryPlanningRepository();
    const ownerReader: MarketplaceListingOwnerReader = {
      async loadSnapshot() {
        throw failure;
      },
    };

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_OWNER_READ_FAILED",
      cause: failure,
    });
    expect(repository.lookupCount).toBe(1);
    expect(repository.createdCount).toBe(0);
  });

  it("classifies an unstructured persistence failure", async () => {
    const failure = new Error("planning transaction unavailable");
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async createOrReplayPlan() {
        throw failure;
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_PERSISTENCE_FAILED",
      cause: failure,
    });
    expect(ownerReader.calls).toBe(1);
  });

  it("rejects an invalid owner snapshot result before persistence", async () => {
    const repository = new InMemoryPlanningRepository();
    const ownerReader: MarketplaceListingOwnerReader = {
      async loadSnapshot() {
        return {};
      },
    };

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_OWNER_SNAPSHOT_INVALID",
    });
    expect(repository.lookupCount).toBe(1);
    expect(repository.createdCount).toBe(0);
  });

  it("rejects an invalid early replay result", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async findReplay() {
        return { invalid: true } as unknown as ListingReplacementOperation;
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_RESULT_INVALID",
    });
    expect(ownerReader.calls).toBe(0);
  });

  it("rejects an early replay that does not match the command", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async findReplay(lookup) {
        return operationForLookup(lookup, { requestHash: "f".repeat(64) });
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_INTEGRITY_ERROR",
    });
    expect(ownerReader.calls).toBe(0);
  });

  it("rejects an invalid post-lock repository result", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async createOrReplayPlan() {
        return {
          kind: "created",
          operation: { invalid: true },
        } as unknown as CreateOrReplayListingReplacementResult;
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_RESULT_INVALID",
    });
    expect(ownerReader.calls).toBe(1);
  });

  it("resumes a matching active plan created with an earlier idempotency key", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async createOrReplayPlan(plan) {
        return {
          kind: "replay",
          operation: operationForPlan(plan, {
            idempotencyKey: "different-operation-key",
          }),
        };
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).resolves.toMatchObject({
      kind: "replay",
      operation: { idempotencyKey: "different-operation-key" },
      plan: null,
    });
    expect(ownerReader.calls).toBe(1);
  });
  it("returns a replay when a concurrent request wins after the early lookup", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    let createCalls = 0;
    const repository = repositoryDouble({
      async createOrReplayPlan(plan) {
        createCalls += 1;
        return { kind: "replay", operation: operationForPlan(plan) };
      },
    });

    const result = await createService(repository, ownerReader).plan(command());

    expect(result).toMatchObject({
      kind: "replay",
      operation: { operationId: 3001 },
      plan: null,
    });
    expect(createCalls).toBe(1);
    expect(ownerReader.calls).toBe(1);
  });

  it("rejects a created operation that does not match its plan", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const repository = repositoryDouble({
      async createOrReplayPlan(plan) {
        return {
          kind: "created",
          operation: operationForPlan(plan, { scopeId: plan.scopeId + 1 }),
        };
      },
    });

    await expect(
      createService(repository, ownerReader).plan(command()),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_REPOSITORY_INTEGRITY_ERROR",
    });
    expect(ownerReader.calls).toBe(1);
  });

  it("classifies a thrown clock failure and does not persist a plan", async () => {
    const repository = new InMemoryPlanningRepository();
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const clockFailure = new Error("clock unavailable");
    const service = createService(repository, ownerReader, {
      now(): Date {
        throw clockFailure;
      },
    });

    await expect(service.plan(command())).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_CLOCK_FAILED",
      cause: clockFailure,
    });
    expect(repository.lookupCount).toBe(1);
    expect(ownerReader.calls).toBe(1);
    expect(repository.createdCount).toBe(0);
  });

  it("rejects an invalid clock value through the timestamp contract", async () => {
    const repository = new InMemoryPlanningRepository();
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const service = createService(
      repository,
      ownerReader,
      new FixedClock(new Date(Number.NaN)),
    );

    await expect(service.plan(command())).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_TIMESTAMP_INVALID",
      context: { field: "requestedAt" },
    });
    expect(repository.lookupCount).toBe(1);
    expect(ownerReader.calls).toBe(1);
    expect(repository.createdCount).toBe(0);
  });
});

class FixedClock implements MarketplaceListingReplacementClock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value.getTime());
  }
}

class FakeOwnerReader implements MarketplaceListingOwnerReader {
  calls = 0;
  lastOwner: ListingOwnerRef | null = null;

  constructor(private snapshot: ListingOwnerSnapshot) {}

  setSnapshot(snapshot: ListingOwnerSnapshot): void {
    this.snapshot = snapshot;
  }

  async loadSnapshot(owner: ListingOwnerRef): Promise<unknown> {
    this.calls += 1;
    this.lastOwner = owner;
    return this.snapshot;
  }
}

class InMemoryPlanningRepository implements MarketplaceListingReplacementRepository {
  private readonly operations = new Map<string, ListingReplacementOperation>();
  createdCount = 0;
  lookupCount = 0;

  async findReplay(
    lookup: ListingReplacementReplayLookup,
  ): Promise<ListingReplacementOperation | null> {
    this.lookupCount += 1;
    const existing = this.operations.get(
      repositoryKey(lookup.owner, lookup.idempotencyKey),
    );
    if (!existing) return null;
    assertMatchingHash(existing, lookup.requestHash);
    return existing;
  }

  async createOrReplayPlan(
    plan: ListingReplacementPlan,
  ): Promise<CreateOrReplayListingReplacementResult> {
    const key = repositoryKey(plan.owner, plan.idempotencyKey);
    const existing = this.operations.get(key);
    if (existing) {
      assertMatchingHash(existing, plan.requestHash);
      return { kind: "replay", operation: existing };
    }

    const timestamp = new Date(plan.requestedAt.getTime());
    const operation: ListingReplacementOperation = {
      operationId: this.operations.size + 1,
      scopeId: plan.scopeId,
      sourcePublicationId: plan.sourcePublication.publicationId,
      targetPublicationId: 10_000 + this.operations.size,
      idempotencyKey: plan.idempotencyKey,
      requestHash: plan.requestHash,
      desiredStateHash: plan.desiredStateHash,
      status: "planned",
      currentPhase: "preflight",
      stateVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations.set(key, operation);
    this.createdCount += 1;
    return { kind: "created", operation };
  }
}

function repositoryDouble(
  overrides: Partial<MarketplaceListingReplacementRepository> = {},
): MarketplaceListingReplacementRepository {
  const repository: MarketplaceListingReplacementRepository = {
    async findReplay() {
      return null;
    },
    async createOrReplayPlan(plan) {
      return { kind: "created", operation: operationForPlan(plan) };
    },
  };
  return { ...repository, ...overrides };
}

function operationForLookup(
  lookup: ListingReplacementReplayLookup,
  overrides: Partial<ListingReplacementOperation> = {},
): ListingReplacementOperation {
  const timestamp = new Date("2026-08-04T12:00:00.000Z");
  return {
    operationId: 3001,
    scopeId: 51,
    sourcePublicationId: 1001,
    targetPublicationId: 2002,
    idempotencyKey: lookup.idempotencyKey,
    requestHash: lookup.requestHash,
    desiredStateHash: "d".repeat(64),
    status: "planned",
    currentPhase: "preflight",
    stateVersion: 1,
    createdAt: timestamp,
    updatedAt: new Date(timestamp.getTime()),
    ...overrides,
  };
}

function operationForPlan(
  plan: ListingReplacementPlan,
  overrides: Partial<ListingReplacementOperation> = {},
): ListingReplacementOperation {
  const timestamp = new Date(plan.requestedAt.getTime());
  return {
    operationId: 3001,
    scopeId: plan.scopeId,
    sourcePublicationId: plan.sourcePublication.publicationId,
    targetPublicationId: 2002,
    idempotencyKey: plan.idempotencyKey,
    requestHash: plan.requestHash,
    desiredStateHash: plan.desiredStateHash,
    status: "planned",
    currentPhase: "preflight",
    stateVersion: 1,
    createdAt: timestamp,
    updatedAt: new Date(timestamp.getTime()),
    ...overrides,
  };
}

function assertMatchingHash(
  existing: ListingReplacementOperation,
  requestHash: string,
): void {
  if (existing.requestHash === requestHash) return;
  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_IDEMPOTENCY_CONFLICT",
    "Listing replacement idempotency key was reused with a different request.",
    { operationId: existing.operationId, scopeId: existing.scopeId },
  );
}

function repositoryKey(owner: ListingOwnerRef, idempotencyKey: string): string {
  const ownerId =
    owner.kind === "channel" ? owner.channelId : owner.storeConnectionId;
  return [
    owner.kind,
    ownerId,
    owner.productId,
    owner.provider,
    owner.marketplaceId,
    idempotencyKey,
  ].join(":");
}

function createService(
  repository: MarketplaceListingReplacementRepository,
  ownerReader: MarketplaceListingOwnerReader,
  clock: MarketplaceListingReplacementClock = new FixedClock(
    new Date("2026-08-04T12:00:00.000Z"),
  ),
): ListingReplacementPlanningService {
  return new ListingReplacementPlanningService({
    repository,
    ownerReader,
    clock,
  });
}

function ownerSnapshot(): ListingOwnerSnapshot {
  return {
    owner: {
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    },
    scopeId: 51,
    sourcePublication: {
      publicationId: 1001,
      generation: 1,
      status: "active",
      desiredStateHash: "a".repeat(64),
      providerPublicationKey: "ARM-ENV-SGL",
      externalListingId: "298148438778",
    },
    nextGeneration: 2,
    memberCandidates: [
      {
        productVariantId: 438,
        sku: "ARM-ENV-SGL-C750",
        currentlyPublished: false,
      },
      {
        productVariantId: 67,
        sku: "ARM-ENV-SGL-C700",
        currentlyPublished: true,
      },
      {
        productVariantId: 66,
        sku: "ARM-ENV-SGL-P50",
        currentlyPublished: true,
      },
    ],
  };
}

function advancedOwnerSnapshot(): ListingOwnerSnapshot {
  const original = ownerSnapshot();
  return {
    ...original,
    sourcePublication: {
      publicationId: 1002,
      generation: 2,
      status: "active",
      desiredStateHash: "b".repeat(64),
      providerPublicationKey: "ARM-ENV-SGL-V2",
      externalListingId: "398148438779",
    },
    nextGeneration: 3,
    memberCandidates: original.memberCandidates.map((member) => ({
      ...member,
    })),
  };
}

function command(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    owner: {
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "EBAY",
      marketplaceId: " EBAY_US ",
    },
    targetMembers: [
      { productVariantId: 438, disposition: "included", reasonCode: null },
      {
        productVariantId: 67,
        disposition: "excluded",
        reasonCode: "variant_inactive",
      },
      { productVariantId: 66, disposition: "included", reasonCode: null },
    ],
    idempotencyKey: "replace-arm-env-sgl-2026-08-04",
    requestedBy: { type: "user", id: "owner@example.test" },
    correlationId: "replacement-test",
    ...overrides,
  };
}
