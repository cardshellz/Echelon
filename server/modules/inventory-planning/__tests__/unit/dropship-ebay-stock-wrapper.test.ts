import { beforeEach, describe, expect, it, vi } from "vitest";

// Channels PR2 (PLAN-CH2 v4.1 §5, P5): ensureDropshipEbayStockReady is the Dropship policy of the shared stock-link
// command. With a fake pool (the real mapping-preparation store, fence call and runner) and the capture, apply and
// gate predicate stubbed, this pins that the wrapper runs through runStockLinkCommand and that its configuration
// transaction issues exactly today's statements: no pair, scope or head lock and no 918428 pre-lock (§5: no retire
// member). Behaviour over real PostgreSQL stays pinned, unchanged, by dropship-ebay-stock-readiness.integration.test.ts,
// dropship-ebay-stock-command-lock.integration.test.ts (PG 29), DS dropship-ebay-push-stock-link.integration.test.ts
// and the key goldens (dropship-ebay-stock-keys.golden.test.ts).
const stubs = vi.hoisted(() => ({ member: vi.fn(), capture: vi.fn(), memberRows: vi.fn(), review: vi.fn(), apply: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/canonical-quantity-publication-member.reader", () => ({ readCanonicalQuantityPublicationMember: stubs.member }));
vi.mock("../../infrastructure/dropship-ebay-stock-readiness.read", () => ({ captureDropshipEbayStockReadiness: stubs.capture,
  readDropshipEbayStockMemberRows: stubs.memberRows, reviewDropshipEbayStockMembers: stubs.review }));
vi.mock("../../infrastructure/exact-ebay-sku-mapping.apply", () => ({ applyExactEbaySkuMappingsInsideTransaction: stubs.apply }));
vi.mock("../../infrastructure/stock-link-command", async importOriginal => {
  const actual = await importOriginal<typeof import("../../infrastructure/stock-link-command")>();
  return { ...actual, runStockLinkCommand: vi.fn(actual.runStockLinkCommand) };
});

import { logger as platformLogger } from "../../../../platform/observability/logger";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { QuantityPublicationAdmissionError } from "../../domain/quantity-publication-admission";
import { ensureDropshipEbayStockReady } from "../../infrastructure/dropship-ebay-stock-readiness.repository";
import { runStockLinkCommand } from "../../infrastructure/stock-link-command";

const ACTOR = "system:dropship-listing-push";
const NOW = new Date("2026-10-21T12:00:00.000Z");
// The first golden of dropship-ebay-stock-keys.golden.test.ts (literals, never recomputed here).
const INPUT = { vendorId: 10, storeConnectionId: 22, accountId: "dropship-seller", environment: "production", productId: 20,
  purpose: "publish", variants: [{ productVariantId: 101, sku: "P5" }], origin: { kind: "listing_push", jobId: 1, jobItemId: 1, listingId: 1 } };
const COMMAND_KEY = "1a1a8c2c-5459-5e1d-8908-fa2952c12e80";
const REQUEST_HASH = "139dbaa092f4c9d72839d8e65c439a2cb48eac19ab8c953403946515f24b7f76";
const PREPARATION_KEY = "dropship-ebay-stock:1a1a8c2c-5459-5e1d-8908-fa2952c12e80";

const TARGET = { id: 7, revision: "3" };
const capture = (overrides: Record<string, unknown> = {}) => ({ target: TARGET, liveTargetCount: 1, blockers: [], rows: [],
  variants: [{ productVariantId: 101, sku: "P5", mappingAction: "create", desiredQuantity: "17" }], currentlyReady: false, ...overrides });
const RECEIPT = { publicationTargetId: 7, revision: "4", reviewHash: "a".repeat(64), changedProductVariantIds: [101], publicationRows: 1,
  appliedAt: "2026-10-21T12:00:00.000Z", appliedBy: ACTOR, alreadyApplied: false };

interface Statement { readonly text: string; readonly values: readonly unknown[] }

/** A pool whose connections record every statement and answer only the statements the wrapper itself issues (the
 * store's BEGIN/SET/COMMIT/ROLLBACK, the fence, the command lock, the receipt, the audit row). Anything else (a pair,
 * scope or head lock, the 918428 lock) throws, so it fails the transaction and the test. */
function fakePool(options: { authority?: "legacy" | "canonical"; recorded?: Array<string | null> } = {}) {
  const transactions: Statement[][] = [];
  const recorded = [...(options.recorded ?? [])];
  const fake = {
    query: vi.fn(async (text: string) => {
      if (text.includes("availability_runtime_authority")) return { rows: [{ authority: options.authority ?? "canonical" }] };
      throw new Error(`Unexpected pool statement: ${text}`);
    }),
    connect: vi.fn(async () => {
      const statements: Statement[] = [];
      transactions.push(statements);
      return {
        release: vi.fn(),
        query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
          statements.push({ text, values });
          if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
          if (text.includes("inventory.acquire_cutover_admission_fence"))
            return { rows: [{ epoch: "5", authority: "canonical", authority_revision: "2", configuration_run_id: null }] };
          if (text === "SELECT pg_advisory_xact_lock(hashtextextended($1,0))") return { rows: [{ pg_advisory_xact_lock: "" }] };
          if (text.startsWith("SELECT request_hash FROM inventory.publication_mapping_preparations")) {
            const hash = recorded.shift() ?? null;
            return { rows: hash === null ? [] : [{ request_hash: hash }] };
          }
          if (text.startsWith("INSERT INTO public.audit_events")) return { rows: [] };
          throw new Error(`Unexpected statement: ${text}`);
        }),
      };
    }),
  };
  /** The configuration transaction (READ COMMITTED), labelled statement by statement. */
  const configuration = () => transactions.filter(tx => tx[0]?.text === "BEGIN ISOLATION LEVEL READ COMMITTED");
  // Only the pg methods the wrapper calls are faked.
  return { pool: fake as never as Parameters<typeof ensureDropshipEbayStockReady>[0], connect: fake.connect, transactions, configuration };
}

const label = (statement: Statement): string => {
  if (statement.text.includes("acquire_cutover_admission_fence")) return "fence";
  if (statement.text.startsWith("SELECT pg_advisory_xact_lock")) return "command lock";
  if (statement.text.startsWith("SELECT request_hash")) return "receipt";
  if (statement.text.startsWith("INSERT INTO public.audit_events")) return "audit";
  return statement.text;
};

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const unmapped = () => new QuantityPublicationAdmissionError("PUBLICATION_LISTING_TARGET_UNMAPPED", "The listing is not linked yet.");

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // The gate's predicate: not linked before the command (fast path miss), linked afterwards (final assert).
  stubs.member.mockReset().mockRejectedValueOnce(unmapped()).mockResolvedValue({ target_id: 7 });
  stubs.capture.mockReset().mockResolvedValue(capture());
  stubs.apply.mockReset().mockResolvedValue(RECEIPT);
});

describe("ensureDropshipEbayStockReady over the shared stock-link command (P5)", () => {
  it("links through runStockLinkCommand with today's keys, statements, audit row, result and log line", async () => {
    const { pool, configuration } = fakePool();
    const log = logger();
    const ticks = [100, 350];
    const result = await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, requestedBy: "vendor-user-7",
      monotonicNow: () => ticks.shift()!, logger: log });

    expect(result).toEqual({ status: "ready", commandKey: COMMAND_KEY, publicationTargetId: 7, linkedProductVariantIds: [101],
      alreadyLinked: false, mappingActions: [{ productVariantId: 101, mappingAction: "create" }], preparation: RECEIPT, fenceHoldMs: 250 });
    expect(runStockLinkCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runStockLinkCommand).mock.calls[0]![1].lockKey).toBe(PREPARATION_KEY);

    const [tx] = configuration();
    expect(configuration()).toHaveLength(1);
    expect(tx!.map(label)).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL lock_timeout='5s'",
      "SET LOCAL statement_timeout='60s'", "fence", "command lock", "receipt", "audit", "COMMIT"]);
    expect(tx![3]!.values).toEqual(["canonical", null]);
    expect(tx![4]!.values).toEqual([PREPARATION_KEY]);
    expect(tx![5]!.values).toEqual([PREPARATION_KEY]);
    // The audit row: same statement text, action, actor, target and payload as before the conversion.
    expect(tx![6]!.text).toBe(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES($1,'AUDIT',$2,'inventory_availability.dropship_ebay_stock.linked',$3,$4::jsonb,$5::jsonb)`);
    const [at, actor, target, changes, context] = tx![6]!.values as [Date, string, string, string, string];
    expect([at, actor, target]).toEqual([NOW, ACTOR, "inventory.inventory_publication_target:7"]);
    expect(JSON.parse(changes)).toEqual({ before: { publicationTargetId: 7, targetRevision: "3",
      variants: [{ productVariantId: 101, sku: "P5", mappingAction: "create" }] }, after: RECEIPT });
    expect(JSON.parse(context)).toEqual({ commandKey: COMMAND_KEY, requestHash: REQUEST_HASH, vendorId: 10, storeConnectionId: 22,
      productId: 20, origin: INPUT.origin, requestedBy: "vendor-user-7" });

    // The shared exact-identity core gets the Dropship prefix, key and hash (draft keys `<prefix>:<key>:<variant>`).
    expect(stubs.apply).toHaveBeenCalledTimes(1);
    expect(stubs.apply.mock.calls[0]![2]).toMatchObject({ target: TARGET, productId: 20, allowRetainedZero: false,
      exactVariantScope: true, idempotencyPrefix: "dropship-ebay-stock", commandKey: COMMAND_KEY, requestHash: REQUEST_HASH,
      actor: ACTOR, now: NOW, changeReason: "Reviewed exact eBay SKU stock link for a Dropship store listing." });
    // Pre-check (no lock) and the locked capture inside the fence.
    expect(stubs.capture.mock.calls.map(call => call[2])).toEqual([{ lock: false, quantityReview: true }, { lock: true, quantityReview: false }]);

    expect(log.info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "inventory_availability.dropship_ebay_stock.ensure",
      outcome: "linked", command_key: COMMAND_KEY, publication_target_id: 7, fence_hold_ms: 250, plans_in_fence: 3,
      job_id: 1, job_item_id: 1, listing_id: 1, vendor_id: 10, store_connection_id: 22, product_id: 20, product_variant_ids: [101] }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns once when the fence was held longer than 2 s", async () => {
    const { pool } = fakePool();
    const log = logger();
    const ticks = [0, 2_001];
    await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, monotonicNow: () => ticks.shift()!, logger: log });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: "fence_hold_slow", threshold_ms: 2_000,
      fence_hold_ms: 2_001 }));
  });

  it("takes no fence when the pre-check finds every member already exact; the final assert decides", async () => {
    stubs.capture.mockResolvedValue(capture({ currentlyReady: true,
      variants: [{ productVariantId: 101, sku: "P5", mappingAction: "none", desiredQuantity: null }] }));
    const { pool, configuration } = fakePool();
    const log = logger();
    expect(await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, monotonicNow: () => 1, logger: log })).toEqual({
      status: "ready", commandKey: COMMAND_KEY, publicationTargetId: 7, linkedProductVariantIds: [101], alreadyLinked: true,
      mappingActions: [{ productVariantId: 101, mappingAction: "none" }], preparation: null, fenceHoldMs: null });
    expect(configuration()).toEqual([]);
    expect(stubs.apply).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ outcome: "already_linked", fence_hold_ms: null }));
  });

  it("returns a draft-writer refusal as blocked against the pre-check's destination, rolled back", async () => {
    stubs.apply.mockRejectedValue(new InventoryAvailabilityMasterDataError(409,
      "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT", "Another size holds this store item."));
    const { pool, configuration } = fakePool();
    const log = logger();
    const ticks = [10, 40];
    expect(await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, monotonicNow: () => ticks.shift()!, logger: log }))
      .toEqual({ status: "blocked", commandKey: COMMAND_KEY, publicationTargetId: 7, targetCount: 1, blockers: [{
        code: "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT", message: "Another size holds this store item.",
        action: "review_mapping", productVariantId: null }] });
    expect(configuration()[0]!.map(label)).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL lock_timeout='5s'",
      "SET LOCAL statement_timeout='60s'", "fence", "command lock", "receipt", "ROLLBACK"]);
    expect(log.debug).toHaveBeenCalledWith(expect.objectContaining({ outcome: "blocked", fence_hold_ms: 30,
      inventory_codes: ["INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT"] }));
    // No final assert after a refusal: the gate predicate was read once (the fast path).
    expect(stubs.member).toHaveBeenCalledTimes(1);
  });

  it("returns the locked capture's business refusal as blocked", async () => {
    const held = { code: "STOCK_LISTING_HELD", message: "The store's stock is on hold.", action: "configure_inventory", productVariantId: null };
    stubs.capture.mockResolvedValueOnce(capture()).mockResolvedValueOnce(capture({ blockers: [held] }));
    const { pool, configuration } = fakePool();
    expect(await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, monotonicNow: () => 1, logger: logger() }))
      .toEqual({ status: "blocked", commandKey: COMMAND_KEY, publicationTargetId: 7, targetCount: 1, blockers: [held] });
    expect(configuration()[0]!.at(-1)!.text).toBe("ROLLBACK");
    expect(stubs.apply).not.toHaveBeenCalled();
  });

  it("throws every other failure for the gate to classify, rolled back", async () => {
    const busy = Object.assign(new Error("A provider request is in flight."), { code: "STOCK_MAPPING_PROVIDER_BUSY" });
    stubs.apply.mockRejectedValue(busy);
    const { pool, configuration } = fakePool();
    await expect(ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, monotonicNow: () => 1, logger: logger() }))
      .rejects.toBe(busy);
    expect(configuration()[0]!.at(-1)!.text).toBe("ROLLBACK");
  });

  it("refuses a command recorded under the lock with another request, writing nothing", async () => {
    const { pool, configuration } = fakePool({ recorded: [null, "f".repeat(64)] });
    expect(await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW, monotonicNow: () => 1, logger: logger() }))
      .toEqual({ status: "blocked", commandKey: COMMAND_KEY, publicationTargetId: null, targetCount: 0, blockers: [{
        code: "STOCK_MAPPING_COMMAND_CONFLICT", message: "This stock link command was already used for a different SKU, store account or listing.",
        action: "review_variant", productVariantId: null }] });
    expect(configuration()[0]!.map(label)).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL lock_timeout='5s'",
      "SET LOCAL statement_timeout='60s'", "fence", "command lock", "receipt", "COMMIT"]);
    // Only the pre-check captured; nothing was applied.
    expect(stubs.capture).toHaveBeenCalledTimes(1);
    expect(stubs.apply).not.toHaveBeenCalled();
  });

  it("is a no-op under legacy authority and logs through the platform logger by default", async () => {
    const debug = vi.spyOn(platformLogger, "debug").mockImplementation(() => {});
    const { pool, connect } = fakePool({ authority: "legacy" });
    expect(await ensureDropshipEbayStockReady(pool, INPUT, { actor: ACTOR, now: NOW })).toEqual({ status: "not_applicable", reason: "legacy_authority" });
    expect(connect).not.toHaveBeenCalled();
    expect(runStockLinkCommand).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledExactlyOnceWith("inventory_availability.dropship_ebay_stock.ensure", expect.objectContaining({
      action: "inventory_availability.dropship_ebay_stock.ensure", outcome: "not_applicable", reason: "legacy_authority", command_key: COMMAND_KEY }));
  });
});
