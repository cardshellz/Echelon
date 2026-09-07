import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CostEvidenceError, type CostEvidenceTransaction } from "./cost-evidence.repository";

const postgresDialect = new PgDialect();

/** Adapts the already-owned pg transaction; never opens another connection. */
export function costEvidenceTransactionFromPg(client: {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}): CostEvidenceTransaction {
  return {
    async execute(query: unknown) {
      if (!(query instanceof SQL)) throw new CostEvidenceError("COST_QUERY_INVALID", "Cost evidence requires a parameterized SQL query.");
      const compiled = postgresDialect.sqlToQuery(query);
      return client.query(compiled.sql, compiled.params);
    },
  };
}
