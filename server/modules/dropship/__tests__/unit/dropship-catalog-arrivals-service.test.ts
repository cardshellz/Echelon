import { describe, expect, it } from "vitest";
import {
  CATALOG_ARRIVALS_BASELINE_STATEMENT_TIMEOUT_MS,
  CATALOG_ARRIVALS_LEDGER_BATCH_SIZE,
  DropshipCatalogArrivalsService,
  type CatalogAcknowledgeTransaction,
  type CatalogArrivalsLedgerSession,
  type CatalogArrivalsNotifications,
  type CatalogConversionFollowUpStage,
  type CatalogJobLog,
  type CatalogNewForVendorFacts,
  type DropshipCatalogArrivalsRepository,
} from "../../application/dropship-catalog-arrivals-service";
import type { ConversionFollowUpStageResult } from "../../application/dropship-selection-conversion-followup";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";
import {
  CATALOG_ARRIVALS_ERROR_CODES,
  type CatalogArrivalInsert,
  type CatalogArrivalSubject,
  type CatalogNoticeMark,
} from "../../domain/catalog-arrivals";
import { evaluateDropshipCatalogExposure, type DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import { DropshipError } from "../../domain/errors";

/**
 * The arrivals job's service on an in-memory model of its tables
 * (PLAN-B v4.1 §11.1, §11.3, §11.4; §15.1): the fake repository applies the
 * same rules its SQL does (ON CONFLICT on (size, category), GREATEST on the
 * marks, a transaction that rolls back whole), and the fake notification
 * service stores events by key, replays a key or refuses a changed request
 * under it, and stores nothing for a vendor who muted the event.
 */

const DAY1_9AM = new Date("2026-10-24T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CATALOG_INCLUDE: DropshipCatalogExposureRule = { id: 1, scopeType: "catalog", action: "include" };

interface Size {
  productId: number;
  categoryId: number | null;
  category: string | null;
  sellable: boolean;
  productIsActive: boolean;
}

interface Arrival extends CatalogArrivalInsert { id: number; baseline: boolean; firstSeenAt: Date }

class World {
  sizes = new Map<number, Size>();
  exposureRules: DropshipCatalogExposureRule[] = [CATALOG_INCLUDE];
  arrivals: Arrival[] = [];
  marks = new Map<string, { seen: number; notified: number }>();
  picks = new Map<number, Set<number>>();
  turnedOff = new Map<number, Set<number>>();
  categoryNames = new Map<number, string>([[7, "Armalope"], [8, "Toploaders"], [9, "Sleeves"]]);
  audits: Array<Record<string, unknown>> = [];
  /** Each vendor's status; a vendor not named is active. */
  vendorStatuses = new Map<number, string>();

  addSize(id: number, size: Partial<Size> = {}): void {
    this.sizes.set(id, { productId: 100, categoryId: 7, category: "Armalope", sellable: true, productIsActive: true, ...size });
  }

  pick(vendorId: number, ...ids: number[]): void {
    const picked = this.picks.get(vendorId) ?? new Set<number>();
    for (const id of ids) picked.add(id);
    this.picks.set(vendorId, picked);
  }

  mark(vendorId: number, categoryId: number): { seen: number; notified: number } | undefined {
    return this.marks.get(`${vendorId}:${categoryId}`);
  }

  subject(id: number): CatalogArrivalSubject | null {
    const size = this.sizes.get(id);
    if (!size || !size.sellable) return null;
    return { productVariantId: id, productId: size.productId, productLineIds: [], category: size.category, categoryId: size.categoryId,
      productIsActive: size.productIsActive, variantIsActive: true };
  }
}

class FakeRepository implements DropshipCatalogArrivalsRepository {
  ledgerTransactions: Array<{ statementTimeoutMs: number }> = [];
  insertArrivalsCalls = 0;
  failInsertArrivalsOnCall: { call: number; error: unknown } | null = null;
  failAdvanceOnce: unknown = null;
  vendorsListed = 0;
  newForVendorReads: Array<{ vendorId: number; watermark: string; categoryIds: readonly number[] }> = [];

  constructor(private readonly world: World) {}

  private session(arrivals: Arrival[]): CatalogArrivalsLedgerSession {
    const world = this.world;
    return {
      listSellableVariantIdsAfter: async (afterId, limit) => [...world.sizes.entries()]
        .filter(([id, size]) => id > afterId && size.sellable).map(([id]) => id).sort((a, b) => a - b).slice(0, limit),
      readArrivalSubjects: async (ids) => ids.map((id) => world.subject(id)).filter((row): row is CatalogArrivalSubject => row !== null),
      listCatalogExposureRules: async () => [...world.exposureRules],
      ledgerIsEmpty: async () => arrivals.length === 0,
      insertArrivals: async ({ rows, baseline, now }) => {
        this.insertArrivalsCalls += 1;
        if (this.failInsertArrivalsOnCall?.call === this.insertArrivalsCalls) throw this.failInsertArrivalsOnCall.error;
        let inserted = 0;
        for (const row of rows) {
          if (arrivals.some((existing) => existing.productVariantId === row.productVariantId && existing.categoryId === row.categoryId)) continue;
          arrivals.push({ ...row, id: (arrivals.at(-1)?.id ?? 0) + 1, baseline, firstSeenAt: now });
          inserted += 1;
        }
        return inserted;
      },
    };
  }

  async runLedgerTransaction<T>(input: { statementTimeoutMs: number }, work: (session: CatalogArrivalsLedgerSession) => Promise<T>): Promise<T> {
    this.ledgerTransactions.push(input);
    const staged = [...this.world.arrivals];
    const result = await work(this.session(staged));
    this.world.arrivals = staged; // COMMIT; a throw above leaves the ledger as it was (ROLLBACK).
    return result;
  }

  ledgerOnPool(): CatalogArrivalsLedgerSession {
    return this.session(this.world.arrivals);
  }

  async readMaxArrivalId(): Promise<number> {
    return this.world.arrivals.at(-1)?.id ?? 0;
  }

  async listVendorsWithPicks(): Promise<Array<{ vendorId: number; status: string }>> {
    this.vendorsListed += 1;
    return [...this.world.picks.entries()].filter(([, ids]) => ids.size > 0).map(([vendorId]) => vendorId).sort((a, b) => a - b)
      .map((vendorId) => ({ vendorId, status: this.world.vendorStatuses.get(vendorId) ?? "active" }));
  }

  async readSellFromCategoryIds({ vendorId, now }: { vendorId: number; now: Date }): Promise<number[]> {
    const categories = new Set<number>();
    for (const id of this.world.picks.get(vendorId) ?? []) {
      const subject = this.world.subject(id);
      if (!subject || subject.categoryId === null || this.world.turnedOff.get(vendorId)?.has(id)) continue;
      if (evaluateDropshipCatalogExposure(subject, this.world.exposureRules, now).exposed) categories.add(subject.categoryId);
    }
    return [...categories].sort((a, b) => a - b);
  }

  async listMarks(vendorId: number): Promise<CatalogNoticeMark[]> {
    return [...this.world.marks.entries()].filter(([key]) => key.startsWith(`${vendorId}:`))
      .map(([key, mark]) => ({ categoryId: Number(key.split(":")[1]), seenThroughArrivalId: mark.seen, notifiedThroughArrivalId: mark.notified }))
      .sort((a, b) => a.categoryId - b.categoryId);
  }

  async insertFirstMarks({ vendorId, marks }: { vendorId: number; marks: ReadonlyArray<{ categoryId: number; throughArrivalId: number }> }) {
    let inserted = 0;
    for (const mark of marks) {
      if (this.world.mark(vendorId, mark.categoryId)) continue;
      this.world.marks.set(`${vendorId}:${mark.categoryId}`, { seen: mark.throughArrivalId, notified: mark.throughArrivalId });
      inserted += 1;
    }
    return inserted;
  }

  async readNewForVendorFacts(input: { vendorId: number; categoryIds: readonly number[]; watermark: "notified" | "seen" }): Promise<CatalogNewForVendorFacts> {
    this.newForVendorReads.push(input);
    const marks = (await this.listMarks(input.vendorId)).filter((mark) => input.categoryIds.includes(mark.categoryId));
    const arrivals = this.world.arrivals.filter((row) => {
      const mark = marks.find((candidate) => candidate.categoryId === row.categoryId);
      if (!mark) return false;
      return row.id > (input.watermark === "notified" ? mark.notifiedThroughArrivalId : mark.seenThroughArrivalId);
    }).map((row) => ({
      arrivalId: row.id, productVariantId: row.productVariantId, productId: row.productId, categoryId: row.categoryId, baseline: row.baseline,
      picked: this.world.picks.get(input.vendorId)?.has(row.productVariantId) === true,
      turnedOff: this.world.turnedOff.get(input.vendorId)?.has(row.productVariantId) === true,
    }));
    return {
      marks,
      arrivals,
      subjects: arrivals.map((row) => this.world.subject(row.productVariantId)).filter((row): row is CatalogArrivalSubject => row !== null),
      exposureRules: [...this.world.exposureRules],
      categoryNames: [...new Set(arrivals.map((row) => row.categoryId))].filter((id) => this.world.categoryNames.has(id))
        .map((categoryId) => ({ categoryId, name: this.world.categoryNames.get(categoryId)! })),
    };
  }

  async advanceNotifiedMarks({ vendorId, marks }: { vendorId: number; marks: ReadonlyArray<{ categoryId: number; throughArrivalId: number }> }) {
    if (this.failAdvanceOnce !== null) {
      const error = this.failAdvanceOnce;
      this.failAdvanceOnce = null;
      throw error;
    }
    let moved = 0;
    for (const mark of marks) {
      const existing = this.world.mark(vendorId, mark.categoryId);
      if (!existing || existing.notified >= mark.throughArrivalId) continue;
      existing.notified = mark.throughArrivalId;
      moved += 1;
    }
    return moved;
  }

  async runAcknowledge<T>(work: (tx: CatalogAcknowledgeTransaction) => Promise<T>): Promise<T> {
    const marksBefore = new Map([...this.world.marks].map(([key, mark]) => [key, { ...mark }]));
    const auditsBefore = this.world.audits.length;
    try {
      return await work({
        readMaxArrivalId: () => this.readMaxArrivalId(),
        lockMark: async ({ vendorId, categoryId }) => {
          const mark = this.world.mark(vendorId, categoryId);
          return mark ? { categoryId, seenThroughArrivalId: mark.seen, notifiedThroughArrivalId: mark.notified } : null;
        },
        upsertMark: async ({ vendorId, categoryId, seenThroughArrivalId, notifiedThroughArrivalId }) => {
          const existing = this.world.mark(vendorId, categoryId);
          if (!existing) {
            this.world.marks.set(`${vendorId}:${categoryId}`, { seen: seenThroughArrivalId, notified: notifiedThroughArrivalId });
            return true;
          }
          if (existing.seen >= seenThroughArrivalId && existing.notified >= notifiedThroughArrivalId) return false;
          existing.seen = Math.max(existing.seen, seenThroughArrivalId);
          existing.notified = Math.max(existing.notified, notifiedThroughArrivalId);
          return true;
        },
        insertAudit: async (input) => { this.world.audits.push({ ...input }); },
      });
    } catch (error) {
      this.world.marks = marksBefore;
      this.world.audits.length = auditsBefore;
      throw error;
    }
  }
}

interface StoredEvent { payload: Record<string, unknown>; hash: string; channel: string }

class FakeNotifications implements CatalogArrivalsNotifications {
  stored = new Map<string, StoredEvent[]>();
  sends: Array<Parameters<CatalogArrivalsNotifications["send"]>[0]> = [];
  muted = new Set<number>();
  failNextSend: unknown = null;

  async listEventsByKey({ vendorId, idempotencyKey }: { vendorId: number; idempotencyKey: string }) {
    return (this.stored.get(`${vendorId} ${idempotencyKey}`) ?? []).map((event) => ({ payload: event.payload }));
  }

  async send(input: Parameters<CatalogArrivalsNotifications["send"]>[0]) {
    if (this.failNextSend !== null) {
      const error = this.failNextSend;
      this.failNextSend = null;
      throw error;
    }
    this.sends.push(input);
    const key = `${input.vendorId} ${input.idempotencyKey}`;
    const hash = JSON.stringify([input.title, input.message, input.payload]);
    const existing = this.stored.get(key);
    if (existing) {
      if (existing.some((event) => event.hash !== hash)) {
        throw new DropshipError("DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT", "Dropship notification idempotency key was reused with a different request.");
      }
      return { events: existing, idempotentReplay: true };
    }
    if (this.muted.has(input.vendorId)) return { events: [], idempotentReplay: false };
    const events = ["email", "in_app"].map((channel) => ({ payload: JSON.parse(JSON.stringify(input.payload)), hash, channel }));
    this.stored.set(key, events);
    return { events, idempotentReplay: false };
  }
}

const QUIET_FOLLOW_UP: ConversionFollowUpStageResult = {
  conversionsRead: 0, followUpsDone: 0, followUpsBusy: 0, noticesSent: 0, noticesDeferred: 0, vendorsFailed: 0, requiresReview: 0,
};

class FakeFollowUp implements CatalogConversionFollowUpStage {
  calls: Date[] = [];
  failWith: unknown = null;
  async runStage(now: Date): Promise<ConversionFollowUpStageResult> {
    this.calls.push(now);
    if (this.failWith !== null) throw this.failWith;
    return { ...QUIET_FOLLOW_UP };
  }
}

interface LogLine { level: keyof CatalogJobLog; action: string; fields: Record<string, unknown> }

function harness(world = new World()) {
  const repository = new FakeRepository(world);
  const notifications = new FakeNotifications();
  const followUp = new FakeFollowUp();
  const logs: LogLine[] = [];
  const clock = { current: DAY1_9AM };
  const log: CatalogJobLog = {
    debug: (action, fields) => logs.push({ level: "debug", action, fields }),
    info: (action, fields) => logs.push({ level: "info", action, fields }),
    warn: (action, fields) => logs.push({ level: "warn", action, fields }),
    error: (action, fields) => logs.push({ level: "error", action, fields }),
  };
  const service = new DropshipCatalogArrivalsService({
    repository, notifications, followUp, log, clock: { now: () => clock.current }, timer: () => 0,
    catalogUrl: "https://cardshellz.io/catalog/choose",
  });
  const at = (date: Date) => { clock.current = date; };
  const later = (ms: number) => { clock.current = new Date(clock.current.getTime() + ms); };
  return { world, repository, notifications, followUp, logs, service, at, later };
}

/** A catalog of sellable sizes in category 7 (Armalope), each its own product unless said otherwise. */
function seedCatalog(world: World, ids: number[], size: Partial<Size> = {}): void {
  for (const id of ids) world.addSize(id, { productId: id, ...size });
}

const emails = (notifications: FakeNotifications) => notifications.sends.filter((send) => send.eventType === DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS);

describe("the catalog arrivals job (PLAN-B v4.1 §11.1)", () => {
  it("writes the whole baseline in one transaction, announces nothing, and first-marks silently", async () => {
    const h = harness();
    seedCatalog(h.world, [1, 2, 3]);
    h.world.addSize(4, { categoryId: null, category: null });
    h.world.addSize(5, { sellable: false });
    h.world.pick(10, 1);

    const result = await h.service.runTick();
    expect(result.outcome).toBe("completed");
    expect(result.ledger).toEqual({ baseline: true, insertedCount: 3, ledgerEmpty: false });
    expect(h.repository.ledgerTransactions).toEqual([{ statementTimeoutMs: CATALOG_ARRIVALS_BASELINE_STATEMENT_TIMEOUT_MS }]);
    expect(CATALOG_ARRIVALS_BASELINE_STATEMENT_TIMEOUT_MS).toBe(300_000);
    expect(h.world.arrivals.map((row) => [row.id, row.productVariantId, row.categoryId, row.baseline])).toEqual([
      [1, 1, 7, true], [2, 2, 7, true], [3, 3, 7, true],
    ]);
    expect(h.world.mark(10, 7)).toEqual({ seen: 3, notified: 3 });
    expect(h.notifications.sends).toEqual([]);
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.baseline_written"))
      .toMatchObject({ level: "info", fields: { outcome: "written", inserted_count: 3 } });
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.first_marks")).toMatchObject({ level: "debug" });
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toEqual({ categories: [] });
  });

  it("rolls a baseline that fails part way back whole; the next tick writes every row as baseline (CHK6)", async () => {
    const h = harness();
    const ids = Array.from({ length: CATALOG_ARRIVALS_LEDGER_BATCH_SIZE + 500 }, (_, index) => index + 1);
    seedCatalog(h.world, ids);
    h.world.pick(10, 1);
    h.repository.failInsertArrivalsOnCall = { call: 2, error: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) };

    const failed = await h.service.runTick();
    expect(failed.outcome).toBe("failed");
    expect(h.world.arrivals).toEqual([]);
    expect(h.repository.vendorsListed).toBe(0);
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.tick_failed"))
      .toEqual([expect.objectContaining({ level: "warn", fields: expect.objectContaining({ error_code: "57014", error_class: "transient" }) })]);

    // The next minute's tick tries again (the stage did not finish, so it is still due).
    h.later(60_000);
    const retried = await h.service.runTick();
    expect(retried.ledger).toEqual({ baseline: true, insertedCount: ids.length, ledgerEmpty: false });
    expect(h.world.arrivals).toHaveLength(ids.length);
    expect(h.world.arrivals.every((row) => row.baseline)).toBe(true);
    expect(h.notifications.sends).toEqual([]);
  });

  it("skips stages 3 and 4 while the ledger is empty, and runs the ledger stage at most hourly while the follow-up runs every tick", async () => {
    const h = harness();
    h.world.pick(10, 1); // a pick of a size Card Shellz does not offer: nothing to put in the ledger
    const first = await h.service.runTick();
    expect(first.ledger).toEqual({ baseline: true, insertedCount: 0, ledgerEmpty: true });
    expect(first.notices).toBeNull();
    expect(h.repository.vendorsListed).toBe(0);
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.baseline_written")?.fields.outcome).toBe("empty_catalog");

    seedCatalog(h.world, [1]);
    h.later(59 * 60_000);
    const second = await h.service.runTick();
    expect(second.ledger).toBeNull();
    h.later(60_000);
    const third = await h.service.runTick();
    expect(third.ledger).toEqual({ baseline: true, insertedCount: 1, ledgerEmpty: false });
    expect(h.followUp.calls).toHaveLength(3);
    // A quiet tick is DEBUG (CLAUDE.md §10).
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.tick").map((line) => line.level)).toEqual(["info", "debug", "info"]);
  });

  it("announces arrivals after the baseline once a day, by category, with today's key and the §13 words", async () => {
    const h = harness();
    seedCatalog(h.world, [1, 2]);
    h.world.addSize(3, { productId: 300, categoryId: 8, category: "Toploaders" });
    h.world.pick(10, 1, 3);
    await h.service.runTick(); // baseline + marks for 7 and 8 at 3

    h.world.addSize(4, { productId: 1 }); // a new size of a picked product: new
    h.world.addSize(5, { productId: 5 });
    h.world.addSize(6, { productId: 6, categoryId: 8, category: "Toploaders" });
    h.world.addSize(7, { productId: 7, categoryId: 9, category: "Sleeves" }); // a category vendor 10 does not sell from
    h.later(HOUR);
    const tick = await h.service.runTick();
    expect(tick.ledger).toEqual({ baseline: false, insertedCount: 4, ledgerEmpty: false });
    expect(h.world.arrivals.filter((row) => !row.baseline).map((row) => row.productVariantId)).toEqual([4, 5, 6, 7]);
    expect(emails(h.notifications)).toEqual([{
      vendorId: 10,
      eventType: "dropship_catalog_new_items",
      critical: false,
      idempotencyKey: "catalog-new-items:10:2026-10-24",
      title: "New items from Card Shellz",
      message: "Card Shellz added new items in categories you sell from: Armalope (2), Toploaders (1). Nothing is added until you "
        + "choose them in Catalog, step 1 (Choose what to sell), and publish them in step 3: https://cardshellz.io/catalog/choose",
      payload: {
        throughArrivalId: 6,
        categories: [
          { categoryId: 7, categoryName: "Armalope", productCount: 2, sizeCount: 2, throughArrivalId: 5 },
          { categoryId: 8, categoryName: "Toploaders", productCount: 1, sizeCount: 1, throughArrivalId: 6 },
        ],
      },
    }]);
    expect(h.world.mark(10, 7)).toEqual({ seen: 3, notified: 5 });
    expect(h.world.mark(10, 8)).toEqual({ seen: 3, notified: 6 });
    expect(h.world.mark(10, 9)).toBeUndefined();
    // Step 1 still shows them (the email moves only notified_through), with the same counts as the email (TESTS-8).
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toEqual({
      categories: (emails(h.notifications)[0].payload as { categories: unknown[] }).categories,
    });
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.new_items_emailed"))
      .toMatchObject({ level: "info", fields: { outcome: "sent", vendor_id: 10, category_count: 2, size_count: 3 } });
  });

  it("lists the size ids selection=new reads by the notice's own rule: per category, all sell-from categories, the same counts (§11.4, TESTS-8)", async () => {
    const h = harness();
    seedCatalog(h.world, [1, 2]);
    h.world.addSize(3, { productId: 300, categoryId: 8, category: "Toploaders" });
    h.world.pick(10, 1, 3);
    await h.service.runTick();
    h.world.addSize(4, { productId: 1 });
    h.world.addSize(5, { productId: 5 });
    h.world.addSize(6, { productId: 6, categoryId: 8, category: "Toploaders" });
    h.world.addSize(7, { productId: 7, categoryId: 9, category: "Sleeves" });
    h.later(HOUR);
    await h.service.runTick();
    // The caller's time (the catalog read's clock), not the job's.
    const now = new Date(DAY1_9AM.getTime() + HOUR);

    const ids = (categoryId: number | null) => h.service.listNewVariantIds({ vendorId: 10, categoryId, now });
    await expect(ids(7)).resolves.toEqual([4, 5]);
    await expect(ids(8)).resolves.toEqual([6]);
    await expect(ids(null)).resolves.toEqual([4, 5, 6]);
    // A category the vendor does not sell from has nothing new (its arrival 7 is never shown).
    await expect(ids(9)).resolves.toEqual([]);
    // Each category's ids count exactly what the notice shows for it, read past seen_through as readNewItems is.
    const notice = await h.service.readNewItems({ vendorId: 10 });
    for (const category of notice.categories) {
      expect((await ids(category.categoryId)).length, String(category.categoryId)).toBe(category.sizeCount);
    }
    expect(h.repository.newForVendorReads.slice(-1)[0]).toMatchObject({ vendorId: 10, watermark: "seen" });
    // A category whose name cannot be read is left out of both, so its rows never outnumber the notice.
    h.world.categoryNames.delete(8);
    await expect(ids(null)).resolves.toEqual([4, 5]);
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toMatchObject({ categories: [{ categoryId: 7, sizeCount: 2 }] });
    // Got it clears the category for selection=new too.
    await h.service.acknowledge({ vendorId: 10, actor: { actorType: "vendor", actorId: "member-10" }, categoryId: 7, throughArrivalId: 5 });
    await expect(ids(7)).resolves.toEqual([]);
    await expect(h.service.listNewVariantIds({ vendorId: 10, categoryId: 7 })).rejects.toMatchObject({
      code: "DROPSHIP_CATALOG_NEW_ITEMS_INVALID_INPUT", context: { classification: "permanent" },
    });
  });

  it("emails arrivals after today's email on the next UTC day, keeping the watermark below them (FIDELITY-2)", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    await h.service.runTick();
    h.world.addSize(2, { productId: 2 });
    h.later(HOUR); // 10:00, day 1
    await h.service.runTick();
    expect(emails(h.notifications).map((send) => send.idempotencyKey)).toEqual(["catalog-new-items:10:2026-10-24"]);
    expect(h.world.mark(10, 7)?.notified).toBe(2);

    h.world.addSize(3, { productId: 3 });
    h.later(HOUR); // 11:00, day 1: today's email was sent, so nothing goes out and the mark stays at what it named
    await h.service.runTick();
    expect(emails(h.notifications)).toHaveLength(1);
    expect(h.world.mark(10, 7)?.notified).toBe(2);
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.already_emailed_today")).toHaveLength(1);

    h.at(new Date("2026-10-25T00:30:00.000Z")); // the next UTC day
    await h.service.runTick();
    expect(emails(h.notifications).map((send) => [send.idempotencyKey, (send.payload as { throughArrivalId: number }).throughArrivalId]))
      .toEqual([["catalog-new-items:10:2026-10-24", 2], ["catalog-new-items:10:2026-10-25", 3]]);
    expect(h.world.mark(10, 7)?.notified).toBe(3);
  });

  it("after a crash between the send and the mark move, moves the marks only to the stored email's ids, with no second send", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    await h.service.runTick();
    h.world.addSize(2, { productId: 2 });
    h.repository.failAdvanceOnce = Object.assign(new Error("Connection terminated unexpectedly"), {});
    h.later(HOUR);
    const tick = await h.service.runTick();
    expect(tick.notices).toMatchObject({ vendorsFailed: 1, vendorsEmailed: 0 });
    expect(h.world.mark(10, 7)?.notified).toBe(1);
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.vendor_failed"))
      .toMatchObject({ level: "warn", fields: { vendor_id: 10, error_class: "transient" } });

    h.world.addSize(3, { productId: 3 }); // arrives after the email: stays new
    h.later(HOUR);
    await h.service.runTick();
    expect(emails(h.notifications)).toHaveLength(1);
    expect(h.world.mark(10, 7)?.notified).toBe(2);
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toMatchObject({
      categories: [{ categoryId: 7, sizeCount: 2, throughArrivalId: 3 }],
    });
  });

  it("moves the marks to yesterday's stored email when its move failed in the day's last hour: the next day emails only what is new (JOB-2)", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    h.at(new Date("2026-10-24T22:10:00.000Z"));
    await h.service.runTick(); // baseline, first mark at 1
    h.world.addSize(2, { productId: 2 });
    h.repository.failAdvanceOnce = new Error("Connection terminated unexpectedly");
    h.at(new Date("2026-10-24T23:10:00.000Z")); // day D's last hour: the email goes out, its mark move fails
    const failed = await h.service.runTick();
    expect(failed.notices).toMatchObject({ vendorsFailed: 1 });
    expect(emails(h.notifications).map((send) => send.idempotencyKey)).toEqual(["catalog-new-items:10:2026-10-24"]);
    expect(h.world.mark(10, 7)?.notified).toBe(1);

    h.world.addSize(3, { productId: 3 }); // arrives after day D's email
    h.at(new Date("2026-10-25T00:10:00.000Z")); // day D+1's first stage: nothing under its own key yet
    const start = h.logs.length;
    await h.service.runTick();
    const sent = emails(h.notifications);
    expect(sent.map((send) => send.idempotencyKey)).toEqual(["catalog-new-items:10:2026-10-24", "catalog-new-items:10:2026-10-25"]);
    // Size 2 was named by day D's email: only size 3 is new to this email.
    expect(sent[1].payload).toEqual({ throughArrivalId: 3, categories: [
      { categoryId: 7, categoryName: "Armalope", productCount: 1, sizeCount: 1, throughArrivalId: 3 },
    ] });
    expect(h.world.mark(10, 7)).toEqual({ seen: 1, notified: 3 });
    expect(h.logs.slice(start).filter((line) => line.action === "dropship.catalog_arrivals.previous_email_marks_moved")).toEqual([
      { level: "debug", action: "dropship.catalog_arrivals.previous_email_marks_moved",
        fields: { outcome: "repaired", vendor_id: 10, idempotency_key: "catalog-new-items:10:2026-10-24", marks_moved: 1 } },
    ]);
    expect(h.logs.slice(start).filter((line) => line.level === "warn" || line.level === "error")).toEqual([]);
  });

  it("looks one day back only: an email whose move was lost two days ago is not repaired, and its items are named again (JOB-2's limit)", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    h.at(new Date("2026-10-24T22:10:00.000Z"));
    await h.service.runTick();
    h.world.addSize(2, { productId: 2 });
    h.repository.failAdvanceOnce = new Error("Connection terminated unexpectedly");
    h.at(new Date("2026-10-24T23:10:00.000Z"));
    await h.service.runTick();
    expect(h.world.mark(10, 7)?.notified).toBe(1);

    // No stage runs on day D+1 (the job is off all day); the next one is on day D+2.
    h.world.addSize(3, { productId: 3 });
    h.at(new Date("2026-10-26T00:10:00.000Z"));
    await h.service.runTick();
    const sent = emails(h.notifications);
    expect(sent.map((send) => send.idempotencyKey)).toEqual(["catalog-new-items:10:2026-10-24", "catalog-new-items:10:2026-10-26"]);
    expect((sent[1].payload as { categories: Array<{ sizeCount: number }> }).categories[0].sizeCount).toBe(2);
    expect(h.world.mark(10, 7)?.notified).toBe(3);
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.previous_email_marks_moved")).toEqual([]);
  });

  it("skips the vendors step 1 refuses: a closed, lapsed or suspended vendor gets no first mark and no email; a paused one does (JOB-1)", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    for (const [vendorId, status] of [[10, "active"], [11, "paused"], [12, "closed"], [13, "suspended"], [14, "lapsed"], [15, "onboarding"]] as const) {
      h.world.pick(vendorId, 1);
      h.world.vendorStatuses.set(vendorId, status);
    }
    const baseline = await h.service.runTick();
    expect(baseline.notices).toMatchObject({ vendorsScanned: 3, vendorsBlocked: 3, firstMarksInserted: 3 });
    expect([10, 11, 12, 13, 14, 15].map((vendorId) => h.world.mark(vendorId, 7) ?? null)).toEqual([
      { seen: 1, notified: 1 }, { seen: 1, notified: 1 }, null, null, null, { seen: 1, notified: 1 },
    ]);
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.vendors_blocked")).toEqual({
      level: "debug", action: "dropship.catalog_arrivals.vendors_blocked", fields: { outcome: "skipped", vendor_count: 3, vendors: [
        { vendor_id: 12, vendor_status: "closed" }, { vendor_id: 13, vendor_status: "suspended" }, { vendor_id: 14, vendor_status: "lapsed" },
      ] },
    });

    h.world.addSize(2, { productId: 2 });
    h.later(HOUR);
    const tick = await h.service.runTick();
    expect(tick.notices).toMatchObject({ vendorsScanned: 3, vendorsBlocked: 3, vendorsEmailed: 3, vendorsFailed: 0 });
    expect(emails(h.notifications).map((send) => send.vendorId)).toEqual([10, 11, 15]);
    expect(h.world.mark(12, 7)).toBeUndefined();

    // Suspended vendor 13 is active again: first-marked silently at the newest arrival, so nothing older is emailed.
    h.world.vendorStatuses.set(13, "active");
    h.world.addSize(3, { productId: 3 });
    h.later(HOUR);
    await h.service.runTick();
    expect(h.world.mark(13, 7)).toEqual({ seen: 3, notified: 3 });
    expect(emails(h.notifications).filter((send) => send.vendorId === 13)).toEqual([]);
    expect(h.logs.filter((line) => line.level === "warn" || line.level === "error")).toEqual([]);
  });

  it("moves the marks for a vendor who muted the email though nothing is stored, and sends nothing more that day", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    h.notifications.muted.add(10);
    await h.service.runTick();
    h.world.addSize(2, { productId: 2 });
    h.later(HOUR);
    await h.service.runTick();
    expect(emails(h.notifications)).toHaveLength(1);
    expect(h.notifications.stored.size).toBe(0);
    expect(h.world.mark(10, 7)?.notified).toBe(2);
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.new_items_emailed")?.fields.outcome).toBe("muted");
    h.later(HOUR);
    await h.service.runTick();
    expect(emails(h.notifications)).toHaveLength(1);
  });

  it("announces a size moved into a category the vendor sells from, and never again when it moves back", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.addSize(2, { productId: 2, categoryId: 8, category: "Toploaders" });
    h.world.pick(10, 1);
    await h.service.runTick(); // baseline: (1,7), (2,8); vendor 10 sells from 7 only

    h.world.addSize(2, { productId: 2, categoryId: 7, category: "Armalope" }); // moved into 7
    h.later(HOUR);
    await h.service.runTick();
    expect(h.world.arrivals.map((row) => [row.productVariantId, row.categoryId, row.baseline]))
      .toEqual([[1, 7, true], [2, 8, true], [2, 7, false]]);
    expect(emails(h.notifications)).toHaveLength(1);

    h.world.addSize(2, { productId: 2, categoryId: 8, category: "Toploaders" }); // back to 8
    h.at(new Date("2026-10-25T10:00:00.000Z"));
    await h.service.runTick();
    h.world.addSize(2, { productId: 2, categoryId: 7, category: "Armalope" }); // into 7 again: no new arrival
    h.at(new Date("2026-10-26T10:00:00.000Z"));
    await h.service.runTick();
    expect(h.world.arrivals).toHaveLength(3);
    expect(emails(h.notifications)).toHaveLength(1);
  });

  it("announces a size whose admin rule starts later only once the rule is effective", async () => {
    const h = harness();
    const starts = new Date("2026-10-24T12:30:00.000Z");
    h.world.exposureRules = [{ id: 1, scopeType: "category", action: "include", category: "Armalope" },
      { id: 2, scopeType: "product", action: "exclude", productId: 2 },
      { id: 3, scopeType: "product", action: "include", productId: 2, startsAt: starts }];
    seedCatalog(h.world, [1, 2]);
    h.world.pick(10, 1);
    await h.service.runTick(); // 09:00: size 2 is not offered yet, so not in the ledger
    expect(h.world.arrivals.map((row) => row.productVariantId)).toEqual([1]);
    h.later(HOUR); // 10:00
    await h.service.runTick();
    expect(emails(h.notifications)).toEqual([]);
    h.at(new Date("2026-10-24T13:00:00.000Z"));
    await h.service.runTick();
    expect(h.world.arrivals.map((row) => [row.productVariantId, row.baseline])).toEqual([[1, true], [2, false]]);
    expect(emails(h.notifications)).toHaveLength(1);
  });

  it("never announces a picked, turned-off or unsellable size, and keeps two vendors independent", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    h.world.pick(11, 1);
    await h.service.runTick();
    seedCatalog(h.world, [2, 3, 4]);
    h.world.pick(10, 2);
    h.world.turnedOff.set(10, new Set([3]));
    h.later(HOUR);
    h.world.addSize(4, { productId: 4, sellable: false });
    await h.service.runTick();
    // Size 4 turned unsellable before the ledger read it; sizes 2 and 3 arrived.
    expect(emails(h.notifications).map((send) => [send.vendorId, (send.payload as { categories: Array<{ sizeCount: number }> }).categories[0].sizeCount]))
      .toEqual([[11, 2]]);
    expect(h.world.mark(10, 7)?.notified).toBe(1);
    expect(h.world.mark(11, 7)?.notified).toBe(3);
  });

  it("reads a missing mark as nothing new: a first save into a category with 5 later arrivals shows no notice before or after the next tick (FIDELITY-5)", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.addSize(2, { productId: 2, categoryId: 8, category: "Toploaders" });
    h.world.pick(10, 1);
    await h.service.runTick();
    for (const id of [3, 4, 5, 6, 7]) h.world.addSize(id, { productId: id, categoryId: 8, category: "Toploaders" });
    h.later(HOUR);
    await h.service.runTick(); // the five arrive in 8, which vendor 10 does not sell from yet
    expect(emails(h.notifications)).toEqual([]);

    h.world.pick(10, 2); // the vendor's first save in category 8
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toEqual({ categories: [] });
    h.later(HOUR);
    await h.service.runTick();
    expect(h.world.mark(10, 8)).toEqual({ seen: 7, notified: 7 });
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toEqual({ categories: [] });
    expect(emails(h.notifications)).toEqual([]);
  });

  it("acknowledges idempotently: moves both watermarks with one audit row, a second press is already_seen, a missing mark is created", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    await h.service.runTick();
    seedCatalog(h.world, [2, 3]);
    h.later(HOUR);
    await h.service.runTick();
    expect(h.world.mark(10, 7)).toEqual({ seen: 1, notified: 3 });

    const actor = { actorType: "vendor" as const, actorId: "member-10" };
    await expect(h.service.acknowledge({ vendorId: 10, actor, categoryId: 7, throughArrivalId: 3 }))
      .resolves.toEqual({ outcome: "acknowledged", categoryId: 7, seenThroughArrivalId: 3 });
    expect(h.world.mark(10, 7)).toEqual({ seen: 3, notified: 3 });
    expect(h.world.audits).toEqual([expect.objectContaining({
      vendorId: 10, categoryId: 7, actor,
      payload: { categoryId: 7, throughArrivalId: 3, before: { seenThroughArrivalId: 1, notifiedThroughArrivalId: 3 },
        after: { seenThroughArrivalId: 3, notifiedThroughArrivalId: 3 } },
    })]);
    await expect(h.service.readNewItems({ vendorId: 10 })).resolves.toEqual({ categories: [] });

    await expect(h.service.acknowledge({ vendorId: 10, actor, categoryId: 7, throughArrivalId: 2 }))
      .resolves.toEqual({ outcome: "already_seen", categoryId: 7, seenThroughArrivalId: 3 });
    expect(h.world.audits).toHaveLength(1);

    // A category without a mark: the mark is created at the given id, with its audit row.
    await expect(h.service.acknowledge({ vendorId: 10, actor, categoryId: 9, throughArrivalId: 2 }))
      .resolves.toEqual({ outcome: "acknowledged", categoryId: 9, seenThroughArrivalId: 2 });
    expect(h.world.mark(10, 9)).toEqual({ seen: 2, notified: 2 });
    expect(h.world.audits).toHaveLength(2);
    expect(h.world.audits[1]).toMatchObject({ payload: { before: null } });
    // Each line names the mark before and after, both watermarks (CLAUDE.md §10; API-1).
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.acknowledged")).toEqual([
      { level: "info", action: "dropship.catalog_arrivals.acknowledged", fields: { outcome: "acknowledged", vendor_id: 10, category_id: 7,
        actor_id: "member-10", through_arrival_id: 3,
        before: { seen_through_arrival_id: 1, notified_through_arrival_id: 3 }, after: { seen_through_arrival_id: 3, notified_through_arrival_id: 3 } } },
      { level: "debug", action: "dropship.catalog_arrivals.acknowledged", fields: { outcome: "already_seen", vendor_id: 10, category_id: 7,
        actor_id: "member-10", through_arrival_id: 2,
        before: { seen_through_arrival_id: 3, notified_through_arrival_id: 3 }, after: { seen_through_arrival_id: 3, notified_through_arrival_id: 3 } } },
      { level: "info", action: "dropship.catalog_arrivals.acknowledged", fields: { outcome: "acknowledged", vendor_id: 10, category_id: 9,
        actor_id: "member-10", through_arrival_id: 2,
        before: null, after: { seen_through_arrival_id: 2, notified_through_arrival_id: 2 } } },
    ]);
  });

  it("refuses Got it past the newest arrival (400) and writes nothing; refuses malformed input as permanent", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    await h.service.runTick();
    const actor = { actorType: "vendor" as const, actorId: "member-10" };
    await expect(h.service.acknowledge({ vendorId: 10, actor, categoryId: 7, throughArrivalId: 2 })).rejects.toMatchObject({
      code: CATALOG_ARRIVALS_ERROR_CODES.acknowledgeInvalid, context: { classification: "permanent", maxArrivalId: 1 },
    });
    expect(h.world.mark(10, 7)).toEqual({ seen: 1, notified: 1 });
    expect(h.world.audits).toEqual([]);
    for (const invalid of [{ vendorId: 10, actor, categoryId: 0, throughArrivalId: 1 }, { vendorId: 10, actor, categoryId: 7, throughArrivalId: -1 },
      { vendorId: 10, actor, categoryId: 7, throughArrivalId: 1, extra: 1 }, { vendorId: 10, categoryId: 7, throughArrivalId: 1 }]) {
      await expect(h.service.acknowledge(invalid)).rejects.toMatchObject({
        code: "DROPSHIP_CATALOG_NEW_ITEMS_INVALID_INPUT", context: { classification: "permanent" },
      });
    }
  });

  it("logs a transient tick failure at WARN and one ERROR at the third in a row; a success resets the streak (FIDELITY-4)", async () => {
    const h = harness();
    h.followUp.failWith = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    for (let tick = 0; tick < 4; tick += 1) {
      await expect(h.service.runTick()).resolves.toMatchObject({ outcome: "failed" });
      h.later(60_000);
    }
    const failures = h.logs.filter((line) => line.action === "dropship.catalog_arrivals.tick_failed");
    expect(failures.map((line) => [line.level, line.fields.failed_ticks_in_a_row, line.fields.error_code])).toEqual([
      ["warn", 1, "40P01"], ["warn", 2, "40P01"], ["warn", 3, "40P01"],
      ["error", 3, CATALOG_ARRIVALS_ERROR_CODES.tickFailed], ["warn", 4, "40P01"],
    ]);
    expect(failures.at(-2)?.fields).toMatchObject({ cause_code: "40P01", outcome: "failed" });
    // The ledger stage never ran (the tick aborts at the failed stage).
    expect(h.repository.ledgerTransactions).toEqual([]);

    h.followUp.failWith = null;
    await expect(h.service.runTick()).resolves.toMatchObject({ outcome: "completed" });
    h.followUp.failWith = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    await h.service.runTick();
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.tick_failed").at(-1)?.fields.failed_ticks_in_a_row).toBe(1);
  });

  it("logs a fatal tick failure at ERROR at once, and counts a lock runner failure in the same streak", async () => {
    const h = harness();
    h.followUp.failWith = new TypeError("Cannot read properties of undefined");
    await h.service.runTick();
    expect(h.logs.filter((line) => line.action === "dropship.catalog_arrivals.tick_failed")).toEqual([expect.objectContaining({
      level: "error",
      fields: expect.objectContaining({ outcome: "failed", error_class: "fatal", error_code: CATALOG_ARRIVALS_ERROR_CODES.tickFailed,
        error_message: "Cannot read properties of undefined" }),
    })]);
    h.service.recordTickFailure(new Error("timeout exceeded when trying to connect"), { lock_id: 736_000 });
    h.service.recordTickFailure(new Error("timeout exceeded when trying to connect"));
    const lines = h.logs.filter((line) => line.action === "dropship.catalog_arrivals.tick_failed");
    expect(lines.map((line) => [line.level, line.fields.failed_ticks_in_a_row])).toEqual([["error", 1], ["warn", 2], ["warn", 3], ["error", 3]]);
    expect(lines[1].fields).toMatchObject({ lock_id: 736_000, error_class: "transient" });
  });

  it("treats a key conflict on today's email as transient for that vendor: nothing moves, other vendors go on", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    h.world.pick(11, 1);
    await h.service.runTick();
    seedCatalog(h.world, [2]);
    h.notifications.failNextSend = new DropshipError("DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT", "reused");
    h.later(HOUR);
    const tick = await h.service.runTick();
    expect(tick.notices).toMatchObject({ vendorsScanned: 2, vendorsFailed: 1, vendorsEmailed: 1 });
    expect(h.world.mark(10, 7)?.notified).toBe(1);
    expect(h.world.mark(11, 7)?.notified).toBe(2);
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.vendor_failed")).toMatchObject({
      level: "warn", fields: { vendor_id: 10, error_code: "DROPSHIP_NOTIFICATION_IDEMPOTENCY_CONFLICT", error_class: "transient" },
    });
  });

  it("logs a vendor's fault at ERROR and goes on with the others", async () => {
    const h = harness();
    seedCatalog(h.world, [1]);
    h.world.pick(10, 1);
    h.world.pick(11, 1);
    await h.service.runTick();
    seedCatalog(h.world, [2]);
    h.notifications.failNextSend = new TypeError("boom");
    h.later(HOUR);
    await h.service.runTick();
    expect(h.logs.find((line) => line.action === "dropship.catalog_arrivals.vendor_failed")).toMatchObject({
      level: "error", fields: { vendor_id: 10, error_class: "fatal", error_message: "boom" },
    });
    expect(h.world.mark(11, 7)?.notified).toBe(2);
  });

  it("passes the injected time to the follow-up and reads the email words without a URL when none is configured", async () => {
    const world = new World();
    seedCatalog(world, [1]);
    world.pick(10, 1);
    const repository = new FakeRepository(world);
    const notifications = new FakeNotifications();
    const followUp = new FakeFollowUp();
    let now = DAY1_9AM;
    const service = new DropshipCatalogArrivalsService({
      repository, notifications, followUp, clock: { now: () => now }, timer: () => 0, catalogUrl: null,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await service.runTick();
    seedCatalog(world, [2]);
    now = new Date(now.getTime() + HOUR);
    await service.runTick();
    expect(followUp.calls).toEqual([DAY1_9AM, now]);
    expect(notifications.sends[0].message).toBe("Card Shellz added new items in categories you sell from: Armalope (1). Nothing is "
      + "added until you choose them in Catalog, step 1 (Choose what to sell), in your Card Shellz dropship portal, and publish them in step 3.");
  });
});
