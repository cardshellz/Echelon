import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { buildListingRegistrationPlan } from "../../domain/listing-registration-plan";
import {
  buildListingReplacementPlan,
  type ListingOwnerRef,
} from "../../domain/listing-replacement-plan";
import { PgMarketplaceListingRegistrationRepository } from "../../infrastructure/pg-listing-registration.repository";
import { PgMarketplaceListingReplacementRepository } from "../../infrastructure/pg-listing-replacement.repository";
import { PgMarketplaceListingReplacementExecutionRepository } from "../../infrastructure/pg-listing-replacement-execution.repository";
import {
  EbayMarketplaceListingReplacementProvider,
  type EbayListingReplacementClient,
} from "../../infrastructure/providers/ebay/ebay-listing-replacement.provider";
import { ListingReplacementExecutionService } from "../../application/listing-replacement-execution.service";
import type {
  ClaimedListingReplacementStep,
  ListingReplacementStepSuccess,
} from "../../application/execution-ports";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const actor = { type: "user", id: "recovery-test" } as const;
const owner: ListingOwnerRef = {
  kind: "channel",
  channelId: 1,
  productId: 1,
  provider: "ebay",
  marketplaceId: "EBAY_US",
};
const oldTime = new Date("2026-08-01T12:00:00Z");
const variants = [
  { id: 1, sku: "C700" },
  { id: 2, sku: "C750" },
  { id: 3, sku: "P50" },
];

// Reuse the existing minimal owner DDL. Listing tables and every trigger below
// come from the actual migrations, not weakened test replicas.
const ownerFixture = readFileSync(
  resolve(
    "server/modules/marketplace-listings/__tests__/integration/marketplace-listing-registration.pg.sql",
  ),
  "utf8",
)
  .split("\\ir ")[0]
  .split("\n")
  .filter((line) => !line.startsWith("\\"))
  .join("\n");

(url && disposable ? describe : describe.skip).sequential(
  "listing replacement recovery with real immutable history guards",
  () => {
    let database: InventoryCutoverTestDatabase;
    let execution: PgMarketplaceListingReplacementExecutionRepository;
    let registration: PgMarketplaceListingRegistrationRepository;
    let operationId: number;
    let scopeId: number;
    let sourceId: number;
    let clockMs: number;
    const now = () => new Date((clockMs += 1000));

    beforeEach(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        ownerFixture,
      );
      for (const migration of [
        "0607_marketplace_listing_replacement_foundation.sql",
        "0609_marketplace_listing_registration.sql",
        "0610_marketplace_listing_verification_snapshots.sql",
      ]) {
        await database.pool.query(
          readFileSync(resolve("migrations", migration), "utf8"),
        );
      }
      await database.pool.query(`
      ALTER TABLE catalog.product_variants ADD COLUMN is_active boolean NOT NULL DEFAULT true,
        ADD COLUMN sales_eligibility text NOT NULL DEFAULT 'sellable';
      INSERT INTO catalog.products (id,name) OVERRIDING SYSTEM VALUE VALUES (1,'Envelopes');
      INSERT INTO catalog.product_variants (id,product_id,sku,name) OVERRIDING SYSTEM VALUE VALUES
        (1,1,'C700','Retired case'),(2,1,'C750','Current case'),(3,1,'P50','Pack');
      INSERT INTO channels.channels (id,name,provider) OVERRIDING SYSTEM VALUE VALUES (1,'eBay','ebay');
      INSERT INTO ebay.ebay_oauth_tokens(channel_id,environment,access_token,access_token_expires_at,refresh_token,
        external_account_id,external_account_identity_scheme,external_account_verified_at)
        VALUES(1,'production','fixture-only','2026-08-02','fixture-only','test-account','provider_user_id','2026-08-01T12:00:00Z');
    `);
      registration = new PgMarketplaceListingRegistrationRepository(
        database.pool,
      );
      execution = new PgMarketplaceListingReplacementExecutionRepository(
        database.pool,
      );
      const plan = registrationPlan(oldTime, "register", false);
      const registered = await registration.registerOrReplay({
        plan,
        registeredAt: oldTime,
        accountClaim: {
          kind: "claimed",
          owner,
          provider: "ebay",
          accountNamespace: "production",
          externalAccountId: "test-account",
          identityScheme: "provider_user_id",
          verifiedAt: oldTime,
        },
      });
      sourceId = registered.receipt.publicationId;
      scopeId = registered.receipt.scopeId;
      const planned = await new PgMarketplaceListingReplacementRepository(
        database.pool,
      ).createOrReplayPlan(
        buildListingReplacementPlan({
          snapshot: {
            owner,
            scopeId,
            sourcePublication: {
              publicationId: sourceId,
              generation: 1,
              status: "active",
              desiredStateHash: plan.desiredStateHash,
              providerPublicationKey: "ENVELOPE",
              externalListingId: "old-listing",
            },
            nextGeneration: 2,
            memberCandidates: variants.map((variant) => ({
              productVariantId: variant.id,
              sku: variant.sku,
              currentlyPublished: variant.id !== 2,
            })),
          },
          requestedMembers: variants.map((variant) => ({
            productVariantId: variant.id,
            disposition: variant.id === 1 ? "excluded" : "included",
            reasonCode: variant.id === 1 ? "retired" : null,
          })),
          idempotencyKey: "replace",
          requestedBy: actor,
          correlationId: "recovery-fixture",
          requestedAt: oldTime,
        }),
      );
      operationId = planned.operation.operationId;
      clockMs = planned.operation.createdAt.getTime() + 1000;
      let claimed = await claim();
      await execution.completeStep({
        claim: claimed,
        result: { evidence: { preflight: true } },
        completedAt: now(),
      });
      claimed = await claim(claimed.leaseToken);
      await execution.completeStep({
        claim: claimed,
        result: { evidence: { sourceQuiesced: true } },
        completedAt: now(),
      });
      claimed = await claim(claimed.leaseToken);
      await execution.beginCompensation({
        claim: claimed,
        errorCode: "FIXTURE_PUBLISH_FAILED",
        errorMessage: "Historical publish failed",
        evidence: {},
        failedAt: now(),
      });
      claimed = await claim(claimed.leaseToken);
      await execution.completeStep({
        claim: claimed,
        result: { evidence: { targetNotSellable: true } },
        completedAt: now(),
      });
      claimed = await claim(claimed.leaseToken);
      await execution.requireManualRecovery({
        claim: claimed,
        errorCode: "FIXTURE_DATABASE_ERROR",
        errorMessage: "Historical recovery failed",
        evidence: {},
        failedAt: now(),
      });
    });
    afterEach(async () => {
      await database?.close();
    });

    async function claim(
      leaseToken: string | null = null,
    ): Promise<ClaimedListingReplacementStep> {
      const result = await execution.claimNextStep({
        operationId,
        expectedOwner: owner,
        actor,
        leaseToken,
        now: now(),
        leaseDurationMs: 300_000,
        recoveryAuthorized: true,
      });
      if ("kind" in result)
        throw new Error(`Unexpected terminal operation ${result.status}`);
      return result;
    }
    async function verifyCorrection(key = "corrected") {
      const at = now();
      await registration.verifyExistingPublication({
        plan: registrationPlan(at, key, true),
        verifiedAt: at,
      });
    }
    async function history() {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        return (
          await client.query(
            `SELECT to_jsonb(publication) AS publication,
      (SELECT jsonb_agg(member ORDER BY product_variant_id) FROM marketplace.listing_publication_members member WHERE publication_id=$1) AS members
      FROM marketplace.listing_publications publication WHERE id=$1`,
            [sourceId],
          )
        ).rows;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    async function counts() {
      return (
        await database.pool.query(
          `SELECT
      (SELECT count(*)::int FROM marketplace.listing_verification_snapshots) verifications,
      (SELECT count(*)::int FROM marketplace.listing_replacement_events) events,
      (SELECT status FROM marketplace.listing_replacement_operations WHERE id=$1) status`,
          [operationId],
        )
      ).rows[0];
    }

    it("proves the original source update is forbidden, then records normal compensation append-only", async () => {
      const before = await history();
      await expect(
        database.pool.query(
          "UPDATE marketplace.listing_publications SET verified_at = verified_at + interval '1 second' WHERE id=$1",
          [sourceId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const claimed = await claim();
      expect(claimed.operation.sourceVerification).toBeNull();
      await execution.completeCompensationAndFailOperation({
        claim: claimed,
        result: restored(claimed),
        completedAt: now(),
      });
      expect(await history()).toEqual(before);
      expect(await counts()).toMatchObject({
        verifications: 1,
        status: "failed",
      });
    });

    it("reconciles current P50/C750 with GETs only, preserves C700 history, and retries without duplicate evidence", async () => {
      await verifyCorrection();
      const before = await history();
      const noWrite = vi.fn(async () => {
        throw new Error("Provider writes are forbidden in this recovery");
      });
      const client: EbayListingReplacementClient = {
        getInventoryItemGroup: async (key) =>
          key === "ENVELOPE"
            ? { variantSKUs: variants.map((variant) => variant.sku) }
            : null,
        getOffers: async (sku) => [
          {
            offerId: `offer-${sku}`,
            sku,
            status: sku === "C700" ? "UNPUBLISHED" : "PUBLISHED",
            listingId: sku === "C700" ? undefined : "corrected-listing",
          },
        ],
        getInventoryItem: async () => null,
        createOrReplaceInventoryItemGroup: noWrite,
        deleteInventoryItemGroup: noWrite,
        createOffer: noWrite,
        publishOffer: noWrite,
        publishOfferByInventoryItemGroup: noWrite,
        withdrawOffer: noWrite,
        withdrawOfferByInventoryItemGroup: noWrite,
      };
      const provider = new EbayMarketplaceListingReplacementProvider({
        forOwner: async () => client,
      });
      const service = new ListingReplacementExecutionService({
        repository: execution,
        providers: { forOwner: () => provider },
        clock: { now },
      });
      await expect(
        service.recover({ operationId, expectedOwner: owner, actor }),
      ).resolves.toMatchObject({
        kind: "failed",
        stepKey: "compensate.ensure_source_live",
      });
      const first = await counts();
      expect(first).toMatchObject({ verifications: 2, status: "failed" });
      await expect(
        service.recover({ operationId, expectedOwner: owner, actor }),
      ).resolves.toMatchObject({
        kind: "failed",
        stepKey: "operation.terminal",
      });
      expect(await counts()).toEqual(first);
      expect(await history()).toEqual(before);
      expect(noWrite).not.toHaveBeenCalled();
      const latest = (
        await database.pool.query(
          `SELECT external_listing_id, evidence FROM marketplace.listing_verification_snapshots ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0];
      expect(latest).toMatchObject({
        external_listing_id: "corrected-listing",
        evidence: { recoveryMode: "verified_source_read_only", operationId },
      });
      const state = (
        await database.pool.query(
          `SELECT p.status FROM marketplace.listing_publications p JOIN marketplace.listing_replacement_operations o ON o.target_publication_id=p.id WHERE o.id=$1`,
          [operationId],
        )
      ).rows[0];
      expect(state.status).toBe("failed");
      await expect(
        registration.findCurrentRegistration(owner),
      ).resolves.toMatchObject({
        externalListingId: "corrected-listing",
        registeredVariantIds: [2, 3],
        registeredVariants: [
          { productVariantId: 1, disposition: "excluded" },
          { productVariantId: 2, disposition: "included" },
          { productVariantId: 3, disposition: "included" },
        ],
      });
      const pending = (
        await database.pool.query(
          `SELECT EXISTS(SELECT 1 FROM marketplace.listing_publications WHERE scope_id=$1 AND status IN ('planned','staged')) AS pending`,
          [scopeId],
        )
      ).rows[0];
      expect(pending.pending).toBe(false);
    });

    it("rolls back every completion write when the append-only evidence cannot persist", async () => {
      await verifyCorrection();
      const claimed = await claim();
      const before = await counts();
      await database.pool
        .query(`CREATE FUNCTION marketplace.test_reject_verification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER test_reject_verification BEFORE INSERT ON marketplace.listing_verification_snapshots FOR EACH ROW EXECUTE FUNCTION marketplace.test_reject_verification();`);
      await expect(
        execution.completeCompensationAndFailOperation({
          claim: claimed,
          result: restored(claimed),
          completedAt: now(),
        }),
      ).rejects.toMatchObject({
        code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
        context: { code: "23514" },
      });
      expect(await counts()).toEqual(before);
      const step = (
        await database.pool.query(
          "SELECT status FROM marketplace.listing_replacement_steps WHERE id=$1",
          [claimed.stepId],
        )
      ).rows[0];
      expect(step.status).toBe("running");
    });

    it("rejects a concurrent verification change instead of sealing stale provider proof", async () => {
      await verifyCorrection();
      const claimed = await claim();
      await verifyCorrection("newer-correction");
      const before = await counts();
      await expect(
        execution.completeCompensationAndFailOperation({
          claim: claimed,
          result: restored(claimed),
          completedAt: now(),
        }),
      ).rejects.toMatchObject({
        code: "MARKETPLACE_LISTING_REPLACEMENT_RECOVERY_VERIFICATION_CONFLICT",
      });
      expect(await counts()).toEqual(before);
    });

    it("grants only one recovery lease to concurrent callers", async () => {
      await verifyCorrection();
      const results = await Promise.allSettled([claim(), claim()]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: { code: "MARKETPLACE_LISTING_REPLACEMENT_LEASE_CONFLICT" },
      });
    });

    it.each([
      "missing-member",
      "duplicate-member",
      "wrong-listing",
      "wrong-group",
      "wrong-offer",
      "missing-proof",
    ])(
      "rejects incomplete or mismatched recovery evidence: %s",
      async (failure) => {
        await verifyCorrection();
        const claimed = await claim();
        const result = restored(claimed);
        const malformed: ListingReplacementStepSuccess = {
          ...result,
          ...(failure === "missing-member" ? { memberIdentities: [] } : {}),
          ...(failure === "duplicate-member"
            ? {
                memberIdentities: [
                  result.memberIdentities![0],
                  result.memberIdentities![0],
                ],
              }
            : {}),
          ...(failure === "wrong-listing"
            ? { externalListingId: "other" }
            : {}),
          ...(failure === "wrong-group"
            ? { providerPublicationKey: "other" }
            : {}),
          ...(failure === "wrong-offer"
            ? {
                memberIdentities: result.memberIdentities!.map((identity) => ({
                  ...identity,
                  externalOfferId: "another-offer",
                })),
              }
            : {}),
          ...(failure === "missing-proof" ? { evidence: {} } : {}),
        };
        const before = await counts();
        await expect(
          execution.completeCompensationAndFailOperation({
            claim: claimed,
            result: malformed,
            completedAt: now(),
          }),
        ).rejects.toMatchObject({
          code: "MARKETPLACE_LISTING_REPLACEMENT_RECOVERY_VERIFICATION_CONFLICT",
        });
        expect(await counts()).toEqual(before);
      },
    );
  },
);

function restored(
  claim: ClaimedListingReplacementStep,
): ListingReplacementStepSuccess {
  return {
    externalListingId: claim.operation.sourcePublication.externalListingId,
    providerPublicationKey:
      claim.operation.sourcePublication.providerPublicationKey,
    evidence: claim.operation.sourceVerification?.readOnlyRecovery
      ? {
          recoveryMode: "verified_source_read_only",
          sourceVerificationId: claim.operation.sourceVerification.id,
          targetGroupAbsent: true,
        }
      : { sourceLive: true },
    memberIdentities: claim.operation.sourceMembers
      .filter((member) => member.disposition === "included")
      .map((member) => ({
        productVariantId: member.productVariantId,
        externalVariantId: member.externalVariantId,
        externalOfferId: member.externalOfferId,
        externalInventoryItemId: member.externalInventoryItemId,
      })),
  };
}

function registrationPlan(observedAt: Date, key: string, corrected: boolean) {
  const listingId = corrected ? "corrected-listing" : "old-listing";
  return buildListingRegistrationPlan({
    owner,
    requestedBy: actor,
    idempotencyKey: key,
    correlationId: null,
    locator: {
      providerPublicationKey: "ENVELOPE",
      externalListingId: listingId,
    },
    snapshot: {
      owner,
      memberCandidates: variants.map((variant) => ({
        productVariantId: variant.id,
        sku: variant.sku,
        isActive: true,
        availableQuantity: 0,
      })),
    },
    observation: {
      providerAccount: {
        provider: "ebay",
        accountNamespace: "production",
        externalAccountId: "test-account",
        identityScheme: "provider_user_id",
        externalDisplayNameSnapshot: "Test account",
        evidenceHash: "a".repeat(64),
      },
      marketplaceId: "EBAY_US",
      publicationKeyIdentity: {
        identityNamespace: "ebay.group",
        externalId: "ENVELOPE",
      },
      listingIdentity: {
        identityNamespace: "ebay.listing",
        externalId: listingId,
      },
      externalUrl: null,
      isPublished: true,
      members: variants
        .filter((variant) => variant.id !== (corrected ? 1 : 2))
        .map((variant) => ({
          sku: variant.sku,
          variantIdentity: null,
          offerIdentity: {
            identityNamespace: "ebay.offer",
            externalId: `offer-${variant.sku}`,
          },
          inventoryItemIdentity: {
            identityNamespace: "ebay.item",
            externalId: variant.sku,
          },
        })),
      evidence: { fixture: key },
      observedAt,
    },
  });
}
