import { beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock calls are hoisted above this import, so the adapter is built over the doubles below.
import { createDropshipListingSettingEbayAdapterFromEnv } from "../../infrastructure/dropship-listing-setting-ebay.adapter";

/**
 * The listing-settings eBay adapter (plan PR 9, section 6.1): each port method
 * hands its input to today's provider unchanged, a shipping policy is checked
 * against Card Shellz shipping read fresh (W2's rule, not the 5-minute cache),
 * and both eBay directories share one credential provider.
 */

const mocks = vi.hoisted(() => ({
  credentials: { name: "the one credential provider" },
  credentialFactory: vi.fn(),
  directoryCredentials: [] as unknown[],
  shelfCredentials: [] as unknown[],
  describe: vi.fn(),
  discover: vi.fn(),
  capability: vi.fn(),
  shelves: vi.fn(),
}));

vi.mock("../../infrastructure/dropship-ebay-registration-credentials", () => ({
  createDropshipEbayRegistrationCredentialProviderFromEnv: mocks.credentialFactory,
}));
vi.mock("../../infrastructure/dropship-ebay-listing-setup.directory", () => ({
  EbayDropshipListingSetupDirectory: class {
    discoverForStoreConnection = mocks.discover;
    constructor(credentials: unknown) { mocks.directoryCredentials.push(credentials); }
  },
}));
vi.mock("../../infrastructure/dropship-ebay-store-category.directory", () => ({
  EbayDropshipStoreCategoryDirectory: class {
    listLeafCategories = mocks.shelves;
    constructor(credentials: unknown) { mocks.shelfCredentials.push(credentials); }
  },
}));
vi.mock("../../infrastructure/dropship-ebay-fulfillment-capability.provider", () => ({
  createDropshipEbayFulfillmentCapabilityProviderFromEnv: () => ({ getForStoreConnection: mocks.capability }),
}));
vi.mock("../../infrastructure/dropship-ebay-category-rules.factory", () => ({
  sharedDropshipEbayCategoryTaxonomy: () => ({ describe: mocks.describe }),
}));

describe("createDropshipListingSettingEbayAdapterFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.directoryCredentials.length = 0;
    mocks.shelfCredentials.length = 0;
    mocks.credentialFactory.mockReturnValue(mocks.credentials);
  });

  it("builds one credential provider and gives it to both eBay directories", () => {
    createDropshipListingSettingEbayAdapterFromEnv();
    expect(mocks.credentialFactory).toHaveBeenCalledTimes(1);
    expect(mocks.directoryCredentials).toEqual([mocks.credentials]);
    expect(mocks.shelfCredentials).toEqual([mocks.credentials]);
    expect(mocks.directoryCredentials[0]).toBe(mocks.shelfCredentials[0]);
  });

  it("reads Card Shellz shipping fresh for a shipping policy, never from the cache", async () => {
    const capability = { marketplaceId: "EBAY_US" };
    mocks.capability.mockResolvedValue(capability);
    const port = createDropshipListingSettingEbayAdapterFromEnv();

    await expect(port.loadFulfillmentCapability({ storeConnectionId: 22, marketplaceId: "EBAY_US" })).resolves.toBe(capability);
    expect(mocks.capability).toHaveBeenCalledWith({ storeConnectionId: 22, marketplaceId: "EBAY_US", fresh: true });
  });

  it("hands each other read its input unchanged and answers with the provider's answer", async () => {
    const described = new Map();
    const discovery = { marketplaceId: "EBAY_US" };
    const leaves = [{ categoryId: "101" }];
    mocks.describe.mockResolvedValue(described);
    mocks.discover.mockResolvedValue(discovery);
    mocks.shelves.mockResolvedValue(leaves);
    const port = createDropshipListingSettingEbayAdapterFromEnv();
    const identity = { vendorId: 10, storeConnectionId: 22 };

    await expect(port.describeCategories(identity, ["261328"])).resolves.toBe(described);
    expect(mocks.describe).toHaveBeenCalledWith(identity, ["261328"]);

    await expect(port.discoverPolicies({ ...identity, marketplaceId: "EBAY_US" })).resolves.toBe(discovery);
    expect(mocks.discover).toHaveBeenCalledWith({ vendorId: 10, storeConnectionId: 22, marketplaceId: "EBAY_US" });

    await expect(port.listStoreShelves(identity)).resolves.toBe(leaves);
    expect(mocks.shelves).toHaveBeenCalledWith({ vendorId: 10, storeConnectionId: 22 });
  });

  it("lets a provider failure through as it is", async () => {
    const failure = new Error("eBay is down");
    mocks.shelves.mockRejectedValue(failure);
    const port = createDropshipListingSettingEbayAdapterFromEnv();
    await expect(port.listStoreShelves({ vendorId: 10, storeConnectionId: 22 })).rejects.toBe(failure);
  });
});
