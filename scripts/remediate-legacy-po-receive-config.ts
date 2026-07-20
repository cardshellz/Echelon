/**
 * Recover missing expected receive configuration on legacy PO lines.
 *
 * Preview is the default and performs no writes:
 *   npm run procurement:remediate-legacy-po-receive-config
 *
 * Apply requires an attributable application user and the exact preview hash:
 *   npm run procurement:remediate-legacy-po-receive-config -- \
 *     --execute --actor=USER-ID --preview-hash=SHA256
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export type LegacyPoReceiveConfigCliOptions = {
  execute: boolean;
  actor: string | null;
  previewHash: string | null;
};

export function parseLegacyPoReceiveConfigArgs(
  args: string[],
): LegacyPoReceiveConfigCliOptions {
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
  if (process.env.DATABASE_URL) return;
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
}

async function main(): Promise<void> {
  const options = parseLegacyPoReceiveConfigArgs(process.argv.slice(2));
  await loadLocalEnvironmentIfNeeded();
  const connectionString =
    process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pg = await import("pg");
  const Pool = pg.default.Pool;
  const useSsl = Boolean(
    connectionString.includes("amazonaws.com"),
  );
  const pool = new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  const {
    applyLegacyPoReceiveConfigRemediation,
    previewLegacyPoReceiveConfigRemediation,
  } = await import(
    "../server/modules/procurement/legacy-po-receive-config-remediation.service"
  );

  try {
    if (!options.execute) {
      const preview = await previewLegacyPoReceiveConfigRemediation(pool);
      console.log(JSON.stringify(preview, null, 2));
      return;
    }
    const result = await applyLegacyPoReceiveConfigRemediation({
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
