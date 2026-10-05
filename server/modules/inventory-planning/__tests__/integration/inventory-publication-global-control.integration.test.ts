import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { InventoryPublicationGlobalControlService } from "../../application/inventory-publication-global-control.service";
import { PostgresInventoryPublicationGlobalControlStore } from "../../infrastructure/inventory-publication-global-control.repository";

vi.mock("../../../../db", () => ({ db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-09-14T12:00:00.000Z");

const fixtureSql = `
CREATE SCHEMA inventory;
CREATE SCHEMA channels;
CREATE TABLE channels.sync_settings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  global_enabled boolean NOT NULL,
  sweep_interval_minutes integer NOT NULL DEFAULT 15,
  last_sweep_at timestamp,
  last_sweep_duration_ms integer,
  updated_at timestamp NOT NULL DEFAULT transaction_timestamp()
);
INSERT INTO channels.sync_settings(global_enabled, sweep_interval_minutes) VALUES(FALSE, 15);
CREATE TABLE public.audit_events (
  id bigserial PRIMARY KEY,
  timestamp timestamptz NOT NULL DEFAULT transaction_timestamp(),
  level text NOT NULL DEFAULT 'AUDIT',
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  changes jsonb,
  context jsonb
);
CREATE TABLE public.idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz
);
`;

dbDescribe.sequential("audited global publication control", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryPublicationGlobalControlService;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    await database.pool.query(readFileSync(resolve(
      process.cwd(),
      "migrations/0669_inventory_publication_global_control_singleton.sql",
    ), "utf8"));
    const original = (await database.pool.query("SELECT changed_by, change_reason FROM channels.sync_settings")).rows;
    await database.pool.query(readFileSync(resolve(process.cwd(),
      "migrations/0720_inventory_publication_pause_optional_reason.sql"), "utf8"));
    expect((await database.pool.query("SELECT changed_by, change_reason FROM channels.sync_settings")).rows).toEqual(original);
    const store = new PostgresInventoryPublicationGlobalControlStore(
      drizzle(database.pool) as never,
    );
    service = new InventoryPublicationGlobalControlService(store, { now: () => NOW });
  }, 30_000);

  beforeEach(async () => {
    await database.pool.query("TRUNCATE public.audit_events, public.idempotency_keys RESTART IDENTITY");
    await database.pool.query(`UPDATE channels.sync_settings
      SET global_enabled=FALSE, sweep_interval_minutes=15, revision=1,
          changed_by='migration:0669', change_reason='Reset disposable fixture'`);
  });

  afterAll(async () => {
    await database?.close();
  });

  function command(idempotencyKey: string, overrides: Record<string, unknown> = {}) {
    return {
      globalEnabled: true,
      sweepIntervalMinutes: 10,
      expectedRevision: "1",
      idempotencyKey,
      changeReason: "Enable only after reviewed pre-activation evidence",
      ...overrides,
    };
  }

  it("commits the CAS setting, receipt, and audit atomically and replays idempotently", async () => {
    const first = await service.change(command("global-control-atomic"), "operator-7");
    const replay = await service.change(command("global-control-atomic"), "operator-7");

    expect(first).toMatchObject({
      globalEnabled: true,
      sweepIntervalMinutes: 10,
      revision: "2",
      alreadyApplied: false,
    });
    expect(replay).toEqual({ ...first, alreadyApplied: true });
    expect((await database.pool.query(`SELECT global_enabled,sweep_interval_minutes,revision::text,
      changed_by,change_reason FROM channels.sync_settings`)).rows).toEqual([{
      global_enabled: true,
      sweep_interval_minutes: 10,
      revision: "2",
      changed_by: "operator-7",
      change_reason: "Enable only after reviewed pre-activation evidence",
    }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.idempotency_keys")).rows[0].count).toBe(1);
  });

  it("pauses without an operator reason and atomically audits and replays the normalized command", async () => {
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=TRUE");
    const request = { globalEnabled: false, expectedRevision: "1", idempotencyKey: "global-pause-no-reason" };
    const first = await service.change(request, "operator-7");
    expect(first).toMatchObject({ globalEnabled: false, revision: "2", changeReason: null, changedAt: NOW.toISOString() });
    expect(await service.change({ ...request, changeReason: " " }, "operator-7"))
      .toEqual({ ...first, alreadyApplied: true });
    expect((await database.pool.query("SELECT global_enabled,change_reason,changed_by,updated_at AT TIME ZONE 'UTC' AS updated_at FROM channels.sync_settings")).rows)
      .toEqual([{ global_enabled: false, change_reason: null, changed_by: "operator-7", updated_at: NOW }]);
    const audits = (await database.pool.query("SELECT timestamp,actor,action,changes,context FROM public.audit_events")).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ timestamp: NOW, actor: "operator-7",
      action: "inventory_availability.publication_global_control.changed",
      changes: { before: { globalEnabled: true }, after: { globalEnabled: false, revision: "2" } },
      context: { reason: null, idempotencyKey: request.idempotencyKey } });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.idempotency_keys")).rows[0].count).toBe(1);
    await expect(service.change({ ...request, expectedRevision: "2", changeReason: "Different request" }, "operator-7"))
      .rejects.toMatchObject({ code: "PUBLICATION_GLOBAL_CONTROL_IDEMPOTENCY_CONFLICT" });
  });

  it("keeps the database reason constraint for enabled controls and rejects blank notes", async () => {
    await expect(database.pool.query("UPDATE channels.sync_settings SET global_enabled=TRUE, change_reason=NULL"))
      .rejects.toMatchObject({ constraint: "sync_settings_change_reason_chk" });
    await expect(database.pool.query("UPDATE channels.sync_settings SET change_reason=''"))
      .rejects.toMatchObject({ constraint: "sync_settings_change_reason_chk" });
    await expect(database.pool.query("UPDATE channels.sync_settings SET change_reason=' padded '"))
      .rejects.toMatchObject({ constraint: "sync_settings_change_reason_chk" });
  });

  it("rejects stale revisions and idempotency-key reuse without changing control", async () => {
    await expect(service.change(command("global-control-stale", { expectedRevision: "2" }), "operator-7"))
      .rejects.toMatchObject({ code: "PUBLICATION_GLOBAL_CONTROL_STALE" });
    await service.change(command("global-control-conflict"), "operator-7");
    await expect(service.change(command("global-control-conflict", {
      globalEnabled: false,
      expectedRevision: "2",
    }), "operator-7")).rejects.toMatchObject({
      code: "PUBLICATION_GLOBAL_CONTROL_IDEMPOTENCY_CONFLICT",
    });
    expect((await database.pool.query("SELECT revision::text FROM channels.sync_settings")).rows[0].revision).toBe("2");
  });

  it("fails busy while a provider owner holds the global fence", async () => {
    const owner = await database.pool.connect();
    try {
      await owner.query("SELECT pg_advisory_lock(918419,0)");
      await expect(service.change(command("global-control-busy"), "operator-7"))
        .rejects.toMatchObject({ code: "PUBLICATION_GLOBAL_CONTROL_BUSY" });
    } finally {
      await owner.query("SELECT pg_advisory_unlock(918419,0)");
      owner.release();
    }
    expect((await database.pool.query("SELECT revision::text FROM channels.sync_settings")).rows[0].revision).toBe("1");
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.idempotency_keys")).rows[0].count).toBe(0);
  });

  it("rolls back setting and receipt when durable audit persistence fails", async () => {
    await database.pool.query(`CREATE FUNCTION public.reject_global_control_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER reject_global_control_audit BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.reject_global_control_audit()`);
    try {
      await expect(service.change(command("global-control-audit-failure"), "operator-7"))
        .rejects.toThrow("audit unavailable");
    } finally {
      await database.pool.query(`DROP TRIGGER reject_global_control_audit ON public.audit_events;
        DROP FUNCTION public.reject_global_control_audit()`);
    }
    expect((await database.pool.query("SELECT global_enabled,revision::text FROM channels.sync_settings")).rows[0])
      .toEqual({ global_enabled: false, revision: "1" });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.idempotency_keys")).rows[0].count).toBe(0);
  });
});
