import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HmacDropshipOAuthStateSigner } from "../../infrastructure/dropship-oauth-state-signer";
import { DropshipStoreConnectionService } from "../../application/dropship-store-connection-service";
import { createDropshipPartnerOrderIntakeAdapter } from "../../oms-channel-resolver.api";
import { ChannelOrderBoundaryValidationError } from "../../../channels/channel-adapter.interface";
import { paginateEbayFulfillmentOrders } from "../../../channels/ebay-connector.api";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("P3.2 — Dropship Convergence (OAuth One-Time Nonce, Channel Config API, eBay Pager Deduplication, Partner Intake Adapter)", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const secret = "dropship-oauth-convergence-secret-at-least-32-chars";

  describe("OAuth state nonce validation & single-use replay rejection", () => {
    it("rejects signed OAuth states with blank/missing nonces or malformed issuedAt timestamps", () => {
      const signer = new HmacDropshipOAuthStateSigner(secret);

      const blankNonce = signer.sign({
        version: 1,
        vendorId: 10,
        memberId: "member-10",
        platform: "ebay",
        shopDomain: null,
        nonce: "   ",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        returnTo: "/settings",
      });
      expect(() => signer.verify(blankNonce, now)).toThrowError(
        expect.objectContaining({ code: "DROPSHIP_INVALID_OAUTH_STATE" }),
      );

      const badIssuedAt = signer.sign({
        version: 1,
        vendorId: 10,
        memberId: "member-10",
        platform: "ebay",
        shopDomain: null,
        nonce: "valid-nonce-123",
        issuedAt: "not-a-timestamp",
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        returnTo: "/settings",
      });
      expect(() => signer.verify(badIssuedAt, now)).toThrowError(
        expect.objectContaining({ code: "DROPSHIP_INVALID_OAUTH_STATE" }),
      );
    });

    it("enforces single-use OAuth state nonces in completeOAuthCallback (rejecting replay with DROPSHIP_OAUTH_STATE_REPLAYED)", async () => {
      const signer = new HmacDropshipOAuthStateSigner(secret);
      const signedState = signer.sign({
        version: 1,
        vendorId: 10,
        memberId: "member-10",
        platform: "shopify",
        shopDomain: "partner-shop.myshopify.com",
        nonce: "single-use-nonce-001",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        returnTo: "/settings",
      });

      const consumedKeys = new Set<string>();
      const consumeOAuthStateNonce = vi.fn(async ({ nonce, vendorId, platform }) => {
        const k = `${vendorId}:${platform}:${nonce}`;
        if (consumedKeys.has(k)) return false;
        consumedKeys.add(k);
        return true;
      });

      const exchangeCode = vi.fn(async () => ({
        accessToken: "shpat_live_token",
        refreshToken: null,
        accessTokenExpiresAt: null,
        externalAccountId: "gid://shopify/Shop/123456",
        providerEnvironment: "production",
        externalAccountIdentityScheme: "provider_user_id",
        externalDisplayName: "Partner Shop",
      }));

      const service = new DropshipStoreConnectionService({
        vendorProvisioning: {
          provisionForMember: vi.fn(async () => ({
            created: false,
            vendor: {
              vendorId: 10,
              memberId: "member-10",
              status: "active",
              entitlementStatus: "active",
            } as any,
          })),
        } as any,
        repository: {
          consumeOAuthStateNonce,
          listByVendorId: vi.fn(async () => []),
          countActiveByVendorId: vi.fn(async () => 0),
          hasReconnectableConnection: vi.fn(async () => false),
          isMarketplaceIdentityBound: vi.fn(async () => false),
          connectStore: vi.fn(async () => ({
            storeConnectionId: 77,
            vendorId: 10,
            platform: "shopify",
            status: "connected",
            setupStatus: "pending",
            launchReady: false,
          })) as any,
        } as any,
        dropshipOmsWarehouses: {
          listEligibleWarehouses: vi.fn(async () => []),
        } as any,
        oauthProviders: {
          shopify: {
            platform: "shopify",
            createAuthorizationUrl: vi.fn(),
            exchangeCode,
          },
          ebay: {
            platform: "ebay",
            createAuthorizationUrl: vi.fn(),
            exchangeCode: vi.fn(),
          },
        },
        stateSigner: signer,
        tokenCipher: {
          seal: vi.fn(({ tokenKind }) => ({
            tokenKind,
            tokenRef: `ref-${tokenKind}`,
            keyId: "k1",
            ciphertext: "ct",
            iv: "iv",
            authTag: "tag",
            expiresAt: null,
          })),
        },
        clock: { now: () => now },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const first = await service.completeOAuthCallback({
        state: signedState,
        code: "oauth-code-1",
        platform: "shopify",
        shop: "partner-shop.myshopify.com",
      });
      expect(first.connection.storeConnectionId).toBe(77);
      expect(consumeOAuthStateNonce).toHaveBeenCalledTimes(1);
      expect(exchangeCode).toHaveBeenCalledTimes(1);

      // Replay with the same signed state MUST fail BEFORE provider token exchange!
      await expect(
        service.completeOAuthCallback({
          state: signedState,
          code: "oauth-code-2",
          platform: "shopify",
          shop: "partner-shop.myshopify.com",
        }),
      ).rejects.toMatchObject({
        code: "DROPSHIP_OAUTH_STATE_REPLAYED",
      });
      expect(exchangeCode).toHaveBeenCalledTimes(1);
    });
  });

  describe("Structural convergence guards (OMS acceptance, channels.* config API, shared eBay pager)", () => {
    it("keeps dropship-order-acceptance.repository.ts on OMS authority commands with zero raw oms.* INSERTs or reservations", () => {
      const acceptanceSrc = readRepoFile(
        "server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts",
      );
      expect(acceptanceSrc).toContain("createDropshipOrderInTransaction");
      expect(acceptanceSrc).toContain("confirmStagedDropshipOrderPaidInTransaction");
      expect(acceptanceSrc).not.toMatch(/INSERT\s+INTO\s+oms\./i);
      expect(acceptanceSrc).not.toContain("reserved_qty = reserved_qty +");
    });

    it("eliminates all direct channels.* SQL from dropship-oms-channel-config.repository.ts behind channel-registry-mutations.api.ts", () => {
      const configRepoSrc = readRepoFile(
        "server/modules/dropship/infrastructure/dropship-oms-channel-config.repository.ts",
      );
      expect(configRepoSrc).toContain("listDropshipOmsChannelOptionsInTx");
      expect(configRepoSrc).toContain("findDropshipDefaultOmsChannelIdInTx");
      expect(configRepoSrc).toContain("lockDropshipOmsChannelByIdInTx");
      expect(configRepoSrc).not.toMatch(/FROM\s+channels\./i);
      expect(configRepoSrc).not.toMatch(/UPDATE\s+channels\./i);
      expect(configRepoSrc).not.toMatch(/INSERT\s+INTO\s+channels\./i);
    });

    it("routes dropship eBay order intake paging through shared channels/ebay-connector.api.ts primitives", async () => {
      const intakeProviderSrc = readRepoFile(
        "server/modules/dropship/infrastructure/dropship-ebay-order-intake.provider.ts",
      );
      expect(intakeProviderSrc).toContain("paginateEbayFulfillmentOrders");
      expect(intakeProviderSrc).toContain("fetchEbayFulfillmentResource");
      expect(intakeProviderSrc).toContain('from "../../channels/ebay-connector.api"');
      expect(intakeProviderSrc).not.toContain("https://api.ebay.com");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              total: 3,
              orders: [{ orderId: "ORD-1" }, { orderId: "ORD-2" }],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              total: 3,
              orders: [{ orderId: "ORD-3" }],
            }),
            { status: 200 },
          ),
        );

      const paged = await paginateEbayFulfillmentOrders({
        environment: "production",
        accessToken: "tok",
        filter: "lastmodifieddate:[2026-11-19T00:00:00Z..2026-11-19T12:00:00Z]",
        pageSize: 2,
        fetchImpl: fetchMock as any,
        createNetworkError: (e) => new Error(String(e)),
        createInvalidJsonError: () => new Error("bad json"),
        createHttpError: (s) => new Error(`http ${s}`),
      });
      expect(paged.map((o) => o.orderId)).toEqual(["ORD-1", "ORD-2", "ORD-3"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("Dropship Partner Feed ChannelOrderAdapter (P3.1 conformance)", () => {
    const partnerSecret = "partner_hmac_secret_32_characters_minimum";
    const adapter = createDropshipPartnerOrderIntakeAdapter({
      webhookSecret: partnerSecret,
    });

    const validRawOrder = {
      vendorId: 42,
      externalOrderId: "DP-88001",
      externalOrderNumber: "PARTNER-88001",
      orderedAt: "2026-11-19T12:00:00.000Z",
      shipTo: {
        name: "Sam Collector",
        address1: "200 Oak Ave",
        city: "Chicago",
        region: "IL",
        postalCode: "60601",
        country: "US",
        email: "sam@example.com",
      },
      totals: {
        retailSubtotalCents: 2998,
        shippingPaidCents: 499,
        taxCents: 0,
        discountCents: 0,
        grandTotalCents: 3497,
        currency: "usd",
      },
      lines: [
        {
          externalLineItemId: "dp-line-1",
          sku: "CS-SEMI-RIGID",
          title: "Semi-Rigid Card Holder",
          quantity: 2,
          unitRetailPriceCents: 1499,
        },
      ],
    };

    it("verifies HMAC-SHA256 partner webhook signatures and normalizes orders, cancels, and refunds through P3.1 schemas", async () => {
      const rawBytes = Buffer.from(JSON.stringify(validRawOrder), "utf8");
      const sig = crypto
        .createHmac("sha256", partnerSecret)
        .update(rawBytes)
        .digest("hex");

      expect(
        await adapter.verifyWebhook({
          rawBody: rawBytes,
          headers: { "x-dropship-partner-signature": sig },
        }),
      ).toEqual({ ok: true });

      expect(
        (
          await adapter.verifyWebhook({
            rawBody: rawBytes,
            headers: { "x-dropship-partner-signature": "bad" },
          })
        ).ok,
      ).toBe(false);

      const order = adapter.normalizeOrder(validRawOrder, { channelId: 7 });
      expect(order.source).toBe("dropship_partner");
      expect(order.externalOrderId).toBe("DP-88001");
      expect(order.totalCents).toBe(3497);
      expect(order.currency).toBe("USD");
      expect(order.externalCustomerId).toBe("dropship_vendor:42");
      expect(order.lineItems).toHaveLength(1);

      expect(() =>
        adapter.normalizeOrder({ externalOrderId: "" }, { channelId: 7 }),
      ).toThrow(ChannelOrderBoundaryValidationError);

      expect(adapter.normalizeCancel(validRawOrder, { channelId: 7 })).toBeNull();
      const cancel = adapter.normalizeCancel(
        { ...validRawOrder, cancelledAt: "2026-11-19T13:00:00.000Z" },
        { channelId: 7 },
      );
      expect(cancel?.source).toBe("dropship_partner");

      expect(adapter.normalizeRefund(validRawOrder, { channelId: 7 })).toBeNull();
      const refund = adapter.normalizeRefund(
        { ...validRawOrder, refundAmountCents: 3497 },
        { channelId: 7 },
      );
      expect(refund?.refundAmountCents).toBe(3497);
      expect(refund?.financialStatus).toBe("refunded");
    });
  });
});
