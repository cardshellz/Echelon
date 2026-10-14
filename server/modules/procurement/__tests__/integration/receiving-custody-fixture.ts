import type pg from "pg";

const EMPTY_HISTORY_TABLES = [
  ["receiving_quarantine_observations", "receiving_quarantine_observation_no_truncate"],
  ["receiving_quarantine_acceptances", "receiving_quarantine_acceptance_no_truncate"],
  ["receiving_quarantine_dispositions", "receiving_quarantine_disposition_no_truncate"],
] as const;

/** Existing regression fixtures own their disposable schemas and reset stock
 * between cases. Quarantine's production TRUNCATE prohibition also covers empty
 * tables. Permit that fixture reset only after proving there is no custody
 * history, and restore its guards atomically before any business code runs. */
export async function resetFixtureWithEmptyReceivingCustody(pool: pg.Pool, resetSql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [table] of EMPTY_HISTORY_TABLES) {
      await client.query(`LOCK TABLE procurement.${table} IN ACCESS EXCLUSIVE MODE`);
      if ((await client.query(`SELECT 1 FROM procurement.${table} LIMIT 1`)).rowCount !== 0) {
        throw new Error("This legacy fixture reset may not erase receiving custody history");
      }
    }
    for (const [table, trigger] of EMPTY_HISTORY_TABLES) {
      await client.query(`ALTER TABLE procurement.${table} DISABLE TRIGGER ${trigger}`);
    }
    await client.query(resetSql);
    for (const [table, trigger] of EMPTY_HISTORY_TABLES) {
      await client.query(`ALTER TABLE procurement.${table} ENABLE TRIGGER ${trigger}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
