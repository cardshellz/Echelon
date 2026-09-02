import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const sourceMigration = readFileSync(
  resolve(process.cwd(), "migrations/0643_shipping_fulfillment_provider_connections.sql"),
  "utf8",
);

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

describeWithDisposableDb.sequential("fulfillment provider connection PostgreSQL guarantees", () => {
  let pool: pg.Pool;
  const schema = `shipping_provider_connections_${process.pid}`;
  const qualifiedMigration = sourceMigration.replaceAll("shipping.", `"${schema}".`);

  beforeAll(async () => {
    const protectedUrls = [
      process.env.DATABASE_URL,
      process.env.EXTERNAL_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));
    if (!TEST_DB_URL || !DISPOSABLE_DB || protectedUrls.includes(TEST_DB_URL)) {
      throw new Error("Fulfillment provider integration tests require a distinct disposable database");
    }
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 2,
      ssl: sslConfig(TEST_DB_URL),
    });
    await pool.query(`
      CREATE SCHEMA "${schema}";

      CREATE TABLE "${schema}".fulfillment_routing_revisions (
        id bigint PRIMARY KEY,
        service_level_id integer NOT NULL,
        revision integer NOT NULL,
        methods_snapshot jsonb NOT NULL
      );

      CREATE TABLE "${schema}".fulfillment_routing_profiles (
        service_level_id integer PRIMARY KEY,
        revision integer NOT NULL,
        current_revision_id bigint
      );

      CREATE TABLE "${schema}".service_level_methods (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        service_level_id integer NOT NULL,
        provider varchar(40) NOT NULL,
        provider_account_id varchar(120),
        provider_account_name varchar(160),
        carrier varchar(50) NOT NULL,
        carrier_name varchar(160),
        service_code varchar(80) NOT NULL,
        service_name varchar(160),
        priority integer NOT NULL,
        domestic boolean NOT NULL DEFAULT false,
        international boolean NOT NULL DEFAULT false,
        revision_id bigint,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT shipping_level_method_provider_chk
          CHECK (provider IN ('legacy_unscoped', 'shipstation_v2')),
        CONSTRAINT shipping_level_method_identity_chk CHECK (
          (provider = 'legacy_unscoped' AND provider_account_id IS NULL AND revision_id IS NULL)
          OR
          (provider = 'shipstation_v2' AND provider_account_id IS NOT NULL AND revision_id IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX shipping_level_method_identity_idx
        ON "${schema}".service_level_methods(
          service_level_id, provider, provider_account_id, service_code
        );
      CREATE UNIQUE INDEX shipping_level_method_priority_idx
        ON "${schema}".service_level_methods(service_level_id, priority)
        WHERE provider_account_id IS NOT NULL;

      INSERT INTO "${schema}".fulfillment_routing_revisions
        (id, service_level_id, revision, methods_snapshot)
      VALUES (
        91,
        7,
        1,
        '[{"provider":"shipstation_v2","providerAccountId":"se-ups","providerAccountName":"UPS account","carrierCode":"ups","carrierName":"UPS","serviceCode":"ups_ground","serviceName":"UPS Ground","domestic":true,"international":false,"priority":1}]'::jsonb
      );
      INSERT INTO "${schema}".fulfillment_routing_profiles
        (service_level_id, revision, current_revision_id)
      VALUES (7, 1, 91);
      INSERT INTO "${schema}".service_level_methods (
        service_level_id, provider, provider_account_id, provider_account_name,
        carrier, carrier_name, service_code, service_name, priority, domestic,
        international, revision_id, is_active
      ) VALUES (
        7, 'shipstation_v2', 'se-ups', 'UPS account', 'ups', 'UPS',
        'ups_ground', 'UPS Ground', 1, true, false, 91, true
      );
    `);
    await pool.query(qualifiedMigration);
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("backfills existing ShipStation routes through the deployment connection", async () => {
    const result = await pool.query<{
      connection_id: string;
      credential_ref: string;
      event_count: string;
    }>(`
      SELECT method.provider_connection_id::text AS connection_id,
             connection.credential_ref,
             (SELECT count(*)::text FROM "${schema}".fulfillment_provider_connection_events) AS event_count
      FROM "${schema}".service_level_methods AS method
      JOIN "${schema}".fulfillment_provider_connections AS connection
        ON connection.id = method.provider_connection_id
      WHERE method.service_level_id = 7
    `);

    expect(result.rows).toEqual([{
      connection_id: "1",
      credential_ref: "SHIPSTATION_V2_API_KEY",
      event_count: "1",
    }]);
  });

  it("retains coherence with a routing revision written before connection identity existed", async () => {
    await pool.query(`
      CREATE CONSTRAINT TRIGGER test_fulfillment_routing_methods_coherence_guard
      AFTER INSERT OR UPDATE OR DELETE ON "${schema}".service_level_methods
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "${schema}".check_fulfillment_routing_method_coherence()
    `);

    await expect(pool.query(`
      UPDATE "${schema}".service_level_methods
      SET updated_at = updated_at
      WHERE service_level_id = 7
    `)).resolves.toBeDefined();
  });

  it("rejects disabling a connection referenced by an active route", async () => {
    await expect(pool.query(`
      UPDATE "${schema}".fulfillment_provider_connections
      SET status = 'disabled',
          revision = revision + 1,
          updated_by = 'integration-test',
          updated_at = transaction_timestamp()
      WHERE id = 1
    `)).rejects.toThrow(/used by active routes cannot be disabled/);
  });

  it("keeps audit events append-only and credentials scoped to vault connections", async () => {
    await expect(pool.query(`
      UPDATE "${schema}".fulfillment_provider_connection_events
      SET actor_user_id = 'changed'
      WHERE connection_id = 1
    `)).rejects.toThrow(/append-only/);

    await expect(pool.query(`
      INSERT INTO "${schema}".fulfillment_provider_credentials
        (connection_id, key_id, ciphertext, iv, auth_tag, updated_by)
      VALUES (1, 'key-1', 'ciphertext', 'iv', 'tag', 'integration-test')
    `)).rejects.toThrow(/vault-backed connection/);
  });

  it("accepts a future provider key without a schema migration", async () => {
    const result = await pool.query<{ provider: string }>(`
      INSERT INTO "${schema}".fulfillment_provider_connections (
        provider, name, status, credential_source, credential_ref, system_managed,
        revision, created_by, updated_by
      ) VALUES (
        'direct_carrier', 'Direct carrier', 'active', 'vault', NULL, FALSE,
        1, 'integration-test', 'integration-test'
      )
      RETURNING provider
    `);

    expect(result.rows).toEqual([{ provider: "direct_carrier" }]);
  });
});
