import { describe, expect, it, vi } from "vitest";
import type { DropshipEbayListingSetupService } from "../../application/dropship-ebay-listing-setup-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import type { DropshipStoreConnectionPostConnectProvider } from "../../application/dropship-store-connection-service";
import { EbayDropshipListingSetupPostConnectProvider } from "../../infrastructure/dropship-ebay-listing-setup.factory";
import { DropshipStoreConnectionPostConnectPipeline } from "../../infrastructure/dropship-store-connection-post-connect.provider";

const connectedAt = new Date("2026-08-30T15:00:00.000Z");

describe("eBay listing setup post-connect integration", () => {
  it("uses the OAuth grant environment and records incomplete discovery without failing connection", async () => {
    const autoConfigureAfterConnection = vi.fn(async () => ({
      complete: false,
      missingFields: ["paymentPolicyId"],
    }));
    const logs: DropshipLogEvent[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      logger(logs),
    );

    await provider.afterStoreConnected(connectionInput());

    expect(autoConfigureAfterConnection).toHaveBeenCalledWith({
      storeConnectionId: 44,
      accessToken: "access-token",
      environment: "sandbox",
    });
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_REQUIRED",
      context: { storeConnectionId: 44, missingFields: ["paymentPolicyId"] },
    });
  });

  it("does not treat listing setup discovery failure as an OAuth credential failure", async () => {
    const autoConfigureAfterConnection = vi.fn();
    const logs: DropshipLogEvent[] = [];
    const provider = new EbayDropshipListingSetupPostConnectProvider(
      { autoConfigureAfterConnection } as unknown as DropshipEbayListingSetupService,
      logger(logs),
    );

    await expect(provider.afterStoreConnected(connectionInput({
      providerEnvironment: "invalid",
    }))).resolves.toBeUndefined();

    expect(autoConfigureAfterConnection).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_SETUP_DISCOVERY_FAILED",
      context: { errorCode: "DROPSHIP_EBAY_LISTING_SETUP_ENVIRONMENT_INVALID" },
    });
  });

  it("runs post-connect providers in declared order", async () => {
    const calls: string[] = [];
    const pipeline = new DropshipStoreConnectionPostConnectPipeline([
      provider("first", calls),
      provider("second", calls),
    ]);

    await pipeline.afterStoreConnected(connectionInput());

    expect(calls).toEqual(["first", "second"]);
  });
});

function connectionInput(
  overrides: Partial<Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0]> = {},
): Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0] {
  return {
    vendorId: 10,
    storeConnectionId: 44,
    platform: "ebay",
    providerEnvironment: "sandbox",
    shopDomain: null,
    accessToken: "access-token",
    connectedAt,
    ...overrides,
  };
}

function provider(name: string, calls: string[]): DropshipStoreConnectionPostConnectProvider {
  return {
    async afterStoreConnected() {
      calls.push(name);
    },
  };
}

function logger(logs: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => logs.push(event),
    warn: (event: DropshipLogEvent) => logs.push(event),
    error: (event: DropshipLogEvent) => logs.push(event),
  };
}
