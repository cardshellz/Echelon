import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDropshipEbayListingPolicyOverrideRepository } from "../../infrastructure/dropship-ebay-listing-policy-override.repository";
import type { ReplaceDropshipEbayListingPoliciesRepositoryInput } from "../../application/dropship-ebay-listing-policy-override-service";

vi.mock("../../../../db", () => ({ pool: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testDatabaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testDatabaseUrl && disposable ? describe : describe.skip;
const now = new Date("2026-09-04T12:00:00.000Z");

describeDatabase.sequential("bulk eBay listing policy PostgreSQL guarantees", () => {
  const schema = `dropship_policy_bulk_${process.pid}`;
  let pool: pg.Pool | undefined;
  let repository: PgDropshipEbayListingPolicyOverrideRepository;
  let createdSchema = false;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`).replaceAll("catalog.", `"${schema}".`);

  beforeAll(async () => {
    const protectedUrls = [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean);
    if (!testDatabaseUrl || !disposable || protectedUrls.includes(testDatabaseUrl)) {
      throw new Error("Bulk policy integration tests require a distinct disposable database.");
    }
    // The only created/dropped namespace is this validated, process-local test schema.
    if (!/^dropship_policy_bulk_\d+$/.test(schema)) throw new Error("Invalid test schema.");
    pool = new pg.Pool({
      connectionString: testDatabaseUrl,
      max: 4,
      ssl: /localhost|127\.0\.0\.1/.test(testDatabaseUrl) ? false : { rejectUnauthorized: false },
    });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY);
      CREATE TABLE dropship.dropship_store_connections (
        id integer PRIMARY KEY, vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
        platform text NOT NULL, status text NOT NULL
      );
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY);
      CREATE TABLE dropship.dropship_audit_events (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type text, entity_id text,
        event_type text, actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz
      );
      INSERT INTO dropship.dropship_vendors VALUES (10), (11);
      INSERT INTO dropship.dropship_store_connections VALUES
        (44, 10, 'ebay', 'connected'), (45, 11, 'ebay', 'connected');
      INSERT INTO catalog.product_variants VALUES (501), (502), (503), (504);
    `));
    await pool.query(qualify(readFileSync(resolve(process.cwd(), "migrations/217_dropship_ebay_listing_policy_overrides.sql"), "utf8")));
    // Run the real repository SQL and production migration in isolated namespaces.
    const scopedPool = {
      connect: async () => {
        const client = await pool!.connect();
        return {
          query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    repository = new PgDropshipEbayListingPolicyOverrideRepository(scopedPool);
  });

  beforeEach(async () => {
    await pool!.query(qualify(`
      TRUNCATE dropship.dropship_ebay_listing_policy_overrides,
        dropship.dropship_ebay_listing_policy_override_revisions,
        dropship.dropship_audit_events RESTART IDENTITY;
      UPDATE dropship.dropship_store_connections SET status = 'connected';
    `));
  });

  afterAll(async () => {
    if (pool && createdSchema) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  async function state() {
    const assignments = await repository.listAssignments({ vendorId: 10, storeConnectionId: 44 });
    const revisions = await pool!.query(qualify("SELECT * FROM dropship.dropship_ebay_listing_policy_override_revisions ORDER BY id"));
    const audits = await pool!.query(qualify("SELECT * FROM dropship.dropship_audit_events ORDER BY id"));
    return { assignments, revisions: revisions.rows, audits: audits.rows };
  }

  it("commits all assignments with immutable per-row revisions and before/after audit", async () => {
    const result = await repository.replaceAssignments(request("bulk-commit"));
    const saved = await state();
    expect(result.results).toHaveLength(2);
    expect(saved.assignments.map((row) => row.productVariantId)).toEqual([501, 502]);
    expect(saved.revisions).toHaveLength(2);
    expect(saved.audits).toHaveLength(2);
    expect(saved.audits[0].payload).toMatchObject({ before: null, after: { fulfillmentPolicyId: "shipping-501" } });
  });

  it("rolls back earlier rows and audit events when the last listing conflicts", async () => {
    const initial = await repository.replaceAssignments(request("bulk-initial"));
    const before = await state();
    const next = request("bulk-stale");
    next.assignments[0].expectedRevisionId = initial.results[0].revisionId;
    next.assignments[0].fulfillmentPolicyId = "new-shipping";
    // Row 502 is already assigned; expected null is deliberately stale.
    await expect(repository.replaceAssignments(next)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT",
      context: { productVariantId: 502 },
    });
    expect(await state()).toEqual(before);
  });

  it("rolls back an earlier row when a later variant does not exist", async () => {
    const input = request("bulk-unknown");
    input.assignments[1].productVariantId = 999;
    await expect(repository.replaceAssignments(input)).rejects.toMatchObject({ code: "DROPSHIP_CATALOG_VARIANT_NOT_FOUND" });
    expect(await state()).toEqual({ assignments: [], revisions: [], audits: [] });
  });

  it("serializes duplicate requests and returns one write plus one replay", async () => {
    const input = request("bulk-concurrent-replay");
    const results = await Promise.all([repository.replaceAssignments(input), repository.replaceAssignments(input)]);
    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    const saved = await state();
    expect(saved.revisions).toHaveLength(2);
    expect(saved.audits).toHaveLength(2);
  });

  it("allows only one concurrent writer with the same expected revisions", async () => {
    const results = await Promise.allSettled([
      repository.replaceAssignments(request("bulk-writer-one")),
      repository.replaceAssignments(request("bulk-writer-two")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT" });
    expect((await state()).revisions).toHaveLength(2);
  });

  it("does not overwrite a subsequent edit when an older operation is replayed", async () => {
    const original = request("bulk-original");
    const created = await repository.replaceAssignments(original);
    await repository.replaceAssignment({
      vendorId: 10, storeConnectionId: 44, productVariantId: 501,
      expectedRevisionId: created.results[0].revisionId, fulfillmentPolicyId: "later-choice",
      returnPolicyId: null, paymentPolicyId: null, actor: original.actor, now,
      idempotencyKey: "single-later-choice", requestHash: "later-request",
    });
    const before = await state();
    expect((await repository.replaceAssignments(original)).idempotentReplay).toBe(true);
    expect(await state()).toEqual(before);
    expect(before.assignments[0].fulfillmentPolicyId).toBe("later-choice");
  });

  it("rejects a changed target set under the original key, including disjoint targets", async () => {
    await repository.replaceAssignments(request("bulk-reused-key"));
    const before = await state();
    const changed = request("bulk-reused-key", [503, 504]);
    await expect(repository.replaceAssignments(changed)).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(await state()).toEqual(before);
  });

  it("clears assignments atomically while retaining clearing revisions and audit", async () => {
    const initial = await repository.replaceAssignments(request("bulk-before-clear"));
    const input = request("bulk-clear");
    input.assignments.forEach((row, index) => {
      row.expectedRevisionId = initial.results[index].revisionId;
      row.fulfillmentPolicyId = null;
    });
    const result = await repository.replaceAssignments(input);
    expect(result.results.every((row) => row.assignment === null)).toBe(true);
    const saved = await state();
    expect(saved.assignments).toEqual([]);
    expect(saved.revisions).toHaveLength(4);
    expect(saved.audits).toHaveLength(4);
  });

  it("denies another vendor's store and a disconnected store without writes", async () => {
    await expect(repository.replaceAssignments({ ...request("bulk-other-store"), storeConnectionId: 45 }))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    await pool!.query(qualify("UPDATE dropship.dropship_store_connections SET status = 'needs_reauth' WHERE id = 44"));
    await expect(repository.replaceAssignments(request("bulk-disconnected")))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED" });
    expect((await state()).revisions).toEqual([]);
  });
});

function request(key: string, ids = [501, 502]): ReplaceDropshipEbayListingPoliciesRepositoryInput {
  const assignments = ids.map((productVariantId) => ({
    productVariantId, expectedRevisionId: null,
    fulfillmentPolicyId: `shipping-${productVariantId}`, returnPolicyId: null, paymentPolicyId: null,
  }));
  return {
    vendorId: 10, storeConnectionId: 44, assignments, idempotencyKey: key,
    requestHash: createHash("sha256").update(JSON.stringify(assignments)).digest("hex"),
    actor: { actorType: "vendor", actorId: "member-1" }, now,
  };
}
