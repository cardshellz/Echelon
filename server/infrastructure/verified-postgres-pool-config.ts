import type { PoolConfig } from "pg";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parsedPostgresUrl(connectionString: string): URL {
  if (connectionString.length === 0 || connectionString.trim() !== connectionString) {
    throw new Error("PostgreSQL connection URL is required without surrounding whitespace");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("PostgreSQL connection URL is invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connection URL must use the postgres protocol");
  }
  if (parsed.search.length > 0) {
    throw new Error("PostgreSQL connection URL must not contain query parameters");
  }
  return parsed;
}

export function verifiedPostgresPoolConfig(input: {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly max: number;
}): PoolConfig {
  const parsed = parsedPostgresUrl(input.connectionString);
  const isLocal = LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  return {
    connectionString: input.connectionString,
    ssl: isLocal ? undefined : { rejectUnauthorized: true },
    max: input.max,
    application_name: input.applicationName,
  };
}
