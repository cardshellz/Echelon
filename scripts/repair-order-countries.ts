/** Dry-run by default. See docs/operations/order-country-integrity.md before applying. */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  applyOrderCountryRepair, orderCountryRepairDigest, OrderCountryRepairError, planOrderCountryRepair,
} from "../server/modules/orders/infrastructure/order-country-repair";

export function parseCountryRepairArguments(args: string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^(--plan|--actor|--operation-key|--confirm-digest)=(.+)$/.exec(arg);
    const key = match?.[1] ?? arg;
    if ((!match && !["--apply", "--dry-run"].includes(arg)) || values.has(key)) {
      throw new OrderCountryRepairError("COUNTRY_REPAIR_ARGUMENT_INVALID");
    }
    values.set(key, match?.[2] ?? "true");
  }
  const apply = values.has("--apply");
  const planPath = values.get("--plan");
  if (!planPath || (apply && values.has("--dry-run")) || (!apply && values.size > (values.has("--dry-run") ? 2 : 1))) {
    throw new OrderCountryRepairError("COUNTRY_REPAIR_ARGUMENT_INVALID");
  }
  const actor = values.get("--actor") ?? "";
  const operationKey = values.get("--operation-key") ?? "";
  const approvedDigest = values.get("--confirm-digest") ?? "";
  if (apply && (!actor || !operationKey || !/^[a-f0-9]{64}$/.test(approvedDigest))) {
    throw new OrderCountryRepairError("COUNTRY_REPAIR_APPROVAL_REQUIRED");
  }
  return { apply, planPath, actor, operationKey, approvedDigest };
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    const args = parseCountryRepairArguments(process.argv.slice(2));
    // Importing server/db would run unrelated startup work. This connection does only this command.
    const raw = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
    if (!raw) throw new OrderCountryRepairError("COUNTRY_REPAIR_DATABASE_REQUIRED");
    const database = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new OrderCountryRepairError("COUNTRY_REPAIR_DATABASE_INVALID");
    for (const key of ["sslmode", "sslrootcert"]) database.searchParams.delete(key);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(database.hostname);
    pool = new Pool({ connectionString: database.toString(), max: 1, connectionTimeoutMillis: 10_000,
      ssl: local ? false : { rejectUnauthorized: true },
      options: `-c application_name=order_country_repair${args.apply ? "" : " -c default_transaction_read_only=on"}` });
    if (args.apply) {
      const plan: unknown = JSON.parse(readFileSync(args.planPath, "utf8"));
      const result = await applyOrderCountryRepair(pool, { ...args, plan });
      console.log(JSON.stringify({ event: "order_country_repair_complete", operationKey: args.operationKey, ...result }));
    } else {
      const client = await pool.connect();
      try {
        const plan = await planOrderCountryRepair(client);
        writeFileSync(args.planPath, JSON.stringify(plan, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
        console.log(JSON.stringify({ event: "order_country_repair_preview", digest: orderCountryRepairDigest(plan),
          changes: plan.rows.length, unrecognized: plan.unrecognized.length,
          tables: Object.fromEntries(["oms.oms_orders", "wms.orders", "wms.combined_order_groups"]
            .map(table => [table, plan.rows.filter(row => row.tableName === table).length])) }));
      } finally { client.release(); }
    }
  } catch (error) {
    // Never print driver messages: they may include connection credentials or address values.
    console.error(JSON.stringify({ event: "order_country_repair_failed",
      code: error instanceof OrderCountryRepairError ? error.code : "COUNTRY_REPAIR_FAILED",
      sqlState: error && typeof error === "object" && "code" in error && /^[0-9A-Z]{5}$/.test(String(error.code)) ? error.code : null }));
    process.exitCode = 1;
  } finally { await pool?.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
