import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The listing end worker's production wiring (PLAN-C v4.1 §5.2 gate 1; review TST-4): `DRY_RUN` is read once, at
 * composition, and a dry run claims nothing and reads nothing. The shared pool and every env-built collaborator are
 * stubbed; the service and repository are the real ones, so a gate wired wrong in the factory shows here.
 */
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: {}, pool: { query: mocks.query, connect: mocks.connect } }));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../inventory-planning/quantity-publication", () => ({
  createDropshipEbayQuantityRequestAdmission: vi.fn(),
  quantityProviderResponseRecovery: { reconcile: vi.fn() },
}));
vi.mock("../../infrastructure/dropship-marketplace-credentials", () => ({
  createDropshipMarketplaceCredentialRepositoryFromEnv: () => ({}),
}));
vi.mock("../../infrastructure/dropship-ebay-registration-credentials", () => ({
  RefreshingDropshipEbayRegistrationCredentialProvider: { fromEnv: () => ({ loadFreshForStoreConnection: vi.fn() }) },
  resolveDropshipEbayProviderEnvironment: vi.fn(),
}));
vi.mock("../../infrastructure/dropship-marketplace-registration.factory", () => ({
  createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv: () => ({ inspector: { inspectExistingPublication: vi.fn() } }),
}));
vi.mock("../../infrastructure/dropship-notification.factory", () => ({
  createDropshipNotificationServiceFromEnv: () => ({ send: vi.fn() }),
}));
import { createDropshipListingEndServiceFromEnv } from "../../infrastructure/dropship-listing-end.factory";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockRejectedValue(Object.assign(new Error("database unavailable"), { code: "57P01" }));
  mocks.connect.mockRejectedValue(Object.assign(new Error("database unavailable"), { code: "57P01" }));
});

describe("createDropshipListingEndServiceFromEnv (§5.2 gate 1, TST-4)", () => {
  it("closes the dry-run gate when DRY_RUN is \"true\": the tick reads nothing, claims nothing and calls nothing", async () => {
    const service = createDropshipListingEndServiceFromEnv({ DRY_RUN: "true" });
    expect(await service.runTick()).toMatchObject({ outcome: "gated", gate: "dry_run", due: 0, claimed: 0 });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["no DRY_RUN", {}],
    ["DRY_RUN=false", { DRY_RUN: "false" }],
    ["DRY_RUN=1 (only \"true\" is a dry run, the eBay client's own rule)", { DRY_RUN: "1" }],
  ] as const)("leaves the dry-run gate open with %s: the tick goes on to the readiness read", async (_label, environment) => {
    const service = createDropshipListingEndServiceFromEnv(environment as NodeJS.ProcessEnv);
    const result = await service.runTick();
    // The stubbed database refuses the first read, so the tick fails (fatal); what matters is that it got there.
    expect(result).toMatchObject({ outcome: "failed", gate: null });
    expect(mocks.query).toHaveBeenCalled();
  });
});
