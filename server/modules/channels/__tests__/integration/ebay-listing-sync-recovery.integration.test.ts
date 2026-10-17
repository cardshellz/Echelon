import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
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
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
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
        "0734_ebay_operator_republication_recovery.sql",
        "0736_ebay_listing_mapping_repairs.sql",
        "0737_ebay_publication_completion.sql",
        "0741_ebay_durable_withdrawal.sql",
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
    function fixture(options: { beforeGroup?: () => Promise<void>; photoUrls?: readonly string[] } = {}) {
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
      const scopes = [scope("group:PACK"), { ...scope("P5"), productId: 20, productVariantId: 101 }];
      const preview = await recovery.preview(scopes);
      const result = await recovery.resume({ scopes, previewHash: preview.previewHash, idempotencyKey: randomUUID(),
        actor: "operator", acknowledgeUnknownOutcome: true });
      expect(result.providerWriteAttempted).toBe(false);
      expect((await database.pool.query("SELECT state,completed_at,resolution_basis FROM inventory.quantity_publication_attempts WHERE id=ANY($1::bigint[])",
        [result.attemptIds])).rows).toEqual([{ state: "superseded_unknown", completed_at: null, resolution_basis: null }]);
      expect((await database.pool.query("SELECT scope->>'productVariantId' AS variant,reason FROM inventory.quantity_publication_catchup WHERE scope->>'externalScopeId'=$1 AND scope->>'externalInventoryItemId'='P5'",
        [identity.accountId])).rows).toEqual([{ variant: "101", reason: "ebay_operator_resume_unknown_outcome" }]);
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
        IF NEW.event='stage_completed' AND NEW.evidence->>'key'='offer:offer-101' THEN RAISE EXCEPTION 'injected stage audit failure'; END IF;RETURN NEW;END $$;
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
