/** Bounded, preview-first admin command. Never imported by the app or migrations. */
import { existsSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import { Product102CleanupService } from "../server/modules/catalog/application/product-102-cleanup.service";
import { Product102CleanupError } from "../server/modules/catalog/domain/product-102-cleanup";
import { Product102CleanupRepository } from "../server/modules/catalog/infrastructure/product-102-cleanup.repository";
import { parseProduct102CleanupArguments } from "../server/modules/catalog/interfaces/product-102-cleanup-command";

async function main(): Promise<void> {
  const input = parseProduct102CleanupArguments(process.argv.slice(2));
  const supplied = process.env.ECHELON_PRODUCT_CLEANUP_DATABASE_URL;
  delete process.env.ECHELON_PRODUCT_CLEANUP_DATABASE_URL;
  if (!supplied)
    throw new Product102CleanupError(
      "CLEANUP_CONNECTION_REQUIRED",
      "Provide ECHELON_PRODUCT_CLEANUP_DATABASE_URL explicitly. This command never uses the application's default database.",
    );
  const url = new URL(supplied);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Product102CleanupError(
      "CLEANUP_INVALID_CONNECTION",
      "A PostgreSQL URL is required.",
    );
  const localTest =
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
  if (!localTest) {
    if (
      url.searchParams.has("sslmode") &&
      url.searchParams.get("sslmode") !== "verify-full"
    ) {
      throw new Product102CleanupError(
        "CLEANUP_TLS_REQUIRED",
        "Remote cleanup connections require verified TLS.",
      );
    }
    url.searchParams.delete("ssl");
    url.searchParams.set("sslmode", "verify-full");
    const windowsCa =
      "C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt";
    if (
      process.platform === "win32" &&
      url.searchParams.get("sslrootcert") ===
        "/etc/ssl/certs/ca-certificates.crt" &&
      existsSync(windowsCa)
    ) {
      url.searchParams.set("sslrootcert", windowsCa);
    }
  }
  const readOnly = input.mode !== "execute";
  // Strip supplied startup options so they cannot override read-only preview.
  url.searchParams.delete("options");
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 1,
    ssl: localTest ? undefined : { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
    application_name: "echelon_product102_cleanup",
    options: `-c default_transaction_read_only=${readOnly ? "on" : "off"} -c statement_timeout=30000 -c lock_timeout=2000`,
  });
  try {
    const service = new Product102CleanupService(
      new Product102CleanupRepository(pool),
      () => new Date(),
    );
    if (input.mode === "preview")
      console.log(JSON.stringify(await service.preview(), null, 2));
    else if (input.mode === "verify")
      console.log(JSON.stringify(await service.verify(), null, 2));
    else {
      console.log(
        JSON.stringify({ result: await service.apply(input.command) }, null, 2),
      );
      // A new read-only transaction independently checks the committed receipt.
      console.log(
        JSON.stringify({ verification: await service.verify() }, null, 2),
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Raw driver errors can contain connection details or whole failed records.
  // Keep stderr structured and bounded; exact evidence lives in the receipt.
  const known = error instanceof Product102CleanupError;
  const sqlState =
    !known &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : null;
  console.error(
    JSON.stringify({
      code: known
        ? error.code
        : error instanceof z.ZodError
          ? "CLEANUP_INVALID_INPUT"
          : "CLEANUP_FAILED",
      message: known
        ? error.message
        : "Cleanup did not return a verified successful outcome. If executing, run --verify before retrying the identical command.",
      sqlState,
    }),
  );
  process.exitCode = 1;
});
