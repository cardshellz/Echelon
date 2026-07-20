import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!.includes("amazonaws.com") && !process.env.DATABASE_URL!.includes("sslmode=")
      ? `${process.env.DATABASE_URL}?sslmode=require`
      : process.env.DATABASE_URL!,
    ssl: process.env.DATABASE_URL!.includes("amazonaws.com") ? true : false,
  },
  // SAFEGUARD: drizzle-kit must never manage the `membership` schema. It is
  // owned by shellz-club-app (same shared Postgres); Echelon's Drizzle
  // definitions for membership.* (shared/schema/membership.schema.ts) are
  // deliberately PARTIAL read-stubs — membership.plans alone omits ~60 real
  // columns, including plans.tier_level, whose boot-time drop caused the
  // 2026-06 incident (see DB-ROLE-SEPARATION-RUNBOOK.md) and which went
  // missing again on 2026-07-07. An unfiltered `drizzle-kit push` diffs prod
  // against those stubs and offers to DROP every column it doesn't know.
  // This list is every Echelon-owned schema; add new schemas here, never
  // `membership`.
  schemaFilter: [
    "public",
    "wms",
    "oms",
    "inventory",
    "catalog",
    "procurement",
    "channels",
    "warehouse",
    "dropship",
    "ebay",
    "identity",
    "shipping",
    "shopify",
  ],
});
