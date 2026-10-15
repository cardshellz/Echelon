import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE } from "./quantity-publication-admission.repository";

export const reconciliationHash = (input: unknown): string => createHash("sha256").update(canonicalJson(input)).digest("hex");
export function reconciliationFailure(code: string, message: string): QuantityPublicationAdmissionError {
  return new QuantityPublicationAdmissionError(code, message);
}
export async function withReconciliationTransaction<T>(pool: Pick<Pool, "connect">,
  work: (client: PoolClient) => Promise<T>, serializable = false): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(serializable ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN");
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollback) { discard = true; throw new AggregateError([error, rollback], "eBay inventory recovery rollback failed."); }
    throw error;
  } finally { client.release(discard); }
}
export async function tryLockReconciliationScopes(client: PoolClient, keys: readonly string[]): Promise<boolean> {
  if (!(await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock_shared($1,0) AS acquired",
    [QUANTITY_PUBLICATION_LOCK_NAMESPACE])).rows[0]?.acquired) return false;
  for (const key of [...new Set(keys)].sort()) {
    if (!(await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,918420)) AS acquired", [key])).rows[0]?.acquired) return false;
  }
  return true;
}
