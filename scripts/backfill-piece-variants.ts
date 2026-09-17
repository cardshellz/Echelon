/**
 * Create the missing one-piece variant for every product sold only in packs.
 *
 * Receiving needs an active `units_per_variant = 1` variant to count pieces
 * that do not divide into the preferred pack; products without one fail with
 * RECEIVING_PIECE_VARIANT_REQUIRED. Each created piece is internal-only,
 * `${productSku}-PC1`, and audited.
 *
 * Preview is the default and performs no writes:
 *   npm run catalog:backfill-piece-variants
 *
 * Apply requires an attributable application user and the exact preview hash:
 *   npm run catalog:backfill-piece-variants -- \
 *     --execute --actor=USER-ID --preview-hash=SHA256
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export type PieceVariantBackfillCliOptions = {
  execute: boolean;
  actor: string | null;
  previewHash: string | null;
};

export function parsePieceVariantBackfillArgs(
  args: string[],
): PieceVariantBackfillCliOptions {
  let execute = false;
  let actor: string | null = null;
  let previewHash: string | null = null;

  for (const arg of args) {
    if (arg === "--execute") {
      execute = true;
    } else if (arg.startsWith("--actor=")) {
      actor = arg.slice("--actor=".length).trim() || null;
    } else if (arg.startsWith("--preview-hash=")) {
      previewHash = arg.slice("--preview-hash=".length).trim().toLowerCase() || null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (actor && actor.length > 100) {
    throw new Error("--actor must be 100 characters or fewer");
  }
  if (previewHash && !/^[0-9a-f]{64}$/.test(previewHash)) {
    throw new Error("--preview-hash must be the SHA-256 hash returned by preview");
  }
  if (execute && !actor) throw new Error("--actor is required with --execute");
  if (execute && !previewHash) {
    throw new Error("--preview-hash is required with --execute");
  }
  if (!execute && (actor || previewHash)) {
    throw new Error("--actor and --preview-hash are only valid with --execute");
  }

  return { execute, actor, previewHash };
}

async function loadLocalEnvironmentIfNeeded(): Promise<void> {
  if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) return;
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
}

async function main(): Promise<void> {
  const options = parsePieceVariantBackfillArgs(process.argv.slice(2));
  await loadLocalEnvironmentIfNeeded();
  const connectionString =
    process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
  }

  const pg = await import("pg");
  const Pool = pg.default.Pool;
  const useSsl = Boolean(
    process.env.EXTERNAL_DATABASE_URL || connectionString.includes("amazonaws.com"),
  );
  const pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  const {
    applyPieceVariantBackfill,
    previewPieceVariantBackfill,
  } = await import("../server/modules/catalog/piece-variant-backfill.service");

  try {
    if (!options.execute) {
      const preview = await previewPieceVariantBackfill(pool);
      console.log(JSON.stringify(preview, null, 2));
      return;
    }
    const result = await applyPieceVariantBackfill({
      pool,
      actorId: options.actor!,
      expectedPreviewHash: options.previewHash!,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
