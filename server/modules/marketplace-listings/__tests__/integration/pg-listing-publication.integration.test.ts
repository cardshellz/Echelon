import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresListingPublicationRepository } from "../../infrastructure/pg-listing-publication.repository";
import {
  listingHash,
  type ListingSnapshot,
} from "../../domain/listing-publication";
import {
  fixedNow,
  publicationProgress,
  publicationSnapshot,
  testAccount,
  testId,
} from "../fixtures/listing-publication.fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const fixtureSql = `
CREATE SCHEMA channels; CREATE SCHEMA catalog;
CREATE TABLE channels.channels(id integer PRIMARY KEY, provider text NOT NULL);
CREATE TABLE channels.channel_connections(id integer PRIMARY KEY, channel_id integer NOT NULL REFERENCES channels.channels(id));
CREATE TABLE catalog.products(id integer PRIMARY KEY, is_active boolean NOT NULL, status text NOT NULL);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id), sku text NOT NULL,
 is_active boolean NOT NULL, sales_eligibility text NOT NULL, requires_shipping boolean NOT NULL, track_inventory boolean NOT NULL);
`;

// Only the supporting owners are reduced fixtures. The entire publication migration
// runs unchanged so transaction, FK, uniqueness, and immutable-evidence proof is real.
(url && disposable ? describe : describe.skip).sequential(
  "Postgres listing publication durable owner",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: PostgresListingPublicationRepository;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(
        url,
        disposable,
        fixtureSql,
      );
      await database.pool.query(
        readFileSync(
          resolve("migrations/0707_channel_listing_publication.sql"),
          "utf8",
        ),
      );
      repository = new PostgresListingPublicationRepository(database.pool);
      await database.pool.query(readFileSync(resolve("migrations/260_channel_listing_recreation.sql"), "utf8"));
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool
        .query(`DROP TRIGGER IF EXISTS test_reject_event ON marketplace.channel_listing_publication_events;
      TRUNCATE marketplace.channel_listing_publication_events, marketplace.channel_listing_item_claims, marketplace.channel_listing_operations,
      marketplace.channel_listing_reviews, marketplace.channel_listing_drafts, channels.channel_connections, channels.channels, catalog.product_variants, catalog.products;
      INSERT INTO channels.channels VALUES (104,'walmart'),(105,'walmart'); INSERT INTO channels.channel_connections VALUES (5,104),(6,105);
      INSERT INTO catalog.products VALUES (20,true,'active');
      INSERT INTO catalog.product_variants VALUES (10,20,'SKU-10',true,'sellable',true,true),(11,20,'SKU-11',true,'sellable',true,true);`);
    });
    async function saveReview(snapshot = publicationSnapshot()) {
      const current = await repository.draft(snapshot.account.channelId);
      const draft = await repository.saveDraft(
        snapshot.account,
        { ...snapshot.draft, revision: current.revision },
        "admin",
        fixedNow,
      );
      const next = structuredClone(snapshot);
      next.draft = draft;
      next.review.draftRevision = draft.revision;
      await repository.saveReview(next, "admin", fixedNow);
      return next;
    }
    async function saveSelectedReview(selectedIds = [10]) {
      const full = publicationSnapshot([10, 11]);
      Object.assign(full.draft.items[1], {
        identifier: { type: "GTIN", value: "00036000291452" },
        productType: "Exact provider product type",
        title: "Saved custom title",
        priceOverrideCents: 1550,
        attributes: { Visible: { numberOfPieces: 200 } },
      });
      const draft = await repository.saveDraft(
        full.account,
        { ...full.draft, revision: 0 },
        "admin",
        fixedNow,
      );
      const selected = structuredClone(full);
      selected.draft = {
        ...draft,
        items: draft.items.filter((item) =>
          selectedIds.includes(item.variantId),
        ),
      };
      selected.catalog = selected.catalog.filter((item) =>
        selectedIds.includes(item.variantId),
      );
      selected.prepared = selected.prepared.filter((item) =>
        selectedIds.includes(item.variantId),
      );
      selected.review.items = selected.review.items.filter((item) =>
        selectedIds.includes(item.variantId),
      );
      selected.review.draftRevision = draft.revision;
      selected.review.reviewHash = listingHash({
        account: selected.account,
        draft: selected.draft,
        catalog: selected.catalog,
        prepared: selected.prepared,
        inventory: selected.review.inventory,
      });
      await repository.saveReview(selected, "admin", fixedNow);
      return { full: draft, selected };
    }
    function input(snapshot: ListingSnapshot, id = 3, key = 50) {
      return {
        id: testId(id),
        snapshot,
        progress: publicationProgress(snapshot),
        commandKey: testId(key),
        requestHash: listingHash({
          reviewId: snapshot.review.id,
          reviewHash: snapshot.review.reviewHash,
        }),
        actor: "admin",
        now: fixedNow,
      };
    }
    async function counts() {
      return (
        await database.pool.query(`SELECT
      (SELECT count(*)::int FROM marketplace.channel_listing_operations) operations,
      (SELECT count(*)::int FROM marketplace.channel_listing_item_claims) claims,
      (SELECT count(*)::int FROM marketplace.channel_listing_publication_events WHERE action='publication_queued') queued,
      (SELECT count(*)::int FROM marketplace.channel_listing_publication_events WHERE action='draft_submitted') consumed`)
      ).rows[0];
    }

    it("rejects an optimistic draft conflict without changing selection or audit", async () => {
      const snapshot = await saveReview();
      await expect(
        repository.saveDraft(
          snapshot.account,
          { ...snapshot.draft, revision: 0, items: [] },
          "other-admin",
          fixedNow,
        ),
      ).rejects.toMatchObject({ code: "LISTING_REVIEW_STALE" });
      expect((await repository.draft(104)).items).toEqual(snapshot.draft.items);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.channel_listing_publication_events WHERE action='draft_saved'",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("consumes only the immutable reviewed selection and replays without consuming remaining saved fields", async () => {
      const { full, selected } = await saveSelectedReview();
      const created = await repository.createOperation(input(selected));
      expect(
        created.snapshot.draft.items.map((item) => item.variantId),
      ).toEqual([10]);
      expect(created.progress.items.map((item) => item.variantId)).toEqual([
        10,
      ]);
      expect(
        created.progress.batches.flatMap((batch) => batch.variantIds),
      ).toEqual([10]);
      expect(
        (
          await database.pool.query(
            "SELECT product_variant_id FROM marketplace.channel_listing_item_claims",
          )
        ).rows,
      ).toEqual([{ product_variant_id: 10 }]);
      const remaining = await repository.draft(104);
      expect(remaining).toMatchObject({
        revision: full.revision + 1,
        items: [full.items[1]],
      });
      const audit = (
        await database.pool.query(
          "SELECT before_state,after_state FROM marketplace.channel_listing_publication_events WHERE action='draft_submitted'",
        )
      ).rows[0];
      expect(audit.before_state).toEqual(full.items);
      expect(audit.after_state).toEqual({
        items: [full.items[1]],
        submittedVariantIds: [10],
        operationId: created.id,
        revision: 2,
      });
      expect((await repository.createOperation(input(selected, 30))).id).toBe(
        created.id,
      );
      expect(await repository.draft(104)).toEqual(remaining);
      expect(await counts()).toEqual({
        operations: 1,
        claims: 1,
        queued: 1,
        consumed: 1,
      });
    });

    it("fences competing disjoint selections at the full draft revision and preserves the losing selection", async () => {
      const { full, selected: first } = await saveSelectedReview();
      const second = publicationSnapshot([11], testAccount, testId(20));
      second.draft = { ...full, items: [full.items[1]] };
      await repository.saveReview(second, "other-admin", fixedNow);
      const outcomes = await Promise.allSettled([
        repository.createOperation(input(first)),
        repository.createOperation(input(second, 30, 51)),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "LISTING_REVIEW_STALE" });
      const losingItem =
        outcomes[0].status === "rejected" ? full.items[0] : full.items[1];
      expect(await repository.draft(104)).toMatchObject({
        revision: 2,
        items: [losingItem],
      });
      expect(await counts()).toEqual({
        operations: 1,
        claims: 1,
        queued: 1,
        consumed: 1,
      });
    });

    it("rejects a widened durable review snapshot without consuming unselected rows", async () => {
      const { full, selected } = await saveSelectedReview();
      const widened = publicationSnapshot([10, 11]);
      widened.draft = full;
      widened.review.reviewHash = selected.review.reviewHash;
      await expect(
        repository.createOperation(input(widened)),
      ).rejects.toMatchObject({ code: "LISTING_REVIEW_STALE" });
      expect(await repository.draft(104)).toEqual(full);
      expect(await counts()).toEqual({
        operations: 0,
        claims: 0,
        queued: 0,
        consumed: 0,
      });
    });

    it("invalidates a selected review when an unselected saved row changes", async () => {
      const { full, selected } = await saveSelectedReview();
      const updated = structuredClone(full);
      updated.items[1].title = "Another administrator's edit";
      const saved = await repository.saveDraft(
        selected.account,
        updated,
        "other-admin",
        fixedNow,
      );
      await expect(
        repository.createOperation(input(selected)),
      ).rejects.toMatchObject({ code: "LISTING_REVIEW_STALE" });
      expect(await repository.draft(104)).toEqual(saved);
      expect(await counts()).toEqual({
        operations: 0,
        claims: 0,
        queued: 0,
        consumed: 0,
      });
    });

    it("rolls back selected consumption and keeps both reviewed and unreviewed rows after audit failure", async () => {
      const { full, selected } = await saveSelectedReview();
      await database.pool
        .query(`CREATE OR REPLACE FUNCTION marketplace.test_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='publication_queued' THEN RAISE EXCEPTION 'forced audit outage'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER test_reject_event BEFORE INSERT ON marketplace.channel_listing_publication_events FOR EACH ROW EXECUTE FUNCTION marketplace.test_fail_event();`);
      await expect(repository.createOperation(input(selected))).rejects.toThrow(
        "forced audit outage",
      );
      expect(await repository.draft(104)).toEqual(full);
      expect(await counts()).toEqual({
        operations: 0,
        claims: 0,
        queued: 0,
        consumed: 0,
      });
    });

    it("persists blocked all-draft reviews with a prepared subset without consuming any item", async () => {
      const blocked = publicationSnapshot([10, 11]);
      blocked.review.canSubmit = false;
      blocked.review.items[1].issues.push({
        code: "LISTING_PRICE_REQUIRED",
        message: "Set a price",
        field: null,
      });
      blocked.prepared = blocked.prepared.slice(0, 1);
      const saved = await saveReview(blocked);
      expect(await repository.review(104, saved.review.id)).toEqual(saved);
      await expect(
        repository.createOperation(input(saved)),
      ).rejects.toMatchObject({ code: "LISTING_REVIEW_BLOCKED" });
      expect((await repository.draft(104)).items).toEqual(saved.draft.items);
      expect(await counts()).toEqual({
        operations: 0,
        claims: 0,
        queued: 0,
        consumed: 0,
      });
    });

    it.each(["missing", "changed", "duplicate", "catalog", "prepared"])(
      "rejects invalid selected snapshot identity: %s",
      async (kind) => {
        const { full, selected } = await saveSelectedReview();
        const invalid = structuredClone(selected);
        invalid.review.id = testId(25);
        if (kind === "missing") invalid.draft.items[0].variantId = 99;
        if (kind === "changed")
          invalid.draft.items[0].identifier = { type: "UPC", value: "changed" };
        if (kind === "duplicate")
          invalid.draft.items.push(structuredClone(invalid.draft.items[0]));
        if (kind === "catalog") invalid.catalog = [];
        if (kind === "prepared") invalid.prepared = [];
        await expect(
          repository.saveReview(invalid, "admin", fixedNow),
        ).rejects.toMatchObject({ code: "LISTING_REVIEW_STALE" });
        expect(await repository.draft(104)).toEqual(full);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int n FROM marketplace.channel_listing_reviews",
            )
          ).rows[0].n,
        ).toBe(1);
      },
    );

    it("atomically consumes a draft and replays competing identical commands once", async () => {
      const snapshot = await saveReview(publicationSnapshot([10, 11]));
      const results = await Promise.all([
        repository.createOperation(input(snapshot)),
        repository.createOperation(input(snapshot, 30)),
      ]);
      expect(results[0].id).toBe(results[1].id);
      expect(await counts()).toEqual({
        operations: 1,
        claims: 2,
        queued: 1,
        consumed: 1,
      });
      expect(await repository.draft(104)).toMatchObject({
        revision: 2,
        items: [],
      });
      await expect(
        repository.replay(104, testId(50), "f".repeat(64)),
      ).rejects.toMatchObject({ code: "LISTING_COMMAND_CONFLICT" });
      expect(
        (await repository.replay(104, testId(50), input(snapshot).requestHash))
          ?.id,
      ).toBe(results[0].id);
    });

    it("allows only one competing claim for the same remote SKU and preserves the losing draft", async () => {
      const first = await saveReview();
      const other = publicationSnapshot(
        [11],
        { ...testAccount, channelId: 105, connectionId: 6 },
        testId(20),
      );
      other.catalog[0].sku =
        other.prepared[0].sku =
        other.review.items[0].sku =
          "SKU-10";
      const second = await saveReview(other);
      const results = await Promise.allSettled([
        repository.createOperation(input(first)),
        repository.createOperation(input(second, 30, 51)),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failure = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(failure.reason).toMatchObject({
        code: "LISTING_ITEM_ALREADY_MANAGED",
      });
      const loser = results[0].status === "rejected" ? 104 : 105;
      expect((await repository.draft(loser)).items).toHaveLength(1);
      expect(await counts()).toEqual({
        operations: 1,
        claims: 1,
        queued: 1,
        consumed: 1,
      });
    });

    it("rolls back operation, claims, draft consumption and intermediate events when final audit insertion fails", async () => {
      const snapshot = await saveReview(publicationSnapshot([10, 11]));
      await database.pool
        .query(`CREATE OR REPLACE FUNCTION marketplace.test_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='publication_queued' THEN RAISE EXCEPTION 'forced audit outage'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER test_reject_event BEFORE INSERT ON marketplace.channel_listing_publication_events FOR EACH ROW EXECUTE FUNCTION marketplace.test_fail_event();`);
      await expect(repository.createOperation(input(snapshot))).rejects.toThrow(
        "forced audit outage",
      );
      expect(await counts()).toEqual({
        operations: 0,
        claims: 0,
        queued: 0,
        consumed: 0,
      });
      expect(await repository.draft(104)).toMatchObject({
        revision: 1,
        items: snapshot.draft.items,
      });
    });

    it("rechecks fulfillment eligibility transactionally after review", async () => {
      const snapshot = await saveReview();
      await database.pool.query(
        "UPDATE catalog.product_variants SET track_inventory=false WHERE id=10",
      );
      await expect(
        repository.createOperation(input(snapshot)),
      ).rejects.toMatchObject({ code: "LISTING_VARIANT_UNAVAILABLE" });
      expect(await counts()).toEqual({
        operations: 0,
        claims: 0,
        queued: 0,
        consumed: 0,
      });
      expect((await repository.draft(104)).items).toHaveLength(1);
    });

    it("fences an expired submitting lease without converting it back into an unsent job", async () => {
      const snapshot = await saveReview();
      const created = await repository.createOperation(input(snapshot));
      const first = (await repository.claim(fixedNow, testId(60)))!;
      const progress = structuredClone(first.progress);
      progress.batches[0].state = "submitting";
      const submitting = await repository.saveProgress(first, progress, {
        now: fixedNow,
        nextAttemptAt: fixedNow,
        releaseLease: false,
        actor: "worker",
      });
      const later = new Date(fixedNow.getTime() + 300_000);
      const recovered = (await repository.claim(later, testId(61)))!;
      expect(recovered.id).toBe(created.id);
      expect(recovered.state).toBe("needs_reconciliation");
      expect(recovered.progress.batches[0]).toMatchObject({
        state: "needs_reconciliation",
        submissionId: null,
      });
      expect(recovered.progress.items[0]).toMatchObject({
        state: "needs_reconciliation",
        canRetry: false,
      });
      await expect(
        repository.saveProgress(submitting, submitting.progress, {
          now: later,
          nextAttemptAt: later,
          releaseLease: true,
          actor: "stale-worker",
        }),
      ).rejects.toMatchObject({ code: "LISTING_LEASE_LOST" });
      await repository.saveProgress(recovered, recovered.progress, {
        now: later,
        nextAttemptAt: later,
        releaseLease: true,
        actor: "worker",
      });
      const scheduled = await repository.requestReconciliation(
        104,
        created.id,
        "admin",
        later,
      );
      expect(scheduled.progress.batches[0].state).toBe("needs_reconciliation");
      expect(
        (await repository.claim(later, testId(62)))?.progress.items[0].canRetry,
      ).toBe(false);
    });
    it("renews only the current unexpired worker lease without mutating business evidence", async () => {
      const snapshot = await saveReview();
      await repository.createOperation(input(snapshot));
      const claimed = (await repository.claim(fixedNow, testId(60)))!;
      const before = (
        await database.pool.query(
          "SELECT count(*)::int n FROM marketplace.channel_listing_publication_events",
        )
      ).rows[0].n;
      await repository.renewLease(
        claimed,
        new Date(fixedNow.getTime() + 240_000),
      );
      expect((await repository.operation(104, claimed.id)).version).toBe(
        claimed.version,
      );
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM marketplace.channel_listing_publication_events",
          )
        ).rows[0].n,
      ).toBe(before);
      expect(
        await repository.claim(
          new Date(fixedNow.getTime() + 300_000),
          testId(61),
        ),
      ).toBeNull();
      await expect(
        repository.renewLease(
          { ...claimed, leaseToken: testId(62) },
          new Date(fixedNow.getTime() + 300_000),
        ),
      ).rejects.toMatchObject({ code: "LISTING_LEASE_LOST" });
      await expect(
        repository.renewLease(claimed, new Date(fixedNow.getTime() + 540_000)),
      ).rejects.toMatchObject({ code: "LISTING_LEASE_LOST" });
    });

    it.each([false, true])(
      "transfers a claim to a new reviewed operation only with definitive item rejection (retryable=%s)",
      async (retryable) => {
        const first = await saveReview();
        await repository.createOperation(input(first));
        const claimed = (await repository.claim(fixedNow, testId(60)))!;
        const failed = structuredClone(claimed.progress);
        failed.batches[0].state = "processed";
        failed.items[0].state = "needs_attention";
        failed.items[0].canRetry = retryable;
        failed.items[0].error = "Rejected";
        await repository.saveProgress(claimed, failed, {
          now: fixedNow,
          nextAttemptAt: fixedNow,
          releaseLease: true,
          actor: "worker",
        });
        const next = await saveReview(
          publicationSnapshot([10], testAccount, testId(20)),
        );
        if (!retryable) {
          await expect(
            repository.createOperation(input(next, 30, 51)),
          ).rejects.toMatchObject({ code: "LISTING_ITEM_ALREADY_MANAGED" });
          expect((await repository.draft(104)).items).toHaveLength(1);
          expect((await counts()).operations).toBe(1);
        } else {
          const retried = await repository.createOperation(input(next, 30, 51));
          expect(
            (
              await database.pool.query(
                "SELECT operation_id FROM marketplace.channel_listing_item_claims",
              )
            ).rows[0].operation_id,
          ).toBe(retried.id);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int n FROM marketplace.channel_listing_publication_events WHERE action='rejected_item_reclaimed'",
              )
            ).rows[0].n,
          ).toBe(1);
          expect(
            (await repository.operation(104, testId(3))).progress.items[0]
              .error,
          ).toBe("Rejected");
        }
      },
    );

    async function acceptedRecreation(externalProductId: string | null = "old-wpid", method: "create" | "match" = "create") {
      const original = await repository.createOperation(input(await saveReview()));
      const claimed = (await repository.claim(fixedNow, testId(60)))!;
      const progress = structuredClone(claimed.progress);
      progress.batches[0].state = "processed";
      progress.batches[0].submissionId = "accepted-feed";
      progress.items[0].state = "accepted";
      progress.items[0].externalProductId = externalProductId;
      const prior = await repository.saveProgress(claimed, progress, { now: fixedNow,
        nextAttemptAt: new Date(fixedNow.getTime() + 900_000), releaseLease: true, actor: "worker" });
      const next = publicationSnapshot([10], testAccount, testId(101));
      next.draft.items[0].recreateFromOperationId = original.id;
      next.draft.items[0].method = method;
      next.review.items[0].method = method;
      if (method === "match") {
        next.prepared[0].feedType = "MP_ITEM_MATCH";
        next.prepared[0].payload = { Item: next.prepared[0].payload.Orderable };
      }
      next.recreations = [{ operationId: original.id, variantId: 10, sku: "SKU-10", previousExternalProductId: "old-wpid",
        sourceHash: listingHash(original.snapshot), checkedAt: fixedNow.toISOString() }];
      return { prior, next: await saveReview(next) };
    }

    it.each(["create", "match"] as const)("atomically supersedes an accepted deleted listing with %s, transfers its claim and preserves immutable history", async method => {
      const { prior, next } = await acceptedRecreation("old-wpid", method);
      const replacement = await repository.createOperation(input(next, 102, 103));
      const old = await repository.operation(104, prior.id);
      expect(old.snapshot).toEqual(prior.snapshot);
      expect(replacement.snapshot.draft.items[0].method).toBe(method);
      expect(replacement.snapshot.draft.items[0].identifier).toEqual(prior.snapshot.draft.items[0].identifier);
      expect(old.progress.items[0]).toMatchObject({ state: "superseded", recreatedByOperationId: replacement.id, canRetry: false });
      expect(old.progress.batches[0].submissionId).toBe("accepted-feed");
      expect(old.state).toBe("completed");
      expect((await database.pool.query("SELECT operation_id FROM marketplace.channel_listing_item_claims")).rows[0].operation_id).toBe(replacement.id);
      expect((await repository.draft(104)).items).toEqual([]);
      expect((await repository.createOperation(input(next, 102, 103))).id).toBe(replacement.id);
      expect((await database.pool.query("SELECT action FROM marketplace.channel_listing_publication_events WHERE action LIKE 'deleted_%' ORDER BY id")).rows)
        .toEqual([{ action: "deleted_listing_recreated" }, { action: "deleted_item_reclaimed" }]);
    });
    it("refuses stale identity evidence and an in-flight original worker without consuming the draft", async () => {
      const { prior, next } = await acceptedRecreation();
      await database.pool.query("UPDATE marketplace.channel_listing_operations SET lease_token=$2,lease_until=$3 WHERE id=$1",
        [prior.id, testId(60), new Date(fixedNow.getTime() + 60_000)]);
      await expect(repository.createOperation(input(next, 102, 103))).rejects.toMatchObject({ code: "LISTING_RECREATION_BUSY" });
      await database.pool.query("UPDATE marketplace.channel_listing_operations SET lease_token=NULL,lease_until=NULL WHERE id=$1", [prior.id]);
      const stale = structuredClone(next); stale.review.id = testId(104); stale.recreations![0].previousExternalProductId = "another-product";
      await repository.saveReview(stale, "operator", fixedNow);
      await expect(repository.createOperation(input(stale, 105, 106))).rejects.toMatchObject({ code: "LISTING_RECREATION_STALE" });
      expect((await repository.operation(104, prior.id)).progress.items[0].state).toBe("accepted");
      expect((await repository.draft(104)).items).toEqual(next.draft.items);
      expect((await counts()).operations).toBe(1);
    });
    it("retains the reviewed mapping identity when an accepted original feed omitted its product ID", async () => {
      const { prior, next } = await acceptedRecreation(null);
      const replacement = await repository.createOperation(input(next, 102, 103));
      expect(replacement.snapshot.recreations?.[0].previousExternalProductId).toBe("old-wpid");
      expect((await repository.operation(104, prior.id)).progress.items[0]).toMatchObject({ state: "superseded", externalProductId: null });
    });
    it.each(["create", "match"] as const)("allows only one %s recreation when two reviewed requests compete for the same SKU", async method => {
      const { prior, next } = await acceptedRecreation("old-wpid", method);
      const competing = structuredClone(next); competing.review.id = testId(104);
      await repository.saveReview(competing, "other-operator", fixedNow);
      const results = await Promise.allSettled([
        repository.createOperation(input(next, 102, 103)), repository.createOperation(input(competing, 105, 106)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await counts()).operations).toBe(2);
      const owner = (await database.pool.query("SELECT operation_id FROM marketplace.channel_listing_item_claims")).rows[0].operation_id;
      expect((await repository.operation(104, prior.id)).progress.items[0].recreatedByOperationId).toBe(owner);
    });
    it.each(["create", "match"] as const)("rolls back %s supersession, claim transfer and draft consumption if final audit persistence fails", async method => {
      const { prior, next } = await acceptedRecreation("old-wpid", method);
      await database.pool.query(`CREATE OR REPLACE FUNCTION marketplace.reject_recreation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='publication_queued' THEN RAISE EXCEPTION 'forced recreation audit failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER test_reject_event BEFORE INSERT ON marketplace.channel_listing_publication_events
          FOR EACH ROW EXECUTE FUNCTION marketplace.reject_recreation_audit();`);
      await expect(repository.createOperation(input(next, 102, 103))).rejects.toThrow("forced recreation audit failure");
      expect((await repository.operation(104, prior.id)).progress).toEqual(prior.progress);
      expect((await repository.draft(104)).items).toEqual(next.draft.items);
      expect((await database.pool.query("SELECT operation_id FROM marketplace.channel_listing_item_claims")).rows[0].operation_id).toBe(prior.id);
      expect((await counts()).operations).toBe(1);
    });
    it("protects immutable review, operation intent, claims and audit evidence in PostgreSQL", async () => {
      const snapshot = await saveReview();
      await repository.createOperation(input(snapshot));
      await expect(
        database.pool.query(
          "UPDATE marketplace.channel_listing_reviews SET snapshot='{}'::jsonb",
        ),
      ).rejects.toThrow("immutable");
      await expect(
        database.pool.query(
          "DELETE FROM marketplace.channel_listing_publication_events",
        ),
      ).rejects.toThrow("immutable");
      await expect(
        database.pool.query(
          "UPDATE marketplace.channel_listing_operations SET snapshot='{}'::jsonb",
        ),
      ).rejects.toThrow("immutable");
      await expect(
        database.pool.query(
          "UPDATE marketplace.channel_listing_item_claims SET external_sku='OTHER'",
        ),
      ).rejects.toThrow("identity is immutable");
      await expect(
        database.pool.query(
          "DELETE FROM marketplace.channel_listing_item_claims",
        ),
      ).rejects.toThrow("immutable");
      expect(await counts()).toEqual({
        operations: 1,
        claims: 1,
        queued: 1,
        consumed: 1,
      });
    });
  },
);
