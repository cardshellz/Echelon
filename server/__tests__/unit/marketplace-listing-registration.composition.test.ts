import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMarketplaceListingRegistrationResolver,
  type MarketplaceListingRegistrationOwnerAdapters,
} from "../../marketplace-listing-registration.composition";
import { createEbayAuthConfig } from "../../modules/channels/adapters/ebay/ebay-auth.service";
import {
  MarketplaceListingRegistrationError,
  type ListingOwnerRef,
  type ListingRegistrationReplayLookup,
  type ListingRegistrationStatus,
  type MarketplaceListingRegistrationRepository,
  type PersistListingRegistrationInput,
  type PreviewListingRegistrationInput,
} from "../../modules/marketplace-listings";

const FIXED_NOW = new Date("2026-08-04T16:00:00.000Z");
const CHANNEL_OWNER = {
  kind: "channel",
  channelId: 44,
  productId: 88,
  provider: "ebay",
  marketplaceId: "EBAY_US",
} as const satisfies ListingOwnerRef;
const DROPSHIP_OWNER = {
  kind: "dropship",
  storeConnectionId: 17,
  productId: 88,
  provider: "ebay",
  marketplaceId: "EBAY_US",
} as const satisfies ListingOwnerRef;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("marketplace listing registration composition", () => {
  it("loads persisted status without constructing environment-backed adapters", async () => {
    const harness = buildHarness();
    const service = harness.resolver.forOwner(CHANNEL_OWNER);
    const secondProduct = { ...CHANNEL_OWNER, productId: 99 };

    await expect(
      service.getCurrentRegistrationStatuses([CHANNEL_OWNER, secondProduct]),
    ).resolves.toEqual([]);

    expect(harness.repository.statusBatches).toEqual([
      [CHANNEL_OWNER, secondProduct],
    ]);
    expect(harness.createChannelAdapters).not.toHaveBeenCalled();
    expect(harness.createDropshipAdapters).not.toHaveBeenCalled();
  });

  it("constructs and closure-caches Channel adapters only for a bound preview", async () => {
    const harness = buildHarness();
    const service = harness.resolver.forOwner(CHANNEL_OWNER);
    const input = previewInput(CHANNEL_OWNER);

    await expect(service.preview(input)).rejects.toMatchObject({
      code: "TEST_CHANNEL_OWNER_READ_STOP",
    });
    await expect(service.preview(input)).rejects.toMatchObject({
      code: "TEST_CHANNEL_OWNER_READ_STOP",
    });

    expect(harness.createChannelAdapters).toHaveBeenCalledTimes(1);
    expect(harness.createChannelAdapters.mock.calls[0][0].owner).toEqual(
      CHANNEL_OWNER,
    );
    expect(harness.createChannelAdapters.mock.calls[0][0].now()).toEqual(
      FIXED_NOW,
    );
    expect(harness.createDropshipAdapters).not.toHaveBeenCalled();
  });

  it("creates isolated request facades rather than sharing Channel auth adapters", async () => {
    const harness = buildHarness();
    const first = harness.resolver.forOwner(CHANNEL_OWNER);
    const second = harness.resolver.forOwner(CHANNEL_OWNER);

    await expect(first.preview(previewInput(CHANNEL_OWNER))).rejects.toMatchObject({
      code: "TEST_CHANNEL_OWNER_READ_STOP",
    });
    await expect(second.preview(previewInput(CHANNEL_OWNER))).rejects.toMatchObject({
      code: "TEST_CHANNEL_OWNER_READ_STOP",
    });

    expect(harness.createChannelAdapters).toHaveBeenCalledTimes(2);
  });

  it("selects Dropship adapters for a Dropship owner", async () => {
    const harness = buildHarness();
    const service = harness.resolver.forOwner(DROPSHIP_OWNER);

    await expect(
      service.preview(previewInput(DROPSHIP_OWNER)),
    ).rejects.toMatchObject({ code: "TEST_DROPSHIP_OWNER_READ_STOP" });

    expect(harness.createDropshipAdapters).toHaveBeenCalledTimes(1);
    expect(harness.createChannelAdapters).not.toHaveBeenCalled();
  });

  it("rejects a preview owner different from the facade binding before adapter construction", async () => {
    const harness = buildHarness();
    const service = harness.resolver.forOwner(CHANNEL_OWNER);

    await expect(
      service.preview(previewInput({ ...CHANNEL_OWNER, productId: 99 })),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_OWNER_BINDING_MISMATCH",
    });
    expect(harness.createChannelAdapters).not.toHaveBeenCalled();
  });

  it("rejects status batches that cross the bound owner scope", async () => {
    const harness = buildHarness();
    const service = harness.resolver.forOwner(CHANNEL_OWNER);

    await expect(
      service.getCurrentRegistrationStatuses([
        CHANNEL_OWNER,
        { ...CHANNEL_OWNER, channelId: 45, productId: 99 },
      ]),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_OWNER_SCOPE_MISMATCH",
    });
    expect(harness.repository.statusBatches).toEqual([]);
    expect(harness.createChannelAdapters).not.toHaveBeenCalled();
  });

  it("fails closed for a provider without a registration adapter", () => {
    const harness = buildHarness();

    expect(() =>
      harness.resolver.forOwner({
        ...CHANNEL_OWNER,
        provider: "shopify",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REGISTRATION_PROVIDER_UNSUPPORTED",
      }),
    );
    expect(harness.createChannelAdapters).not.toHaveBeenCalled();
    expect(harness.createDropshipAdapters).not.toHaveBeenCalled();
  });

  it("classifies lazy adapter construction failures without exposing config", async () => {
    const harness = buildHarness({
      createChannelAdapters: vi.fn(() => {
        throw new Error("secret-bearing constructor failure");
      }),
    });
    const service = harness.resolver.forOwner(CHANNEL_OWNER);

    await expect(
      service.preview(previewInput(CHANNEL_OWNER)),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REGISTRATION_CONFIGURATION_UNAVAILABLE",
      message: "Marketplace listing registration is not configured for this owner.",
      context: {
        ownerKind: "channel",
        channelId: 44,
        productId: 88,
      },
    });
  });

  it("validates EBAY_ENVIRONMENT instead of trusting a type assertion", () => {
    vi.stubEnv("EBAY_CLIENT_ID", "client-id");
    vi.stubEnv("EBAY_CLIENT_SECRET", "client-secret");
    vi.stubEnv("EBAY_RUNAME", "runame");
    vi.stubEnv("EBAY_ENVIRONMENT", "staging");

    expect(() => createEbayAuthConfig()).toThrow(
      "EBAY_ENVIRONMENT must be sandbox or production.",
    );

    vi.stubEnv("EBAY_ENVIRONMENT", " SANDBOX ");
    expect(createEbayAuthConfig().environment).toBe("sandbox");
  });
});

function previewInput(
  owner: ListingOwnerRef,
): PreviewListingRegistrationInput {
  return {
    owner,
    locator: {
      providerPublicationKey: "ARM-ENV-SGL",
      externalListingId: "36412213011",
    },
    idempotencyKey: "registration-composition-test",
    requestedBy: { type: "user", id: "admin-1" },
    correlationId: null,
  };
}

function stoppingAdapters(code: string): MarketplaceListingRegistrationOwnerAdapters {
  return {
    ownerReader: {
      async loadRegistrationSnapshot(): Promise<unknown> {
        throw new MarketplaceListingRegistrationError(code, "Test stop.");
      },
    },
    observer: {
      async observeExistingPublication(): Promise<unknown> {
        throw new Error("Observer must not run after the owner-reader test stop.");
      },
    },
    accountClaimer: {
      async claimStableProviderAccount(): Promise<unknown> {
        throw new Error("Account claimer must not run during preview.");
      },
    },
  };
}

function buildHarness(overrides: {
  createChannelAdapters?: ReturnType<typeof vi.fn>;
  createDropshipAdapters?: ReturnType<typeof vi.fn>;
} = {}) {
  const repository = new FakeRegistrationRepository();
  const createChannelAdapters = overrides.createChannelAdapters
    ?? vi.fn(() => stoppingAdapters("TEST_CHANNEL_OWNER_READ_STOP"));
  const createDropshipAdapters = overrides.createDropshipAdapters
    ?? vi.fn(() => stoppingAdapters("TEST_DROPSHIP_OWNER_READ_STOP"));
  const resolver = createMarketplaceListingRegistrationResolver({
    repository,
    clock: { now: () => new Date(FIXED_NOW.getTime()) },
    createChannelAdapters,
    createDropshipAdapters,
  });
  return {
    repository,
    createChannelAdapters,
    createDropshipAdapters,
    resolver,
  };
}

class FakeRegistrationRepository
  implements MarketplaceListingRegistrationRepository
{
  readonly statusBatches: ListingOwnerRef[][] = [];

  async findCurrentRegistration(): Promise<ListingRegistrationStatus | null> {
    return null;
  }

  async findCurrentRegistrations(
    owners: readonly ListingOwnerRef[],
  ): Promise<readonly ListingRegistrationStatus[]> {
    this.statusBatches.push(owners.map((owner) => ({ ...owner })));
    return [];
  }

  async findReplay(
    _lookup: ListingRegistrationReplayLookup,
  ): Promise<null> {
    return null;
  }

  async registerOrReplay(
    _input: PersistListingRegistrationInput,
  ): Promise<never> {
    throw new Error("Registration persistence is outside this composition test.");
  }
}
