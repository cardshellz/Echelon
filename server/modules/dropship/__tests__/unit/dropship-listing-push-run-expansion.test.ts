import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { RUN_EXPANSION_SWEEP_BUDGET_MS, RUN_PRICE_INPUT_CLOCK_MARGIN_MS } from "../../domain/listing-push-run";
const selectedVariantIdsAmong = vi.hoisted(() => vi.fn());
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../application/dropship-selected-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-selected-catalog")>()),
  selectedVariantIdsAmong,
}));

import { PgDropshipListingPushRunSweepRepository } from "../../infrastructure/dropship-listing-push-run-sweep.repository";
import { makeSweepHarness, RUN_PRESS, SWEEP_NOW, sweepRunRecord } from "../fixtures/listing-push-run-sweep.fake";

/** Publish run expansion (step 1 plan S2-5, §4.3): one chunk per run per sweep, through the one job writer. */
describe("publish run expansion", () => {
  it("queues the lowest pending chunk through the job writer with the reserved key, the run chunk and the run's actor", async () => {
    const harness = makeSweepHarness();
    expect(await harness.service.expandRuns()).toEqual({ attempted: 1, queued: 1 });
    expect(harness.createChunkJob).toHaveBeenCalledWith({
      vendorId: 10, storeConnectionId: 22, productVariantIds: [101, 102, 103], reviewMode: "current_preview",
      idempotencyKey: "dropship-run:10:4:0", requestedBy: { actorType: "vendor", actorId: "member-10" },
      run: { runId: 4, chunkIndex: 0 },
    });
    expect(harness.repository.callsOf("recordChunkQueued")).toEqual([{ runId: 4, chunkIndex: 0, jobId: 900 }]);
    expect(harness.repository.outcomes()).toEqual([[101, "queued", null], [102, "queued", null], [103, "queued", null]]);
    expect(harness.logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_CHUNK_QUEUED"]);
  });

  it("adopts a chunk job a crash left unrecorded, by (run, chunk), and queues nothing new", async () => {
    const harness = makeSweepHarness();
    harness.repository.chunkJobs.set("4:0", 77);
    await harness.service.expandRuns();
    expect(harness.createChunkJob).not.toHaveBeenCalled();
    expect(harness.repository.callsOf("readChunkFacts")).toEqual([]);
    expect(harness.repository.callsOf("recordChunkQueued")).toEqual([{ runId: 4, chunkIndex: 0, jobId: 77 }]);
    expect(harness.logs[0].context).toMatchObject({ how: "adopted", jobId: 77 });
  });

  it("never adopts by key: a job that holds the chunk's key for something else fails the chunk for good, for a human", async () => {
    const harness = makeSweepHarness();
    harness.createChunkJob.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT", "taken"));
    await harness.service.expandRuns();
    expect(harness.repository.outcomes()).toEqual([
      [101, "failed", "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT"], [102, "failed", "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT"],
      [103, "failed", "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT"]]);
    expect(harness.logs.filter((event) => event.level === "error").map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT"]);
    // A unique violation on any job or item key is the same: never adopted, permanent.
    const raw = makeSweepHarness();
    raw.createChunkJob.mockRejectedValueOnce(Object.assign(new Error("duplicate key value"), { code: "23505" }));
    await raw.service.expandRuns();
    expect(raw.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["failed", "failed", "failed"]);
  });

  it("reads the facts of the chunk's own sizes only", async () => {
    const harness = makeSweepHarness();
    harness.repository.targets.set(4, [
      ...[101, 102].map((id) => ({ productVariantId: id, chunkIndex: 0, outcome: "queued", code: null })),
      ...[201, 202].map((id) => ({ productVariantId: id, chunkIndex: 1, outcome: "pending", code: null })),
      ...[301].map((id) => ({ productVariantId: id, chunkIndex: 2, outcome: "pending", code: null })),
    ]);
    await harness.service.expandRuns();
    expect(harness.repository.callsOf("readChunkFacts")).toEqual([{ runId: 4, productVariantIds: [201, 202], now: SWEEP_NOW }]);
    expect(harness.createChunkJob.mock.calls[0][0]).toMatchObject({ productVariantIds: [201, 202], run: { runId: 4, chunkIndex: 1 },
      idempotencyKey: "dropship-run:10:4:1" });
  });

  it("leaves out sizes no longer selected, and sizes live now for 'Publish new', before the job is created", async () => {
    const harness = makeSweepHarness();
    harness.repository.runs = [sweepRunRecord({ scope: "not_live" })];
    harness.repository.facts.set(101, { selected: false, live: false, priceInputsMoved: false });
    harness.repository.facts.set(102, { selected: true, live: true, priceInputsMoved: false });
    await harness.service.expandRuns();
    expect(harness.repository.callsOf("recordPrefilter")).toEqual([{ runId: 4, chunkIndex: 0, outcomes: [
      { productVariantId: 101, outcome: "skipped", code: "DROPSHIP_LISTING_NOT_SELECTED" },
      { productVariantId: 102, outcome: "skipped", code: "DROPSHIP_LISTING_ALREADY_LIVE" }] }]);
    expect(harness.createChunkJob.mock.calls[0][0].productVariantIds).toEqual([103]);
    // 'Publish all' re-sends a live size.
    const all = makeSweepHarness();
    all.repository.facts.set(102, { selected: true, live: true, priceInputsMoved: false });
    await all.service.expandRuns();
    expect(all.createChunkJob.mock.calls[0][0].productVariantIds).toEqual([101, 102, 103]);
  });

  it("queues no job when the pre-filter decided the whole chunk", async () => {
    const harness = makeSweepHarness();
    for (const id of [101, 102, 103]) harness.repository.facts.set(id, { selected: false, live: false, priceInputsMoved: false });
    expect(await harness.service.expandRuns()).toEqual({ attempted: 1, queued: 0 });
    expect(harness.createChunkJob).not.toHaveBeenCalled();
    expect(harness.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["skipped", "skipped", "skipped"]);
  });

  describe("price review (SAFETY8, D29)", () => {
    it("holds a live rule-priced size whose price input moved after the press, under 'wait for review'", async () => {
      const harness = makeSweepHarness({ policy: "wait_for_review" });
      harness.repository.facts.set(101, { selected: true, live: true, priceInputsMoved: true });
      harness.repository.facts.set(102, { selected: true, live: true, priceInputsMoved: true });
      harness.repository.facts.set(103, { selected: true, live: false, priceInputsMoved: true });
      harness.rulePriced.add(101);
      await harness.service.expandRuns();
      // One read-only check of the moved live sizes; 102 has a fixed price, 103 is not live yet.
      expect(harness.priceCheck).toHaveBeenCalledTimes(1);
      expect(harness.priceCheck.mock.calls[0][0]).toEqual({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101, 102] });
      expect(harness.repository.callsOf("recordPrefilter")).toEqual([{ runId: 4, chunkIndex: 0, outcomes: [
        { productVariantId: 101, outcome: "price_review", code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW" }] }]);
      expect(harness.createChunkJob.mock.calls[0][0].productVariantIds).toEqual([102, 103]);
    });

    it("holds a size eBay still lists while it is re-sent (failed or queued with its id), under 'Publish new' too (review MC3)", async () => {
      const harness = makeSweepHarness({ policy: "wait_for_review" });
      harness.repository.runs = [sweepRunRecord({ scope: "not_live" })];
      harness.repository.facts.set(101, { selected: true, live: false, onMarketplace: true, priceInputsMoved: true });
      harness.repository.facts.set(102, { selected: true, live: false, onMarketplace: false, priceInputsMoved: true });
      harness.rulePriced.add(101);
      harness.rulePriced.add(102);
      await harness.service.expandRuns();
      expect(harness.priceCheck.mock.calls[0][0]).toEqual({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101] });
      expect(harness.repository.callsOf("recordPrefilter")).toEqual([{ runId: 4, chunkIndex: 0, outcomes: [
        { productVariantId: 101, outcome: "price_review", code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW" }] }]);
      expect(harness.createChunkJob.mock.calls[0][0].productVariantIds).toEqual([102, 103]);
    });

    it("sends moved prices when the policy reprices by itself, or when nothing moved", async () => {
      const harness = makeSweepHarness({ policy: "reprice_automatically" });
      harness.repository.facts.set(101, { selected: true, live: true, priceInputsMoved: true });
      harness.rulePriced.add(101);
      await harness.service.expandRuns();
      expect(harness.priceCheck).not.toHaveBeenCalled();
      expect(harness.createChunkJob.mock.calls[0][0].productVariantIds).toEqual([101, 102, 103]);
      const unmoved = makeSweepHarness({ policy: "wait_for_review" });
      unmoved.repository.facts.set(101, { selected: true, live: true, priceInputsMoved: false });
      unmoved.rulePriced.add(101);
      await unmoved.service.expandRuns();
      expect(unmoved.priceCheck).not.toHaveBeenCalled();
    });
  });

  it("queues nothing when a stop came before the queue, and cancels what a stop racing the queue let through", async () => {
    const before = makeSweepHarness();
    before.repository.openForQueue = false;
    await before.service.expandRuns();
    expect(before.createChunkJob).not.toHaveBeenCalled();
    expect(before.repository.callsOf("recordChunkQueued")).toEqual([]);
    const raced = makeSweepHarness();
    raced.repository.stopRacesQueue = true;
    await raced.service.expandRuns();
    expect(raced.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(raced.logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_CHUNK_CANCELLED"]);
  });

  describe("failed queues (CLAUDE.md §6)", () => {
    const conflict = () => new DropshipError("DROPSHIP_CONTENT_VERSION_CONFLICT", "Listing content changed while queueing.");

    it("retries a content or price move twice, then queues", async () => {
      const harness = makeSweepHarness();
      harness.createChunkJob.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
      await harness.service.expandRuns();
      await harness.service.expandRuns();
      expect(harness.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["pending", "pending", "pending"]);
      await harness.service.expandRuns();
      expect(harness.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["queued", "queued", "queued"]);
      expect(harness.repository.callsOf("recordChunkFailure").map((call) => (call as { failure: unknown }).failure))
        .toEqual([{ kind: "conflict", code: "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT", maxAttempts: 3 },
          { kind: "conflict", code: "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT", maxAttempts: 3 }]);
    });

    it("marks the chunk stale after a third move", async () => {
      const harness = makeSweepHarness();
      harness.createChunkJob.mockRejectedValue(conflict());
      for (let sweep = 0; sweep < 3; sweep += 1) await harness.service.expandRuns();
      expect(harness.repository.outcomes()).toEqual([
        [101, "stale", "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT"], [102, "stale", "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT"],
        [103, "stale", "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT"]]);
      expect(harness.logs.filter((event) => event.level === "error")).toEqual([]);
    });

    it("fails the chunk for good on a permanent refusal, never retried", async () => {
      const harness = makeSweepHarness();
      harness.createChunkJob.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "Selling is paused on your account."));
      await harness.service.expandRuns();
      expect(harness.repository.outcomes().map(([, outcome, code]) => [outcome, code])).toEqual(
        Array(3).fill(["failed", "DROPSHIP_LISTING_VENDOR_BLOCKED"]));
      expect(harness.createChunkJob).toHaveBeenCalledTimes(1);
      expect(harness.repository.callsOf("recordChunkFailure")[0]).toMatchObject({ failure: { kind: "permanent" } });
    });

    it("fails only the sizes of a product whose stock could not be read, and queues the rest of the chunk next (verify V6)", async () => {
      const harness = makeSweepHarness();
      // 101 and 102 are product 1's sizes, 103 product 2's.
      for (const [productVariantId, productId] of [[101, 1], [102, 1], [103, 2]] as const) {
        harness.repository.target(4, productVariantId).productId = productId;
      }
      harness.createChunkJob.mockRejectedValueOnce(new DropshipError("DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE",
        "The canonical Dropship channel quantity could not be resolved for product 1: no rows", { productId: 1, retryable: false }));
      await harness.service.expandRuns();
      expect(harness.repository.outcomes()).toEqual([
        [101, "failed", "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE"], [102, "failed", "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE"],
        [103, "pending", null]]);
      expect(harness.repository.callsOf("recordChunkFailure")).toEqual([]);
      expect(harness.logs.at(-1)).toMatchObject({ level: "info", code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_PRODUCT_REFUSED",
        context: { productId: 1, decided: 2, chunkIndex: 0 } });
      // The next sweep queues the rest of the chunk.
      await harness.service.expandRuns();
      expect(harness.createChunkJob).toHaveBeenCalledTimes(2);
      expect(harness.createChunkJob.mock.calls[1][0]).toMatchObject({ productVariantIds: [103] });
      expect(harness.repository.outcomes().at(-1)).toEqual([103, "queued", null]);
    });

    it("fails the whole chunk as before when the named product has nothing pending in it, or its job already exists", async () => {
      const harness = makeSweepHarness();
      harness.createChunkJob.mockRejectedValueOnce(new DropshipError("DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE", "product 9", { productId: 9 }));
      await harness.service.expandRuns();
      expect(harness.repository.callsOf("recordChunkProductFailure")).toHaveLength(1);
      expect(harness.repository.outcomes().map(([, outcome, code]) => [outcome, code])).toEqual(
        Array(3).fill(["failed", "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE"]));

      const adopted = makeSweepHarness();
      adopted.repository.target(4, 101).productId = 1;
      adopted.repository.chunkJobs.set("4:0", 77);
      adopted.repository.failRecordChunkQueued = new DropshipError("DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE", "product 1", { productId: 1 });
      await adopted.service.expandRuns();
      // A chunk a job carries is never decided here: the next sweep adopts it.
      expect(adopted.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["pending", "pending", "pending"]);
    });

    it("retries a passing failure with a WARN, and after five fails the chunk, retryable, with an ERROR", async () => {
      const harness = makeSweepHarness();
      harness.createChunkJob.mockRejectedValue(new Error("Connection terminated unexpectedly"));
      for (let sweep = 0; sweep < 4; sweep += 1) await harness.service.expandRuns();
      expect(harness.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["pending", "pending", "pending"]);
      expect(harness.logs.map((event) => [event.level, event.code])).toEqual(Array(4).fill(["warn", "DROPSHIP_LISTING_PUSH_RUN_CHUNK_RETRYING"]));
      await harness.service.expandRuns();
      expect(harness.repository.outcomes()).toEqual([
        [101, "failed", "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_FAILED"], [102, "failed", "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_FAILED"],
        [103, "failed", "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_FAILED"]]);
      expect(harness.logs.at(-1)).toMatchObject({ level: "error", code: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_FAILED" });
    });

    it("retries a chunk whose job exists but whose record keeps failing: WARN, one ERROR at the limit, then INFO, never deciding it (review round 2 MC3)", async () => {
      const harness = makeSweepHarness();
      harness.repository.chunkJobs.set("4:0", 77);
      harness.repository.failRecordChunkQueued = new Error("canceling statement due to lock timeout");
      for (let sweep = 0; sweep < 7; sweep += 1) await harness.service.expandRuns();
      expect(harness.repository.outcomes().map(([, outcome]) => outcome)).toEqual(["pending", "pending", "pending"]);
      expect(harness.logs.map((event) => [event.level, event.code])).toEqual([
        ...Array(4).fill(["warn", "DROPSHIP_LISTING_PUSH_RUN_CHUNK_RETRYING"]),
        ["error", "DROPSHIP_LISTING_PUSH_RUN_CHUNK_RECORD_STUCK"],
        ...Array(2).fill(["info", "DROPSHIP_LISTING_PUSH_RUN_CHUNK_RECORD_STUCK"]),
      ]);
      expect(harness.logs[4].context).toMatchObject({ runId: 4, chunkIndex: 0, attempts: 5, chunkJobExists: true });
    });

    it("logs an ERROR and moves on when even the failure cannot be recorded", async () => {
      const harness = makeSweepHarness();
      harness.createChunkJob.mockRejectedValue(new Error("boom"));
      harness.repository.failRecordChunkFailure = new Error("database unavailable");
      await expect(harness.service.expandRuns()).resolves.toEqual({ attempted: 1, queued: 0 });
      expect(harness.logs.at(-1)).toMatchObject({ level: "error", code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_FAILURE_NOT_RECORDED" });
    });
  });

  it("expands at most two runs a sweep, oldest first, one chunk each, and stops starting once the budget is spent", async () => {
    const harness = makeSweepHarness();
    harness.repository.runs = [4, 5, 6].map((runId) => sweepRunRecord({ runId }));
    for (const runId of [5, 6]) {
      harness.repository.targets.set(runId, [
        { productVariantId: 101, chunkIndex: 0, outcome: "pending", code: null },
        { productVariantId: 102, chunkIndex: 1, outcome: "pending", code: null },
      ]);
    }
    await harness.service.expandRuns();
    expect(harness.repository.callsOf("listExpandableRuns")).toEqual([{ limit: 2 }]);
    expect(harness.createChunkJob.mock.calls.map(([input]) => input.run)).toEqual([{ runId: 4, chunkIndex: 0 }, { runId: 5, chunkIndex: 0 }]);

    const slow = makeSweepHarness();
    slow.repository.runs = [4, 5].map((runId) => sweepRunRecord({ runId }));
    slow.repository.targets.set(5, [{ productVariantId: 101, chunkIndex: 0, outcome: "pending", code: null }]);
    // The first run starts half a budget in; by the second, the budget is spent.
    slow.timer.advanceEachCall = RUN_EXPANSION_SWEEP_BUDGET_MS / 2 + 1;
    await slow.service.expandRuns();
    expect(slow.createChunkJob.mock.calls.map(([input]) => input.run)).toEqual([{ runId: 4, chunkIndex: 0 }]);
    expect(slow.logs.at(-1)).toMatchObject({ code: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_BUDGET_SPENT", context: { attempted: 1, remaining: 1 } });
  });

  it("reads the pre-filter facts in one read-only snapshot, over the chunk's ids, measuring moves from the press", async () => {
    selectedVariantIdsAmong.mockResolvedValue(new Set([101, 103]));
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        statements.push({ sql, values });
        if (sql.includes("FROM dropship.dropship_vendor_listings")) {
          return { rows: [{ product_variant_id: 101, status: "active", external_listing_id: "EBAY-1" },
            { product_variant_id: 103, status: "queued", external_listing_id: "EBAY-3" },
            { product_variant_id: 102, status: "failed", external_listing_id: "  " }] };
        }
        if (sql.includes("dropship_cost_schedule_entries")) return { rows: [{ product_variant_id: 101 }] };
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const repository = new PgDropshipListingPushRunSweepRepository({ query: client.query, connect: async () => client } as never);
    const facts = await repository.readChunkFacts({ run: sweepRunRecord(), productVariantIds: [103, 101, 102], now: SWEEP_NOW });
    expect(facts).toEqual([
      { productVariantId: 101, selected: true, live: true, onMarketplace: true, priceInputsMoved: true },
      // A blank id is no eBay listing, whatever the status.
      { productVariantId: 102, selected: false, live: false, onMarketplace: false, priceInputsMoved: false },
      // Being re-sent with its id: not live for 'Publish new', but listed on eBay (review MC3).
      { productVariantId: 103, selected: true, live: false, onMarketplace: true, priceInputsMoved: false },
    ]);
    expect(statements[0].sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)?.sql).toBe("COMMIT");
    expect(selectedVariantIdsAmong).toHaveBeenCalledWith(expect.objectContaining({ vendorId: 10 }), [101, 102, 103], SWEEP_NOW);
    const moved = statements.find((statement) => statement.sql.includes("dropship_cost_schedule_entries"))!;
    // Measured from the press less a clock margin (review round 2 MC6): revision times come from other dynos' clocks.
    expect(moved.values).toEqual([10, 22, [101, 102, 103], new Date(RUN_PRESS.getTime() - RUN_PRICE_INPUT_CLOCK_MARGIN_MS), SWEEP_NOW]);
    expect(RUN_PRICE_INPUT_CLOCK_MARGIN_MS).toBe(5_000);
    expect(moved.sql).toContain("c.withdrawn_at IS NULL");
    // A cost in force now that took effect, or was recorded, after the press (review MC6).
    expect(moved.sql).toContain("c.effective_at <= $5 AND (c.effective_at > $4 OR c.created_at > $4)");
    // Product and category price recipes saved after the press (review MC2), only when the recipe changed.
    expect(moved.sql).toContain("dropship.dropship_product_listing_setting_revisions pr");
    expect(moved.sql).toContain("pr.product_id = pv.product_id AND pr.vendor_id = $1");
    expect(moved.sql).toContain("dropship.dropship_category_listing_setting_revisions cr");
    expect(moved.sql).toContain("cr.category_id = p.category_id AND cr.vendor_id = $1");
    expect(moved.sql).toContain("pr.created_at > $4");
    expect(moved.sql).toContain("cr.created_at > $4");
    expect(moved.sql.match(/IS DISTINCT FROM \(prev\.price_basis, prev\.price_markup_bps, prev\.price_flat_cents, prev\.price_rounding\)/g))
      .toHaveLength(2);
    expect(moved.sql).toContain("lp.created_at > $4");
    expect(moved.sql).toContain("pp.created_at > $4");
    expect(statements.find((statement) => statement.sql.includes("FROM dropship.dropship_vendor_listings"))?.values).toEqual([10, 22, [101, 102, 103]]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
