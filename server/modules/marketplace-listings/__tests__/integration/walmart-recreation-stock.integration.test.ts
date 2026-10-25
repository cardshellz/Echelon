import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  listingDraftItemSchema,
  type ListingCatalogItem,
} from "@shared/types/channel-listing-publication";
import { createListingPublicationService } from "../../../../listing-publication.composition";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import {
  installWalmartPublicationInventoryFixture,
  activateWalmartPublicationInventoryFixture,
} from "../../../inventory-planning/__tests__/fixtures/walmart-publication-inventory.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-admission.fixture";
import {
  PostgresQuantityPublicationAdmission,
  attestQuantityPublicationAttemptInsideTransaction,
} from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { createAuthorityAwareInventoryPublicationService } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresVerifiedListingStockStore } from "../../../inventory-planning/infrastructure/verified-listing-stock.repository";
import { VerifiedListingStockService } from "../../../inventory-planning/application/verified-listing-stock.service";
import { PostgresInventoryPublicationOutboxRepository } from "../../../inventory-planning/infrastructure/inventory-publication-outbox.repository";
import { InventoryPublicationOutboxService } from "../../../inventory-planning/application/inventory-publication-outbox.service";
import { InventoryPublicationNotSentError } from "../../../inventory-planning/application/inventory-publication-transport";
import { PostgresInventoryPublicationSupplyReader } from "../../../inventory-planning/infrastructure/inventory-publication-supply-read.repository";
import { ChannelInventoryPublicationTransportAdapter } from "../../../channels/channel-inventory-publication-transport.adapter";
import { ChannelListingCatalogRepository } from "../../../channels/channel-listing-catalog.repository";
import { PostgresChannelCatalogRepository } from "../../../channels/channel-catalog.repository";
import { ChannelCatalogService } from "../../../channels/channel-catalog.service";
import { WalmartListingProvider } from "../../../channels/adapters/walmart/walmart-listing.provider";
import { WalmartListingApi } from "../../../channels/adapters/walmart/walmart-listing-api";
import { WalmartClient } from "../../../channels/adapters/walmart/walmart-client";
import { WalmartUsApi } from "../../../channels/adapters/walmart/walmart-us-api";
import { WalmartAdapter } from "../../../channels/adapters/walmart/walmart.adapter";
import { WalmartChannelService } from "../../../channels/adapters/walmart/walmart-channel.service";
import { PostgresListingPublicationRepository } from "../../infrastructure/pg-listing-publication.repository";
import { PostgresListingLifecycleRepository } from "../../infrastructure/pg-listing-lifecycle.repository";
import { listingHash } from "../../domain/listing-publication";
import { ListingSubmissionError } from "../../application/listing-publication-provider.port";
import {
  publicationSnapshot,
  publicationProgress,
} from "../fixtures/listing-publication.fixture";
import createSchema from "../../../channels/__tests__/fixtures/walmart-listing-sleeves.schema.json";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const productType = "Trading Card Sleeves & Holders";

// Real production composition, listing/identity stores, migrations, quantity
// admission, ATP planning and outbox. Only catalog projection and Walmart HTTP
// are fixtures. No production account, credentials or database is contacted.
dbDescribe.sequential(
  "Walmart recreation through current stock readback",
  () => {
    let database: InventoryCutoverTestDatabase;
    let h: Awaited<ReturnType<typeof harness>>;
    async function initialize(seedPriorStock = true) {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        cutoverCompositionBaseSql,
      );
      await installWalmartPublicationInventoryFixture(database.pool, {
        includeWalmartMapping: false,
        includeQuantityRecoveryMigrations: true,
      });
      await activateWalmartPublicationInventoryFixture(database.pool);
      await installCutoverAdmissionFixturePrerequisites(database.pool);
      await database.pool.query(
        readFileSync(
          resolve("migrations/236_inventory_cutover_admission.sql"),
          "utf8",
        ),
      );
      await database.pool.query(
        readFileSync(
          resolve("migrations/0721_inventory_publication_direct_enable.sql"),
          "utf8",
        ),
      );
      // The Catalog projection is a fixture, but submit still uses the real
      // transactional media-reference owner and its production migration.
      await database.pool.query(`CREATE TABLE catalog.product_assets (
        id integer PRIMARY KEY, product_id integer NOT NULL, product_variant_id integer,
        asset_type text NOT NULL, url text, position integer NOT NULL DEFAULT 0,
        is_primary integer NOT NULL DEFAULT 0, storage_type text NOT NULL,
        mime_type text, file_data bytea
      );`);
      for (const file of [
        "0707_channel_listing_publication.sql",
        "0724_channel_listing_updates.sql",
        "259_channel_listing_lifecycle.sql",
        "260_channel_listing_recreation.sql",
        "900000017000018580001_catalog_publication_media_versions.sql",
      ])
        await database.pool.query(
          readFileSync(resolve("migrations", file), "utf8"),
        );
      await database.pool
        .query(`ALTER TABLE channels.channel_feeds ADD COLUMN channel_type text DEFAULT 'walmart',
      ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz,
      ADD CONSTRAINT recreation_fixture_feed_unique UNIQUE(channel_id,product_variant_id);
      UPDATE channels.channel_feeds SET channel_product_id='WPID-OLD',channel_variant_id=channel_sku;
      ALTER TABLE channels.channel_listings ADD COLUMN last_synced_at timestamptz, ADD COLUMN created_at timestamptz,
        ADD COLUMN updated_at timestamptz, ADD CONSTRAINT recreation_fixture_listing_unique UNIQUE(channel_id,product_variant_id);
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_product_id,external_variant_id,external_sku)
        VALUES(36,101,'WPID-OLD','P5','P5');`);
      h = await harness(seedPriorStock);
    }
    beforeEach(() => initialize(), 30_000);
    afterEach(async () => {
      vi.restoreAllMocks();
      await database?.close();
    });

    async function harness(seedPriorStock: boolean) {
      let clock = new Date();
      let admissionClockOffsetMs = 0;
      const remote = {
        deleted: false,
        feedReady: false,
        published: true,
        productId: "WPID-OLD",
        quantity: 0,
        drift: false,
        rejectFeed: false,
        loseFeedResponse: false,
        loseStockResponse: false,
        feedCalls: 0,
        inventoryWrites: [] as number[],
        feedPayloads: [] as unknown[],
      };
      const client = new WalmartClient(
        {
          clientId: "fixture",
          clientSecret: "fixture",
          market: "us",
          environment: "production",
        },
        {
          now: () => clock,
          correlationId: randomUUID,
          fetch: async (input, options) => {
            const endpoint = new URL(String(input));
            if (endpoint.pathname === "/v3/token")
              return Response.json({
                access_token: "fixture-token",
                expires_in: 3600,
              });
            if (endpoint.pathname === "/v3/items/spec")
              return Response.json({ schema: createSchema });
            if (
              endpoint.pathname === "/v3/feeds" &&
              options?.method === "POST"
            ) {
              expect(endpoint.searchParams.get("feedType")).toBe("MP_ITEM");
              const file = (options.body as FormData).get("file") as Blob;
              const payload = JSON.parse(await file.text());
              expect(payload.MPItem[0].Orderable.inventory).toEqual([
                {
                  quantity: expect.any(Number),
                  fulfillmentCenterID: "test-location",
                },
              ]);
              expect(payload.MPItem[0].Visible[productType].mainImageUrl).toBe(
                "https://example.com/current-photo.jpg",
              );
              remote.feedPayloads.push(payload);
              remote.feedCalls++;
              if (remote.loseFeedResponse)
                throw new Error(
                  "simulated socket loss after provider acceptance",
                );
              if (remote.rejectFeed)
                return Response.json(
                  {
                    error: [
                      {
                        code: "INVALID_REQUEST",
                        category: "DATA",
                        description: "Fixture rejected",
                      },
                    ],
                  },
                  { status: 400 },
                );
              remote.quantity =
                payload.MPItem[0].Orderable.inventory[0].quantity;
              return Response.json({ feedId: `feed-${remote.feedCalls}` });
            }
            if (endpoint.pathname.startsWith("/v3/feeds/"))
              return Response.json({
                feedId: endpoint.pathname.split("/").at(-1),
                feedStatus: remote.feedReady ? "PROCESSED" : "INPROGRESS",
                itemsReceived: 1,
                itemDetails: {
                  itemIngestionStatus: [
                    {
                      sku: "P5",
                      ingestionStatus: remote.feedReady
                        ? "SUCCESS"
                        : "INPROGRESS",
                      wpid: remote.feedReady ? remote.productId : null,
                    },
                  ],
                },
              });
            if (endpoint.pathname === "/v3/items/P5") {
              if (remote.deleted)
                return Response.json(
                  {
                    errors: [
                      {
                        code: "ITEM_NOT_FOUND",
                        description: "Fixture missing",
                      },
                    ],
                  },
                  { status: 404 },
                );
              return Response.json({
                ItemResponse: [
                  {
                    sku: "P5",
                    mart: "WALMART_US",
                    wpid: remote.productId,
                    productName: "Current sleeves",
                    lifecycleStatus: "ACTIVE",
                    publishedStatus: remote.published
                      ? "PUBLISHED"
                      : "UNPUBLISHED",
                    price: { currency: "USD", amount: "12.99" },
                  },
                ],
              });
            }
            if (endpoint.pathname === "/v3/inventory") {
              expect(endpoint.searchParams.get("sku")).toBe("P5");
              expect(endpoint.searchParams.get("shipNode")).toBe(
                "test-location",
              );
              if (options?.method === "PUT") {
                remote.quantity = JSON.parse(
                  String(options.body),
                ).quantity.amount;
                remote.inventoryWrites.push(remote.quantity);
                if (remote.loseStockResponse)
                  throw new Error(
                    "simulated quantity acknowledgement lost after terminal provider write",
                  );
              }
              return Response.json({
                sku: "P5",
                quantity: {
                  unit: "EACH",
                  amount:
                    remote.drift && options?.method === "GET"
                      ? 0
                      : remote.quantity,
                },
              });
            }
            throw new Error(
              `Unexpected fixture HTTP ${options?.method} ${endpoint.pathname}`,
            );
          },
        },
      );
      const api = new WalmartUsApi(client),
        listingApi = new WalmartListingApi(client);
      const lifecycle = new PostgresListingLifecycleRepository(database.pool);
      const channels = {
        policy: { listingWrites: lifecycle },
        now: () => new Date(),
        observeListingPresence:
          WalmartChannelService.prototype.observeListingPresence,
        assertListingNotStopped: lifecycle.assertNotStopped.bind(lifecycle),
        withStockWrites: WalmartChannelService.prototype.withStockWrites,
        connection: async () => ({
          channel_id: 36,
          connection_id: 8,
          ship_node_id: "test-location",
          warehouse_id: 1,
          partner_id: "partner-36",
          revision: 1,
          environment: "production",
        }),
        requireRuntime: () => {},
        api: () => api,
        listingApi: () => listingApi,
        withListingWrites: lifecycle.withAllowed.bind(lifecycle),
        repository: {
          inventoryMappings: async () => [
            { product_variant_id: 101, channel_sku: "P5" },
          ],
          assertWarehouse: async () => {},
          withLock: async <T>(_channel: number, work: () => Promise<T>) =>
            work(),
        },
      } as unknown as WalmartChannelService;
      const provider = new WalmartListingProvider(channels),
        account = await provider.account(36);
      const identities = new ChannelCatalogService(
        new PostgresChannelCatalogRepository(database.pool),
        {
          account: async () => account,
          list: async () => {
            throw new Error("Unexpected catalog census");
          },
          item: async (_account, sku) =>
            (await provider.observe(account, sku)).item,
        },
        () => new Date(),
      );
      const catalog: ListingCatalogItem = {
        ...publicationSnapshot([101]).catalog[0],
        sku: "P5",
        productId: 20,
        productType,
        title: "Current sleeves, 100 count",
        description: "Protective clear sleeves for trading cards",
        brand: "Fixture brand",
        alreadyLinked: true,
        images: ["https://example.com/current-photo.jpg"],
        identifier: { type: "UPC", value: "036000291452" },
      };
      vi.spyOn(
        ChannelListingCatalogRepository.prototype,
        "catalog",
      ).mockResolvedValue({ items: [catalog], total: 1, offset: 0, limit: 25 });
      const admission = new PostgresQuantityPublicationAdmission(
        database.pool,
        () => new Date(Date.now() + admissionClockOffsetMs),
      );
      const stock = new VerifiedListingStockService(
        new PostgresVerifiedListingStockStore(database.pool),
      );
      const buildService = () =>
        createListingPublicationService({
          pool: database.pool,
          walmart: channels,
          channelCatalog: { forChannel: async () => identities },
          quantityAdmission: admission,
          verifiedStock: stock,
        });
      const store = new PostgresListingPublicationRepository(database.pool);
      const transport = new ChannelInventoryPublicationTransportAdapter(
        new WalmartAdapter(
          channels,
          new PostgresInventoryPublicationSupplyReader(database.pool),
        ),
      );
      const worker = new InventoryPublicationOutboxService(
        new PostgresInventoryPublicationOutboxRepository(database.pool),
        { get: () => transport },
        { now: () => clock },
        randomUUID,
        admission,
      );
      const stockInput = (externalProductId: string) => ({
        channelId: 36,
        connectionId: 8,
        accountId: "partner-36",
        environment: "production",
        externalScopeId: "test-location",
        productVariantId: 101,
        sku: "P5",
        externalProductId,
        lifecycleStatus: "ACTIVE",
        publishedStatus: "PUBLISHED",
        observedAt: new Date().toISOString(),
      });
      const publishStock = async () => {
        const due = (
          await database.pool.query(
            `SELECT max(available_at) AS due FROM inventory.inventory_publication_outbox WHERE publication_target_id=2`,
          )
        ).rows[0].due;
        clock = new Date(Math.max(Date.now(), due.getTime()) + 100);
        return worker.processDue();
      };
      // Most cases start with a real verified ATP command. A legacy listing may
      // have a channel link without ever having connected its stock mapping.
      if (seedPriorStock) {
        await stock.connect(stockInput("WPID-OLD"));
        const initialStock = await publishStock();
        expect(
          initialStock,
          JSON.stringify(
            (
              await database.pool.query(
                "SELECT last_error_class,last_error_message FROM inventory.inventory_publication_outbox",
              )
            ).rows,
          ),
        ).toMatchObject({ verified: 1 });
      }
      remote.deleted = true;
      remote.published = false;
      remote.productId = "WPID-NEW";
      remote.quantity = 0; // Simulated remote deletion, never a database quantity adjustment.
      const prior = publicationSnapshot([101], account, randomUUID(), 1);
      prior.catalog = [catalog];
      prior.draft.items[0] = listingDraftItemSchema.parse({
        variantId: 101,
        productType,
        attributes: {
          Orderable: {
            ShippingWeight: 0.1,
            country_of_origin_substantial_transformation: "United States",
          },
          Visible: {
            condition: "New",
            keyFeatures: [
              "Clear protection",
              "One hundred per pack",
              "Standard trading cards",
            ],
            countPerPack: 100,
            multipackQuantity: 1,
            isProp65WarningRequired: "No",
            has_written_warranty: "No",
            netContent: {
              productNetContentUnit: "Each",
              productNetContentMeasure: 100,
            },
            pieceCount: 100,
          },
        },
      });
      prior.prepared[0].sku = "P5";
      prior.review.items[0].sku = "P5";
      const now = new Date();
      prior.review.createdAt = now.toISOString();
      prior.review.expiresAt = new Date(now.getTime() + 900_000).toISOString();
      prior.draft = await store.saveDraft(
        account,
        { ...prior.draft, revision: 0 },
        "fixture-history",
        now,
      );
      prior.review.draftRevision = prior.draft.revision;
      await store.saveReview(prior, "fixture-history", now);
      const oldOperation = await store.createOperation({
        id: randomUUID(),
        snapshot: prior,
        progress: publicationProgress(prior),
        commandKey: randomUUID(),
        requestHash: listingHash(prior),
        actor: "fixture-history",
        now,
      });
      const claimed = (await store.claim(new Date(), randomUUID()))!;
      const oldProgress = structuredClone(claimed.progress);
      oldProgress.batches[0].state = "processed";
      oldProgress.batches[0].submissionId = "historical-feed";
      Object.assign(oldProgress.items[0], {
        state: "verified",
        externalProductId: "WPID-OLD",
        stockState: seedPriorStock ? "ready" : "setup_required",
      });
      await store.saveProgress(claimed, oldProgress, {
        now: new Date(),
        nextAttemptAt: new Date(),
        releaseLease: true,
        actor: "fixture-history",
      });
      const review = async (sourceOperationId = oldOperation.id) => {
        const service = buildService();
        const context = await service.recreation(36, {
          operationId: sourceOperationId,
          sku: "P5",
        });
        const currentDraft = await store.draft(36);
        const draft = await service.saveDraft(
          36,
          { expectedRevision: currentDraft.revision, items: [context.item] },
          "operator",
        );
        return service.review(
          36,
          { expectedRevision: draft.revision, variantIds: [101] },
          "operator",
        );
      };
      const queue = async (sourceOperationId = oldOperation.id) => {
        const reviewed = await review(sourceOperationId);
        expect(reviewed.issues).toEqual([]);
        expect(reviewed.canSubmit).toBe(true);
        const command = {
          reviewId: reviewed.id,
          reviewHash: reviewed.reviewHash,
          commandKey: randomUUID(),
        };
        const operation = await buildService().submit(36, command, "operator");
        return { operation, command, reviewed };
      };
      const runListing = async () => {
        await database.pool.query(
          `UPDATE marketplace.channel_listing_operations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state IN ('queued','processing','needs_reconciliation') AND lease_token IS NULL`,
        );
        return buildService().processDue(); // Fresh instance models process restarts.
      };
      const outboxes = async () =>
        (
          await database.pool
            .query(`SELECT id::text,state,desired_quantity::text,desired_revision::text
      FROM inventory.inventory_publication_outbox WHERE publication_target_id=2 ORDER BY desired_revision`)
        ).rows;
      return {
        channels,
        lifecycle,
        account,
        remote,
        review,
        queue,
        runListing,
        publishStock,
        outboxes,
        buildService,
        store,
        stock,
        stockInput,
        admission,
        oldOperation,
        elapseProviderCooldown: async () => {
          const { rows } = await database.pool.query<{ retry_at: Date }>(
            "SELECT max(retry_not_before) AS retry_at FROM inventory.quantity_publication_cooldowns",
          );
          admissionClockOffsetMs =
            Math.max(0, rows[0].retry_at.getTime() - Date.now()) + 100;
          clock = new Date(Date.now() + admissionClockOffsetMs);
        },
      };
    }

    it.each(["WPID-NEW", "WPID-OLD"])(
      "recreates and verifies unchanged ATP with provider identity %s, preserving the original history",
      async (productId) => {
        const before = await h.outboxes();
        const targetBefore = (
          await database.pool.query(
            "SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=2",
          )
        ).rows[0];
        h.remote.productId = productId;
        const { operation, command } = await h.queue();
        expect(
          (await h.buildService().submit(36, command, "operator")).id,
        ).toBe(operation.id);
        const accepted = await h.store.operation(36, operation.id);
        const mediaPlan = accepted.snapshot.prepared[0].preparedIntent?.input.mediaPlan;
        expect(mediaPlan?.variants[0].gallery.selected.map((photo) => photo.url)).toEqual([
          "https://example.com/current-photo.jpg",
        ]);
        // Command replay retains one reference to the exact reviewed plan.
        expect((await database.pool.query(
          `SELECT owner, reference_key, source_revision, kind, retired_at
           FROM catalog.publication_media_references ORDER BY reference_key`,
        )).rows).toEqual([{
          owner: "marketplace-listings",
          reference_key: `publication:${operation.id}:101`,
          source_revision: mediaPlan?.sourceRevision,
          kind: "pending",
          retired_at: null,
        }]);
        // This fixture uses an external URL, so there are no uploaded bytes to pin.
        expect((await database.pool.query(
          "SELECT * FROM catalog.publication_media_version_pins",
        )).rows).toEqual([]);
        await Promise.all([h.runListing(), h.runListing()]);
        expect(
          (await h.store.operation(36, operation.id)).progress.error,
        ).toBeNull();
        expect(
          (await h.store.operation(36, operation.id)).progress.items[0].error,
        ).toBeNull();
        expect(h.remote.feedCalls).toBe(1);
        expect(h.remote.feedPayloads[0]).toMatchObject({
          MPItem: [
            {
              Orderable: {
                inventory: [
                  { quantity: 17, fulfillmentCenterID: "test-location" },
                ],
              },
            },
          ],
        });
        expect(h.remote.inventoryWrites).toEqual([17]);
        expect(
          (await h.store.operation(36, operation.id)).progress.items[0].state,
        ).toBe("processing");
        h.remote.feedReady = true;
        h.remote.deleted = false;
        await h.runListing();
        expect(
          (await h.store.operation(36, operation.id)).progress.items[0],
        ).toMatchObject({ state: "accepted", stockState: "setup_required" });
        expect(h.remote.inventoryWrites).toEqual([17]);
        h.remote.published = true;
        await h.runListing();
        expect(
          (await h.store.operation(36, operation.id)).progress.items[0],
        ).toMatchObject({ state: "accepted", stockState: "queued" });
        expect(await h.outboxes()).toEqual([
          before[0],
          expect.objectContaining({
            state: "queued",
            desired_quantity: "17",
            desired_revision: "2",
          }),
        ]);
        await h.runListing();
        expect(await h.outboxes()).toHaveLength(2);
        expect(h.remote.feedCalls).toBe(1);
        expect(await h.publishStock()).toMatchObject({
          verified: 1,
          failed: 0,
        });
        await h.runListing();
        expect(
          (await h.store.operation(36, operation.id)).progress.items[0],
        ).toMatchObject({ state: "verified", stockState: "ready" });
        expect(h.remote.inventoryWrites).toEqual([17, 17]);
        expect(
          (
            await database.pool.query(
              "SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=2",
            )
          ).rows[0],
        ).toEqual(targetBefore);
        expect(
          (await h.store.operation(36, h.oldOperation.id)).progress.items[0],
        ).toMatchObject({
          state: "superseded",
          recreatedByOperationId: operation.id,
        });
        expect(
          (
            await database.pool.query(
              "SELECT external_product_id FROM inventory.publication_listing_recreation_stock_receipts",
            )
          ).rows,
        ).toEqual([{ external_product_id: productId }]);
        expect(
          (
            await database.pool.query(
              "SELECT channel_product_id FROM channels.channel_feeds WHERE channel_id=36",
            )
          ).rows,
        ).toEqual([{ channel_product_id: productId }]);
        await database.pool.query(
          "UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=10",
        );
        const publisher = createAuthorityAwareInventoryPublicationService(
          database.pool,
          { channelId: 36 },
        );
        await publisher.publishProduct(
          {
            productId: 20,
            publicationTargetId: 2,
            dryRun: false,
            triggeredBy: "fixture_stock_change",
          },
          async () => {
            throw new Error("Must use canonical ATP");
          },
        );
        expect(await h.publishStock()).toMatchObject({ verified: 1 });
        expect(h.remote.inventoryWrites).toEqual([17, 17, 9]);
        expect(h.remote.feedCalls).toBe(1);
      },
    );

    async function acceptedRecreation() {
      const queued = await h.queue();
      await h.runListing();
      h.remote.feedReady = true;
      h.remote.deleted = false;
      h.remote.published = true;
      return queued;
    }
    it("detects deletion of a completed listing, keeps its ATP identity, and recreates it with freshly calculated initial stock", async () => {
      const mappingBefore = (
        await database.pool.query(
          "SELECT * FROM inventory.publication_listing_recreation_stock_receipts",
        )
      ).rows;
      expect(
        await h.channels.observeListingPresence(h.account, "P5"),
      ).toMatchObject({ state: "missing" });
      const write = vi.fn(async () => {});
      await expect(
        h.channels.withStockWrites(h.account, "P5", 17, write),
      ).rejects.toMatchObject({ code: "LISTING_MISSING_ON_PROVIDER" });
      expect(write).not.toHaveBeenCalled();
      const { operation } = await h.queue();
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=10",
      );
      await h.runListing();
      expect(h.remote.feedPayloads).toHaveLength(1);
      expect(h.remote.feedPayloads[0]).toMatchObject({
        MPItem: [
          {
            Orderable: {
              inventory: [
                { quantity: 9, fulfillmentCenterID: "test-location" },
              ],
            },
          },
        ],
      });
      const attempt = (
        await database.pool.query(
          "SELECT id,listing_setup_intent FROM inventory.quantity_publication_attempts WHERE listing_setup_intent IS NOT NULL",
        )
      ).rows[0];
      expect(attempt.listing_setup_intent.items).toEqual([
        expect.objectContaining({ sku: "P5", quantity: 9 }),
      ]);
      await expect(
        database.pool.query(
          "UPDATE inventory.quantity_publication_attempts SET listing_setup_intent='{}' WHERE id=$1",
          [attempt.id],
        ),
      ).rejects.toThrow(/immutable/);
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.publication_listing_recreation_stock_receipts",
          )
        ).rows,
      ).toEqual(mappingBefore);
      // A normal refresh during processing cannot remove the missing marker.
      expect(
        await h.channels.observeListingPresence(h.account, "P5"),
      ).toBeNull();
      h.remote.deleted = false;
      h.remote.published = true;
      h.remote.feedReady = true;
      await h.runListing();
      expect((await h.lifecycle.presence(h.account, ["P5"]))[0].state).toBe(
        "present",
      );
      expect((await h.outboxes()).at(-1)).toMatchObject({
        state: "queued",
        desired_quantity: "9",
      });
      await h.publishStock();
      await h.runListing();
      expect((await h.store.operation(36, operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.inventoryWrites).toEqual([17, 9]);
    });
    it("does not turn a queued stock update blocked by deletion into uncertainty that prevents recreation", async () => {
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=10",
      );
      const publisher = createAuthorityAwareInventoryPublicationService(
        database.pool,
        { channelId: 36 },
      );
      await publisher.publishProduct(
        {
          productId: 20,
          publicationTargetId: 2,
          dryRun: false,
          triggeredBy: "fixture_stock_change",
        },
        async () => {
          throw new Error("Must use canonical ATP");
        },
      );
      expect((await h.outboxes()).at(-1)).toMatchObject({
        state: "queued",
        desired_quantity: "9",
      });
      expect(
        await h.channels.observeListingPresence(h.account, "P5"),
      ).toMatchObject({ state: "missing" });
      expect(await h.publishStock()).toMatchObject({ verified: 0, failed: 1 });
      expect(h.remote.inventoryWrites).toEqual([17]);
      const blocked = (
        await database.pool
          .query(`SELECT id,state,error_code FROM inventory.quantity_publication_attempts
        WHERE owner_kind='outbox' ORDER BY id DESC LIMIT 1`)
      ).rows[0];
      expect(blocked).toMatchObject({
        state: "not_sent",
        error_code: "LISTING_MISSING_ON_PROVIDER",
      });
      expect(
        (
          await database.pool.query(
            "SELECT id FROM inventory.quantity_provider_requests WHERE attempt_id=$1",
            [blocked.id],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        database.pool.query(
          "UPDATE inventory.quantity_publication_attempts SET state='succeeded' WHERE id=$1",
          [blocked.id],
        ),
      ).rejects.toThrow(/immutable/);
      const { operation } = await acceptedRecreation();
      await h.runListing();
      expect(h.remote.feedPayloads[0]).toMatchObject({
        MPItem: [{ Orderable: { inventory: [{ quantity: 9 }] } }],
      });
      expect(await h.publishStock()).toMatchObject({ verified: 1 });
      await h.runListing();
      expect((await h.store.operation(36, operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.inventoryWrites).toEqual([17, 9]);
    });
    it("does not trust a not-sent transport label when durable evidence proves a stock request started", async () => {
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=10",
      );
      const publisher = createAuthorityAwareInventoryPublicationService(
        database.pool,
        { channelId: 36 },
      );
      await publisher.publishProduct(
        {
          productId: 20,
          publicationTargetId: 2,
          dryRun: false,
          triggeredBy: "fixture_stock_change",
        },
        async () => {
          throw new Error("Must use canonical ATP");
        },
      );
      const publish =
        ChannelInventoryPublicationTransportAdapter.prototype.publishAbsolute;
      vi.spyOn(
        ChannelInventoryPublicationTransportAdapter.prototype,
        "publishAbsolute",
      ).mockImplementation(async function (
        this: ChannelInventoryPublicationTransportAdapter,
        request,
      ) {
        await publish.call(this, request);
        throw new InventoryPublicationNotSentError(
          "FIXTURE_MISCLASSIFIED",
          "Injected incorrect preflight label after HTTP",
          false,
        );
      });
      expect(await h.publishStock()).toMatchObject({ verified: 0, failed: 1 });
      expect(h.remote.inventoryWrites).toEqual([17, 9]);
      const attempt = (
        await database.pool.query(
          "SELECT id,state FROM inventory.quantity_publication_attempts WHERE owner_kind='outbox' ORDER BY id DESC LIMIT 1",
        )
      ).rows[0];
      expect(attempt.state).toBe("uncertain");
      expect(
        (
          await database.pool.query(
            "SELECT id FROM inventory.quantity_provider_requests WHERE attempt_id=$1",
            [attempt.id],
          )
        ).rows,
      ).toHaveLength(1);
      await expect(
        database.pool.query(
          "UPDATE inventory.quantity_publication_attempts SET state='not_sent',completed_at=clock_timestamp(),outcome_hash=repeat('a',64),resolution_basis='owner_preflight_no_request' WHERE id=$1",
          [attempt.id],
        ),
      ).rejects.toThrow(/immutable/);
    });
    it("uses zero in the initial feed only when current ATP is actually zero", async () => {
      await h.queue();
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=reserved_qty WHERE id=10",
      );
      await h.runListing();
      expect(h.remote.feedCalls).toBe(1);
      expect(h.remote.feedPayloads[0]).toMatchObject({
        MPItem: [
          {
            Orderable: {
              inventory: [
                { quantity: 0, fulfillmentCenterID: "test-location" },
              ],
            },
          },
        ],
      });
    });
    it("recalculates ATP on a definitely-unsent retry of the same batch while preserving both attempt snapshots", async () => {
      const { operation, reviewed } = await h.queue();
      const stored = await h.store.operation(36, operation.id);
      const source = stored.snapshot.recreations![0];
      const initial = {
        operationId: stored.progress.batches[0].correlationId,
        publicationTargetId: Number(reviewed.inventory.targetId),
        expectedTargetRevision: reviewed.inventory.targetRevision!,
        channelId: h.account.channelId,
        channelConnectionId: h.account.connectionId,
        partnerId: h.account.accountId,
        environment: h.account.environment,
        shipNodeId: h.account.scopeId,
        items: [
          {
            productVariantId: 101,
            sku: "P5",
            quantity: 0,
            recreation: {
              sourceOperationId: source.operationId,
              sourceHash: source.sourceHash,
              previousExternalProductId: source.previousExternalProductId,
            },
          },
        ],
      };
      await expect(
        h.admission.runListingSetup(initial, async (approved) => {
          expect(approved.items[0].quantity).toBe(17);
          throw new ListingSubmissionError(
            "FIXTURE_PREFLIGHT",
            "Stopped before HTTP",
            "not_sent",
          );
        }),
      ).rejects.toMatchObject({ effect: "not_sent" });
      expect(h.remote.feedCalls).toBe(0);
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=10",
      );
      await h.runListing();
      expect(h.remote.feedCalls).toBe(1);
      expect(h.remote.feedPayloads[0]).toMatchObject({
        MPItem: [{ Orderable: { inventory: [{ quantity: 9 }] } }],
      });
      const attempts = await database.pool.query(
        `SELECT state,listing_setup_intent->'items'->0->>'quantity' AS quantity
        FROM inventory.quantity_publication_attempts WHERE listing_setup_operation_id=$1 ORDER BY id`,
        [initial.operationId],
      );
      expect(attempts.rows).toEqual([
        { state: "not_sent", quantity: "17" },
        { state: "succeeded", quantity: "9" },
      ]);
    });
    it("connects a missing stock mapping after recreating a legacy linked listing", async () => {
      vi.restoreAllMocks();
      await database.close();
      await initialize(false);
      expect(await h.outboxes()).toEqual([]);
      const { operation } = await acceptedRecreation();
      await h.runListing();
      expect((await h.outboxes()).at(-1)).toMatchObject({
        state: "queued",
        desired_quantity: "17",
      });
      expect(await h.publishStock()).toMatchObject({ verified: 1 });
      await h.runListing();
      expect((await h.store.operation(36, operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.feedCalls).toBe(1);
      expect(h.remote.inventoryWrites).toEqual([17]);
    });
    it("fences old stock commands while recreation is processing, then calculates current ATP instead of replaying the old quantity", async () => {
      const { operation } = await acceptedRecreation();
      const original = (await h.outboxes())[0];
      let writes = 0;
      await expect(
        h.admission.runListing(
          {
            destinationKind: "channel_connection",
            connectionId: 8,
            providerKey: "walmart",
            providerScopeType: "location",
            externalScopeId: "test-location",
            externalInventoryItemId: "P5",
            productId: 20,
            productVariantId: 101,
          },
          async () => ({ outboxId: original.id, quantity: 17 }),
          async () => {
            writes++;
          },
        ),
      ).rejects.toMatchObject({
        code: "PUBLICATION_RECREATION_WAITING_FOR_ITEM",
      });
      expect(writes).toBe(0);
      await expect(
        h.stock.connect(h.stockInput("WPID-NEW")),
      ).rejects.toMatchObject({
        code: "PUBLICATION_RECREATION_WAITING_FOR_ITEM",
      });
      expect(await h.outboxes()).toHaveLength(1);
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=15 WHERE id=10",
      );
      await h.runListing();
      expect((await h.outboxes()).at(-1)).toMatchObject({
        state: "queued",
        desired_quantity: "12",
      });
      expect(await h.publishStock()).toMatchObject({ verified: 1 });
      await h.runListing();
      expect(
        (await h.store.operation(36, operation.id)).progress.items[0]
          .stockState,
      ).toBe("ready");
      expect(h.remote.inventoryWrites).toEqual([17, 12]);
    });
    it("rolls back queue and handoff receipt together, then recovers after the channel mapping already committed", async () => {
      const { operation } = await acceptedRecreation();
      await database.pool
        .query(`CREATE FUNCTION public.fail_recreation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='inventory_availability.listing_recreation.stock_queued' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_recreation_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_recreation_audit()`);
      await h.runListing();
      expect(await h.outboxes()).toHaveLength(1);
      expect(
        (
          await database.pool.query(
            "SELECT * FROM inventory.publication_listing_recreation_stock_receipts",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.pool.query(
            "SELECT channel_product_id FROM channels.channel_feeds WHERE channel_id=36",
          )
        ).rows[0].channel_product_id,
      ).toBe("WPID-NEW");
      expect(
        (await h.store.operation(36, operation.id)).progress.items[0]
          .stockState,
      ).toBe("blocked");
      await database.pool.query(
        "DROP TRIGGER fail_recreation_audit ON public.audit_events",
      );
      await h.runListing();
      expect(await h.outboxes()).toHaveLength(2);
      await h.publishStock();
      await h.runListing();
      expect((await h.store.operation(36, operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.feedCalls).toBe(1);
    });
    it("keeps a committed handoff idempotent across concurrent retries and a lost acknowledgement", async () => {
      const { operation } = await acceptedRecreation();
      await h.runListing();
      const stored = await h.store.operation(36, operation.id);
      const input = {
        ...h.stockInput("WPID-NEW"),
        setupOperationId: stored.progress.batches[0].correlationId,
      };
      const results = await Promise.allSettled([
        h.stock.connect(input),
        h.stock.connect(input),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(await h.stock.connect(input)).toMatchObject({
        state: "already_connected",
        publicationState: "queued",
      });
      expect(await h.outboxes()).toHaveLength(2);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM inventory.publication_listing_recreation_stock_receipts",
          )
        ).rows[0].count,
      ).toBe(1);
      expect(h.remote.feedCalls).toBe(1);
    });
    it("continues checking stock after a mismatched readback and completes only after the current quantity matches", async () => {
      const { operation } = await acceptedRecreation();
      await h.runListing();
      h.remote.drift = true;
      expect(await h.publishStock()).toMatchObject({ verified: 0, failed: 1 });
      await h.runListing();
      expect(
        (await h.store.operation(36, operation.id)).progress.items[0],
      ).toMatchObject({ state: "accepted", stockState: "queued" });
      h.remote.drift = false;
      const delivered = await h.publishStock();
      expect(
        delivered,
        JSON.stringify(
          (
            await database.pool.query(
              "SELECT last_error_class,last_error_message FROM inventory.inventory_publication_outbox WHERE publication_target_id=2 ORDER BY desired_revision DESC LIMIT 1",
            )
          ).rows,
        ),
      ).toMatchObject({ verified: 1 });
      await h.runListing();
      expect((await h.store.operation(36, operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.feedCalls).toBe(1);
    });
    it("keeps the committed recreation stock receipt immutable", async () => {
      await acceptedRecreation();
      await h.runListing();
      for (const statement of [
        "UPDATE inventory.publication_listing_recreation_stock_receipts SET external_product_id='OTHER'",
        "DELETE FROM inventory.publication_listing_recreation_stock_receipts",
        "TRUNCATE inventory.publication_listing_recreation_stock_receipts",
      ])
        await expect(database.pool.query(statement)).rejects.toMatchObject({
          code: "23514",
        });
      expect(
        (
          await database.pool.query(
            "SELECT external_product_id FROM inventory.publication_listing_recreation_stock_receipts",
          )
        ).rows,
      ).toEqual([{ external_product_id: "WPID-NEW" }]);
    });
    it.each(["global pause", "channel exclusion"])(
      "retains and resumes the job after %s without changing the saved selection",
      async (reason) => {
        const { operation } = await acceptedRecreation();
        if (reason === "global pause")
          await database.pool.query(
            "UPDATE channels.sync_settings SET global_enabled=false",
          );
        else
          await database.pool.query(
            "INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES(36,101,0)",
          );
        await h.runListing();
        const item = (await h.store.operation(36, operation.id)).progress
          .items[0];
        expect(item.stockState).toBe("blocked");
        expect(item.error).toContain(
          reason === "global pause"
            ? "paused globally"
            : "channel selection excludes stock",
        );
        expect(await h.outboxes()).toHaveLength(1);
        if (reason === "global pause")
          await database.pool.query(
            "UPDATE channels.sync_settings SET global_enabled=true",
          );
        else
          await database.pool.query(
            "UPDATE channels.channel_variant_overrides SET is_listed=1 WHERE channel_id=36 AND product_variant_id=101",
          );
        await h.runListing();
        await h.publishStock();
        await h.runListing();
        expect((await h.store.operation(36, operation.id)).state).toBe(
          "completed",
        );
        expect(h.remote.feedCalls).toBe(1);
      },
    );
    it("does not submit or overwrite a conflicting retained channel identity", async () => {
      await database.pool.query(
        "UPDATE channels.channel_feeds SET channel_sku='OTHER-SKU' WHERE channel_id=36",
      );
      await expect(h.review()).rejects.toMatchObject({
        code: "CHANNEL_RECREATION_MAPPING_CONFLICT",
      });
      expect(h.remote.feedCalls).toBe(0);
      expect(await h.outboxes()).toHaveLength(1);
    });
    it("still rejects ordinary initial setup for an existing linked item", async () => {
      const readiness = await h.admission.inspectListingSetup({
        channelId: 36,
        channelConnectionId: 8,
        partnerId: "partner-36",
        environment: "production",
        shipNodeId: "test-location",
        items: [{ productVariantId: 101, sku: "P5", quantity: 0 }],
      });
      expect(readiness).toMatchObject({
        ready: false,
        variants: [
          {
            ready: false,
            blockers: [
              expect.objectContaining({
                code: "PUBLICATION_SETUP_ITEM_ALREADY_LINKED",
              }),
            ],
          },
        ],
      });
      expect(h.remote.feedCalls).toBe(0);
    });
    it("never retries an ambiguous feed POST or sends stock without its submission receipt", async () => {
      const { operation } = await h.queue();
      h.remote.loseFeedResponse = true;
      await h.runListing();
      await h.runListing();
      expect(h.remote.feedCalls).toBe(1);
      const saved = await h.store.operation(36, operation.id);
      expect(saved.state).toBe("needs_reconciliation");
      expect(saved.progress.batches[0].submissionId).toBeNull();
      expect(await h.outboxes()).toHaveLength(1);
      expect(h.remote.inventoryWrites).toEqual([17]);
    });
    it("accepts a reviewed retry after a definitive rejection and completes the retained stock obligation", async () => {
      const first = await h.queue();
      h.remote.rejectFeed = true;
      await h.runListing();
      expect(
        (await h.store.operation(36, first.operation.id)).progress.items[0],
      ).toMatchObject({ state: "needs_attention", canRetry: true });
      h.remote.rejectFeed = false;
      await h.elapseProviderCooldown();
      const second = await h.queue(first.operation.id);
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=12 WHERE id=10",
      );
      await h.runListing();
      h.remote.deleted = false;
      h.remote.published = true;
      h.remote.feedReady = true;
      await h.runListing();
      await h.publishStock();
      await h.runListing();
      expect((await h.store.operation(36, second.operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.feedCalls).toBe(2);
      expect(h.remote.feedPayloads).toMatchObject([
        { MPItem: [{ Orderable: { inventory: [{ quantity: 17 }] } }] },
        { MPItem: [{ Orderable: { inventory: [{ quantity: 9 }] } }] },
      ]);
      expect(h.remote.inventoryWrites).toEqual([17, 9]);
    });
    it("queues and verifies actual zero ATP without treating it as a setup error", async () => {
      const { operation } = await acceptedRecreation();
      await database.pool.query(
        "UPDATE inventory.inventory_levels SET variant_qty=reserved_qty WHERE id=10",
      );
      await h.runListing();
      expect((await h.outboxes()).at(-1)).toMatchObject({
        desired_quantity: "0",
        state: "queued",
      });
      await h.publishStock();
      await h.runListing();
      expect((await h.store.operation(36, operation.id)).state).toBe(
        "completed",
      );
      expect(h.remote.inventoryWrites).toEqual([17, 0]);
    });
    it("does not claim stock success for an unpublished or unconfirmed recreated item", async () => {
      const { operation } = await h.queue();
      await h.runListing();
      h.remote.feedReady = true;
      h.remote.deleted = false;
      await h.runListing();
      const item = (await h.store.operation(36, operation.id)).progress
        .items[0];
      expect(item.state).toBe("accepted");
      expect(item.error).toContain("reports it as unpublished");
      expect(item.error).toContain("Existing Walmart items");
      expect(await h.outboxes()).toHaveLength(1);
      expect(h.remote.feedCalls).toBe(1);
    });
    it("exposes an uncertain stock request and resumes through the existing evidence-recovery owner", async () => {
      const { operation } = await acceptedRecreation();
      await h.runListing();
      h.remote.loseStockResponse = true;
      expect(await h.publishStock()).toMatchObject({ verified: 0, failed: 1 });
      h.remote.loseStockResponse = false;
      expect(await h.publishStock()).toMatchObject({ verified: 0, failed: 1 });
      await h.runListing();
      expect(
        (await h.store.operation(36, operation.id)).progress.items[0],
      ).toMatchObject({
        state: "accepted",
        stockState: "blocked",
        stockErrorCode: "STOCK_RECREATION_OUTCOME_UNCERTAIN",
        error: expect.stringContaining("Stalled publication recovery"),
      });
      expect(h.remote.inventoryWrites).toEqual([17, 17]);
      const attempt = (
        await database.pool.query(
          "SELECT id::text FROM inventory.quantity_publication_attempts WHERE state='uncertain'",
        )
      ).rows[0];
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        // Explicit synthetic terminal evidence from the fake provider. Attestation
        // clears uncertainty only; the real outbox must still write and read back.
        const record = {
          fakeProvider: true,
          attemptId: attempt.id,
          terminal: true,
          sku: "P5",
          quantity: h.remote.quantity,
        };
        await attestQuantityPublicationAttemptInsideTransaction(client, {
          attemptId: attempt.id,
          idempotencyKey: randomUUID(),
          reason: "Fixture provider retained the final terminal request record",
          evidenceKind: "provider_terminal_request_record",
          terminalOutcome: "completed",
          evidenceReference: `fixture-provider:${attempt.id}`,
          evidenceHash: listingHash(record),
          actor: "fixture-inventory-administrator",
          now: new Date(),
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      expect(await h.publishStock()).toMatchObject({ verified: 1 });
      await h.runListing();
      const item = (await h.store.operation(36, operation.id)).progress
        .items[0];
      expect(item).toMatchObject({
        state: "verified",
        stockState: "ready",
        error: null,
      });
      expect(item.stockErrorCode).toBeUndefined();
      expect(h.remote.feedCalls).toBe(1);
    });
  },
);
