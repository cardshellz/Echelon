import type { Pool, PoolClient } from "pg";

const MAX_TRANSACTION_ATTEMPTS = 3;

/** Local-only publication commands retry the complete transaction after a
 * serialization conflict. The durable command receipt resolves uncertain commits. */
export async function executeInventoryPublicationCommand<T>(connectionPool: Pick<Pool, "connect">,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await connectionPool.connect();
    let discard: Error | undefined;
    let committing = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await work(client);
      committing = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (committing) discard = error instanceof Error ? error : new Error(String(error));
      try { await client.query("ROLLBACK"); }
      catch (rollback) {
        discard = rollback instanceof Error ? rollback : new Error(String(rollback));
        throw new AggregateError([error, rollback], "Inventory publication command rollback failed; retry the same command key.");
      }
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (attempt < MAX_TRANSACTION_ATTEMPTS && (code === "40001" || code === "40P01")) continue;
      throw error;
    } finally { client.release(discard); }
  }
}
