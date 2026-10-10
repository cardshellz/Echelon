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
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
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
      timestamp = new Date("2026-10-09T12:00:00.000Z");
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
    function fixture() {
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
        group: (key, skus, work) =>
          admission.runListingGroup(
            scope(`group:${key}`),
            skus.map(scope),
            async () => {
              throw new Error("Legacy must not plan canonical quantities");
            },
            work,
          ),
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
      const prepare = vi.fn(async () => ({
        ...(await provider.prepare()),
        identity: structuredClone(identity),
        client,
      }));
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
  },
);
