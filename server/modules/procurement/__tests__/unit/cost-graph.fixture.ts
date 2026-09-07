import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { vi } from "vitest";

/** Test adapter for owners whose only raw SQL is the shared graph lock. Other
 * statements fail explicitly; these fixtures must not hide a new data write. */
export function costGraphLockExecute() {
  return vi.fn(async (query: SQL) => {
    const statement = new PgDialect().sqlToQuery(query).sql.replace(/\s+/g, " ").trim();
    if (statement !== "SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'))") {
      throw new Error(`Unexpected SQL in graph-lock-only fixture: ${statement}`);
    }
    return { rows: [] };
  });
}
