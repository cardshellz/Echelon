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
    ssl: process.env.DATABASE_URL!.includes("amazonaws.com") || process.env.EXTERNAL_DATABASE_URL ? true : false,
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
    "marketplace",
    "notifications",
    "operations",
    "returns",
  ],
  // SAFEGUARD (`P4.1` / `DB-ROLE-SEPARATION-RUNBOOK.md` §2b):
  // `drizzle-kit` evaluates `tablesFilter` via `Minimatch` against BARE table names
  // (without schema qualification) during DB introspection (`pgPushIntrospect`),
  // while serializing all tables exported by `shared/schema.ts`.
  //
  // Therefore:
  // 1. Exclude every `shellz-club-app`-owned, Echelon SQL-managed (`_migrations`,
  //    `scheduler_runs`), and retired pre-schema-split `public.*` table that is
  //    NOT declared in `shared/schema.ts` AND whose bare name does not collide with
  //    a canonical Echelon schema table — preventing `drizzle-kit push` from ever
  //    offering to `DROP TABLE` on shared or SQL-managed `public.*` tables.
  // 2. Never add bare-name exclusions that collide with canonical Echelon tables in
  //    non-`public` schemas (`app_settings` -> `warehouse.app_settings`,
  //    `shopify_collections` -> `shopify.shopify_collections`, `channels` ->
  //    `channels.channels`, `users` -> `identity.users`, etc.) or `public.*`
  //    read-stubs declared in `shared/schema.ts` (`shopify_variants`,
  //    `auto_draft_runs`, `reorder_exclusion_rules`).
  tablesFilter: [
    // Echelon SQL-managed `public.*` infrastructure tables (not in shared/schema.ts)
    "!_migrations",
    "!scheduler_runs",
    // shellz-club-app owned `public.*` tables (non-colliding bare names)
    "!__cardshellz_manual_migrations",
    "!__drizzle_migrations",
    "!background_jobs",
    "!discounts",
    "!pricing_rules",
    "!shopify_order_items",
    "!shopify_orders",
    "!shopify_products",
    // Retired pre-schema-split `public.*` shadow tables (non-colliding bare names)
    "!catalog_assets",
    "!catalog_products",
    "!dropship_vendor_products",
    "!inventory_items",
    "!startup_inventory_anomalies",
    "!uom_variants",
  ],
});
