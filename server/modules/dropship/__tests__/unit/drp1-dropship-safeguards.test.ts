import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  confirmStagedDropshipOrderPaidInTransaction,
  createDropshipOrderInTransaction,
  DropshipOmsOrderCommandError,
} from "../../../oms/dropship-order-authority.api";
import {
  ShopifyListingConnectorHttpError,
  ShopifyMarketplaceListingConnector,
} from "../../../channels/listing-connectors/shopify-listing.connector";
import {
  DropshipAuthService,
  type DropshipAuthIdentityRecord,
} from "../../application/dropship-auth-service";
import { reconcileCostSchedule } from "../../domain/cost-schedule";
import { PgDropshipListingTierRepository } from "../../infrastructure/dropship-listing-tier.repository";
import { PgDropshipOrderAcceptanceRepository } from "../../infrastructure/dropship-order-acceptance.repository";
import { PgDropshipPaymentHoldExpirationRepository } from "../../infrastructure/dropship-payment-hold-expiration.repository";

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("Priority 8 — DRP-1 Dropship & Vendor Operations safeguards", () => {
  describe("COM-01 / OR-F01 / COM-02: OMS-owned dropship order creation and paid promotion seam", () => {
    it("creates OMS order, creation event, and dropship order lines in the caller's transaction", async () => {
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const client = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.includes("INSERT INTO oms.oms_orders")) {
            return { rows: [{ id: 4401 }] };
          }
          if (sql.includes("INSERT INTO oms.oms_order_events")) {
            return { rows: [] };
          }
          if (sql.includes("INSERT INTO oms.oms_order_lines")) {
            return {
              rows: [{ id: 8801, product_variant_id: Number(params[1]), quantity: Number(params[6]) }],
            };
          }
          if (sql.includes("UPDATE oms.oms_orders")) {
            return { rows: [{ id: 4401 }] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
      };

      const acceptedAt = new Date("2026-11-10T12:00:00.000Z");
      const created = await createDropshipOrderInTransaction(client as any, {
        channelId: 103,
        omsExternalOrderId: "dropship:22:EBAY-500",
        externalOrderNumber: "10-500",
        externalOrderId: "EBAY-500",
        intakeId: 77,
        vendorId: 10,
        storeConnectionId: 22,
        vendorMembershipPlanId: "plan-ops",
        buyerShippingServiceCode: "USPSPriority",
        marketplaceRawPayload: { orderId: "EBAY-500" },
        shipTo: {
          name: "Buyer",
          email: "buyer@example.com",
          phone: null,
          address1: "1 Main St",
          address2: null,
          city: "Pittsburgh",
          region: "PA",
          postalCode: "16046",
          country: "US",
        },
        wholesaleSubtotalCents: 1618,
        shippingCents: 1122,
        totalDebitCents: 2740,
        currency: "USD",
        warehouseId: 1,
        orderedAt: acceptedAt,
        acceptedAt,
        stagedForCanonicalAcceptance: true,
        lines: [
          {
            productVariantId: 66,
            productId: 5,
            externalLineItemId: "li-1",
            sku: "ARM-ENV",
            title: "Armalope",
            quantity: 2,
            wholesaleUnitCostCents: 809,
            wholesaleLineTotalCents: 1618,
          },
        ],
      });

      expect(created).toEqual({
        omsOrderId: 4401,
        lines: [{ id: 8801, product_variant_id: 66, quantity: 2 }],
      });
      expect(queries).toHaveLength(3);
      expect(queries[0].sql).toContain("'pending', 'pending'");

      await confirmStagedDropshipOrderPaidInTransaction(client as any, {
        omsOrderId: 4401,
        acceptedAt,
      });
      expect(queries[3].sql).toContain("SET status = 'confirmed'");
    });

    it("throws DropshipOmsOrderCommandError on duplicate external order key or invalid promotion stage", async () => {
      const conflictClient = {
        query: vi.fn(async () => ({ rows: [] })),
      };
      await expect(
        createDropshipOrderInTransaction(conflictClient as any, {
          channelId: 103,
          omsExternalOrderId: "dropship:22:EBAY-DUP",
          externalOrderNumber: "10-DUP",
          externalOrderId: "EBAY-DUP",
          intakeId: 78,
          vendorId: 10,
          storeConnectionId: 22,
          vendorMembershipPlanId: "plan-ops",
          buyerShippingServiceCode: null,
          marketplaceRawPayload: {},
          shipTo: {
            name: "Buyer",
            address1: "1 Main St",
            city: "Pittsburgh",
            region: "PA",
            postalCode: "16046",
            country: "US",
          },
          wholesaleSubtotalCents: 809,
          shippingCents: 500,
          totalDebitCents: 1309,
          currency: "USD",
          warehouseId: 1,
          orderedAt: new Date("2026-11-10T12:00:00.000Z"),
          acceptedAt: new Date("2026-11-10T12:00:00.000Z"),
          lines: [],
        }),
      ).rejects.toMatchObject({
        code: "OMS_DROPSHIP_ORDER_EXTERNAL_KEY_CONFLICT",
      });

      await expect(
        confirmStagedDropshipOrderPaidInTransaction(conflictClient as any, {
          omsOrderId: 9999,
          acceptedAt: new Date("2026-11-10T12:00:00.000Z"),
        }),
      ).rejects.toBeInstanceOf(DropshipOmsOrderCommandError);
    });
  });

  describe("VID-01: Active local identity guard on bootstrap and password reset", () => {
    it("refuses account bootstrap and password reset when the local auth identity is locked or disabled", async () => {
      const lockedIdentity: DropshipAuthIdentityRecord = {
        authIdentityId: 501,
        memberId: "member-locked",
        primaryEmail: "locked@cardshellz.test",
        passwordHash: "hashed:OldPassword123",
        passwordHashAlgorithm: "test",
        status: "locked",
        passkeyEnrolledAt: null,
      };
      const consumeChallenge = vi.fn();
      const service = new DropshipAuthService({
        identity: {
          resolveMemberByCardShellzEmail: async () => ({
            memberId: "member-locked",
            cardShellzEmail: "locked@cardshellz.test",
            memberStatus: "active",
          }),
        },
        entitlement: {
          getEntitlementByMemberId: async () => ({
            memberId: "member-locked",
            cardShellzEmail: "locked@cardshellz.test",
            status: "active",
            planId: "plan-ops",
            planName: ".ops",
            subscriptionId: "sub-1",
            includesDropship: true,
            reasonCode: "ENTITLED",
          }),
        },
        authIdentities: {
          findAuthIdentityByMemberId: async () => lockedIdentity,
          findAuthIdentityByPrimaryEmail: async () => lockedIdentity,
          upsertPasswordIdentity: async () => lockedIdentity,
          upsertEmailVerifiedIdentity: async () => lockedIdentity,
          touchLastLogin: async () => {},
          createEmailChallenge: async () => ({
            challengeId: 1,
            created: true,
            expiresAt: new Date("2026-11-10T12:10:00.000Z"),
          }),
          consumeLatestEmailChallenge: consumeChallenge,
        },
        emailSender: {
          sendVerificationCode: async () => {},
        },
        passwordHasher: {
          algorithm: "test",
          hash: async (pwd) => `hashed:${pwd}`,
          verify: async () => true,
        },
        codeGenerator: {
          generateCode: () => "123456",
        },
        clock: {
          now: () => new Date("2026-11-10T12:00:00.000Z"),
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        challengeSecret: "secret-1",
      });

      await expect(
        service.completeAccountBootstrap({
          email: "locked@cardshellz.test",
          verificationCode: "123456",
          password: "StrongPassword123",
        }),
      ).rejects.toMatchObject({
        code: "DROPSHIP_AUTH_IDENTITY_INACTIVE",
        context: { memberId: "member-locked", status: "locked" },
      });

      await expect(
        service.completePasswordReset({
          email: "locked@cardshellz.test",
          verificationCode: "123456",
          password: "StrongPassword123",
        }),
      ).rejects.toMatchObject({
        code: "DROPSHIP_AUTH_IDENTITY_INACTIVE",
        context: { memberId: "member-locked", status: "locked" },
      });

      expect(consumeChallenge).not.toHaveBeenCalled();
    });
  });

  describe("CF-F01: Monotonic archive tombstone on funding method upserts", () => {
    it("preserves archived status, non-default flag, and metadata on conflicting funding method upserts", () => {
      const walletRepoSrc = readSource("../../infrastructure/dropship-wallet.repository.ts");
      expect(walletRepoSrc).toContain(
        "SET status = CASE WHEN fm.status = 'archived' THEN fm.status ELSE EXCLUDED.status END",
      );
      expect(walletRepoSrc).toContain(
        "is_default = CASE WHEN fm.status = 'archived' THEN false ELSE (fm.is_default OR EXCLUDED.is_default) END",
      );
      expect(walletRepoSrc).toContain(
        "metadata = CASE WHEN fm.status = 'archived' THEN fm.metadata ELSE EXCLUDED.metadata END",
      );
    });
  });

  describe("DS-P01: Repeated equal delayed cost decreases preserve original effective date", () => {
    it("returns zero operations when an identical delayed decrease is already scheduled in the future", () => {
      const initialEffectiveAt = new Date("2026-11-17T00:00:00.000Z");
      const result = reconcileCostSchedule({
        entries: [
          {
            entryId: 1,
            unitCostCents: 1000,
            effectiveAt: new Date("2026-11-01T00:00:00.000Z"),
          },
          {
            entryId: 2,
            unitCostCents: 850,
            effectiveAt: initialEffectiveAt,
          },
        ],
        reading: {
          unitCostCents: 850,
          observedAt: new Date("2026-11-12T00:00:00.000Z"),
          retailDriven: false,
        },
        timing: {
          increaseNoticeDays: 7,
          decreaseTiming: "after_notice",
          retailChangesGetNotice: true,
        },
      });

      expect(result).toEqual({
        operations: [],
        inForceBeforeCents: 1000,
        inForceAfterCents: 1000,
      });
    });
  });

  describe("DS-E01: Tier reconciliation fair vendor ordering", () => {
    it("orders unapplied holds first, then never-evaluated vendors, then oldest evaluated_at before vendor id", async () => {
      const query = vi.fn(async () => ({ rows: [] }));
      const repo = new PgDropshipListingTierRepository({ query } as unknown as Pool);
      await repo.listVendorsForReview({ limit: 50 });

      expect(query).toHaveBeenCalledTimes(1);
      const sql = String((query.mock.calls[0] as unknown[])?.[0] ?? "");
      expect(sql).toContain(
        "ORDER BY CASE WHEN h.applied = false THEN 0 WHEN h.evaluated_at IS NULL THEN 1 ELSE 2 END ASC",
      );
      expect(sql).toContain("h.evaluated_at ASC NULLS FIRST");
    });
  });

  describe("DS7-F01: Bounded request timeout on ShopifyMarketplaceListingConnector", () => {
    it("aborts stalled GraphQL and REST requests and raises retryable HTTP 504 timeout error", async () => {
      const connector = new ShopifyMarketplaceListingConnector({
        fetchImpl: () => new Promise<Response>(() => {}),
        delay: async () => {},
        maxRetries: 2,
        requestTimeoutMs: 15,
      });

      await expect(
        connector.pushProductSet({
          credentials: {
            shopDomain: "vendor.myshopify.com",
            accessToken: "shpat_test",
            apiVersion: "2025-10",
          },
          productSet: { title: "Test" },
          existingExternalListingId: null,
          sku: "SKU-1",
        }),
      ).rejects.toMatchObject({
        name: "ShopifyListingConnectorHttpError",
        status: 504,
        retryable: true,
      });

      await expect(
        connector.pushChannelListing({
          credentials: {
            shopDomain: "vendor.myshopify.com",
            accessToken: "shpat_test",
            apiVersion: "2025-10",
          },
          listing: {
            productId: 1,
            title: "Test",
            description: "Desc",
            category: "Supplies",
            status: "active",
            tags: [],
            images: [],
            variants: [
              {
                variantId: 10,
                sku: "SKU-1",
                name: "Pack",
                priceCents: 1000,
                compareAtPriceCents: null,
                weightGrams: 100,
                barcode: null,
                gtin: null,
                mpn: null,
                externalVariantId: null,
                externalInventoryItemId: null,
                isListed: true,
              },
            ],
          },
        }),
      ).rejects.toBeInstanceOf(ShopifyListingConnectorHttpError);
    });
  });

  describe("OR-F02: Payment hold expiry vs. canonical claim compensation", () => {
    it("excludes payment_hold intakes with active canonical inventory claims from expirePaymentHolds", async () => {
      const queries: string[] = [];
      const client = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const repo = new PgDropshipPaymentHoldExpirationRepository({
        connect: async () => client,
      } as unknown as Pool);

      await repo.expirePaymentHolds({
        now: new Date("2026-11-10T12:00:00.000Z"),
        limit: 25,
        workerId: "worker-1",
      });

      const updateQuery = queries.find((sql) => sql.includes("WITH candidates AS")) ?? "";
      expect(updateQuery).toContain("FROM dropship.dropship_order_acceptance_stages AS stage");
      expect(updateQuery).toContain("stage.state IN ('inventory_claimed', 'compensation_pending')");
    });

    it("admits cancelled intakes with inventory_claimed canonical stages for release-only compensation", async () => {
      const now = new Date("2026-11-10T12:00:00.000Z");
      const requestHash = "a".repeat(64);
      const stageRow = {
        intake_id: 1,
        oms_order_id: 1001,
        vendor_id: 10,
        store_connection_id: 22,
        shipping_quote_snapshot_id: 33,
        warehouse_id: 1,
        wallet_account_id: 1,
        state: "inventory_claimed",
        claim_attempt_number: 1,
        wms_order_id: 9001,
        request_hash: requestHash,
        submitted_idempotency_key: "accept-order-0001",
        actor_type: "system",
        actor_id: "worker-1",
        member_id: "member-1",
        membership_plan_id: "plan-ops",
        currency: "USD",
        retail_subtotal_cents: 2000,
        wholesale_subtotal_cents: 1000,
        shipping_cents: 500,
        insurance_pool_cents: 0,
        fees_cents: 0,
        total_debit_cents: 1500,
        cost_evidence_hash: "b".repeat(64),
        pricing_snapshot: { version: 2, requestHash },
        prepared_at: now,
        inventory_claimed_at: now,
        inventory_release_requested_at: null,
        inventory_released_at: null,
        inventory_release_reason: null,
        expired_at: null,
        finalized_at: null,
      };
      const claimAttemptRow = {
        intake_id: 1,
        attempt_number: 1,
        oms_order_id: 1001,
        wms_order_id: 9001,
        warehouse_id: 1,
        claim_authority: "canonical",
        claim_owner: "dropship_acceptance",
        claim_outcome: "claimed",
        availability_claim_id: "7001",
        state: "claimed",
        claimed_at: now,
        release_requested_at: null,
        released_at: null,
        release_reason: null,
        expired_at: null,
        finalized_at: null,
      };
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rows: [] };
          }
          if (sql.includes("FROM dropship.dropship_order_intake")) {
            return {
              rows: [
                {
                  id: 1,
                  channel_id: 103,
                  vendor_id: 10,
                  store_connection_id: 22,
                  platform: "ebay",
                  external_order_id: "EBAY-1",
                  external_order_number: "10-1",
                  status: "cancelled",
                  payment_hold_expires_at: new Date("2026-11-10T11:00:00.000Z"),
                  normalized_payload: {},
                  raw_payload: {},
                  oms_order_id: 1001,
                },
              ],
            };
          }
          if (sql.includes("FROM dropship.dropship_order_acceptance_stages")) {
            return { rows: [stageRow] };
          }
          if (sql.includes("FROM dropship.dropship_order_acceptance_claim_attempts")) {
            return { rows: [claimAttemptRow] };
          }
          if (sql.includes("UPDATE dropship.dropship_order_acceptance_claim_attempts")) {
            return { rows: [] };
          }
          if (sql.includes("UPDATE dropship.dropship_order_acceptance_stages")) {
            return { rows: [] };
          }
          if (sql.includes("INSERT INTO dropship.dropship_audit_events")) {
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        release: vi.fn(),
      } as unknown as PoolClient;

      const repo = new PgDropshipOrderAcceptanceRepository({
        connect: async () => client,
      } as unknown as Pool);

      const prepared = await repo.prepareCanonicalOrder({
        intakeId: 1,
        vendorId: 10,
        storeConnectionId: 22,
        shippingQuoteSnapshotId: 33,
        requestHash,
        idempotencyKey: "accept-order-0001",
        acceptedAt: now,
        actor: { actorType: "system", actorId: "worker-1" },
      });

      expect(prepared.outcome).toBe("compensation_required");
      if (prepared.outcome === "compensation_required") {
        expect(prepared.wmsOrderId).toBe(9001);
        expect(prepared.inventoryClaimId).toBe("7001");
      }
    });
  });
});
