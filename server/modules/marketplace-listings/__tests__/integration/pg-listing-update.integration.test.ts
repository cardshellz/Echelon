import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresListingUpdateRepository } from "../../infrastructure/pg-listing-update.repository";
import { listingAccountKey } from "../../domain/listing-publication";
import {
  listingUpdateRecord,
  updateSource,
} from "../fixtures/listing-update.fixture";
import {
  fixedNow,
  testAccount,
  testId,
} from "../fixtures/listing-publication.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const fixtureSql = `CREATE SCHEMA channels; CREATE SCHEMA catalog;
  CREATE TABLE channels.channels(id integer PRIMARY KEY, provider text NOT NULL);
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY);`;

(url && disposable ? describe : describe.skip).sequential(
  "Postgres listing maintenance owner",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: PostgresListingUpdateRepository;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        fixtureSql,
      );
      // Real migrations, not reduced persistence substitutes.
      for (const file of [
        "0707_channel_listing_publication.sql",
      "0723_channel_listing_updates.sql",
      ]) {
        await database.pool.query(
          readFileSync(resolve("migrations", file), "utf8"),
        );
      }
      repository = new PostgresListingUpdateRepository(database.pool);
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool
        .query(`DROP TRIGGER IF EXISTS test_reject_update_event ON marketplace.channel_listing_update_events;
      TRUNCATE channels.channels CASCADE;
      INSERT INTO channels.channels VALUES (104,'walmart'),(105,'walmart');`);
    });
    async function queue(id = 1) {
      const record = listingUpdateRecord(id);
      await repository.insert(record, "operator");
      return repository.queue(record, testId(id + 100), "operator", fixedNow);
    }
    async function processing(id = 1) {
      await queue(id);
      const claimed = await repository.claim(testId(70), fixedNow, testId(id));
      expect(claimed).not.toBeNull();
      const sending = await repository.progress(
        claimed!,
        "sending",
        null,
        null,
        fixedNow,
        false,
      );
      return repository.progress(
        sending,
        "processing",
        `feed-${id}`,
        null,
        fixedNow,
        false,
      );
    }

    it("atomically records the exact intent and authenticated actor and prevents rewriting evidence", async () => {
      await queue();
      const saved = await repository.get(104, testId(1));
      expect(saved.intent).toEqual(listingUpdateRecord().intent);
      const events = (
        await database.pool.query(
          "SELECT actor,action,before_state,after_state FROM marketplace.channel_listing_update_events ORDER BY id",
        )
      ).rows;
      expect(events.map((event) => [event.actor, event.action])).toEqual([
        ["operator", "reviewed"],
        ["operator", "queued"],
      ]);
      expect(events[1].before_state.state).toBe("reviewed");
      expect(events[1].after_state.state).toBe("queued");
      for (const query of [
        "UPDATE marketplace.channel_listing_updates SET intent='{}'",
        "DELETE FROM marketplace.channel_listing_updates",
        "DELETE FROM marketplace.channel_listing_update_events",
        "UPDATE marketplace.channel_listing_update_events SET actor='changed'",
      ]) {
        await expect(database.pool.query(query)).rejects.toThrow(/immutable/i);
      }
      await expect(repository.get(105, testId(1))).rejects.toMatchObject({
        code: "LISTING_UPDATE_MISSING",
      });
    });
    it("allows one concurrent update per seller SKU, across connections and channels", async () => {
      const a = listingUpdateRecord(1),
        b = listingUpdateRecord(2);
      b.intent.account.channelId = 105;
      b.intent.account.connectionId = 6;
      await repository.insert(a, "a");
      await repository.insert(b, "b");
      const results = await Promise.allSettled([
        repository.queue(a, testId(101), "a", fixedNow),
        repository.queue(b, testId(102), "b", fixedNow),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason.code).toBe("LISTING_UPDATE_PENDING");
    });
    it("deduplicates simultaneous submissions with the same review and command", async () => {
      const record = listingUpdateRecord();
      await repository.insert(record, "operator");
      const result = await Promise.all([
        repository.queue(record, testId(101), "operator", fixedNow),
        repository.queue(record, testId(101), "operator", fixedNow),
      ]);
      expect(result[0]).toEqual(result[1]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM marketplace.channel_listing_update_events",
          )
        ).rows[0].count,
      ).toBe(2);
    });
    it("rolls back a queue transition when audit persistence fails", async () => {
      const record = listingUpdateRecord();
      await repository.insert(record, "operator");
      await database.pool
        .query(`CREATE OR REPLACE FUNCTION marketplace.test_reject_update_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$;
      CREATE TRIGGER test_reject_update_event BEFORE INSERT ON marketplace.channel_listing_update_events FOR EACH ROW EXECUTE FUNCTION marketplace.test_reject_update_event();`);
      await expect(
        repository.queue(record, testId(101), "operator", fixedNow),
      ).rejects.toThrow("injected audit failure");
      expect((await repository.get(104, testId(1))).view.state).toBe(
        "reviewed",
      );
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM marketplace.channel_listing_update_events",
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it("uses exclusive leases and refuses progress from stale workers", async () => {
      await queue();
      const results = await Promise.all([
        repository.claim(testId(71), fixedNow),
        repository.claim(testId(72), fixedNow),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const claimed = results.find(Boolean)!;
      await repository.renew(claimed, new Date(fixedNow.getTime() + 30_000));
      const sending = await repository.progress(
        claimed,
        "sending",
        null,
        null,
        fixedNow,
        false,
      );
      await expect(
        repository.progress(
          claimed,
          "needs_attention",
          null,
          "stale",
          fixedNow,
          true,
        ),
      ).rejects.toMatchObject({ code: "LISTING_UPDATE_LEASE_LOST" });
      await expect(repository.renew(claimed, fixedNow)).rejects.toMatchObject({
        code: "LISTING_UPDATE_LEASE_LOST",
      });
      expect((await repository.get(104, testId(1))).version).toBe(
        sending.version,
      );
    });
    it("recovers an abandoned sending lease as uncertain and keeps later updates blocked", async () => {
      await queue();
      const claimed = await repository.claim(testId(71), fixedNow);
      await repository.progress(
        claimed!,
        "sending",
        null,
        null,
        fixedNow,
        false,
      );
      const later = new Date(fixedNow.getTime() + 121_000);
      const recovered = await repository.claim(testId(72), later);
      expect(recovered?.view.state).toBe("uncertain");
      expect(recovered?.leaseToken).toBeNull();
      expect(await repository.claim(testId(73), later)).toBeNull();
      const next = listingUpdateRecord(2);
      await repository.insert(next, "operator");
      await expect(
        repository.queue(next, testId(102), "operator", later),
      ).rejects.toMatchObject({ code: "LISTING_UPDATE_PENDING" });
    });
    it("accepts a receipted update, preserves its receipt and allows subsequent edits", async () => {
      const record = await processing();
      await repository.progress(
        record,
        "accepted",
        "feed-1",
        "Accepted",
        fixedNow,
        true,
      );
      await expect(
        database.pool.query(
          "UPDATE marketplace.channel_listing_updates SET submission_id='other'",
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(queue(2)).resolves.toMatchObject({
        view: { state: "queued" },
      });
    });
    it("refresh schedules only a receipted item and respects an active worker lease", async () => {
      const record = await processing();
      expect(
        await repository.refresh(104, testId(1), "operator", fixedNow),
      ).toEqual(record);
      const released = await repository.progress(
        record,
        "processing",
        "feed-1",
        "Processing",
        fixedNow,
        true,
      );
      expect(await repository.claim(testId(72), fixedNow)).toBeNull();
      const refreshed = await repository.refresh(
        104,
        testId(1),
        "operator",
        fixedNow,
      );
      expect(refreshed.version).toBe(released.version + 1);
      expect(
        (await repository.claim(testId(72), fixedNow, testId(1)))?.view
          .submissionId,
      ).toBe("feed-1");
      await expect(
        repository.refresh(105, testId(1), "operator", fixedNow),
      ).rejects.toMatchObject({ code: "LISTING_UPDATE_MISSING" });
    });
    it("rejects expired and invalid reviews without changing their intent", async () => {
      const record = listingUpdateRecord();
      await repository.insert(record, "operator");
      await expect(
        repository.queue(
          record,
          testId(101),
          "operator",
          new Date(record.view.expiresAt),
        ),
      ).rejects.toMatchObject({ code: "LISTING_UPDATE_REVIEW_INVALID" });
      expect((await repository.get(104, record.view.id)).view.state).toBe(
        "reviewed",
      );
    });
    it("reconstructs accepted fields only for the exact seller account and product identity", async () => {
      const record = await processing();
      await repository.progress(
        record,
        "accepted",
        "feed-1",
        "Accepted",
        fixedNow,
        true,
      );
      expect(
        await repository.lastSubmitted(
          testAccount,
          updateSource.sku,
          updateSource.externalProductId,
        ),
      ).toMatchObject({ changes: { priceCents: 2799 } });
      expect(
        await repository.lastSubmitted(
          { ...testAccount, accountId: "other" },
          updateSource.sku,
          updateSource.externalProductId,
        ),
      ).toBeNull();
      expect(
        await repository.lastSubmitted(
          testAccount,
          updateSource.sku,
          "different-product",
        ),
      ).toBeNull();
      expect(
        await repository.list(
          104,
          undefined,
          listingAccountKey({ ...testAccount, accountId: "other" }),
        ),
      ).toEqual([]);
      expect(
        await repository.acceptedPrice(
          testAccount,
          updateSource.sku,
          updateSource.externalProductId,
          fixedNow,
        ),
      ).toBe(2799);
      expect(
        await repository.acceptedPrice(
          { ...testAccount, accountId: "other" },
          updateSource.sku,
          updateSource.externalProductId,
          fixedNow,
        ),
      ).toBeNull();
      expect(
        await repository.acceptedPrice(
          testAccount,
          updateSource.sku,
          "other-product",
          fixedNow,
        ),
      ).toBeNull();
      expect(
        await repository.acceptedPrice(
          testAccount,
          updateSource.sku,
          updateSource.externalProductId,
          new Date(fixedNow.getTime() + 1),
        ),
      ).toBeNull();
    });
  },
);
