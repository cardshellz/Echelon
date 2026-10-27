import { parsePackageHistoryBackfillOptions } from "./lib/package-history-backfill-options";

async function main() {
  const options = parsePackageHistoryBackfillOptions(process.argv.slice(2));
  const scope = {
    action: "shipping_package_history_backfill",
    actor: options.actor,
    channelId: options.channelId,
    runKey: options.runKey,
    mode: options.mode,
  };
  console.log(
    JSON.stringify({
      ...scope,
      outcome: options.execute ? "started" : "dry_run",
      batches: options.batches,
    }),
  );
  if (!options.execute) return; // No credentials, DB, services or HTTP in a dry run.
  const { db, pool } = await import("../server/db");
  try {
    const { PackageHistoryBackfillRepository } = await import(
      "../server/modules/shipping/package-history-backfill.repository"
    );
    const repository = new PackageHistoryBackfillRepository(pool);
    if (options.mode === "seed")
      for (let batch = 0; batch < options.batches; batch++) {
        const result = await repository.seed(
          {
            channelId: options.channelId,
            runKey: options.runKey,
            actor: options.actor,
            limit: 200,
          },
          new Date(),
        );
        console.log(JSON.stringify(result));
        if (result.state === "seeded") break;
      }
    if (options.mode === "run") {
      const { createPackageHistoryWorker } = await import(
        "../server/modules/shipping/package-history.composition"
      );
      const worker = createPackageHistoryWorker(
        pool,
        db,
        (event) =>
          console.log(JSON.stringify({ ...event, actor: options.actor })),
        options.actor,
      );
      if (!worker) throw new Error("PACKAGE_HISTORY_PROVIDER_NOT_CONFIGURED");
      for (let batch = 0; batch < options.batches; batch++) {
        if (!(await worker.run({ channelId: options.channelId }))) break;
      }
    }
    if (options.mode === "retry-review")
      for (let batch = 0; batch < options.batches; batch++) {
        const result = await repository.retryReview(
          {
            channelId: options.channelId,
            runKey: options.runKey,
            actor: options.actor,
            limit: 200,
          },
          new Date(),
        );
        console.log(JSON.stringify(result));
        if (!result.enqueued) break;
      }
    console.log(
      JSON.stringify({
        ...scope,
        outcome: "status",
        ...(await repository.status(
          { channelId: options.channelId, runKey: options.runKey },
          new Date(),
        )),
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({
      action: "shipping_package_history_backfill",
      outcome: "failed",
      code: "PACKAGE_HISTORY_BACKFILL_FAILED",
    }),
  );
  process.exitCode = 1;
});
