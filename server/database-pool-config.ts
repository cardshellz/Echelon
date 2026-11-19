import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { PoolConfig } from "pg";

export const DATABASE_SEARCH_PATH = [
  '"$user"',
  "public",
  "catalog",
  "channels",
  "ebay",
  "identity",
  "inventory",
  "notifications",
  "operations",
  "orders",
  "procurement",
  "warehouse",
  "oms",
  "membership",
  "wms",
  "dropship",
] as const;

export const DATABASE_SESSION_OPTIONS =
  `-c search_path=${DATABASE_SEARCH_PATH.join(",")}`;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
let loggedUnverifiedFallbackWarning = false;

export interface PostgresPoolSslDependencies {
  readTextFile?: (filePath: string) => string;
  warn?: (line: string) => void;
}

function parseUrlSafely(connectionString: string | undefined): URL | null {
  if (!connectionString || typeof connectionString !== "string") return null;
  try {
    return new URL(connectionString.trim());
  } catch {
    return null;
  }
}

function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

/**
 * Resolves TLS configuration consistently across all Echelon PostgreSQL pools
 * (`server/db.ts` main + side-channel pools, `server/index.ts` session pool, and
 * `server/infrastructure/scheduler-lock.ts` advisory-lock pool) (`P4.5`).
 *
 * - Loopback hosts default to plaintext (`undefined`) unless `DATABASE_SSL=true`.
 * - Verified TLS (`rejectUnauthorized: true`, `minVersion: "TLSv1.2"`, SNI `servername`)
 *   is enforced whenever a CA bundle (`DATABASE_SSL_CA`, `PGSSLROOTCERT`, or URL
 *   `sslrootcert`), `sslmode=verify-full` / `verify-ca`, or
 *   `DATABASE_SSL_REJECT_UNAUTHORIZED=true` is configured.
 * - Managed cloud URLs without a CA bundle yet fall back to encrypted TLS 1.2+
 *   (`rejectUnauthorized: false`) so Heroku/RDS connections without a configured
 *   root cert do not fail closed at boot, while emitting a single structured warning.
 */
export function resolvePostgresPoolSslConfig(
  connectionString: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: PostgresPoolSslDependencies = {},
): ConnectionOptions | undefined {
  const parsed = parseUrlSafely(connectionString);
  const host = parsed ? normalizeHost(parsed.hostname) : "";
  const isLoopback = host.length > 0 && LOOPBACK_HOSTS.has(host);

  const sslDisabledExplicitly =
    env.DATABASE_SSL === "false" ||
    parsed?.searchParams.get("sslmode") === "disable";
  if (sslDisabledExplicitly) {
    return undefined;
  }

  const sslMode = parsed?.searchParams.get("sslmode")?.toLowerCase() ?? "";
  const sslRootCertPath =
    env.PGSSLROOTCERT?.trim() ||
    parsed?.searchParams.get("sslrootcert")?.trim() ||
    "";
  const inlineCa = env.DATABASE_SSL_CA?.trim()
    ? env.DATABASE_SSL_CA.replace(/\\n/g, "\n")
    : "";

  const shouldUseSsl =
    env.DATABASE_SSL === "true" ||
    Boolean(inlineCa) ||
    Boolean(sslRootCertPath) ||
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full" ||
    (!isLoopback &&
      (Boolean(env.EXTERNAL_DATABASE_URL) ||
        Boolean(connectionString?.includes("amazonaws.com")) ||
        env.NODE_ENV === "production"));

  if (!shouldUseSsl) {
    return undefined;
  }

  const readText = deps.readTextFile ?? ((p: string) => readFileSync(p, "utf8"));
  const ca = inlineCa || (sslRootCertPath ? readText(sslRootCertPath) : undefined);

  const explicitReject = env.DATABASE_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase();
  const verifyCertificate =
    explicitReject === "true"
      ? true
      : explicitReject === "false"
        ? false
        : Boolean(ca) || sslMode === "verify-full" || sslMode === "verify-ca";

  if (verifyCertificate) {
    return {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(host && !isLoopback ? { servername: host } : {}),
      ...(ca ? { ca } : {}),
    };
  }

  if (!loggedUnverifiedFallbackWarning && !env.VITEST) {
    loggedUnverifiedFallbackWarning = true;
    const warn = deps.warn ?? console.warn;
    warn(
      JSON.stringify({
        level: "warn",
        event: "postgres_ssl_unverified_fallback",
        host: host || null,
        hint: "Configure DATABASE_SSL_CA, PGSSLROOTCERT, or DATABASE_SSL_REJECT_UNAUTHORIZED=true for verified PostgreSQL TLS.",
      }),
    );
  }

  return {
    rejectUnauthorized: false,
    minVersion: "TLSv1.2",
  };
}

export function resetPostgresSslWarningForTest(): void {
  loggedUnverifiedFallbackWarning = false;
}

type DatabasePoolConfigInput = Omit<PoolConfig, "options">;

export function createDatabasePoolConfig(
  input: DatabasePoolConfigInput,
): PoolConfig {
  return {
    ...input,
    // Startup options are applied before PostgreSQL marks the connection ready.
    // An async Pool "connect" listener races with the first checked-out query.
    options: DATABASE_SESSION_OPTIONS,
  };
}
