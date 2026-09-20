import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0691_dropship_usdc_deposit_addresses.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

describe("0691 dropship USDC deposit addresses migration (funding design phase 6)", () => {
  it("creates one deposit address per vendor per chain, one index per key, one address per chain", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_usdc_deposit_addresses");
    expect(migrationSql).toContain("key_fingerprint varchar(16) NOT NULL");
    expect(migrationSql).toContain("derivation_index integer NOT NULL");
    expect(migrationSql).toContain("CHECK (derivation_index >= 0)");
    expect(migrationSql).toContain("CHECK (address ~ '^0x[0-9a-f]{40}$')");
    expect(migrationSql).toContain("dropship_usdc_deposit_vendor_idx\n  ON dropship.dropship_usdc_deposit_addresses(vendor_id, chain_id)");
    expect(migrationSql).toContain("dropship_usdc_deposit_key_index_idx\n  ON dropship.dropship_usdc_deposit_addresses(chain_id, key_fingerprint, derivation_index)");
    expect(migrationSql).toContain("dropship_usdc_deposit_address_idx\n  ON dropship.dropship_usdc_deposit_addresses(chain_id, address)");
  });

  it("keeps the watcher's place per chain and token", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_usdc_watcher_cursors");
    expect(migrationSql).toContain("PRIMARY KEY (chain_id, token_address)");
    expect(migrationSql).toContain("CHECK (last_scanned_block >= 0)");
  });

  it("makes the log, not the transaction, the identity of a chain observation, and pins the status lifecycle", () => {
    expect(migrationSql).toContain("DROP INDEX IF EXISTS dropship.dropship_usdc_tx_idx");
    expect(migrationSql).toContain("ON dropship.dropship_usdc_ledger_entries(chain_id, transaction_hash, COALESCE(log_index, -1))");
    expect(migrationSql).toContain("CHECK (status IN ('pending', 'settled', 'voided', 'dust'))");
    expect(migrationSql).toContain("CHECK (log_index IS NULL OR log_index >= 0)");
    expect(migrationSql).toContain("CHECK (dust_atomic_units >= 0 AND dust_atomic_units < 10000)");
    for (const column of ["log_index integer", "block_number bigint", "block_hash varchar(66)", "token_address varchar(42)", "deposit_address_id integer", "dust_atomic_units numeric(78, 0) NOT NULL DEFAULT 0", "voided_at timestamptz"]) {
      expect(migrationSql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });

  it("keeps the Drizzle declarations in step", () => {
    expect(schema).toContain('"dropship_usdc_deposit_addresses"');
    expect(schema).toContain('"dropship_usdc_watcher_cursors"');
    expect(schema).toContain('uniqueIndex("dropship_usdc_tx_log_idx")');
    expect(schema).toContain("sql`COALESCE(${table.logIndex}, -1)`");
    expect(schema).toContain('check("dropship_usdc_status_chk"');
    expect(schema).toContain('numeric("dust_atomic_units", { precision: 78, scale: 0 })');
    expect(schema).not.toContain('uniqueIndex("dropship_usdc_tx_idx")');
  });

  it("is repeatable and rewrites no existing row: no UPDATE, no DROP COLUMN, no money column altered", () => {
    expect(migrationSql).not.toMatch(/UPDATE\s+dropship\./i);
    expect(migrationSql).not.toMatch(/DROP COLUMN/i);
    expect(migrationSql).not.toMatch(/ALTER COLUMN\s+amount_atomic_units/i);
    expect(migrationSql.match(/CREATE TABLE(?! IF NOT EXISTS)/g)).toBeNull();
    expect(migrationSql.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g)).toBeNull();
    expect(migrationSql.match(/ADD COLUMN(?! IF NOT EXISTS)/g)).toBeNull();
    const added = migrationSql.match(/ADD CONSTRAINT (\w+)/g) ?? [];
    for (const statement of added) {
      const name = statement.replace("ADD CONSTRAINT ", "");
      expect(migrationSql).toContain(`DROP CONSTRAINT IF EXISTS ${name}`);
    }
  });
});
