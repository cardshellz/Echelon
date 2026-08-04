import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  postRegistration,
  registrationPreviewResponseSchema,
} from "../MarketplaceListingRegistrationDialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MarketplaceListingRegistrationDialog contract", () => {
  it("accepts the complete server-shaped preview member contract", () => {
    const payload = {
      preview: {
        providerAccount: {
          accountNamespace: "production",
          externalAccountId: "seller-123",
          externalDisplayNameSnapshot: "Card Shellz",
        },
        providerPublicationKey: "ARM-ENV-SGL-V2",
        externalListingId: "36412213011",
        members: [{
          productVariantId: 750,
          skuSnapshot: "ARM-ENV-SGL-C750",
          isActiveSnapshot: true,
          availableQuantitySnapshot: 507,
          disposition: "included" as const,
          reasonCode: null,
          externalVariantId: "Case of 750",
          externalVariantIdentityNamespace: "ebay:production:EBAY_US:listing",
          externalOfferId: "offer-750",
          externalOfferIdentityNamespace: "ebay:production:EBAY_US:offer",
          externalInventoryItemId: "ARM-ENV-SGL-C750",
          externalInventoryItemIdentityNamespace: "ebay:production:EBAY_US:inventory_item",
        }],
        observationHash: "a".repeat(64),
        observedAt: "2026-08-04T15:00:00.000Z",
      },
    };

    expect(registrationPreviewResponseSchema.parse(payload)).toEqual(payload);
  });

  it("aborts and classifies a browser-to-server timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = postRegistration(
      "/api/marketplace-listings/registrations/channel/ebay/confirm",
      { idempotencyKey: "test" },
      z.object({ ok: z.literal(true) }),
      { timeoutMs: 25 },
    );
    const rejection = expect(result).rejects.toMatchObject({
      status: 504,
      payload: {
        code: "MARKETPLACE_LISTING_REGISTRATION_REQUEST_TIMEOUT",
        context: { timeoutMs: 25 },
      },
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
