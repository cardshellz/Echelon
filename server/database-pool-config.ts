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
