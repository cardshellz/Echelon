import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ShippingConfigurationError } from "../domain/configuration-error";

/** Shared lock/command journal keeps catalog, suite and policy changes serializable. */
export async function configurationCommand<T>(
  pool: Pool,
  key: string,
  input: { commandId: string },
  actor: string,
  now: Date,
  work: (client: PoolClient) => Promise<{ before: unknown; after: T }>,
  historyKey: (after: T) => string = () => key,
): Promise<T> {
  const client = await pool.connect();
  const hash = createHash("sha256")
    .update(JSON.stringify({ key, input, actor }))
    .digest("hex");
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('shipping-shared-config'))",
    );
    const replay = await client.query(
      "SELECT request_hash,after_state FROM shipping.configuration_commands WHERE command_id=$1",
      [input.commandId],
    );
    if (replay.rows.length) {
      if (replay.rows[0].request_hash !== hash)
        throw new ShippingConfigurationError(
          "SHIPPING_COMMAND_REUSED",
          "Command was already used for different settings.",
        );
      await client.query("COMMIT");
      return replay.rows[0].after_state as T;
    }
    const result = await work(client);
    await client.query(
      `INSERT INTO shipping.configuration_commands(command_id,request_hash,actor_id,resource_key,before_state,after_state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.commandId,
        hash,
        actor,
        historyKey(result.after),
        JSON.stringify(result.before),
        JSON.stringify(result.after),
        now,
      ],
    );
    await client.query("COMMIT");
    return result.after;
  } catch (error) {
    await client.query("ROLLBACK");
    if (
      (error as { constraint?: string; message?: string }).message?.includes(
        "SHIPPING_PACKAGING_POLICY_CONFLICT",
      )
    ) {
      throw new ShippingConfigurationError(
        "SHIPPING_PACKAGING_POLICY_CONFLICT",
        "This change conflicts with an assigned packaging policy. Reassign its suite or correct box branding first.",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
