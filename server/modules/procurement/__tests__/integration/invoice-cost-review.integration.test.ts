import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { invoiceCostReviewResultSchema } from "@shared/procurement/invoice-cost-review";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

config({ path: resolve(process.cwd(), ".env.test") });
const url = process.env.ECHELON_TEST_DATABASE_URL;
const integration = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW = new Date("2026-09-07T12:00:00Z");
const TABLES = [schema.vendors, schema.vendorInvoices, schema.vendorInvoiceLines];

// The command, advisory lock, version check, audit and durable command repository
// execute against real PostgreSQL. Linked component/COGS application is covered
// separately by receiving-cost-application.integration.test.ts with real owners.
integration.sequential("invoice component review transaction and replay", () => {
  const actorId = `invoice-cost-review-${randomUUID()}`;
  let pool: pg.Pool;
  let modulePool: pg.Pool | undefined;
  let lease: pg.PoolClient | undefined;
  let ownsProcurement = false, ownsAudit = false, ownsCommands = false, ownsRecoveries = false;
  let commands: ReturnType<typeof import("../../invoice-cost-review.service").createInvoiceCostReviewCommands>;
  let versionOf: typeof import("../../ap-ledger.service").invoiceCostReviewVersion;

  beforeAll(async () => {
    if (!["127.0.0.1", "localhost"].includes(new URL(url!).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) {
      throw new Error("Invoice component tests require a separate explicitly disposable LOCAL database");
    }
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 10, statement_timeout: 15_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease");
    await pool.query("CREATE SCHEMA procurement"); ownsProcurement = true;
    for (const table of TABLES) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) {
      await pool.query(fixtureTable(schema.auditEvents)); ownsAudit = true;
    }
    ownsCommands = !(await pool.query("SELECT to_regclass('public.financial_command_results') AS relation")).rows[0].relation;
    ownsRecoveries = !(await pool.query("SELECT to_regclass('public.financial_command_recoveries') AS relation")).rows[0].relation;
    for (const migration of ["136_financial_command_results.sql", "140_financial_command_operations.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    const priorDatabase = process.env.DATABASE_URL, priorExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL; delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [dbModule, commandModule, repository, ap] = await Promise.all([
        import("../../../../db"), import("../../invoice-cost-review.service"),
        import("../../../../platform/commands/command-results.repository"), import("../../ap-ledger.service"),
      ]);
      modulePool = dbModule.pool;
      modulePool.query = pool.query.bind(pool) as typeof modulePool.query;
      modulePool.connect = pool.connect.bind(pool) as typeof modulePool.connect;
      commands = commandModule.createInvoiceCostReviewCommands(repository.createDrizzleFinancialCommandRepository(drizzle(pool, { schema })), () => NOW);
      versionOf = ap.invoiceCostReviewVersion;
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  });
  beforeEach(async () => {
    if (!ownsProcurement) throw new Error("Fixture ownership missing");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await pool.query("DELETE FROM public.financial_command_results WHERE actor_id=$1", [actorId]);
    await pool.query(`INSERT INTO procurement.vendors(id,code,name) VALUES(5,'REVIEW-VENDOR','Synthetic vendor');
      INSERT INTO procurement.vendor_invoices(id,vendor_id,invoice_number,status,currency,invoiced_amount_cents,balance_cents)
        VALUES(71,5,'REVIEW-INVOICE','received','USD',11800,11800);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
        VALUES(72,71,1,150,67,6667,11800)`);
  });
  afterAll(async () => {
    try {
      if (pool && ownsProcurement) {
        if (ownsAudit) await pool.query("DROP TABLE public.audit_events"); else await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
        if (ownsRecoveries) await pool.query("DROP TABLE public.financial_command_recoveries");
        if (ownsCommands) await pool.query("DROP TABLE public.financial_command_results"); else await pool.query("DELETE FROM public.financial_command_results WHERE actor_id=$1", [actorId]);
        await pool.query("DROP SCHEMA procurement CASCADE");
      }
    } finally {
      if (lease) { await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))"); lease.release(); }
      await pool?.end(); await modulePool?.end();
    }
  });

  async function version() {
    const line = (await pool.query("SELECT * FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0];
    return versionOf({ id: line.id, qtyInvoiced: line.qty_invoiced, unitCostCents: Number(line.unit_cost_cents),
      unitCostMills: line.unit_cost_mills === null ? null : Number(line.unit_cost_mills), lineTotalCents: Number(line.line_total_cents), costComponentEvidence: line.cost_component_evidence });
  }
  async function input(patch: Record<string, unknown> = {}) {
    return { expectedVersion: await version(), packagingTreatment: "separate", productMills: 1_000_000, packagingMills: 180_000,
      adjustmentMills: 0, reason: "Supplier breakdown reviewed", ...patch };
  }
  function descriptor(body: unknown, key = randomUUID()): FinancialCommandDescriptor {
    const scope = { method: "POST", routeTemplate: "/api/vendor-invoice-lines/:lineId/cost-components", resourceKey: "vendor_invoice_line:72" };
    return { ...scope, actorType: "user", actorId, idempotencyKey: key, requestHash: hashHttpFinancialCommand({ ...scope, body }), commandName: "ap.invoice.cost_components", contractVersion: 1 };
  }
  async function rows() {
    return { line: (await pool.query("SELECT * FROM procurement.vendor_invoice_lines WHERE id=72")).rows[0],
      invoice: (await pool.query("SELECT * FROM procurement.vendor_invoices WHERE id=71")).rows[0],
      audits: (await pool.query("SELECT * FROM public.audit_events WHERE actor=$1 ORDER BY id", [actorId])).rows };
  }

  it("records exact components and immutable audit without repricing the document", async () => {
    const before = await rows(), body = await input();
    const result = await commands.review(72, body, actorId, descriptor(body));
    expect(result.httpStatus).toBe(200);
    expect(invoiceCostReviewResultSchema.parse(result.body)).toMatchObject({ id: 72, application: null,
      costComponentEvidence: { productMills: 1_000_000, packagingMills: 180_000, adjustmentMills: 0 } });
    const after = await rows();
    expect(after.invoice).toEqual(before.invoice);
    expect(after.line).toEqual({ ...before.line, cost_component_evidence: (result.body as any).costComponentEvidence, updated_at: NOW });
    expect(after.audits).toEqual([expect.objectContaining({ actor: actorId, action: "procurement.invoice.cost_components",
      changes: { before: null, after: (result.body as any).costComponentEvidence }, context: expect.objectContaining({ reason: body.reason, unchangedLineTotalCents: "11800" }) })]);
  });
  it("rejects a stale reviewed version without changing evidence or audit", async () => {
    const body = await input();
    await pool.query("UPDATE procurement.vendor_invoice_lines SET line_total_cents=11801 WHERE id=72");
    const before = await rows();
    expect(await commands.review(72, body, actorId, descriptor(body))).toMatchObject({ httpStatus: 409, body: { details: { code: "INVOICE_COST_REVIEW_STALE" } } });
    expect(await rows()).toEqual(before);
  });
  it("rejects an exact one-mill mismatch without rounding it into the document", async () => {
    const before = await rows(), body = await input({ adjustmentMills: -1 });
    expect(await commands.review(72, body, actorId, descriptor(body))).toMatchObject({ httpStatus: 422, body: { details: { code: "INVOICE_COST_COMPONENT_TOTAL_MISMATCH" } } });
    expect(await rows()).toEqual(before);
  });
  it("replays the original response after a lost acknowledgement without a second audit", async () => {
    const body = await input(), identity = descriptor(body);
    const first = await commands.review(72, body, actorId, identity);
    const beforeReplay = await rows();
    const replay = await commands.review(72, body, actorId, identity);
    expect(replay).toMatchObject({ replayed: true, body: first.body, httpStatus: 200 });
    expect(await rows()).toEqual(beforeReplay);
    await expect(commands.review(72, { ...body, reason: "Changed request" }, actorId, descriptor({ ...body, reason: "Changed request" }, identity.idempotencyKey))).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
  });
  it("rolls back evidence and timestamps when the audit write fails, then retries exactly", async () => {
    const before = await rows(), body = await input(), identity = descriptor(body);
    await pool.query(`CREATE FUNCTION procurement.review_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'review fixture audit failure'; END $$;
      CREATE TRIGGER review_audit_fail BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.review_audit_fail()`);
    try { await expect(commands.review(72, body, actorId, identity)).rejects.toThrow(); }
    finally { await pool.query("DROP TRIGGER review_audit_fail ON public.audit_events; DROP FUNCTION procurement.review_audit_fail()"); }
    expect(await rows()).toEqual(before);
    expect((await pool.query("SELECT status,last_error_code FROM public.financial_command_results WHERE idempotency_key=$1", [identity.idempotencyKey])).rows).toEqual([{ status: "retryable", last_error_code: "INVOICE_COST_REVIEW_RETRY" }]);
    await pool.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM next_attempt_at-clock_timestamp())) + 0.01) FROM public.financial_command_results WHERE idempotency_key=$1", [identity.idempotencyKey]);
    expect(await commands.review(72, body, actorId, identity)).toMatchObject({ httpStatus: 200 });
    expect((await rows()).audits).toHaveLength(1);
  });
  it("serializes competing reviewers so only one current-version review can commit", async () => {
    const body = await input(), alternative = { ...body, productMills: 1_100_000, packagingMills: 80_000, reason: "Alternative evidence" };
    const results = await Promise.all([commands.review(72, body, actorId, descriptor(body)), commands.review(72, alternative, actorId, descriptor(alternative))]);
    expect(results.map((result) => result.httpStatus).sort()).toEqual([200, 409]);
    expect((await rows()).audits).toHaveLength(1);
  });
  it.each(["voided", "EUR"])("retains read-only evidence for %s invoices", async (state) => {
    await pool.query("UPDATE procurement.vendor_invoices SET status=$1,currency=$2 WHERE id=71", [state === "voided" ? "voided" : "received", state === "EUR" ? "EUR" : "USD"]);
    const before = await rows(), body = await input();
    expect(await commands.review(72, body, actorId, descriptor(body))).toMatchObject({ httpStatus: 409 });
    expect(await rows()).toEqual(before);
  });
  it("preserves signed credit evidence instead of clamping it", async () => {
    await pool.query("UPDATE procurement.vendor_invoice_lines SET line_total_cents=-5500 WHERE id=72");
    const body = await input({ productMills: 0, packagingMills: 0, adjustmentMills: -550_000 });
    expect(await commands.review(72, body, actorId, descriptor(body))).toMatchObject({ httpStatus: 200, body: { costComponentEvidence: { adjustmentMills: -550_000 } } });
    expect((await rows()).line.line_total_cents).toBe("-5500");
  });
  it("refuses to fingerprint an unsafe historical BIGINT by rounding it", async () => {
    await pool.query("UPDATE procurement.vendor_invoice_lines SET line_total_cents=9007199254740993 WHERE id=72");
    const before = await rows(), body = await input();
    await expect(commands.review(72, body, actorId, descriptor(body))).rejects.toThrow();
    expect(await rows()).toEqual(before);
    expect((await rows()).line.line_total_cents).toBe("9007199254740993");
  });
});
