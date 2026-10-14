import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresListingLifecycleRepository } from "../../infrastructure/pg-listing-lifecycle.repository";
import {
  testAccount,
  testId,
  fixedNow,
} from "../fixtures/listing-publication.fixture";
import { listingAccountKey } from "../../domain/listing-publication";
import {
  runWithListingSetupAdmission,
  validateListingSetupIntent,
} from "../../../inventory-planning/application/listing-setup-intent";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(url && disposable ? describe : describe.skip).sequential(
  "confirmed Walmart listing absence",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: PostgresListingLifecycleRepository;
    const missing = () => ({
      sku: "SKU",
      state: "missing" as const,
      externalProductId: null,
      checkedAt: fixedNow.toISOString(),
    });
    const observe = () =>
      repository.observePresence(testAccount, "SKU", async () => missing());
    beforeEach(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        `CREATE SCHEMA channels; CREATE SCHEMA catalog;
      CREATE TABLE channels.channels(id integer PRIMARY KEY);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY);
      CREATE TABLE channels.channel_feeds(channel_id integer,product_variant_id integer,channel_sku text,
        channel_product_id text,is_active integer,quarantined_at timestamptz);
      INSERT INTO channels.channels VALUES(104); INSERT INTO catalog.product_variants VALUES(10);
      INSERT INTO channels.channel_feeds VALUES(104,10,'SKU','WPID',1,NULL);`,
      );
      for (const file of [
        "0707_channel_listing_publication.sql",
        "0724_channel_listing_updates.sql",
        "259_channel_listing_lifecycle.sql",
        "0748_walmart_listing_presence.sql",
      ])
        await database.pool.query(
          readFileSync(resolve("migrations", file), "utf8"),
        );
      repository = new PostgresListingLifecycleRepository(database.pool);
    });
    afterEach(async () => database?.close());

    it("retains the catalog identity, audits absence once, and stops stock and maintenance only for this SKU/account", async () => {
      await observe();
      await observe();
      expect(
        (
          await database.pool.query(
            "SELECT channel_product_id FROM channels.channel_feeds",
          )
        ).rows,
      ).toEqual([{ channel_product_id: "WPID" }]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM marketplace.channel_listing_presence_events",
          )
        ).rows[0].n,
      ).toBe(1);
      const write = vi.fn(async () => "sent");
      await expect(
        repository.withAllowed(testAccount, ["SKU"], write),
      ).rejects.toMatchObject({ code: "LISTING_MISSING_ON_PROVIDER" });
      for (const quantity of [0, 100])
        await expect(
          repository.withStockAllowed(testAccount, "SKU", quantity, write),
        ).rejects.toMatchObject({ code: "LISTING_MISSING_ON_PROVIDER" });
      expect(write).not.toHaveBeenCalled();
      await expect(
        repository.withAllowed(testAccount, ["OTHER"], write),
      ).resolves.toBe("sent");
      await expect(
        repository.withAllowed(
          { ...testAccount, accountId: "other-seller" },
          ["SKU"],
          write,
        ),
      ).resolves.toBe("sent");
      await expect(
        database.pool.query(
          "UPDATE marketplace.channel_listing_presence_events SET actor='changed'",
        ),
      ).rejects.toThrow(/immutable/);
    });

    it("does not classify an unsubmitted draft or a failed provider lookup as missing", async () => {
      const read = vi.fn(async () => missing());
      expect(
        await repository.observePresence(testAccount, "DRAFT", read),
      ).toBeNull();
      expect(read).not.toHaveBeenCalled();
      await expect(
        repository.observePresence(testAccount, "SKU", async () => {
          throw new Error("timeout");
        }),
      ).rejects.toThrow("timeout");
      expect(await repository.presence(testAccount, ["SKU"])).toEqual([]);
    });

    it("serializes absence with a provider write and uses only one pool connection while holding the SKU lock", async () => {
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inFlight = repository.withAllowed(
        testAccount,
        ["SKU"],
        async () => {
          entered();
          await wait;
        },
      );
      await ready;
      const read = vi.fn(async () => missing());
      try {
        await expect(
          repository.observePresence(testAccount, "SKU", read),
        ).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_BUSY" });
        expect(read).not.toHaveBeenCalled();
      } finally {
        release();
        await inFlight;
      }
      const connect = vi.spyOn(database.pool, "connect");
      await observe();
      expect(connect).toHaveBeenCalledTimes(1);
      connect.mockRestore();
    });

    it("rolls back the observation if its immutable audit cannot commit", async () => {
      await database.pool
        .query(`CREATE TRIGGER fail_presence_audit BEFORE INSERT ON marketplace.channel_listing_presence_events
      FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_presence_event()`);
      await expect(observe()).rejects.toThrow(/immutable/);
      expect(await repository.presence(testAccount, ["SKU"])).toEqual([]);
    });

    async function pendingListing() {
      const key = listingAccountKey(testAccount);
      await database.pool.query(
        `INSERT INTO marketplace.channel_listing_reviews
      (id,channel_id,draft_revision,review_hash,snapshot,created_by,created_at,expires_at)
      VALUES($1,104,1,repeat('a',64),'{}','operator',$2,$2::timestamptz+interval '1 hour')`,
        [testId(1), fixedNow],
      );
      await database.pool.query(
        `INSERT INTO marketplace.channel_listing_operations
      (id,channel_id,account_key,command_key,request_hash,review_id,state,snapshot,progress,next_attempt_at,created_by,created_at,updated_at)
      VALUES($1,104,$2,$3,repeat('a',64),$4,'processing','{}',$5,$6,'operator',$6,$6)`,
        [
          testId(2),
          key,
          testId(3),
          testId(1),
          {
            items: [{ sku: "SKU", variantId: 10, state: "accepted" }],
            batches: [
              {
                correlationId: testId(4),
                variantIds: [10],
                state: "processed",
              },
            ],
          },
          fixedNow,
        ],
      );
    }

    it("does not mistake a processed feed awaiting first publication for a deleted listing", async () => {
      await pendingListing();
      const read = vi.fn(async () => missing());
      expect(
        await repository.observePresence(testAccount, "SKU", read),
      ).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(await repository.presence(testAccount, ["SKU"])).toEqual([]);
    });

    it("clears absence only with the exact current submission batch and observed mapped identity", async () => {
      await observe();
      await pendingListing();
      const present = async () => ({
        ...missing(),
        state: "present" as const,
        externalProductId: "WPID",
      });
      await expect(
        repository.observePresence(testAccount, "SKU", present, testId(99)),
      ).rejects.toMatchObject({ code: "LISTING_PRESENCE_OPERATION_CHANGED" });
      await expect(
        repository.observePresence(
          testAccount,
          "SKU",
          async () => ({
            ...(await present()),
            externalProductId: "UNRELATED",
          }),
          testId(4),
        ),
      ).rejects.toMatchObject({ code: "LISTING_PRESENCE_IDENTITY_CHANGED" });
      expect((await repository.presence(testAccount, ["SKU"]))[0].state).toBe(
        "missing",
      );
      await repository.observePresence(testAccount, "SKU", present, testId(4));
      await expect(
        repository.withStockAllowed(testAccount, "SKU", 17, async () => "sent"),
      ).resolves.toBe("sent");
    });

    it("permits exact inventory-admitted recreation without bypassing an operator stop", async () => {
      await observe();
      const intent = validateListingSetupIntent({
        operationId: testId(2),
        publicationTargetId: 1,
        expectedTargetRevision: "1",
        channelId: testAccount.channelId,
        channelConnectionId: testAccount.connectionId,
        partnerId: testAccount.accountId,
        environment: testAccount.environment,
        shipNodeId: testAccount.scopeId,
        items: [
          {
            productVariantId: 10,
            sku: "SKU",
            quantity: 17,
            recreation: {
              sourceOperationId: testId(1),
              sourceHash: "a".repeat(64),
              previousExternalProductId: "WPID",
            },
          },
        ],
      });
      const send = () =>
        repository.withAllowed(
          testAccount,
          ["SKU"],
          async () => "sent",
          intent,
        );
      await expect(send()).rejects.toMatchObject({
        code: "PUBLICATION_SETUP_ADMISSION_REQUIRED",
      });
      await expect(runWithListingSetupAdmission(intent, send)).resolves.toBe(
        "sent",
      );
      await repository.withListing(testAccount, "SKU", (session) =>
        session.request(
          { account: testAccount, sku: "SKU", action: "unpublish" },
          "Title",
          "operator",
          testId(9),
          fixedNow,
        ),
      );
      await expect(
        runWithListingSetupAdmission(intent, send),
      ).rejects.toMatchObject({ code: "LISTING_PUBLICATION_STOPPED" });
      const read = vi.fn(async () => missing());
      expect(
        await repository.observePresence(testAccount, "SKU", read),
      ).toBeNull();
      expect(read).not.toHaveBeenCalled();
    });
  },
);
