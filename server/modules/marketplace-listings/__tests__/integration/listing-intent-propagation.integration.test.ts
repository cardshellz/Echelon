import { PostgresEbayListingSyncRepository } from "../../../channels/infrastructure/ebay-listing-sync.repository";
import { EbayListingSyncService } from "../../../channels/ebay-listing-sync.service";
import { PgDropshipListingPreviewRepository } from "../../../dropship/infrastructure/dropship-listing-preview.repository";
import type {
  CreateDropshipListingPushJobRepositoryInput,
  DropshipListingPreviewResult,
} from "../../../dropship/application/dropship-listing-preview-service";
import { ExistingListingIntentHandoff } from "../../infrastructure/existing-listing-intent-handoff";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresListingIntentPropagationRepository } from "../../infrastructure/pg-listing-intent-propagation.repository";
import { ListingIntentPropagationService } from "../../application/listing-intent-propagation.service";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const migration =
  "migrations/900000018000018580002_listing_intent_propagation.sql";
// Reduced source-owner tables retain the production names, identity types and
// desired fields. The installed capture migration and repository SQL are real;
// handoff acknowledgement is an injected boundary, not a provider execution test.
const base = `
CREATE SCHEMA catalog;CREATE SCHEMA channels;CREATE SCHEMA ebay;CREATE SCHEMA dropship;CREATE SCHEMA marketplace;
CREATE TABLE catalog.products(id int PRIMARY KEY,name text,product_type text,category text,category_id int,price_cents bigint,ebay_fulfillment_policy_override text);
CREATE TABLE catalog.product_variants(id int PRIMARY KEY,product_id int,sku text,name text,price_cents bigint,shopify_variant_id text,option1_name text,option1_value text);
CREATE TABLE catalog.product_assets(id int PRIMARY KEY,product_id int,product_variant_id int,url text,position int,file_data bytea);
CREATE TABLE public.shopify_variants(id text PRIMARY KEY,sku text,price numeric);
CREATE TABLE channels.channels(id int PRIMARY KEY,provider text);
CREATE TABLE channels.channel_connections(id int PRIMARY KEY,channel_id int,shop_domain text,metadata jsonb);
CREATE TABLE channels.channel_listings(id int PRIMARY KEY,channel_id int,product_variant_id int,external_product_id text,external_variant_id text);
CREATE TABLE channels.channel_product_overrides(id int PRIMARY KEY,channel_id int,product_id int,title_override text);
CREATE TABLE channels.channel_variant_overrides(id int PRIMARY KEY,channel_id int,product_variant_id int,name_override text);
CREATE TABLE channels.channel_pricing(id int PRIMARY KEY,channel_id int,product_variant_id int,price bigint,currency text);
CREATE TABLE channels.channel_asset_overrides(id int PRIMARY KEY,channel_id int,product_asset_id int,is_included int,position_override int);
CREATE TABLE channels.channel_pricing_rules(id int PRIMARY KEY,channel_id int,scope text,scope_id text,rule_type text,value numeric);
CREATE TABLE channels.walmart_connections(channel_id int,connection_id int,partner_id text,environment text,ship_node_id text,warehouse_id int,revision int);
CREATE TABLE ebay.ebay_oauth_tokens(channel_id int,environment text,external_account_id text,external_account_verified_at timestamptz);
CREATE TABLE ebay.ebay_category_mappings(id int PRIMARY KEY,channel_id int,product_type_slug text,fulfillment_policy_override text);
CREATE TABLE ebay.ebay_type_aspect_defaults(id int PRIMARY KEY,product_type_slug text,aspect_name text,aspect_value text);
CREATE TABLE ebay.ebay_product_aspect_overrides(id int PRIMARY KEY,product_id int,aspect_name text,aspect_value text);
CREATE TABLE dropship.dropship_vendors(id int PRIMARY KEY,member_id text);
CREATE TABLE dropship.dropship_store_connections(id int PRIMARY KEY,vendor_id int,platform text,external_account_id text,provider_environment text,external_account_verified_at timestamptz,config jsonb);
CREATE TABLE dropship.dropship_vendor_listings(id int PRIMARY KEY,vendor_id int,store_connection_id int,product_variant_id int,external_listing_id text,external_offer_id text);
CREATE TABLE dropship.dropship_product_listing_settings(store_connection_id int,vendor_id int,product_id int,revision_id int);
CREATE TABLE dropship.dropship_category_listing_settings(store_connection_id int,vendor_id int,category_id int,revision_id int);
CREATE TABLE dropship.dropship_listing_price_settings(store_connection_id int,vendor_id int,product_variant_id int,revision_id int,override_price_cents bigint,pricing_mode text);
CREATE TABLE dropship.dropship_listing_content_settings(store_connection_id int,vendor_id int,product_variant_id int,revision_id int);
CREATE TABLE dropship.dropship_pricing_profiles(store_connection_id int,vendor_id int,revision_id int);
CREATE TABLE dropship.dropship_content_profiles(store_connection_id int,vendor_id int,revision_id int);
CREATE TABLE dropship.dropship_ebay_category_rule_profiles(store_connection_id int,vendor_id int,revision_id int);
CREATE TABLE dropship.dropship_store_listing_configs(id int PRIMARY KEY,store_connection_id int,revision int,listing_mode text,marketplace_config jsonb);
   CREATE TABLE dropship.dropship_listing_push_jobs(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,vendor_id int,store_connection_id int,
    job_type text,status text,requested_scope jsonb,requested_by text,idempotency_key text,request_hash text,error_message text,created_at timestamptz,updated_at timestamptz,
    UNIQUE(vendor_id,idempotency_key));
INSERT INTO catalog.products VALUES (20,'Product A','sleeves','Sleeves',7,1000,NULL),(21,'Product B','boxes','Boxes',8,2000,NULL);
INSERT INTO catalog.product_variants VALUES(101,20,'SKU-A','A',1000,'remote-a',NULL,NULL),(102,20,'SKU-B','B',1200,NULL,NULL,NULL),(103,21,'SKU-C','C',2000,NULL,NULL,NULL);
INSERT INTO channels.channels VALUES(34,'ebay'),(35,'shopify'),(36,'walmart');
INSERT INTO channels.channel_connections VALUES(4,34,NULL,'{"environment":"production","marketplaceId":"EBAY_US"}'),(5,35,'shop.example',NULL),(6,36,NULL,NULL);
INSERT INTO ebay.ebay_oauth_tokens VALUES(34,'production','seller-a',now());
INSERT INTO channels.walmart_connections VALUES(36,6,'partner-a','production','node-a',1,1);
INSERT INTO channels.channel_listings VALUES(1,34,101,'listing-a','offer-a'),(2,34,102,'listing-a','offer-b'),(3,34,103,'listing-c','offer-c'),(4,35,101,'shop-product','shop-a'),(5,36,101,'wm-product','wm-a');
INSERT INTO catalog.product_assets VALUES(1,20,NULL,'https://example.com/a.jpg',0,NULL);
INSERT INTO public.shopify_variants VALUES('remote-a','SKU-A',10);
INSERT INTO channels.channel_pricing_rules VALUES(1,34,'product','20','fixed',10);
INSERT INTO dropship.dropship_vendors VALUES(10,'member-a'),(11,'member-b');
INSERT INTO dropship.dropship_store_connections VALUES(40,10,'ebay','vendor-seller','production',now(),'{"marketplaceId":"EBAY_US"}'),(41,11,'ebay','other-seller','production',now(),NULL);
INSERT INTO dropship.dropship_vendor_listings VALUES(1,10,40,101,'vendor-listing',NULL),(2,10,40,102,'vendor-listing',NULL);
`;

(url && disposable ? describe : describe.skip).sequential(
  "Listing intent durable propagation PostgreSQL",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: PostgresListingIntentPropagationRepository;
    const now = new Date("2026-10-19T18:00:00Z");
    beforeEach(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        base,
      );
      await database.pool.query(await readFile(migration, "utf8"));
      repository = new PostgresListingIntentPropagationRepository(
        database.pool,
      );
    });
    afterEach(async () => {
      await database?.close();
    });
    const changes = async () =>
      (
        await database.pool.query(
          "SELECT * FROM marketplace.listing_intent_changes ORDER BY id",
        )
      ).rows;
    const deliveries = async () =>
      (
        await database.pool.query(
          "SELECT * FROM marketplace.listing_intent_deliveries ORDER BY id",
        )
      ).rows;

    async function installDropshipJobs(): Promise<PgDropshipListingPreviewRepository> {
      await database.pool.query(`
   CREATE SEQUENCE dropship.listing_test_ids START 100;
   ALTER TABLE dropship.dropship_vendor_listings ALTER COLUMN id SET DEFAULT nextval('dropship.listing_test_ids');
   ALTER TABLE dropship.dropship_vendor_listings ADD COLUMN platform text DEFAULT 'ebay',ADD COLUMN status text DEFAULT 'active',
    ADD COLUMN vendor_retail_price_cents bigint,ADD COLUMN pushed_quantity int DEFAULT 0,ADD COLUMN quantity_cap int,
    ADD COLUMN last_preview_hash text,ADD COLUMN metadata jsonb,ADD COLUMN created_at timestamptz,ADD COLUMN updated_at timestamptz;
   CREATE UNIQUE INDEX listing_test_scope ON dropship.dropship_vendor_listings(store_connection_id,product_variant_id);
   CREATE TABLE dropship.dropship_listing_push_job_items(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id int,listing_id int,product_variant_id int,
    action text,status text,preview_hash text,error_code text,error_message text,result jsonb,idempotency_key text,created_at timestamptz,updated_at timestamptz);
   CREATE TABLE dropship.dropship_audit_events(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,vendor_id int,store_connection_id int,entity_type text,entity_id text,
    event_type text,actor_type text,actor_id text,severity text,payload jsonb,created_at timestamptz);
  `);
      return new PgDropshipListingPreviewRepository(database.pool);
    }
    function preparedJob(
      key: string,
    ): CreateDropshipListingPushJobRepositoryInput {
      const preview: DropshipListingPreviewResult = {
        vendorId: 10,
        storeConnectionId: 40,
        platform: "ebay",
        generatedAt: now,
        summary: { total: 2, ready: 2, blocked: 0, warning: 0 },
        rows: [101, 102].map((productVariantId) => ({
          productVariantId,
          productId: 20,
          sku: "SKU-" + productVariantId,
          title: "Prepared product",
          platform: "ebay",
          listingMode: "live",
          currentListingStatus: "active",
          previewStatus: "ready",
          blockers: [],
          warnings: [],
          marketplaceQuantity: 1,
          priceCents: 1000,
          marketplaceCategoryId: "category",
          marketplaceCategoryName: "Category",
          storeCategoryNames: [],
          businessPolicySelection: null,
          previewHash: "a".repeat(64),
          adminExposureDecision: {
            exposed: true,
            reason: "exposed",
            includeRuleIds: [],
            excludeRuleIds: [],
          },
          selectionDecision: {
            selected: true,
            reason: "selected",
            adminExposureReason: "exposed",
            includeRuleIds: [],
            excludeRuleIds: [],
            autoConnectNewSkus: false,
            autoListNewSkus: false,
            marketplaceQuantity: 1,
            quantityCapApplied: false,
          },
          listingTier: null,
          listingIntent: null,
        })),
      };
      return {
        vendorId: 10,
        storeConnectionId: 40,
        platform: "ebay",
        productVariantIds: [101, 102],
        requestedRetailPricesByVariantId: {},
        idempotencyKey: key,
        requestHash: "b".repeat(64),
        requestedBy: {
          actorType: "system",
          actorId: "system:listing-intent-propagation",
        },
        preview,
        now,
        managedIntentScope: {
          accountId: "vendor-seller",
          environment: "production",
          managedOnly: true,
        },
      };
    }
    async function installEbayJobs(): Promise<EbayListingSyncService> {
      await database.pool.query(`CREATE SCHEMA inventory;
   CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'immutable evidence' USING ERRCODE='23514'; END $$;`);
      const initial = await readFile(
        "migrations/0729_ebay_listing_sync_recovery.sql",
        "utf8",
      );
      const start = initial.indexOf(
        "CREATE TABLE channels.ebay_listing_sync_jobs",
      );
      const end = initial.indexOf(
        "CREATE TRIGGER publication_response_recoveries_no_truncate",
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      await database.pool.query(initial.slice(start, end));
      for (const migration of [
        "0731_ebay_listing_sync_verification_checkpoint.sql",
        "0732_ebay_listing_sync_identity_admission.sql",
        "0736_ebay_listing_mapping_repairs.sql",
        "0737_ebay_publication_completion.sql",
        "0741_ebay_durable_withdrawal.sql",
        "900000010000018170001_ebay_saved_publication_continuation.sql",
      ])
        await database.pool.query(
          await readFile("migrations/" + migration, "utf8"),
        );
      return new EbayListingSyncService(
        new PostgresEbayListingSyncRepository(database.pool),
        {
          execute: vi.fn(() => {
            throw new Error("Provider execution is outside admission test");
          }),
        },
        () => now,
        randomUUID,
      );
    }
    it("commits source edits and obligations together, and rolls both back", async () => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE catalog.products SET name='Discarded' WHERE id=20",
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await changes()).toEqual([]);
      await database.pool.query(
        "UPDATE catalog.products SET name='Current' WHERE id=20",
      );
      expect(await changes()).toHaveLength(1);
      await repository.expand(20, now);
      const rows = await deliveries();
      expect(rows).toHaveLength(4);
      expect(
        rows.find((row) => row.destination.channelId === 34).variant_ids,
      ).toEqual([101, 102]);
      expect(rows.every((row) => row.product_id === 20)).toBe(true);
    });
    it("records DELETE and both scopes of a moved price rule without touching another account", async () => {
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET scope_id='21',value=15 WHERE id=1",
      );
      await database.pool.query(
        "DELETE FROM channels.channel_pricing_rules WHERE id=1",
      );
      const rows = await changes();
      expect(rows[0].before_scope.scope_id).toBe("20");
      expect(rows[0].after_scope.scope_id).toBe("21");
      expect(rows[1].operation).toBe("DELETE");
      await repository.expand(20, now);
      const work = await deliveries();
      expect(work.map((row) => row.product_id).sort()).toEqual([20, 21, 21]);
      expect(work.every((row) => row.destination.channelId === 34)).toBe(true);
    });
    it("captures image bytes, order and inclusion without retaining bytes, and ignores token-only refresh", async () => {
      await database.pool.query(
        "UPDATE catalog.product_assets SET file_data=$1,position=3 WHERE id=1",
        [Buffer.from("private-image-bytes")],
      );
      await database.pool.query(
        "INSERT INTO channels.channel_asset_overrides VALUES(1,34,1,0,1)",
      );
      await database.pool.query(
        'UPDATE channels.channel_connections SET metadata=metadata||\'{"accessToken":"must-not-retain"}\'::jsonb WHERE id=4',
      );
      const rows = await changes();
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain("private-image-bytes");
      expect(JSON.stringify(rows)).not.toContain("must-not-retain");
      expect(rows[0].before_hash).not.toBe(rows[0].after_hash);
      await repository.expand(20, now);
      expect(
        (await deliveries())
          .filter((row) => row.change_id === rows[1].id)
          .map((row) => row.destination.channelId),
      ).toEqual([34]);
    });
    it("fans out bulk source changes once with concurrent expanders and isolates exact lease ownership", async () => {
      await database.pool.query(
        "UPDATE catalog.products SET price_cents=price_cents+1",
      );
      await Promise.all([
        repository.expand(20, now),
        repository.expand(20, now),
      ]);
      const rows = await deliveries();
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((row) => row.command_key)).size).toBe(
        rows.length,
      );
      const claims = await Promise.all([
        repository.claim(randomUUID(), now),
        repository.claim(randomUUID(), now),
      ]);
      expect(claims[0]?.id).not.toBe(claims[1]?.id);
      const claim = claims[0]!;
      await repository.finish(
        { ...claim, leaseToken: randomUUID() },
        { state: "blocked", code: "TEST", message: "Wrong lease" },
        now,
      );
      expect(
        (
          await database.pool.query(
            "SELECT state FROM marketplace.listing_intent_deliveries WHERE id=$1",
            [claim.id],
          )
        ).rows[0].state,
      ).toBe("pending");
    });
    it("reuses the same immutable handoff command after acknowledgement loss and records completion atomically", async () => {
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
      );
      let clock = now;
      const receipts = new Map<string, string>();
      const handoff = vi.fn(async (delivery: { commandKey: string }) => {
        const prior = receipts.get(delivery.commandKey);
        if (prior)
          return {
            state: "delivered" as const,
            receipt: {
              owner: "ebay_listing_sync" as const,
              operationId: prior,
              commandKey: delivery.commandKey,
            },
          };
        receipts.set(delivery.commandKey, "saved-job");
        throw new Error("Acknowledgement lost after durable admission");
      });
      const service = new ListingIntentPropagationService({
        store: repository,
        handoff: { handoff },
        now: () => clock,
        uuid: randomUUID,
      });
      expect(await service.processDue()).toEqual({ processed: 0, failed: 1 });
      clock = new Date(now.getTime() + 61_000);
      expect(await service.processDue()).toEqual({ processed: 1, failed: 0 });
      expect(receipts.size).toBe(1);
      expect(handoff.mock.calls[0][0].commandKey).toBe(
        handoff.mock.calls[1][0].commandKey,
      );
      const row = (await deliveries())[0];
      expect(row.state).toBe("delivered");
      expect(row.receipt.operationId).toBe("saved-job");
      await expect(
        database.pool.query(
          "UPDATE marketplace.listing_intent_deliveries SET receipt='{}' WHERE id=$1",
          [row.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        database.pool.query(
          "DELETE FROM marketplace.listing_intent_delivery_events",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("retains a pending obligation when audit insertion fails", async () => {
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
      );
      await repository.expand(20, now);
      const claim = (await repository.claim(randomUUID(), now))!;
      await database.pool
        .query(`CREATE FUNCTION marketplace.reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
   CREATE TRIGGER reject_test_event BEFORE INSERT ON marketplace.listing_intent_delivery_events FOR EACH ROW EXECUTE FUNCTION marketplace.reject_test_event();`);
      await expect(
        repository.finish(
          claim,
          {
            state: "delivered",
            receipt: {
              owner: "ebay_listing_sync",
              operationId: "saved-job",
              commandKey: claim.commandKey,
            },
          },
          now,
        ),
      ).rejects.toThrow("audit unavailable");
      expect((await deliveries())[0].state).toBe("pending");
      expect((await deliveries())[0].receipt).toBeNull();
    });
    it("records Dropship revision changes only for that managed vendor/store and checks member access", async () => {
      await database.pool.query(
        "INSERT INTO dropship.dropship_product_listing_settings VALUES(40,10,20,1)",
      );
      await repository.expand(20, now);
      const rows = await deliveries();
      expect(rows).toHaveLength(1);
      expect(rows[0].destination).toMatchObject({
        kind: "dropship",
        vendorId: 10,
        connectionId: 40,
        accountId: "vendor-seller",
      });
      expect(await repository.vendorForMemberStore("member-a", 40)).toBe(10);
      expect(await repository.vendorForMemberStore("member-b", 40)).toBeNull();
      expect(
        await repository.list({ vendorId: 11, storeConnectionId: 41 }),
      ).toEqual({ items: [], total: 0, limit: 100, offset: 0 });
    });
    it("retains old and new retail source scopes and does not create publications for unlisted products", async () => {
      await database.pool.query(
        "UPDATE public.shopify_variants SET sku='SKU-C',price=13 WHERE id='remote-a'",
      );
      await database.pool.query(
        "INSERT INTO catalog.products VALUES(90,'Never listed','sleeves','Sleeves',7,1000,NULL)",
      );
      await repository.expand(20, now);
      const work = await deliveries();
      expect(new Set(work.map((row) => row.product_id))).toEqual(
        new Set([20, 21]),
      );
      expect(work.some((row) => row.product_id === 90)).toBe(false);
    });
    it("composes real Dropship admission and receipt-first replay after lost acknowledgement without preparing changed source", async () => {
      const owner = await installDropshipJobs();
      await database.pool.query(
        "INSERT INTO dropship.dropship_product_listing_settings VALUES(40,10,20,1)",
      );
      await repository.expand(20, now);
      const claim = (await repository.claim(randomUUID(), now))!;
      const prepare = vi.fn(async (input: unknown) => {
        const key = (input as { idempotencyKey: string }).idempotencyKey;
        const prepared = preparedJob(key);
        await owner.createListingPushJob(prepared);
        throw new Error("Lost admission acknowledgement");
      });
      const ebay = {
        channelId: 34,
        service: { getByCommand: vi.fn(), getAdmission: vi.fn() },
        sync: vi.fn(),
      };
      const handoff = new ExistingListingIntentHandoff(
        database.pool,
        { createListingPushJob: prepare },
        ebay,
      );
      await expect(handoff.handoff(claim)).rejects.toThrow(
        "Lost admission acknowledgement",
      );
      // Receipt ownership remains the original account even after its source changes.
      await database.pool.query(
        "UPDATE dropship.dropship_store_connections SET external_account_id='new-account' WHERE id=40",
      );
      expect(await handoff.handoff(claim)).toMatchObject({
        state: "delivered",
        receipt: {
          owner: "dropship_listing_push",
          commandKey: claim.commandKey,
        },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM dropship.dropship_listing_push_jobs",
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        handoff.handoff({
          ...claim,
          destination: { ...claim.destination, accountId: "new-account" },
        }),
      ).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    });
    it("serializes concurrent real Dropship acceptance and refuses changed account or unmanaged sizes before insertion", async () => {
      const owner = await installDropshipJobs();
      const key = randomUUID();
      const [first, second] = await Promise.all([
        owner.createListingPushJob(preparedJob(key)),
        owner.createListingPushJob(preparedJob(key)),
      ]);
      expect(first.job.jobId).toBe(second.job.jobId);
      expect([first.idempotentReplay, second.idempotentReplay].sort()).toEqual([
        false,
        true,
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM dropship.dropship_listing_push_job_items",
          )
        ).rows[0].n,
      ).toBe(2);
      const wrong = preparedJob(randomUUID());
      wrong.managedIntentScope = {
        accountId: "another-account",
        environment: "production",
        managedOnly: true,
      };
      await expect(owner.createListingPushJob(wrong)).rejects.toMatchObject({
        code: "DROPSHIP_LISTING_ACCOUNT_CHANGED",
      });
      const unmanaged = preparedJob(randomUUID());
      unmanaged.productVariantIds = [101, 103];
      await expect(owner.createListingPushJob(unmanaged)).rejects.toMatchObject(
        { code: "DROPSHIP_LISTING_MANAGED_SCOPE_CHANGED" },
      );
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM dropship.dropship_listing_push_jobs",
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it("uses a new audited command only for explicit retry of definitive rejection, never for unresolved account", async () => {
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
      );
      await repository.expand(20, now);
      const claim = (await repository.claim(randomUUID(), now))!;
      await repository.finish(
        claim,
        {
          state: "blocked",
          code: "EBAY_POLICY_UNAVAILABLE",
          message: "Review policy",
        },
        now,
      );
      expect(
        await repository.retry({
          id: claim.id,
          channelId: 35,
          actor: "wrong-channel",
          now,
        }),
      ).toBe(false);
      expect(
        await repository.retry({
          id: claim.id,
          channelId: 34,
          actor: "admin:1",
          now,
        }),
      ).toBe(true);
      const fresh = (await repository.claim(randomUUID(), now))!;
      expect(fresh.commandKey).not.toBe(claim.commandKey);
      expect(fresh.destination).toEqual(claim.destination);
      await repository.finish(
        fresh,
        {
          state: "blocked",
          code: "LISTING_INTENT_ACCOUNT_UNRESOLVED",
          message: "Reconnect then review",
        },
        now,
      );
      expect(
        await repository.retry({
          id: claim.id,
          channelId: 34,
          actor: "admin:1",
          now,
        }),
      ).toBe(false);
    });
    it("captures a newly verified account as fresh review work without redirecting old blocked scope", async () => {
      await database.pool.query(
        "UPDATE ebay.ebay_oauth_tokens SET external_account_id=NULL,external_account_verified_at=NULL",
      );
      await repository.expand(20, now);
      const old = await repository.claim(randomUUID(), now);
      expect(old?.destination.accountId).toBeNull();
      await database.pool.query(
        "UPDATE ebay.ebay_oauth_tokens SET external_account_id='seller-b',external_account_verified_at=$1",
        [now],
      );
      await repository.expand(20, now);
      const all = await deliveries();
      expect(all.some((row) => row.destination.accountId === "seller-b")).toBe(
        true,
      );
      expect(
        all.find((row) => String(row.id) === old!.id)?.destination.accountId,
      ).toBeNull();
      expect(
        all
          .filter((row) => row.destination.accountId === "seller-b")
          .every((row) => row.destination.channelId === 34),
      ).toBe(true);
    });

    it("uses the real eBay admission receipt before changed source after acknowledgement loss and converges concurrent admission", async () => {
      const owner = await installEbayJobs();
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
      );
      await repository.expand(20, now);
      const claim = (await repository.claim(randomUUID(), now))!;
      const identity = {
        channelId: 34,
        connectionId: 4,
        productId: 20,
        accountId: "seller-a",
        marketplaceId: "EBAY_US",
        groupKey: "GROUP",
        variants: [
          {
            variantId: 101,
            sku: "SKU-A",
            externalSku: "SKU-A",
            offerId: "offer-a",
            listingId: "listing-a",
          },
          {
            variantId: 102,
            sku: "SKU-B",
            externalSku: "SKU-B",
            offerId: "offer-b",
            listingId: "listing-a",
          },
        ],
      };
      // The source read is deterministic here; admission, command serialization,
      // immutable job/events and receipt-first handoff all use production owners.
      let admitters = 0;
      let releaseAdmission!: () => void;
      const admissionBarrier = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const fresh = vi.fn(
        async (
          _filter: unknown,
          actor: string | undefined,
          key: string | undefined,
        ) => {
          admitters++;
          if (admitters === 2) releaseAdmission();
          await admissionBarrier;
          await owner.enqueue(identity, actor, key);
          throw new Error("eBay admission acknowledgement lost");
        },
      );
      const handoff = new ExistingListingIntentHandoff(
        database.pool,
        { createListingPushJob: vi.fn() },
        { channelId: 34, service: owner, sync: fresh },
      );
      await Promise.all([
        expect(handoff.handoff(claim)).rejects.toThrow("acknowledgement lost"),
        expect(handoff.handoff(claim)).rejects.toThrow("acknowledgement lost"),
      ]);
      await database.pool.query(
        "UPDATE catalog.products SET name='Renamed after admission' WHERE id=20",
      );
      const before = fresh.mock.calls.length;
      expect(await handoff.handoff(claim)).toMatchObject({
        state: "delivered",
        receipt: { owner: "ebay_listing_sync", commandKey: claim.commandKey },
      });
      expect(fresh).toHaveBeenCalledTimes(before);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM channels.ebay_listing_sync_jobs",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM channels.ebay_listing_sync_commands",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        await handoff.handoff({
          ...claim,
          destination: { ...claim.destination, accountId: "other-seller" },
        }),
      ).toMatchObject({
        state: "blocked",
        code: "LISTING_INTENT_RECEIPT_SCOPE_CONFLICT",
      });
    });
    it("makes permanent account changes actionable instead of repeatedly preparing or sending", async () => {
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
      );
      const handoff = vi.fn(async () => {
        throw Object.assign(new Error("Account changed"), {
          code: "EBAY_SYNC_IDENTITY_CHANGED",
        });
      });
      const service = new ListingIntentPropagationService({
        store: repository,
        handoff: { handoff },
        now: () => now,
        uuid: randomUUID,
      });
      expect(await service.processDue()).toEqual({ processed: 0, failed: 1 });
      expect(await service.processDue()).toEqual({ processed: 0, failed: 0 });
      expect(handoff).toHaveBeenCalledTimes(1);
      const page = await repository.list({ channelId: 34 });
      expect(page.items[0]).toMatchObject({
        state: "blocked",
        can_retry: false,
        last_error_code: "EBAY_SYNC_IDENTITY_CHANGED",
      });
    });
    it("returns validated attention-first pages so delivered rows cannot bury older blockers", async () => {
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
      );
      await repository.expand(20, now);
      const first = (await repository.claim(randomUUID(), now))!;
      await repository.finish(
        first,
        {
          state: "blocked",
          code: "EBAY_POLICY_UNAVAILABLE",
          message: "Choose an available shipping policy",
        },
        now,
      );
      await database.pool.query(
        "UPDATE channels.channel_pricing_rules SET value=13 WHERE id=1",
      );
      await repository.expand(20, now);
      const second = (await repository.claim(randomUUID(), now))!;
      await repository.finish(
        second,
        {
          state: "delivered",
          receipt: {
            owner: "ebay_listing_sync",
            operationId: "job",
            commandKey: second.commandKey,
          },
        },
        now,
      );
      const page = await repository.list({ channelId: 34 }, 1);
      expect(page).toMatchObject({ total: 2, limit: 1, offset: 0 });
      expect(page.items[0]).toMatchObject({
        id: first.id,
        state: "blocked",
        can_retry: true,
      });
      expect(
        (await repository.list({ channelId: 34 }, 1, 1)).items[0].state,
      ).toBe("delivered");
    });
    it("keeps a rejected Dropship preview blocked on receipt replay and its admission evidence immutable", async () => {
      const owner = await installDropshipJobs();
      await database.pool.query(
        "INSERT INTO dropship.dropship_product_listing_settings VALUES(40,10,20,1)",
      );
      await repository.expand(20, now);
      const claim = (await repository.claim(randomUUID(), now))!;
      const prepared = preparedJob(claim.commandKey);
      prepared.preview.summary = { total: 2, ready: 0, warning: 0, blocked: 2 };
      prepared.preview.rows = prepared.preview.rows.map((row) => ({
        ...row,
        previewStatus: "blocked",
        blockers: ["Choose an available shipping policy"],
      }));
      const accepted = await owner.createListingPushJob(prepared);
      expect(accepted.job.status).toBe("failed");
      const prepare = vi.fn();
      const handoff = new ExistingListingIntentHandoff(
        database.pool,
        { createListingPushJob: prepare },
        {
          channelId: 34,
          service: { getByCommand: vi.fn(), getAdmission: vi.fn() },
          sync: vi.fn(),
        },
      );
      expect(await handoff.handoff(claim)).toMatchObject({
        state: "blocked",
        code: "DROPSHIP_LISTING_PREVIEW_BLOCKED",
      });
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        database.pool.query(
          "UPDATE dropship.dropship_listing_push_jobs SET requested_scope='{}' WHERE id=$1",
          [accepted.job.jobId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("coalesces a bulk transaction per exact destination/product under concurrent expanders and preserves every source link", async () => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO dropship.dropship_listing_price_settings VALUES(40,10,101,1,1100,'override'),(40,10,102,2,1300,'override')",
        );
        await client.query(
          "INSERT INTO dropship.dropship_product_listing_settings VALUES(40,10,20,3)",
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await Promise.all([
        repository.expand(20, now),
        repository.expand(20, now),
      ]);
      const work = await deliveries();
      expect(work).toHaveLength(1);
      expect(work[0].variant_ids).toEqual([101, 102]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.listing_intent_delivery_sources",
          )
        ).rows[0].n,
      ).toBe(3);
      const claim = (await repository.claim(randomUUID(), now))!;
      expect(claim.changes).toHaveLength(3);
      const owner = await installDropshipJobs();
      const prepared = preparedJob(claim.commandKey);
      await owner.createListingPushJob(prepared);
      await owner.createListingPushJob(prepared);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM dropship.dropship_listing_push_jobs",
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        database.pool.query(
          "DELETE FROM marketplace.listing_intent_delivery_sources",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("applies the strongest linked review requirement instead of dispatching only the first change", async () => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE channels.channel_pricing_rules SET value=12 WHERE id=1",
        );
        await client.query(
          "UPDATE catalog.product_variants SET sku='RENAMED' WHERE id=101",
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const handoff = vi.fn();
      const service = new ListingIntentPropagationService({
        store: repository,
        handoff: { handoff },
        now: () => now,
        uuid: randomUUID,
      });
      await service.processDue();
      expect(handoff).not.toHaveBeenCalled();
      const page = await repository.list({ channelId: 34 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        state: "needs_review",
        can_retry: false,
      });
      expect(page.items[0].source_changes).toHaveLength(2);
    });
    it("does not claim a partially expanded transaction and resumes a bounded fanout page", async () => {
      await database.close();
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        base +
          `
        INSERT INTO catalog.products(id,name,product_type,category_id,price_cents)
          SELECT n,'Page product','page',7,1000 FROM generate_series(1000,1100)n;
        INSERT INTO catalog.product_variants(id,product_id,sku,name,price_cents)
          SELECT n,n,'PAGE-'||n,'Page size',1000 FROM generate_series(1000,1100)n;
        INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_product_id,external_variant_id)
          SELECT n,34,n,'LISTING-'||n,'OFFER-'||n FROM generate_series(1000,1100)n;
      `,
      );
      await database.pool.query(await readFile(migration, "utf8"));
      repository = new PostgresListingIntentPropagationRepository(
        database.pool,
      );
      await database.pool.query(
        "INSERT INTO channels.channel_pricing_rules VALUES(2,34,'category','page','fixed',10)",
      );
      expect(await repository.expand(1, now)).toBe(50);
      expect(await repository.claim(randomUUID(), now)).toBeNull();
      expect(await repository.expand(1, now)).toBe(50);
      expect(await repository.claim(randomUUID(), now)).toBeNull();
      expect(await repository.expand(1, now)).toBe(1);
      expect(await deliveries()).toHaveLength(101);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.listing_intent_delivery_sources",
          )
        ).rows[0].n,
      ).toBe(101);
      expect(await repository.claim(randomUUID(), now)).not.toBeNull();
    });
    it("preserves safe Dropship access explanation and resolution without endless automatic retries", async () => {
      await database.pool.query(
        "INSERT INTO dropship.dropship_product_listing_settings VALUES(40,10,20,1)",
      );
      const handoff = vi.fn(async () => {
        throw Object.assign(
          new Error(
            "Your store needs authorization again. Reconnect it on the Store page.",
          ),
          {
            code: "DROPSHIP_LISTING_STORE_BLOCKED",
            context: { resolution: "reconnect_store" },
          },
        );
      });
      const service = new ListingIntentPropagationService({
        store: repository,
        handoff: { handoff },
        now: () => now,
        uuid: randomUUID,
      });
      await service.processDue();
      await service.processDue();
      expect(handoff).toHaveBeenCalledTimes(1);
      const page = await repository.list({
        vendorId: 10,
        storeConnectionId: 40,
      });
      expect(page.items[0]).toMatchObject({
        state: "blocked",
        last_error_resolution: "reconnect_store",
        last_error_message:
          "Your store needs authorization again. Reconnect it on the Store page.",
        can_retry: true,
      });
      await expect(
        service.requestRetry({ id: page.items[0].id, actor: "no-scope" }),
      ).rejects.toThrow();
      expect(
        await service.requestRetry({
          id: page.items[0].id,
          vendorId: 10,
          storeConnectionId: 40,
          actor: "member:member-a",
        }),
      ).toBe(true);
    });
    it("ignores timestamp-only account re-verification but records revocation", async () => {
      await database.pool.query(
        "UPDATE ebay.ebay_oauth_tokens SET external_account_verified_at='2027-01-01T00:00:00Z'",
      );
      await database.pool.query(
        "UPDATE dropship.dropship_store_connections SET external_account_verified_at='2027-01-01T00:00:00Z'",
      );
      expect(await changes()).toHaveLength(0);
      await database.pool.query(
        "UPDATE ebay.ebay_oauth_tokens SET external_account_verified_at=NULL",
      );
      expect(await changes()).toHaveLength(1);
    });
  },
);
