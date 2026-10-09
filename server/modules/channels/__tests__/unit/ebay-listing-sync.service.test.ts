import { describe, expect, it, vi } from "vitest";
import { EbayExistingListingSyncExecution } from "../../ebay-listing-sync.service";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import {
  EbayListingSyncError,
  syncFailure,
  ebayListingSyncIdentitySchema,
} from "../../ebay-listing-sync.domain";
import {
  syncIdentity,
  syncProviderFixture,
} from "../fixtures/ebay-listing-sync.fixture";
import { safeEbayErrorMessage } from "../../adapters/ebay/ebay-quantity-http";
describe("existing eBay listing sync execution", () => {
  const recovered = () => ({
    reconcile: vi.fn(async () => ({
      busy: false,
      resolved: [],
      unresolved: [],
    })),
  });
  it("checks the exact identity, recovers, journals each primitive and verifies published content before completion", async () => {
    const fixture = syncProviderFixture(),
      recovery = recovered(),
      stages: string[] = [];
    const executor = new EbayExistingListingSyncExecution(
      fixture.prepare,
      recovery,
      new EbayMarketplaceListingConnector(),
    );
    const result = await executor.execute(
      syncIdentity,
      async (key, _hash, work) => {
        stages.push(`start:${key}`);
        await work();
        stages.push(`done:${key}`);
      },
    );
    expect(result.synced).toBe(1);
    expect(result.errors).toBe(0);
    expect(stages).toEqual([
      "start:offer:offer-101",
      "done:offer:offer-101",
      "start:item:P5",
      "done:item:P5",
      "start:group:PACK",
      "done:group:PACK",
      "start:verification",
      "done:verification",
    ]);
    expect(recovery.reconcile).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: 1,
          externalScopeId: "verified-account",
          externalInventoryItemId: "P5",
        }),
      ]),
    );
    expect(fixture.client.getOffers).toHaveBeenCalledTimes(2);
  });
  it("does not publish when response proof is missing, regardless of age or matching current content", async () => {
    const fixture = syncProviderFixture(),
      recovery = {
        reconcile: vi.fn(async () => ({
          busy: false,
          resolved: [],
          unresolved: ["17348"],
        })),
      };
    const executor = new EbayExistingListingSyncExecution(
      fixture.prepare,
      recovery,
      new EbayMarketplaceListingConnector(),
    );
    await expect(
      executor.execute(syncIdentity, async (_k, _h, w) => w()),
    ).rejects.toMatchObject({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" });
    expect(fixture.client.updateOffer).not.toHaveBeenCalled();
  });
  it("rejects a foreign draft SKU before any provider write", async () => {
    const fixture = syncProviderFixture(),
      prepared = await fixture.prepare();
    prepared.draft.inventoryItems[0].sku = "FOREIGN-SKU";
    const executor = new EbayExistingListingSyncExecution(
      async () => prepared,
      recovered(),
      new EbayMarketplaceListingConnector(),
    );
    await expect(
      executor.execute(syncIdentity, async (_key, _hash, work) => work()),
    ).rejects.toMatchObject({ code: "EBAY_SYNC_DRAFT_SCOPE_INVALID" });
    expect(fixture.client.updateOffer).not.toHaveBeenCalled();
    expect(fixture.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it.each([
    "missing group members",
    "duplicate group members",
    "missing item",
    "missing offer",
  ])("rejects %s before any provider write", async (invalid) => {
    const fixture = syncProviderFixture(),
      prepared = await fixture.prepare();
    switch (invalid) {
      case "missing group members":
        delete prepared.draft.itemGroup!.payload.variantSKUs;
        break;
      case "duplicate group members":
        prepared.draft.itemGroup!.payload.variantSKUs = ["P5", "P5"];
        break;
      case "missing item":
        prepared.draft.inventoryItems.pop();
        break;
      case "missing offer":
        prepared.draft.offers.pop();
        break;
    }
    const executor = new EbayExistingListingSyncExecution(
      async () => prepared,
      recovered(),
      new EbayMarketplaceListingConnector(),
    );
    await expect(
      executor.execute(syncIdentity, async (_key, _hash, work) => work()),
    ).rejects.toMatchObject({ code: "EBAY_SYNC_DRAFT_SCOPE_INVALID" });
    expect(fixture.client.updateOffer).not.toHaveBeenCalled();
    expect(fixture.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
  });
  it.each(["accountId", "groupKey"] as const)(
    "rejects changed %s before recovery or writes",
    async (field) => {
      const fixture = syncProviderFixture(),
        recovery = recovered();
      const executor = new EbayExistingListingSyncExecution(
        async () => ({
          ...(await fixture.prepare()),
          identity: { ...syncIdentity, [field]: "changed" },
        }),
        recovery,
        new EbayMarketplaceListingConnector(),
      );
      await expect(
        executor.execute(syncIdentity, async (_k, _h, w) => w()),
      ).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
      expect(recovery.reconcile).not.toHaveBeenCalled();
      expect(fixture.client.updateOffer).not.toHaveBeenCalled();
    },
  );
  it("leaves verification pending when a PUT succeeds but eBay still exposes old group content", async () => {
    const fixture = syncProviderFixture();
    vi.mocked(
      fixture.client.createOrReplaceInventoryItemGroup,
    ).mockResolvedValue(undefined);
    const executor = new EbayExistingListingSyncExecution(
      fixture.prepare,
      recovered(),
      new EbayMarketplaceListingConnector(),
    );
    await expect(
      executor.execute(syncIdentity, async (_k, _h, w) => w()),
    ).rejects.toMatchObject({ code: "EBAY_SYNC_READBACK_PENDING" });
  });
  it("rebuilds quantities after a partial failure without modifying the original intent", async () => {
    const fixture = syncProviderFixture(),
      first = await fixture.prepare();
    vi.mocked(
      fixture.client.createOrReplaceInventoryItemGroup,
    ).mockRejectedValueOnce(new Error("partial provider failure"));
    const executor = new EbayExistingListingSyncExecution(
      fixture.prepare,
      recovered(),
      new EbayMarketplaceListingConnector(),
    );
    await expect(
      executor.execute(syncIdentity, async (_k, _h, w) => w()),
    ).rejects.toThrow("partial provider failure");
    fixture.setQuantity(3);
    await executor.execute(syncIdentity, async (_k, _h, w) => w());
    expect(
      fixture.currentItem().availability.shipToLocationAvailability.quantity,
    ).toBe(3);
    expect(
      first.draft.inventoryItems[0].payload.availability
        .shipToLocationAvailability.quantity,
    ).toBe(7);
  });
  it.each(["11.490", "11.499"])(
    "verifies price %s with exact decimal comparison",
    async (observedPrice) => {
      const fixture = syncProviderFixture(),
        read = fixture.client.getOffers;
      fixture.client.getOffers = async (sku, marketplaceId) => {
        const result = await read(sku, marketplaceId);
        return {
          offers: result.offers.map((offer) => ({
            ...offer,
            pricingSummary: {
              price: { value: observedPrice, currency: "USD" },
            },
          })),
        };
      };
      const executor = new EbayExistingListingSyncExecution(
        fixture.prepare,
        recovered(),
        new EbayMarketplaceListingConnector(),
      );
      const execution = executor.execute(
        syncIdentity,
        async (_key, _hash, work) => work(),
      );
      if (observedPrice === "11.490")
        await expect(execution).resolves.toMatchObject({
          synced: 1,
          errors: 0,
        });
      else
        await expect(execution).rejects.toMatchObject({
          code: "EBAY_SYNC_READBACK_PENDING",
        });
    },
  );
  it("enforces a finite retry budget and provider cooldown, and never retries missing proof", () => {
    const now = new Date("2026-10-09T12:00:00Z"),
      uncertain = Object.assign(new Error("uncertain"), {
        code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN",
      });
    expect(syncFailure(uncertain, 1, now).state).toBe("recovering");
    expect(syncFailure(uncertain, 5, now).state).toBe("needs_attention");
    const deadline = "2026-10-10T12:00:00.000Z";
    expect(
      syncFailure(
        Object.assign(new Error("cooldown"), {
          code: "PUBLICATION_PROVIDER_COOLDOWN",
          context: { retryNotBefore: deadline },
        }),
        9,
        now,
      ).nextAttemptAt.toISOString(),
    ).toBe(deadline);
    expect(
      syncFailure(
        new EbayListingSyncError(
          "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
          "Missing proof",
        ),
        1,
        now,
      ).state,
    ).toBe("awaiting_evidence");
  });
  it("validates distinct members and strips sensitive diagnostics", () => {
    const persistenceError = Object.assign(
      new Error("SQL diagnostic password=private"),
      { code: "XX001" },
    );
    expect(
      syncFailure(persistenceError, 1, new Date("2026-10-09T12:00:00Z"))
        .message,
    ).not.toMatch(/SQL|private/);
    expect(
      ebayListingSyncIdentitySchema.safeParse({
        ...syncIdentity,
        variants: [...syncIdentity.variants, ...syncIdentity.variants],
      }).success,
    ).toBe(false);
    const message = safeEbayErrorMessage({
      errors: [
        {
          errorId: 25002,
          category: "REQUEST",
          message: "Invalid field",
          longMessage:
            "Invalid image https://example.com/private?token=secret Bearer credential access_token=abc",
        },
      ],
    });
    expect(message).toContain("25002 REQUEST");
    expect(message).not.toMatch(/secret|credential|abc/);
  });
});
