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
import { PostgresChannelSyncBatchRepository } from "../../infrastructure/pg-channel-sync-batch.repository";
import {
  ChannelSyncBatchService,
  type ChannelSyncBatchAdapter,
} from "../../application/channel-sync-batch.service";
import {
  ChannelSyncAdmissionRefused,
  type SavedSyncBatch,
  type SyncCommandStatus,
  type SyncDestination,
} from "../../domain/channel-sync-batch";
import { PostgresEbayListingSyncRepository } from "../../../channels/infrastructure/ebay-listing-sync.repository";
import { EbayListingSyncService } from "../../../channels/ebay-listing-sync.service";
import { EbaySyncBatchAdapter } from "../../../channels/adapters/ebay/ebay-sync-batch.adapter";
import { admitEbayListingSyncProducts } from "../../../channels/ebay-listing-sync-admission";
import { syncIdentity } from "../../../channels/__tests__/fixtures/ebay-listing-sync.fixture";
vi.mock("../../../../db", () => ({ pool: {} }));
const configured =
  process.env.ECHELON_TEST_DATABASE_URL &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(configured ? describe : describe.skip).sequential(
  "shared sync batch owner with actual PostgreSQL constraints and channel indexes",
  () => {
    let db: InventoryCutoverTestDatabase,
      store: PostgresChannelSyncBatchRepository;
    let now: Date,
      sequence = 0,
      productIds: number[],
      destination: SyncDestination;
    const clock = () => new Date(now);
    const actor = "user:batch-test";
    beforeAll(async () => {
      db = await createInventoryCutoverTestDatabase(
        process.env.ECHELON_TEST_DATABASE_URL,
        true,
        cutoverCompositionBaseSql,
      );
      await installCutoverCompositionMigrations(db.pool);
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
        await db.pool.query(readFileSync(resolve("migrations", file), "utf8"));
      await db.pool.query(cutoverCompositionSeedSql);
      await db.pool.query(cutoverCompositionLegacyChannelSeedSql);
      await db.pool.query("CREATE SCHEMA IF NOT EXISTS marketplace");
      await db.pool.query(
        readFileSync(
          resolve("migrations/900000020000018810001_channel_sync_batches.sql"),
          "utf8",
        ),
      );
      store = new PostgresChannelSyncBatchRepository(db.pool);
    }, 60000);
    afterAll(async () => {
      await db?.close();
    });
    beforeEach(async () => {
      now = new Date(Date.parse("2026-10-21T12:00:00Z") + sequence++ * 60_000);
      productIds = [1000 + sequence * 2, 1001 + sequence * 2];
      await db.pool.query(
        "UPDATE marketplace.channel_sync_batches SET next_attempt_at='2100-01-01' WHERE admission_completed_at IS NULL",
      );
      for (const id of productIds) {
        await db.pool.query(
          "INSERT INTO catalog.products(id,sku) VALUES($1,$2)",
          [id, `SKU-${id}`],
        );
        await db.pool.query(
          "INSERT INTO catalog.product_variants(id,product_id,sku) VALUES($1,$2,$3)",
          [id + 10000, id, `SKU-${id}-P1`],
        );
      }
      destination = {
        channelId: 1,
        provider: "fixture-channel",
        connectionId: 1,
        accountId: "verified-account",
        environment: "production",
        marketplaceId: "EBAY_US",
      };
    });
    function saved(): SavedSyncBatch {
      return {
        id: randomUUID(),
        destination,
        actor,
        createdAt: now.toISOString(),
        admissionCompletedAt: null,
        admissionError: null,
        admissionRefusal: null,
        members: productIds.map((id) => ({
          productId: id,
          name: `Product ${id}`,
          sku: `SKU-${id}`,
          commandKey: randomUUID(),
        })),
      };
    }
    function fixture() {
      const receipts = new Map<string, SyncCommandStatus>();
      const adapter: ChannelSyncBatchAdapter = {
        select: vi.fn(async () => ({
          destination,
          products: saved().members.map(
            ({ commandKey, ...product }) => product,
          ),
        })),
        read: vi.fn(async (batch: SavedSyncBatch) =>
          batch.members.flatMap((member) =>
            receipts.has(member.commandKey)
              ? [receipts.get(member.commandKey)!]
              : [],
          ),
        ),
        admit: vi.fn(async (_batch, members) => {
          for (const member of members)
            receipts.set(member.commandKey, {
              commandKey: member.commandKey,
              operationId: randomUUID(),
              state: "queued",
              code: null,
              message: null,
              updatedAt: now.toISOString(),
              nextAttemptAt: now.toISOString(),
            });
        }),
      };
      const service = new ChannelSyncBatchService({
        store,
        adapter: () => adapter,
        now: clock,
        uuid: randomUUID,
      });
      return { adapter, service, receipts };
    }
    it("saves exact membership once under concurrent replay and rejects later membership changes", async () => {
      const a = saved(),
        b = { ...saved(), id: a.id };
      const results = await Promise.all([store.create(a), store.create(b)]);
      expect(results[0]).toEqual(results[1]);
      const original = (await store.get(a.id))!;
      expect(original.members).toHaveLength(2);
      expect([a.members, b.members]).toContainEqual(original.members);
      await expect(
        db.pool.query(
          "UPDATE marketplace.channel_sync_batch_members SET name='changed' WHERE batch_id=$1",
          [a.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.pool.query(
          "DELETE FROM marketplace.channel_sync_batches WHERE id=$1",
          [a.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.pool.query(
          "INSERT INTO marketplace.channel_sync_batch_members VALUES($1,20,$2,'late',NULL)",
          [a.id, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
    it("rolls back the entire selection on a foreign-key or duplicate-command failure", async () => {
      const a = saved();
      await expect(
        store.create({
          ...a,
          members: [a.members[0], { ...a.members[1], productId: 2147483647 }],
        }),
      ).rejects.toMatchObject({ code: "23503" });
      expect(await store.get(a.id)).toBeNull();
      const first = await store.create(saved());
      const next = saved();
      next.members[0].commandKey = first.members[0].commandKey;
      await expect(store.create(next)).rejects.toMatchObject({ code: "23505" });
      expect(await store.get(next.id)).toBeNull();
    });
    it("recovers a lost start acknowledgement without selecting again and refuses another actor or channel", async () => {
      const f = fixture(),
        key = randomUUID();
      const first = await f.service.start(1, actor, { commandKey: key });
      expect(await f.service.start(1, actor, { commandKey: key })).toEqual(
        first,
      );
      expect(f.adapter.select).toHaveBeenCalledTimes(1);
      expect(await f.service.get(1, key)).toEqual(first);
      await expect(f.service.get(2, key)).rejects.toMatchObject({
        code: "SYNC_BATCH_NOT_FOUND",
      });
      await expect(
        f.service.start(2, actor, { commandKey: key }),
      ).rejects.toMatchObject({ code: "SYNC_BATCH_REPLAY_CONFLICT" });
      await expect(
        f.service.start(1, "user:other", { commandKey: key }),
      ).rejects.toMatchObject({ code: "SYNC_BATCH_REPLAY_CONFLICT" });
    });
    it("continues only missing commands after partial handoff and a lost acknowledgement", async () => {
      const f = fixture(),
        start = await f.service.start(1, actor, { commandKey: randomUUID() });
      const admit = f.adapter.admit;
      f.adapter.admit = vi.fn(async (batch, members) => {
        await admit(batch, members.slice(0, 1));
        throw new Error("connection lost after commit");
      });
      expect(await f.service.processDue(1)).toEqual({
        processed: 0,
        failed: 1,
      });
      const firstId = f.receipts.get(start.items[0].commandKey)!.operationId;
      expect((await store.get(start.id))!.admissionCompletedAt).toBeNull();
      f.adapter.admit = vi.fn(admit);
      now = new Date(now.getTime() + 31_000);
      await f.service.processDue(1);
      expect(f.adapter.admit).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({ commandKey: start.items[1].commandKey }),
      ]);
      expect(f.receipts.get(start.items[0].commandKey)!.operationId).toBe(
        firstId,
      );
      expect((await store.get(start.id))!.admissionCompletedAt).not.toBeNull();
      expect((await f.service.list(1)).batches[0].counts).toMatchObject({
        finished: 0,
        queued: 2,
      });
    });
    it("claims once across concurrent workers and fences an expired worker", async () => {
      const batch = await store.create(saved());
      const tokens = [randomUUID(), randomUUID()];
      const claims = await Promise.all(
        tokens.map((token) => store.claim(token, now)),
      );
      const expiredToken = tokens[claims.findIndex(Boolean)];
      expect(claims.filter(Boolean)).toHaveLength(1);
      now = new Date(now.getTime() + 121_000);
      const token = randomUUID();
      expect((await store.claim(token, now))!.id).toBe(batch.id);
      expect(await store.finish(batch.id, expiredToken, now)).toBe(false);
      expect((await store.get(batch.id))!.admissionCompletedAt).toBeNull();
      await store.finish(batch.id, token, now);
      expect((await store.get(batch.id))!.admissionCompletedAt).toBe(
        now.toISOString(),
      );
    });
    it("uses current owner evidence after reload and keeps retries, verification, and missing receipts unfinished", async () => {
      const f = fixture(),
        started = await f.service.start(1, actor, { commandKey: randomUUID() });
      await f.service.processDue(1);
      for (const item of started.items)
        f.receipts.set(item.commandKey, {
          ...f.receipts.get(item.commandKey)!,
          state: "verifying",
        });
      expect((await f.service.list(1)).batches[0].counts).toMatchObject({
        finished: 0,
        verifying: 2,
      });
      f.receipts.delete(started.items[1].commandKey);
      expect((await f.service.list(1)).batches[0].state).toBe("unavailable");
      f.adapter.read = vi.fn(async () => {
        throw new Error("database read unavailable");
      });
      expect((await f.service.list(1)).batches[0].counts).toMatchObject({
        finished: 0,
        unavailable: 2,
      });
    });
    it("ends confirmed admission refusal without hiding accepted work or retrying a changed destination", async () => {
      const f = fixture(),
        started = await f.service.start(1, actor, { commandKey: randomUUID() });
      const admit = f.adapter.admit;
      f.adapter.admit = vi.fn(async (batch, members) => {
        await admit(batch, members.slice(0, 1));
        throw new ChannelSyncAdmissionRefused({
          code: "SYNC_DESTINATION_CHANGED",
          message: "Review the connection and request a new sync.",
        });
      });
      await f.service.processDue(1);
      const stored = (await store.get(started.id))!;
      expect(stored.admissionRefusal?.code).toBe("SYNC_DESTINATION_CHANGED");
      expect(stored.admissionCompletedAt).not.toBeNull();
      let progress = (await f.service.list(1)).batches[0];
      expect(progress.counts).toMatchObject({
        queued: 1,
        needsAttention: 1,
        finished: 1,
      });
      expect(progress.state).toBe("working");
      now = new Date(now.getTime() + 31_000);
      expect(await f.service.processDue(1)).toEqual({
        processed: 0,
        failed: 0,
      });
      const accepted = f.receipts.get(started.items[0].commandKey)!;
      f.receipts.set(accepted.commandKey, { ...accepted, state: "completed" });
      progress = (await f.service.list(1)).batches[0];
      expect(progress.state).toBe("needs_attention");
      expect(progress.counts).toMatchObject({
        completed: 1,
        needsAttention: 1,
        finished: 2,
      });
    });
    it("keeps real queued, running and uncertain eBay jobs unfinished after admission", async () => {
      const f = ebayFixture();
      const started = await f.service.start(1, actor, {
        commandKey: randomUUID(),
      });
      await f.service.processDue(1);
      const queued = (await f.service.list(1)).batches.find(
        (batch) => batch.id === started.id,
      )!;
      const claim = await f.repository.claim(
        now,
        randomUUID(),
        queued.items[0].operationId!,
      );
      expect(claim).not.toBeNull();
      try {
        expect((await f.service.list(1)).batches[0].counts).toMatchObject({
          running: 1,
          queued: 1,
          finished: 0,
        });
        await f.repository.finish(
          claim!.job,
          {
            state: "awaiting_evidence",
            code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN",
            message: "Checking the earlier response.",
            result: null,
            nextAttemptAt: new Date(now.getTime() + 30_000),
          },
          now,
        );
      } finally {
        await claim!.release();
      }
      expect((await f.service.list(1)).batches[0].counts).toMatchObject({
        verifying: 1,
        queued: 1,
        finished: 0,
      });
      expect((await f.service.list(1)).batches[0].state).toBe("working");
    });
    it("records empty selection without queueing provider work", async () => {
      const f = fixture();
      f.adapter.select = vi.fn(async () => ({ destination, products: [] }));
      const started = await f.service.start(1, actor, {
        commandKey: randomUUID(),
      });
      await f.service.processDue(1);
      expect(started.counts.total).toBe(0);
      expect(f.adapter.admit).not.toHaveBeenCalled();
      expect(
        (await store.get(started.id))!.admissionCompletedAt,
      ).not.toBeNull();
    });
    function ebayFixture() {
      destination = { ...destination, provider: "ebay" };
      const repository = new PostgresEbayListingSyncRepository(db.pool);
      const execution = new EbayListingSyncService(
        repository,
        {
          execute: async (_identity, stage) => {
            await stage("verification", "f".repeat(64), async () => {});
            return {
              synced: 1,
              errors: 0,
              priceChanges: 0,
              qtyChanges: 0,
              policyChanges: 0,
              pending: 0,
              jobs: [],
              details: [],
            };
          },
        },
        clock,
        randomUUID,
      );
      const identity = (id: number) => ({
        ...syncIdentity,
        productId: id,
        variants: [
          {
            ...syncIdentity.variants[0],
            variantId: id + 10000,
            sku: `SKU-${id}-P1`,
            offerId: `offer-${id}`,
            listingId: `listing-${id}`,
          },
        ],
      });
      const adapter = new EbaySyncBatchAdapter({
        channelId: 1,
        status: repository,
        select: async () => ({
          destination: {
            ...destination,
            environment: "production" as const,
            marketplaceId: "EBAY_US",
          },
          products: productIds.map((id) => ({
            productId: id,
            name: `Product ${id}`,
            sku: `SKU-${id}`,
          })),
        }),
        sync: async (filter, requestedBy, key, _destination, keys) =>
          admitEbayListingSyncProducts(
            (filter?.productIds ?? []).map((id) => ({
              productId: id,
              productName: `Product ${id}`,
              variants: identity(id).variants,
              captureIdentity: () => identity(id),
            })),
            {
              channelId: 1,
              actor: requestedBy!,
              commandKey: key,
              commandKeys: keys,
            },
            {
              findAcceptedCommand: (commandKey, _id, requester) =>
                repository.getByCommand(commandKey, 1, {
                  expectedActor: requester,
                  expectedOperation: "sync",
                }),
              enqueue: (source, requester, commandKey) =>
                repository.enqueue(source, commandKey, requester, clock()),
              recordFailure: (failure) =>
                execution.recordAdmissionFailure(failure),
              uuid: randomUUID,
            },
          ),
      });
      return {
        repository,
        execution,
        adapter,
        identity,
        service: new ChannelSyncBatchService({
          store,
          adapter: () => adapter,
          now: clock,
          uuid: randomUUID,
        }),
      };
    }
    it("tracks commands coalesced into existing jobs, and never substitutes a later same-product job", async () => {
      const f = ebayFixture();
      const existing = await f.repository.enqueue(
        f.identity(productIds[0]),
        randomUUID(),
        "another-owner",
        now,
      );
      const started = await f.service.start(1, actor, {
        commandKey: randomUUID(),
      });
      await f.service.processDue(1);
      let progress = (await f.service.list(1)).batches[0];
      expect(progress.items[0].operationId).toBe(existing.id);
      expect(progress.counts).toMatchObject({ queued: 2, finished: 0 });
      for (const item of progress.items)
        await f.execution.processDue(1, item.operationId!);
      progress = (await f.service.list(1)).batches[0];
      expect(progress.state).toBe("completed");
      expect(progress.counts.completed).toBe(2);
      now = new Date(now.getTime() + 1000);
      const later = await f.repository.enqueue(
        f.identity(productIds[0]),
        randomUUID(),
        actor,
        now,
      );
      expect(later.id).not.toBe(existing.id);
      expect((await f.service.list(1)).batches[0].items[0]).toMatchObject({
        operationId: existing.id,
        state: "completed",
      });
      expect((await store.get(started.id))!.members[0].commandKey).toBe(
        started.items[0].commandKey,
      );
      const indexes = (
        await db.pool.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname IN ('channels','marketplace')",
        )
      ).rows.map((row) => row.indexname);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "ebay_listing_sync_one_active",
          "channel_sync_batches_due",
          "channel_sync_batch_members_command_key_key",
        ]),
      );
    });
    it("reports durable admission refusal as attention and rejects a receipt for a different account", async () => {
      const f = ebayFixture(),
        batch = await store.create(saved());
      for (const member of batch.members)
        await f.execution.recordAdmissionFailure({
          channelId: 1,
          productId: member.productId,
          variantIds: [],
          actor,
          commandKey: member.commandKey,
          code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE",
          message: "Review inclusion.",
        });
      const progress = (await f.service.list(1)).batches.find(
        (row) => row.id === batch.id,
      )!;
      expect(progress.counts).toMatchObject({
        finished: 2,
        needsAttention: 2,
        completed: 0,
      });
      const other = await store.create(saved());
      for (const member of other.members)
        await f.repository.enqueue(
          { ...f.identity(member.productId), accountId: "different-seller" },
          member.commandKey,
          actor,
          now,
        );
      expect(
        (await f.service.list(1)).batches.find((row) => row.id === other.id)!
          .state,
      ).toBe("unavailable");
    });
  },
);
