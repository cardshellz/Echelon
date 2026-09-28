import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { customerReturnLabelSettingsSchema } from "@shared/returns/customer-return-label.contract";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema,
  seedIntakeTestSchema,
  seedPreCarrierSelectionIntake,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";

const connectionString = resolveReturnsTestDatabase(process.env, "policy");
const integration = connectionString ? describe.sequential : describe.skip;
const migration = readFileSync(
  "migrations/255_return_policy_shipping.sql",
  "utf8",
);

integration("policy-owned shipping migration on PostgreSQL", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({
      connectionString: connectionString!,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
  });
  beforeEach(async () => {
    await createIntakeTestSchema(pool, { policyShipping: false });
    await seedIntakeTestSchema(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });

  async function clonePolicy(
    overrides: Partial<typeof schema.returnPolicies.$inferInsert>,
  ) {
    const database = drizzle(pool, { schema });
    const [source] = await database.select().from(schema.returnPolicies);
    const { id: _id, ...fields } = source;
    const [created] = await database
      .insert(schema.returnPolicies)
      .values({ ...fields, ...overrides })
      .returning();
    return created;
  }
  async function graph() {
    const names = [
      "customer_return_settings",
      "customer_return_authorizations",
      "customer_return_intakes",
      "customer_return_parcels",
      "customer_return_label_attempts",
      "return_cases",
    ];
    return Promise.all(
      names.map(
        async (name) =>
          (
            await pool.query(
              `SELECT to_jsonb(t) AS row FROM returns.${name} t ORDER BY 1`,
            )
          ).rows,
      ),
    );
  }
  async function apply() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("preserves distinct channel shipping and the complete accepted graph while cloning a shared fallback", async () => {
    await seedPreCarrierSelectionIntake(pool);
    await pool.query(
      `INSERT INTO returns.customer_return_settings(channel_id,version,enabled,warehouse_id,policy_id,selection_mode,carrier_rules,
      carrier_id,service_code,destination_address,contact_name,contact_phone,updated_by,updated_at)
      SELECT 37,7,false,warehouse_id,NULL,'cheapest_eligible',
      '[{"carrierId":"se-999","serviceCodes":["ups_ground"],"maxWeightLb":"20"}]'::jsonb,
      NULL,NULL,destination_address || '{"name":"Frozen channel two"}'::jsonb,'Frozen channel two',NULL,'test',$1
      FROM returns.customer_return_settings WHERE channel_id=36`,
      [INTAKE_NOW],
    );
    const before = await graph();
    const original = (
      await pool.query(
        "SELECT to_jsonb(p) AS row FROM returns.return_policies p WHERE id=1",
      )
    ).rows[0].row;
    await apply();
    expect(await graph()).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(p) AS row FROM returns.return_policies p WHERE id=1",
        )
      ).rows[0].row,
    ).toEqual(original);
    const rows = (
      await pool.query(`SELECT p.id,p.channel_id,p.scope_kind,p.return_window_days,p.supersedes_policy_id,s.configuration
      FROM returns.return_policies p JOIN returns.return_policy_shipping s ON s.policy_id=p.id ORDER BY p.channel_id`)
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        scope_kind: "channel_context",
        return_window_days: 365,
        supersedes_policy_id: null,
      });
      expect(
        customerReturnLabelSettingsSchema.parse(row.configuration),
      ).toMatchObject({ policyId: row.id, version: row.id });
    }
    expect(rows[0].configuration).toMatchObject({
      enabled: true,
      selectionMode: "fixed_service",
      carrierId: "se-123",
    });
    expect(rows[1].configuration).toMatchObject({
      enabled: false,
      selectionMode: "cheapest_eligible",
      carrierId: null,
      carrierRules: [
        {
          carrierId: "se-999",
          serviceCodes: ["ups_ground"],
          maxWeightLb: "20",
        },
      ],
      destinationAddress: { name: "Frozen channel two" },
    });
    expect(
      (
        await pool.query(
          "SELECT channel_id,paused,version FROM returns.customer_return_label_controls ORDER BY channel_id",
        )
      ).rows,
    ).toEqual([
      { channel_id: 36, paused: false, version: 1 },
      { channel_id: 37, paused: true, version: 1 },
    ]);
    expect(
      (
        await pool.query(
          "SELECT channel_id,resolved_policy_id,outcome FROM returns.return_policy_shipping_migrations ORDER BY channel_id",
        )
      ).rows,
    ).toEqual([
      { channel_id: 36, resolved_policy_id: 1, outcome: "migrated" },
      { channel_id: 37, resolved_policy_id: 1, outcome: "migrated" },
    ]);
  });

  it("versions the active channel winner without filtering unsupported operational terms", async () => {
    const old = await clonePolicy({
      scopeKind: "channel_context",
      scopeKey: "context:retail:channel:36",
      channelId: 36,
      version: 2,
      returnWindowDays: 32,
      returnShippingPayer: "customer",
      inspectionRequirement: "conditional",
      notes: "Keep exact rules",
    });
    await apply();
    const rows = (
      await pool.query(
        "SELECT id,status,version,return_window_days,return_shipping_payer,inspection_requirement,notes,supersedes_policy_id FROM returns.return_policies ORDER BY id",
      )
    ).rows;
    expect(rows[0]).toMatchObject({ id: 1, status: "active" });
    expect(rows[1]).toMatchObject({ id: old.id, status: "retired" });
    expect(rows[2]).toMatchObject({
      status: "active",
      version: 3,
      return_window_days: 32,
      return_shipping_payer: "customer",
      inspection_requirement: "conditional",
      notes: "Keep exact rules",
      supersedes_policy_id: old.id,
    });
  });

  it("does not invent policy rules when no active winner exists", async () => {
    await pool.query("UPDATE returns.return_policies SET status='retired'");
    await apply();
    expect(
      (
        await pool.query(
          "SELECT outcome,new_policy_id FROM returns.return_policy_shipping_migrations",
        )
      ).rows,
    ).toEqual([{ outcome: "no_active_policy", new_policy_id: null }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM returns.return_policy_shipping",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM returns.customer_return_settings",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("does not conceal a malformed lower-scope candidate beneath a valid channel winner", async () => {
    await clonePolicy({
      scopeKind: "channel_context",
      scopeKey: "context:retail:channel:36",
      channelId: 36,
    });
    await pool.query(
      "UPDATE returns.return_policies SET scope_key='malformed-retail' WHERE id=1",
    );
    await apply();
    expect(
      (
        await pool.query(
          "SELECT outcome,new_policy_id FROM returns.return_policy_shipping_migrations",
        )
      ).rows,
    ).toEqual([{ outcome: "invalid_policy_scope", new_policy_id: null }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM returns.return_policies WHERE status='active'",
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("rolls back all prior channel conversions if a later legacy destination cannot satisfy the new invariant", async () => {
    await pool.query(
      `INSERT INTO returns.customer_return_settings(channel_id,version,enabled,warehouse_id,policy_id,carrier_id,service_code,
      destination_address,contact_name,contact_phone,updated_by,updated_at)
      SELECT 37,1,true,warehouse_id,policy_id,carrier_id,service_code,'{}'::jsonb,contact_name,contact_phone,'test',$1
      FROM returns.customer_return_settings WHERE channel_id=36`,
      [INTAKE_NOW],
    );
    const before = (
      await pool.query(
        "SELECT to_jsonb(p) AS row FROM returns.return_policies p ORDER BY id",
      )
    ).rows;
    await expect(apply()).rejects.toThrow(/check constraint/);
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(p) AS row FROM returns.return_policies p ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT to_regclass('returns.return_policy_shipping') AS relation",
        )
      ).rows[0].relation,
    ).toBeNull();
  });

  it("enforces immutable owner, real warehouse references, explicit null configuration and migration evidence", async () => {
    await apply();
    const existing = (
      await pool.query(
        "SELECT configuration FROM returns.return_policy_shipping",
      )
    ).rows[0].configuration;
    for (const table of [
      "return_policy_shipping",
      "return_policy_shipping_migrations",
      "customer_return_label_control_events",
    ]) {
      await expect(pool.query(`DELETE FROM returns.${table}`)).rejects.toThrow(
        /append-only/,
      );
    }
    const policy = await clonePolicy({
      scopeKind: "global",
      scopeKey: "global",
      businessContext: null,
    });
    await expect(
      pool.query(
        "INSERT INTO returns.return_policy_shipping(policy_id,configuration,created_by,created_at) VALUES($1,$2,'test',$3)",
        [policy.id, JSON.stringify(existing), INTAKE_NOW],
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pool.query(
        "INSERT INTO returns.return_policy_shipping(policy_id,configuration,created_by,created_at) VALUES($1,$2,'test',$3)",
        [
          policy.id,
          JSON.stringify({
            ...existing,
            version: policy.id,
            policyId: policy.id,
            warehouseId: 99999,
          }),
          INTAKE_NOW,
        ],
      ),
    ).rejects.toThrow(/foreign key/);
    await pool.query(
      "INSERT INTO returns.return_policy_shipping(policy_id,configuration,created_by,created_at) VALUES($1,NULL,'test',$2)",
      [policy.id, INTAKE_NOW],
    );
    expect(
      (
        await pool.query(
          "SELECT configuration,warehouse_id FROM returns.return_policy_shipping WHERE policy_id=$1",
          [policy.id],
        )
      ).rows,
    ).toEqual([{ configuration: null, warehouse_id: null }]);
    await expect(
      pool.query(
        "UPDATE returns.return_policy_shipping SET configuration=NULL",
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("rejects an old-release save queued across conversion commit without changing preserved or migrated configuration", async () => {
    const original = (
      await pool.query(
        "SELECT to_jsonb(s) AS row FROM returns.customer_return_settings s WHERE channel_id=36",
      )
    ).rows[0].row;
    const migrationClient = await pool.connect();
    const staleWriter = await pool.connect();
    let pending: Promise<{ error: unknown } | { value: unknown }> | undefined;
    try {
      await staleWriter.query("BEGIN");
      expect(
        (
          await staleWriter.query(
            "SELECT version FROM returns.customer_return_settings WHERE channel_id=36",
          )
        ).rows[0].version,
      ).toBe(1);
      await migrationClient.query("BEGIN");
      await migrationClient.query(migration);
      const writerPid = (
        await staleWriter.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      pending = staleWriter
        .query(
          "UPDATE returns.customer_return_settings SET enabled=false,version=2 WHERE channel_id=36 AND version=1",
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = (
          await pool.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [writerPid],
          )
        ).rows[0];
        if (activity?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await migrationClient.query("COMMIT");
      expect(await pending).toMatchObject({
        error: {
          code: "55000",
          detail: "RETURN_LABEL_SETTINGS_MOVED",
          message: expect.stringContaining("Returns > Policies"),
        },
      });
      await staleWriter.query("ROLLBACK");
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(s) AS row FROM returns.customer_return_settings s WHERE channel_id=36",
          )
        ).rows[0].row,
      ).toEqual(original);
      expect(
        (
          await pool.query(
            "SELECT paused,version FROM returns.customer_return_label_controls WHERE channel_id=36",
          )
        ).rows[0],
      ).toEqual({ paused: false, version: 1 });
      expect(
        (
          await pool.query(
            "SELECT configuration FROM returns.return_policy_shipping",
          )
        ).rows[0].configuration,
      ).toMatchObject({ enabled: true, version: 2, policyId: 2 });
      for (const statement of [
        "DELETE FROM returns.customer_return_settings WHERE channel_id=36",
        "INSERT INTO returns.customer_return_settings SELECT * FROM returns.customer_return_settings WHERE false",
      ]) {
        await expect(pool.query(statement)).rejects.toMatchObject({
          code: "55000",
          detail: "RETURN_LABEL_SETTINGS_MOVED",
        });
      }
    } finally {
      await migrationClient.query("ROLLBACK");
      await pending;
      await staleWriter.query("ROLLBACK");
      migrationClient.release();
      staleWriter.release();
    }
  });
});
