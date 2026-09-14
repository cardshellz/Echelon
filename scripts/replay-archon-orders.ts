import { pool } from "../server/db";
import { queueHistoricalArchonOrders } from "../server/modules/oms/archon-order-replay";
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
async function main() {
  if (
    !args.includes("--from") ||
    !args.includes("--to") ||
    args.some(
      (a, i) =>
        a.startsWith("--") && !["--from", "--to", "--apply"].includes(a),
    )
  )
    throw new Error(
      "Use --from YYYY-MM-DD --to YYYY-MM-DD [--apply]. End date is exclusive. Default is dry run.",
    );
  console.log(
    JSON.stringify(
      await queueHistoricalArchonOrders(pool, {
        from: value("--from"),
        to: value("--to"),
        apply: args.includes("--apply"),
      }),
    ),
  );
}
main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        code: "ARCHON_REPLAY_FAILED",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
