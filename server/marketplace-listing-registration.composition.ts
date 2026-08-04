import { db, pool } from "./db";
import {
  EbayAuthService,
  createEbayAuthConfig,
} from "./modules/channels/adapters/ebay/ebay-auth.service";
import {
  createEbayMarketplaceRegistrationAdapters,
} from "./modules/channels/adapters/ebay/ebay-marketplace-registration.factory";
import {
  createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv,
} from "./modules/dropship/infrastructure/dropship-marketplace-registration.factory";
import {
  MarketplaceListingRegistrationError,
  MarketplaceListingRegistrationService,
  PgMarketplaceListingRegistrationRepository,
  listingOwnerRefSchema,
  type ConfirmListingRegistrationInput,
  type ListingOwnerRef,
  type ListingRegistrationPlan,
  type ListingRegistrationResult,
  type ListingRegistrationStatus,
  type MarketplaceListingProviderAccountClaim,
  type MarketplaceListingProviderAccountClaimer,
  type MarketplaceListingRegistrationClock,
  type MarketplaceListingRegistrationObserver,
  type MarketplaceListingRegistrationOwnerReader,
  type MarketplaceListingRegistrationRepository,
  type ObserveMarketplaceListingInput,
  type PreviewListingRegistrationInput,
} from "./modules/marketplace-listings";
import type {
  MarketplaceListingRegistrationServiceResolver,
} from "./modules/marketplace-listings/interfaces/http/listing-registration.routes";

const EBAY_PROVIDER = "ebay" as const;
const CONFIGURATION_UNAVAILABLE_CODE =
  "MARKETPLACE_LISTING_REGISTRATION_CONFIGURATION_UNAVAILABLE";

type ChannelOwner = Extract<ListingOwnerRef, { kind: "channel" }>;
type DropshipOwner = Extract<ListingOwnerRef, { kind: "dropship" }>;

export interface MarketplaceListingRegistrationOwnerAdapters {
  readonly ownerReader: MarketplaceListingRegistrationOwnerReader;
  readonly observer: MarketplaceListingRegistrationObserver;
  readonly accountClaimer: MarketplaceListingProviderAccountClaimer;
}

export interface MarketplaceListingRegistrationResolverDependencies {
  readonly repository: MarketplaceListingRegistrationRepository;
  readonly clock: MarketplaceListingRegistrationClock;
  readonly createChannelAdapters: (input: {
    readonly owner: ChannelOwner;
    readonly now: () => Date;
  }) => MarketplaceListingRegistrationOwnerAdapters;
  readonly createDropshipAdapters: (input: {
    readonly owner: DropshipOwner;
    readonly now: () => Date;
  }) => MarketplaceListingRegistrationOwnerAdapters;
}

/**
 * Creates the cross-module resolver without reading environment configuration.
 * Each `forOwner` call gets an isolated facade and lazy adapter cache, while the
 * registration repository and clock are shared explicitly by the composition
 * root. Persisted status reads therefore require neither OAuth configuration nor
 * provider clients.
 */
export function createMarketplaceListingRegistrationResolver(
  dependencies: MarketplaceListingRegistrationResolverDependencies,
): MarketplaceListingRegistrationServiceResolver {
  assertDependencies(dependencies);
  return {
    forOwner(owner: ListingOwnerRef) {
      const boundOwner = parseSupportedOwner(owner);
      return createBoundRegistrationFacade(boundOwner, dependencies);
    },
  };
}

/** Production wiring. All environment-backed factories remain request-lazy. */
export function createMarketplaceListingRegistrationResolverFromEnv(
): MarketplaceListingRegistrationServiceResolver {
  const clock: MarketplaceListingRegistrationClock = {
    now: () => new Date(),
  };
  return createMarketplaceListingRegistrationResolver({
    repository: new PgMarketplaceListingRegistrationRepository(pool),
    clock,
    createChannelAdapters: ({ now }) => {
      const authService = new EbayAuthService(
        db,
        createEbayAuthConfig(),
        { now },
      );
      return createEbayMarketplaceRegistrationAdapters({
        authService,
        now,
      });
    },
    createDropshipAdapters: ({ now }) =>
      createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv({ now }),
  });
}

function createBoundRegistrationFacade(
  boundOwner: ListingOwnerRef,
  dependencies: MarketplaceListingRegistrationResolverDependencies,
): BoundMarketplaceListingRegistrationFacade {
  let cachedAdapters: MarketplaceListingRegistrationOwnerAdapters | null = null;

  const resolveAdapters = (): MarketplaceListingRegistrationOwnerAdapters => {
    if (cachedAdapters !== null) return cachedAdapters;
    try {
      const now = () => dependencies.clock.now();
      const created = boundOwner.kind === "channel"
        ? dependencies.createChannelAdapters({ owner: boundOwner, now })
        : dependencies.createDropshipAdapters({ owner: boundOwner, now });
      cachedAdapters = assertOwnerAdapters(created, boundOwner);
      return cachedAdapters;
    } catch (error) {
      throw new MarketplaceListingRegistrationError(
        CONFIGURATION_UNAVAILABLE_CODE,
        "Marketplace listing registration is not configured for this owner.",
        ownerContext(boundOwner),
        { cause: error },
      );
    }
  };

  const service = new MarketplaceListingRegistrationService(
    {
      async loadRegistrationSnapshot(owner: ListingOwnerRef): Promise<unknown> {
        assertExactOwner(owner, boundOwner, "owner snapshot");
        return resolveAdapters().ownerReader.loadRegistrationSnapshot(owner);
      },
    },
    {
      async observeExistingPublication(
        input: ObserveMarketplaceListingInput,
      ): Promise<unknown> {
        assertExactOwner(input.owner, boundOwner, "provider observation");
        return resolveAdapters().observer.observeExistingPublication(input);
      },
    },
    {
      async claimStableProviderAccount(
        claim: MarketplaceListingProviderAccountClaim,
      ): Promise<unknown> {
        assertExactOwner(claim.owner, boundOwner, "provider account claim");
        return resolveAdapters().accountClaimer.claimStableProviderAccount(claim);
      },
    },
    dependencies.repository,
    dependencies.clock,
  );

  return new BoundMarketplaceListingRegistrationFacade(boundOwner, service);
}

class BoundMarketplaceListingRegistrationFacade {
  constructor(
    private readonly boundOwner: ListingOwnerRef,
    private readonly service: MarketplaceListingRegistrationService,
  ) {}

  async preview(
    input: PreviewListingRegistrationInput,
  ): Promise<ListingRegistrationPlan> {
    assertExactOwner(input.owner, this.boundOwner, "preview");
    return this.service.preview(input);
  }

  async confirm(
    input: ConfirmListingRegistrationInput,
  ): Promise<ListingRegistrationResult> {
    assertExactOwner(input.owner, this.boundOwner, "confirmation");
    return this.service.confirm(input);
  }

  async getCurrentRegistrationStatuses(
    owners: readonly ListingOwnerRef[],
  ): Promise<readonly ListingRegistrationStatus[]> {
    for (const owner of owners) {
      assertSameOwnerScope(owner, this.boundOwner);
    }
    return this.service.getCurrentRegistrationStatuses(owners);
  }
}

function parseSupportedOwner(owner: ListingOwnerRef): ListingOwnerRef {
  const parsed = listingOwnerRefSchema.safeParse(owner);
  if (!parsed.success) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
      "Marketplace listing registration owner is invalid.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  if (parsed.data.provider !== EBAY_PROVIDER) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_PROVIDER_UNSUPPORTED",
      "Marketplace listing registration does not support this provider.",
      { provider: parsed.data.provider },
    );
  }
  return parsed.data;
}

function assertExactOwner(
  actualValue: ListingOwnerRef,
  expected: ListingOwnerRef,
  operation: string,
): void {
  const actual = parseSupportedOwner(actualValue);
  if (
    !sameOwnerScope(actual, expected)
    || actual.productId !== expected.productId
  ) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_OWNER_BINDING_MISMATCH",
      "The registration service is bound to a different marketplace owner.",
      {
        operation,
        expected: ownerContext(expected),
        actual: ownerContext(actual),
      },
    );
  }
}

function assertSameOwnerScope(
  actualValue: ListingOwnerRef,
  expected: ListingOwnerRef,
): void {
  const actual = parseSupportedOwner(actualValue);
  if (!sameOwnerScope(actual, expected)) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_OWNER_SCOPE_MISMATCH",
      "A registration status request crossed marketplace owner scope.",
      {
        expected: ownerContext(expected),
        actual: ownerContext(actual),
      },
    );
  }
}

function sameOwnerScope(left: ListingOwnerRef, right: ListingOwnerRef): boolean {
  if (
    left.kind !== right.kind
    || left.provider !== right.provider
    || left.marketplaceId !== right.marketplaceId
  ) {
    return false;
  }
  return left.kind === "channel"
    ? right.kind === "channel" && left.channelId === right.channelId
    : right.kind === "dropship"
      && left.storeConnectionId === right.storeConnectionId;
}

function ownerContext(owner: ListingOwnerRef): Readonly<Record<string, unknown>> {
  return owner.kind === "channel"
    ? {
        ownerKind: owner.kind,
        channelId: owner.channelId,
        productId: owner.productId,
        provider: owner.provider,
        marketplaceId: owner.marketplaceId,
      }
    : {
        ownerKind: owner.kind,
        storeConnectionId: owner.storeConnectionId,
        productId: owner.productId,
        provider: owner.provider,
        marketplaceId: owner.marketplaceId,
      };
}

function assertOwnerAdapters(
  value: MarketplaceListingRegistrationOwnerAdapters,
  owner: ListingOwnerRef,
): MarketplaceListingRegistrationOwnerAdapters {
  if (
    !value
    || typeof value.ownerReader?.loadRegistrationSnapshot !== "function"
    || typeof value.observer?.observeExistingPublication !== "function"
    || typeof value.accountClaimer?.claimStableProviderAccount !== "function"
  ) {
    throw new MarketplaceListingRegistrationError(
      CONFIGURATION_UNAVAILABLE_CODE,
      "Marketplace listing registration adapters are incomplete.",
      ownerContext(owner),
    );
  }
  return value;
}

function assertDependencies(
  value: MarketplaceListingRegistrationResolverDependencies,
): void {
  if (
    !value
    || typeof value.repository?.findCurrentRegistration !== "function"
    || typeof value.repository?.findCurrentRegistrations !== "function"
    || typeof value.repository?.findReplay !== "function"
    || typeof value.repository?.registerOrReplay !== "function"
    || typeof value.clock?.now !== "function"
    || typeof value.createChannelAdapters !== "function"
    || typeof value.createDropshipAdapters !== "function"
  ) {
    throw new MarketplaceListingRegistrationError(
      CONFIGURATION_UNAVAILABLE_CODE,
      "Marketplace listing registration composition dependencies are incomplete.",
    );
  }
}
