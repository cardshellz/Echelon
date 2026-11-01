/** Reviewed image recovery. Dry-run by default; only the Catalog owner writes.
 * CATALOG_RECOVERY_DATABASE_URL must explicitly name the intended database.
 * npx tsx scripts/recover-catalog-image-originals.ts --manifest review.json [--execute]
 * Files are local, hash-pinned originals under the manifest directory. This
 * command does not change photo selection or upload to a provider. An applied
 * Catalog change can schedule normal channel work through intent invalidation.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "../shared/schema";
import {
  catalogOriginalReplacementSchema,
  createCatalogImageOriginalsService,
} from "../server/modules/catalog/catalog-image-originals.service";
import { inspectCatalogImage } from "../server/modules/catalog/catalog-image-inspection";
import { MAX_PRODUCT_IMAGE_BYTES } from "../server/modules/catalog/product-image-download.service";
import { ProductAssetError } from "../server/modules/catalog/product-asset-errors";

const manifestSchema = z
  .object({
    version: z.literal(1),
    photos: z
      .array(
        z
          .object({
            command: catalogOriginalReplacementSchema,
            file: z
              .string()
              .min(1)
              .max(1000)
              .refine((value) => !isAbsolute(value)),
            mimeType: z.enum([
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/gif",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      execute: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.manifest || !process.env.CATALOG_RECOVERY_DATABASE_URL)
    throw new Error("Provide --manifest and CATALOG_RECOVERY_DATABASE_URL.");
  const manifestPath = await realpath(resolve(values.manifest)),
    directory = dirname(manifestPath);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (
    new Set(manifest.photos.map((photo) => photo.command.assetId)).size !==
    manifest.photos.length
  )
    throw new Error(
      "Each Catalog image must appear once in the reviewed manifest.",
    );
  async function original(photo: (typeof manifest.photos)[number]) {
    const path = await realpath(resolve(directory, photo.file)),
      within = relative(directory, path);
    if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep))
      throw new Error(
        "Original files must stay within the reviewed manifest directory.",
      );
    if ((await stat(path)).size > MAX_PRODUCT_IMAGE_BYTES)
      throw new Error("Original exceeds the Catalog image limit.");
    const image = { data: await readFile(path), mimeType: photo.mimeType };
    if (
      inspectCatalogImage(image).contentHash !==
      photo.command.expectedOriginalHash
    )
      throw new Error("An original differs from its reviewed content hash.");
    return image;
  }
  // Validate every reviewed file before opening a database connection or writing.
  for (const photo of manifest.photos) await original(photo);
  const connection = new URL(process.env.CATALOG_RECOVERY_DATABASE_URL);
  if (!["postgresql:", "postgres:"].includes(connection.protocol))
    throw new Error("A PostgreSQL recovery connection is required.");
  for (const field of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    connection.searchParams.delete(field);
  const pool = new pg.Pool({
    connectionString: connection.toString(),
    ssl: ["localhost", "127.0.0.1", "::1"].includes(connection.hostname)
      ? undefined
      : { rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
    application_name: "catalog_image_original_recovery",
  });
  const owner = createCatalogImageOriginalsService(
    drizzle(pool, { schema }),
    () => new Date(),
  );
  const results: Array<{
    assetId: number;
    applied?: boolean;
    wouldApply?: boolean;
    contentHash: string;
  }> = [];
  try {
    // Preview uses the same source/CAS validation in a PostgreSQL read-only
    // transaction. Execution rechecks under locks; each image/audit is atomic.
    if (values.execute)
      for (const photo of manifest.photos)
        await owner.preview(photo.command, await original(photo));
    for (const photo of manifest.photos) {
      const result = values.execute
        ? await owner.replace(photo.command, await original(photo))
        : await owner.preview(photo.command, await original(photo));
      results.push({ assetId: photo.command.assetId, ...result });
    }
    console.log(
      JSON.stringify({
        mode: values.execute ? "execute" : "preview",
        reviewed: manifest.photos.length,
        results,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        code:
          error instanceof ProductAssetError
            ? error.code
            : "CATALOG_ORIGINAL_RECOVERY_FAILED",
        completed: results,
        message:
          "Recovery stopped. Committed images remain audited and an unchanged manifest can be replayed safely.",
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      code: "CATALOG_ORIGINAL_RECOVERY_INVALID",
      message:
        error instanceof z.ZodError
          ? "The reviewed manifest is invalid."
          : "Validate the manifest, files and recovery connection before retrying.",
    }),
  );
  process.exitCode = 1;
});
