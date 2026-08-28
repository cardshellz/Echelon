import { pool } from "../server/db";
import { InventoryAvailabilityBackfillService } from "../server/modules/inventory-planning/application/inventory-availability-backfill.service";
import { PostgresInventoryAvailabilityBackfillRepository } from "../server/modules/inventory-planning/infrastructure/inventory-availability-backfill.repository";
import { PostgresInventoryAvailabilityMasterDataStore } from "../server/modules/inventory-planning/infrastructure/inventory-availability-master-data.repository";

interface CommandOptions {
  apply: boolean;
  actor: string | null;
  reason: string | null;
  productId: number | null;
}

function argumentValue(arguments_: readonly string[], name: string): string | null {
  const index = arguments_.indexOf(name);
  if (index === -1) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(arguments_: readonly string[]): CommandOptions {
  const known = new Set(["--apply", "--actor", "--reason", "--product-id"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!known.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument !== "--apply") index += 1;
  }
  const rawProductId = argumentValue(arguments_, "--product-id");
  const productId = rawProductId === null ? null : Number(rawProductId);
  if (productId !== null
    && (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2_147_483_647)) {
    throw new Error("--product-id must be a positive PostgreSQL integer");
  }
  const apply = arguments_.includes("--apply");
  const actor = argumentValue(arguments_, "--actor")?.trim() || null;
  const reason = argumentValue(arguments_, "--reason")?.trim() || null;
  if (apply && !actor) throw new Error("--apply requires --actor");
  if (apply && !reason) throw new Error("--apply requires --reason");
  if (actor && actor.length > 100) throw new Error("--actor cannot exceed 100 characters");
  if (reason && reason.length > 1000) throw new Error("--reason cannot exceed 1000 characters");
  return { apply, actor, reason, productId };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const catalogStore = new PostgresInventoryAvailabilityBackfillRepository();
  const service = new InventoryAvailabilityBackfillService(
    catalogStore,
    new PostgresInventoryAvailabilityMasterDataStore(),
    { previewLatestShadowChannels: async () => null },
  );
  const queue = await service.getMigrationQueue();
  const products = options.productId === null
    ? queue.products
    : queue.products.filter((product) => product.productId === options.productId);
  if (options.productId !== null && products.length === 0) {
    throw new Error(`Active product ${options.productId} was not found in the migration queue`);
  }
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      mode: "dry_run",
      runtimeAuthorityChanged: false,
      inventoryWriteAttempted: false,
      channelWriteAttempted: false,
      ...queue,
      products,
    }, null, 2)}\n`);
    return;
  }

  const applied: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  for (const product of products) {
    if (product.queueState !== "not_backfilled" || product.candidateDefinition === null) {
      skipped.push({
        productId: product.productId,
        queueState: product.queueState,
        issueCodes: product.issues.map((entry) => entry.code),
      });
      continue;
    }
    try {
      const result = await service.applyProductDraft(product.productId, {
        expectedInputHash: product.inputHash,
        expectedResultHash: product.resultHash,
        changeReason: options.reason!,
        idempotencyKey: `phase3-backfill-v1:${product.productId}:${product.resultHash}`,
      }, options.actor!);
      applied.push({ productId: product.productId, ...result });
    } catch (error) {
      failed.push({
        productId: product.productId,
        errorName: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  process.stdout.write(`${JSON.stringify({
    mode: "apply_drafts_only",
    runtimeAuthorityChanged: false,
    inventoryWriteAttempted: false,
    channelWriteAttempted: false,
    catalogInputHash: queue.catalogInputHash,
    catalogResultHash: queue.catalogResultHash,
    applied,
    skipped,
    failed,
  }, null, 2)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      code: "INVENTORY_AVAILABILITY_BACKFILL_COMMAND_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (error) {
      console.error(JSON.stringify({
        code: "INVENTORY_AVAILABILITY_BACKFILL_POOL_CLOSE_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
      process.exitCode = 1;
    }
  });
