import { describe, expect, it, vi } from "vitest";
import { ListingReplacementExecutionService } from "../../application/listing-replacement-execution.service";
import type {
  ClaimedListingReplacementStep,
  MarketplaceListingReplacementExecutionRepository,
  MarketplaceListingReplacementProvider,
} from "../../application/execution-ports";

describe("ListingReplacementExecutionService", () => {
  it("dispatches a provider step and persists its evidence", async () => {
    const harness = makeHarness(claim("publish.create_target"));
    harness.provider.createTarget.mockResolvedValue({
      evidence: { listingId: "new-1" },
      externalListingId: "new-1",
    });
    await expect(harness.service.execute(command())).resolves.toEqual({
      kind: "idle",
    });
    expect(harness.provider.createTarget).toHaveBeenCalledWith(
      harness.claim.operation,
      harness.claim.idempotencyKey,
    );
    expect(harness.repository.completeStep).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: harness.claim,
        result: expect.objectContaining({ externalListingId: "new-1" }),
      }),
    );
    expect(harness.repository.claimNextStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        leaseToken: harness.claim.leaseToken,
      }),
    );
  });

  it("keeps mapping activation repository-owned and completes the operation", async () => {
    const harness = makeHarness(claim("switch_mapping.activate_target"));
    await expect(harness.service.execute(command())).resolves.toEqual({
      kind: "completed",
      stepKey: "switch_mapping.activate_target",
    });
    expect(
      harness.repository.activateTargetAndCompleteOperation,
    ).toHaveBeenCalledWith(expect.objectContaining({ claim: harness.claim }));
    expect(harness.providers.forOwner).not.toHaveBeenCalled();
  });

  it("starts compensation when a post-preflight provider step fails", async () => {
    const harness = makeHarness(claim("cutover.quiesce_source"));
    harness.provider.quiesceSource.mockRejectedValue(
      new Error("eBay unavailable"),
    );
    await expect(harness.service.execute(command())).resolves.toEqual({
      kind: "idle",
    });
    expect(harness.repository.beginCompensation).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: harness.claim,
        errorCode: "MARKETPLACE_LISTING_REPLACEMENT_PROVIDER_FAILED",
      }),
    );
  });

  it("requires manual recovery when a compensation step fails", async () => {
    const harness = makeHarness(claim("compensate.ensure_source_live"));
    harness.provider.ensureSourceLive.mockRejectedValue(
      new Error("source cannot be restored"),
    );
    await expect(harness.service.execute(command())).resolves.toEqual({
      kind: "manual_recovery_required",
      stepKey: "compensate.ensure_source_live",
    });
    expect(harness.repository.requireManualRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ claim: harness.claim }),
    );
  });
});

function command() {
  return { operationId: 100, actor: { type: "user" as const, id: "admin-1" } };
}
function claim(
  stepKey: ClaimedListingReplacementStep["stepKey"],
): ClaimedListingReplacementStep {
  return {
    executor: { type: "user", id: "admin-1" },
    operation: {
      operationId: 100,
      operationStateVersion: 2,
      owner: {
        kind: "channel",
        channelId: 7,
        productId: 33,
        provider: "ebay",
        marketplaceId: "EBAY_US",
      },
      sourcePublication: {
        publicationId: 51,
        generation: 2,
        status: "active",
        desiredStateHash: "a".repeat(64),
        providerPublicationKey: "ARM-ENV-SGL",
        externalListingId: "old-1",
      },
      targetPublicationId: 52,
      targetGeneration: 3,
      desiredStateHash: "b".repeat(64),
      targetMembers: [
        {
          productVariantId: 12,
          skuSnapshot: "ARM-ENV-SGL-C750",
          disposition: "included",
          reasonCode: null,
        },
      ],
      actor: { type: "user", id: "admin-1" },
      correlationId: null,
    },
    stepId: 200,
    stepStateVersion: 2,
    stepKey,
    idempotencyKey: "step-key",
    requestHash: "c".repeat(64),
    attempt: 1,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    leaseExpiresAt: new Date("2026-08-04T12:01:00Z"),
  };
}
function makeHarness(currentClaim: ClaimedListingReplacementStep) {
  const repository = {
    claimNextStep: vi
      .fn()
      .mockResolvedValueOnce(currentClaim)
      .mockResolvedValueOnce(null),
    completeStep: vi.fn(async () => undefined),
    activateTargetAndCompleteOperation: vi.fn(async () => undefined),
    failPreflight: vi.fn(async () => undefined),
    beginCompensation: vi.fn(async () => undefined),
    requireManualRecovery: vi.fn(async () => undefined),
    completeCompensationAndFailOperation: vi.fn(async () => undefined),
  } satisfies MarketplaceListingReplacementExecutionRepository;
  const provider = {
    preflight: vi.fn(),
    quiesceSource: vi.fn(),
    createTarget: vi.fn(),
    verifyTarget: vi.fn(),
    ensureTargetNotSellable: vi.fn(),
    ensureSourceLive: vi.fn(),
  } satisfies MarketplaceListingReplacementProvider;
  const providers = { forOwner: vi.fn(() => provider) };
  const service = new ListingReplacementExecutionService({
    repository,
    providers,
    clock: { now: () => new Date("2026-08-04T12:00:00Z") },
  });
  return { service, repository, provider, providers, claim: currentClaim };
}
