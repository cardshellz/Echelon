import { describe, expect, it } from "vitest";
import type { CatalogJobLog } from "../../application/dropship-catalog-arrivals-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";
import { SELECTION_CHANGE_PLAN_MOVED, seededJitterSource } from "../../application/dropship-selection-change-service";
import {
  conversionFollowUpIdempotencyKey,
  DropshipSelectionConversionFollowUp,
  FOLLOW_UP_REPAIR_BATCH_SIZE,
  followUpRepairAction,
  type ConversionNoticeSender,
  type DropshipSelectionConversionFollowUpRepository,
  type FollowUpApplyTransaction,
  type FollowUpCatalogRow,
  type FollowUpDetectionReads,
  type OpenSelectionConversion,
  type SelectionConversionRecord,
} from "../../application/dropship-selection-conversion-followup";
import { CATALOG_ARRIVALS_ERROR_CODES } from "../../domain/catalog-arrivals";
import { DropshipError } from "../../domain/errors";
import { isReservedSelectionIdempotencyKey } from "../../domain/selection-release";
import type { DropshipVendorSelectionRule } from "../../domain/vendor-selection";

/**
 * The conversion follow-up on an in-memory model of its tables (PLAN-B v4.1
 * §11.2; §15.1). The fake computes the SQL twin's column the way
 * SELECTION_RULE_MATCH_SQL does, with one difference that stands for
 * HYPOTHESIS A10: its `lower()` folds ASCII letters only (as a C collation
 * would), so "ÉCOLE" and "école" differ in SQL and agree in TypeScript. A
 * row's SQL answer can also be forced, as a stubbed column. The apply
 * transaction rolls back whole on any error.
 */

const NOW = new Date("2026-10-24T09:01:00.000Z");

interface CatalogSize {
  productId: number;
  category: string | null;
  productLineIds: number[];
  productIsActive: boolean;
  variantIsActive: boolean;
}

interface Revision { id: number; vendorId: number; key: string; hash: string; kind: string; pickCount: number; result: unknown }

class World {
  conversions = new Map<number, SelectionConversionRecord & { followupAt: Date | null; noticeAt: Date | null; lastErrorCode: string | null }>();
  rules = new Map<number, DropshipVendorSelectionRule[]>();
  catalog = new Map<number, CatalogSize>();
  sqlForced = new Map<number, boolean>();
  /** Sizes created, or whose product, category or lines changed, since the conversion read them (not `asConverted`). */
  changedSinceConversion = new Set<number>();
  /** Each vendor's status; a vendor not named is active. */
  vendorStatuses = new Map<number, string>();
  picks = new Map<number, Map<number, string>>();
  offered = new Set<number>();
  listed = new Map<number, Set<number>>();
  revisions: Revision[] = [];
  audits: Array<{ vendorId: number; revisionId: number; payload: Record<string, unknown> }> = [];

  convert(vendorId: number, input: { followupState?: SelectionConversionRecord["followupState"]; noticeState?: SelectionConversionRecord["noticeState"] } = {}) {
    const backfill: Revision = { id: this.revisions.length + 1, vendorId, key: `legacy-picks-backfill:${vendorId}:0`, hash: "0".repeat(64),
      kind: "picks_backfill", pickCount: 0, result: null };
    this.revisions.push(backfill);
    this.conversions.set(vendorId, {
      vendorId, backfillRevisionId: backfill.id, followupState: input.followupState ?? "pending", noticeState: input.noticeState ?? "pending",
      followupFailures: 0, followupAt: input.followupState === "done" ? new Date("2026-10-24T08:00:00.000Z") : null, noticeAt: null,
      lastErrorCode: null,
    });
    return backfill.id;
  }

  size(id: number, size: Partial<CatalogSize> = {}): void {
    this.catalog.set(id, { productId: id, category: "Armalope", productLineIds: [], productIsActive: true, variantIsActive: true, ...size });
  }

  pick(vendorId: number, id: number, source = "legacy_broad_rule"): void {
    const picks = this.picks.get(vendorId) ?? new Map<number, string>();
    picks.set(id, source);
    this.picks.set(vendorId, picks);
  }

  vendorSaves(vendorId: number): void {
    this.revisions.push({ id: this.revisions.length + 1, vendorId, key: "vendor-key-1234", hash: "h", kind: "picks_change", pickCount: 0, result: {} });
  }

  pickIds(vendorId: number): Array<[number, string]> {
    return [...(this.picks.get(vendorId) ?? new Map()).entries()].sort(([a], [b]) => a - b);
  }

  row(vendorId: number, id: number): FollowUpCatalogRow | null {
    const size = this.catalog.get(id);
    if (!size) return null;
    const rules = (this.rules.get(vendorId) ?? []).filter((rule) => rule.isActive !== false);
    const matches = (rule: DropshipVendorSelectionRule) => sqlRuleMatches(rule, id, size);
    const sql = rules.some((rule) => rule.action === "include" && matches(rule)) && !rules.some((rule) => rule.action === "exclude" && matches(rule));
    return {
      productVariantId: id, productId: size.productId, productLineIds: size.productLineIds, category: size.category,
      productIsActive: size.productIsActive, variantIsActive: size.variantIsActive,
      pickSource: this.picks.get(vendorId)?.get(id) ?? null,
      asConverted: !this.changedSinceConversion.has(id),
      sqlRulesPick: this.sqlForced.get(id) ?? sql,
    };
  }

  clone(): World {
    const copy = new World();
    copy.conversions = new Map([...this.conversions].map(([key, value]) => [key, { ...value }]));
    copy.rules = this.rules;
    copy.catalog = this.catalog;
    copy.sqlForced = this.sqlForced;
    copy.changedSinceConversion = this.changedSinceConversion;
    copy.vendorStatuses = this.vendorStatuses;
    copy.picks = new Map([...this.picks].map(([key, value]) => [key, new Map(value)]));
    copy.offered = this.offered;
    copy.listed = this.listed;
    copy.revisions = [...this.revisions];
    copy.audits = [...this.audits];
    return copy;
  }

  restore(from: World): void {
    this.conversions = from.conversions;
    this.picks = from.picks;
    this.revisions = from.revisions;
    this.audits = from.audits;
  }
}

/** SELECTION_RULE_MATCH_SQL's semantics, with an ASCII-only lower() (HYPOTHESIS A10's difference). */
function sqlRuleMatches(rule: DropshipVendorSelectionRule, id: number, size: CatalogSize): boolean {
  const sqlNormalize = (value: string | null | undefined) => {
    if (value === null || value === undefined) return null;
    // The twin trims exactly what String.prototype.trim removes (JS_TRIM_CHARACTER_CLASS, pinned by the migration text test).
    const folded = value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    return folded === "" ? null : folded;
  };
  switch (rule.scopeType) {
    case "catalog": return true;
    case "product_line": return typeof rule.productLineId === "number" && size.productLineIds.includes(rule.productLineId);
    case "category": return sqlNormalize(rule.category) !== null && sqlNormalize(rule.category) === sqlNormalize(size.category);
    case "product": return rule.productId === size.productId;
    case "variant": return rule.productVariantId === id;
    default: return false;
  }
}

type FailurePoint = "lockConversion" | "preLock" | "deletePicks" | "insertRepairPicks" | "markFollowUpDone" | "readFrozenRules"
  | "listOpenConversions" | "recordFailure";

class FakeRepository implements DropshipSelectionConversionFollowUpRepository {
  applies = 0;
  /** Errors thrown at a point, in order, one per call that reaches it. */
  failures = new Map<FailurePoint, unknown[]>();
  /** Sizes a concurrent catalog delete removes just before the pre-lock (SAFETY-9), once. */
  deleteBeforePreLock: number[] = [];
  /** Runs once when an apply transaction begins: what another writer committed between the detection and the locks. */
  beforeApply: (() => void) | null = null;
  /** Sizes a concurrent catalog delete removes (their picks cascade) just before the pick count statement, once. */
  deleteBeforeCount: number[] = [];
  /** Sizes another connection deleted and committed: an apply's rollback never brings their picks back. */
  private committedCatalogDeletes = new Set<number>();

  /** Another connection's committed hard delete of sizes: their picks go with them (ON DELETE CASCADE). */
  private commitCatalogDelete(ids: readonly number[]): void {
    for (const id of ids) {
      this.world.catalog.delete(id);
      for (const picks of this.world.picks.values()) picks.delete(id);
      this.committedCatalogDeletes.add(id);
    }
  }

  constructor(private readonly world: World) {}

  private fail(point: FailurePoint): void {
    const queue = this.failures.get(point);
    if (queue && queue.length > 0) throw queue.shift();
  }

  async listOpenConversions(): Promise<OpenSelectionConversion[]> {
    this.fail("listOpenConversions");
    return [...this.world.conversions.values()]
      .filter((row) => row.followupState === "pending" || (row.noticeState === "pending" && row.followupState === "done"))
      .sort((a, b) => a.vendorId - b.vendorId)
      .map(({ vendorId, backfillRevisionId, followupState, noticeState, followupFailures }) => ({
        vendorId, backfillRevisionId, followupState, noticeState, followupFailures,
        vendorStatus: this.world.vendorStatuses.get(vendorId) ?? "active",
      }));
  }

  async readFrozenRules(vendorId: number): Promise<DropshipVendorSelectionRule[]> {
    this.fail("readFrozenRules");
    return (this.world.rules.get(vendorId) ?? []).filter((rule) => rule.isActive !== false);
  }

  detectionReads(): FollowUpDetectionReads {
    return {
      listRepairRowsAfter: async ({ vendorId, afterId, limit }) => [...this.world.catalog.keys()].filter((id) => id > afterId)
        .sort((a, b) => a - b).slice(0, limit).map((id) => this.world.row(vendorId, id)!),
      listBroadPickIdsAfter: async ({ vendorId, afterId, limit }) => this.world.pickIds(vendorId)
        .filter(([id, source]) => id > afterId && source === "legacy_broad_rule").map(([id]) => id).slice(0, limit),
      readOfferedAmong: async ({ productVariantIds }) => new Set(productVariantIds.filter((id) => this.world.offered.has(id))),
      readListedAmong: async ({ vendorId, productVariantIds }) =>
        new Set(productVariantIds.filter((id) => this.world.listed.get(vendorId)?.has(id))),
    };
  }

  async runApply<T>(input: { vendorId: number }, work: (tx: FollowUpApplyTransaction) => Promise<T>): Promise<T> {
    this.applies += 1;
    const concurrent = this.beforeApply;
    this.beforeApply = null;
    concurrent?.();
    const before = this.world.clone();
    const world = this.world;
    const tx: FollowUpApplyTransaction = {
      lockConversion: async (vendorId) => {
        this.fail("lockConversion");
        const row = world.conversions.get(vendorId);
        return row ? { vendorId, backfillRevisionId: row.backfillRevisionId, followupState: row.followupState, noticeState: row.noticeState,
          followupFailures: row.followupFailures } : null;
      },
      readHeadRevisionId: async (vendorId) => Math.max(0, ...world.revisions.filter((rev) => rev.vendorId === vendorId).map((rev) => rev.id)) || null,
      readRepairRows: async ({ vendorId, productVariantIds }) => productVariantIds.map((id) => world.row(vendorId, id))
        .filter((row): row is FollowUpCatalogRow => row !== null),
      readBroadPickIds: async ({ vendorId, productVariantIds }) =>
        new Set(productVariantIds.filter((id) => world.picks.get(vendorId)?.get(id) === "legacy_broad_rule")),
      readOfferedAmong: async ({ productVariantIds }) => new Set(productVariantIds.filter((id) => world.offered.has(id))),
      readListedAmong: async ({ vendorId, productVariantIds }) => new Set(productVariantIds.filter((id) => world.listed.get(vendorId)?.has(id))),
      countPicksOutside: async ({ vendorId, productVariantIds }) => {
        this.commitCatalogDelete(this.deleteBeforeCount.splice(0));
        const touched = new Set(productVariantIds);
        return [...(world.picks.get(vendorId)?.keys() ?? [])].filter((id) => !touched.has(id)).length;
      },
      insertRevision: async (revision) => {
        if (world.revisions.some((rev) => rev.vendorId === revision.vendorId && rev.key === revision.idempotencyKey)) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
        const id = world.revisions.length + 1;
        world.revisions.push({ id, vendorId: revision.vendorId, key: revision.idempotencyKey, hash: revision.requestHash,
          kind: "picks_conversion_followup", pickCount: revision.pickCount, result: revision.result });
        return id;
      },
      insertAudit: async (audit) => { world.audits.push({ vendorId: audit.vendorId, revisionId: audit.revisionId, payload: audit.payload }); },
      preLockVariants: async (ids) => {
        this.fail("preLock");
        this.commitCatalogDelete(this.deleteBeforePreLock.splice(0));
        return ids.filter((id) => world.catalog.has(id));
      },
      deletePicks: async ({ vendorId, productVariantIds }) => {
        this.fail("deletePicks");
        let deleted = 0;
        for (const id of productVariantIds) if (world.picks.get(vendorId)?.delete(id)) deleted += 1;
        return deleted;
      },
      insertRepairPicks: async ({ vendorId, productVariantIds }) => {
        this.fail("insertRepairPicks");
        let inserted = 0;
        for (const id of productVariantIds) {
          if (world.picks.get(vendorId)?.has(id)) continue;
          world.pick(vendorId, id, "conversion_repair");
          inserted += 1;
        }
        return inserted;
      },
      markFollowUpDone: async ({ vendorId, now }) => {
        this.fail("markFollowUpDone");
        const row = world.conversions.get(vendorId)!;
        if (row.followupState !== "pending") throw new Error("not pending");
        Object.assign(row, { followupState: "done", followupAt: now, followupFailures: 0 });
      },
    };
    void input;
    try {
      return await work(tx);
    } catch (error) {
      this.world.restore(before);
      for (const picks of this.world.picks.values()) for (const id of this.committedCatalogDeletes) picks.delete(id);
      throw error;
    }
  }

  async readSelectedCount({ vendorId }: { vendorId: number }): Promise<number> {
    return this.world.pickIds(vendorId).filter(([id]) => this.world.offered.has(id)).length;
  }

  async markNoticeSent({ vendorId, now }: { vendorId: number; now: Date }): Promise<void> {
    const row = this.world.conversions.get(vendorId)!;
    if (row.noticeState === "pending") Object.assign(row, { noticeState: "sent", noticeAt: now, followupFailures: 0 });
  }

  async recordFailure({ vendorId }: { vendorId: number }): Promise<number | null> {
    this.fail("recordFailure");
    const row = this.world.conversions.get(vendorId);
    if (!row || (row.followupState !== "pending" && row.noticeState !== "pending")) return null;
    row.followupFailures += 1;
    return row.followupFailures;
  }

  async markRequiresReview({ vendorId, stage, errorCode }: { vendorId: number; stage: "followup" | "notice"; errorCode: string }) {
    const row = this.world.conversions.get(vendorId)!;
    if (stage === "followup" && row.followupState === "pending") Object.assign(row, { followupState: "requires_review", lastErrorCode: errorCode });
    if (stage === "notice" && row.noticeState === "pending") Object.assign(row, { noticeState: "requires_review", lastErrorCode: errorCode });
  }
}

class FakeNotices implements ConversionNoticeSender {
  sends: Array<Parameters<ConversionNoticeSender["send"]>[0]> = [];
  stored = new Map<string, string>();
  muted = new Set<number>();
  failNext: unknown = null;

  async send(input: Parameters<ConversionNoticeSender["send"]>[0]) {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.sends.push(input);
    const hash = JSON.stringify([input.message, input.payload]);
    const existing = this.stored.get(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing !== hash) throw new DropshipError("DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT", "reused");
      return { events: [{}], idempotentReplay: true };
    }
    if (this.muted.has(input.vendorId)) return { events: [], idempotentReplay: false };
    this.stored.set(input.idempotencyKey, hash);
    return { events: [{}, {}], idempotentReplay: false };
  }
}

interface LogLine { level: keyof CatalogJobLog; action: string; fields: Record<string, unknown> }

function harness(world = new World()) {
  const repository = new FakeRepository(world);
  const notices = new FakeNotices();
  const logs: LogLine[] = [];
  const sleeps: number[] = [];
  const log: CatalogJobLog = {
    debug: (action, fields) => logs.push({ level: "debug", action, fields }),
    info: (action, fields) => logs.push({ level: "info", action, fields }),
    warn: (action, fields) => logs.push({ level: "warn", action, fields }),
    error: (action, fields) => logs.push({ level: "error", action, fields }),
  };
  const followUp = new DropshipSelectionConversionFollowUp({
    repository, notifications: notices, log, sleep: async (ms) => { sleeps.push(ms); }, random: seededJitterSource(7),
  });
  return { world, repository, notices, logs, sleeps, followUp };
}

const busy = () => Object.assign(new Error("PUBLICATION_SELECTION_BUSY"), { code: "55P03" });
const actions = (logs: LogLine[], action: string) => logs.filter((line) => line.action === action);

describe("the conversion follow-up (PLAN-B v4.1 §11.2)", () => {
  it("decides a repair only where the TS matcher and the SQL twin disagree on the same row", () => {
    const rules: DropshipVendorSelectionRule[] = [{ id: 1, scopeType: "category", action: "include", category: "Armalope", isActive: true }];
    const row = (overrides: Partial<FollowUpCatalogRow>): FollowUpCatalogRow => ({
      productVariantId: 1, productId: 1, productLineIds: [], category: "Armalope", productIsActive: true, variantIsActive: true,
      pickSource: null, asConverted: true, sqlRulesPick: true, ...overrides,
    });
    expect(followUpRepairAction(rules, row({}))).toBeNull(); // both true, no pick: a size created later
    expect(followUpRepairAction(rules, row({ sqlRulesPick: false }))).toBe("insert");
    expect(followUpRepairAction(rules, row({ sqlRulesPick: false, pickSource: "vendor" }))).toBeNull();
    expect(followUpRepairAction(rules, row({ category: "Toploaders", pickSource: "legacy_broad_rule" }))).toBe("delete");
    expect(followUpRepairAction(rules, row({ category: "Toploaders", pickSource: "legacy_variant_rule" }))).toBe("delete");
    expect(followUpRepairAction(rules, row({ category: "Toploaders", pickSource: "vendor" }))).toBeNull();
    expect(followUpRepairAction(rules, row({ category: "Toploaders", pickSource: "conversion_repair" }))).toBeNull();
    expect(followUpRepairAction(rules, row({ category: "Toploaders", sqlRulesPick: false, pickSource: "legacy_broad_rule" }))).toBeNull();
    // A size the conversion never decided as it stands (created, or its product, category or lines changed since): no
    // repair either way, even where the matchers disagree on it (FUP-1).
    expect(followUpRepairAction(rules, row({ sqlRulesPick: false, asConverted: false }))).toBeNull();
    expect(followUpRepairAction(rules, row({ category: "Toploaders", pickSource: "legacy_broad_rule", asConverted: false }))).toBeNull();
    expect(conversionFollowUpIdempotencyKey(20, 77)).toBe("legacy-picks-followup:20:77");
    expect(isReservedSelectionIdempotencyKey(conversionFollowUpIdempotencyKey(20, 77))).toBe(true);
  });

  it("repairs both ways on a TS/SQL disagreement, with a WARN, a revision keyed by the backfill revision and the audit ids (FIDELITY-1, SAFETY-1)", async () => {
    const h = harness();
    const backfill = h.world.convert(20);
    h.world.rules.set(20, [{ id: 1, scopeType: "category", action: "include", category: "ÉCOLE", isActive: true },
      { id: 2, scopeType: "category", action: "include", category: "Armalope", isActive: true }]);
    h.world.size(1, { category: "école" }); // TS true, SQL false (A10), never picked, not sellable or offered: inserted
    h.world.size(2, { category: "Armalope" });
    h.world.pick(20, 2);
    h.world.offered.add(2);
    h.world.size(3, { category: "Toploaders" }); // forced: SQL true, TS false, a legacy pick → deleted
    h.world.sqlForced.set(3, true);
    h.world.pick(20, 3);
    h.world.offered.add(3);
    h.world.listed.set(20, new Set([3]));
    h.world.size(4, { category: "Armalope" }); // forced: SQL false, TS true, no pick → inserted (the stubbed column)
    h.world.sqlForced.set(4, false);

    const result = await h.followUp.runStage(NOW);
    expect(result).toMatchObject({ conversionsRead: 1, followUpsDone: 1, noticesSent: 1, vendorsFailed: 0 });
    expect(h.world.pickIds(20)).toEqual([[1, "conversion_repair"], [2, "legacy_broad_rule"], [4, "conversion_repair"]]);
    const revision = h.world.revisions.at(-1)!;
    expect(revision).toMatchObject({ vendorId: 20, key: `legacy-picks-followup:20:${backfill}`, kind: "picks_conversion_followup", pickCount: 3,
      result: { inserted: 2, deleted: 1, repaired: 3, tidied: 0 } });
    expect(revision.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.world.audits).toEqual([{ vendorId: 20, revisionId: revision.id, payload: expect.objectContaining({
      outcome: "changed", backfillRevisionId: backfill, revisionId: revision.id, repairAllowed: true,
      repairedInsertedVariantIds: [1, 4], repairedDeletedVariantIds: [3], tidiedVariantIds: [],
    }) }]);
    expect(actions(h.logs, "dropship.selection.conversion_repaired")).toEqual([expect.objectContaining({ level: "warn",
      fields: expect.objectContaining({ inserted_variant_ids: [1, 4], deleted_variant_ids: [3], revision_id: revision.id }) })]);
    expect(h.world.conversions.get(20)).toMatchObject({ followupState: "done", followupAt: NOW, noticeState: "sent", noticeAt: NOW });
  });

  it("never repairs a size created, or a product moved, after the migration where both matchers agree on the current row (FIDELITY-1)", async () => {
    const h = harness();
    h.world.convert(21, { noticeState: "not_needed" });
    h.world.rules.set(21, [{ id: 1, scopeType: "category", action: "include", category: "Armalope", isActive: true }]);
    h.world.size(1, { category: "Toploaders" }); // moved out of Armalope since: its legacy pick stays (offered, so not tidied)
    h.world.pick(21, 1);
    h.world.offered.add(1);
    h.world.size(2, { category: "Armalope" }); // moved into Armalope since: no pick added
    h.world.size(3, { category: "Armalope" }); // created since: no pick added
    h.world.offered.add(2).add(3);

    await h.followUp.runStage(NOW);
    expect(h.world.pickIds(21)).toEqual([[1, "legacy_broad_rule"]]);
    expect(h.world.revisions.filter((rev) => rev.kind === "picks_conversion_followup")).toEqual([]);
    expect(h.world.audits).toEqual([{ vendorId: 21, revisionId: h.world.conversions.get(21)!.backfillRevisionId,
      payload: expect.objectContaining({ outcome: "nothing_to_change", revisionId: null }) }]);
    expect(actions(h.logs, "dropship.selection.conversion_repaired")).toEqual([]);
    expect(h.world.conversions.get(21)).toMatchObject({ followupState: "done", noticeState: "not_needed" });
    expect(h.notices.sends).toEqual([]);
  });

  it("never repairs a size created or moved since the conversion, even where the matchers disagree on it (FUP-1)", async () => {
    const h = harness();
    h.world.convert(40, { noticeState: "not_needed" });
    h.world.rules.set(40, [{ id: 1, scopeType: "category", action: "include", category: "ÉCOLE", isActive: true }]);
    h.world.size(1, { category: "école" }); // as the conversion read it: TS true, SQL false, no pick → repaired
    h.world.size(2, { category: "école" }); // created since: the same disagreement, but the conversion never decided it
    h.world.changedSinceConversion.add(2);
    h.world.size(3, { category: "Toploaders" }); // moved out of école since, with its legacy pick: forced SQL true, TS false
    h.world.sqlForced.set(3, true);
    h.world.pick(40, 3);
    h.world.offered.add(3);
    h.world.changedSinceConversion.add(3);
    h.world.size(4, { category: "école" }); // moved into école since, unpicked and listed by the vendor
    h.world.changedSinceConversion.add(4);
    h.world.listed.set(40, new Set([4]));

    await h.followUp.runStage(NOW);
    expect(h.world.pickIds(40)).toEqual([[1, "conversion_repair"], [3, "legacy_broad_rule"]]);
    expect(h.world.audits).toEqual([expect.objectContaining({ payload: expect.objectContaining({
      repairedInsertedVariantIds: [1], repairedDeletedVariantIds: [], tidiedVariantIds: [] }) })]);
    expect(actions(h.logs, "dropship.selection.conversion_repaired")).toEqual([expect.objectContaining({
      fields: expect.objectContaining({ inserted_variant_ids: [1], deleted_variant_ids: [] }) })]);
  });

  it("counts the revision's picks from the plan's own reads: a tidied size the catalog deletes before the count re-plans, never a fatal negative count", async () => {
    const h = harness();
    h.world.convert(41, { noticeState: "not_needed" });
    h.world.rules.set(41, [{ id: 1, scopeType: "catalog", action: "include", isActive: true }]);
    h.world.size(1);
    h.world.pick(41, 1); // the vendor's only pick: not offered, never listed, so tidied
    // The catalog deletes size 1 (its pick cascades) after the tidy re-check read it and before the count statement.
    h.repository.deleteBeforeCount = [1];
    const result = await h.followUp.runStage(NOW);
    expect(result).toMatchObject({ followUpsDone: 1, vendorsFailed: 0 });
    // The first attempt counted 0 + 1 picked before, so 0 after (never -1); its delete then found no row and re-planned.
    expect(h.repository.applies).toBe(2);
    expect(actions(h.logs, "dropship.selection.conversion_followup_retry")[0]?.fields.error_code).toBe(SELECTION_CHANGE_PLAN_MOVED);
    expect(h.world.pickIds(41)).toEqual([]);
    expect(h.world.revisions.filter((rev) => rev.kind === "picks_conversion_followup")).toEqual([]);
    expect(h.world.audits).toEqual([expect.objectContaining({ payload: expect.objectContaining({ outcome: "nothing_to_change" }) })]);
    expect(h.logs.filter((line) => line.level === "warn" || line.level === "error")).toEqual([]);
  });

  it("counts the revision's picks as the rows outside the change plus the picks it read: inserts add, deletes remove", async () => {
    const h = harness();
    h.world.convert(42, { noticeState: "not_needed" });
    h.world.rules.set(42, [{ id: 1, scopeType: "catalog", action: "include", isActive: true }]);
    for (const id of [1, 2, 3, 4]) h.world.size(id);
    for (const id of [1, 2]) {
      h.world.pick(42, id);
      h.world.offered.add(id);
    }
    h.world.pick(42, 3); // tidied
    h.world.sqlForced.set(4, false); // repaired in
    h.world.pick(42, 9, "vendor"); // a pick of a size outside the catalog walk still counts
    await h.followUp.runStage(NOW);
    expect(h.world.pickIds(42).map(([id]) => id)).toEqual([1, 2, 4, 9]);
    expect(h.world.revisions.at(-1)).toMatchObject({ kind: "picks_conversion_followup", pickCount: 4 });
  });

  it("defers the conversion notice while the vendor may not open the catalog, and sends it once it may (JOB-1)", async () => {
    const h = harness();
    h.world.convert(43);
    h.world.convert(44);
    h.world.vendorStatuses.set(43, "suspended");
    h.world.vendorStatuses.set(44, "paused");
    h.world.size(1);
    h.world.pick(43, 1);
    h.world.offered.add(1);
    const first = await h.followUp.runStage(NOW);
    // The follow-up itself runs for both; only the notice waits for the blocked vendor.
    expect(first).toMatchObject({ conversionsRead: 2, followUpsDone: 2, noticesSent: 1, noticesDeferred: 1, vendorsFailed: 0 });
    expect(h.notices.sends.map((send) => send.vendorId)).toEqual([44]);
    expect(h.world.conversions.get(43)).toMatchObject({ followupState: "done", noticeState: "pending", noticeAt: null, followupFailures: 0 });
    expect(actions(h.logs, "dropship.selection.conversion_notice_deferred")).toEqual([{ level: "debug",
      action: "dropship.selection.conversion_notice_deferred",
      fields: { outcome: "deferred", vendor_id: 43, vendor_status: "suspended", backfill_revision_id: h.world.conversions.get(43)!.backfillRevisionId } }]);

    for (const status of ["closed", "lapsed"]) {
      h.world.vendorStatuses.set(43, status);
      await expect(h.followUp.runStage(NOW)).resolves.toMatchObject({ conversionsRead: 1, noticesSent: 0, noticesDeferred: 1 });
    }
    expect(h.repository.applies).toBe(2);

    h.world.vendorStatuses.set(43, "active");
    await expect(h.followUp.runStage(NOW)).resolves.toMatchObject({ conversionsRead: 1, noticesSent: 1, noticesDeferred: 0 });
    expect(h.notices.sends.map((send) => [send.vendorId, send.payload])).toEqual([
      [44, { selectedCount: 0, backfillRevisionId: h.world.conversions.get(44)!.backfillRevisionId }],
      [43, { selectedCount: 1, backfillRevisionId: h.world.conversions.get(43)!.backfillRevisionId }],
    ]);
    expect(h.world.conversions.get(43)).toMatchObject({ noticeState: "sent", noticeAt: NOW });
    expect(h.logs.filter((line) => line.level === "warn" || line.level === "error")).toEqual([]);
  });

  it("walks every catalog size in keyset batches, not only picks (SAFETY-1)", async () => {
    const h = harness();
    h.world.convert(22, { noticeState: "not_needed" });
    h.world.rules.set(22, [{ id: 1, scopeType: "catalog", action: "include", isActive: true }]);
    const count = FOLLOW_UP_REPAIR_BATCH_SIZE * 2 + 3;
    for (let id = 1; id <= count; id += 1) {
      h.world.size(id);
      h.world.pick(22, id);
      h.world.offered.add(id);
    }
    h.world.size(count + 1); // the last size, after two full batches, unpicked and forced SQL false
    h.world.sqlForced.set(count + 1, false);
    await h.followUp.runStage(NOW);
    expect(h.world.picks.get(22)?.get(count + 1)).toBe("conversion_repair");
  });

  it("tidies only broad picks of sizes not offered and never listed, keeping the rest (incl. a non-sellable one)", async () => {
    const h = harness();
    h.world.convert(23);
    h.world.rules.set(23, [{ id: 1, scopeType: "catalog", action: "include", isActive: true },
      { id: 2, scopeType: "variant", action: "include", productVariantId: 2, isActive: true }]);
    for (const id of [1, 2, 3, 4, 5, 6]) h.world.size(id);
    h.world.pick(23, 1); // broad, not offered (non-sellable or hidden), never listed: tidied
    h.world.pick(23, 2, "legacy_variant_rule"); // a hidden variant pick: kept
    h.world.pick(23, 3); // a hidden broad pick with a listing row: kept (sells again when offered)
    h.world.listed.set(23, new Set([3]));
    h.world.pick(23, 4); // broad and offered: kept
    h.world.offered.add(4);
    h.world.pick(23, 5, "vendor"); // the vendor's own pick: kept
    h.world.pick(23, 6); // broad, not offered, never listed: tidied
    await h.followUp.runStage(NOW);
    expect(h.world.pickIds(23)).toEqual([[2, "legacy_variant_rule"], [3, "legacy_broad_rule"], [4, "legacy_broad_rule"], [5, "vendor"]]);
    expect(h.world.audits.at(-1)?.payload).toMatchObject({ tidiedVariantIds: [1, 6], repairedInsertedVariantIds: [], counts: { tidied: 2 } });
    expect(h.world.revisions.at(-1)).toMatchObject({ kind: "picks_conversion_followup", pickCount: 4 });
    // n = the selected count after the follow-up (picked and offered): size 4 only.
    expect(h.notices.sends).toEqual([expect.objectContaining({ vendorId: 23, payload: { selectedCount: 1, backfillRevisionId: 1 } })]);
  });

  it("repairs nothing once the vendor saved since the conversion, while the tidy and the notice still run", async () => {
    const h = harness();
    h.world.convert(24);
    h.world.rules.set(24, [{ id: 1, scopeType: "category", action: "include", category: "Armalope", isActive: true }]);
    h.world.size(1);
    h.world.sqlForced.set(1, false); // would be repaired
    h.world.size(2);
    h.world.pick(24, 2); // not offered, never listed: tidied
    h.world.vendorSaves(24);
    await h.followUp.runStage(NOW);
    expect(h.world.pickIds(24)).toEqual([]);
    expect(h.world.audits.at(-1)?.payload).toMatchObject({ repairAllowed: false, repairedInsertedVariantIds: [], tidiedVariantIds: [2] });
    expect(h.world.conversions.get(24)).toMatchObject({ followupState: "done", noticeState: "sent" });
  });

  it("writes no revision and no picks when nothing changes, and a re-run after done writes nothing (CLAUDE.md §7)", async () => {
    const h = harness();
    h.world.convert(25, { noticeState: "not_needed" });
    h.world.rules.set(25, [{ id: 1, scopeType: "category", action: "include", category: "Armalope", isActive: true }]);
    h.world.size(1);
    h.world.pick(25, 1);
    h.world.offered.add(1);
    await h.followUp.runStage(NOW);
    const revisions = h.world.revisions.length;
    expect(h.world.audits).toHaveLength(1);
    expect(h.world.pickIds(25)).toEqual([[1, "legacy_broad_rule"]]);
    const again = await h.followUp.runStage(new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ conversionsRead: 0, followUpsDone: 0 });
    expect(h.world.revisions).toHaveLength(revisions);
    expect(h.world.audits).toHaveLength(1);
    expect(h.repository.applies).toBe(1);
  });

  it("re-checks the tidy under the locks: a size listed since the detection keeps its pick", async () => {
    const h = harness();
    h.world.convert(38, { noticeState: "not_needed" });
    h.world.size(1);
    h.world.size(2);
    h.world.pick(38, 1);
    h.world.pick(38, 2);
    // Both are tidy candidates at detection; size 2 gets a listing row before the apply takes its locks.
    h.repository.beforeApply = () => { h.world.listed.set(38, new Set([2])); };
    await h.followUp.runStage(NOW);
    expect(h.world.pickIds(38)).toEqual([[2, "legacy_broad_rule"]]);
    expect(h.world.audits.at(-1)?.payload).toMatchObject({ tidiedVariantIds: [1] });
  });

  it("writes nothing when another process finished the follow-up between the read and the lock", async () => {
    const h = harness();
    h.world.convert(39, { noticeState: "not_needed" });
    h.world.size(1);
    h.world.pick(39, 1);
    h.repository.beforeApply = () => {
      Object.assign(h.world.conversions.get(39)!, { followupState: "done", followupAt: new Date("2026-10-24T09:00:30.000Z") });
    };
    const result = await h.followUp.runStage(NOW);
    expect(result).toMatchObject({ followUpsDone: 0, vendorsFailed: 0 });
    expect(h.world.pickIds(39)).toEqual([[1, "legacy_broad_rule"]]);
    expect(h.world.audits).toEqual([]);
    expect(h.world.revisions.filter((rev) => rev.kind === "picks_conversion_followup")).toEqual([]);
    expect(h.logs.filter((line) => line.level === "error" || line.level === "warn")).toEqual([]);
  });

  it("sends only the notice for a done follow-up with a pending notice: no revision, audit or picks write (SAFETY-6)", async () => {
    const h = harness();
    h.world.convert(26, { followupState: "done", noticeState: "pending" });
    h.world.size(1);
    h.world.pick(26, 1);
    h.world.offered.add(1);
    const revisions = h.world.revisions.length;
    const result = await h.followUp.runStage(NOW);
    expect(result).toMatchObject({ conversionsRead: 1, followUpsDone: 0, noticesSent: 1 });
    expect(h.repository.applies).toBe(0);
    expect(h.world.revisions).toHaveLength(revisions);
    expect(h.world.audits).toEqual([]);
    expect(h.notices.sends).toEqual([{
      vendorId: 26, eventType: DROPSHIP_NOTIFICATION_EVENTS.SELECTION_RULES_CONVERTED, critical: false,
      title: "Your automatic choices were turned into items",
      message: "Your setting that added new items by itself (for a category, a product or everything) has been replaced. The 1 item it "
        + "covered today stays chosen. When Card Shellz adds new items to a category you sell from, you'll see them in Catalog, step 1, "
        + "and nothing is added until you choose it.",
      payload: { selectedCount: 1, backfillRevisionId: 1 }, idempotencyKey: "selection-rules-converted:26",
    }]);
    expect(h.world.conversions.get(26)).toMatchObject({ noticeState: "sent", noticeAt: NOW });
    await h.followUp.runStage(NOW);
    expect(h.notices.sends).toHaveLength(1);
  });

  it("counts a notice replay mismatch and a muted notice as sent", async () => {
    const h = harness();
    h.world.convert(27, { followupState: "done" });
    h.world.convert(28, { followupState: "done" });
    h.notices.stored.set("selection-rules-converted:27", "an earlier count");
    h.notices.muted.add(28);
    await h.followUp.runStage(NOW);
    expect(h.world.conversions.get(27)).toMatchObject({ noticeState: "sent" });
    expect(h.world.conversions.get(28)).toMatchObject({ noticeState: "sent" });
    expect(actions(h.logs, "dropship.selection.conversion_notice_replay_mismatch")).toEqual([expect.objectContaining({ level: "debug" })]);
    expect(actions(h.logs, "dropship.selection.conversion_notice_sent").map((line) => line.fields.outcome)).toEqual(["replay_mismatch", "muted"]);
  });

  it("retries a busy apply like the save, and leaves it pending at DEBUG with no streak when it stays busy", async () => {
    const h = harness();
    h.world.convert(29);
    h.world.size(1);
    h.world.pick(29, 1); // to tidy: the delete takes the gate
    h.repository.failures.set("deletePicks", [busy(), busy(), Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" })]);
    const result = await h.followUp.runStage(NOW);
    expect(result).toMatchObject({ followUpsBusy: 1, followUpsDone: 0, noticesSent: 0, vendorsFailed: 0 });
    expect(h.repository.applies).toBe(4);
    expect(h.sleeps).toHaveLength(3);
    h.sleeps.forEach((ms, index) => expect(ms).toBeGreaterThanOrEqual([125, 250, 500][index]));
    // Rolled back whole each time: no revision, audit or pick change.
    expect(h.world.pickIds(29)).toEqual([[1, "legacy_broad_rule"]]);
    expect(h.world.audits).toEqual([]);
    expect(h.world.conversions.get(29)).toMatchObject({ followupState: "pending", followupFailures: 0, noticeState: "pending" });
    expect(actions(h.logs, "dropship.selection.conversion_followup_deferred")).toEqual([expect.objectContaining({ level: "debug",
      fields: expect.objectContaining({ attempt_error_codes: ["55P03", "55P03", "40P01", "55P03"], error_class: "transient" }) })]);
    expect(h.logs.filter((line) => line.level === "warn" || line.level === "error")).toEqual([]);

    // Next tick: the gate is free.
    await h.followUp.runStage(NOW);
    expect(h.world.conversions.get(29)).toMatchObject({ followupState: "done", noticeState: "sent" });
  });

  it("re-plans when a size the repair inserts was deleted before the pre-lock, and writes only what still exists (SAFETY-9)", async () => {
    const h = harness();
    h.world.convert(30, { noticeState: "not_needed" });
    h.world.rules.set(30, [{ id: 1, scopeType: "catalog", action: "include", isActive: true }]);
    h.world.size(1);
    h.world.size(2);
    h.world.sqlForced.set(1, false);
    h.world.sqlForced.set(2, false);
    h.repository.deleteBeforePreLock = [2];
    await h.followUp.runStage(NOW);
    expect(h.repository.applies).toBe(2);
    expect(h.world.pickIds(30)).toEqual([[1, "conversion_repair"]]);
    expect(h.world.audits.at(-1)?.payload).toMatchObject({ repairedInsertedVariantIds: [1] });
    expect(actions(h.logs, "dropship.selection.conversion_followup_retry")[0]?.fields.error_code).toBe(SELECTION_CHANGE_PLAN_MOVED);
  });

  it("counts a transient failure in the row's streak, WARN each time and one ERROR at the third; a success resets it", async () => {
    const h = harness();
    h.world.convert(31, { noticeState: "not_needed" });
    const transient = () => new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "unreachable", { classification: "transient" });
    h.repository.failures.set("readFrozenRules", [transient(), transient(), transient()]);
    for (let tick = 0; tick < 3; tick += 1) await h.followUp.runStage(NOW);
    expect(actions(h.logs, "dropship.selection.conversion_followup_failed").map((line) => [line.level, line.fields.followup_failures, line.fields.error_code]))
      .toEqual([["warn", 1, "DROPSHIP_LISTING_SETTINGS_BUSY"], ["warn", 2, "DROPSHIP_LISTING_SETTINGS_BUSY"],
        ["warn", 3, "DROPSHIP_LISTING_SETTINGS_BUSY"], ["error", 3, CATALOG_ARRIVALS_ERROR_CODES.followUpFailed]]);
    expect(h.world.conversions.get(31)).toMatchObject({ followupState: "pending", followupFailures: 3 });
    await h.followUp.runStage(NOW);
    expect(h.world.conversions.get(31)).toMatchObject({ followupState: "done", followupFailures: 0 });
  });

  it("moves a permanent failure to requires_review with its code, one ERROR, and never reads the row again", async () => {
    const h = harness();
    h.world.convert(32);
    h.world.convert(33, { noticeState: "not_needed" });
    h.world.size(1);
    h.world.pick(32, 1);
    h.repository.failures.set("deletePicks", [Object.assign(new Error("violates check constraint"), { code: "23514" })]);
    const first = await h.followUp.runStage(NOW);
    expect(first).toMatchObject({ conversionsRead: 2, vendorsFailed: 1, requiresReview: 1, followUpsDone: 1 });
    expect(h.world.conversions.get(32)).toMatchObject({ followupState: "requires_review", lastErrorCode: "23514", noticeState: "pending" });
    expect(actions(h.logs, "dropship.selection.conversion_followup_requires_review")).toEqual([expect.objectContaining({ level: "error",
      fields: expect.objectContaining({ error_code: CATALOG_ARRIVALS_ERROR_CODES.followUpRequiresReview, cause_code: "23514", error_class: "permanent",
        stage: "followup" }) })]);
    // One vendor's failure did not block the other.
    expect(h.world.conversions.get(33)).toMatchObject({ followupState: "done" });
    const second = await h.followUp.runStage(NOW);
    expect(second.conversionsRead).toBe(0);
    expect(h.repository.applies).toBe(2);
  });

  it("moves a notice that fails permanently to requires_review, the follow-up staying done", async () => {
    const h = harness();
    h.world.convert(34, { followupState: "done" });
    h.notices.failNext = new DropshipError("DROPSHIP_NOTIFICATION_INVALID_SEND", "Dropship notification input failed validation.");
    await h.followUp.runStage(NOW);
    expect(h.world.conversions.get(34)).toMatchObject({ followupState: "done", noticeState: "requires_review",
      lastErrorCode: "DROPSHIP_NOTIFICATION_INVALID_SEND" });
    expect(actions(h.logs, "dropship.selection.conversion_followup_requires_review")[0]?.fields.stage).toBe("notice");
  });

  it("keeps a lost connection pending at DEBUG with no streak, and a fault at ERROR with the streak", async () => {
    const h = harness();
    h.world.convert(35, { noticeState: "not_needed" });
    h.repository.failures.set("lockConversion", [new Error("Connection terminated unexpectedly"), new TypeError("undefined is not a function")]);
    await h.followUp.runStage(NOW);
    expect(h.world.conversions.get(35)).toMatchObject({ followupState: "pending", followupFailures: 0 });
    expect(actions(h.logs, "dropship.selection.conversion_followup_deferred")).toEqual([expect.objectContaining({ level: "debug" })]);
    await h.followUp.runStage(NOW);
    expect(h.world.conversions.get(35)).toMatchObject({ followupState: "pending", followupFailures: 1 });
    expect(actions(h.logs, "dropship.selection.conversion_followup_failed")).toEqual([expect.objectContaining({ level: "error",
      fields: expect.objectContaining({ error_class: "fatal", error_message: "undefined is not a function", followup_failures: 1 }) })]);
  });

  it("aborts the stage when the conversions cannot be read, for the tick to classify", async () => {
    const h = harness();
    h.repository.failures.set("listOpenConversions", [Object.assign(new Error("relation does not exist"), { code: "42P01" })]);
    await expect(h.followUp.runStage(NOW)).rejects.toMatchObject({ code: "42P01" });
  });

  it("logs the failure when even the row's streak cannot be written, and goes on", async () => {
    const h = harness();
    h.world.convert(36, { noticeState: "not_needed" });
    h.world.convert(37, { noticeState: "not_needed" });
    h.repository.failures.set("readFrozenRules", [new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "x", { classification: "transient" })]);
    h.repository.failures.set("recordFailure", [new Error("Connection terminated unexpectedly")]);
    await h.followUp.runStage(NOW);
    expect(actions(h.logs, "dropship.selection.conversion_followup_failed")).toEqual([expect.objectContaining({ level: "error",
      fields: expect.objectContaining({ vendor_id: 36, state_write_error: "Connection terminated unexpectedly" }) })]);
    expect(h.world.conversions.get(37)).toMatchObject({ followupState: "done" });
  });
});
