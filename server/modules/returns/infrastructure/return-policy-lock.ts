import { sql, type SQL } from "drizzle-orm";

// All policy snapshot writers take shared; catalog mutations take exclusive.
// Acquire before scope/settings/order locks and retain until transaction commit.
const RETURN_POLICY_CATALOG_LOCK_NAMESPACE = 918421;
const RETURN_POLICY_CATALOG_LOCK_KEY = 1;
export async function acquireReturnPolicyCatalogLock(
  executor: { execute(query: SQL): PromiseLike<unknown> },
  mode: "shared" | "exclusive",
): Promise<void> {
  await executor.execute(
    mode === "shared"
      ? sql`SELECT pg_advisory_xact_lock_shared(${RETURN_POLICY_CATALOG_LOCK_NAMESPACE},${RETURN_POLICY_CATALOG_LOCK_KEY})`
      : sql`SELECT pg_advisory_xact_lock(${RETURN_POLICY_CATALOG_LOCK_NAMESPACE},${RETURN_POLICY_CATALOG_LOCK_KEY})`,
  );
}
