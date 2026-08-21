import { readFileSync } from "node:fs";

import type { PoolConfig } from "pg";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const ENHANCED_CERTIFICATE_QUERY_KEYS = new Set(["sslmode", "sslrootcert"]);
const SYSTEM_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const DEFAULT_POSTGRES_PORT = 5_432;

interface ParsedPostgresUrl {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly isLocal: boolean;
  readonly ca: string | undefined;
}

export interface VerifiedPostgresPoolConfigDependencies {
  readonly readTextFile: (path: string) => string;
}

interface PinnedPgPoolConfig extends PoolConfig {
  // pg supports these startup fields at runtime, but @types/pg omits them.
  // Keep the extension explicit and prove it with a real Client construction test.
  readonly client_encoding: "utf8";
  readonly replication: "false";
}

const DEFAULT_DEPENDENCIES: VerifiedPostgresPoolConfigDependencies = Object.freeze({
  readTextFile: (path: string) => readFileSync(path, "utf8"),
});

function decodedUrlComponent(value: string, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch (cause) {
    throw new Error(`PostgreSQL ${field} is not valid percent-encoding`, { cause });
  }
}

function parsedPostgresUrl(
  connectionString: string,
  dependencies: VerifiedPostgresPoolConfigDependencies,
): ParsedPostgresUrl {
  if (connectionString.length === 0 || connectionString.trim() !== connectionString) {
    throw new Error("PostgreSQL connection URL is required without surrounding whitespace");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch (cause) {
    throw new Error("PostgreSQL connection URL is invalid", { cause });
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connection URL must use the postgres protocol");
  }
  if (parsed.hash.length > 0) {
    throw new Error("PostgreSQL connection URL must not contain a fragment");
  }

  const urlHostname = parsed.hostname.toLowerCase();
  const host = urlHostname.startsWith("[") && urlHostname.endsWith("]")
    ? urlHostname.slice(1, -1)
    : urlHostname;
  if (host.length === 0) {
    throw new Error("PostgreSQL connection URL must contain an explicit host");
  }
  const isLocal = LOOPBACK_HOSTNAMES.has(host);
  const user = decodedUrlComponent(parsed.username, "username");
  if (user.length === 0) {
    throw new Error("PostgreSQL connection URL must contain an explicit username");
  }
  const password = decodedUrlComponent(parsed.password, "password");
  if (password.length === 0) {
    throw new Error("PostgreSQL connection URL must contain an explicit password");
  }
  const encodedDatabase = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : "";
  if (encodedDatabase.length === 0 || encodedDatabase.includes("/")) {
    throw new Error("PostgreSQL connection URL must contain one explicit database name");
  }
  const database = decodedUrlComponent(encodedDatabase, "database name");
  if (database.length === 0) {
    throw new Error("PostgreSQL connection URL database name must not be empty");
  }
  const port = parsed.port.length === 0 ? DEFAULT_POSTGRES_PORT : Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PostgreSQL connection URL port is invalid");
  }

  const queryEntries = [...parsed.searchParams.entries()];
  if (queryEntries.length === 0) {
    return Object.freeze({ host, port, user, password, database, isLocal, ca: undefined });
  }
  if (isLocal) {
    throw new Error("Loopback PostgreSQL connection URLs must not contain query parameters");
  }
  if (
    queryEntries.length !== ENHANCED_CERTIFICATE_QUERY_KEYS.size
    || queryEntries.some(([key]) => !ENHANCED_CERTIFICATE_QUERY_KEYS.has(key))
    || [...ENHANCED_CERTIFICATE_QUERY_KEYS].some(
      (key) => parsed.searchParams.getAll(key).length !== 1,
    )
  ) {
    throw new Error(
      "Remote PostgreSQL connection URL query parameters must be the exact enhanced-certificate pair",
    );
  }
  if (parsed.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Remote PostgreSQL sslmode must be verify-full");
  }
  if (parsed.searchParams.get("sslrootcert") !== SYSTEM_CA_BUNDLE_PATH) {
    throw new Error("Remote PostgreSQL sslrootcert must use the approved system CA bundle");
  }

  let ca: string;
  try {
    ca = dependencies.readTextFile(SYSTEM_CA_BUNDLE_PATH);
  } catch (cause) {
    throw new Error("Remote PostgreSQL system CA bundle could not be read", { cause });
  }
  if (ca.trim().length === 0) {
    throw new Error("Remote PostgreSQL system CA bundle must not be empty");
  }

  return Object.freeze({ host, port, user, password, database, isLocal, ca });
}

export function verifiedPostgresPoolConfig(input: {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly max: number;
}, dependencies: VerifiedPostgresPoolConfigDependencies = DEFAULT_DEPENDENCIES): PoolConfig {
  const parsed = parsedPostgresUrl(input.connectionString, dependencies);
  const config: PinnedPgPoolConfig = {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    ssl: parsed.isLocal
      ? false
      : {
          rejectUnauthorized: true,
          servername: parsed.host,
          minVersion: "TLSv1.2",
          ...(parsed.ca === undefined ? {} : { ca: parsed.ca }),
        },
    // These explicit startup values prevent pg from reading PGOPTIONS,
    // PGCLIENTENCODING, PGREPLICATION, or PGCONNECT_TIMEOUT.
    options: "-c client_min_messages=warning",
    client_encoding: "utf8",
    replication: "false",
    connectionTimeoutMillis: 10_000,
    max: input.max,
    application_name: input.applicationName,
  };
  return config;
}
