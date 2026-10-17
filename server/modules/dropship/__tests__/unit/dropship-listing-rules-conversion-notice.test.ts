import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropshipListingRulesConversionNoticeService,
  RULES_CONVERSION_NOTICE_SEEN_ACTION,
  type ListingRulesConversionNoticeAcknowledgeResult,
  type ListingRulesConversionNoticeRepository,
} from "../../application/dropship-listing-rules-conversion-notice-service";
import { DropshipError } from "../../domain/errors";

// The production pool is never reached: the repository is handed a scripted pool.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { PgDropshipListingRulesConversionNoticeRepository } from "../../infrastructure/dropship-listing-rules-conversion-notice.repository";

/*
 * [Got it] on the one-time notice of a system conversion (11e1, plan 9.3,
 * 9.4): the service (input, one clock reading, the 404, one INFO line after
 * commit) over a fake repository, and the repository's one transaction over
 * a scripted client (its statements in order, its rollback and its mapping).
 * The writer's own statements are pinned in the writer's test; PostgreSQL
 * runs them in the writes suite (WSU), the guard trigger included.
 */

const MEMBER = "member-1";
const STORE = 22;
const VENDOR = 7;
const NOW = new Date("2026-10-16T10:30:00.000Z");

class FakeNoticeRepository implements ListingRulesConversionNoticeRepository {
  presses: Array<{ memberId: string; storeConnectionId: number; conversionId: number; now: Date }> = [];
  next: ListingRulesConversionNoticeAcknowledgeResult | Error = { vendorId: VENDOR, outcome: "acknowledged" };
  async acknowledgeNotice(input: { memberId: string; storeConnectionId: number; conversionId: number; now: Date }) {
    this.presses.push(input);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

async function caught(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("DropshipListingRulesConversionNoticeService.acknowledgeForMember (11e1, plan 9.3)", () => {
  let repository: FakeNoticeRepository;
  let clockReads: number;
  let info: ReturnType<typeof vi.fn<(action: string, fields: Record<string, unknown>) => void>>;
  let service: DropshipListingRulesConversionNoticeService;
  let ticks: number[];

  beforeEach(() => {
    repository = new FakeNoticeRepository();
    clockReads = 0;
    ticks = [100, 112.4];
    info = vi.fn<(action: string, fields: Record<string, unknown>) => void>();
    service = new DropshipListingRulesConversionNoticeService({
      repository,
      clock: { now: () => { clockReads += 1; return NOW; } },
      timer: () => ticks.shift() ?? 0,
      log: { info },
    });
  });

  it("marks the notice seen with one clock reading, and logs one INFO line after commit with who, what, when, before and after", async () => {
    await expect(service.acknowledgeForMember(MEMBER, STORE, { conversionId: 41 })).resolves.toEqual({ outcome: "acknowledged" });
    expect(repository.presses).toEqual([{ memberId: MEMBER, storeConnectionId: STORE, conversionId: 41, now: NOW }]);
    expect(clockReads).toBe(1);
    expect(info.mock.calls).toEqual([[RULES_CONVERSION_NOTICE_SEEN_ACTION, {
      outcome: "acknowledged", vendor_id: VENDOR, store_connection_id: STORE, conversion_id: 41, actor_type: "vendor", actor_id: MEMBER,
      before: { notice_seen: false }, after: { notice_seen: true }, elapsed_ms: 12,
    }]]);
    expect(RULES_CONVERSION_NOTICE_SEEN_ACTION).toBe("dropship.listing_settings.rules_conversion_notice_seen");
  });

  it("answers a second press (or one on another device) already_seen: nothing was written, and the line says the notice was seen before", async () => {
    repository.next = { vendorId: VENDOR, outcome: "already_seen" };
    await expect(service.acknowledgeForMember(MEMBER, STORE, { conversionId: 41 })).resolves.toEqual({ outcome: "already_seen" });
    expect(info).toHaveBeenCalledWith(RULES_CONVERSION_NOTICE_SEEN_ACTION, expect.objectContaining({
      outcome: "already_seen", before: { notice_seen: true }, after: { notice_seen: true } }));
  });

  it("refuses an id that names no system conversion of this store with the permanent 404, logging nothing of its own", async () => {
    repository.next = { vendorId: VENDOR, outcome: "not_found" };
    const error = await caught(service.acknowledgeForMember(MEMBER, STORE, { conversionId: 99 }));
    expect(error.code).toBe("DROPSHIP_LISTING_CONVERSION_NOTICE_NOT_FOUND");
    expect(error.context).toEqual({ storeConnectionId: STORE, conversionId: 99, retryable: false, classification: "permanent" });
    // The route logs the refusal once, at DEBUG; the service's INFO line is for a commit only.
    expect(info).not.toHaveBeenCalled();
  });

  it("refuses a blank member, a bad store id and a body outside its contract before the clock or the repository", async () => {
    expect((await caught(service.acknowledgeForMember("  ", STORE, { conversionId: 41 }))).code).toBe("DROPSHIP_AUTH_REQUIRED");
    for (const [storeId, body] of [
      [0, { conversionId: 41 }], ["22", { conversionId: 41 }], [STORE, {}], [STORE, { conversionId: 0 }], [STORE, { conversionId: "41" }],
      [STORE, { conversionId: 41, idempotencyKey: "ls-notice:12345678" }], [STORE, null],
    ] as const) {
      const error = await caught(service.acknowledgeForMember(MEMBER, storeId, body));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
      expect(error.context).toMatchObject({ classification: "permanent" });
    }
    expect([repository.presses, clockReads, info.mock.calls.length]).toEqual([[], 0, 0]);
  });

  it("passes the repository's failure through as it is, with no INFO line", async () => {
    const busy = new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Try again.", { failure: "08006", retryable: true, classification: "transient" });
    repository.next = busy;
    await expect(service.acknowledgeForMember(MEMBER, STORE, { conversionId: 41 })).rejects.toBe(busy);
    expect(info).not.toHaveBeenCalled();
  });
});

describe("PgDropshipListingRulesConversionNoticeRepository.acknowledgeNotice (11e1, plan 9.3)", () => {
  const OWNER = /^SELECT v\.id AS vendor_id FROM dropship\.dropship_vendors v\s+JOIN dropship\.dropship_store_connections sc ON sc\.vendor_id = v\.id\s+WHERE v\.member_id::text = \$1 AND sc\.id = \$2 FOR SHARE OF v, sc$/;
  const UPDATE = /^UPDATE dropship\.dropship_listing_rule_conversions\s+SET notice_seen_at = \$4, notice_seen_by = \$5/;
  const EXISTS = /^SELECT EXISTS \(SELECT 1 FROM dropship\.dropship_listing_rule_conversions/;
  const AUDIT = /^INSERT INTO dropship\.dropship_audit_events/;

  interface Script {
    owner: boolean;
    updated: number;
    exists: boolean;
    failOn: RegExp | null;
    failure: unknown;
    rollbackFails: boolean;
    connectFails: unknown;
  }

  function scripted(patch: Partial<Script> = {}) {
    const script: Script = { owner: true, updated: 1, exists: true, failOn: null, failure: null, rollbackFails: false, connectFails: null, ...patch };
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    let released = 0;
    const client = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
        if (script.failOn?.test(sql)) throw script.failure;
        if (sql === "ROLLBACK" && script.rollbackFails) throw new Error("rollback failed");
        if (OWNER.test(sql)) return { rows: script.owner ? [{ vendor_id: VENDOR }] : [] };
        if (UPDATE.test(sql)) return { rows: Array.from({ length: script.updated }, () => ({ id: "41" })) };
        if (EXISTS.test(sql)) return { rows: [{ found: script.exists }] };
        return { rows: [] };
      },
      release: () => { released += 1; },
    } as unknown as PoolClient;
    const pool = {
      connect: async () => {
        if (script.connectFails) throw script.connectFails;
        return client;
      },
    } as unknown as Pick<Pool, "connect">;
    return { statements, sql: () => statements.map((statement) => statement.sql), released: () => released,
      repository: new PgDropshipListingRulesConversionNoticeRepository(pool) };
  }

  const press = { memberId: MEMBER, storeConnectionId: STORE, conversionId: 41, now: NOW };

  it("runs one READ COMMITTED transaction: the owner rows by member FOR SHARE, the guarded UPDATE, its audit row, COMMIT", async () => {
    const run = scripted();
    await expect(run.repository.acknowledgeNotice(press)).resolves.toEqual({ vendorId: VENDOR, outcome: "acknowledged" });
    const sql = run.sql();
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toMatch(OWNER);
    expect(run.statements[1].params).toEqual([MEMBER, STORE]);
    expect(sql[2]).toMatch(UPDATE);
    expect(run.statements[2].params).toEqual([41, VENDOR, STORE, NOW, MEMBER]);
    expect(sql[3]).toMatch(AUDIT);
    expect(sql[4]).toBe("COMMIT");
    expect(sql).toHaveLength(5);
    // No advisory lock (the UPDATE's row lock serializes two presses), no snapshot, no request key.
    expect(sql.some((statement) => /pg_advisory|READ ONLY|REPEATABLE READ|SERIALIZABLE/.test(statement))).toBe(false);
    expect(run.released()).toBe(1);
  });

  it("answers already_seen and not_found with nothing written, and commits the read-only transaction", async () => {
    const seen = scripted({ updated: 0, exists: true });
    await expect(seen.repository.acknowledgeNotice(press)).resolves.toEqual({ vendorId: VENDOR, outcome: "already_seen" });
    expect(seen.sql().map((statement) => statement.split(/\s/)[0])).toEqual(["BEGIN", "SELECT", "UPDATE", "SELECT", "COMMIT"]);
    expect(seen.sql().some((statement) => AUDIT.test(statement))).toBe(false);
    const missing = scripted({ updated: 0, exists: false });
    await expect(missing.repository.acknowledgeNotice(press)).resolves.toEqual({ vendorId: VENDOR, outcome: "not_found" });
    expect(missing.released()).toBe(1);
  });

  it("refuses a store the member's vendor does not own (404) before touching the conversion, and rolls back", async () => {
    const run = scripted({ owner: false });
    const error = await caught(run.repository.acknowledgeNotice(press));
    expect(error.code).toBe("DROPSHIP_STORE_CONNECTION_REQUIRED");
    expect(run.sql()).toEqual(["BEGIN", expect.stringMatching(OWNER), "ROLLBACK"]);
    expect(run.released()).toBe(1);
  });

  it("rolls back and maps a database failure once: the guard trigger is the fatal invariant, a deadlock the transient BUSY", async () => {
    const guard = Object.assign(new Error("A system conversion's notice is marked seen once, and nothing else changes"),
      { code: "23514", table: "dropship_listing_rule_conversions" });
    const refused = scripted({ failOn: UPDATE, failure: guard });
    const invariant = await caught(refused.repository.acknowledgeNotice(press));
    expect(invariant.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(invariant.context).toMatchObject({ sqlState: "23514", classification: "fatal" });
    expect(refused.sql().at(-1)).toBe("ROLLBACK");
    expect(refused.sql().some((statement) => AUDIT.test(statement))).toBe(false);

    const deadlock = scripted({ failOn: AUDIT, failure: Object.assign(new Error("deadlock detected"), { code: "40P01" }) });
    const busy = await caught(deadlock.repository.acknowledgeNotice(press));
    expect(busy.code).toBe("DROPSHIP_LISTING_SETTINGS_BUSY");
    expect(busy.context).toMatchObject({ classification: "transient" });
    expect(deadlock.sql().at(-1)).toBe("ROLLBACK");
    expect(deadlock.released()).toBe(1);
  });

  it("keeps the original failure when the ROLLBACK fails too, and maps a pool that can't connect as the retryable BUSY", async () => {
    // A backend the server ends (an administrator, a failover) answers with its SQLSTATE: the retryable BUSY.
    const ended = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    const run = scripted({ failOn: UPDATE, failure: ended, rollbackFails: true });
    const error = await caught(run.repository.acknowledgeNotice(press));
    expect(error).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY", context: { failure: "57P01" } });
    expect(run.released()).toBe(1);

    // node-postgres' own connection loss has no code (pg 8.20, lib/client.js): PR 9's mapper leaves it as it is, so the
    // press answers as an unexpected failure (500) and the line stays for another press; nothing was committed.
    const lost = new Error("Connection terminated unexpectedly");
    const dropped = scripted({ failOn: UPDATE, failure: lost, rollbackFails: true });
    await expect(dropped.repository.acknowledgeNotice(press)).rejects.toBe(lost);
    expect(dropped.sql().some((statement) => AUDIT.test(statement))).toBe(false);
    expect(dropped.released()).toBe(1);

    const noPool = scripted({ connectFails: new Error("timeout exceeded when trying to connect") });
    expect(await caught(noPool.repository.acknowledgeNotice(press))).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { failure: "pool_acquire_timeout", classification: "transient" } });
    expect(noPool.statements).toEqual([]);
  });

  it("refuses a press outside its contract before taking a connection", async () => {
    for (const [patch, field] of [
      [{ memberId: " " }, "memberId"], [{ memberId: "m".repeat(256) }, "memberId"], [{ storeConnectionId: 0 }, "storeConnectionId"],
      [{ storeConnectionId: 2_147_483_648 }, "storeConnectionId"], [{ conversionId: -1 }, "conversionId"], [{ now: new Date(Number.NaN) }, "now"],
    ] as const) {
      const run = scripted();
      const error = await caught(run.repository.acknowledgeNotice({ ...press, ...patch }));
      expect(error.context).toMatchObject({ invalid: [field], classification: "fatal" });
      expect(run.statements).toEqual([]);
    }
  });
});
