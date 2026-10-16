import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  DropshipRulesConversionJobService,
  RULES_CONVERSION_DEFERRED_ACTION,
  type RulesConversionFailureAudit,
} from "../../application/dropship-rules-conversion-job-service";
import { DropshipError } from "../../domain/errors";

/**
 * The rules conversion job's reads and its failure record (PR 11e2, plan
 * 9.2, 13.2, 13.3, D20), DI: the conversion repository's check load by
 * store and its failure record, and the job's store list. Statements are
 * scripted; the SQL's meaning is pinned on PostgreSQL (the writes suite).
 */

const mocks = vi.hoisted(() => ({ loadConversionInputsWithClient: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-listing-settings.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-listing-settings.repository")>()),
  loadConversionInputsWithClient: mocks.loadConversionInputsWithClient,
}));

import { PgDropshipListingRulesConversionRepository } from "../../infrastructure/dropship-listing-rules-conversion.repository";
import { PgDropshipRulesConversionJobSource } from "../../infrastructure/dropship-rules-conversion-job.source";

const NOW = new Date("2026-10-16T09:15:00.000Z");
const JOB_KEY = "rules-conversion-job:2026-10-16T09";
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();
const PAYLOAD: RulesConversionFailureAudit = Object.freeze({ plannerVersion: 1, revisions: Object.freeze({ pricing: 31, content: null, ebayRules: 51 }),
  stage: "apply", errorCode: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", errorClass: "fatal", causeCode: "DROPSHIP_PRICING_REVIEW_STALE",
  jobKey: JOB_KEY }) as RulesConversionFailureAudit;

/** One pooled connection whose answers are chosen per statement fragment. */
class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  release = vi.fn();
  owner: Array<{ vendor_id: unknown }> = [{ vendor_id: 10 }];
  heads: Array<Record<string, unknown>> = [{ vendor_id: 10, pricing_revision_id: 31, content_revision_id: null, ebay_rules_revision_id: 51 }];
  inserted: Array<{ id: number }> = [{ id: 501 }];
  failOn: { fragment: string; error: unknown } | null = null;
  /** true: the ROLLBACK fails with words of its own; an Error: it fails with that one. */
  failRollback: boolean | Error = false;

  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = flat(text);
    this.sql.push(sql);
    this.params.push(params);
    if (this.failOn && sql.includes(this.failOn.fragment)) throw this.failOn.error;
    if (sql === "ROLLBACK" && this.failRollback) {
      throw this.failRollback instanceof Error ? this.failRollback : new Error("connection lost during rollback");
    }
    if (sql.startsWith("SELECT sc.vendor_id FROM dropship.dropship_store_connections sc WHERE sc.id = $1")) return { rows: this.owner };
    if (sql.startsWith("SELECT sc.vendor_id, (SELECT p.revision_id")) return { rows: this.heads };
    if (sql.startsWith("INSERT INTO dropship.dropship_audit_events")) return { rows: this.inserted };
    return { rows: [] };
  }
}

let client: ScriptedClient;
let connect: ReturnType<typeof vi.fn>;
let pool: Pick<Pool, "connect">;
type CostReadReport = (input: { vendorId: number; storeConnectionId: number; variantCount: number; stage: string; sqlState: string | null }) => void;
let report: Mock<CostReadReport>;

beforeEach(() => {
  vi.clearAllMocks();
  client = new ScriptedClient();
  connect = vi.fn(async () => client);
  pool = { connect } as unknown as Pick<Pool, "connect">;
  report = vi.fn<CostReadReport>();
  mocks.loadConversionInputsWithClient.mockImplementation(async (reader: ScriptedClient) => {
    await reader.query("-- loadConversionInputsWithClient");
    return { state: "ok", inputs: { sentinel: true }, costReadFailure: null };
  });
});

const repository = () => new PgDropshipListingRulesConversionRepository(pool, report);
const noLocks = (sql: readonly string[]) => sql.filter((statement) => /FOR (SHARE|UPDATE)|pg_advisory|LOCK TABLE/i.test(statement));

describe("PgDropshipListingRulesConversionRepository.loadConversionInputsForStore (the job's check, plan 13.3 step 3)", () => {
  it("loads in one read-only snapshot with the owner found by the store, no lock, and its own cost-read reporter", async () => {
    const load = await repository().loadConversionInputsForStore({ storeConnectionId: 22, now: NOW });

    expect(load).toEqual({ vendorId: 10, load: { state: "ok", inputs: { sentinel: true }, costReadFailure: null } });
    expect(client.sql).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT sc.vendor_id FROM dropship.dropship_store_connections sc WHERE sc.id = $1",
      "-- loadConversionInputsWithClient",
      "COMMIT",
    ]);
    expect(client.params[1]).toEqual([22]);
    // The dry run's own composition, on this snapshot's client, with the vendor the store row names.
    expect(mocks.loadConversionInputsWithClient).toHaveBeenCalledExactlyOnceWith(client, { vendorId: 10, storeConnectionId: 22, now: NOW }, report);
    expect(noLocks(client.sql)).toEqual([]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("answers null for a store that is gone, loading nothing", async () => {
    client.owner = [];
    await expect(repository().loadConversionInputsForStore({ storeConnectionId: 22, now: NOW })).resolves.toBeNull();
    expect(mocks.loadConversionInputsWithClient).not.toHaveBeenCalled();
    expect(client.sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and rethrows the load's own failure, mapped once (a deadlock is the transient BUSY)", async () => {
    mocks.loadConversionInputsWithClient.mockRejectedValue(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
    await expect(repository().loadConversionInputsForStore({ storeConnectionId: 22, now: NOW })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { classification: "transient" } });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("passes a raw contract failure as it is (fatal for the job), and destroys a connection whose rollback failed", async () => {
    const raw = new Error("Persisted pricing profile failed its contract.");
    mocks.loadConversionInputsWithClient.mockRejectedValue(raw);
    client.failRollback = true;
    await expect(repository().loadConversionInputsForStore({ storeConnectionId: 22, now: NOW })).rejects.toBe(raw);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "connection lost during rollback" }));
  });

  it("maps a pool with no free connection in time to the transient BUSY, before any statement", async () => {
    connect.mockRejectedValue(new Error("timeout exceeded when trying to connect"));
    await expect(repository().loadConversionInputsForStore({ storeConnectionId: 22, now: NOW })).rejects.toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { failure: "pool_acquire_timeout" } });
    expect(client.sql).toEqual([]);
  });

  it.each([
    ["a store id that is not a positive int4", { storeConnectionId: 0, now: NOW }],
    ["an invalid time", { storeConnectionId: 22, now: new Date(Number.NaN) }],
  ])("refuses %s as a fatal broken contract, before a connection", async (_label, input) => {
    await expect(repository().loadConversionInputsForStore(input)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("PgDropshipListingRulesConversionRepository.recordFailure (D20)", () => {
  const input = (overrides: Partial<{ storeConnectionId: number; expectedVendorId: number; payload: RulesConversionFailureAudit; now: Date }> = {}) =>
    ({ storeConnectionId: 22, expectedVendorId: 10, payload: PAYLOAD, now: NOW, ...overrides });

  it("writes one audit row in one short transaction, naming the heads the failure was planned from", async () => {
    await expect(repository().recordFailure(input())).resolves.toBe("recorded");

    expect(client.sql.map((sql) => sql.split(" ").slice(0, 4).join(" "))).toEqual(["BEGIN", "SELECT sc.vendor_id, (SELECT p.revision_id",
      "INSERT INTO dropship.dropship_audit_events (vendor_id,", "COMMIT"]);
    expect(client.params[1]).toEqual([22]);
    const insert = client.sql[2];
    expect(insert).toContain("'dropship_store_connection', $3::text, $4::text, 'system', $5::text, 'error', $6::jsonb, $7::timestamptz");
    // Written only when no row of the store names the same planner version and revisions (a replay writes nothing).
    expect(insert).toContain("WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_audit_events a");
    expect(insert).toContain("a.payload->'plannerVersion' = $6::jsonb->'plannerVersion' AND a.payload->'revisions' = $6::jsonb->'revisions'");
    expect(client.params[2]).toEqual([10, 22, "22", "listing_rules_conversion_failed", JOB_KEY, JSON.stringify(PAYLOAD), NOW]);
    expect(JSON.parse(client.params[2][5] as string)).toEqual(PAYLOAD);
    expect(noLocks(client.sql)).toEqual([]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("answers already_recorded when an identical row exists (the insert wrote nothing)", async () => {
    client.inserted = [];
    await expect(repository().recordFailure(input())).resolves.toBe("already_recorded");
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it.each([
    ["the pricing head moved (a pricing save since the list)", { pricing_revision_id: 32 }],
    ["a description profile was saved for the first time", { content_revision_id: 7 }],
    ["the eBay rules head moved", { ebay_rules_revision_id: 52 }],
    ["the store names another vendor", { vendor_id: 11 }],
  ])("writes nothing when %s: rules_changed, so the store is checked again with its new rules", async (_label, change) => {
    client.heads = [{ ...client.heads[0], ...change }];
    await expect(repository().recordFailure(input())).resolves.toBe("rules_changed");
    expect(client.sql.some((sql) => sql.startsWith("INSERT"))).toBe(false);
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("writes nothing for a store that is gone", async () => {
    client.heads = [];
    await expect(repository().recordFailure(input())).resolves.toBe("store_gone");
    expect(client.sql.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("refuses heads that break their contract as fatal, rolling back", async () => {
    client.heads = [{ ...client.heads[0], pricing_revision_id: "31" }];
    await expect(repository().recordFailure(input())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it.each([
    ["a payload outside its schema (a transient class)", { payload: { ...PAYLOAD, errorClass: "transient" } as unknown as RulesConversionFailureAudit }],
    ["a payload with an extra field", { payload: { ...PAYLOAD, message: "words" } as unknown as RulesConversionFailureAudit }],
    ["a vendor id that is not an int4", { expectedVendorId: -1 }],
    ["an invalid time", { now: new Date(Number.NaN) }],
  ])("refuses %s before any statement but BEGIN, rolling back", async (_label, overrides) => {
    await expect(repository().recordFailure(input(overrides))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: expect.objectContaining({ classification: "fatal" }) });
    expect(client.sql).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["a guard or CHECK (23514) at the insert: the fatal invariant", { code: "23514", constraint: "some_check" }, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED"],
    ["a connection exception the server names (class 08, 08006): the transient BUSY", { code: "08006" }, "DROPSHIP_LISTING_SETTINGS_BUSY"],
  ])("maps %s once, rolling back", async (_label, fields, code) => {
    client.failOn = { fragment: "INSERT INTO dropship.dropship_audit_events", error: Object.assign(new Error("database error"), fields) };
    await expect(repository().recordFailure(input())).rejects.toMatchObject({ code });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("maps a pool with no free connection in time to the transient BUSY", async () => {
    connect.mockRejectedValue(new Error("timeout exceeded when trying to connect"));
    await expect(repository().recordFailure(input())).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { classification: "transient" } });
  });
});

describe("node-postgres' code-less connection losses on the job's three calls (plan 13.7)", () => {
  // pg 8.20 (lib/client.js) raises these with no `code`: the pending query when the socket ends with no server error,
  // and any statement after it (a ROLLBACK included).
  const terminated = () => new Error("Connection terminated unexpectedly");
  const notQueryable = () => new Error("Client has encountered a connection error and is not queryable");
  const STORE_OWNER = "SELECT sc.vendor_id FROM dropship.dropship_store_connections sc WHERE sc.id = $1";
  const STORE_LOCK = "SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)";
  type Repository = ReturnType<typeof repository>;

  it.each([
    ["the check's owner read", STORE_OWNER, true,
      (repo: Repository) => repo.loadConversionInputsForStore({ storeConnectionId: 22, now: NOW })],
    ["the apply's store lock", STORE_LOCK, false,
      (repo: Repository) => repo.executeConversion({ actorType: "system", jobKey: JOB_KEY, storeConnectionId: 22 },
        async () => { throw new Error("The transaction body ran."); })],
    ["the failure record's insert", "INSERT INTO dropship.dropship_audit_events", true,
      (repo: Repository) => repo.recordFailure({ storeConnectionId: 22, expectedVendorId: 10, payload: PAYLOAD, now: NOW })],
  ] as const)("hands %s's raw error to the job unchanged (the listing-settings mapper leaves it as it is)", async (_label, fragment, destroys, call) => {
    const raw = terminated();
    client.failOn = { fragment, error: raw };
    client.failRollback = notQueryable();

    await expect(call(repository())).rejects.toBe(raw);

    expect(client.sql.at(-1)).toBe("ROLLBACK");
    // The check and the record destroy a connection whose rollback failed; 11c's transaction releases it (pg-pool drops a
    // client that is not queryable).
    expect(client.release).toHaveBeenCalledExactlyOnceWith(...(destroys ? [expect.objectContaining({ message: notQueryable().message })] : []));
  });

  it("is deferred by the job with the real repository, never recorded: one connection, no failure row, WARN and no ERROR", async () => {
    client.failOn = { fragment: STORE_OWNER, error: terminated() };
    client.failRollback = notQueryable();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const job = new DropshipRulesConversionJobService({
      source: { listStores: async () => ({ eligible: [{ vendorId: 10, storeConnectionId: 22, revisions: PAYLOAD.revisions }],
        notEligibleStoreIds: [], deadLetteredStoreIds: [] }) },
      repository: repository(), clock: { now: () => NOW }, timer: () => 0, log, failureContext: () => ({}),
    });

    await expect(job.runOnce()).resolves.toMatchObject({ storesChecked: 1, deferred: 1, failed: 0, converted: 0 });

    // Only the check's connection: the record's transaction was never opened.
    expect(connect).toHaveBeenCalledOnce();
    expect(client.sql.some((sql) => sql.startsWith("INSERT"))).toBe(false);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(RULES_CONVERSION_DEFERRED_ACTION, expect.objectContaining({ store_connection_id: 22,
      stage: "check", outcome: "deferred", error_class: "transient", failure: "connection_terminated" }));
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("PgDropshipRulesConversionJobSource.listStores (plan 13.2)", () => {
  const row = (storeConnectionId: number, overrides: Record<string, unknown> = {}) => ({ vendor_id: storeConnectionId >= 30 ? 11 : 10,
    store_connection_id: storeConnectionId, eligible: true, pricing_revision_id: 31, content_revision_id: null, ebay_rules_revision_id: 51,
    dead_lettered: false, ...overrides });
  let query: ReturnType<typeof vi.fn>;
  const source = () => new PgDropshipRulesConversionJobSource({ query } as unknown as Pick<Pool, "query">);
  beforeEach(() => { query = vi.fn(async () => ({ rows: [] })); });

  it("asks with the write gate's two allow-lists and its entitlement, the failure event and the planner version, in one pool statement with no lock", async () => {
    await source().listStores({ plannerVersion: 1 });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([["connected", "needs_reauth", "refresh_failed"], ["active", "onboarding"], "listing_rules_conversion_failed", 1,
      "active"]);
    expect(noLocks([flat(sql)])).toEqual([]);
    // Eligible only with the vendor's .ops entitlement active, as the vendor's own write gate requires.
    expect(flat(sql)).toContain("(sc.status = ANY($1::text[]) AND v.status = ANY($2::text[]) AND v.entitlement_status = $5::text) AS eligible");
    // eBay only; no store with any conversion row (vendor or system); the failure exclusion on the three heads and the version.
    expect(flat(sql)).toContain("WHERE sc.platform = 'ebay'");
    expect(flat(sql)).toContain("NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_rule_conversions c WHERE c.store_connection_id = sc.id)");
    expect(flat(sql)).toContain("a.payload->'plannerVersion' = to_jsonb($4::int)");
    expect(flat(sql)).toContain("a.payload->'revisions' = jsonb_build_object('pricing', c.pricing_revision_id, "
      + "'content', c.content_revision_id, 'ebayRules', c.ebay_rules_revision_id)");
    expect(flat(sql)).toContain("ORDER BY c.vendor_id, c.store_connection_id");
  });

  it("splits the rows three ways, each store once, in the statement's order; not eligible before dead-lettered", async () => {
    query.mockResolvedValue({ rows: [row(22), row(23, { eligible: false }), row(24, { dead_lettered: true }),
      row(25, { eligible: false, dead_lettered: true }), row(30, { pricing_revision_id: null, content_revision_id: 4 })] });

    await expect(source().listStores({ plannerVersion: 1 })).resolves.toEqual({
      eligible: [{ vendorId: 10, storeConnectionId: 22, revisions: { pricing: 31, content: null, ebayRules: 51 } },
        { vendorId: 11, storeConnectionId: 30, revisions: { pricing: null, content: 4, ebayRules: 51 } }],
      notEligibleStoreIds: [23, 25],
      deadLetteredStoreIds: [24],
    });
  });

  it.each([
    ["a store listed twice", [row(22), row(22)]],
    ["a store id that is not an int4", [row(22, { store_connection_id: "22" })]],
    ["a vendor id that is not an int4", [row(22, { vendor_id: 0 })]],
    ["an eligibility that is not a boolean", [row(22, { eligible: "t" })]],
    ["a dead-letter flag that is not a boolean", [row(22, { dead_lettered: null })]],
    ["a head revision that is not an id", [row(22, { pricing_revision_id: -3 })]],
  ])("refuses %s as a fatal broken contract (the tick fails)", async (_label, rows) => {
    query.mockResolvedValue({ rows });
    await expect(source().listStores({ plannerVersion: 1 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
  });

  it("maps the database's failures: a pool timeout is the transient BUSY", async () => {
    query.mockRejectedValue(new Error("timeout exceeded when trying to connect"));
    await expect(source().listStores({ plannerVersion: 1 })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { classification: "transient" } });
  });

  it("refuses a planner version that is not a positive whole number, before any statement", async () => {
    await expect(source().listStores({ plannerVersion: 0 })).rejects.toBeInstanceOf(DropshipError);
    expect(query).not.toHaveBeenCalled();
  });
});
