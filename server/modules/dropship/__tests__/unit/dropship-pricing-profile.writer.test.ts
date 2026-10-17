import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { PricingProfile } from "../../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../../domain/errors";
import {
  PRICING_PROFILE_HEAD_UPSERT_SQL,
  PRICING_PROFILE_REVISION_INSERT_SQL,
  savePricingProfileWithClient,
  type PricingProfileSaveInput,
  type PricingProfileWriteTarget,
} from "../../infrastructure/dropship-pricing-profile.writer";

const NOW = new Date("2026-10-15T09:00:00.000Z");
const EARLIER = new Date("2026-10-01T09:30:00.000Z");
const VENDOR = 10;
const STORE = 44;
const CONVERSION_ID = 77;
const DEFAULT_RECIPE = { basis: "product_cost", markupBps: 3_000, flatCents: 100, rounding: "cent" } as const;
const GROUPED: PricingProfile = {
  defaultRecipe: DEFAULT_RECIPE,
  groups: [{ id: "sleeves", name: "Sleeves", priority: 10, scope: { type: "category", category: "Sleeves" },
    recipe: { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } }],
};
const EMPTIED: PricingProfile = { defaultRecipe: DEFAULT_RECIPE, groups: [] };
const TARGET: PricingProfileWriteTarget = { vendorId: VENDOR, storeConnectionId: STORE, actorId: "member-1" };

// Whitespace-insensitive: a statement may be re-indented, never re-worded.
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const SQL = {
  head: "SELECT r.id, r.profile, r.created_at FROM dropship.dropship_pricing_profiles p "
    + "JOIN dropship.dropship_pricing_profile_revisions r ON r.id = p.revision_id "
    + "AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id "
    + "WHERE p.store_connection_id = $1 AND p.vendor_id = $2 FOR UPDATE OF p",
  revision: "INSERT INTO dropship.dropship_pricing_profile_revisions "
    + "(vendor_id, store_connection_id, previous_revision_id, profile, actor_id, created_at) "
    + "VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id",
  headUpsert: "INSERT INTO dropship.dropship_pricing_profiles (vendor_id, store_connection_id, revision_id) "
    + "VALUES ($1, $2, $3) ON CONFLICT (store_connection_id) DO UPDATE SET revision_id = EXCLUDED.revision_id",
  audit: "INSERT INTO dropship.dropship_audit_events "
    + "(vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at) "
    + "VALUES ($1, $2, 'dropship_pricing_profile', $3, 'pricing_profile_saved', $4, $5, 'info', $6::jsonb, $7)",
};

interface Call { sql: string; params: unknown[] }

class ScriptedClient {
  calls: Call[] = [];
  head: { id: unknown; profile: unknown; created_at: unknown } | null = { id: 20, profile: GROUPED, created_at: EARLIER };
  revisionRows: unknown[] = [{ id: 21 }];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = normalize(text);
    this.calls.push({ sql, params });
    if (sql === SQL.head) return { rows: (this.head ? [this.head] : []) as T[] };
    if (sql === SQL.revision) return { rows: this.revisionRows as T[] };
    return { rows: [] };
  }
}

const asClient = (client: ScriptedClient) => client as unknown as Pick<PoolClient, "query">;
const save = (overrides: Partial<PricingProfileSaveInput> = {}): PricingProfileSaveInput =>
  ({ expectedRevisionId: 20, profile: EMPTIED, conversionId: CONVERSION_ID, now: NOW, ...overrides });

async function caught(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("savePricingProfileWithClient (PR 11, plan 7.A.2 row 7, D11)", () => {
  it("locks the head, chains the revision to it, moves the head and audits before and after: four statements, no size row", async () => {
    const client = new ScriptedClient();

    const result = await savePricingProfileWithClient(asClient(client), TARGET, save());

    expect(result).toEqual({ revisionId: 21, previousRevisionId: 20 });
    expect(client.calls).toEqual([
      { sql: SQL.head, params: [STORE, VENDOR] },
      { sql: SQL.revision, params: [VENDOR, STORE, 20, JSON.stringify(EMPTIED), "member-1", NOW] },
      { sql: SQL.headUpsert, params: [VENDOR, STORE, 21] },
      // The entity is the new revision, as W1's pricing_rules_applied rows name it (one id space under dropship_pricing_profile).
      { sql: SQL.audit, params: [VENDOR, STORE, "21", "vendor", "member-1", JSON.stringify({
        conversionId: CONVERSION_ID, revisionId: 21, previousRevisionId: 20, before: GROUPED, after: EMPTIED,
      }), NOW] },
    ]);
    // W1's apply re-saves reviewed sizes as `rules`; this writer touches no listing price table at all (plan D6).
    expect(client.calls.some((call) => /dropship_listing_price_(revisions|settings)|dropship_pricing_applications/.test(call.sql))).toBe(false);
  });

  it("exports the revision insert and the head upsert it runs, the two statements W1's apply shares", () => {
    expect([normalize(PRICING_PROFILE_REVISION_INSERT_SQL), normalize(PRICING_PROFILE_HEAD_UPSERT_SQL)]).toEqual([SQL.revision, SQL.headUpsert]);
  });

  it("audits with the target's actor type: a vendor when none is given, the system for the job; the revision keeps the id only", async () => {
    for (const [actorType, expected] of [[undefined, "vendor"], ["vendor", "vendor"], ["system", "system"]] as const) {
      const client = new ScriptedClient();
      await savePricingProfileWithClient(asClient(client),
        { ...TARGET, actorId: "rules-conversion-job", ...(actorType ? { actorType } : {}) }, save());
      const audit = client.calls.find((call) => call.sql === SQL.audit);
      expect({ actorType, actor: audit?.params.slice(3, 5) }).toEqual({ actorType, actor: [expected, "rules-conversion-job"] });
      expect(client.calls.find((call) => call.sql === SQL.revision)?.params[4]).toBe("rules-conversion-job");
    }
  });

  it("starts a store's first profile with no predecessor when none is expected", async () => {
    const client = new ScriptedClient();
    client.head = null;

    const result = await savePricingProfileWithClient(asClient(client), TARGET, save({ expectedRevisionId: null, profile: GROUPED }));

    expect(result).toEqual({ revisionId: 21, previousRevisionId: null });
    expect(client.calls.find((call) => call.sql === SQL.revision)?.params[2]).toBeNull();
    expect(JSON.parse(String(client.calls.find((call) => call.sql === SQL.audit)?.params[5])))
      .toMatchObject({ previousRevisionId: null, before: null, after: GROUPED });
  });

  it.each<[string, number | null, number | null]>([
    ["a stale revision", 19, 20],
    ["a first save over an existing profile", null, 20],
    ["an expected profile that is gone", 20, null],
  ])("refuses %s with W1's 409 before any INSERT", async (_label, expectedRevisionId, actualRevisionId) => {
    const client = new ScriptedClient();
    if (actualRevisionId === null) client.head = null;

    const error = await caught(savePricingProfileWithClient(asClient(client), TARGET, save({ expectedRevisionId })));

    expect(error.code).toBe("DROPSHIP_PRICING_REVIEW_STALE");
    expect(error.context).toEqual({ storeConnectionId: STORE, expectedRevisionId, actualRevisionId, retryable: false,
      classification: "permanent" });
    expect(client.calls.map((call) => call.sql)).toEqual([SQL.head]);
  });

  it.each<[string, Partial<PricingProfileWriteTarget>, Partial<PricingProfileSaveInput>]>([
    ["a profile outside its contract", {}, { profile: { defaultRecipe: DEFAULT_RECIPE, groups: "none" } as unknown as PricingProfile }],
    ["a profile with an unknown key", {}, { profile: { ...EMPTIED, extra: true } as unknown as PricingProfile }],
    ["101 groups", {}, { profile: { defaultRecipe: DEFAULT_RECIPE, groups: Array.from({ length: 101 }, (_, index) =>
      ({ ...GROUPED.groups[0], id: `g${index}` })) } as PricingProfile }],
    ["no conversion id", {}, { conversionId: 0 }],
    ["a revision id that is not one", {}, { expectedRevisionId: 2_147_483_648 }],
    ["no clock", {}, { now: new Date(Number.NaN) }],
    ["store id 0", { storeConnectionId: 0 }, {}],
    ["a blank actor", { actorId: " " }, {}],
    ["an admin actor", { actorType: "admin" as never }, {}],
  ])("refuses %s before any SQL, as a fatal fault", async (_label, target, input) => {
    const client = new ScriptedClient();

    const error = await caught(savePricingProfileWithClient(asClient(client), { ...TARGET, ...target }, save(input)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ retryable: false, classification: "fatal" });
    expect(client.calls).toEqual([]);
  });

  it("refuses a stored profile that breaks its contract, and an insert that returns no identity, writing nothing more", async () => {
    const broken = new ScriptedClient();
    broken.head = { id: 20, profile: { groups: [] }, created_at: EARLIER };
    const stored = await caught(savePricingProfileWithClient(asClient(broken), TARGET, save()));
    expect(stored.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(broken.calls.map((call) => call.sql)).toEqual([SQL.head]);

    const noId = new ScriptedClient();
    noId.revisionRows = [];
    const inserted = await caught(savePricingProfileWithClient(asClient(noId), TARGET, save()));
    expect(inserted.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(noId.calls.map((call) => call.sql)).toEqual([SQL.head, SQL.revision]);
  });
});
