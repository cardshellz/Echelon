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
  MAX_RECOVERY_BATCH_BYTES,
  MAX_RECOVERY_PHOTOS_PER_PRODUCT,
} from "../server/modules/catalog/catalog-image-originals.service";
import { inspectCatalogImage } from "../server/modules/catalog/catalog-image-inspection";
import { MAX_PRODUCT_IMAGE_BYTES } from "../server/modules/catalog/product-image-download.service";
import { ProductAssetError } from "../server/modules/catalog/product-asset-errors";
import { fetchProductImage } from "../server/modules/catalog/product-image-download.transport";

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
            prior: z.object({
              file: z.string().min(1).max(1000).refine((value) => !isAbsolute(value)),
              mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
            }).strict().optional(),
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
      product: { type: "string" },
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
  const productId = values.product === undefined ? undefined
    : z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)).parse(values.product);
  const photos = productId === undefined ? manifest.photos : manifest.photos.filter(photo => photo.command.productId === productId);
  if (!photos.length) throw new ProductAssetError("CATALOG_RECOVERY_PRODUCT_MISSING", "The selected product has no photos in this reviewed manifest.", 404);
  async function fileImage(file: string, mimeType: string, expectedHash: string) {
    const path = await realpath(resolve(directory, file)),
      within = relative(directory, path);
    if (isAbsolute(within) || within === ".." || within.startsWith(".." + sep))
      throw new Error(
        "Original files must stay within the reviewed manifest directory.",
      );
    if ((await stat(path)).size > MAX_PRODUCT_IMAGE_BYTES)
      throw new Error("Original exceeds the Catalog image limit.");
    const image = { data: await readFile(path), mimeType };
    if (inspectCatalogImage(image).contentHash !== expectedHash)
      throw new Error("An original differs from its reviewed content hash.");
    return image;
  }
  async function original(photo: (typeof manifest.photos)[number]) {
    return fileImage(photo.file, photo.mimeType, photo.command.expectedOriginalHash);
  }
  async function prior(photo: (typeof manifest.photos)[number]) {
    if (!photo.prior) {
      if (photo.command.expected.storageType === "url" && photo.command.expected.url)
        throw new ProductAssetError("CATALOG_PRIOR_IMAGE_REQUIRED", `Save the previous source for photo ${photo.command.assetId} before recovery.`, 409);
      return undefined;
    }
    if (!photo.command.expectedPriorHash || !photo.command.expected.url)
      throw new Error("A prior snapshot requires the exact expected URL and hash.");
    return fileImage(photo.prior.file, photo.prior.mimeType, photo.command.expectedPriorHash);
  }
  // Validate every reviewed file before opening a database connection or writing.
  for (const photo of photos) { await original(photo); await prior(photo); }
  async function checkPrior(photo: (typeof manifest.photos)[number], checkedUrls?: Map<string,string>) {
    if (!photo.prior) return;
    const url = photo.command.expected.url!;
    const key = `${photo.prior.mimeType}\n${url}`;
    let actual = checkedUrls?.get(key);
    if (!actual) {
      actual = inspectCatalogImage(await fetchProductImage(url, undefined, { acceptMimeType: photo.prior.mimeType })).contentHash;
      checkedUrls?.set(key, actual);
    }
    if (actual !== photo.command.expectedPriorHash)
      throw new ProductAssetError("CATALOG_PRIOR_IMAGE_CHANGED", `The current source for photo ${photo.command.assetId} changed after review.`, 409);
  }
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
    const previews = [];
    for (const photo of photos)
      previews.push(await owner.preview(photo.command, await original(photo), await prior(photo)));
    // Check all still-pending URL sources before the first write. Completed
    // replays do not depend on an old external URL remaining available forever.
    const checkedUrls = new Map<string,string>();
    for (const [index, photo] of photos.entries())
      if (previews[index].wouldApply) await checkPrior(photo, checkedUrls);
    if (!values.execute) {
      for (const [index, photo] of photos.entries())
        results.push({assetId:photo.command.assetId,...previews[index]});
    } else {
      const groups = new Map<number, Array<{photo:(typeof manifest.photos)[number];index:number}>>();
      for (const [index, photo] of photos.entries()) {
        const group = groups.get(photo.command.productId) ?? [];
        group.push({photo,index});
        groups.set(photo.command.productId,group);
      }
      for (const group of groups.values()) {
        if (group.length > MAX_RECOVERY_PHOTOS_PER_PRODUCT)
          throw new ProductAssetError("CATALOG_RECOVERY_BATCH_INVALID", "The product has too many photos for one atomic recovery.", 422);
        let fileBytes = 0;
        for (const {photo} of group) {
          fileBytes += (await stat(resolve(directory,photo.file))).size;
          if (photo.prior) fileBytes += (await stat(resolve(directory,photo.prior.file))).size;
        }
        if (fileBytes > MAX_RECOVERY_BATCH_BYTES)
          throw new ProductAssetError("CATALOG_RECOVERY_BATCH_TOO_LARGE", "The reviewed photos exceed the per-product recovery limit.", 413);
        for (const {photo,index} of group)
          if (previews[index].wouldApply) await checkPrior(photo);
        const items = [];
        for (const {photo} of group)
          items.push({command:photo.command,image:await original(photo),priorImage:await prior(photo)});
        results.push(...await owner.replaceBatch(items));
      }
    }
    console.log(
      JSON.stringify({
        mode: values.execute ? "execute" : "preview",
        reviewed: photos.length,
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
        message: error instanceof ProductAssetError ? error.message
          : "Recovery stopped. Committed images remain audited and an unchanged manifest can be replayed safely.",
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
      code: error instanceof ProductAssetError ? error.code : "CATALOG_ORIGINAL_RECOVERY_INVALID",
      message:
        error instanceof ProductAssetError ? error.message : error instanceof z.ZodError
          ? "The reviewed manifest is invalid."
          : "Validate the manifest, files and recovery connection before retrying.",
    }),
  );
  process.exitCode = 1;
});
