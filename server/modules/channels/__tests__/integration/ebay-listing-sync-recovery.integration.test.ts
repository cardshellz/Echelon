import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { EbayListingRecoveryService } from "../../ebay-listing-recovery.service";
import { PostgresEbayListingRecoveryContinuation } from "../../infrastructure/ebay-listing-recovery-continuation";
import { EbayAutomaticPublicationRecoveryService } from "../../../inventory-planning/application/ebay-automatic-publication-recovery.service";
import { PostgresEbayAutomaticPublicationRecoveryRepository } from "../../../inventory-planning/infrastructure/ebay-automatic-publication-recovery.repository";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import {
  cutoverCompositionBaseSql,
  cutoverCompositionSeedSql,
  cutoverCompositionLegacyChannelSeedSql,
  installCutoverCompositionMigrations,
} from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import {
  PostgresQuantityPublicationAdmission,
  attestQuantityPublicationAttemptInsideTransaction,
} from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { PostgresQuantityProviderResponseRecovery } from "../../../inventory-planning/infrastructure/quantity-provider-response-recovery.repository";
import { PostgresEbayPublicationRecoveryRepository } from "../../../inventory-planning/infrastructure/ebay-publication-recovery.repository";
import { EbayPublicationRecoveryService } from "../../../inventory-planning/application/ebay-publication-recovery.service";
import { observeEbayQuantityRequest } from "../../../inventory-planning/application/quantity-provider-request-evidence";
import type { QuantityPublicationScope } from "../../../inventory-planning/domain/quantity-publication-admission";
import { PostgresEbayListingSyncRepository } from "../../infrastructure/ebay-listing-sync.repository";
import {
  EbayListingSyncService,
  EbayExistingListingSyncExecution,
} from "../../ebay-listing-sync.service";
import {
  EbayMarketplaceListingConnector,
  type EbayListingLifecycleClient,
} from "../../listing-connectors/ebay-listing.connector";
import {
  executeAdmittedEbayQuantityRequest,
  type EbayQuantityRequestAdmission,
  type EbayQuantityHttpRequest,
} from "../../quantity-publication-request";
import { executeEbayQuantityHttp } from "../../adapters/ebay/ebay-quantity-http";
import {
  syncIdentity,
  syncProviderFixture,
} from "../fixtures/ebay-listing-sync.fixture";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import { resolveExistingEbayListingIdentity } from "../../ebay-existing-listing-identity";
import { hasOutstandingEbayListingWork } from "../../channel-stock-selection";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import { publicationCompletionFixture } from "../fixtures/ebay-publication-completion.fixture";
import { buildEbayRouteListingDraft } from "../../ebay-listing-draft";
import { prepareEbayListingPackages } from "../../adapters/ebay/ebay-listing-package";
vi.mock("../../../../db", () => ({ pool: {} }));
const configured =
  process.env.ECHELON_TEST_DATABASE_URL &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(configured ? describe : describe.skip).sequential(
  "durable eBay sync through real PostgreSQL admission and recovery",
  () => {
    let database: InventoryCutoverTestDatabase,
      sequence = 0,
      timestamp: Date,
      identity: EbayListingSyncIdentity;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        process.env.ECHELON_TEST_DATABASE_URL,
        true,
        cutoverCompositionBaseSql,
      );
      await installCutoverCompositionMigrations(database.pool);
      for (const file of [
        "0709_walmart_quantity_admission.sql",
        "0716_inventory_publication_reconciliation.sql",
        "0729_ebay_listing_sync_recovery.sql",
        "0731_ebay_listing_sync_verification_checkpoint.sql",
        "0732_ebay_listing_sync_identity_admission.sql",
        "0733_ebay_provider_response_finality.sql",
        "0734_ebay_operator_republication_recovery.sql", "900000020000018840001_shared_publication_recovery.sql",
        "0736_ebay_listing_mapping_repairs.sql",
        "0737_ebay_publication_completion.sql",
        "0741_ebay_durable_withdrawal.sql", "900000021000018880001_channel_lifecycle_recovery.sql", "900000023000018880003_listing_work_settlement.sql",
        "900000008000018120001_ebay_automatic_sync_recovery.sql",
        "900000011000018230001_ebay_publication_preflight_recovery.sql",
      ])
        await database.pool.query(
          readFileSync(resolve(process.cwd(), "migrations", file), "utf8"),
        );
      await database.pool.query(cutoverCompositionSeedSql);
      await database.pool.query(cutoverCompositionLegacyChannelSeedSql);
      await database.pool
        .query(`CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer,external_sku text,external_variant_id text,
      external_product_id text,last_synced_price integer,last_synced_qty integer,sync_status text,sync_error text,last_synced_at timestamptz,updated_at timestamptz,
      PRIMARY KEY(channel_id,product_variant_id));
      INSERT INTO channels.channel_listings VALUES(1,101,'P5','offer-101','listing-20',999,999,'error','original block',NULL,NULL)`);
      // Read-only canonical mapping/account dependencies; the job migrations above own writes.
      await database.pool.query(`CREATE SCHEMA IF NOT EXISTS marketplace; CREATE SCHEMA IF NOT EXISTS ebay;
      CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer,environment text,external_account_id text,external_account_identity_scheme text,external_account_verified_at timestamptz);
      CREATE TABLE marketplace.provider_accounts(id integer PRIMARY KEY,owner_kind text,channel_id integer,provider text,account_namespace text,external_account_id text);
      CREATE TABLE marketplace.listing_scopes(id integer PRIMARY KEY,owner_kind text,provider text,marketplace_id text,product_id integer);
      CREATE TABLE marketplace.channel_listing_scopes(scope_id integer,channel_id integer,product_id integer,marketplace_id text);
      CREATE TABLE marketplace.listing_publications(id integer PRIMARY KEY,scope_id integer,status text,external_listing_id text,provider_publication_key text);
      CREATE TABLE marketplace.listing_scope_provider_accounts(scope_id integer,provider_account_id integer);
      CREATE TABLE marketplace.listing_publication_members(id integer PRIMARY KEY,publication_id integer,product_variant_id integer,disposition text,
        sku_snapshot text,external_variant_id text,external_offer_id text,external_inventory_item_id text);
      CREATE TABLE marketplace.provider_identity_claims(provider_account_id integer,scope_id integer,publication_id integer,member_id integer,
        identity_role text,identity_namespace text,external_id text);
      CREATE TABLE marketplace.listing_replacement_operations(scope_id integer,status text);
      CREATE TABLE marketplace.listing_registrations(scope_id integer);
`);
    }, 60000);
    beforeEach(async () => {
      // Jobs are immutable and retained between cases. Keep newer test requests
      // newer than the prior case's retries when exercising the latest-job feed.
      timestamp = new Date(Date.parse("2026-10-09T12:00:00.000Z") + sequence * 24 * 60 * 60_000);
      identity = {
        ...structuredClone(syncIdentity),
        accountId: `verified-account-${++sequence}`,
      };
      await database.pool.query(
        "UPDATE channels.channel_listings SET last_synced_price=999,last_synced_qty=999,sync_status='error',sync_error='original block'",
      );
    });
    afterAll(async () => {
      await database?.close();
    });
    afterEach(async () => {
      // Publication cases use independent channels. Remove their mutable read
      // projections so older fixture assertions still concern channel 1 only;
      // immutable job/command/event evidence remains intact for the suite.
      if (identity.channelId >= 3000) await database.pool.query("DELETE FROM channels.channel_listings WHERE channel_id=$1", [identity.channelId]);
    });
    const clock = () => new Date(timestamp);
    const scope = (item: string): QuantityPublicationScope => ({
      destinationKind: "channel_connection",
      connectionId: 1,
      providerKey: "ebay",
      providerScopeType: "account",
      externalScopeId: identity.accountId,
      externalInventoryItemId: item,
      productId: null,
      productVariantId: null,
    });
    const advance = () => {
      timestamp = new Date(timestamp.getTime() + 20 * 60_000);
    };
    function fixture(options: { beforeGroup?: () => Promise<void>; photoUrls?: readonly string[];
      reject?: (request: EbayQuantityHttpRequest) => Response | undefined } = {}) {
      const provider = syncProviderFixture(),
        admission = new PostgresQuantityPublicationAdmission(
          database.pool,
          clock,
        ),
        recovery = new PostgresQuantityProviderResponseRecovery(
          database.pool,
          clock,
        );
      const port: EbayQuantityRequestAdmission = {
        item: (sku, work) =>
          admission.runListing(
            scope(sku),
            async () => {
              throw new Error("Legacy must not plan canonical quantities");
            },
            work,
          ),
        group: async (key, skus, work) => {
          // Inject the canonical planner's pre-send failure at the same boundary
          // where production admits the shared-gallery update. Provider HTTP is
          // mocked; durable jobs, receipts, ownership and recovery use real PG.
          await options.beforeGroup?.();
          return admission.runListingGroup(
            scope(`group:${key}`),
            skus.map(scope),
            async () => {
              throw new Error("Legacy must not plan canonical quantities");
            },
            work,
          );
        },
        reducing: (sku, work, members) =>
          admission.runQuantityReducingLifecycle(
            scope(sku),
            work,
            members?.map(scope),
          ),
      };
      let failGroup: "response" | "timeout" | null = null;
      const mutations: EbayQuantityHttpRequest[] = [];
      const raw = async <T>(request: EbayQuantityHttpRequest): Promise<T> =>
        executeEbayQuantityHttp<T>({
          url: `https://api.example.test${request.path}`,
          method: request.method,
          path: request.path,
          body: request.body,
          headers: {},
          now: clock,
          request: async () => {
            mutations.push(structuredClone(request));
            const refused = options.reject?.(request);
            if (refused) return refused;
            if (request.path.includes("inventory_item_group") && failGroup) {
              const failure = failGroup;
              failGroup = null;
              if (failure === "timeout")
                throw Object.assign(
                  new Error("Connection lost before response"),
                  { code: "ECONNRESET" },
                );
              return new Response(
                JSON.stringify({
                  errors: [
                    {
                      errorId: 25002,
                      category: "REQUEST",
                      message: "A user error has occurred.",
                    },
                  ],
                }),
                { status: 500 },
              );
            }
            const body = request.body as any;
            if (request.path.includes("inventory_item_group"))
              await provider.client.createOrReplaceInventoryItemGroup(
                "PACK",
                body,
              );
            else if (request.path.includes("/inventory_item/"))
              await provider.client.createOrReplaceInventoryItem("P5", body);
            else await provider.client.updateOffer("offer-101", body);
            return new Response(null, { status: 204 });
          },
        });
      const client: EbayListingLifecycleClient = {
        ...provider.client,
        updateOffer: async (id, body) =>
          executeAdmittedEbayQuantityRequest(
            { method: "PUT", path: `/sell/inventory/v1/offer/${id}`, body },
            port,
            raw,
          ),
        createOrReplaceInventoryItem: async (sku, body) =>
          executeAdmittedEbayQuantityRequest(
            {
              method: "PUT",
              path: `/sell/inventory/v1/inventory_item/${sku}`,
              body,
            },
            port,
            raw,
          ),
        createOrReplaceInventoryItemGroup: async (key, body) =>
          executeAdmittedEbayQuantityRequest(
            {
              method: "PUT",
              path: `/sell/inventory/v1/inventory_item_group/${key}`,
              body: { ...body, inventoryItemGroupKey: key },
            },
            port,
            raw,
          ),
      };
      const prepare = vi.fn(async () => {
        const prepared = await provider.prepare();
        if (options.photoUrls) {
          for (const item of prepared.draft.inventoryItems)
            item.payload.product.imageUrls = [...options.photoUrls];
          prepared.draft.itemGroup!.payload.imageUrls = [...options.photoUrls];
        }
        return { ...prepared, identity: structuredClone(identity), client };
      });
      const executor = new EbayExistingListingSyncExecution(
        prepare,
        recovery,
        new EbayMarketplaceListingConnector(),
      );
      const store = new PostgresEbayListingSyncRepository(database.pool),
        service = new EbayListingSyncService(
          store,
          executor,
          clock,
          randomUUID,
        );
      return {
        provider,
        admission,
        recovery,
        mutations,
        store,
        service,
        executor,
        client,
        prepare,
        fail: (value: "response" | "timeout") => {
          failGroup = value;
        },
      };
    }
    const targetBusy = () => Object.assign(new Error("Publication target is busy; retry the complete owning transaction."), {
      code: "INVENTORY_PUBLICATION_TARGET_BUSY", context: { retryable: true },
    });
    const galleryPhotos = ["https://example.com/current-front.jpg", "https://example.com/current-back.jpg"];

    async function prepareFromCatalog(f: ReturnType<typeof fixture>, weight: number | null = 120, calculated = false) {
      // Catalog read dependencies are fixtures; all queue/receipt/audit indexes
      // and constraints above come from the unchanged production migrations.
      await database.pool.query(`ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS weight_grams numeric(10,2);
        ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS length_mm numeric(10,2), ADD COLUMN IF NOT EXISTS width_mm numeric(10,2),
          ADD COLUMN IF NOT EXISTS height_mm numeric(10,2), ADD COLUMN IF NOT EXISTS shipping_package_type varchar(30);
        ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS description text;`);
      await database.pool.query("UPDATE catalog.product_variants SET length_mm=NULL,width_mm=NULL,height_mm=NULL,shipping_package_type=NULL WHERE id=101");
      await database.pool.query("UPDATE catalog.product_variants SET weight_grams=$1 WHERE id=101", [weight]);
      await database.pool.query("UPDATE catalog.products SET description=$1 WHERE id=20", ["<p>Current catalog description</p>"]);
      f.prepare.mockImplementation(async () => {
        const product = (await database.pool.query("SELECT name,sku,description FROM catalog.products WHERE id=20")).rows[0];
        const variants = (await database.pool.query("SELECT id,sku,name,weight_grams,length_mm,width_mm,height_mm,shipping_package_type FROM catalog.product_variants WHERE id=101")).rows;
        const draft = buildEbayRouteListingDraft({ productId: 20, product, variants,
          photoPlan: { byVariantId: new Map([[101, galleryPhotos]]), groupImageUrls: galleryPhotos },
          aspects: { Brand: ["Shellz"] }, isMultiVariant: false, variationAspectName: "Pack Size",
          variantPrices: new Map([[101, 1149]]), atpByVariantId: new Map([[101, 7]]),
          marketplaceId: "EBAY_US", ebayBrowseCategoryId: "183454",
          resolvedPoliciesByVariantId: new Map([[101, { fulfillmentPolicyId: "fulfillment", returnPolicyId: "return", paymentPolicyId: "payment" }]]),
          packageRequirementsByVariantId: new Map([[101, { weight: true, dimensions: calculated, packageType: calculated }]]),
          storeCategoryNames: [], merchantLocationKey: "HQ", existingGroupKey: identity.groupKey });
        return { ...await f.provider.prepare(), identity: structuredClone(identity), client: f.client,
          draft: await prepareEbayListingPackages(f.client, { ...draft, productId: 20, marketplaceId: "EBAY_US" }) };
      });
    }

    function processConcurrently(f: ReturnType<typeof fixture>, jobId: string) {
      // Separate worker instances cannot share the service's in-memory running
      // flag: the real PostgreSQL claim/lease must serialize these executions.
      const restartedWorker = new EbayListingSyncService(f.store, f.executor, clock, randomUUID);
      return Promise.all([f.service.processDue(1, jobId), restartedWorker.processDue(1, jobId)]);
    }

    function withRetiredUnpublishedMember(f: ReturnType<typeof fixture>) {
      const currentSource: EbayListingSyncIdentity = { ...identity, variants: [
        { ...identity.variants[0], contentSyncEnabled: true },
        { variantId: 7777, sku: "RETIRED-C200", externalSku: "RETIRED-C200", offerId: "retired-offer", listingId: null, contentSyncEnabled: false },
      ] };
      // The original command predates optional eligibility snapshots. Its exact
      // saved identifiers remain fenced against the fresh complete source read.
      identity = { ...currentSource, variants: currentSource.variants.map(({ contentSyncEnabled: _enabled, ...member }) => member) };
      const retired = { status: "UNPUBLISHED", groupIds: [] as string[] };
      const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "test-only", environment: "production" }) },
        { get: async request => {
          const url = new URL(request.path, "https://api.ebay.com");
          if (url.pathname === "/commerce/identity/v1/user/") return { status: 200, body: { userId: identity.accountId } };
          if (url.pathname.endsWith("/inventory_item_group/PACK")) return { status: 200, body: await f.client.getInventoryItemGroup("PACK") };
          if (url.pathname.includes("/inventory_item/")) {
            const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
            return { status: 200, body: { sku, groupIds: sku === "RETIRED-C200" ? retired.groupIds : ["PACK"] } };
          }
          if (url.pathname.endsWith("/offer")) {
            const sku = url.searchParams.get("sku")!;
            const offer = sku === "RETIRED-C200"
              ? { sku, marketplaceId: "EBAY_US", offerId: "retired-offer", status: retired.status }
              : { ...(await f.client.getOffers(sku, "EBAY_US")).offers[0], listing: { listingId: "listing-20", listingStatus: "ACTIVE" } };
            return { status: 200, body: { offers: [offer], total: 1 } };
          }
          throw new Error(`Unexpected provider read ${request.path}`);
        } }, { now: clock });
      const prepare = f.prepare.getMockImplementation()!;
      f.prepare.mockImplementation(async () => {
        const { identity: resolved, observation } = await resolveExistingEbayListingIdentity(currentSource, observer,
          currentSource.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku,
            isActive: member.contentSyncEnabled !== false, availableQuantity: member.contentSyncEnabled === false ? 0 : 7 })));
        return { ...await prepare(), sourceIdentity: structuredClone(currentSource), identity: resolved, providerObservation: observation };
      });
      return { currentSource, retired };
    }

    // Audit acceptance test: a completed replacement must settle a proven
    // pre-write failure without deleting its history or skipping unresolved sends.
    it("AUDIT: settles an earlier pre-write sync failure after its exact replacement completes", async () => {
      const f = fixture();
      const selected = { channelId: identity.channelId, connectionId: identity.connectionId, productId: identity.productId };
      expect(await hasOutstandingEbayListingWork(database.pool, selected)).toBe(false);
      f.prepare.mockRejectedValueOnce(new EbayListingSyncError("EBAY_POLICY_UNAVAILABLE", "Selected policy is unavailable."));
      const failed = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, failed.id);
      expect(await f.store.get(failed.id)).toMatchObject({ state: "needs_attention", code: "EBAY_POLICY_UNAVAILABLE" });
      expect(f.mutations).toHaveLength(0);
      advance();
      const replacement = await f.service.enqueue(identity, "operator");
      expect(replacement.id).not.toBe(failed.id);
      await f.service.processDue(1, replacement.id);
      expect(await f.store.get(replacement.id)).toMatchObject({ state: "completed" });
      expect((await f.store.get(failed.id)).state).toBe("needs_attention");
      const settlement = (await database.pool.query("SELECT * FROM channels.ebay_listing_sync_settlements WHERE failed_job_id=$1",[failed.id])).rows[0];
      expect(settlement).toMatchObject({replacement_job_id:replacement.id,actor:"operator",before_record:{state:"needs_attention"}});
      expect(await hasOutstandingEbayListingWork(database.pool, selected)).toBe(false);
      await expect(database.pool.query("UPDATE channels.ebay_listing_sync_settlements SET actor='rewritten' WHERE failed_job_id=$1",[failed.id])).rejects.toThrow(/immutable/);
    });

    it("backfills only evidence-proven historical replacements idempotently", async () => {
      const f=fixture();
      f.prepare.mockRejectedValueOnce(new EbayListingSyncError("EBAY_POLICY_UNAVAILABLE","Policy is unavailable."));
      const failed=await f.service.enqueue(identity,"operator");
      await f.service.processDue(1,failed.id);
      // Model a verified replacement completed by the previous deployment,
      // before settlement receipts existed. All execution and readback are real.
      const legacy=vi.spyOn(f.store as any,"settleUnsentFailures").mockResolvedValue(undefined);
      advance();
      const replacement=await f.service.enqueue(identity,"operator");
      try { await f.service.processDue(1,replacement.id); } finally { legacy.mockRestore(); }
      expect((await f.store.get(replacement.id)).state).toBe("completed");
      expect((await database.pool.query("SELECT 1 FROM channels.ebay_listing_sync_settlements WHERE failed_job_id=$1",[failed.id])).rowCount).toBe(0);
      const migration=readFileSync(resolve(process.cwd(),"migrations","900000024000018880004_settle_proven_historical_listing_work.sql"),"utf8");
      for(let replay=0;replay<2;replay++){
        const client=await database.pool.connect();
        try { await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT"); }
        catch(error){await client.query("ROLLBACK");throw error;} finally {client.release();}
      }
      expect((await database.pool.query("SELECT replacement_job_id,actor FROM channels.ebay_listing_sync_settlements WHERE failed_job_id=$1",[failed.id])).rows)
        .toEqual([{replacement_job_id:replacement.id,actor:"system:listing-lifecycle"}]);
    });

    it("preserves channel package data through concurrent durable sync and idempotent replay", async () => {
      const f = fixture();
      await prepareFromCatalog(f, 3175.25, true);
      const existing = { weight: { value: 7, unit: "POUND" as const }, dimensions: { length: 12, width: 8, height: 4, unit: "INCH" as const },
        packageType: "MAILING_BOX", shippingIrregular: true };
      f.provider.currentItem().packageWeightAndSize = structuredClone(existing);
      const key = randomUUID();
      const jobs = await Promise.all([f.service.enqueue(identity, "operator", key), f.service.enqueue(identity, "operator", key)]);
      expect(jobs[0].id).toBe(jobs[1].id);
      await processConcurrently(f, jobs[0].id);
      expect(await f.store.get(jobs[0].id)).toMatchObject({ state: "completed" });
      expect(f.provider.currentItem().packageWeightAndSize).toEqual({ ...existing, weight: { value: 3175.25, unit: "GRAM" } });
      const writes = f.mutations.length;
      await f.service.enqueue(identity, "operator", key);
      expect(await f.service.processDue(1, jobs[0].id)).toEqual({ processed: 0, failed: 0 });
      expect(f.mutations).toHaveLength(writes);
      expect((await database.pool.query("SELECT weight_grams,length_mm,shipping_package_type FROM catalog.product_variants WHERE id=101")).rows[0])
        .toEqual({ weight_grams: "3175.25", length_mm: null, shipping_package_type: null });
    });

    it("completes an older package draft without overwriting provider flags or duplicating work", async () => {
      const f = fixture();
      const existing = { weight: { value: 7, unit: "POUND" as const }, dimensions: { length: 12, width: 8, height: 4, unit: "INCH" as const },
        packageType: "MAILING_BOX", shippingIrregular: true };
      f.provider.currentItem().packageWeightAndSize = structuredClone(existing);
      f.prepare.mockImplementation(async () => {
        const prepared = await f.provider.prepare();
        prepared.draft.inventoryItems[0].payload.packageWeightAndSize = { weight: { value: 120.25, unit: "GRAM" }, shippingIrregular: false };
        return { ...prepared, identity: structuredClone(identity), client: f.client,
          draft: await prepareEbayListingPackages(f.client, prepared.draft) };
      });
      const saved = await f.service.enqueue(identity, "operator");
      await processConcurrently(f, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "completed" });
      expect(f.provider.currentItem().packageWeightAndSize).toEqual({ ...existing, weight: { value: 120.25, unit: "GRAM" } });
      const writes = f.mutations.length;
      expect(await f.service.processDue(1, saved.id)).toEqual({ processed: 0, failed: 0 });
      expect(f.mutations).toHaveLength(writes);
    });

    it("blocks incomplete calculated packages before any write and completes after an exact catalog correction", async () => {
      const f = fixture();
      await prepareFromCatalog(f, 120.25, true);
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "needs_attention", code: "CHANNEL_LISTING_VALIDATION_FAILED",
        issue: { title: "Add the variant's package dimensions", action: { href: "/products/20?tab=variants&variantId=101" } } });
      expect(f.mutations).toEqual([]);
      const evidence = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='needs_attention'", [saved.id])).rows;
      expect(evidence[0].evidence.diagnostic.context.validation.field).toBe("package_dimensions");
      await database.pool.query("UPDATE catalog.product_variants SET length_mm=152.40,width_mm=101.60,height_mm=25.40,shipping_package_type='parcel' WHERE id=101");
      const key = randomUUID();
      const corrected = await Promise.all([f.service.enqueue(identity, "operator", key), f.service.enqueue(identity, "operator", key)]);
      expect(corrected[0].id).toBe(corrected[1].id);
      await processConcurrently(f, corrected[0].id);
      expect(await f.store.get(corrected[0].id)).toMatchObject({ state: "completed" });
      expect(f.provider.currentItem().packageWeightAndSize).toEqual({ weight: { value: 120.25, unit: "GRAM" },
        dimensions: { length: 15.24, width: 10.16, height: 2.54, unit: "CENTIMETER" }, packageType: "PACKAGE_THICK_ENVELOPE" });
      expect((await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='needs_attention'", [saved.id])).rows).toEqual(evidence);
    });

    it("requires a real package type after dimensions are supplied and never infers it from the SKU", async () => {
      const f = fixture(); await prepareFromCatalog(f, 120, true);
      await database.pool.query("UPDATE catalog.product_variants SET length_mm=100,width_mm=80,height_mm=20 WHERE id=101");
      const saved = await f.service.enqueue(identity, "operator"); await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "needs_attention",
        issue: { title: "Add the variant's shipping package type" } });
      expect(f.mutations).toEqual([]);
    });

    it("retains a temporary package read failure and retries without erasing known channel fields", async () => {
      const f = fixture();
      await prepareFromCatalog(f, 120, true);
      const existing = { dimensions: { length: 12, width: 8, height: 4, unit: "INCH" as const }, packageType: "MAILING_BOX" };
      f.provider.currentItem().packageWeightAndSize = structuredClone(existing);
      vi.spyOn(f.client, "getInventoryItem").mockRejectedValueOnce(Object.assign(new Error("Package read timed out"), { code: "ETIMEDOUT" }));
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "recovering", code: "ETIMEDOUT" });
      expect(f.mutations).toEqual([]);
      expect(f.provider.currentItem().packageWeightAndSize).toEqual(existing);
      advance();
      await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "completed" });
      expect(f.provider.currentItem().packageWeightAndSize).toEqual({ ...existing, weight: { value: 120, unit: "GRAM" } });
      expect((await database.pool.query("SELECT evidence->'diagnostic'->>'code' AS code FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='recovering'", [saved.id])).rows)
        .toEqual([{ code: "ETIMEDOUT" }]);
    });

    it("re-prepares changed provider package facts on the same durable job before writing", async () => {
      const f = fixture();
      await prepareFromCatalog(f, 120, true);
      f.provider.currentItem().packageWeightAndSize = {
        dimensions: { length: 12, width: 8, height: 4, unit: "INCH" }, packageType: "MAILING_BOX",
      };
      const prepare = f.prepare.getMockImplementation()!;
      f.prepare.mockImplementationOnce(async () => {
        const prepared = await prepare();
        f.provider.currentItem().packageWeightAndSize!.dimensions!.length = 14;
        return prepared;
      });
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "recovering", code: "EBAY_SYNC_PACKAGE_CHANGED" });
      expect(f.mutations).toEqual([]);
      advance();
      await processConcurrently(f, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "completed" });
      expect(f.provider.currentItem().packageWeightAndSize?.dimensions?.length).toBe(14);
      const writes = f.mutations.length;
      await f.service.processDue(1, saved.id);
      expect(f.mutations).toHaveLength(writes);
    });

    it("repairs legacy item/group descriptions before replacing an offer and completes once under concurrent replay", async () => {
      const description = "<p>Current catalog description</p>";
      let f: ReturnType<typeof fixture>;
      f = fixture({ reject: request => {
        if (request.path.includes("/offer/") &&
          (f.provider.currentItem().product.description !== description || f.provider.currentGroup().description !== description ||
            (request.body as { listingDescription?: string }).listingDescription !== description)) {
          return new Response(JSON.stringify({ errors: [{ errorId: 25002, category: "REQUEST", message: "Description is required." }] }), { status: 400 });
        }
      } });
      await prepareFromCatalog(f);
      // Model the observed provider state without altering the catalog source.
      f.provider.currentItem().product.description = "";
      f.provider.currentGroup().description = "";
      const key = randomUUID();
      const admitted = await Promise.all([f.service.enqueue(identity, "operator", key), f.service.enqueue(identity, "operator", key)]);
      expect(admitted[0].id).toBe(admitted[1].id);
      await processConcurrently(f, admitted[0].id);
      expect(await f.store.get(admitted[0].id)).toMatchObject({ state: "completed" });
      expect(f.mutations.map(request => request.path)).toEqual([
        "/sell/inventory/v1/inventory_item/P5", "/sell/inventory/v1/inventory_item_group/PACK", "/sell/inventory/v1/offer/offer-101" ]);
      expect(f.provider.currentItem().product.description).toBe(description);
      expect(f.provider.currentGroup().description).toBe(description);
      expect(f.mutations[2].body).toMatchObject({ listingDescription: description });
      await f.service.enqueue(identity, "operator", key);
      expect(await f.service.processDue(1, admitted[0].id)).toEqual({ processed: 0, failed: 0 });
      expect(f.mutations).toHaveLength(3);
    });

    it.each([25002, 25016])("retains definitive HTTP 400/%i evidence, stops unchanged retries and safely resumes after correction", async errorId => {
      let reject = true;
      const f = fixture({ reject: request => reject && request.path.includes("/offer/")
        ? new Response(JSON.stringify({ errors: [{ errorId, category: "REQUEST", message: "Correct the saved listing content." }] }), { status: 400 }) : undefined });
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      const failed = await f.store.get(saved.id);
      expect(failed).toMatchObject({ state: "needs_attention", code: "EBAY_QUANTITY_REJECTED", attempts: 1 });
      expect(failed.message).toContain(String(errorId));
      const events = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='needs_attention'", [saved.id])).rows;
      expect(events[0].evidence.diagnostic.context.providerWrite).toEqual({ provider: "ebay", kind: "validation", httpStatus: 400, errorCodes: [String(errorId)] });
      const writes = f.mutations.length;
      advance();
      expect(await f.service.processDue(1, saved.id)).toEqual({ processed: 0, failed: 0 });
      expect(f.mutations).toHaveLength(writes);
      reject = false;
      const key = randomUUID();
      const resumed = await Promise.all([f.service.enqueue(identity, "operator", key), f.service.enqueue(identity, "operator", key)]);
      expect(resumed[0].id).toBe(resumed[1].id);
      await processConcurrently(f, resumed[0].id);
      expect(await f.store.get(resumed[0].id)).toMatchObject({ state: "completed" });
      // The failed receipt remains audit evidence, not a manufactured success.
      expect((await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='needs_attention'", [saved.id])).rows).toEqual(events);
    });

    it("persists the actual builder's missing-weight cause and resumes from corrected catalog input without duplicate writes", async () => {
      const f = fixture();
      await prepareFromCatalog(f, null);
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      const failed = await f.store.get(saved.id);
      expect(failed).toMatchObject({ state: "needs_attention", code: "CHANNEL_LISTING_VALIDATION_FAILED", attempts: 1,
        progress: { phase: "prepare_listing", phaseState: "started" },
        issue: { title: "Add the variant's package weight", action: { href: "/products/20?tab=variants&variantId=101" } } });
      expect(failed.issue?.details).toContainEqual({ label: "Variant ID", value: "101" });
      expect(f.mutations).toEqual([]);
      const events = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='needs_attention'", [saved.id])).rows;
      expect(events[0].evidence.diagnostic.context.validation).toEqual({ field: "package_weight", reason: "required", productId: 20, variantId: 101, variantSku: "P5" });
      expect((await f.service.list(identity.channelId)).find(job => job.id === saved.id)?.issue).toEqual(failed.issue);
      advance();
      expect(await f.service.processDue(1, saved.id)).toEqual({ processed: 0, failed: 0 });
      await database.pool.query("UPDATE catalog.product_variants SET weight_grams=250 WHERE id=101");
      const key = randomUUID();
      const resumed = await Promise.all([f.service.enqueue(identity, "operator", key), f.service.enqueue(identity, "operator", key)]);
      expect(resumed[0].id).toBe(resumed[1].id);
      await processConcurrently(f, resumed[0].id);
      expect(await f.store.get(resumed[0].id)).toMatchObject({ state: "completed" });
      expect(f.provider.currentItem().packageWeightAndSize?.weight).toEqual({ value: 250, unit: "GRAM" });
      expect(f.mutations).toHaveLength(3);
      expect((await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='needs_attention'", [saved.id])).rows).toEqual(events);
    });

    it("does not settle a partial provider write or a failure for another account", async () => {
      const f = fixture();
      const source = structuredClone(identity);
      const execution = {execute:async (_identity:unknown, stage:Parameters<EbayExistingListingSyncExecution["execute"]>[1]) => {
        await stage("update_offer", "3".repeat(64), async () => { throw new EbayListingSyncError("EBAY_REJECTED","Provider update failed after dispatch."); });
        throw new Error("unreachable");
      }};
      const partial = new EbayListingSyncService(f.store,execution,clock,randomUUID);
      const failed = await partial.enqueue(source,"operator");
      await partial.processDue(1,failed.id);
      expect((await f.store.get(failed.id)).state).toBe("needs_attention");
      advance();
      const completed = await f.service.enqueue(source,"operator");
      await f.service.processDue(1,completed.id);
      expect((await f.store.get(completed.id)).state).toBe("completed");
      expect((await database.pool.query("SELECT 1 FROM channels.ebay_listing_sync_settlements WHERE failed_job_id=$1",[failed.id])).rowCount).toBe(0);
      await expect(database.pool.query(`INSERT INTO channels.ebay_listing_sync_settlements(failed_job_id,replacement_job_id,before_record,actor,resolved_at)
        SELECT id,$2,to_jsonb(j),'operator',$3 FROM channels.ebay_listing_sync_jobs j WHERE id=$1`,[failed.id,completed.id,clock()])).rejects.toThrow(/unsent failure/);
      const otherSource = {...identity,accountId:identity.accountId+"-other"};
      f.prepare.mockRejectedValueOnce(new EbayListingSyncError("EBAY_POLICY_UNAVAILABLE","Policy is unavailable."));
      const other = await f.service.enqueue(otherSource,"operator");
      await f.service.processDue(1,other.id);
      await expect(database.pool.query(`INSERT INTO channels.ebay_listing_sync_settlements(failed_job_id,replacement_job_id,before_record,actor,resolved_at)
        SELECT id,$2,to_jsonb(j),'operator',$3 FROM channels.ebay_listing_sync_jobs j WHERE id=$1`,[other.id,completed.id,clock()])).rejects.toThrow(/exact verified replacement/);
      expect((await f.store.get(other.id)).state).toBe("needs_attention");
    });

    it("shows only the current claim's phase across a crash, joined command and requeue", async () => {
      await database.pool.query("INSERT INTO catalog.products(id,sku) VALUES(900,'PROGRESS')");
      await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(900,900,'PROGRESS-P5')");
      const source = { ...identity, productId: 900, variants: identity.variants.map(member => ({ ...member, variantId: 900, sku: 'PROGRESS-P5' })) };
      const store = new PostgresEbayListingSyncRepository(database.pool);
      const command = randomUUID();
      const saved = await store.enqueue(source, command, "operator", clock());
      expect((await store.get(saved.id)).progress).toMatchObject({ phase: null, phaseState: null,
        requestedAt: timestamp.toISOString() });
      const claim = (await store.claim(clock(), randomUUID(), saved.id))!;
      advance();
      const hash = "a".repeat(64);
      await store.stage(claim.job, "item:P5", hash, "started", clock());
      const running = await store.get(saved.id);
      expect(running.progress).toMatchObject({ phase: "update_item", phaseState: "started", lastActivityAt: timestamp.toISOString() });
      expect(running.updatedAt).not.toBe(running.progress!.lastActivityAt);
      // Simulate a process dying after its stage was saved. Its session lock is
      // released, but the durable running row remains claimable by another owner.
      await claim.release();
      const reclaimed = (await store.claim(clock(), randomUUID(), saved.id))!;
      expect((await store.get(saved.id)).progress).toMatchObject({ phase: null, phaseState: null });
      await store.stage(reclaimed.job, "prepare_inventory", hash, "started", clock());
      // A concurrent command increments requested revision while this pass owns
      // the earlier revision. Its current phase stays visible until it requeues.
      const joined = await store.enqueue(source, randomUUID(), "operator", clock());
      expect(joined.revision).toBe("2");
      expect((await store.get(saved.id)).progress).toMatchObject({ phase: "prepare_inventory", phaseState: "started" });
      await store.finish(reclaimed.job, { state: "recovering", result: null, code: "PUBLICATION_SCOPE_BUSY",
        message: "Waiting", nextAttemptAt: clock() }, clock());
      await reclaimed.release();
      const queued = await store.get(saved.id);
      expect(queued).toMatchObject({ state: "queued", progress: { phase: null, phaseState: null } });
      expect((await store.getByCommand(command, identity.channelId))?.progress).toEqual(queued.progress);
      expect((await store.list(identity.channelId)).find(job => job.id === saved.id)?.progress).toEqual(queued.progress);
      const final = (await store.claim(clock(), randomUUID(), saved.id))!;
      await store.finish(final.job, { state: "needs_attention", result: null, code: "EBAY_SYNC_MAPPING_INVALID",
        message: "Test complete", nextAttemptAt: clock() }, clock());
      await final.release();
    });

    it("counts earlier eligible work across channels, excludes future retries and records actual queue activity", async () => {
      await database.pool.query("INSERT INTO catalog.products(id,sku) VALUES(901,'QUEUE-A'),(902,'QUEUE-B'),(903,'QUEUE-C')");
      await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(901,901,'QUEUE-A'),(902,902,'QUEUE-B'),(903,903,'QUEUE-C')");
      await database.pool.query("INSERT INTO channels.channels(id,name,provider) VALUES(902,'Second eBay account','ebay')");
      await database.pool.query("INSERT INTO channels.channel_connections(id,channel_id) VALUES(902,902)");
      // Match the database's due-candidate clock while keeping every timestamp
      // in this test an explicit input. Future retries must stay out of the count.
      timestamp = new Date((await database.pool.query("SELECT CURRENT_TIMESTAMP AS now")).rows[0].now.getTime() - 2 * 60 * 60_000);
      const queuedIdentity = (productId: number, sku: string) => ({ ...identity, productId,
        variants: identity.variants.map(member => ({ ...member, variantId: productId, sku })) });
      const store = new PostgresEbayListingSyncRepository(database.pool);
      const future = await store.enqueue(queuedIdentity(901, "QUEUE-A"), randomUUID(), "operator", clock());
      const held = (await store.claim(clock(), randomUUID(), future.id))!;
      await store.finish(held.job, { state: "recovering", result: null, code: "PUBLICATION_PROVIDER_COOLDOWN",
        message: "Wait", nextAttemptAt: new Date("2099-01-01T00:00:00Z") }, clock());
      await held.release();
      advance();
      const first = await store.enqueue({ ...queuedIdentity(902, "QUEUE-B"), channelId: 902, connectionId: 902 }, randomUUID(), "operator", clock());
      const running = (await store.claim(clock(), randomUUID(), first.id))!;
      advance();
      await store.stage(running.job, "group:PACK", "b".repeat(64), "started", clock());
      const lastActivityAt = timestamp.toISOString();
      advance();
      const queued = await store.enqueue(queuedIdentity(903, "QUEUE-C"), randomUUID(), "operator", clock());
      expect((await store.get(queued.id)).progress).toMatchObject({ queuedAhead: 1, lastWorkerActivityAt: lastActivityAt });
      await store.finish(running.job, { state: "needs_attention", result: null, code: "EBAY_SYNC_MAPPING_INVALID", message: "Done", nextAttemptAt: clock() }, clock());
      await running.release();
      expect((await store.get(queued.id)).progress?.queuedAhead).toBe(0);
      for (const job of [future, queued]) {
        const claim = (await store.claim(new Date("2099-01-02T00:00:00Z"), randomUUID(), job.id))!;
        await store.finish(claim.job, { state: "needs_attention", result: null, code: "EBAY_SYNC_MAPPING_INVALID", message: "Done", nextAttemptAt: clock() }, clock());
        await claim.release();
      }
    });

    it("retains the exact failing preparation phase and safe scope diagnostics before any provider write", async () => {
      const f = fixture();
      const prepare = f.prepare.getMockImplementation()!;
      f.prepare.mockImplementationOnce(async () => ({ ...await prepare(), assertInventoryReady: async () => {
        throw Object.assign(new Error("private SQL diagnostic"), { code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
          context: { productId: 4, productVariantId: 208, publicationTargetId: 3, password: "private" } });
      } }));
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      expect(f.mutations).toEqual([]);
      const job = await f.store.get(saved.id);
      expect(job).toMatchObject({ state: "needs_attention", code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
        progress: { phase: "prepare_inventory", phaseState: "started" } });
      expect(job.message).not.toContain("private");
      const event = (await database.pool.query(`SELECT evidence FROM channels.ebay_listing_sync_events
        WHERE job_id=$1 AND event='needs_attention' ORDER BY id DESC LIMIT 1`, [saved.id])).rows[0];
      expect(event.evidence.diagnostic).toEqual({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
        context: { productId: 4, productVariantId: 208, publicationTargetId: 3 } });
      expect((await f.service.list(identity.channelId)).find(item => item.id === saved.id)?.issue)
        .toMatchObject({ action: { kind: "retry_sync" }, retryable: true });
    });


    async function separatePublicationChannel() {
      identity = { ...identity, channelId: 3000 + sequence, connectionId: 3000 + sequence };
      await database.pool.query("INSERT INTO channels.channels(id,name,provider) VALUES($1,'Publication read recovery','ebay')", [identity.channelId]);
      await database.pool.query("INSERT INTO channels.channel_connections(id,channel_id) VALUES($1,$1)", [identity.connectionId]);
    }
    async function seedPublicationMapping(source: EbayListingSyncIdentity) {
      await database.pool.query("INSERT INTO ebay.ebay_oauth_tokens VALUES($1,'production',$2,'provider_user_id',$3)", [source.channelId, source.accountId, clock()]);
      await database.pool.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status) VALUES($1,101,NULL,$2,NULL,'pending')", [source.channelId, source.variants[0].offerId]);
    }
    it("creates a missing offer after real 404/25713 observation and persists one completion under concurrent replay", async () => {
      await separatePublicationChannel();
      const f = await publicationCompletionFixture(undefined, { source: identity, missing: true });
      await seedPublicationMapping(f.source);
      const store = new PostgresEbayListingSyncRepository(database.pool);
      const service = new EbayListingSyncService(store, f.executor, clock, randomUUID);
      const key = randomUUID();
      const admitted = await Promise.all([service.enqueue(f.source, "operator", key, "publish"), service.enqueue(f.source, "operator", key, "publish")]);
      expect(admitted[0].id).toBe(admitted[1].id);
      await service.processDue(1, admitted[0].id);
      expect(await store.get(admitted[0].id)).toMatchObject({ state: "completed", publicationWriteCompleted: true,
        publicationAccepted: { listingId: "listing-20", offerIds: { 101: "offer-101" } } });
      await service.enqueue(f.source, "operator", key, "publish");
      await service.processDue(1, admitted[0].id);
      expect(f.client.createOffer).toHaveBeenCalledTimes(1); expect(f.client.publishOffer).toHaveBeenCalledTimes(1);
    });

    it.each(["preparation", "readback"] as const)("retains translated %s read evidence in the real publication queue and recovers without duplicate creation", async phase => {
      await separatePublicationChannel();
      const f = await publicationCompletionFixture(undefined, { source: identity });
      await seedPublicationMapping(f.source);
      const originalPrepare = f.prepare.getMockImplementation()!;
      const read = { provider: "ebay", resource: "offers", method: "GET" as const, kind: "unavailable" as const,
        httpStatus: 503, requestId: "provider-read-request" };
      if (phase === "preparation") f.setReadResponse({ status: 503, body: { errors: [{ errorId: 999 }] }, requestId: read.requestId });
      else {
        const prepared = await originalPrepare();
        f.prepare.mockResolvedValue({ ...prepared, inspect: async () => ({ ...prepared.inspection, publication: null,
          skus: prepared.inspection.skus.map(row => ({ ...row, issue: { code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", message: "Provider unavailable", providerRead: read } })) }) });
      }
      const store = new PostgresEbayListingSyncRepository(database.pool);
      const service = new EbayListingSyncService(store, f.executor, clock, randomUUID);
      const saved = await service.enqueue(f.source, "operator", randomUUID(), "publish");
      await service.processDue(1, saved.id);
      expect(await store.get(saved.id)).toMatchObject({ state: "recovering", providerRead: read });
      const events = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='recovering'", [saved.id])).rows;
      expect(events[0].evidence.diagnostic.context.providerRead).toEqual(read);
      expect(f.client.publishOffer).toHaveBeenCalledTimes(phase === "readback" ? 1 : 0);
      f.setReadResponse(null); f.prepare.mockImplementation(originalPrepare);
      advance(); await service.processDue(1, saved.id);
      expect(await store.get(saved.id)).toMatchObject({ state: "completed" });
      expect(f.client.createOffer).not.toHaveBeenCalled(); expect(f.client.publishOffer).toHaveBeenCalledTimes(1);
    });

    it("persists an uncoded pool timeout as a classified retry with safe evidence", async () => {
      const f = fixture();
      f.prepare.mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"));
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "recovering", code: "DATABASE_POOL_ACQUIRE_TIMEOUT" });
      const events = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='recovering'", [saved.id])).rows;
      expect(events[0].evidence.diagnostic.context.failure).toMatchObject({ category: "pool_acquisition_timeout", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(f.mutations).toEqual([]);
      advance(); await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "completed" });
    });

    it("retains an unexpected preparation failure's database cause and code location through status reads", async () => {
      const f = fixture();
      f.prepare.mockImplementationOnce(async () => {
        try { await database.pool.query("SELECT missing_listing_column FROM catalog.products WHERE id=20"); }
        catch (cause) { throw new Error("Private preparation query failed", { cause }); }
        throw new Error("Expected PostgreSQL to reject the missing fixture column");
      });
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      const failed = await f.store.get(saved.id);
      expect(failed).toMatchObject({ state: "recovering", code: "EBAY_LISTING_SYNC_FAILED" });
      const event = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='recovering'", [saved.id])).rows[0];
      const failure = event.evidence.diagnostic.context.failure;
      expect(failure).toMatchObject({ category: "database", codes: ["42703"], fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(failure.locations.some((location: string) => location.startsWith("server/modules/channels/"))).toBe(true);
      const status = (await f.service.list(identity.channelId)).find(job => job.id === saved.id)!;
      expect(status.issue?.details).toContainEqual({ label: "Failure reference", value: failure.fingerprint });
      expect(JSON.stringify(status)).not.toMatch(/missing_listing_column|Private preparation|SELECT /);
      expect(f.mutations).toEqual([]);
      advance(); await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "completed" });
    });

    const malformedRead = () => Object.assign(new Error("private response body"), {
      code: "EBAY_REGISTRATION_PROVIDER_RESPONSE_INVALID", context: { providerRead: {
        provider: "ebay", resource: "offers", method: "GET", kind: "invalid_response", httpStatus: 200,
        requestId: "observed-read-123", issues: [{ path: "offers.0.offerId", code: "invalid_type" }],
      }, body: "private response body" },
    });
    function listingRecovery(f: Pick<ReturnType<typeof fixture>, "service" | "store">, pool: Pick<Pool, "connect"> = database.pool) {
      const inventory = new EbayPublicationRecoveryService(new PostgresEbayPublicationRecoveryRepository(pool), clock);
      return new EbayListingRecoveryService(f.service, inventory, new PostgresEbayListingRecoveryContinuation(pool, f.store, clock));
    }
    async function legacyRequest(f: ReturnType<typeof fixture>) {
      await expect(f.admission.runQuantityReducingLifecycle(scope("P5"), async () => {
        throw new Error("legacy request without receipts");
      })).rejects.toThrow("legacy request without receipts");
      return (await database.pool.query("SELECT id::text,to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE scope->>'externalScopeId'=$1 ORDER BY id DESC LIMIT 1",
        [identity.accountId])).rows[0] as { id: string; record: Record<string, unknown> };
    }
    async function legacyRecoveryFixture() {
      const f = fixture(); const legacy = await legacyRequest(f);
      const automatic = new EbayAutomaticPublicationRecoveryService(new PostgresEbayAutomaticPublicationRecoveryRepository(database.pool), clock);
      const executor = new EbayExistingListingSyncExecution(f.prepare, f.recovery, new EbayMarketplaceListingConnector(), automatic);
      const worker = new EbayListingSyncService(f.store, executor, clock, randomUUID);
      const saved = await worker.enqueue(identity, "operator");
      await worker.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "needs_attention", code: "PUBLICATION_RECOVERY_REVIEW_REQUIRED" });
      expect(f.mutations).toEqual([]);
      const recovery = listingRecovery(f); const preview = await recovery.preview(saved.id, 1);
      expect(preview).toMatchObject({ canResume: true, attempts: [{ attemptId: legacy.id, requests: [] }] });
      return { ...f, worker, legacy, saved, recovery, confirmation: {
        previewHash: preview.previewHash, idempotencyKey: randomUUID(), acknowledgeUnknownOutcome: true as const,
      } };
    }

    it("retains safe read diagnostics in PostgreSQL and the status API, then completes after a successful read", async () => {
      const f = fixture(); const error = malformedRead(); f.prepare.mockRejectedValueOnce(error);
      const saved = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, saved.id);
      expect(f.mutations).toEqual([]);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "recovering", providerRead: error.context.providerRead,
        progress: { phase: "prepare_listing", phaseState: "started" } });
      const events = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='recovering'", [saved.id])).rows;
      expect(events[0].evidence.diagnostic.context).toEqual({ providerRead: error.context.providerRead });
      expect(JSON.stringify(events)).not.toContain("private");
      expect((await f.service.list(1)).find(job => job.id === saved.id)).toMatchObject({ providerRead: error.context.providerRead,
        issue: { action: { kind: "check_status" }, details: expect.arrayContaining([{ label: "Rejected field", value: "offers.0.offerId: invalid_type" }]) } });
      advance(); await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "completed", providerRead: undefined });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='recovering'", [saved.id])).rows[0].n).toBe(1);
    });
    it("stops persistent invalid reads at the bounded retry limit and supports a deliberate retry", async () => {
      const f = fixture(); const prepare = f.prepare.getMockImplementation()!;
      f.prepare.mockRejectedValue(malformedRead()); const saved = await f.service.enqueue(identity, "operator");
      for (let i = 1; i <= 5; i++) { await f.service.processDue(1, saved.id); advance(); }
      expect(await f.store.get(saved.id)).toMatchObject({ state: "needs_attention", attempts: 5 });
      expect(f.prepare).toHaveBeenCalledTimes(5); expect(f.mutations).toEqual([]);
      expect((await f.service.list(1)).find(job => job.id === saved.id)?.issue).toMatchObject({ action: { kind: "retry_sync" }, diagnosticAction: { kind: "check_recovery" } });
      f.prepare.mockImplementation(prepare);
      const next = await f.service.enqueue(identity, "operator", randomUUID());
      await f.service.processDue(1, next.id);
      expect((await f.store.get(next.id)).state).toBe("completed");
      expect((await f.store.get(saved.id)).state).toBe("needs_attention");
    });
    it("never converts a successful GET retry into permission to discard an unresolved legacy write", async () => {
      const f = fixture(); const legacy = await legacyRequest(f);
      f.prepare.mockRejectedValueOnce(malformedRead());
      const saved = await f.service.enqueue(identity, "operator"); await f.service.processDue(1, saved.id);
      advance(); await f.service.processDue(1, saved.id);
      expect(await f.store.get(saved.id)).toMatchObject({ state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" });
      expect(f.mutations).toEqual([]);
      expect((await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [legacy.id])).rows[0].record).toEqual(legacy.record);
    });
    it("queues recovery and its audit atomically, replays after a lost acknowledgement and completes using current content", async () => {
      const f = await legacyRecoveryFixture();
      let lost = false;
      const lostAcknowledgement = { connect: async () => {
        const client = await database.pool.connect();
        return new Proxy(client, { get(target, property) {
          if (property === "query") return async (sql: string, args?: unknown[]) => {
            const result = await client.query(sql, args);
            if (sql === "COMMIT" && !lost) { lost = true; throw new Error("lost commit acknowledgement"); }
            return result;
          };
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        } });
      } };
      await expect(listingRecovery(f, lostAcknowledgement).resume(f.saved.id, 1, "operator", f.confirmation)).rejects.toThrow("lost commit acknowledgement");
      const result = await f.recovery.resume(f.saved.id, 1, "operator", f.confirmation);
      expect(result).toMatchObject({ replayed: true, providerWriteAttempted: false, attemptIds: [f.legacy.id], job: { state: "queued" } });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1", [f.confirmation.idempotencyKey])).rows[0].n).toBe(1);
      expect((await database.pool.query("SELECT count(*)::int AS n FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [f.confirmation.idempotencyKey])).rows[0].n).toBe(1);
      expect((await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [f.legacy.id])).rows[0].record)
        .toEqual({ ...f.legacy.record, state: "superseded_unknown" });
      expect(f.mutations).toEqual([]);
      f.provider.setQuantity(4); await f.worker.processDue(1, result.job.id);
      expect((await f.store.get(result.job.id)).state).toBe("completed");
      expect(f.provider.currentItem().availability.shipToLocationAvailability.quantity).toBe(4);
    });

    it("revalidates a changed saved mapping after recovery before sending any provider write", async () => {
      const f = await legacyRecoveryFixture();
      const result = await f.recovery.resume(f.saved.id, 1, "operator", f.confirmation);
      await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='replaced-offer' WHERE channel_id=1 AND product_variant_id=101");
      const prepare = f.prepare.getMockImplementation()!;
      f.prepare.mockImplementation(async () => {
        const current = (await database.pool.query("SELECT external_variant_id FROM channels.channel_listings WHERE channel_id=1 AND product_variant_id=101")).rows[0];
        return { ...await prepare(), sourceIdentity: { ...identity, variants: identity.variants.map(member => ({ ...member, offerId: current.external_variant_id })) } };
      });
      try {
        await f.worker.processDue(1, result.job.id);
        expect(await f.store.get(result.job.id)).toMatchObject({ state: "needs_attention", code: "EBAY_SYNC_IDENTITY_CHANGED" });
        expect(f.mutations).toEqual([]);
        expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE id=$1", [f.legacy.id])).rows[0].state).toBe("superseded_unknown");
      } finally { await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='offer-101' WHERE channel_id=1 AND product_variant_id=101"); }
    });

    it("rolls back the recovery decision, catch-up and attempt transition if the actual queue insert fails", async () => {
      const f = await legacyRecoveryFixture();
      const before = (await database.pool.query("SELECT to_jsonb(c) AS record FROM inventory.quantity_publication_catchup c WHERE scope->>'externalScopeId'=$1", [identity.accountId])).rows;
      await database.pool.query(`CREATE FUNCTION channels.test_recovery_queue_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.actor='failing-recovery' THEN RAISE EXCEPTION 'queue insert failed'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_recovery_queue_failure BEFORE INSERT ON channels.ebay_listing_sync_commands FOR EACH ROW EXECUTE FUNCTION channels.test_recovery_queue_failure()`);
      try {
        await expect(f.recovery.resume(f.saved.id, 1, "failing-recovery", f.confirmation)).rejects.toThrow("queue insert failed");
      } finally { await database.pool.query("DROP TRIGGER test_recovery_queue_failure ON channels.ebay_listing_sync_commands; DROP FUNCTION channels.test_recovery_queue_failure()"); }
      expect((await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [f.legacy.id])).rows[0].record).toEqual(f.legacy.record);
      expect((await database.pool.query("SELECT to_jsonb(c) AS record FROM inventory.quantity_publication_catchup c WHERE scope->>'externalScopeId'=$1", [identity.accountId])).rows).toEqual(before);
      expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1", [f.confirmation.idempotencyKey])).rows[0].n).toBe(0);
      expect((await f.store.get(f.saved.id)).state).toBe("needs_attention");
      expect(await f.recovery.resume(f.saved.id, 1, "failing-recovery", f.confirmation)).toMatchObject({ replayed: false, job: { state: "queued" } });
    });
    it("serializes concurrent recovery confirmations, retaining one immutable decision and one saved continuation", async () => {
      const f = await legacyRecoveryFixture();
      const outcomes = await Promise.allSettled([1, 2].map(() => f.recovery.resume(f.saved.id, 1, "operator", f.confirmation)));
      expect(outcomes.some(result => result.status === "fulfilled")).toBe(true);
      for (const result of outcomes) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "EBAY_RECOVERY_BUSY" });
      const replay = await f.recovery.resume(f.saved.id, 1, "operator", f.confirmation);
      expect(replay.replayed).toBe(true);
      expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_operator_resume_attempts WHERE attempt_id=$1", [f.legacy.id])).rows[0].n).toBe(1);
      expect((await database.pool.query("SELECT count(*)::int AS n FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [f.confirmation.idempotencyKey])).rows[0].n).toBe(1);
      await expect(f.recovery.resume(f.saved.id, 1, "different-operator", f.confirmation)).rejects.toMatchObject({ code: "EBAY_RECOVERY_REPLAY_CONFLICT" });
    });


    it.each(["publish", "withdraw"] as const)("AUDIT: bounds invalid provider reads after a %s send marker without dropping that marker", async operation => {
      identity = { ...identity, channelId: 2000 + sequence, connectionId: 2000 + sequence };
      await database.pool.query("INSERT INTO channels.channels(id,name,provider) VALUES($1,'Audit read budget','ebay')", [identity.channelId]);
      await database.pool.query("INSERT INTO channels.channel_connections(id,channel_id) VALUES($1,$1)", [identity.connectionId]);
      const f = fixture();
      const source = operation === "publish" ? { ...identity, variants: identity.variants.map(member => ({ ...member, mappingExists: true, listingId: null })) } : identity;
      const saved = await f.service.enqueue(source, "operator", randomUUID(), operation);
      const claim = (await f.store.claim(clock(), randomUUID(), saved.id))!;
      try {
        if (operation === "publish") await f.store.bindPublicationTarget(claim.job, source, clock());
        else await f.store.bindProviderIdentity(claim.job, source, clock());
        await f.store.stage(claim.job, operation, "7".repeat(64), "started", clock());
        await f.store.finish(claim.job, { state: "awaiting_evidence", code: operation === "publish" ? "EBAY_PUBLICATION_RESPONSE_UNCERTAIN" : "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN",
          message: "Outcome unknown.", result: null, nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
      const executor = { execute: vi.fn(async () => { throw malformedRead(); }) };
      const restarted = new EbayListingSyncService(f.store, executor, clock, randomUUID);
      for (let attempt = 0; attempt < 8; attempt++) {
        advance();
        await restarted.processDue(1, saved.id);
      }
      const retained = await f.store.get(saved.id);
      expect(operation === "publish" ? retained.publicationWriteStarted : retained.withdrawalWriteStarted).toBe(true);
      expect(retained.providerRead).toMatchObject({ kind: "invalid_response", requestId: "observed-read-123" });
      expect(f.mutations).toEqual([]);
      // Pausing malformed reads must not release the unresolved-write fence.
      expect(executor.execute).toHaveBeenCalledTimes(5);
      expect(retained).toMatchObject({readFailureCount:5,readRetryPaused:true});
      const newOwner = new EbayListingSyncService(new PostgresEbayListingSyncRepository(database.pool),executor,clock,randomUUID);
      advance(); await newOwner.processDue(1,saved.id);
      expect(executor.execute).toHaveBeenCalledTimes(5);
      // An explicit command resumes this exact operation without removing any
      // send receipt; retry admission still prevents a conflicting workflow.
      const retryKey=randomUUID();
      const resumed=await newOwner.enqueue(source,"operator",retryKey,operation);
      expect(resumed).toMatchObject({id:saved.id,readFailureCount:0,readRetryPaused:false});
      await newOwner.processDue(1,saved.id);
      expect(executor.execute).toHaveBeenCalledTimes(6);
      expect(await f.store.get(saved.id)).toMatchObject({readFailureCount:1});
      expect(f.mutations).toEqual([]);
      const alias=await newOwner.enqueue(source,"operator",retryKey,operation);
      expect(alias.id).toBe(saved.id);
      expect(operation==="publish" ? alias.publicationWriteStarted : alias.withdrawalWriteStarted).toBe(true);
    });

    it.each(["publish", "withdraw"] as const)("commits an empty legacy review and interrupted %s authorization together", async operation => {
      // Each unfinished workflow owns its own channel, just as production permits only one active job per product and channel.
      identity = { ...identity, channelId: 1000 + sequence, connectionId: 1000 + sequence };
      await database.pool.query("INSERT INTO channels.channels(id,name,provider) VALUES($1,\'Recovery fixture\',\'ebay\')", [identity.channelId]);
      await database.pool.query("INSERT INTO channels.channel_connections(id,channel_id) VALUES($1,$1)", [identity.connectionId]);
      const f = fixture();
      const source = operation === "publish" ? { ...identity, variants: identity.variants.map(member => ({ ...member, mappingExists: true, listingId: null })) } : identity;
      const saved = await f.service.enqueue(source, "operator", randomUUID(), operation);
      const claim = (await f.store.claim(clock(), randomUUID(), saved.id))!;
      expect(claim).not.toBeNull();
      try {
        if (operation === "publish") await f.store.bindPublicationTarget(claim.job, source, clock());
        else await f.store.bindProviderIdentity(claim.job, source, clock());
        await f.store.stage(claim.job, operation === "publish" ? "publish" : "withdraw", "7".repeat(64), "started", clock());
        await f.store.finish(claim.job, { state: "awaiting_evidence", code: operation === "publish" ? "EBAY_PUBLICATION_RESPONSE_UNCERTAIN" : "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN",
          message: "Outcome unknown.", result: null, nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
      const recovery = listingRecovery(f);
      const preview = await recovery.preview(saved.id, identity.channelId);
      expect(preview).toMatchObject({ attempts: [], canResume: true, blockReason: null });
      const command = { previewHash: preview.previewHash, publicationRetryHash: preview.publicationRetry!.reviewHash,
        idempotencyKey: randomUUID(), acknowledgeUnknownOutcome: true as const };
      // A bad workflow review must roll back even the already-written empty audit.
      await expect(recovery.resume(saved.id, identity.channelId, "operator", { ...command, publicationRetryHash: "8".repeat(64) }))
        .rejects.toMatchObject({ code: "EBAY_PUBLICATION_RETRY_REVIEW_CHANGED" });
      expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1", [command.idempotencyKey])).rows[0].n).toBe(0);
      const result = await recovery.resume(saved.id, identity.channelId, "operator", command);
      expect(result).toMatchObject({ attemptIds: [], replayed: false, providerWriteAttempted: false, publicationRetryAuthorized: true,
        job: { id: saved.id, state: "queued", operation } });
      expect(await recovery.resume(saved.id, identity.channelId, "operator", command)).toMatchObject({ replayed: true, attemptIds: [], job: { id: saved.id, operation } });
      const receipt = (await database.pool.query("SELECT result_payload,owner_transaction_id::text FROM inventory.quantity_publication_operator_resumes WHERE idempotency_key=$1", [command.idempotencyKey])).rows[0];
      const authorized = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event=$2",
        [saved.id, operation === "publish" ? "publication_retry_authorized" : "withdrawal_retry_authorized"])).rows;
      expect(authorized).toHaveLength(1);
      expect(authorized[0].evidence.ownerTransactionId).toBe(receipt.owner_transaction_id);
      expect(receipt.result_payload).toEqual({ attemptIds: [], replayed: false, providerWriteAttempted: false });
      expect(f.mutations).toEqual([]);
    });

    it("retains partial photo sync through repeated target contention, restart and competing workers, then verifies the same listing", async () => {
      let busy = true;
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const f = fixture({ photoUrls: galleryPhotos, beforeGroup: async () => {
        if (busy) throw targetBusy();
        entered(); await gate;
      } });
      const oldGallery = structuredClone(f.provider.currentGroup().imageUrls);
      const commandKey = randomUUID();
      const job = await f.service.enqueue(identity, "operator", commandKey);
      // Contention may last longer than the normal failure budget. Each retry
      // must release ownership and retain the saved command for a later pass.
      for (let attempt = 0; attempt < 6; attempt++) {
        expect(await f.service.processDue(1, job.id)).toEqual({ processed: 0, failed: 1 });
        expect(await f.store.get(job.id)).toMatchObject({ state: "recovering", attempts: 0,
          code: "INVENTORY_PUBLICATION_TARGET_BUSY", verificationIntentHash: null });
        expect(f.provider.currentItem().product.imageUrls).toEqual(galleryPhotos);
        expect(f.provider.currentGroup().imageUrls).toEqual(oldGallery);
        expect(await f.service.processDue(1, job.id)).toEqual({ processed: 0, failed: 0 });
        advance();
      }
      expect(f.mutations.some(request => request.path.includes("inventory_item_group"))).toBe(false);
      expect((await database.pool.query("SELECT sync_status FROM channels.channel_listings")).rows[0].sync_status).toBe("error");
      expect((await database.pool.query(`SELECT count(*)::int AS count FROM inventory.quantity_publication_attempts
        WHERE scope->>'externalScopeId'=$1 AND state IN ('running','uncertain')`, [identity.accountId])).rows[0].count).toBe(0);

      busy = false;
      f.provider.setQuantity(3);
      const restarted = new EbayListingSyncService(new PostgresEbayListingSyncRepository(database.pool), f.executor, clock, randomUUID);
      const running = restarted.processDue(1, job.id);
      await started;
      try {
        expect(await f.service.processDue(1, job.id)).toEqual({ processed: 0, failed: 0 });
      } finally { release(); }
      expect(await running).toEqual({ processed: 1, failed: 0 });
      expect(await f.store.get(job.id)).toMatchObject({ state: "completed", result: { synced: 1, errors: 0 } });
      expect(f.provider.currentGroup().imageUrls).toEqual(galleryPhotos);
      expect(f.provider.currentItem().availability.shipToLocationAvailability.quantity).toBe(3);
      expect(f.mutations.filter(request => request.path.includes("inventory_item_group"))).toHaveLength(1);
      expect(f.provider.client.createOffer).not.toHaveBeenCalled();
      expect(f.provider.client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
      const count = f.mutations.length;
      expect((await f.service.enqueue(identity, "operator", commandKey)).id).toBe(job.id);
      expect(await restarted.processDue(1, job.id)).toEqual({ processed: 0, failed: 0 });
      expect(f.mutations).toHaveLength(count);
      expect((await database.pool.query(`SELECT count(*)::int AS count FROM channels.ebay_listing_sync_events
        WHERE job_id=$1 AND event='recovering' AND evidence->>'code'='INVENTORY_PUBLICATION_TARGET_BUSY'`, [job.id])).rows[0].count).toBe(6);
    });

    it("retries an older terminal contention failure through normal enqueue without changing its immutable audit history", async () => {
      let busy = true;
      const f = fixture({ photoUrls: galleryPhotos, beforeGroup: async () => { if (busy) throw targetBusy(); } });
      const original = await f.service.enqueue(identity, "operator");
      const finish = f.store.finish.bind(f.store);
      // Reproduce the earlier classifier's terminal result through the actual
      // owned finish transaction, without weakening the database's audit guard.
      const legacy = vi.spyOn(f.store, "finish").mockImplementationOnce((job, outcome, now) => finish(job, {
        ...outcome, state: "needs_attention", resetAttempts: false,
        message: "The listing update could not finish. Inspect the saved sync job before retrying.",
      }, now));
      await f.service.processDue(1, original.id);
      legacy.mockRestore();
      const oldJob = await f.store.get(original.id);
      const oldEvents = (await database.pool.query("SELECT * FROM channels.ebay_listing_sync_events WHERE job_id=$1 ORDER BY id", [original.id])).rows;
      expect(oldJob).toMatchObject({ state: "needs_attention", code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
      expect((await f.service.list(identity.channelId)).find(job => job.id === original.id)?.issue)
        .toMatchObject({ retryable: true, action: { kind: "retry_sync" } });
      busy = false;
      advance();
      const commandKey = randomUUID();
      const retry = await f.service.enqueue(identity, "operator", commandKey);
      expect(retry.id).not.toBe(original.id);
      expect((await f.service.enqueue(identity, "operator", commandKey)).id).toBe(retry.id);
      await f.service.processDue(1, retry.id);
      expect(await f.store.get(retry.id)).toMatchObject({ state: "completed", result: { synced: 1, errors: 0 } });
      expect(f.provider.currentGroup().imageUrls).toEqual(galleryPhotos);
      expect(await f.store.get(original.id)).toEqual(oldJob);
      expect((await database.pool.query("SELECT * FROM channels.ebay_listing_sync_events WHERE job_id=$1 ORDER BY id", [original.id])).rows).toEqual(oldEvents);
      expect(f.provider.client.createOffer).not.toHaveBeenCalled();
      expect(f.provider.client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    });

    it("continues an old invalid draft through normal sync, preserving its failure and coalescing repeated commands", async () => {
      const f = fixture({ photoUrls: galleryPhotos });
      f.prepare.mockRejectedValueOnce(new EbayListingSyncError("EBAY_SYNC_DRAFT_SCOPE_INVALID",
        "The prepared update contains a different listing, group or SKU identity."));
      const original = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, original.id);
      const oldJob = await f.store.get(original.id);
      const oldEvents = (await database.pool.query("SELECT * FROM channels.ebay_listing_sync_events WHERE job_id=$1 ORDER BY id", [original.id])).rows;
      expect(oldJob).toMatchObject({ state: "needs_attention", code: "EBAY_SYNC_DRAFT_SCOPE_INVALID" });
      expect(f.mutations).toEqual([]);
      expect((await f.service.list(identity.channelId)).find(job => job.id === original.id)?.issue)
        .toMatchObject({ retryable: true, action: { kind: "retry_sync", label: "Sync existing listing" } });
      advance();
      const commandKey = randomUUID();
      const [retry, replay] = await Promise.all([
        f.service.enqueue(identity, "operator", commandKey), f.service.enqueue(identity, "operator", commandKey),
      ]);
      expect(retry.id).not.toBe(original.id);
      expect(replay.id).toBe(retry.id);
      const restarted = new EbayListingSyncService(new PostgresEbayListingSyncRepository(database.pool), f.executor, clock, randomUUID);
      await Promise.all([f.service.processDue(1, retry.id), restarted.processDue(1, retry.id)]);
      expect(await f.store.get(retry.id)).toMatchObject({ state: "completed", result: { synced: 1, errors: 0 } });
      expect(f.provider.currentItem().product.imageUrls).toEqual(galleryPhotos);
      expect(f.provider.currentGroup().imageUrls).toEqual(galleryPhotos);
      expect(await f.store.get(original.id)).toEqual(oldJob);
      expect((await database.pool.query("SELECT * FROM channels.ebay_listing_sync_events WHERE job_id=$1 ORDER BY id", [original.id])).rows).toEqual(oldEvents);
      expect((await database.pool.query("SELECT sync_status,sync_error FROM channels.channel_listings")).rows)
        .toEqual([{ sync_status: "synced", sync_error: null }]);
      const writes = structuredClone(f.mutations);
      expect((await f.service.enqueue(identity, "operator", commandKey)).id).toBe(retry.id);
      await restarted.processDue(1, retry.id);
      expect(f.mutations).toEqual(writes);
      expect(f.provider.client.createOffer).not.toHaveBeenCalled();
      expect(f.provider.client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
    });

    it("recovers a final 500 after partial work, restarts, replans current quantities, verifies and completes atomically", async () => {
      const f = fixture();
      f.fail("response");
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      expect(await f.store.get(job.id)).toMatchObject({
        state: "recovering",
        code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN",
      });
      expect(
        (
          await database.pool.query(
            "SELECT last_synced_price,sync_status FROM channels.channel_listings",
          )
        ).rows[0],
      ).toEqual({ last_synced_price: 999, sync_status: "error" });
      const before = (
        await database.pool.query(
          "SELECT id::text,state,error_code FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'=$1 AND state='uncertain'",
          [identity.accountId],
        )
      ).rows[0];
      expect(before.error_code).toBe("EBAY_QUANTITY_RESPONSE_UNCERTAIN");
      advance();
      f.provider.setQuantity(2);
      const restartedStore = new PostgresEbayListingSyncRepository(
          database.pool,
        ),
        restarted = new EbayListingSyncService(
          restartedStore,
          f.executor,
          clock,
          randomUUID,
        );
      await restarted.processDue(1, job.id);
      expect(await restartedStore.get(job.id)).toMatchObject({
        state: "completed",
        result: { synced: 1, errors: 0 },
      });
      expect(
        f.provider.currentItem().availability.shipToLocationAvailability
          .quantity,
      ).toBe(2);
      const old = (
        await database.pool.query(
          "SELECT state,error_code,resolution_basis FROM inventory.quantity_publication_attempts WHERE id=$1",
          [before.id],
        )
      ).rows[0];
      expect(old).toEqual({
        state: "resolved",
        error_code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN",
        resolution_basis: "provider_response_terminal",
      });
      const receipt = (
        await database.pool.query(
          "SELECT before_record,request_receipts FROM inventory.quantity_publication_response_recoveries WHERE attempt_id=$1",
          [before.id],
        )
      ).rows[0];
      expect(receipt.before_record.state).toBe("uncertain");
      expect(receipt.request_receipts[0]).toMatchObject({
        httpStatus: 500,
        outcome: "uncertain",
        errorCodes: ["25002"],
      });
      expect(
        (
          await database.pool.query(
            "SELECT last_synced_price,last_synced_qty,sync_status,sync_error FROM channels.channel_listings",
          )
        ).rows[0],
      ).toEqual({
        last_synced_price: 1149,
        last_synced_qty: 999,
        sync_status: "synced",
        sync_error: null,
      });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM inventory.quantity_publication_response_recoveries WHERE attempt_id=$1",
            [before.id],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (await f.recovery.reconcile([scope("P5"), scope("group:PACK")]))
          .resolved,
      ).toEqual([]);
    });
    it("persists accepted content, survives restart and concurrent workers, and verifies delayed readback without additional mutations", async () => {
      const f = fixture();
      const oldGroup = structuredClone(f.provider.currentGroup());
      const read = f.client.getInventoryItemGroup;
      let visible = false;
      f.client.getInventoryItemGroup = vi.fn(async key => visible ? read(key) : structuredClone(oldGroup));
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      const waiting = await f.store.get(job.id);
      expect(waiting).toMatchObject({ state: "recovering", code: "EBAY_SYNC_READBACK_PENDING", verificationRevision: "1" });
      expect(waiting.verificationIntentHash).toMatch(/^[a-f0-9]{64}$/);
      const count = f.mutations.length;
      expect(count).toBe(3);
      advance();
      f.provider.setQuantity(1);
      const restartedStore = new PostgresEbayListingSyncRepository(database.pool);
      const restarted = new EbayListingSyncService(restartedStore, f.executor, clock, randomUUID);
      await restarted.processDue(1, job.id);
      expect((await restartedStore.get(job.id)).state).toBe("recovering");
      expect(f.mutations).toHaveLength(count);
      visible = true;
      advance();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      f.client.getInventoryItemGroup = vi.fn(async key => { entered(); await gate; return read(key); });
      const running = restarted.processDue(1, job.id);
      await started;
      try {
        expect(await f.service.processDue(1, job.id)).toEqual({ processed: 0, failed: 0 });
      } finally { release(); }
      await running;
      expect(await restartedStore.get(job.id)).toMatchObject({ state: "completed", result: { synced: 1, qtyChanges: 0 } });
      expect(f.mutations).toHaveLength(count);
      expect(f.provider.currentItem().availability.shipToLocationAvailability.quantity).toBe(7);
      expect((await database.pool.query("SELECT last_synced_price,last_synced_qty,sync_status FROM channels.channel_listings")).rows[0])
        .toEqual({ last_synced_price: 1149, last_synced_qty: 999, sync_status: "synced" });
    });
    it("recovers readback with a nullable saved offer ID without rewriting the accepted update", async () => {
      identity.variants[0].offerId = null;
      await database.pool.query("UPDATE channels.channel_listings SET external_variant_id=NULL");
      try {
        const f = fixture();
        const prepared = await f.prepare();
        delete prepared.draft.offers[0].payload.offerId;
        f.prepare.mockResolvedValue(prepared);
        const oldGroup = structuredClone(f.provider.currentGroup());
        const read = f.client.getInventoryItemGroup;
        f.client.getInventoryItemGroup = vi.fn(async () => structuredClone(oldGroup));
        const job = await f.service.enqueue(identity, "operator");
        await f.service.processDue(1, job.id);
        expect(await f.store.get(job.id)).toMatchObject({
          state: "recovering", code: "EBAY_SYNC_READBACK_PENDING", verificationRevision: "1",
        });
        f.client.getInventoryItemGroup = read;
        advance();
        const restarted = new EbayListingSyncService(
          new PostgresEbayListingSyncRepository(database.pool), f.executor, clock, randomUUID,
        );
        await restarted.processDue(1, job.id);
        expect((await f.store.get(job.id)).state).toBe("completed");
        expect(f.mutations).toHaveLength(3);
        expect((await database.pool.query("SELECT external_variant_id,sync_status FROM channels.channel_listings")).rows[0])
          .toEqual({ external_variant_id: null, sync_status: "synced" });
      } finally {
        await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='offer-101'");
      }
    });
    it("binds a checkpoint to its requested revision and applies a newer content intent", async () => {
      const f = fixture();
      const oldGroup = structuredClone(f.provider.currentGroup());
      const read = f.client.getInventoryItemGroup;
      f.client.getInventoryItemGroup = vi.fn(async () => structuredClone(oldGroup));
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      const prior = await f.store.get(job.id);
      await f.service.enqueue(identity, "operator");
      const next = await f.prepare();
      next.draft.inventoryItems[0].payload.product.imageUrls = ["https://example.com/new-request.jpg"];
      next.draft.itemGroup!.payload.imageUrls = ["https://example.com/new-request.jpg"];
      f.prepare.mockResolvedValue(next);
      f.client.getInventoryItemGroup = read;
      advance();
      await f.service.processDue(1, job.id);
      const completed = await f.store.get(job.id);
      expect(completed).toMatchObject({ state: "completed", revision: "2", verificationRevision: "2" });
      expect(completed.verificationIntentHash).not.toBe(prior.verificationIntentHash);
      expect(f.mutations).toHaveLength(6);
      expect(f.provider.currentGroup().imageUrls).toEqual(["https://example.com/new-request.jpg"]);
    });
    it("rolls the checkpoint and its stage evidence back together, then adopts accepted content without another write", async () => {
      const f = fixture();
      const job = await f.service.enqueue(identity, "operator");
      await database.pool.query(`CREATE FUNCTION channels.test_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.verification_intent_hash IS DISTINCT FROM OLD.verification_intent_hash THEN RAISE EXCEPTION 'injected checkpoint failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_checkpoint_failure BEFORE UPDATE ON channels.ebay_listing_sync_jobs FOR EACH ROW EXECUTE FUNCTION channels.test_checkpoint_failure()`);
      try {
        await f.service.processDue(1, job.id);
        expect(await f.store.get(job.id)).toMatchObject({ state: "recovering", verificationIntentHash: null, verificationRevision: null });
        expect((await database.pool.query("SELECT id FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND evidence->>'key'='verification'", [job.id])).rows).toEqual([]);
      } finally {
        await database.pool.query("DROP TRIGGER test_checkpoint_failure ON channels.ebay_listing_sync_jobs");
      }
      const count = f.mutations.length;
      expect(count).toBe(3);
      advance();
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
      expect(f.mutations).toHaveLength(count);
    });
    it("rejects preseeded checkpoints, unfenced mutations, and checkpoints without owned stage evidence", async () => {
      const f = fixture();
      const job = await f.service.enqueue(identity, "operator");
      const hash = "a".repeat(64);
      await expect(database.pool.query(
        `INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,identity,identity_hash,
          requested_by,created_at,updated_at,next_attempt_at,verification_intent_hash,verification_revision)
         SELECT $2::uuid,channel_id,connection_id,product_id,identity,identity_hash,requested_by,
          created_at,updated_at,next_attempt_at,$3,1 FROM channels.ebay_listing_sync_jobs WHERE id=$1`,
        [job.id, randomUUID(), hash],
      )).rejects.toMatchObject({ code: "23514" });
      await expect(database.pool.query(
        "UPDATE channels.ebay_listing_sync_jobs SET verification_intent_hash=$2,verification_revision=1 WHERE id=$1",
        [job.id, hash],
      )).rejects.toMatchObject({ code: "23514" });
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [918427, job.id]);
        await client.query(
          "UPDATE channels.ebay_listing_sync_jobs SET state='running',owner_token=$2,claimed_revision=1 WHERE id=$1",
          [job.id, randomUUID()],
        );
        await expect(client.query(
          "UPDATE channels.ebay_listing_sync_jobs SET verification_intent_hash=$2,verification_revision=1 WHERE id=$1",
          [job.id, hash],
        )).rejects.toMatchObject({ code: "23514" });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(await f.store.get(job.id)).toMatchObject({ verificationIntentHash: null, verificationRevision: null });
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
    });
    it("adopts the old incident shape of completed bulk quantity receipts followed by a group error, without an operator attestation", async () => {
      const f = fixture();
      await expect(
        f.admission.runListingGroup(
          scope("group:PACK"),
          [scope("P5")],
          async () => {
            throw new Error("unused");
          },
          async () => {
            for (let index = 0; index < 2; index++)
              await observeEbayQuantityRequest(
                {
                  method: "POST",
                  path: "/sell/inventory/v1/bulk_update_price_quantity",
                  body: { requests: [{ sku: "P5", offers: [], shipToLocationAvailability: { quantity: index } }] },
                },
                () =>
                  executeEbayQuantityHttp({
                    url: "https://api.example.test/quantity",
                    method: "POST",
                    path: "/sell/inventory/v1/bulk_update_price_quantity",
                    body: { requests: [{ sku: "P5", offers: [], shipToLocationAvailability: { quantity: index } }] },
                    headers: {},
                    now: clock,
                    request: async () =>
                      new Response(
                        JSON.stringify({
                          responses: [{ sku: "P5", statusCode: 200 }],
                        }),
                        { status: 200 },
                      ),
                  }),
              );
            await observeEbayQuantityRequest(
              {
                method: "PUT",
                path: "/sell/inventory/v1/inventory_item_group/PACK",
                body: {},
              },
              () =>
                executeEbayQuantityHttp({
                  url: "https://api.example.test/group",
                  method: "PUT",
                  path: "/sell/inventory/v1/inventory_item_group/PACK",
                  headers: {},
                  now: clock,
                  request: async () =>
                    new Response(
                      JSON.stringify({
                        errors: [
                          {
                            errorId: 25002,
                            message: "A user error has occurred.",
                          },
                        ],
                      }),
                      { status: 500 },
                    ),
                }),
            );
          },
        ),
      ).rejects.toMatchObject({ code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN" });
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
      const receipt = (
        await database.pool.query(
          "SELECT request_receipts FROM inventory.quantity_publication_response_recoveries WHERE before_record->'scope'->>'externalScopeId'=$1",
          [identity.accountId],
        )
      ).rows[0];
      expect(receipt.request_receipts.map((r: any) => r.httpStatus)).toEqual([
        200, 200, 500,
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM inventory.quantity_publication_attempt_resolutions",
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it("keeps the failure retry budget after successful passes with commands arriving during execution", async () => {
      const f = fixture(),
        job = await f.service.enqueue(identity, "operator");
      const prepare = f.prepare.getMockImplementation()!;
      f.prepare.mockImplementation(async () => {
        await f.service.enqueue(identity, "operator");
        return prepare();
      });
      for (let index = 0; index < 5; index++) {
        await f.service.processDue(1, job.id);
        expect((await f.store.get(job.id)).state).toBe("queued");
      }
      const next = await prepare();
      next.draft.inventoryItems[0].payload.product.imageUrls = ["https://example.com/next-pass.jpg"];
      next.draft.itemGroup!.payload.imageUrls = ["https://example.com/next-pass.jpg"];
      f.prepare.mockResolvedValue(next);
      f.fail("response");
      await f.service.processDue(1, job.id);
      expect(await f.store.get(job.id)).toMatchObject({
        state: "recovering",
        attempts: 1,
      });
      advance();
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
    });
    it("coalesces concurrent commands, replays a stable key, fences competing claims and retains requests arriving during execution", async () => {
      const f = fixture(),
        key = randomUUID();
      const [first, replay] = await Promise.all([
        f.service.enqueue(identity, "operator", key),
        f.service.enqueue(identity, "operator", key),
      ]);
      expect(first.id).toBe(replay.id);
      await expect(
        f.service.enqueue(identity, "other-operator", key),
      ).rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
      const claim = await f.store.claim(clock(), randomUUID(), first.id);
      expect(claim).not.toBeNull();
      const competitor = new PostgresEbayListingSyncRepository(database.pool);
      expect(
        await competitor.claim(clock(), randomUUID(), first.id),
      ).toBeNull();
      const joinedCommandKey = randomUUID();
      const newer = await competitor.enqueue(
        identity,
        joinedCommandKey,
        "other-operator",
        clock(),
      );
      expect(newer.id).toBe(first.id);
      expect(newer.revision).toBe("2");
      expect((await f.service.getByCommand(joinedCommandKey, identity.channelId))?.id).toBe(first.id);
      // Recovery commands may join a job originally requested by another actor.
      // Authorize replay using the immutable command, not requested_by on the job.
      expect((await f.service.getByCommand(joinedCommandKey, identity.channelId, "other-operator"))?.id).toBe(first.id);
      await expect(f.service.getByCommand(joinedCommandKey, identity.channelId, "operator"))
        .rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
      expect(await f.service.getByCommand(joinedCommandKey, identity.channelId + 1)).toBeNull();
      expect(await f.service.getByCommand(randomUUID(), identity.channelId)).toBeNull();
      await f.store.finish(
        claim!.job,
        {
          state: "completed",
          result: null,
          code: null,
          message: null,
          nextAttemptAt: clock(),
        },
        clock(),
      );
      await claim!.release();
      expect((await f.store.get(first.id)).state).toBe("queued");
      await f.service.processDue(1, first.id);
      expect((await f.store.get(first.id)).state).toBe("completed");
      expect((await f.service.getByCommand(joinedCommandKey, identity.channelId))?.state).toBe("completed");
      expect(
        f.mutations.filter((r) => r.path.includes("inventory_item_group")),
      ).toHaveLength(1);
      await expect(
        f.store.stage(claim!.job, "stale", "a".repeat(64), "started", clock()),
      ).rejects.toMatchObject({ code: "EBAY_SYNC_OWNER_LOST" });
    });
    it("reclaims a crashed local job while retaining its started stage and request identity", async () => {
      const f = fixture(),
        job = await f.service.enqueue(identity, "operator"),
        claim = await f.store.claim(clock(), randomUUID(), job.id);
      await f.store.stage(
        claim!.job,
        "offer:offer-101",
        "a".repeat(64),
        "started",
        clock(),
      );
      await claim!.release();
      const restarted = new EbayListingSyncService(
        new PostgresEbayListingSyncRepository(database.pool),
        f.executor,
        clock,
        randomUUID,
      );
      await restarted.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='claimed'",
            [job.id],
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it("rolls projection and completion back together when the immutable completion event fails, then recovers", async () => {
      const f = fixture(),
        job = await f.service.enqueue(identity, "operator");
      await database.pool
        .query(`CREATE FUNCTION channels.test_sync_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event='completed' THEN RAISE EXCEPTION 'injected audit failure'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER test_sync_audit_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_sync_audit_failure()`);
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("recovering");
      const mutationCount = f.mutations.length;
      expect(
        (
          await database.pool.query(
            "SELECT last_synced_price,sync_status FROM channels.channel_listings",
          )
        ).rows[0],
      ).toEqual({ last_synced_price: 999, sync_status: "error" });
      await database.pool.query(
        "DROP TRIGGER test_sync_audit_failure ON channels.ebay_listing_sync_events",
      );
      advance();
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
      expect(f.mutations).toHaveLength(mutationCount);
    });
    it("keeps an unreceipted timeout fenced and exposes the exact unresolved attempt instead of blindly replaying", async () => {
      const f = fixture();
      f.fail("timeout");
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      const count = f.mutations.length;
      advance();
      await f.service.processDue(1, job.id);
      expect(await f.store.get(job.id)).toMatchObject({
        state: "awaiting_evidence",
        code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
      });
      expect(f.mutations).toHaveLength(count);
      expect(
        (
          await database.pool.query(
            "SELECT state FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'=$1 AND state='uncertain'",
            [identity.accountId],
          )
        ).rows,
      ).toHaveLength(1);
      // Only the disposable provider fixture supplies this explicit termination
      // evidence. Production attestation still requires operator authorization.
      const attempt = (
        await database.pool.query(
          "SELECT id::text FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'=$1 AND state='uncertain'",
          [identity.accountId],
        )
      ).rows[0];
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await attestQuantityPublicationAttemptInsideTransaction(client, {
          attemptId: attempt.id,
          idempotencyKey: `test-terminal:${attempt.id}`,
          actor: "test-operator",
          now: clock(),
          reason: "Disposable mocked provider request definitively terminated",
          evidenceKind: "owner_process_and_request_termination_record",
          terminalOutcome: "completed",
          evidenceReference:
            "disposable fixture: final mocked request termination",
          evidenceHash: "b".repeat(64),
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      advance();
      f.provider.setQuantity(4);
      await f.service.processDue(1, job.id);
      expect(await f.store.get(job.id)).toMatchObject({ state: "completed" });
      expect(
        f.provider.currentItem().availability.shipToLocationAvailability
          .quantity,
      ).toBe(4);
    });
    it("keeps an earlier group timeout fenced when a repaired job observes a different group with the same member SKU", async () => {
      const f=fixture();f.fail("timeout");
      const original=await f.service.enqueue(identity,"operator");
      await f.service.processDue(1,original.id);
      const prior=(await database.pool.query(`SELECT id::text,state,scope->>'externalInventoryItemId' AS item
        FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'=$1 AND state='uncertain'`,[identity.accountId])).rows;
      expect(prior).toHaveLength(1);expect(prior[0].item).toBe("group:PACK");
      const mutationCount=f.mutations.length;
      const previous=(await f.store.get(original.id)).providerIdentity;
      identity={...identity,groupKey:"new-proven-provider-group"};
      const client=await database.pool.connect();
      let replacementId:string;
      try {
        await client.query("BEGIN");
        const replacement=await f.store.enqueueInsideTransaction(client,identity,randomUUID(),"operator",clock(),identity);
        replacementId=replacement.id;await client.query("COMMIT");
      } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
      expect(replacementId).not.toBe(original.id);
      await f.service.processDue(1,replacementId);
      expect(await f.store.get(replacementId)).toMatchObject({state:"awaiting_evidence",code:"EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
        message:expect.stringContaining(prior[0].id)});
      expect(f.mutations).toHaveLength(mutationCount);
      expect(await f.store.get(original.id)).toMatchObject({state:"needs_attention",code:"EBAY_SYNC_SOURCE_SUPERSEDED",providerIdentity:previous});
      expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE id=$1",[prior[0].id])).rows[0].state).toBe("uncertain");
    });
    it("resumes the already saved job after an explicit unknown-outcome decision even if no follow-up enqueue commits", async () => {
      const f = fixture();
      f.fail("timeout");
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      advance();
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("awaiting_evidence");
      const recovery = new EbayPublicationRecoveryService(new PostgresEbayPublicationRecoveryRepository(database.pool), clock);
      const scopes = [{ ...scope("group:PACK"), productId: 20 }, { ...scope("P5"), productId: 20, productVariantId: 101 }];
      const preview = await recovery.preview(scopes);
      const result = await recovery.resume({ scopes, previewHash: preview.previewHash, idempotencyKey: randomUUID(),
        actor: "operator", acknowledgeUnknownOutcome: true });
      expect(result.providerWriteAttempted).toBe(false);
      expect((await database.pool.query("SELECT state,completed_at,resolution_basis FROM inventory.quantity_publication_attempts WHERE id=ANY($1::bigint[])",
        [result.attemptIds])).rows).toEqual([{ state: "superseded_unknown", completed_at: null, resolution_basis: null }]);
      expect((await database.pool.query("SELECT scope->>'productVariantId' AS variant,reason FROM inventory.quantity_publication_catchup WHERE scope->>'externalScopeId'=$1 AND scope->>'externalInventoryItemId'='P5'",
        [identity.accountId])).rows).toEqual([{ variant: "101", reason: "operator_resume_unknown_outcome" }]);
      // Simulate the response/queue step being lost after the recovery transaction.
      // The saved worker resumes using its own due schedule and current plan.
      advance();
      f.provider.setQuantity(4);
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
      expect(f.provider.currentItem().availability.shipToLocationAvailability.quantity).toBe(4);
    });
    it("rolls response recovery evidence and the fence transition back together, then resumes the saved job", async () => {
      const f = fixture();
      f.fail("response");
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      const attempt = (
        await database.pool.query(
          "SELECT id::text FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'=$1 AND state='uncertain'",
          [identity.accountId],
        )
      ).rows[0];
      await database.pool
        .query(`CREATE FUNCTION inventory.test_response_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected response audit failure'; END $$;
        CREATE TRIGGER test_response_audit_failure BEFORE INSERT ON inventory.quantity_publication_response_recoveries FOR EACH ROW EXECUTE FUNCTION inventory.test_response_audit_failure()`);
      try {
        await expect(
          f.recovery.reconcile([scope("group:PACK")]),
        ).rejects.toMatchObject({
          code: "PUBLICATION_RESPONSE_RECOVERY_FAILED",
        });
        advance();
        await f.service.processDue(1, job.id);
        expect(await f.store.get(job.id)).toMatchObject({
          state: "recovering",
          code: "PUBLICATION_RESPONSE_RECOVERY_FAILED",
        });
        expect(
          (
            await database.pool.query(
              "SELECT state FROM inventory.quantity_publication_attempts WHERE id=$1",
              [attempt.id],
            )
          ).rows[0].state,
        ).toBe("uncertain");
        expect(
          (
            await database.pool.query(
              "SELECT attempt_id FROM inventory.quantity_publication_response_recoveries WHERE attempt_id=$1",
              [attempt.id],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await database.pool.query(
          "DROP TRIGGER test_response_audit_failure ON inventory.quantity_publication_response_recoveries",
        );
      }
      advance();
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
    });
    it("recovers a lost stage checkpoint after an accepted write and keeps the original audit records immutable", async () => {
      const f = fixture(),
        job = await f.service.enqueue(identity, "operator");
      await database.pool
        .query(`CREATE FUNCTION channels.test_stage_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event='stage_completed' AND NEW.evidence->>'key'='item:P5' THEN RAISE EXCEPTION 'injected stage audit failure'; END IF;RETURN NEW;END $$;
        CREATE TRIGGER test_stage_audit_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_stage_audit_failure()`);
      try {
        await f.service.processDue(1, job.id);
        expect((await f.store.get(job.id)).state).toBe("recovering");
        expect(f.mutations).toHaveLength(1);
        expect(
          (
            await database.pool.query(
              "SELECT state FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'=$1",
              [identity.accountId],
            )
          ).rows[0].state,
        ).toBe("succeeded");
      } finally {
        await database.pool.query(
          "DROP TRIGGER test_stage_audit_failure ON channels.ebay_listing_sync_events",
        );
      }
      advance();
      f.provider.setQuantity(1);
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
      expect(
        f.provider.currentItem().availability.shipToLocationAvailability
          .quantity,
      ).toBe(1);
      for (const table of [
        "ebay_listing_sync_events",
        "ebay_listing_sync_commands",
      ]) {
        await expect(
          database.pool.query(`DELETE FROM channels.${table} WHERE job_id=$1`, [
            job.id,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await expect(
        database.pool.query(
          "UPDATE channels.ebay_listing_sync_jobs SET identity='{}' WHERE id=$1",
          [job.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("does not reconcile while an admitted provider owner is still active, nor resolve another account", async () => {
      const f = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const running = f.admission.run(scope("P5"), async () => {
        entered();
        await gate;
      });
      await started;
      expect(await f.recovery.reconcile([scope("P5")])).toMatchObject({
        busy: true,
        resolved: [],
      });
      release();
      await running;
      expect(
        await f.recovery.reconcile([
          { ...scope("P5"), externalScopeId: "different-account" },
        ]),
      ).toMatchObject({ busy: false, resolved: [], unresolved: [] });
    });
    it.each(["recovering", "awaiting_evidence"] as const)("queues a new maintenance revision without its old %s error, preserving audit history", async state => {
      const f = fixture();
      const original = await f.service.enqueue(identity, "operator");
      const claim = (await f.store.claim(clock(), randomUUID(), original.id))!;
      try {
        await f.store.finish(claim.job, { state, result: null, code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
          message: "Earlier unknown response", nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
      const command = randomUUID();
      const resumed = await f.service.enqueue(identity, "operator", command);
      expect(resumed).toMatchObject({ id: original.id, state: "queued", revision: "2", code: null, message: null });
      expect(await f.service.enqueue(identity, "operator", command)).toMatchObject({ id: original.id, revision: "2" });
      const history = await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event=$2", [original.id, state]);
      expect(JSON.stringify(history.rows)).toContain("EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED");
      await f.service.processDue(1, original.id);
      expect(await f.store.get(original.id)).toMatchObject({ state: "completed" });
    });
    it("keeps a live owner's claim while coalescing a click, then queues the newer revision without stale errors", async () => {
      const f = fixture();
      const job = await f.service.enqueue(identity, "operator");
      const claim = (await f.store.claim(clock(), randomUUID(), job.id))!;
      try {
        const joined = await f.service.enqueue(identity, "operator", randomUUID());
        expect(joined).toMatchObject({ state: "running", ownerToken: claim.job.ownerToken, claimedRevision: "1", revision: "2" });
        await f.store.finish(claim.job, { state: "recovering", result: null, code: "PUBLICATION_SCOPE_BUSY",
          message: "Old revision waited", nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
      expect(await f.store.get(job.id)).toMatchObject({ state: "queued", revision: "2", ownerToken: null, code: null, message: null });
      await f.service.processDue(1, job.id);
      expect(await f.store.get(job.id)).toMatchObject({ state: "completed" });
    });
    it("completes the exact provider alias after a catalog rename without overwriting its saved mapping", async () => {
      identity = { ...identity, variants: identity.variants.map(member => ({ ...member, catalogSku: "PACK-CURRENT" })) };
      await database.pool.query("UPDATE catalog.product_variants SET sku='PACK-CURRENT' WHERE id=101");
      try {
        const f = fixture();
        const job = await f.service.enqueue(identity, "operator");
        await f.service.processDue(1, job.id);
        expect(await f.store.get(job.id)).toMatchObject({ state: "completed", result: { synced: 1, errors: 0 } });
        expect((await database.pool.query("SELECT external_sku,external_variant_id,external_product_id,last_synced_price,last_synced_qty,sync_status FROM channels.channel_listings WHERE product_variant_id=101")).rows[0])
          .toEqual({ external_sku: "P5", external_variant_id: "offer-101", external_product_id: "listing-20", last_synced_price: 1149, last_synced_qty: 999, sync_status: "synced" });
      } finally { await database.pool.query("UPDATE catalog.product_variants SET sku='P5' WHERE id=101"); }
    });
    it("binds observed provider identity once, replays it, and refuses changed bindings or unowned SQL", async () => {
      const f = fixture();
      const job = await f.service.enqueue(identity, "operator");
      const claim = (await f.store.claim(clock(), randomUUID(), job.id))!;
      const observed = { ...identity, groupKey: "VERIFIED-EXTERNAL-GROUP" };
      try {
        await f.store.bindProviderIdentity(claim.job, observed, clock());
        await f.store.bindProviderIdentity(claim.job, observed, clock());
        expect((await f.store.get(job.id)).providerIdentity).toEqual(observed);
        expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND evidence->>'key'='provider_identity'", [job.id])).rows[0].count).toBe(1);
        await expect(f.store.bindProviderIdentity(claim.job, { ...observed, groupKey: "DIFFERENT-GROUP" }, clock()))
          .rejects.toMatchObject({ code: "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED" });
        await expect(database.pool.query("UPDATE channels.ebay_listing_sync_jobs SET provider_identity_hash=$2 WHERE id=$1", [job.id, "b".repeat(64)]))
          .rejects.toThrow();
        await f.store.finish(claim.job, { state: "needs_attention", result: null, code: "TEST_COMPLETED", message: null, nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
    });
    it("persists admission failures and serializes global command replay across different products", async () => {
      const f = fixture();
      await database.pool.query("INSERT INTO catalog.products(id,sku) VALUES(21,'OTHER-PRODUCT') ON CONFLICT(id) DO NOTHING");
      const rejected = { channelId: 1, productId: 21, variantIds: [102], actor: "operator", commandKey: randomUUID(),
        code: "EBAY_SYNC_MAPPING_INVALID", message: "Review the saved eBay mapping." };
      const first = await f.store.recordAdmissionFailure(rejected, clock());
      expect(await f.store.recordAdmissionFailure(rejected, clock())).toEqual(first);
      expect((await f.store.list(1)).find(row => row.productId === 21)).toMatchObject({ kind: "admission", state: "needs_attention", code: rejected.code });
      await expect(f.store.enqueue(identity, rejected.commandKey, "operator", clock())).rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
      const commandKey = randomUUID();
      const outcomes = await Promise.allSettled([
        f.store.enqueue(identity, commandKey, "operator", clock()),
        f.store.recordAdmissionFailure({ ...rejected, commandKey }, clock()),
      ]);
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
      const count = (await database.pool.query("SELECT (SELECT count(*) FROM channels.ebay_listing_sync_commands WHERE command_key=$1)+(SELECT count(*) FROM channels.ebay_listing_sync_admission_failures WHERE command_key=$1) AS count", [commandKey])).rows[0].count;
      expect(Number(count)).toBe(1);
      if (outcomes[0].status === "fulfilled") {
        const claim = (await f.store.claim(clock(), randomUUID(), outcomes[0].value.id))!;
        try { await f.store.finish(claim.job, { state: "needs_attention", result: null, code: "TEST_COMPLETED", message: null, nextAttemptAt: clock() }, clock()); }
        finally { await claim.release(); }
      }
    });
    it("supersedes an idle changed source mapping while preserving its unresolved quantity history, but refuses a live owner", async () => {
      const f = fixture();
      f.fail("timeout");
      const original = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, original.id);
      const evidence = (await database.pool.query("SELECT to_jsonb(a) AS value FROM inventory.quantity_publication_attempts a WHERE scope->>'externalScopeId'=$1", [identity.accountId])).rows;
      const changed = { ...identity, variants: identity.variants.map(member => ({ ...member, sku: "P5-RENAMED", externalSku: "P5-RENAMED" })) };
      const replacement = await f.store.enqueue(changed, randomUUID(), "operator", clock());
      expect(replacement.id).not.toBe(original.id);
      expect(await f.store.get(original.id)).toMatchObject({ state: "needs_attention", code: "EBAY_SYNC_SOURCE_SUPERSEDED" });
      expect((await database.pool.query("SELECT to_jsonb(a) AS value FROM inventory.quantity_publication_attempts a WHERE scope->>'externalScopeId'=$1", [identity.accountId])).rows).toEqual(evidence);
      const claim = (await f.store.claim(clock(), randomUUID(), replacement.id))!;
      try {
        await expect(f.store.enqueue(identity, randomUUID(), "operator", clock())).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
        expect((await f.store.get(replacement.id)).state).toBe("running");
        await f.store.finish(claim.job, { state: "needs_attention", result: null, code: "TEST_COMPLETED", message: null, nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
    });
    it("recovers only the affected stock while an unrelated publisher remains active", async () => {
      const f = fixture();
      f.fail("response");
      const job = await f.service.enqueue(identity, "operator");
      await f.service.processDue(1, job.id);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const running = f.admission.run(
        { ...scope("P5"), externalScopeId: "unrelated-active-account" },
        async () => {
          entered();
          await gate;
        },
      );
      await started;
      try {
        const recovery = await f.recovery.reconcile([
          scope("group:PACK"),
          scope("P5"),
        ]);
        expect(recovery.busy).toBe(false);
        expect(recovery.resolved).toHaveLength(1);
      } finally {
        release();
        await running;
      }
      advance();
      await f.service.processDue(1, job.id);
      expect((await f.store.get(job.id)).state).toBe("completed");
    });
    it("recovers a crash after retired-member reconciliation and provider writes without repeating writes or changing retired mappings", async () => {
      await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(7777,20,'RETIRED-C200') ON CONFLICT(id) DO NOTHING");
      await database.pool.query(`INSERT INTO channels.channel_listings VALUES(1,7777,'RETIRED-C200','retired-offer',NULL,231,0,'ended','historic retired state',NULL,NULL)`);
      try {
        const f = fixture({ photoUrls: galleryPhotos });
        const { currentSource } = withRetiredUnpublishedMember(f);
        const retiredBefore = (await database.pool.query("SELECT * FROM channels.channel_listings WHERE product_variant_id=7777")).rows[0];
        f.prepare.mockRejectedValueOnce(new EbayListingSyncError("EBAY_SYNC_MEMBERSHIP_CHANGED", "Historical three-versus-two membership failure"));
        const old = await f.service.enqueue(identity, "operator");
        await f.service.processDue(1, old.id);
        expect((await f.store.get(old.id)).state).toBe("needs_attention");
        const historicalEvents = (await database.pool.query("SELECT * FROM channels.ebay_listing_sync_events WHERE job_id=$1 ORDER BY id", [old.id])).rows;
        advance();
        const command = randomUUID();
        const saved = await f.service.enqueue(identity, "operator", command);
        const claim = (await f.store.claim(clock(), randomUUID(), saved.id))!;
        try {
          await f.executor.execute(claim.job.identity, async (key, hash, work) => {
          await f.store.stage(claim.job, key, hash, "started", clock());
          const result = await work();
          await f.store.stage(claim.job, key, hash, "completed", clock());
          return result;
        }, null, (resolved, observation, source) => f.store.bindProviderIdentity(claim.job, resolved, clock(), observation, source));
          const afterWrites = await f.store.get(saved.id);
          expect(afterWrites).toMatchObject({ state: "running", providerIdentity: { variants: [expect.objectContaining({ variantId: 101 })] } });
          expect(afterWrites.identity.variants.map(member => member.variantId)).toEqual([101, 7777]);
        } finally {
          // Process loss after verified provider writes, before local completion.
          await claim.release();
        }
        const writes = structuredClone(f.mutations);
        expect(writes).toHaveLength(3);
        const restartedStore = new PostgresEbayListingSyncRepository(database.pool);
        const restarted = new EbayListingSyncService(restartedStore, f.executor, clock, randomUUID);
        const results = await Promise.all([f.service.processDue(1, saved.id), restarted.processDue(1, saved.id)]);
        expect(results.reduce((count, result) => count + result.processed, 0)).toBe(1);
        expect(await restartedStore.get(saved.id)).toMatchObject({ state: "completed", result: { synced: 1, errors: 0 } });
        expect(f.mutations).toEqual(writes);
        expect(f.provider.currentItem().product.imageUrls).toEqual(galleryPhotos);
        expect(f.provider.currentGroup().imageUrls).toEqual(galleryPhotos);
        expect((await database.pool.query("SELECT * FROM channels.channel_listings WHERE product_variant_id=7777")).rows[0]).toEqual(retiredBefore);
        const proof = (await database.pool.query(`SELECT evidence FROM channels.ebay_listing_sync_events
          WHERE job_id=$1 AND evidence->>'key'='provider_identity'`, [saved.id])).rows;
        expect(proof).toHaveLength(1);
        expect(proof[0].evidence.sourceIdentity).toEqual(currentSource);
        expect(proof[0].evidence.observation.evidence.nonMemberCandidates).toEqual([
          expect.objectContaining({ sku: "RETIRED-C200", groupIds: [], offers: [expect.objectContaining({ offerId: "retired-offer", status: "UNPUBLISHED" })] }),
        ]);
        expect((await f.service.enqueue(identity, "operator", command)).id).toBe(saved.id);
        expect(await restarted.processDue(1, saved.id)).toEqual({ processed: 0, failed: 0 });
        expect(f.mutations).toEqual(writes);
        expect((await database.pool.query("SELECT * FROM channels.ebay_listing_sync_events WHERE job_id=$1 ORDER BY id", [old.id])).rows).toEqual(historicalEvents);
        expect(f.provider.client.createOffer).not.toHaveBeenCalled();
        expect(f.provider.client.publishOfferByInventoryItemGroup).not.toHaveBeenCalled();
      } finally {
        await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=7777");
      }
    });

    it("rolls back a provider binding that drops a disabled mapping without complete unpublished evidence", async () => {
      const f = fixture();
      withRetiredUnpublishedMember(f);
      const saved = await f.service.enqueue(identity, "operator");
      const claim = (await f.store.claim(clock(), randomUUID(), saved.id))!;
      try {
        const prepared = await f.prepare();
        const unproved = { ...prepared.providerObservation!, evidence: {} };
        await expect(f.store.bindProviderIdentity(claim.job, prepared.identity, clock(), unproved, prepared.sourceIdentity))
          .rejects.toMatchObject({ code: "EBAY_SYNC_MEMBERSHIP_CHANGED" });
        expect((await f.store.get(saved.id)).providerIdentity).toBeNull();
        expect((await database.pool.query(`SELECT count(*)::int AS count FROM channels.ebay_listing_sync_events
          WHERE job_id=$1 AND evidence->>'key'='provider_identity'`, [saved.id])).rows[0].count).toBe(0);
        expect(f.mutations).toEqual([]);
        await f.store.finish(claim.job, { state: "needs_attention", result: null, code: "EBAY_SYNC_MEMBERSHIP_CHANGED",
          message: "Unproved membership", nextAttemptAt: clock() }, clock());
      } finally { await claim.release(); }
    });
  },
);
