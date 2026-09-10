import type { Pool } from "pg";

/**
 * Reduced authority read model for pre-opening cost-owner integration fixtures.
 * The explicit, empty opening means "not activated", never "schema missing".
 * These suites exercise real receipt/cost SQL before quantity cutover; they do
 * not prove migration guards or post-opening posting. Those guarantees use the
 * actual migrations in quantity-ledger-database.ts. Refuse opening inserts so a
 * reduced fixture cannot accidentally masquerade as an activated ledger.
 */
export async function installPreOpeningQuantityAuthorityFixture(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`
    CREATE TABLE inventory.cutover_admission_fence (
      singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key),
      epoch bigint NOT NULL CHECK (epoch > 0)
    );
    INSERT INTO inventory.cutover_admission_fence(singleton_key,epoch) VALUES(true,1);
  `);
  await installUnopenedQuantityLedgerFixture(pool);
}

/** Opening-only prerequisite for component fixtures with their own admission setup. */
export async function installUnopenedQuantityLedgerFixture(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`
    CREATE TABLE inventory.quantity_ledger_opening (
      singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key),
      command_id bigint NOT NULL,
      CONSTRAINT fixture_must_remain_pre_opening CHECK (false)
    );
  `);
}
