import { describe, expect, it } from "vitest";

import type {
  ConfirmListingRegistrationInput,
  ListingRegistrationReceipt,
  ListingRegistrationStatus,
} from "../../application/registration-dtos";
import { MarketplaceListingRegistrationService } from "../../application/listing-registration.service";
import { buildListingRegistrationRequestHash } from "../../domain/listing-registration-plan";
import type { ListingOwnerRef } from "../../domain/listing-replacement-plan";
import type {
  MarketplaceListingProviderAccountClaim,
  MarketplaceListingProviderAccountClaimer,
  MarketplaceListingRegistrationObserver,
  MarketplaceListingRegistrationOwnerReader,
  MarketplaceListingRegistrationRepository,
  ObserveMarketplaceListingInput,
  PersistListingRegistrationInput,
} from "../../application/registration-ports";

describe("MarketplaceListingRegistrationService", () => {
  it("validates an owner before loading current registration status", async () => {
    const repository = new FakeRepository();
    const service = createService(
      new FakeOwnerReader(ownerSnapshot()),
      new FakeObserver(observation()),
      new FakeClaimer(),
      repository,
    );

    await expect(
      service.getCurrentRegistrationStatus({
        ...command().owner,
        productId: 0,
      } as ListingOwnerRef),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
    });
    expect(repository.statusCalls).toBe(0);
  });

  it("returns the strict persisted current registration status", async () => {
    const repository = new FakeRepository();
    repository.status = registrationStatus();
    const service = createService(
      new FakeOwnerReader(ownerSnapshot()),
      new FakeObserver(observation()),
      new FakeClaimer(),
      repository,
    );

    await expect(
      service.getCurrentRegistrationStatus(command().owner),
    ).resolves.toEqual(repository.status);
    expect(repository.statusCalls).toBe(1);
  });

  it("returns null when no persisted registration exists for the owner", async () => {
    const repository = new FakeRepository();
    const service = createService(
      new FakeOwnerReader(ownerSnapshot()),
      new FakeObserver(observation()),
      new FakeClaimer(),
      repository,
    );

    await expect(
      service.getCurrentRegistrationStatus(command().owner),
    ).resolves.toBeNull();
    expect(repository.statusCalls).toBe(1);
  });

  it("loads and sorts one-owner registration statuses in one repository call", async () => {
    const repository = new FakeRepository();
    repository.statuses = [
      { ...registrationStatus(), productId: 44 },
      registrationStatus(),
    ];
    const service = createService(
      new FakeOwnerReader(ownerSnapshot()),
      new FakeObserver(observation()),
      new FakeClaimer(),
      repository,
    );
    const owners = [
      { ...command().owner, productId: 44 },
      command().owner,
    ];

    await expect(service.getCurrentRegistrationStatuses(owners)).resolves.toEqual([
      registrationStatus(),
      { ...registrationStatus(), productId: 44 },
    ]);
    expect(repository.batchStatusCalls).toBe(1);
  });

  it("rejects mixed-owner or duplicate-product status batches", async () => {
    const repository = new FakeRepository();
    const service = createService(
      new FakeOwnerReader(ownerSnapshot()),
      new FakeObserver(observation()),
      new FakeClaimer(),
      repository,
    );

    await expect(
      service.getCurrentRegistrationStatuses([
        command().owner,
        { ...command().owner, channelId: 8, productId: 44 },
      ]),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
    });
    await expect(
      service.getCurrentRegistrationStatuses([
        command().owner,
        command().owner,
      ]),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
    });
    expect(repository.batchStatusCalls).toBe(0);
  });

  it("validates the owner snapshot before making a provider call", async () => {
    const ownerReader = new FakeOwnerReader({ invalid: true });
    const observer = new FakeObserver(observation());
    const claimer = new FakeClaimer();
    const repository = new FakeRepository();
    const service = createService(ownerReader, observer, claimer, repository);

    await expect(service.preview(command())).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_FAILED",
    });
    expect(ownerReader.calls).toBe(1);
    expect(observer.calls).toBe(0);
    expect(claimer.calls).toBe(0);
    expect(repository.registerCalls).toBe(0);
  });

  it("keeps preview read-only", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const observer = new FakeObserver(observation());
    const claimer = new FakeClaimer();
    const repository = new FakeRepository();
    const service = createService(ownerReader, observer, claimer, repository);

    const plan = await service.preview(command());

    expect(plan.observationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(observer.calls).toBe(1);
    expect(observer.lastInput?.memberCandidates).toEqual(
      ownerSnapshot().memberCandidates,
    );
    expect(claimer.calls).toBe(0);
    expect(repository.replayCalls).toBe(0);
    expect(repository.registerCalls).toBe(0);
  });

  it("re-observes and rejects changed provider state before claiming the account", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const observer = new FakeObserver(observation());
    const claimer = new FakeClaimer();
    const repository = new FakeRepository();
    const service = createService(ownerReader, observer, claimer, repository);
    const preview = await service.preview(command());
    const changedObservation = observation();
    observer.value = {
      ...changedObservation,
      members: changedObservation.members.map((member) => ({
        ...member,
        offerIdentity: {
          identityNamespace: "ebay.sell.inventory.offer",
          externalId: "changed-offer",
        },
      })),
    };

    await expect(
      service.confirm({
        ...command(),
        expectedObservationHash: preview.observationHash,
      }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_OBSERVATION_CHANGED",
    });
    expect(claimer.calls).toBe(0);
    expect(repository.registerCalls).toBe(0);
  });

  it("durably claims the stable account before marketplace persistence", async () => {
    const callOrder: string[] = [];
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const observer = new FakeObserver(observation());
    const claimer = new FakeClaimer(callOrder);
    const repository = new FakeRepository(callOrder);
    const service = createService(ownerReader, observer, claimer, repository);
    const preview = await service.preview(command());

    const result = await service.confirm({
      ...command(),
      expectedObservationHash: preview.observationHash,
    });

    expect(result.kind).toBe("created");
    expect(callOrder).toEqual(["claim", "register"]);
    expect(claimer.lastClaim?.providerAccount.externalAccountId).toBe(
      "provider-user-123",
    );
  });

  it("does not roll back a successful owner claim when marketplace persistence fails", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const observer = new FakeObserver(observation());
    const claimer = new FakeClaimer();
    const repository = new FakeRepository();
    repository.failure = new Error("database unavailable");
    const service = createService(ownerReader, observer, claimer, repository);
    const preview = await service.preview(command());

    await expect(
      service.confirm({
        ...command(),
        expectedObservationHash: preview.observationHash,
      }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_PERSISTENCE_FAILED",
    });
    expect(claimer.calls).toBe(1);
    expect(repository.registerCalls).toBe(1);
  });

  it("returns an early replay without owner, provider, or claimer calls", async () => {
    const ownerReader = new FakeOwnerReader(ownerSnapshot());
    const observer = new FakeObserver(observation());
    const claimer = new FakeClaimer();
    const repository = new FakeRepository();
    repository.replay = receipt();
    const service = createService(ownerReader, observer, claimer, repository);

    const result = await service.confirm({
      ...command(),
      expectedObservationHash: "d".repeat(64),
    });

    expect(result).toEqual({ kind: "replay", receipt: repository.replay });
    expect(ownerReader.calls).toBe(0);
    expect(observer.calls).toBe(0);
    expect(claimer.calls).toBe(0);
    expect(repository.registerCalls).toBe(0);
  });
});

class FakeOwnerReader implements MarketplaceListingRegistrationOwnerReader {
  calls = 0;
  constructor(public value: unknown) {}
  async loadRegistrationSnapshot(): Promise<unknown> {
    this.calls += 1;
    return this.value;
  }
}

class FakeObserver implements MarketplaceListingRegistrationObserver {
  calls = 0;
  lastInput: ObserveMarketplaceListingInput | null = null;
  constructor(public value: unknown) {}
  async observeExistingPublication(
    input: ObserveMarketplaceListingInput,
  ): Promise<unknown> {
    this.calls += 1;
    this.lastInput = input;
    return this.value;
  }
}

class FakeClaimer implements MarketplaceListingProviderAccountClaimer {
  calls = 0;
  lastClaim: MarketplaceListingProviderAccountClaim | null = null;
  constructor(private readonly callOrder: string[] = []) {}
  async claimStableProviderAccount(
    claim: MarketplaceListingProviderAccountClaim,
  ) {
    this.calls += 1;
    this.lastClaim = claim;
    this.callOrder.push("claim");
    return {
      kind: "claimed" as const,
      owner: claim.owner,
      provider: claim.providerAccount.provider,
      accountNamespace: claim.providerAccount.accountNamespace,
      externalAccountId: claim.providerAccount.externalAccountId,
      identityScheme: "provider_user_id" as const,
      verifiedAt: new Date("2026-08-04T12:00:01.000Z"),
    };
  }
}

class FakeRepository implements MarketplaceListingRegistrationRepository {
  statusCalls = 0;
  batchStatusCalls = 0;
  replayCalls = 0;
  registerCalls = 0;
  status: ListingRegistrationStatus | null = null;
  statuses: readonly ListingRegistrationStatus[] = [];
  replay: ListingRegistrationReceipt | null = null;
  failure: Error | null = null;
  constructor(private readonly callOrder: string[] = []) {}
  async findCurrentRegistration(): Promise<ListingRegistrationStatus | null> {
    this.statusCalls += 1;
    return this.status;
  }
  async findCurrentRegistrations(): Promise<readonly ListingRegistrationStatus[]> {
    this.batchStatusCalls += 1;
    return this.statuses;
  }
  async findReplay(): Promise<ListingRegistrationReceipt | null> {
    this.replayCalls += 1;
    return this.replay;
  }
  async registerOrReplay(input: PersistListingRegistrationInput) {
    this.registerCalls += 1;
    this.callOrder.push("register");
    if (this.failure) throw this.failure;
    return {
      kind: "created" as const,
      receipt: {
        registrationId: 100,
        scopeId: 200,
        providerAccountId: 300,
        publicationId: 400,
        idempotencyKey: input.plan.idempotencyKey,
        requestHash: input.plan.requestHash,
        observationHash: input.plan.observationHash,
        desiredStateHash: input.plan.desiredStateHash,
        observedAt: input.plan.observedAt,
        registeredAt: input.registeredAt,
      },
    };
  }
}

function createService(
  ownerReader: MarketplaceListingRegistrationOwnerReader,
  observer: MarketplaceListingRegistrationObserver,
  claimer: MarketplaceListingProviderAccountClaimer,
  repository: MarketplaceListingRegistrationRepository,
) {
  return new MarketplaceListingRegistrationService(
    ownerReader,
    observer,
    claimer,
    repository,
    { now: () => new Date("2026-08-04T12:00:02.000Z") },
  );
}

function command(): Omit<
  ConfirmListingRegistrationInput,
  "expectedObservationHash"
> {
  return {
    owner: {
      kind: "channel",
      channelId: 7,
      productId: 33,
      provider: "ebay",
      marketplaceId: "EBAY_US",
    },
    locator: {
      providerPublicationKey: "ARM-ENV-SGL-V2",
      externalListingId: "listing-123",
    },
    idempotencyKey: "register-arm-envelope-v2",
    requestedBy: { type: "user", id: "admin@example.test" },
    correlationId: "correlation-1",
  };
}

function ownerSnapshot() {
  return {
    owner: command().owner,
    memberCandidates: [
      {
        productVariantId: 11,
        sku: "ARM-ENV-SGL-C750",
        isActive: false,
        availableQuantity: 0,
      },
      {
        productVariantId: 12,
        sku: "ARM-ENV-SGL-C700",
        isActive: false,
        availableQuantity: 8,
      },
    ],
  };
}

function observation() {
  return {
    providerAccount: {
      provider: "ebay",
      accountNamespace: "production",
      externalAccountId: "provider-user-123",
      identityScheme: "provider_user_id" as const,
      externalDisplayNameSnapshot: "Cardshellz",
      evidenceHash: "a".repeat(64),
    },
    marketplaceId: "EBAY_US",
    publicationKeyIdentity: {
      identityNamespace: "ebay.sell.inventory.inventory_item_group",
      externalId: "ARM-ENV-SGL-V2",
    },
    listingIdentity: {
      identityNamespace: "ebay.sell.inventory.listing",
      externalId: "listing-123",
    },
    externalUrl: "https://example.test/listing-123",
    isPublished: true,
    members: [
      {
        sku: "ARM-ENV-SGL-C750",
        variantIdentity: null,
        offerIdentity: {
          identityNamespace: "ebay.sell.inventory.offer",
          externalId: "offer-c750",
        },
        inventoryItemIdentity: {
          identityNamespace: "ebay.sell.inventory.inventory_item",
          externalId: "ARM-ENV-SGL-C750",
        },
      },
    ],
    evidence: { requestId: "request-1" },
    observedAt: new Date("2026-08-04T12:00:00.000Z"),
  };
}

function receipt(): ListingRegistrationReceipt {
  return {
    registrationId: 100,
    scopeId: 200,
    providerAccountId: 300,
    publicationId: 400,
    idempotencyKey: command().idempotencyKey,
    requestHash: buildListingRegistrationRequestHash(command()),
    observationHash: "b".repeat(64),
    desiredStateHash: "c".repeat(64),
    observedAt: new Date("2026-08-04T12:00:00.000Z"),
    registeredAt: new Date("2026-08-04T12:00:02.000Z"),
  };
}

function registrationStatus(): ListingRegistrationStatus {
  return {
    status: "registered",
    productId: 33,
    registrationId: 100,
    scopeId: 200,
    providerAccountId: 300,
    publicationId: 401,
    providerPublicationKey: "ARM-ENV-SGL-V3",
    externalListingId: "listing-456",
    registeredVariantIds: [501, 502],
    registeredVariants: [{
      productVariantId: 501,
      sku: "ARM-ENV-SGL-C700",
      disposition: "included",
    }],
    registeredAt: new Date("2026-08-04T12:00:02.000Z"),
  };
}
