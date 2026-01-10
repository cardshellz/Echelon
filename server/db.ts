import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Database connection string must be set. Provide EXTERNAL_DATABASE_URL or DATABASE_URL.",
  );
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.EXTERNAL_DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
