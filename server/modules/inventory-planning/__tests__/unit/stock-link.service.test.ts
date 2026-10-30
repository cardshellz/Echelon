import { describe, expect, it, vi } from "vitest";
import type { StockLinkDestination, StockLinkStoreItem } from "@shared/types/stock-link";
import type {
  StockLinkAdapter, StockLinkRecentChange, StockLinkSource,
} from "../../application/stock-link.ports";
import {
  STOCK_LINK_TICK_LIMITS, StockLinkService, createStockLinkRegistry, type StockLinkSelectionFact, type StockLinkTickStore,
} from "../../application/stock-link.service";
import { normalizeStockLinkSku, type StockLinkSizeDecision } from "../../domain/stock-link";
import {
  stockLinkCheckAfterDecision, stockLinkCheckAfterFailure, type StockLinkCheckFacts, type StockLinkCheckWrite,
} from "../../domain/stock-link-check-outcome";
import { STOCK_LINK_ERROR_CODES, StockLinkError, classifyStockLinkFailure } from "../../domain/stock-link-errors";
import type {
  StockLinkClaimedCheck, StockLinkCursorUpdate, StockLinkDestinationState, StockLinkHeadRead, StockLinkTargetRow,
} from "../../infrastructure/stock-link-checks.repository";
import type { StockLinkCommandRequest, StockLinkCommandResult } from "../../infrastructure/stock-link-shopify-command";

// Channels PR2 (PLAN-CH2 v4.1 §7.2, §11.3): StockLinkService.tick with its database work, the store and the command
// replaced by an in-memory stand-in that keeps the SQL's rules (claims due rows not stopped on an error, guards every
// write by lease and revision, wakes only rows not leased and not already due). The decision and the row outcomes are
// the real pure modules, so what the tick writes is what production writes.

const C = STOCK_LINK_ERROR_CODES;
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse("2026-10-27T12:00:00.000Z");
const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);

interface Row extends StockLinkCheckFacts {
  errorClass: string | null;
  message: string | null;
  revision: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
}
interface Size { productId: number; sku: string | null; hint: string | null; carried: boolean; selection: StockLinkSelectionFact }
interface Head { revision: number; active: { mappingId: number; itemId: string; externalSku: string | null } | null }

const destinationOf = (publicationTargetId: number): StockLinkDestination => ({ publicationTargetId,
  destinationKind: "channel_connection", providerKey: "shopify", channelId: 30 + publicationTargetId,
  channelConnectionId: 70 + publicationTargetId, dropshipStoreConnectionId: null, providerScopeType: "location",
  externalScopeId: `loc-${publicationTargetId}`, targetRevision: "3" });

const item = (itemId: string, sku: string | null, productStatus = "ACTIVE"): StockLinkStoreItem =>
  ({ itemId, sku, productId: `9${itemId}`, productStatus });

/** One Shopify destination's database rows, the store's items and the clocks, with the tick wired to them. */
class Harness {
  now = START;
  monotonic = 0;
  authority: "legacy" | "canonical" = "canonical";
  readonly targets = new Map<number, { held: boolean }>();
  readonly states = new Map<number, { -readonly [K in keyof Omit<StockLinkDestinationState, "recentCursor">]: StockLinkDestinationState[K] }
    & { recentCursor: { raw: string | null; id: number | null }; heartbeatAt: Date | null }>();
  readonly rows = new Map<number, Map<number, Row>>();
  readonly sizes = new Map<number, Map<number, Size>>();
  readonly heads = new Map<number, Map<number, Head>>();
  readonly recent = new Map<number, StockLinkRecentChange[]>();
  readonly deadLetters = new Map<number, { productVariantId: number; at: string }[]>();
  readonly store = new Map<number, Map<string, StockLinkStoreItem>>();
  recentRetires = 0;
  /** Store reads made: the destination, the call and its ids. */
  readonly calls: { targetId: number; kind: "lookup" | "observe"; values: readonly string[]; aborted: boolean }[] = [];
  readonly commands: StockLinkCommandRequest[] = [];
  readonly cursorSaves: { targetId: number; update: StockLinkCursorUpdate }[] = [];
  readonly wakes: { targetId: number; ids: number[] }[] = [];
  readonly recordCalls: { targetId: number; ids: number[] }[] = [];
  readonly deletedClaimed: number[] = [];
  readonly halts: { targetId: number; code: string }[] = [];
  readonly pauses: { targetId: number; code: string; until: Date }[] = [];
  readonly claimCalls: number[] = [];
  /** Scripted failures, consumed in order, by store method or provider read. */
  readonly failures = new Map<string, unknown[]>();
  /** What the stand-in command does (default: applies the plan, as step 10 records it). */
  command: (request: StockLinkCommandRequest) => Promise<StockLinkCommandResult> = request => this.applyCommand(request);
  fenceHoldMs: number | null = 50;
  fingerprint = FINGERPRINT;
  /** Called before each provider read (to move the clocks or change the store mid-tick). */
  beforeCall: (kind: "lookup" | "observe", call: number) => void = () => undefined;
  controller = new AbortController();
  private mapping = 1_000;
  private leaseSeq = 0;
  readonly log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  readonly service: StockLinkService;

  constructor() {
    const harness = this;
    const source: StockLinkSource = {
      destinationKind: "channel_connection", providerKey: "shopify",
      async listCandidates(_client, destination, afterVariantId, limit) {
        const ids = [...harness.sizesOf(destination.publicationTargetId)].filter(([, size]) => size.carried).map(([id]) => id)
          .filter(id => id > afterVariantId).sort((a, b) => a - b).slice(0, limit);
        return { candidates: ids.map(id => ({ productVariantId: id, productId: harness.sizesOf(destination.publicationTargetId).get(id)!.productId })),
          nextAfterVariantId: ids.length === limit ? ids[ids.length - 1]! : null };
      },
      async listRecentlyChanged(_client, destination, _cursor, limit) {
        return (harness.recent.get(destination.publicationTargetId) ?? []).slice(0, limit);
      },
      async listCarriedSkus(_client, destination) {
        return [...harness.sizesOf(destination.publicationTargetId)].filter(([, size]) => size.carried)
          .map(([productVariantId, size]) => ({ productVariantId, sku: size.sku }));
      },
      async readSkus(_client, destination, ids) {
        harness.fail("readSkus");
        return ids.flatMap(id => {
          const size = harness.sizesOf(destination.publicationTargetId).get(id);
          return size ? [{ productVariantId: id, productId: size.productId, cardShellzSku: size.sku, feedHintItemId: size.hint }] : [];
        });
      },
      async readFingerprint() { return harness.fingerprint; },
      async lockForConfirmation() { throw new Error("The stand-in command never confirms."); },
    };
    const adapter: StockLinkAdapter = {
      destinationKind: "channel_connection", providerKey: "shopify",
      async findItemsBySku(destination, skus, options) {
        harness.calls.push({ targetId: destination.publicationTargetId, kind: "lookup", values: [...skus], aborted: options.signal.aborted });
        harness.beforeCall("lookup", harness.calls.length);
        harness.fail("provider");
        if (options.signal.aborted) throw new StockLinkError(C.callBudgetUsed, "The tick's time is up.", {});
        const keys = new Set(skus.map(sku => normalizeStockLinkSku(sku)).flatMap(sku => sku.kind === "sku" ? [sku.key] : []));
        const items = [...harness.storeOf(destination.publicationTargetId).values()].filter(candidate => {
          const sku = normalizeStockLinkSku(candidate.sku);
          return sku.kind === "sku" && keys.has(sku.key);
        });
        return { observedAt: new Date(harness.now).toISOString(), readFingerprint: harness.fingerprint, skus: [...skus], items };
      },
      async observeItems(destination, itemIds, options) {
        harness.calls.push({ targetId: destination.publicationTargetId, kind: "observe", values: [...itemIds], aborted: options.signal.aborted });
        harness.beforeCall("observe", harness.calls.length);
        harness.fail("provider");
        if (options.signal.aborted) throw new StockLinkError(C.callBudgetUsed, "The tick's time is up.", {});
        return { observedAt: new Date(harness.now).toISOString(), readFingerprint: harness.fingerprint,
          observations: itemIds.map(itemId => ({ itemId, item: harness.storeOf(destination.publicationTargetId).get(itemId) ?? null })) };
      },
    };
    const store: StockLinkTickStore = {
      readAuthority: async () => { this.fail("readAuthority"); return this.authority; },
      listTargets: async () => [...this.targets].map(([id, target]): StockLinkTargetRow => ({ publicationTargetId: id,
        destination: destinationOf(id), destinationKind: "channel_connection", providerKey: "shopify",
        heldAt: target.held ? new Date(START) : null })),
      beat: async (targetId, now) => {
        this.fail("beat");
        const state = this.stateOf(targetId);
        if (state.autoLinkEnabled) state.heartbeatAt = now;
        const { heartbeatAt: _beat, ...rest } = state;
        return { ...rest, recentCursor: { ...state.recentCursor } } as StockLinkDestinationState;
      },
      saveCursors: async (targetId, update) => {
        this.cursorSaves.push({ targetId, update });
        const state = this.stateOf(targetId);
        if (update.recent) state.recentCursor = { raw: update.recent.raw, id: update.recent.id };
        if (update.sweepAfterVariantId !== undefined) state.sweepAfterVariantId = update.sweepAfterVariantId ?? 0;
        if (update.deadLetterAt !== undefined) state.deadLetterCursor = update.deadLetterAt;
      },
      insertMissingChecks: async (targetId, wanted, now) => {
        this.fail("insertMissingChecks");
        const added: number[] = [];
        for (const { productVariantId, firstVerifyAt } of wanted) {
          if (this.rowsOf(targetId).has(productVariantId) || !this.sizesOf(targetId).has(productVariantId)) continue;
          const linked = this.headsOf(targetId).get(productVariantId)?.active != null;
          this.rowsOf(targetId).set(productVariantId, this.newRow(linked ? "linked" : "waiting", linked ? firstVerifyAt : now, now));
          added.push(productVariantId);
        }
        return added.sort((a, b) => a - b);
      },
      wakeChecks: async (targetId, ids, now) => {
        this.wakes.push({ targetId, ids: [...ids] });
        const woken: number[] = [];
        for (const id of ids) {
          const row = this.rowsOf(targetId).get(id);
          if (!row || row.status === "error" || (row.leaseToken !== null && row.leaseExpiresAt! > now) || row.nextCheckAt! <= now) continue;
          Object.assign(row, { nextCheckAt: now, updatedAt: now, revision: row.revision + 1 });
          woken.push(id);
        }
        return woken.sort((a, b) => a - b);
      },
      deleteUncarriedChecks: async (targetId, range, carried, now) => {
        const deleted: number[] = [];
        for (const [id, row] of this.rowsOf(targetId)) {
          if (id <= range.afterVariantId || (range.throughVariantId !== null && id > range.throughVariantId) || carried.includes(id)) continue;
          if ((row.leaseToken !== null && row.leaseExpiresAt! > now) || this.headsOf(targetId).get(id)?.active) continue;
          this.rowsOf(targetId).delete(id);
          deleted.push(id);
        }
        return deleted;
      },
      listDeadLetterWakes: async (targetId, after, limit) => {
        const due = (this.deadLetters.get(targetId) ?? []).filter(row => after === null || row.at > after).slice(0, limit);
        return { productVariantIds: [...new Set(due.map(row => row.productVariantId))].sort((a, b) => a - b),
          lastAt: due.length === 0 ? null : due[due.length - 1]!.at };
      },
      claimDue: async (targetId, input) => {
        this.claimCalls.push(targetId);
        this.fail("claimDue");
        const due = [...this.rowsOf(targetId)].filter(([, row]) => row.status !== "error" && row.nextCheckAt! <= input.now
          && (row.leaseToken === null || row.leaseExpiresAt! <= input.now))
          .sort(([a, x], [b, y]) => x.nextCheckAt!.getTime() - y.nextCheckAt!.getTime() || a - b).slice(0, input.limit);
        return due.map(([id, row]): StockLinkClaimedCheck => {
          Object.assign(row, { leaseToken: input.leaseToken, leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
            revision: row.revision + 1 });
          return { productVariantId: id, leaseToken: input.leaseToken, revision: String(row.revision), status: row.status,
            observedSku: row.observedSku, nextCheckAt: row.nextCheckAt! };
        });
      },
      readHeads: async targetId => {
        this.fail("readHeads");
        return [...this.headsOf(targetId)].map(([id, head]): StockLinkHeadRead => ({ productVariantId: id, revision: String(head.revision),
          active: head.active ? { ...head.active } : null, draft: null }));
      },
      readSelection: async (destination, _productId, ids) =>
        new Map(ids.map(id => [id, this.sizesOf(destination.publicationTargetId).get(id)!.selection])),
      countRecentRetires: async () => this.recentRetires,
      recordOutcomes: async (targetId, guards, now, decide) => {
        this.fail("recordOutcomes");
        this.recordCalls.push({ targetId, ids: guards.map(guard => guard.productVariantId) });
        return this.write(targetId, guards, now, decide);
      },
      deleteClaimedChecks: async (targetId, guards) => {
        const deleted = guards.filter(guard => {
          const row = this.rowsOf(targetId).get(guard.productVariantId);
          return row && row.leaseToken === guard.leaseToken && String(row.revision) === guard.revision;
        }).map(guard => guard.productVariantId);
        for (const id of deleted) this.rowsOf(targetId).delete(id);
        this.deletedClaimed.push(...deleted);
        return deleted;
      },
      pause: async (targetId, input) => {
        this.pauses.push({ targetId, code: input.code, until: input.until });
        const state = this.stateOf(targetId);
        const started = state.pausedSince === null;
        Object.assign(state, { pausedUntil: input.until, pausedCode: input.code, pausedSince: state.pausedSince ?? input.now });
        return started;
      },
      clearPause: async (targetId, codes) => {
        const state = this.stateOf(targetId);
        if (!state.pausedCode || !codes.includes(state.pausedCode)) return null;
        const code = state.pausedCode;
        Object.assign(state, { pausedUntil: null, pausedCode: null, pausedSince: null });
        return code;
      },
      halt: async (targetId, input) => {
        const state = this.stateOf(targetId);
        if (state.haltedAt !== null) return false;
        Object.assign(state, { haltedAt: input.now, haltedCode: input.code });
        this.halts.push({ targetId, code: input.code });
        return true;
      },
    };
    this.service = new StockLinkService({
      store, registry: createStockLinkRegistry([{ adapter, source }]),
      runCommand: async request => { this.commands.push(request); return this.command(request); },
      db: { query: async () => ({ rows: [] }) },
      clock: () => new Date(this.now), monotonicNow: () => this.monotonic, random: () => 0.5,
      newLeaseToken: () => `00000000-0000-4000-8000-${String(++this.leaseSeq).padStart(12, "0")}`,
      logger: this.log, deadline: () => this.controller.signal,
    });
  }

  fail(at: string): void {
    const queue = this.failures.get(at);
    if (queue && queue.length > 0) throw queue.shift();
  }
  addTarget(targetId: number, state: Partial<StockLinkDestinationState> = {}, options: { held?: boolean } = {}): void {
    this.targets.set(targetId, { held: options.held === true });
    this.states.set(targetId, { autoLinkEnabled: true, pausedUntil: null, pausedCode: null, pausedSince: null, haltedAt: null,
      haltedCode: null, retiresReleasedAt: null, recentCursor: { raw: null, id: null }, sweepAfterVariantId: 0, deadLetterCursor: null,
      heartbeatAt: null, ...state });
  }
  stateOf(targetId: number) { return this.states.get(targetId)!; }
  rowsOf(targetId: number) { return this.mapOf(this.rows, targetId); }
  sizesOf(targetId: number) { return this.mapOf(this.sizes, targetId); }
  headsOf(targetId: number) { return this.mapOf(this.heads, targetId); }
  storeOf(targetId: number) { return this.mapOf(this.store, targetId) as Map<string, StockLinkStoreItem>; }
  private mapOf<K, V>(maps: Map<number, Map<K, V>>, targetId: number): Map<K, V> {
    if (!maps.has(targetId)) maps.set(targetId, new Map());
    return maps.get(targetId)!;
  }
  /** A carried size (publish, no blockers by default) of product `productId`. */
  addSize(targetId: number, productVariantId: number, size: Partial<Size> & { productId?: number } = {}): void {
    this.sizesOf(targetId).set(productVariantId, { productId: size.productId ?? productVariantId, sku: `SKU-${productVariantId}`,
      hint: null, carried: true, selection: { action: "publish", blockerCodes: [] }, ...size });
  }
  link(targetId: number, productVariantId: number, itemId: string, externalSku: string | null = `SKU-${productVariantId}`): void {
    this.headsOf(targetId).set(productVariantId, { revision: 2, active: { mappingId: this.mapping++, itemId, externalSku } });
  }
  newRow(status: Row["status"], nextCheckAt: Date | null, now: Date, extra: Partial<Row> = {}): Row {
    return { status, reasonCode: null, errorClass: null, message: null, attemptCount: 0, firstFailureAt: null, busySince: null,
      nextCheckAt, updatedAt: now, waitingItemId: null, observedSku: null, revision: 1, leaseToken: null, leaseExpiresAt: null, ...extra };
  }
  setRow(targetId: number, productVariantId: number, status: Row["status"], extra: Partial<Row> = {}): Row {
    const row = this.newRow(status, status === "error" ? null : new Date(this.now), new Date(this.now), extra);
    this.rowsOf(targetId).set(productVariantId, row);
    return row;
  }
  row(targetId: number, productVariantId: number): Row { return this.rowsOf(targetId).get(productVariantId)!; }

  /** The command's step 10 as the real policy writes it: heads moved, members' rows settled (guarded), freed rows woken. */
  write(targetId: number, guards: readonly { productVariantId: number; leaseToken: string | null; revision: string }[], now: Date,
    decide: (productVariantId: number, previous: StockLinkCheckFacts) => StockLinkCheckWrite): number[] {
    const written: number[] = [];
    for (const guard of guards) {
      const row = this.rowsOf(targetId).get(guard.productVariantId);
      if (!row || row.leaseToken !== guard.leaseToken || String(row.revision) !== guard.revision) continue;
      Object.assign(row, decide(guard.productVariantId, { ...row }), { leaseToken: null, leaseExpiresAt: null, revision: row.revision + 1,
        updatedAt: now });
      written.push(guard.productVariantId);
    }
    return written;
  }
  async applyCommand(request: StockLinkCommandRequest): Promise<StockLinkCommandResult> {
    const targetId = request.destination.publicationTargetId;
    const now = new Date(this.now);
    const members = new Map<number, StockLinkSizeDecision>(request.command.members.map(member => [member.productVariantId, member]));
    for (const member of members.values()) {
      const head = this.headsOf(targetId).get(member.productVariantId) ?? { revision: 0, active: null };
      this.headsOf(targetId).set(member.productVariantId, { revision: head.revision + 1,
        active: member.link ? { mappingId: this.mapping++, itemId: member.link.itemId, externalSku: member.link.storeSku } : null });
    }
    this.write(targetId, request.claims, now, (id, previous) => stockLinkCheckAfterDecision(members.get(id)!, previous, now, () => 0.5));
    const woken: number[] = [];
    for (const [id, row] of this.rowsOf(targetId)) {
      if (row.waitingItemId && request.command.freedItemIds.includes(row.waitingItemId) && row.status !== "error"
        && row.leaseToken === null && row.nextCheckAt! > now) {
        Object.assign(row, { nextCheckAt: now, updatedAt: now, revision: row.revision + 1 });
        woken.push(id);
      }
    }
    return { status: "applied", commandKey: "00000000-0000-5000-8000-000000000001", action: "linked", preparation: null,
      retiredMappingIds: [], wokenProductVariantIds: woken, fenceHoldMs: this.fenceHoldMs, cleanupUncertain: false };
  }
  tick() { return this.service.tick(); }
  /** Lines the service logged at `level` with this outcome. */
  logged(level: keyof Harness["log"], outcome: string) {
    return this.log[level].mock.calls.filter(([, event]) => (event as { outcome?: string }).outcome === outcome);
  }
}

/** A harness with one Shopify destination (target 1). */
function oneDestination(state: Partial<StockLinkDestinationState> = {}): Harness {
  const harness = new Harness();
  harness.addTarget(1, state);
  return harness;
}

describe("StockLinkService.tick (PLAN-CH2 v4.1 §7.2, §11.3)", () => {
  it("links a new size end to end: discovery adds its row, the tick claims it, reads the store and runs one command", async () => {
    const h = oneDestination();
    h.addSize(1, 101, { hint: "5001" });
    h.storeOf(1).set("5001", item("5001", "SKU-101"));
    const summary = await h.tick();

    expect(h.stateOf(1).heartbeatAt).toEqual(new Date(START));
    expect(h.calls.map(call => [call.kind, call.values])).toEqual([["observe", ["5001"]], ["lookup", ["SKU-101"]]]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]!.command.members).toMatchObject([{ productVariantId: 101, change: "link", rule: "L10",
      link: { itemId: "5001", storeSku: "SKU-101", mappingAction: "create" } }]);
    // The command gets the claim as taken and the reads' evidence: the oldest read time and their one fingerprint.
    expect(h.commands[0]!.claims).toEqual([{ productVariantId: 101, leaseToken: "00000000-0000-4000-8000-000000000001", revision: "2" }]);
    expect(h.commands[0]!.evidence).toEqual({ observedAt: new Date(START).toISOString(), readFingerprint: FINGERPRINT });
    expect(h.row(1, 101)).toMatchObject({ status: "linked", leaseToken: null, attemptCount: 0, nextCheckAt: new Date(START + 24 * HOUR) });
    // The member's row is the command's: the tick records nothing else for it.
    expect(h.recordCalls).toEqual([{ targetId: 1, ids: [] }]);
    expect(h.cursorSaves).toEqual([{ targetId: 1, update: { sweepAfterVariantId: null } }]);
    expect(summary).toMatchObject({ outcome: "completed", destinations: 1, claimed: 1, providerCalls: 2, observations: 1, lookups: 1,
      applies: 1, links: 1, relinks: 0, retires: 0, flags: 0, fenceHoldMsTotal: 50, fenceHoldMsMax: 50 });
    expect(h.log.info).toHaveBeenLastCalledWith("inventory_availability.stock_link.tick", expect.objectContaining({
      outcome: "completed", actor: "system:stock-link", applies: 1, links: 1, fence_hold_ms_total: 50, fence_hold_ms_max: 50 }));
  });

  it("idles under legacy authority: no heartbeat, no claim, one DEBUG line, and the summary says why", async () => {
    const h = oneDestination();
    h.authority = "legacy";
    h.addSize(1, 101);
    expect(await h.tick()).toMatchObject({ outcome: "legacy_authority", destinations: 0, claimed: 0 });
    expect(h.stateOf(1).heartbeatAt).toBeNull();
    expect(h.claimCalls).toEqual([]);
    expect(h.logged("debug", "skipped")).toEqual([["inventory_availability.stock_link.tick",
      { outcome: "skipped", reason: "legacy_authority", actor: "system:stock-link" }]]);
  });

  it("beats for a paused and a halted destination too, then stops there; a switched-off one gets no beat (TST-9)", async () => {
    const h = new Harness();
    h.addTarget(1, { pausedUntil: new Date(START + 10 * MIN), pausedCode: C.storeAuthRefused, pausedSince: new Date(START - HOUR) });
    h.addTarget(2, { haltedAt: new Date(START - HOUR), haltedCode: C.unclassified });
    h.addTarget(3, { autoLinkEnabled: false });
    h.addTarget(4);
    h.addTarget(5, {}, { held: true });
    for (const target of [1, 2, 3, 4, 5]) h.addSize(target, 101);
    await h.tick();
    expect([1, 2, 3, 4, 5].map(target => h.stateOf(target).heartbeatAt)).toEqual([new Date(START), new Date(START), null,
      new Date(START), new Date(START)]);
    // Only the running destination is claimed; a held target publishes nothing, so nothing is linked for it.
    expect(h.claimCalls).toEqual([4]);
    expect(h.logged("debug", "skipped").map(([, event]) => [(event as Record<string, unknown>).publication_target_id,
      (event as Record<string, unknown>).reason])).toEqual([[1, "paused"], [2, "halted"], [3, "switch_off"], [5, "target_held"]]);
  });

  it("skips a destination no policy covers at DEBUG, without a row or a beat", async () => {
    const h = oneDestination();
    const service = new StockLinkService({ ...(h.service as unknown as { deps: ConstructorParameters<typeof StockLinkService>[0] }).deps,
      registry: { resolve: () => null } });
    expect(await service.tick()).toMatchObject({ outcome: "completed", destinations: 0 });
    expect(h.stateOf(1).heartbeatAt).toBeNull();
    expect(h.logged("debug", "skipped")).toEqual([["inventory_availability.stock_link.tick", expect.objectContaining({
      reason: "no_policy", publication_target_id: 1, destination_kind: "channel_connection", provider_key: "shopify" })]]);
  });

  describe("discovery (§7.2 steps 2-3, SAF-6)", () => {
    const change = (productVariantId: number, feedId: number, fresh: boolean, carried = true): StockLinkRecentChange => ({
      productVariantId, productId: productVariantId, changedAtRaw: `2026-10-27 11:${String(feedId % 60).padStart(2, "0")}:00.000000`,
      feedId, carried, fresh });

    it("wakes a waiting row at a 24 h backoff when its feed changes, and moves the cursor past that change only", async () => {
      const h = oneDestination({ recentCursor: { raw: "2026-10-27 10:00:00.000000", id: 1 } });
      h.addSize(1, 101);
      h.setRow(1, 101, "waiting", { reasonCode: "STOCK_LINK_NOT_LISTED", nextCheckAt: new Date(START + 24 * HOUR),
        updatedAt: new Date(START) });
      h.recent.set(1, [change(101, 7, true)]);
      h.storeOf(1).set("5001", item("5001", "SKU-101"));
      await h.tick();
      expect(h.wakes[0]).toEqual({ targetId: 1, ids: [101] });
      expect(h.commands.map(request => request.command.members.map(member => member.productVariantId))).toEqual([[101]]);
      expect(h.row(1, 101)).toMatchObject({ status: "linked" });
      expect(h.stateOf(1).recentCursor).toEqual({ raw: "2026-10-27 11:07:00.000000", id: 7 });
    });

    it("wakes at most 200 changed rows a tick, oldest change first; the overlap behind the cursor only adds missing rows", async () => {
      const h = oneDestination({ recentCursor: { raw: "2026-10-27 10:00:00.000000", id: 1 } });
      const changes: StockLinkRecentChange[] = [];
      for (let index = 0; index < 250; index += 1) {
        const id = 1_000 + index;
        h.addSize(1, id, { sku: null });
        h.setRow(1, id, "flagged", { reasonCode: "STOCK_LINK_SKU_BLANK", nextCheckAt: new Date(START + 24 * HOUR) });
        changes.push(change(id, 10 + index, true));
      }
      h.addSize(1, 2_000, { sku: null });
      h.setRow(1, 2_000, "flagged", { reasonCode: "STOCK_LINK_SKU_BLANK", nextCheckAt: new Date(START + 24 * HOUR) });
      h.addSize(1, 2_001, { sku: null });
      changes.push(change(2_000, 5, false), change(2_001, 6, false));
      h.recent.set(1, changes);
      await h.tick();
      expect(h.wakes[0]!.ids).toEqual(changes.slice(0, 200).map(row => row.productVariantId));
      expect(h.stateOf(1).recentCursor).toEqual({ raw: changes[199]!.changedAtRaw, id: changes[199]!.feedId });
      // The overlap's existing row is not woken; its missing one is added (due now) and decided this tick.
      expect(h.row(1, 2_000).nextCheckAt).toEqual(new Date(START + 24 * HOUR));
      expect(h.row(1, 2_001)).toMatchObject({ status: "flagged", reasonCode: "STOCK_LINK_SKU_BLANK" });
      expect(h.row(1, 1_249).nextCheckAt).toEqual(new Date(START + 24 * HOUR));
    });

    it("adds a linked size's row with a spread first verify, wakes a dead letter's size and keeps the dead-letter cursor", async () => {
      const h = oneDestination();
      h.addSize(1, 101);
      h.link(1, 101, "5001");
      h.addSize(1, 102);
      h.link(1, 102, "5002");
      h.setRow(1, 102, "linked", { nextCheckAt: new Date(START + 20 * HOUR) });
      h.deadLetters.set(1, [{ productVariantId: 102, at: "2026-10-27T11:59:00.123456Z" }]);
      h.storeOf(1).set("5002", item("5002", "SKU-102"));
      await h.tick();
      // random 0.5 → half a day; the size is linked already, so it is verified then, not now.
      expect(h.row(1, 101)).toMatchObject({ status: "linked", nextCheckAt: new Date(START + 12 * HOUR) });
      expect(h.wakes.find(wake => wake.ids.includes(102))).toBeDefined();
      expect(h.calls.map(call => call.values)).toEqual([["5002"], ["SKU-102"]]);
      expect(h.row(1, 102)).toMatchObject({ status: "linked", nextCheckAt: new Date(START + 24 * HOUR) });
      expect(h.stateOf(1).deadLetterCursor).toBe("2026-10-27T11:59:00.123456Z");
    });

    it("retains a scoped selection exclusion without registering or calling the provider", async () => {
      const h = oneDestination();
      h.addSize(1, 101, { productId: 20, selection: { action: "read_only", blockerCodes: [] } });
      await h.service.checkProduct({ productId: 20, targets: [{ publicationTargetId: 1, productVariantIds: [101] }] });
      expect(h.deletedClaimed).toEqual([]);
      expect(h.row(1, 101)).toMatchObject({ status: "waiting", reasonCode: "STOCK_LINK_SELECTION_BLOCKED", leaseToken: null });
      expect(h.row(1, 101).nextCheckAt!.getTime()).toBeGreaterThan(START);
      expect(h.calls).toEqual([]);
      expect(h.commands).toEqual([]);
    });

    it("deletes the row of a claimed size the selection no longer carries and that is not linked (D-P6-10)", async () => {
      const h = oneDestination();
      h.addSize(1, 101, { selection: { action: "read_only", blockerCodes: [] } });
      h.addSize(1, 102, { selection: { action: "publish", blockerCodes: ["CHANNEL_FEED_QUARANTINED"] } });
      await h.tick();
      expect(h.deletedClaimed).toEqual([101]);
      expect(h.rowsOf(1).has(101)).toBe(false);
      expect(h.row(1, 102)).toMatchObject({ status: "waiting", reasonCode: "STOCK_LINK_SELECTION_BLOCKED" });
      expect(h.calls).toEqual([]);
    });

    it("keeps claiming due rows when discovery is busy (a lock held elsewhere), and logs it at DEBUG", async () => {
      const h = oneDestination();
      h.addSize(1, 101, { sku: null });
      h.setRow(1, 101, "waiting");
      h.failures.set("insertMissingChecks", [Object.assign(new Error("lock timeout"), { code: "55P03" })]);
      await h.tick();
      expect(h.row(1, 101)).toMatchObject({ status: "flagged", reasonCode: "STOCK_LINK_SKU_BLANK" });
      expect(h.cursorSaves).toEqual([]);
      expect(h.logged("debug", "busy")).toEqual([["inventory_availability.stock_link.tick", expect.objectContaining({
        phase: "discovery", error_code: "STOCK_LINK_DATABASE_BUSY" })]]);
    });
  });

  describe("holders and freed items (SAF-5)", () => {
    it("sets the holder of a candidate due now when the candidate is held by another size", async () => {
      const h = oneDestination();
      h.addSize(1, 101);
      h.addSize(1, 201, { sku: "SKU-201" });
      h.link(1, 201, "5001", "SKU-201");
      h.setRow(1, 201, "linked", { nextCheckAt: new Date(START + 20 * HOUR) });
      // The store moved the SKU of size 101 onto the item size 201 is linked to.
      h.storeOf(1).set("5001", item("5001", "SKU-101"));
      await h.tick();
      expect(h.row(1, 101)).toMatchObject({ status: "flagged", reasonCode: "STOCK_LINK_ITEM_SHARED", waitingItemId: "5001" });
      expect(h.wakes.at(-1)).toEqual({ targetId: 1, ids: [201] });
      expect(h.row(1, 201).nextCheckAt).toEqual(new Date(START));
      expect(h.commands).toEqual([]);
      expect(h.logged("error", "flagged")).toHaveLength(1);
    });

    it("hands the command the items it frees, and the freeing command wakes the rows waiting on them", async () => {
      const h = oneDestination();
      h.addSize(1, 201, { sku: "SKU-201" });
      h.link(1, 201, "5001", "SKU-201");
      h.setRow(1, 201, "linked");
      h.addSize(1, 101);
      h.setRow(1, 101, "flagged", { reasonCode: "STOCK_LINK_ITEM_SHARED", waitingItemId: "5001",
        nextCheckAt: new Date(START + 20 * HOUR) });
      // 201's item now carries 101's SKU (V4: it is 101's item now); 201's own SKU moved to item 5002.
      h.storeOf(1).set("5001", item("5001", "SKU-101"));
      h.storeOf(1).set("5002", item("5002", "SKU-201"));
      await h.tick();
      expect(h.commands).toHaveLength(1);
      expect(h.commands[0]!.command).toMatchObject({ productId: 201, freedItemIds: ["5001"],
        members: [{ productVariantId: 201, change: "relink", rule: "V4/L10", link: { itemId: "5002" } }] });
      expect(h.row(1, 101)).toMatchObject({ status: "flagged", nextCheckAt: new Date(START) });
    });
  });

  describe("failures (§4.6): paused vs transient vs exhausted", () => {
    function claimedLookup(): Harness {
      const h = oneDestination();
      h.addSize(1, 101);
      h.setRow(1, 101, "waiting", { reasonCode: "STOCK_LINK_NOT_LISTED" });
      return h;
    }

    it("pauses the destination on a refused login and leaves the claimed rows to expire (no attempt, no row write)", async () => {
      const h = claimedLookup();
      h.failures.set("provider", [new StockLinkError(C.storeAuthRefused, "The store refused the login.", {})]);
      await h.tick();
      expect(h.pauses).toEqual([{ targetId: 1, code: C.storeAuthRefused, until: new Date(START + 15 * MIN) }]);
      expect(h.stateOf(1)).toMatchObject({ pausedCode: C.storeAuthRefused, pausedSince: new Date(START) });
      expect(h.row(1, 101)).toMatchObject({ status: "waiting", attemptCount: 0, leaseToken: expect.any(String), busySince: null });
      expect(h.recordCalls).toEqual([]);
      expect(h.logged("warn", "paused")).toHaveLength(1);
      // The next tick (still inside the pause) beats and stops there.
      h.now += 5 * MIN;
      await h.tick();
      expect(h.claimCalls).toEqual([1]);
      expect(h.stateOf(1).heartbeatAt).toEqual(new Date(START + 5 * MIN));
    });

    it("lifts a login pause once the store answers again", async () => {
      const h = oneDestination({ pausedUntil: new Date(START - MIN), pausedCode: C.storeAuthRefused, pausedSince: new Date(START - HOUR) });
      h.addSize(1, 101);
      h.setRow(1, 101, "waiting");
      await h.tick();
      expect(h.stateOf(1)).toMatchObject({ pausedCode: null, pausedSince: null });
      expect(h.logged("info", "resumed")).toHaveLength(1);
    });

    it("records a transient store failure on the unread rows: one attempt, Retry-After honoured, one WARN for the streak", async () => {
      const h = claimedLookup();
      h.failures.set("provider", [new StockLinkError(C.providerThrottled, "Throttled.", {}, { retryAfterMs: 20 * MIN })]);
      await h.tick();
      expect(h.row(1, 101)).toMatchObject({ status: "waiting", reasonCode: C.providerThrottled, errorClass: "transient", attemptCount: 1,
        firstFailureAt: new Date(START), busySince: null, leaseToken: null, nextCheckAt: new Date(START + 20 * MIN) });
      expect(h.logged("warn", "retry_scheduled")).toHaveLength(1);
      expect(h.pauses).toEqual([]);
    });

    it("releases rows busy when the call budget runs out: no attempt, the busy streak starts, the next tick progresses (TST-12)", async () => {
      const h = oneDestination();
      for (let index = 0; index < 500; index += 1) {
        const id = 10_000 + index;
        h.addSize(1, id, { sku: `S-${id}`, hint: String(700_000 + index) });
        h.link(1, id, String(500_000 + index), `S-${id}`);
        h.setRow(1, id, "linked", { attemptCount: index === 499 ? 2 : 0, firstFailureAt: index === 499 ? new Date(START - HOUR) : null });
        h.storeOf(1).set(String(500_000 + index), item(String(500_000 + index), `S-${id}`));
      }
      const first = await h.tick();
      // Each 50 sizes need one lookup and one observe of 100 items (their links and their hints): 19 calls fit, one is kept.
      expect(first).toMatchObject({ claimed: 500, providerCalls: 19 });
      const busy = [...h.rowsOf(1)].filter(([, row]) => row.reasonCode === C.callBudgetUsed);
      expect(busy).toHaveLength(50);
      for (const [, row] of busy) expect(row).toMatchObject({ status: "linked", errorClass: "transient", busySince: new Date(START) });
      // Busy never counts an attempt (DV4-4): a row in a transient streak keeps its count and its streak start.
      expect(h.row(1, 10_499)).toMatchObject({ attemptCount: 2, firstFailureAt: new Date(START - HOUR), busySince: new Date(START),
        nextCheckAt: new Date(START + 120_000) });
      expect([...h.rowsOf(1)].filter(([, row]) => row.nextCheckAt!.getTime() === START + 24 * HOUR)).toHaveLength(450);
      h.now += 3 * MIN;
      h.calls.length = 0;
      expect(await h.tick()).toMatchObject({ claimed: 50, providerCalls: 2 });
      expect([...h.rowsOf(1)].filter(([, row]) => row.reasonCode === C.callBudgetUsed)).toHaveLength(0);
      expect(h.row(1, 10_499)).toMatchObject({ attemptCount: 0, busySince: null, nextCheckAt: new Date(START + 3 * MIN + 24 * HOUR) });
    });

    it("stops starting provider calls after 30 s and releases the rows not read busy", async () => {
      const h = oneDestination();
      for (const id of [101, 102]) {
        h.addSize(1, id, { productId: 1 });
        h.setRow(1, id, "waiting");
      }
      for (let index = 0; index < 60; index += 1) {
        h.addSize(1, 300 + index, { productId: 3 });
        h.setRow(1, 300 + index, "waiting", { nextCheckAt: new Date(START - MIN) });
      }
      h.beforeCall = () => { h.monotonic = 31_000; };
      const summary = await h.tick();
      expect(summary.providerCalls).toBe(1);
      expect(h.calls[0]!.values).toHaveLength(50);
      const released = [...h.rowsOf(1)].filter(([, row]) => row.reasonCode === C.callBudgetUsed).map(([id]) => id);
      expect(released).toHaveLength(12);
      expect(h.commands).toEqual([]);
    });

    it("never sends a read after the hard stop: the aborted read is busy, nothing counts an attempt", async () => {
      const h = claimedLookup();
      // Two reads are needed (the feed hint's observation, then the SKU lookup); the hard stop fires during the first.
      h.addSize(1, 101, { hint: "5001" });
      h.beforeCall = () => h.controller.abort();
      await h.tick();
      expect(h.calls).toEqual([{ targetId: 1, kind: "observe", values: ["5001"], aborted: false }]);
      expect(h.row(1, 101)).toMatchObject({ reasonCode: C.callBudgetUsed, attemptCount: 0, busySince: new Date(START), leaseToken: null });
      expect(h.commands).toEqual([]);
    });

    it("starts no destination once the hard stop has fired: nothing is claimed or read", async () => {
      const h = claimedLookup();
      h.controller.abort();
      await h.tick();
      expect(h.claimCalls).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.row(1, 101)).toMatchObject({ reasonCode: "STOCK_LINK_NOT_LISTED", attemptCount: 0, leaseToken: null });
      expect(h.stateOf(1).heartbeatAt).toEqual(new Date(START));
    });

    it("stops the tick when the database is lost mid-tick: nothing more is written, no row turns error, no halt (TST-2)", async () => {
      const h = new Harness();
      h.addTarget(1);
      h.addTarget(2);
      for (const target of [1, 2]) { h.addSize(target, 101); h.setRow(target, 101, "waiting"); }
      h.failures.set("readHeads", [Object.assign(new Error("Connection terminated unexpectedly"), {})]);
      const summary = await h.tick();
      expect(summary.outcome).toBe("database_unavailable");
      expect(h.claimCalls).toEqual([1]);
      expect(h.recordCalls).toEqual([]);
      expect(h.halts).toEqual([]);
      expect(h.row(1, 101)).toMatchObject({ status: "waiting", leaseToken: expect.any(String), attemptCount: 0 });
      expect(h.log.error).not.toHaveBeenCalled();
      expect(h.logged("warn", "database_unavailable")).toHaveLength(1);
    });

    it("halts the destination once with one ERROR on an unknown failure, and skips it after (DV4-13)", async () => {
      const h = claimedLookup();
      h.failures.set("provider", [new TypeError("cannot read properties of undefined")]);
      await h.tick();
      expect(h.halts).toEqual([{ targetId: 1, code: C.unclassified }]);
      expect(h.logged("error", "halted")).toEqual([["inventory_availability.stock_link.tick", expect.objectContaining({
        phase: "store_read", error_code: C.unclassified, error_class: "fatal", cause_code: "TypeError" })]]);
      h.now += 10 * MIN;
      await h.tick();
      expect(h.claimCalls).toEqual([1]);
      expect(h.logged("error", "halted")).toHaveLength(1);
    });

    it("never retries a permanent failure: the tick halts the destination instead of releasing its rows for a retry (B8)", async () => {
      const h = claimedLookup();
      h.failures.set("claimDue", [Object.assign(new Error("new row violates check constraint"), { code: "23514" })]);
      await h.tick();
      expect(h.halts).toEqual([{ targetId: 1, code: C.checkViolation }]);
      expect(h.logged("error", "halted")).toHaveLength(1);
      h.now += 30 * MIN;
      await h.tick();
      await h.tick();
      expect(h.claimCalls).toEqual([1]);
      expect(h.calls).toEqual([]);
    });

    it("stops a row on a permanent command failure and never claims it again until Check again (B8)", async () => {
      const h = claimedLookup();
      h.storeOf(1).set("5001", item("5001", "SKU-101"));
      h.command = async request => {
        // The policy's own failure path: classify, write each claimed row's outcome guarded by the claim.
        const failure = classifyStockLinkFailure(new StockLinkError("STOCK_MAPPING_COMMAND_CONFLICT", "Conflict.", {}));
        const now = new Date(h.now);
        const recorded = h.write(1, request.claims, now, (_id, previous) => stockLinkCheckAfterFailure(failure, "Conflict.", previous, now, () => 0.5));
        return { status: "failed", commandKey: "00000000-0000-5000-8000-000000000001", failure, message: "Conflict.",
          recordedProductVariantIds: recorded, fenceHoldMs: 10 };
      };
      await h.tick();
      expect(h.row(1, 101)).toMatchObject({ status: "error", errorClass: "permanent", reasonCode: "STOCK_MAPPING_COMMAND_CONFLICT",
        nextCheckAt: null, leaseToken: null });
      for (const later of [HOUR, 25 * HOUR, 72 * HOUR]) {
        h.now = START + later;
        h.calls.length = 0;
        expect(await h.tick()).toMatchObject({ claimed: 0 });
        expect(h.calls).toEqual([]);
      }
      expect(h.commands).toHaveLength(1);
    });

    it("decides again when the store was read with two different logins (STOCK_LINK_CONNECTION_CHANGED, an attempt)", async () => {
      const h = claimedLookup();
      h.addSize(1, 102, { hint: "5002" });
      h.setRow(1, 102, "waiting");
      h.beforeCall = (_kind, call) => { if (call === 2) h.fingerprint = OTHER_FINGERPRINT; };
      await h.tick();
      expect(h.commands).toEqual([]);
      for (const id of [101, 102]) expect(h.row(1, id)).toMatchObject({ reasonCode: C.connectionChanged, attemptCount: 1 });
    });
  });

  describe("the fence budget (§4.7)", () => {
    function products(count: number): Harness {
      const h = oneDestination();
      for (let index = 0; index < count; index += 1) {
        const id = 100 + index;
        h.addSize(1, id);
        h.setRow(1, id, "waiting");
        h.storeOf(1).set(String(5_000 + index), item(String(5_000 + index), `SKU-${id}`));
      }
      return h;
    }

    it("runs at most 10 fenced commands a tick; the rest are released busy with no attempt", async () => {
      const h = products(12);
      const summary = await h.tick();
      expect(h.commands).toHaveLength(10);
      expect(summary).toMatchObject({ applies: 10, links: 10, fenceHoldMsTotal: 500, fenceHoldMsMax: 50 });
      for (const id of [110, 111]) {
        expect(h.row(1, id)).toMatchObject({ status: "waiting", reasonCode: C.fenceBudgetUsed, attemptCount: 0, busySince: new Date(START) });
      }
    });

    it("stops after one hold over 2 s, or 3 s in all; a fast path that took no fence does not count", async () => {
      const slow = products(3);
      slow.fenceHoldMs = 2_500;
      await slow.tick();
      expect(slow.commands).toHaveLength(1);
      const total = products(5);
      total.fenceHoldMs = 1_500;
      await total.tick();
      expect(total.commands).toHaveLength(2);
      const fast = products(12);
      fast.fenceHoldMs = null;
      await fast.tick();
      expect(fast.commands).toHaveLength(12);
    });
  });

  describe("commands and their own rows", () => {
    it("records nothing more for a command whose scope unlock was unconfirmed after COMMIT (receipt found) or rolled back (TST-7)", async () => {
      const h = oneDestination();
      for (const id of [101, 102]) {
        h.addSize(1, id);
        h.setRow(1, id, "waiting");
        h.storeOf(1).set(String(5_000 + id), item(String(5_000 + id), `SKU-${id}`));
      }
      h.command = async request => {
        const now = new Date(h.now);
        const member = request.command.members[0]!;
        if (member.productVariantId === 101) {
          // Applied: step 10 wrote the row before COMMIT; the receipt proves it.
          await h.applyCommand(request);
          return { status: "applied", commandKey: "k1", action: "linked", preparation: null, retiredMappingIds: [], wokenProductVariantIds: [],
            fenceHoldMs: 40, cleanupUncertain: true };
        }
        // Rolled back (no receipt): the policy recorded the transient attempt itself.
        const failure = classifyStockLinkFailure(new StockLinkError("STOCK_MAPPING_CLEANUP_UNCERTAIN", "Unconfirmed.", {}));
        const recorded = h.write(1, request.claims, now, (_id, previous) => stockLinkCheckAfterFailure(failure, "Unconfirmed.", previous, now, () => 0.5));
        return { status: "failed", commandKey: "k2", failure, message: "Unconfirmed.", recordedProductVariantIds: recorded, fenceHoldMs: 40 };
      };
      const summary = await h.tick();
      expect(summary).toMatchObject({ applies: 1, links: 1 });
      expect(h.row(1, 101)).toMatchObject({ status: "linked", attemptCount: 0, revision: 3 });
      expect(h.row(1, 102)).toMatchObject({ status: "waiting", attemptCount: 1, reasonCode: "STOCK_MAPPING_CLEANUP_UNCERTAIN" });
      expect(h.recordCalls).toEqual([{ targetId: 1, ids: [] }]);
    });

    it("stops the destination's tick when a command finds the switch turned off: no other row of the batch is written", async () => {
      const h = oneDestination();
      h.addSize(1, 101);
      h.addSize(1, 102, { sku: null });
      for (const id of [101, 102]) h.setRow(1, id, "waiting");
      h.storeOf(1).set("5001", item("5001", "SKU-101"));
      h.command = async () => ({ status: "stopped", commandKey: "k", reason: "switch_off", fenceHoldMs: 30 });
      await h.tick();
      expect(h.recordCalls).toEqual([]);
      expect(h.row(1, 102)).toMatchObject({ status: "waiting", leaseToken: expect.any(String) });
    });

    it("halts the destination when a command fails for the whole destination (fatal), with one ERROR from the tick", async () => {
      const h = oneDestination();
      h.addSize(1, 101);
      h.setRow(1, 101, "waiting");
      h.storeOf(1).set("5001", item("5001", "SKU-101"));
      h.command = async () => ({ status: "failed", commandKey: "k", failure: classifyStockLinkFailure(new Error("odd")), message: "odd",
        recordedProductVariantIds: [], fenceHoldMs: 10 });
      await h.tick();
      expect(h.halts).toEqual([{ targetId: 1, code: C.unclassified }]);
      expect(h.logged("error", "halted")).toEqual([["inventory_availability.stock_link.tick", expect.objectContaining({ phase: "command" })]]);
    });
  });

  describe("the safety stop before a retire (SAF-7)", () => {
    function goneLink(): Harness {
      const h = oneDestination();
      h.addSize(1, 101);
      h.link(1, 101, "5001");
      h.setRow(1, 101, "linked");
      // Another linked size outside the batch: the control item.
      h.addSize(1, 201, { sku: "SKU-201" });
      h.link(1, 201, "5201", "SKU-201");
      h.setRow(1, 201, "linked", { nextCheckAt: new Date(START + 20 * HOUR) });
      return h;
    }

    it("observes a linked item outside the retiring set before retiring a link whose item is gone, then retires", async () => {
      const h = goneLink();
      h.storeOf(1).set("5201", item("5201", "SKU-201"));
      await h.tick();
      expect(h.calls.map(call => [call.kind, call.values])).toEqual([["observe", ["5001"]], ["lookup", ["SKU-101"]], ["observe", ["5201"]]]);
      expect(h.commands[0]!.command.members).toMatchObject([{ productVariantId: 101, change: "retire", code: "STOCK_LINK_NOT_LISTED" }]);
      expect(h.pauses).toEqual([]);
    });

    it("retires nothing and pauses the destination when the control item is gone too; the rows are released busy", async () => {
      const h = goneLink();
      await h.tick();
      expect(h.commands).toEqual([]);
      expect(h.pauses).toEqual([{ targetId: 1, code: C.storeNotAnswering, until: new Date(START + 15 * MIN) }]);
      expect(h.row(1, 101)).toMatchObject({ status: "linked", reasonCode: C.storeNotAnswering, attemptCount: 0, busySince: new Date(START) });
      expect(h.logged("warn", "paused")).toHaveLength(1);
    });
  });

  it("logs a failure no step routed at ERROR and never throws", async () => {
    const h = oneDestination();
    h.addSize(1, 101);
    const service = new StockLinkService({ ...(h.service as unknown as { deps: ConstructorParameters<typeof StockLinkService>[0] }).deps,
      registry: { resolve: () => { throw new RangeError("registry broke"); } } });
    await expect(service.tick()).resolves.toMatchObject({ outcome: "failed" });
    expect(h.log.error).toHaveBeenCalledWith("inventory_availability.stock_link.tick", expect.objectContaining({ outcome: "failed",
      error_code: C.unclassified, cause_code: "RangeError" }));
  });

  it("hands a runner failure to one log line: a lost database at WARN, anything else at ERROR", () => {
    const h = oneDestination();
    h.service.recordTickFailure(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), { lock_id: 1 });
    h.service.recordTickFailure(new Error("odd"), { lock_id: 1 });
    expect(h.logged("warn", "tick_failed")).toEqual([["inventory_availability.stock_link.tick", expect.objectContaining({
      lock_id: 1, error_code: C.databaseUnavailable })]]);
    expect(h.logged("error", "tick_failed")).toEqual([["inventory_availability.stock_link.tick", expect.objectContaining({
      lock_id: 1, error_code: C.unclassified })]]);
  });

  it("bounds a tick as the plan says (§4.7, §7.2, C27)", () => {
    expect(STOCK_LINK_TICK_LIMITS).toEqual({ softStopMs: 30_000, hardStopMs: 45_000, claimLimit: 500, leaseMs: 300_000, recentLimit: 500,
      recentWakeLimit: 200, sweepLimit: 500, deadLetterLimit: 500, callsPerDestination: 20, commandsPerTick: 10, fenceHoldTotalMs: 3_000,
      fenceHoldSingleMs: 2_000 });
  });
});
