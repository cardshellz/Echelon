import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ContentProfile, SaveContentProfileInput, SaveListingContentInput } from "../../../../../shared/dropship/listing-content";
import {
  PgDropshipListingContentRepository,
  findContentReplayWithClient,
  saveContentProfileWithClient,
  saveListingContentWithClient,
} from "../../infrastructure/dropship-listing-content.repository";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

const NOW = new Date("2026-10-10T12:00:00.000Z");
const EARLIER = new Date("2026-10-01T09:30:00.000Z");
const MEMBER = "member-1";
const STORE = 44;
const VENDOR = 10;
const VARIANT = 101;
const HASH = "a".repeat(64);
const CATALOG_HASH = "c".repeat(64);
// Written in contentProfileSchema key order, so the re-read profile serializes identically.
const PROFILE: ContentProfile = { defaultTemplate: { introduction: "Hello", footer: "Thanks" }, groups: [] };
const OLD_PROFILE: ContentProfile = { defaultTemplate: { introduction: "Old", footer: "" }, groups: [] };

// Whitespace-insensitive: a refactor may re-indent a statement but must not change its tokens.
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

const SQL = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  requestLock: "SELECT pg_advisory_xact_lock(hashtext('dropship_content_request'), hashtext($1))",
  storeLock: "SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)",
  owner: "SELECT v.id AS vendor_id FROM dropship.dropship_vendors v JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id "
    + "WHERE v.member_id::text = $1 AND sc.id = $2 FOR SHARE OF v, sc",
  selectionLocks: "LOCK TABLE dropship.dropship_catalog_rules, dropship.dropship_vendor_selection_rules, "
    + "dropship.dropship_vendor_variant_overrides, catalog.product_line_products IN SHARE MODE",
  sizeLock: "SELECT pv.id FROM catalog.product_variants pv JOIN catalog.products p ON p.id = pv.product_id WHERE pv.id = $1 FOR SHARE OF pv, p",
  readProfile: "SELECT r.id, r.profile, r.created_at FROM dropship.dropship_content_profiles p "
    + "JOIN dropship.dropship_content_profile_revisions r ON r.id = p.revision_id "
    + "AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id "
    + "WHERE p.vendor_id = $1 AND p.store_connection_id = $2",
  readListing: "SELECT r.id, r.product_variant_id, r.custom_text, r.catalog_hash, r.created_at "
    + "FROM dropship.dropship_listing_content_settings s JOIN dropship.dropship_listing_content_revisions r "
    + "ON r.id = s.revision_id AND r.vendor_id = s.vendor_id AND r.store_connection_id = s.store_connection_id "
    + "AND r.product_variant_id = s.product_variant_id "
    + "WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.product_variant_id = ANY($3::int[])",
  insertProfileRevision: "INSERT INTO dropship.dropship_content_profile_revisions "
    + "(vendor_id, store_connection_id, previous_revision_id, profile, idempotency_key, request_hash, actor_id, created_at) "
    + "VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id",
  upsertProfileHead: "INSERT INTO dropship.dropship_content_profiles (vendor_id, store_connection_id, revision_id) "
    + "VALUES ($1,$2,$3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id",
  insertListingRevision: "INSERT INTO dropship.dropship_listing_content_revisions "
    + "(vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash, "
    + "profile_revision_id, idempotency_key, request_hash, actor_id, created_at) "
    + "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
  upsertListingHead: "INSERT INTO dropship.dropship_listing_content_settings (vendor_id, store_connection_id, product_variant_id, revision_id) "
    + "VALUES ($1,$2,$3,$4) ON CONFLICT (store_connection_id, product_variant_id) DO UPDATE SET revision_id = EXCLUDED.revision_id",
  audit: "INSERT INTO dropship.dropship_audit_events "
    + "(vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at) "
    + "VALUES ($1,$2,$3,$4,'listing_content_saved','vendor',$5,'info',$6::jsonb,$7)",
  replay: (table: string) => `SELECT request_hash, store_connection_id FROM dropship.${table} WHERE vendor_id = $1 AND idempotency_key = $2`,
};

interface ProfileRow { id: number; profile: unknown; created_at: Date }
interface ListingRow { id: number; product_variant_id: number; custom_text: string | null; catalog_hash: string; created_at: Date }
type Call = [sql: string, params: unknown[]];

/**
 * Answers the content repository's statements from in-memory heads. A revision
 * insert is staged and becomes the head only at its head upsert, so a re-read
 * after the save proves the upsert ran.
 */
class ScriptedClient {
  calls: Call[] = [];
  release = vi.fn();
  ownerFound = true;
  profileHead: ProfileRow | null = null;
  listingHead: ListingRow | null = null;
  replays = new Map<string, { request_hash: string; store_connection_id: number }>();
  failOn: string | null = null;
  failRollback = false;
  private stagedProfile: ProfileRow | null = null;
  private stagedListing: ListingRow | null = null;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = normalize(text);
    this.calls.push([sql, params]);
    if (this.failOn && sql === this.failOn) throw new Error(`scripted failure: ${sql.slice(0, 40)}`);
    if (sql === SQL.rollback && this.failRollback) throw new Error("rollback failed");
    if (sql === SQL.owner) return rows<T>(this.ownerFound ? [{ vendor_id: VENDOR }] : []);
    if (sql === SQL.readProfile) return rows<T>(this.profileHead ? [this.profileHead] : []);
    if (sql === SQL.readListing) return rows<T>(this.listingHead ? [this.listingHead] : []);
    if (sql.startsWith("SELECT request_hash, store_connection_id FROM dropship.")) {
      const table = /FROM dropship\.(\w+)/.exec(sql)?.[1] ?? "";
      const replay = this.replays.get(table);
      return rows<T>(replay ? [replay] : []);
    }
    if (sql === SQL.insertProfileRevision) {
      this.stagedProfile = { id: 21, profile: JSON.parse(String(params[3])), created_at: NOW };
      return rows<T>([{ id: 21 }]);
    }
    if (sql === SQL.upsertProfileHead) { this.profileHead = this.stagedProfile; return rows<T>([]); }
    if (sql === SQL.insertListingRevision) {
      this.stagedListing = { id: 31, product_variant_id: Number(params[2]), custom_text: params[4] as string | null,
        catalog_hash: String(params[5]), created_at: NOW };
      return rows<T>([{ id: 31 }]);
    }
    if (sql === SQL.upsertListingHead) { this.listingHead = this.stagedListing; return rows<T>([]); }
    return rows<T>([]);
  }

  sql(): string[] {
    return this.calls.map(([sql]) => sql);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function profileSave(overrides: Partial<SaveContentProfileInput> = {}): SaveContentProfileInput {
  return { expectedRevisionId: 20, profile: PROFILE, idempotencyKey: "content:profile-1", ...overrides };
}

function listingSave(overrides: Partial<SaveListingContentInput> = {}): SaveListingContentInput {
  return { customText: "Own words", expectedRevisionId: 30, expectedCatalogHash: CATALOG_HASH,
    expectedProfileRevisionId: 20, idempotencyKey: "content:listing-1", ...overrides };
}

function writeTarget(idempotencyKey: string, productVariantId?: number) {
  return { memberId: MEMBER, storeConnectionId: STORE, idempotencyKey, ...(productVariantId ? { productVariantId } : {}) };
}

const lockedPrefix = (key: string): Call[] => [
  [SQL.begin, []],
  [SQL.requestLock, [`${MEMBER}:${key}`]],
  [SQL.storeLock, [STORE]],
  [SQL.owner, [MEMBER, STORE]],
];

describe("PgDropshipListingContentRepository (pinned statements)", () => {
  it("saves a template revision chained to the head, re-reads it and audits before and after", async () => {
    const client = new ScriptedClient();
    client.profileHead = { id: 20, profile: OLD_PROFILE, created_at: EARLIER };
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await repository.execute(writeTarget("content:profile-1"), (tx) => tx.saveProfile(profileSave(), HASH, NOW));

    expect(client.calls).toEqual([
      ...lockedPrefix("content:profile-1"),
      [SQL.readProfile, [VENDOR, STORE]],
      [SQL.insertProfileRevision, [VENDOR, STORE, 20, JSON.stringify(PROFILE), "content:profile-1", HASH, MEMBER, NOW]],
      [SQL.upsertProfileHead, [VENDOR, STORE, 21]],
      [SQL.readProfile, [VENDOR, STORE]],
      [SQL.audit, [VENDOR, STORE, "dropship_content_profile", String(STORE), MEMBER, JSON.stringify({
        before: { revisionId: 20, profile: OLD_PROFILE, updatedAt: EARLIER.toISOString() },
        after: { revisionId: 21, profile: PROFILE, updatedAt: NOW.toISOString() },
      }), NOW]],
      [SQL.commit, []],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("saves a store's first template with no previous revision and an empty before", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await repository.execute(writeTarget("content:profile-2"),
      (tx) => tx.saveProfile(profileSave({ expectedRevisionId: null, idempotencyKey: "content:profile-2" }), HASH, NOW));

    const insert = client.calls.find(([sql]) => sql === SQL.insertProfileRevision);
    expect(insert?.[1]).toEqual([VENDOR, STORE, null, JSON.stringify(PROFILE), "content:profile-2", HASH, MEMBER, NOW]);
    const audit = client.calls.find(([sql]) => sql === SQL.audit);
    expect(audit?.[1][5]).toBe(JSON.stringify({
      before: { revisionId: null, profile: null, updatedAt: null },
      after: { revisionId: 21, profile: PROFILE, updatedAt: NOW.toISOString() },
    }));
    expect(client.sql().at(-1)).toBe(SQL.commit);
  });

  it("locks the size, saves its revision chained to the head, re-reads it and audits before and after", async () => {
    const client = new ScriptedClient();
    client.listingHead = { id: 30, product_variant_id: VARIANT, custom_text: "Old words", catalog_hash: CATALOG_HASH, created_at: EARLIER };
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await repository.execute(writeTarget("content:listing-1", VARIANT), (tx) => tx.saveListing(VARIANT, listingSave(), HASH, NOW));

    expect(client.calls).toEqual([
      ...lockedPrefix("content:listing-1"),
      [SQL.selectionLocks, []],
      [SQL.sizeLock, [VARIANT]],
      [SQL.readListing, [VENDOR, STORE, [VARIANT]]],
      [SQL.insertListingRevision, [VENDOR, STORE, VARIANT, 30, "Own words", CATALOG_HASH, 20, "content:listing-1", HASH, MEMBER, NOW]],
      [SQL.upsertListingHead, [VENDOR, STORE, VARIANT, 31]],
      [SQL.readListing, [VENDOR, STORE, [VARIANT]]],
      [SQL.audit, [VENDOR, STORE, "dropship_listing_content_setting", String(VARIANT), MEMBER, JSON.stringify({
        before: { revisionId: 30, customText: "Old words", catalogHash: CATALOG_HASH, updatedAt: EARLIER.toISOString() },
        after: { revisionId: 31, customText: "Own words", catalogHash: CATALOG_HASH, updatedAt: NOW.toISOString() },
      }), NOW]],
      [SQL.commit, []],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("saves a size's first revision as a reset to catalog text with an empty before", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await repository.execute(writeTarget("content:listing-2", VARIANT), (tx) => tx.saveListing(VARIANT,
      listingSave({ customText: null, expectedRevisionId: null, expectedProfileRevisionId: null, idempotencyKey: "content:listing-2" }), HASH, NOW));

    const insert = client.calls.find(([sql]) => sql === SQL.insertListingRevision);
    expect(insert?.[1]).toEqual([VENDOR, STORE, VARIANT, null, null, CATALOG_HASH, null, "content:listing-2", HASH, MEMBER, NOW]);
    const audit = client.calls.find(([sql]) => sql === SQL.audit);
    expect(audit?.[1][5]).toBe(JSON.stringify({
      before: null,
      after: { revisionId: 31, customText: null, catalogHash: CATALOG_HASH, updatedAt: NOW.toISOString() },
    }));
    expect(client.sql().at(-1)).toBe(SQL.commit);
  });

  it("looks up a replay in the revision table of its kind and refuses the key for another request or store", async () => {
    const client = new ScriptedClient();
    client.replays.set("dropship_content_profile_revisions", { request_hash: HASH, store_connection_id: STORE });
    client.replays.set("dropship_listing_content_revisions", { request_hash: "b".repeat(64), store_connection_id: STORE });
    const repository = new PgDropshipListingContentRepository(poolFor(client));
    const read = { memberId: MEMBER, storeConnectionId: STORE };

    await expect(repository.execute(read, (tx) => tx.findReplay("profile", "content:key-1", HASH))).resolves.toBe(true);
    await expect(repository.execute(read, (tx) => tx.findReplay("listing", "content:key-1", "b".repeat(64)))).resolves.toBe(true);
    await expect(repository.execute(read, (tx) => tx.findReplay("profile", "content:key-1", "d".repeat(64))))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    client.replays.set("dropship_listing_content_revisions", { request_hash: "b".repeat(64), store_connection_id: 45 });
    await expect(repository.execute(read, (tx) => tx.findReplay("listing", "content:key-1", "b".repeat(64))))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    client.replays.clear();
    await expect(repository.execute(read, (tx) => tx.findReplay("listing", "content:key-2", HASH))).resolves.toBe(false);

    const lookups = client.calls.filter(([sql]) => sql.startsWith("SELECT request_hash"));
    expect(lookups).toEqual([
      [SQL.replay("dropship_content_profile_revisions"), [VENDOR, "content:key-1"]],
      [SQL.replay("dropship_listing_content_revisions"), [VENDOR, "content:key-1"]],
      [SQL.replay("dropship_content_profile_revisions"), [VENDOR, "content:key-1"]],
      [SQL.replay("dropship_listing_content_revisions"), [VENDOR, "content:key-1"]],
      [SQL.replay("dropship_listing_content_revisions"), [VENDOR, "content:key-2"]],
    ]);
    expect(client.sql().some((sql) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("takes the store lock but no request lock, selection lock or write for an unkeyed read", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    const state = await repository.execute({ memberId: MEMBER, storeConnectionId: STORE }, (tx) => tx.loadProfile());

    expect(state).toEqual({ revisionId: null, profile: null, updatedAt: null });
    expect(client.calls).toEqual([
      [SQL.begin, []],
      [SQL.storeLock, [STORE]],
      [SQL.owner, [MEMBER, STORE]],
      [SQL.readProfile, [VENDOR, STORE]],
      [SQL.commit, []],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses a write with another request's key, without a key, or for another size, before any SQL of its own", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await expect(repository.execute(writeTarget("content:profile-1"),
      (tx) => tx.saveProfile(profileSave({ idempotencyKey: "content:other" }), HASH, NOW))).rejects.toThrow("original request key");
    await expect(repository.execute({ memberId: MEMBER, storeConnectionId: STORE },
      (tx) => tx.saveProfile(profileSave(), HASH, NOW))).rejects.toThrow("original request key");
    await expect(repository.execute(writeTarget("content:listing-1", VARIANT),
      (tx) => tx.saveListing(VARIANT + 1, listingSave(), HASH, NOW))).rejects.toThrow("differs from its locked listing");

    expect(client.sql().some((sql) => sql === SQL.readProfile || sql === SQL.readListing || sql.startsWith("INSERT"))).toBe(false);
    expect(client.sql().filter((sql) => sql === SQL.rollback)).toHaveLength(3);
    expect(client.release).toHaveBeenCalledTimes(3);
  });

  it("reports a store that is not the member's as not found and rolls back", async () => {
    const client = new ScriptedClient();
    client.ownerFound = false;
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await expect(repository.execute(writeTarget("content:listing-1", VARIANT), (tx) => tx.loadProfile()))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(client.sql()).toEqual([SQL.begin, SQL.requestLock, SQL.storeLock, SQL.owner, SQL.rollback]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back the whole save when its audit insert fails and keeps the original failure over a failed rollback", async () => {
    const client = new ScriptedClient();
    client.failOn = SQL.audit;
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await expect(repository.execute(writeTarget("content:profile-2"),
      (tx) => tx.saveProfile(profileSave({ expectedRevisionId: null, idempotencyKey: "content:profile-2" }), HASH, NOW)))
      .rejects.toThrow("scripted failure");
    expect(client.sql().at(-1)).toBe(SQL.rollback);
    expect(client.sql()).not.toContain(SQL.commit);

    // The scripted client has no transactions, so forget the head the failed save staged.
    client.profileHead = null;
    client.failRollback = true;
    await expect(repository.execute(writeTarget("content:profile-3"),
      (tx) => tx.saveProfile(profileSave({ expectedRevisionId: null, idempotencyKey: "content:profile-3" }), HASH, NOW)))
      .rejects.toThrow("scripted failure");
    expect(client.release).toHaveBeenCalledTimes(2);
  });
});

// Added with the client-scoped extraction (plan 3.8, F6). Today's service checks the
// revision before calling the writer, so these refusals never fire on its path; they
// give a reused caller (PR 9's listing-settings transaction) the 409 instead of the
// 0660 trigger's raw 23514, which a scripted client never raises.
describe("client-scoped content writers", () => {
  const target = { vendorId: VENDOR, storeConnectionId: STORE, actorId: MEMBER };
  const onClient = (client: ScriptedClient) => client as unknown as PoolClient;

  it("refuses a stale template revision through the repository with no INSERT", async () => {
    const client = new ScriptedClient();
    client.profileHead = { id: 20, profile: OLD_PROFILE, created_at: EARLIER };
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    await expect(repository.execute(writeTarget("content:profile-1"),
      (tx) => tx.saveProfile(profileSave({ expectedRevisionId: 19 }), HASH, NOW)))
      .rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(client.sql().some((sql) => sql.startsWith("INSERT"))).toBe(false);
    expect(client.sql().at(-1)).toBe(SQL.rollback);
  });

  it("refuses a stale size revision, and a first save over an existing one, through the repository with no INSERT", async () => {
    const client = new ScriptedClient();
    client.listingHead = { id: 30, product_variant_id: VARIANT, custom_text: "Old words", catalog_hash: CATALOG_HASH, created_at: EARLIER };
    const repository = new PgDropshipListingContentRepository(poolFor(client));

    for (const expectedRevisionId of [29, null]) {
      await expect(repository.execute(writeTarget("content:listing-1", VARIANT),
        (tx) => tx.saveListing(VARIANT, listingSave({ expectedRevisionId }), HASH, NOW)))
        .rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    }
    expect(client.sql().some((sql) => sql.startsWith("INSERT"))).toBe(false);
    expect(client.sql().filter((sql) => sql === SQL.rollback)).toHaveLength(2);
  });

  it("refuses a size revision when none is stored yet but one was expected", async () => {
    const client = new ScriptedClient();

    await expect(saveListingContentWithClient(onClient(client), target, VARIANT, listingSave({ expectedRevisionId: 30 }), HASH, NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(client.calls).toEqual([[SQL.readListing, [VENDOR, STORE, [VARIANT]]]]);
  });

  it("writes a template on the caller's client with the same statements and no lock or transaction of its own", async () => {
    const client = new ScriptedClient();
    client.profileHead = { id: 20, profile: OLD_PROFILE, created_at: EARLIER };

    await saveContentProfileWithClient(onClient(client), target, profileSave(), HASH, NOW);

    expect(client.calls).toEqual([
      [SQL.readProfile, [VENDOR, STORE]],
      [SQL.insertProfileRevision, [VENDOR, STORE, 20, JSON.stringify(PROFILE), "content:profile-1", HASH, MEMBER, NOW]],
      [SQL.upsertProfileHead, [VENDOR, STORE, 21]],
      [SQL.readProfile, [VENDOR, STORE]],
      [SQL.audit, [VENDOR, STORE, "dropship_content_profile", String(STORE), MEMBER, JSON.stringify({
        before: { revisionId: 20, profile: OLD_PROFILE, updatedAt: EARLIER.toISOString() },
        after: { revisionId: 21, profile: PROFILE, updatedAt: NOW.toISOString() },
      }), NOW]],
    ]);
  });

  it("writes a size on the caller's client with the same statements and the actor it is given", async () => {
    const client = new ScriptedClient();

    await saveListingContentWithClient(onClient(client), { ...target, actorId: "member-2" }, VARIANT,
      listingSave({ expectedRevisionId: null, idempotencyKey: "ls:child-content-1" }), HASH, NOW);

    expect(client.calls).toEqual([
      [SQL.readListing, [VENDOR, STORE, [VARIANT]]],
      [SQL.insertListingRevision, [VENDOR, STORE, VARIANT, null, "Own words", CATALOG_HASH, 20, "ls:child-content-1", HASH, "member-2", NOW]],
      [SQL.upsertListingHead, [VENDOR, STORE, VARIANT, 31]],
      [SQL.readListing, [VENDOR, STORE, [VARIANT]]],
      [SQL.audit, [VENDOR, STORE, "dropship_listing_content_setting", String(VARIANT), "member-2", JSON.stringify({
        before: null,
        after: { revisionId: 31, customText: "Own words", catalogHash: CATALOG_HASH, updatedAt: NOW.toISOString() },
      }), NOW]],
    ]);
  });

  it("finds a replay on the caller's client in the table of its kind", async () => {
    const client = new ScriptedClient();
    client.replays.set("dropship_listing_content_revisions", { request_hash: HASH, store_connection_id: STORE });

    await expect(findContentReplayWithClient(onClient(client), target, "listing", "content:key-1", HASH)).resolves.toBe(true);
    await expect(findContentReplayWithClient(onClient(client), target, "profile", "content:key-1", HASH)).resolves.toBe(false);
    await expect(findContentReplayWithClient(onClient(client), { ...target, storeConnectionId: 45 }, "listing", "content:key-1", HASH))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(client.calls).toEqual([
      [SQL.replay("dropship_listing_content_revisions"), [VENDOR, "content:key-1"]],
      [SQL.replay("dropship_content_profile_revisions"), [VENDOR, "content:key-1"]],
      [SQL.replay("dropship_listing_content_revisions"), [VENDOR, "content:key-1"]],
    ]);
  });
});
