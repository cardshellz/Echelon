import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  LISTING_RULE_CONVERSION_ACTOR_TYPES,
  MAX_CONVERSION_REMOVED_RULES,
  listingRuleConversionRecordSchema,
  listingRuleConversionValuesSchema,
} from "../../../../../shared/dropship/listing-rules-conversion";
import { DropshipError } from "../../domain/errors";
import {
  LISTING_RULE_CONVERSION_KEY_CONSTRAINT,
  acknowledgeNoticeWithClient,
  findRuleConversionByKeyWithClient,
  findUnseenSystemConversionWithClient,
  hasRuleConversionWithClient,
  insertRuleConversionWithClient,
  type ListingRuleConversionInsert,
  type ListingRuleConversionNoticeAcknowledge,
} from "../../infrastructure/dropship-listing-rule-conversions.writer";

const NOW = new Date("2026-10-15T09:00:00.000Z");
const SEEN = new Date("2026-10-16T10:30:00.000Z");
const VENDOR = 10;
const STORE = 44;
const VENDOR_KEY = "ls-convert:0b8e7c1d-5f4a-4c3b-9a2e-1d0c9b8a7f6e";
const SYSTEM_KEY = `rules-conversion:${STORE}`;

// Whitespace-insensitive: a statement may be re-indented, never re-worded.
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const COLUMNS = "id, vendor_id, store_connection_id, idempotency_key, request_hash, plan_hash, writes_hash, clean, "
  + "changed_size_count, category_count, product_count, pricing_groups_removed, content_groups_removed, ebay_rules_removed, "
  + "actor_type, actor_id, created_at, notice_seen_at, notice_seen_by";
const SQL = {
  insert: "INSERT INTO dropship.dropship_listing_rule_conversions (vendor_id, store_connection_id, idempotency_key, request_hash, "
    + "plan_hash, writes_hash, clean, changed_size_count, category_count, product_count, pricing_groups_removed, "
    + "content_groups_removed, ebay_rules_removed, actor_type, actor_id, created_at) "
    + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) "
    + `RETURNING ${COLUMNS}`,
  findByKey: `SELECT ${COLUMNS} FROM dropship.dropship_listing_rule_conversions WHERE vendor_id = $1 AND idempotency_key = $2`,
  hasAny: "SELECT EXISTS (SELECT 1 FROM dropship.dropship_listing_rule_conversions WHERE store_connection_id = $1) AS found",
  unseenSystem: `SELECT ${COLUMNS} FROM (SELECT ${COLUMNS} FROM dropship.dropship_listing_rule_conversions `
    + "WHERE store_connection_id = $1 AND vendor_id = $2 ORDER BY id DESC LIMIT 1) latest "
    + "WHERE actor_type = 'system' AND notice_seen_at IS NULL",
  noticeSeen: "UPDATE dropship.dropship_listing_rule_conversions SET notice_seen_at = $4, notice_seen_by = $5 WHERE id = $1 "
    + "AND vendor_id = $2 AND store_connection_id = $3 AND actor_type = 'system' AND notice_seen_at IS NULL RETURNING id",
  systemExists: "SELECT EXISTS (SELECT 1 FROM dropship.dropship_listing_rule_conversions WHERE id = $1 AND vendor_id = $2 "
    + "AND store_connection_id = $3 AND actor_type = 'system') AS found",
  noticeAudit: "INSERT INTO dropship.dropship_audit_events (vendor_id, store_connection_id, entity_type, entity_id, event_type, "
    + "actor_type, actor_id, severity, payload, created_at) VALUES ($1, $2, 'dropship_listing_rule_conversion', $3, "
    + "'listing_rules_conversion_notice_seen', 'vendor', $4, 'info', $5::jsonb, $6)",
};

interface Call { sql: string; params: unknown[] }

/** Answers the record writer's statements; `answer` stands in for PostgreSQL. */
class ScriptedClient {
  calls: Call[] = [];
  constructor(private readonly answer: (sql: string, params: unknown[]) => unknown[] | Error = () => []) {}

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = normalize(text);
    this.calls.push({ sql, params });
    const answer = this.answer(sql, params);
    if (answer instanceof Error) throw answer;
    return { rows: answer as T[] };
  }
}

const asClient = (client: ScriptedClient) => client as unknown as Pick<PoolClient, "query">;

function vendorInsert(overrides: Partial<ListingRuleConversionInsert> = {}): ListingRuleConversionInsert {
  return {
    vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: VENDOR_KEY,
    requestHash: "a".repeat(64), planHash: "b".repeat(64), writesHash: "c".repeat(64),
    clean: false, changedSizeCount: 12, categoryCount: 2, productCount: 5,
    pricingGroupsRemoved: 3, contentGroupsRemoved: 1, ebayRulesRemoved: 0,
    actor: { actorType: "vendor", actorId: "member-1" }, now: NOW, ...overrides,
  };
}

function systemInsert(overrides: Partial<ListingRuleConversionInsert> = {}): ListingRuleConversionInsert {
  return vendorInsert({ idempotencyKey: SYSTEM_KEY, clean: true, changedSizeCount: 0,
    actor: { actorType: "system", actorId: "rules-conversion-job" }, ...overrides });
}

/** The row PostgreSQL returns for an insert: bigint id as a string, timestamps as Dates. */
function storedRow(input: ListingRuleConversionInsert, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9007199254740991", vendor_id: input.vendorId, store_connection_id: input.storeConnectionId, idempotency_key: input.idempotencyKey,
    request_hash: input.requestHash, plan_hash: input.planHash, writes_hash: input.writesHash, clean: input.clean,
    changed_size_count: input.changedSizeCount, category_count: input.categoryCount, product_count: input.productCount,
    pricing_groups_removed: input.pricingGroupsRemoved, content_groups_removed: input.contentGroupsRemoved,
    ebay_rules_removed: input.ebayRulesRemoved, actor_type: input.actor.actorType, actor_id: input.actor.actorId,
    created_at: input.now, notice_seen_at: null, notice_seen_by: null, ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("insertRuleConversionWithClient", () => {
  it("records a vendor's conversion in one insert that claims the key, and answers the stored row", async () => {
    const input = vendorInsert();
    const client = new ScriptedClient((sql) => sql === SQL.insert ? [storedRow(input)] : []);

    const record = await insertRuleConversionWithClient(asClient(client), input);

    expect(client.calls).toEqual([{ sql: SQL.insert, params: [VENDOR, STORE, VENDOR_KEY, "a".repeat(64), "b".repeat(64), "c".repeat(64),
      false, 12, 2, 5, 3, 1, 0, "vendor", "member-1", NOW] }]);
    expect(record).toEqual({
      id: 9_007_199_254_740_991, vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: VENDOR_KEY,
      requestHash: "a".repeat(64), planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: false, changedSizeCount: 12,
      categoryCount: 2, productCount: 5, pricingGroupsRemoved: 3, contentGroupsRemoved: 1, ebayRulesRemoved: 0,
      actorType: "vendor", actorId: "member-1", createdAt: NOW.toISOString(), noticeSeenAt: null, noticeSeenBy: null,
    });
  });

  it("records the system job's clean conversion under its one key per store", async () => {
    const input = systemInsert();
    const client = new ScriptedClient(() => [storedRow(input)]);

    const record = await insertRuleConversionWithClient(asClient(client), input);

    expect(client.calls[0].params.slice(2, 3)).toEqual([SYSTEM_KEY]);
    expect(client.calls[0].params.slice(6, 8)).toEqual([true, 0]);
    expect(client.calls[0].params.slice(13, 15)).toEqual(["system", "rules-conversion-job"]);
    expect(record).toMatchObject({ actorType: "system", clean: true, changedSizeCount: 0 });
  });

  it("answers a 23505 on the key as the permanent key conflict, and rethrows any other database error as it is", async () => {
    const keyTaken = Object.assign(new Error("duplicate key value violates unique constraint"),
      { code: "23505", constraint: LISTING_RULE_CONVERSION_KEY_CONSTRAINT });
    const conflict = await caught(insertRuleConversionWithClient(asClient(new ScriptedClient(() => keyTaken)), vendorInsert()));
    expect(conflict.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(conflict.context).toEqual({ constraint: LISTING_RULE_CONVERSION_KEY_CONSTRAINT, retryable: false, classification: "permanent" });

    // Another unique key, a CHECK and a lost connection are the caller's to map after its rollback.
    for (const other of [
      Object.assign(new Error("other unique"), { code: "23505", constraint: "some_other_uk" }),
      Object.assign(new Error("check"), { code: "23514", constraint: "dropship_listing_rule_conversion_system_clean_chk" }),
      Object.assign(new Error("gone"), { code: "57P01" }),
    ]) {
      await expect(insertRuleConversionWithClient(asClient(new ScriptedClient(() => other)), vendorInsert())).rejects.toBe(other);
    }
  });

  it.each<[string, Partial<ListingRuleConversionInsert>]>([
    ["a system conversion that is not clean (plan D1)", { actor: { actorType: "system", actorId: "job" }, idempotencyKey: SYSTEM_KEY }],
    ["a system conversion that changed a size", { actor: { actorType: "system", actorId: "job" }, clean: true, changedSizeCount: 1 }],
    ["a clean conversion that changed a size", { clean: true, changedSizeCount: 1 }],
    ["an admin actor", { actor: { actorType: "admin" as never, actorId: "admin-1" } }],
    ["a blank actor", { actor: { actorType: "vendor", actorId: "  " } }],
    ["an actor id over 255 characters", { actor: { actorType: "vendor", actorId: "m".repeat(256) } }],
    ["a short key", { idempotencyKey: "short" }],
    ["a key with a space", { idempotencyKey: "ls-convert: 1234" }],
    ["a plan hash that is not one", { planHash: "B".repeat(64) }],
    ["a writes hash that is short", { writesHash: "c".repeat(63) }],
    ["a negative count", { productCount: -1 }],
    ["more than 10,000 changed sizes", { changedSizeCount: 10_001 }],
    ["a fractional count", { categoryCount: 1.5 }],
    ["more than 100 rules removed", { ebayRulesRemoved: MAX_CONVERSION_REMOVED_RULES + 1 }],
    ["store id 0", { storeConnectionId: 0 }],
    ["a vendor id past int4", { vendorId: 2_147_483_648 }],
    ["no clock", { now: new Date(Number.NaN) }],
  ])("refuses %s before any SQL, as a fatal fault", async (_label, overrides) => {
    const client = new ScriptedClient();

    const error = await caught(insertRuleConversionWithClient(asClient(client), vendorInsert(overrides)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ retryable: false, classification: "fatal" });
    expect(client.calls).toEqual([]);
  });

  it("refuses a returned row that breaks the record's contract, naming its id, and an insert that returns no row", async () => {
    const input = vendorInsert();
    const broken = await caught(insertRuleConversionWithClient(asClient(new ScriptedClient(() => [storedRow(input, { clean: "yes" })])), input));
    expect(broken.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(broken.context).toMatchObject({ conversionId: "9007199254740991", issues: [{ path: "clean", code: "invalid_type" }] });

    const noRow = await caught(insertRuleConversionWithClient(asClient(new ScriptedClient(() => [])), input));
    expect(noRow.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(noRow.context).toMatchObject({ returnedCount: 0 });

    const pastSafe = await caught(insertRuleConversionWithClient(asClient(new ScriptedClient(() => [storedRow(input, { id: "9007199254740993" })])), input));
    expect(pastSafe.context).toMatchObject({ issues: [{ path: "id", code: "too_big" }] });
  });
});

describe("findRuleConversionByKeyWithClient", () => {
  it("reads the vendor's row under the key with no lock, and answers null when there is none", async () => {
    const input = systemInsert();
    const seen = storedRow(input, { notice_seen_at: SEEN, notice_seen_by: "member-1" });
    const client = new ScriptedClient((_sql, params) => params[1] === SYSTEM_KEY ? [seen] : []);

    await expect(findRuleConversionByKeyWithClient(asClient(client), { vendorId: VENDOR, idempotencyKey: SYSTEM_KEY }))
      .resolves.toMatchObject({ idempotencyKey: SYSTEM_KEY, actorType: "system", noticeSeenAt: SEEN.toISOString(), noticeSeenBy: "member-1" });
    await expect(findRuleConversionByKeyWithClient(asClient(client), { vendorId: VENDOR, idempotencyKey: VENDOR_KEY })).resolves.toBeNull();

    expect(client.calls).toEqual([
      { sql: SQL.findByKey, params: [VENDOR, SYSTEM_KEY] },
      { sql: SQL.findByKey, params: [VENDOR, VENDOR_KEY] },
    ]);
    expect(client.calls.some((call) => /\bFOR (UPDATE|SHARE)\b|pg_advisory/.test(call.sql))).toBe(false);
  });

  it("refuses a stored row the database should never hold: a vendor row with a notice, a notice with no reader", async () => {
    const vendor = vendorInsert();
    for (const [row, path] of [
      [storedRow(vendor, { notice_seen_at: SEEN, notice_seen_by: "member-1" }), "noticeSeenAt"],
      [storedRow(systemInsert(), { notice_seen_at: SEEN }), "noticeSeenBy"],
      [storedRow(systemInsert(), { clean: false }), "clean"],
    ] as const) {
      const error = await caught(findRuleConversionByKeyWithClient(asClient(new ScriptedClient(() => [row])),
        { vendorId: VENDOR, idempotencyKey: VENDOR_KEY }));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
      expect(error.context?.issues).toEqual(expect.arrayContaining([{ path, code: "custom" }]));
    }
  });

  it("refuses a key that names two rows, and a call outside its contract before any SQL", async () => {
    const row = storedRow(vendorInsert());
    const twice = await caught(findRuleConversionByKeyWithClient(asClient(new ScriptedClient(() => [row, row])),
      { vendorId: VENDOR, idempotencyKey: VENDOR_KEY }));
    expect(twice.context).toMatchObject({ foundCount: 2, classification: "fatal" });

    const client = new ScriptedClient();
    for (const input of [{ vendorId: 0, idempotencyKey: VENDOR_KEY }, { vendorId: VENDOR, idempotencyKey: "short" }]) {
      const error = await caught(findRuleConversionByKeyWithClient(asClient(client), input));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    }
    expect(client.calls).toEqual([]);
  });
});

describe("hasRuleConversionWithClient", () => {
  it("answers whether the store has any conversion, by either actor, in one statement", async () => {
    for (const found of [true, false]) {
      const client = new ScriptedClient(() => [{ found }]);
      await expect(hasRuleConversionWithClient(asClient(client), { storeConnectionId: STORE })).resolves.toBe(found);
      expect(client.calls).toEqual([{ sql: SQL.hasAny, params: [STORE] }]);
    }
  });

  it("refuses an answer that is not a boolean, and a store id that is not one, before any SQL", async () => {
    const strange = await caught(hasRuleConversionWithClient(asClient(new ScriptedClient(() => [])), { storeConnectionId: STORE }));
    expect(strange.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    const client = new ScriptedClient();
    await caught(hasRuleConversionWithClient(asClient(client), { storeConnectionId: -1 }));
    expect(client.calls).toEqual([]);
  });
});

describe("findUnseenSystemConversionWithClient (11e1, plan 9.3)", () => {
  it("reads the store's latest unseen system conversion in one indexed statement with no lock, and null when there is none", async () => {
    const row = storedRow(systemInsert(), { id: "12" });
    const client = new ScriptedClient((_sql, params) => params[0] === STORE ? [row] : []);

    await expect(findUnseenSystemConversionWithClient(asClient(client), { vendorId: VENDOR, storeConnectionId: STORE }))
      .resolves.toMatchObject({ id: 12, actorType: "system", noticeSeenAt: null, categoryCount: 2, productCount: 5 });
    await expect(findUnseenSystemConversionWithClient(asClient(client), { vendorId: VENDOR, storeConnectionId: 45 })).resolves.toBeNull();

    expect(client.calls).toEqual([
      { sql: SQL.unseenSystem, params: [STORE, VENDOR] },
      { sql: SQL.unseenSystem, params: [45, VENDOR] },
    ]);
    expect(client.calls.some((call) => /\bFOR (UPDATE|SHARE)\b|pg_advisory/.test(call.sql))).toBe(false);
  });

  it("never answers a row it did not ask for (a vendor's, one already seen, another store's or vendor's) as a notice", async () => {
    for (const row of [
      storedRow(vendorInsert()),
      storedRow(systemInsert(), { notice_seen_at: SEEN, notice_seen_by: "member-1" }),
      storedRow(systemInsert({ storeConnectionId: 45 })),
      storedRow(systemInsert({ vendorId: 11 })),
    ]) {
      const error = await caught(findUnseenSystemConversionWithClient(asClient(new ScriptedClient(() => [row])),
        { vendorId: VENDOR, storeConnectionId: STORE }));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
      expect(error.context).toMatchObject({ classification: "fatal" });
    }
  });

  it("refuses a stored row that breaks the record's contract, and ids outside theirs before any SQL", async () => {
    const broken = await caught(findUnseenSystemConversionWithClient(asClient(new ScriptedClient(() => [storedRow(systemInsert(),
      { clean: false })])), { vendorId: VENDOR, storeConnectionId: STORE }));
    expect(broken.context?.issues).toEqual(expect.arrayContaining([{ path: "clean", code: "custom" }]));
    const client = new ScriptedClient();
    for (const [input, field] of [
      [{ vendorId: 0, storeConnectionId: STORE }, "vendorId"],
      [{ vendorId: VENDOR, storeConnectionId: 2_147_483_648 }, "storeConnectionId"],
      [{ vendorId: VENDOR, storeConnectionId: 1.5 }, "storeConnectionId"],
    ] as const) {
      const error = await caught(findUnseenSystemConversionWithClient(asClient(client), input));
      expect(error.context).toMatchObject({ invalid: [field] });
    }
    expect(client.calls).toEqual([]);
  });
});

describe("acknowledgeNoticeWithClient (11e1, plan 9.3)", () => {
  const press = (overrides: Partial<ListingRuleConversionNoticeAcknowledge> = {}): ListingRuleConversionNoticeAcknowledge =>
    ({ vendorId: VENDOR, storeConnectionId: STORE, conversionId: 12, actorId: "member-1", now: SEEN, ...overrides });

  it("marks the notice seen with the guarded UPDATE and writes its audit row with before and after: acknowledged", async () => {
    const client = new ScriptedClient((sql) => sql === SQL.noticeSeen ? [{ id: "12" }] : []);
    await expect(acknowledgeNoticeWithClient(asClient(client), press())).resolves.toBe("acknowledged");
    expect(client.calls).toEqual([
      { sql: SQL.noticeSeen, params: [12, VENDOR, STORE, SEEN, "member-1"] },
      { sql: SQL.noticeAudit, params: [VENDOR, STORE, "12", "member-1", JSON.stringify({
        conversionId: 12,
        before: { noticeSeenAt: null, noticeSeenBy: null },
        after: { noticeSeenAt: SEEN.toISOString(), noticeSeenBy: "member-1" },
      }), SEEN] },
    ]);
    // The guard trigger allows exactly this: only the two notice columns, from null, on a system row of this store.
    expect(client.calls[0].sql).toMatch(/SET notice_seen_at = \$4, notice_seen_by = \$5 WHERE id = \$1 AND vendor_id = \$2 AND store_connection_id = \$3 AND actor_type = 'system' AND notice_seen_at IS NULL/);
  });

  it("answers already_seen, writing nothing, when the id names a system conversion of this store someone saw first", async () => {
    const client = new ScriptedClient((sql) => sql === SQL.systemExists ? [{ found: true }] : []);
    await expect(acknowledgeNoticeWithClient(asClient(client), press())).resolves.toBe("already_seen");
    expect(client.calls).toEqual([
      { sql: SQL.noticeSeen, params: [12, VENDOR, STORE, SEEN, "member-1"] },
      { sql: SQL.systemExists, params: [12, VENDOR, STORE] },
    ]);
  });

  it("answers not_found, writing nothing, when the id names no system conversion of this store (a vendor's, another store's, none)", async () => {
    const client = new ScriptedClient((sql) => sql === SQL.systemExists ? [{ found: false }] : []);
    await expect(acknowledgeNoticeWithClient(asClient(client), press({ conversionId: 13 }))).resolves.toBe("not_found");
    expect(client.calls.map((call) => call.sql)).toEqual([SQL.noticeSeen, SQL.systemExists]);
    expect(client.calls.some((call) => call.sql === SQL.noticeAudit)).toBe(false);
  });

  it("refuses an UPDATE that answers another row or two, and a lookup with no answer, as broken contracts", async () => {
    for (const rows of [[{ id: "13" }], [{ id: "12" }, { id: "12" }]]) {
      const client = new ScriptedClient((sql) => sql === SQL.noticeSeen ? rows : []);
      const error = await caught(acknowledgeNoticeWithClient(asClient(client), press()));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
      expect(client.calls.some((call) => call.sql === SQL.noticeAudit)).toBe(false);
    }
    const silent = await caught(acknowledgeNoticeWithClient(asClient(new ScriptedClient(() => [])), press()));
    expect(silent.context).toMatchObject({ conversionId: 12, classification: "fatal" });
  });

  it("passes a database failure through as it is, for the transaction's one mapping after rollback", async () => {
    const guard = Object.assign(new Error("A system conversion's notice is marked seen once, and nothing else changes"), { code: "23514" });
    const client = new ScriptedClient(() => guard);
    await expect(acknowledgeNoticeWithClient(asClient(client), press())).rejects.toBe(guard);
  });

  it("refuses a press outside its contract before any SQL", async () => {
    const client = new ScriptedClient();
    for (const [overrides, field] of [
      [{ vendorId: 0 }, "vendorId"], [{ storeConnectionId: -1 }, "storeConnectionId"], [{ conversionId: 0 }, "conversionId"],
      [{ conversionId: Number.MAX_SAFE_INTEGER + 1 }, "conversionId"], [{ actorId: "  " }, "actorId"], [{ actorId: "m".repeat(256) }, "actorId"],
      [{ now: new Date(Number.NaN) }, "now"],
    ] as const) {
      const error = await caught(acknowledgeNoticeWithClient(asClient(client), press(overrides as Partial<ListingRuleConversionNoticeAcknowledge>)));
      expect(error.context).toMatchObject({ invalid: [field], classification: "fatal" });
    }
    expect(client.calls).toEqual([]);
  });
});

describe("the record's contracts (shared/dropship/listing-rules-conversion.ts)", () => {
  it("are the vendor and the system, the rules the migration's CHECKs hold, and strict", () => {
    expect([...LISTING_RULE_CONVERSION_ACTOR_TYPES]).toEqual(["vendor", "system"]);
    const values = { vendorId: VENDOR, storeConnectionId: STORE, idempotencyKey: SYSTEM_KEY, requestHash: "a".repeat(64),
      planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: true, changedSizeCount: 0, categoryCount: 0, productCount: 0,
      pricingGroupsRemoved: 0, contentGroupsRemoved: 0, ebayRulesRemoved: 0, actorType: "system", actorId: "job" };
    expect(listingRuleConversionValuesSchema.safeParse(values).success).toBe(true);
    expect(listingRuleConversionValuesSchema.safeParse({ ...values, extra: 1 }).success).toBe(false);
    expect(listingRuleConversionValuesSchema.safeParse({ ...values, clean: false }).success).toBe(false);
    const record = { ...values, id: 1, createdAt: NOW.toISOString(), noticeSeenAt: SEEN.toISOString(), noticeSeenBy: "member-1" };
    expect(listingRuleConversionRecordSchema.safeParse(record).success).toBe(true);
    expect(listingRuleConversionRecordSchema.safeParse({ ...record, noticeSeenBy: " " }).success).toBe(false);
    expect(listingRuleConversionRecordSchema.safeParse({ ...record, actorType: "vendor" }).success).toBe(false);
  });
});
