import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditEvents } from "@shared/schema";
import { fixtureTable } from "./shipment-line-fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const run = databaseUrl && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const protectedActions = ["procurement.receiving.source_resolved", "procurement.receiving.default_location_applied"];

run.sequential("Receiving integrity audit migration", () => {
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  let ownsTable = false;

  beforeAll(async () => {
    if (!databaseUrl || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(databaseUrl)) {
      throw new Error("An explicitly disposable separate database is required");
    }
    const url = new URL(databaseUrl);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Audit migration fixture requires local PostgreSQL");
    pool = new pg.Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 10_000 });
    client = await pool.connect();
    // CREATE fails if the table already exists; this fixture never replaces
    // pre-existing data or disables the migration's protection for cleanup.
    await client.query(fixtureTable(auditEvents));
    ownsTable = true;
    await client.query(readFileSync(resolve(process.cwd(), "migrations/0749_receiving_integrity_audit_guard.sql"), "utf8"));
  });

  beforeEach(async () => { await client!.query("BEGIN"); });
  afterEach(async () => { await client?.query("ROLLBACK"); });
  afterAll(async () => {
    if (client && ownsTable) {
      await client.query("DROP TABLE public.audit_events");
      await client.query("DROP FUNCTION public.guard_receiving_integrity_audit_history()");
    }
    client?.release();
    await pool?.end();
  });

  async function insert(action: string) {
    const result = await client!.query(`INSERT INTO public.audit_events(actor,action,target,changes)
      VALUES('audit-fixture',$1,'receiving-line:51','{"before":{},"after":{"purchaseOrderLineId":21}}') RETURNING id`, [action]);
    return result.rows[0].id;
  }

  async function rejectsMutation(statement: string, parameters: unknown[] = []) {
    await client!.query("SAVEPOINT mutation");
    await expect(client!.query(statement, parameters)).rejects.toMatchObject({ code: "23514" });
    await client!.query("ROLLBACK TO SAVEPOINT mutation");
  }

  it.each(protectedActions)("preserves %s against update, delete and truncate", async (action) => {
    const id = await insert(action);
    const before = (await client!.query("SELECT * FROM public.audit_events WHERE id=$1", [id])).rows;
    await rejectsMutation("UPDATE public.audit_events SET changes='{}',action='legacy' WHERE id=$1", [id]);
    await rejectsMutation("DELETE FROM public.audit_events WHERE id=$1", [id]);
    await rejectsMutation("TRUNCATE public.audit_events");
    expect((await client!.query("SELECT * FROM public.audit_events WHERE id=$1", [id])).rows).toEqual(before);
  });

  it.each(protectedActions)("rejects rewriting legacy evidence as %s", async (action) => {
    const id = await insert("unrelated.legacy");
    await rejectsMutation("UPDATE public.audit_events SET action=$1 WHERE id=$2", [action, id]);
    expect((await client!.query("SELECT action FROM public.audit_events WHERE id=$1", [id])).rows)
      .toEqual([{ action: "unrelated.legacy" }]);
  });

  it("leaves unrelated row maintenance available with protected evidence present", async () => {
    await insert(protectedActions[0]);
    const legacyId = await insert("unrelated.legacy");
    await client!.query("UPDATE public.audit_events SET changes='{}' WHERE id=$1", [legacyId]);
    await client!.query("DELETE FROM public.audit_events WHERE id=$1", [legacyId]);
    expect((await client!.query("SELECT action FROM public.audit_events")).rows).toEqual([{ action: protectedActions[0] }]);
  });

  it("allows transaction rollback of a newly inserted decision", async () => {
    await client!.query("SAVEPOINT business_command");
    await insert(protectedActions[0]);
    await client!.query("ROLLBACK TO SAVEPOINT business_command");
    expect((await client!.query("SELECT count(*)::int AS count FROM public.audit_events")).rows).toEqual([{ count: 0 }]);
  });

  it("allows truncate only before protected history exists", async () => {
    await insert("unrelated.legacy");
    await client!.query("TRUNCATE public.audit_events");
    expect((await client!.query("SELECT count(*)::int AS count FROM public.audit_events")).rows).toEqual([{ count: 0 }]);
  });
});
