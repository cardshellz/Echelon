/**
 * Read-only readiness audit for Phase 2 fulfillment canonical shadow tables.
 *
 * This script does not backfill or mutate anything. It answers whether legacy
 * WMS shipment rows have enough authority and idempotency data to be projected
 * into the canonical fulfillment model without inventing shipment or line
 * identities.
 *
 * Usage:
 *   npx tsx scripts/audit-fulfillment-canonical-readiness.ts --limit=10
 *   npx tsx scripts/audit-fulfillment-canonical-readiness.ts --check=shipped_missing_physical_identity
 *   npx tsx scripts/audit-fulfillment-canonical-readiness.ts --json --fail-on-issues
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

type Severity = "blocker" | "warning";
type SampleLimit = number | "all";

interface Flags {
  help: boolean;
  json: boolean;
  failOnIssues: boolean;
  sampleLimit: SampleLimit;
  checkId: string | null;
}

export interface CanonicalReadinessCheck {
  id: string;
  severity: Severity;
  description: string;
  canonicalTarget: string;
  sql: string;
}

export interface CanonicalCheckResult {
  check: CanonicalReadinessCheck;
  count: number;
  samples: Record<string, unknown>[];
}

export interface CanonicalAuditSummary {
  checks: number;
  blockers: number;
  warnings: number;
  issueCount: number;
}

export interface CanonicalAuditResult {
  summary: CanonicalAuditSummary;
  results: CanonicalCheckResult[];
}

const ACTIVE_LEGACY_SHIPMENT_FILTER = `
  COALESCE(s.status::text, '') NOT IN ('cancelled', 'voided', 'returned')
`;

const SHIPPED_LEGACY_SHIPMENT_FILTER = `
  s.status::text = 'shipped'
  AND NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL
`;

const SHIPMENT_SAMPLE_COLUMNS = `
  s.id AS legacy_shipment_id,
  o.id AS wms_order_id,
  o.order_number,
  o.source AS wms_order_source,
  o.warehouse_status,
  s.status AS legacy_shipment_status,
  s.shipping_engine,
  s.engine_order_ref,
  s.engine_shipment_ref,
  s.shipstation_order_id,
  s.shipstation_order_key,
  s.external_fulfillment_id,
  s.shopify_fulfillment_id,
  s.tracking_number,
  s.carrier,
  s.shipped_at,
  s.requires_review,
  s.review_reason
`;

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/audit-fulfillment-canonical-readiness.ts [--limit=10]",
    "  npx tsx scripts/audit-fulfillment-canonical-readiness.ts --check=shipped_missing_physical_identity",
    "  npx tsx scripts/audit-fulfillment-canonical-readiness.ts --json --fail-on-issues",
    "",
    "Flags:",
    "  --limit=N          Number of sample rows per failing check. Default 10.",
    "  --limit=all        Print all sample rows for each failing check.",
    "  --check=ID         Run one readiness check by id.",
    "  --json             Print machine-readable JSON.",
    "  --fail-on-issues   Exit 1 when any blocker or warning rows are found.",
  ].join("\n");
}

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const json = argv.includes("--json");
  const failOnIssues = argv.includes("--fail-on-issues");

  const allowedBareFlags = new Set(["--help", "-h", "--json", "--fail-on-issues"]);
  for (const arg of argv) {
    if (allowedBareFlags.has(arg)) continue;
    if (arg.startsWith("--limit=")) continue;
    if (arg.startsWith("--check=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limitValue = limitArg == null ? "10" : limitArg.slice("--limit=".length).trim();
  const sampleLimit: SampleLimit = limitValue === "all" ? "all" : Number(limitValue);
  if (sampleLimit !== "all" && (!Number.isInteger(sampleLimit) || sampleLimit <= 0)) {
    throw new Error("--limit must be a positive integer or all");
  }

  const checkArg = argv.find((arg) => arg.startsWith("--check="));
  const checkId = checkArg == null ? null : checkArg.slice("--check=".length).trim();
  if (checkId !== null && checkId.length === 0) {
    throw new Error("--check cannot be blank");
  }

  return { help, json, failOnIssues, sampleLimit, checkId };
}

export function buildCanonicalReadinessChecks(): CanonicalReadinessCheck[] {
  return [
    {
      id: "shipment_item_missing_authority_line",
      severity: "blocker",
      description: "Every shipment item must point to a WMS item with a live OMS order-line authority reference.",
      canonicalTarget: "wms.fulfillment_plan_lines and wms.shipment_request_items",
      sql: `
        SELECT
          ${SHIPMENT_SAMPLE_COLUMNS},
          si.id AS legacy_shipment_item_id,
          si.order_item_id,
          si.qty AS legacy_shipment_item_qty,
          oi.oms_order_line_id,
          oi.sku AS wms_item_sku
        FROM wms.outbound_shipment_items si
        JOIN wms.outbound_shipments s ON s.id = si.shipment_id
        LEFT JOIN wms.orders o ON o.id = s.order_id
        LEFT JOIN wms.order_items oi ON oi.id = si.order_item_id
        LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
        WHERE ${ACTIVE_LEGACY_SHIPMENT_FILTER}
          AND (
            si.order_item_id IS NULL
            OR oi.id IS NULL
            OR oi.oms_order_line_id IS NULL
            OR ol.id IS NULL
          )
        ORDER BY s.id DESC, si.id DESC
      `,
    },
    {
      id: "shipment_item_order_mismatch",
      severity: "blocker",
      description: "A shipment item cannot reference a WMS item belonging to a different WMS order.",
      canonicalTarget: "wms.shipment_request_items.wms_order_item_id",
      sql: `
        SELECT
          ${SHIPMENT_SAMPLE_COLUMNS},
          si.id AS legacy_shipment_item_id,
          si.order_item_id,
          si.qty AS legacy_shipment_item_qty,
          oi.order_id AS order_item_wms_order_id,
          oi.oms_order_line_id,
          oi.sku AS wms_item_sku
        FROM wms.outbound_shipment_items si
        JOIN wms.outbound_shipments s ON s.id = si.shipment_id
        JOIN wms.orders o ON o.id = s.order_id
        JOIN wms.order_items oi ON oi.id = si.order_item_id
        WHERE ${ACTIVE_LEGACY_SHIPMENT_FILTER}
          AND oi.order_id <> s.order_id
        ORDER BY s.id DESC, si.id DESC
      `,
    },
    {
      id: "nonpositive_shipment_item_quantity",
      severity: "blocker",
      description: "Canonical shipment request and physical shipment item quantities must be positive.",
      canonicalTarget: "wms.shipment_request_items.quantity_requested and wms.physical_shipment_items.quantity_shipped",
      sql: `
        SELECT
          ${SHIPMENT_SAMPLE_COLUMNS},
          si.id AS legacy_shipment_item_id,
          si.order_item_id,
          si.qty AS legacy_shipment_item_qty
        FROM wms.outbound_shipment_items si
        JOIN wms.outbound_shipments s ON s.id = si.shipment_id
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE ${ACTIVE_LEGACY_SHIPMENT_FILTER}
          AND si.qty <= 0
        ORDER BY s.id DESC, si.id DESC
      `,
    },
    {
      id: "duplicate_physical_shipment_identity",
      severity: "blocker",
      description: "The canonical physical shipment idempotency key must be unique by provider and physical shipment id.",
      canonicalTarget: "wms.physical_shipments(provider, provider_physical_shipment_id)",
      sql: `
        WITH shipment_identities AS (
          SELECT
            COALESCE(NULLIF(BTRIM(s.shipping_engine), ''), 'shipstation') AS provider,
            NULLIF(BTRIM(s.external_fulfillment_id), '') AS provider_physical_shipment_id,
            s.id AS legacy_shipment_id,
            o.order_number,
            o.warehouse_status,
            s.status,
            s.tracking_number,
            s.shipped_at
          FROM wms.outbound_shipments s
          LEFT JOIN wms.orders o ON o.id = s.order_id
          WHERE ${ACTIVE_LEGACY_SHIPMENT_FILTER}
            AND NULLIF(BTRIM(s.external_fulfillment_id), '') IS NOT NULL
        )
        SELECT
          provider,
          provider_physical_shipment_id,
          COUNT(*)::int AS duplicate_count,
          ARRAY_AGG(legacy_shipment_id ORDER BY legacy_shipment_id) AS legacy_shipment_ids,
          ARRAY_AGG(order_number ORDER BY legacy_shipment_id) AS order_numbers,
          ARRAY_AGG(warehouse_status ORDER BY legacy_shipment_id) AS warehouse_statuses,
          MIN(shipped_at) AS first_shipped_at,
          MAX(shipped_at) AS last_shipped_at
        FROM shipment_identities
        GROUP BY provider, provider_physical_shipment_id
        HAVING COUNT(*) > 1
        ORDER BY duplicate_count DESC, provider, provider_physical_shipment_id
      `,
    },
    {
      id: "shipped_missing_physical_identity",
      severity: "blocker",
      description: "A shipped legacy row with tracking needs a stable provider physical shipment id before it can become a physical_shipment row.",
      canonicalTarget: "wms.physical_shipments.provider_physical_shipment_id",
      sql: `
        SELECT
          ${SHIPMENT_SAMPLE_COLUMNS}
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE ${SHIPPED_LEGACY_SHIPMENT_FILTER}
          AND NULLIF(BTRIM(COALESCE(s.external_fulfillment_id, '')), '') IS NULL
          AND COALESCE(s.requires_review, false) = false
          AND NOT EXISTS (
            SELECT 1
            FROM wms.outbound_shipments sibling
            WHERE sibling.id <> s.id
              AND sibling.shipstation_order_id IS NOT NULL
              AND sibling.shipstation_order_id = s.shipstation_order_id
              AND NULLIF(BTRIM(COALESCE(sibling.tracking_number, '')), '') =
                NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '')
              AND NULLIF(BTRIM(COALESCE(sibling.external_fulfillment_id, '')), '') IS NOT NULL
          )
        ORDER BY s.shipped_at DESC NULLS LAST, s.id DESC
      `,
    },
    {
      id: "shipped_physical_identity_review_exception",
      severity: "warning",
      description: "A shipped legacy row still lacks a provider physical shipment id, but is explicitly classified for review instead of deterministic canonical backfill.",
      canonicalTarget: "wms.physical_shipments review exception",
      sql: `
        SELECT
          ${SHIPMENT_SAMPLE_COLUMNS}
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE ${SHIPPED_LEGACY_SHIPMENT_FILTER}
          AND NULLIF(BTRIM(COALESCE(s.external_fulfillment_id, '')), '') IS NULL
          AND COALESCE(s.requires_review, false) = true
        ORDER BY s.shipped_at DESC NULLS LAST, s.id DESC
      `,
    },
    {
      id: "provider_order_identity_collision",
      severity: "warning",
      description: "Multiple legacy shipment rows share one shipping-engine order identity; backfill must collapse these into one shipping_engine_orders row and separate physical shipments.",
      canonicalTarget: "wms.shipping_engine_orders and wms.physical_shipments",
      sql: `
        WITH engine_identities AS (
          SELECT
            COALESCE(NULLIF(BTRIM(s.shipping_engine), ''), 'shipstation') AS provider,
            COALESCE(
              NULLIF(BTRIM(s.engine_order_ref), ''),
              NULLIF(s.shipstation_order_id::text, ''),
              NULLIF(BTRIM(s.shipstation_order_key), '')
            ) AS provider_order_ref,
            s.id AS legacy_shipment_id,
            o.order_number,
            o.warehouse_status,
            s.status,
            s.external_fulfillment_id,
            s.tracking_number,
            s.shipped_at
          FROM wms.outbound_shipments s
          LEFT JOIN wms.orders o ON o.id = s.order_id
          WHERE ${ACTIVE_LEGACY_SHIPMENT_FILTER}
        )
        SELECT
          provider,
          provider_order_ref,
          COUNT(*)::int AS legacy_row_count,
          ARRAY_AGG(legacy_shipment_id ORDER BY legacy_shipment_id) AS legacy_shipment_ids,
          ARRAY_AGG(order_number ORDER BY legacy_shipment_id) AS order_numbers,
          ARRAY_AGG(warehouse_status ORDER BY legacy_shipment_id) AS warehouse_statuses,
          COUNT(*) FILTER (WHERE status = 'shipped')::int AS shipped_row_count,
          COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(external_fulfillment_id, '')), '') IS NOT NULL)::int AS rows_with_physical_identity
        FROM engine_identities
        WHERE provider_order_ref IS NOT NULL
        GROUP BY provider, provider_order_ref
        HAVING COUNT(*) > 1
        ORDER BY legacy_row_count DESC, provider, provider_order_ref
      `,
    },
    {
      id: "shopify_shipped_without_channel_fulfillment_id",
      severity: "warning",
      description: "Shopify-origin shipped rows with tracking but no Shopify fulfillment id still need channel-push repair after physical shipment backfill.",
      canonicalTarget: "oms.channel_fulfillment_pushes.channel_fulfillment_id",
      sql: `
        SELECT
          ${SHIPMENT_SAMPLE_COLUMNS}
        FROM wms.outbound_shipments s
        JOIN wms.orders o ON o.id = s.order_id
        WHERE ${SHIPPED_LEGACY_SHIPMENT_FILTER}
          AND o.source IN ('oms', 'shopify')
          AND COALESCE(o.order_number, '') LIKE '#%'
          AND NULLIF(BTRIM(COALESCE(s.shopify_fulfillment_id, '')), '') IS NULL
        ORDER BY s.shipped_at DESC NULLS LAST, s.id DESC
      `,
    },
  ];
}

function loadDotenvIfAvailable(): void {
  if (process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt);
    if (process.env[key]) continue;
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function connectionStringFromEnv(): string {
  loadDotenvIfAvailable();
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
  }
  return connectionString;
}

function normalizeSql(sqlText: string): string {
  return sqlText.trim().replace(/;+\s*$/, "");
}

async function runCheck(
  pool: Pool,
  check: CanonicalReadinessCheck,
  sampleLimit: SampleLimit,
): Promise<CanonicalCheckResult> {
  const baseSql = normalizeSql(check.sql);
  const countResult = await pool.query(`SELECT COUNT(*)::int AS issue_count FROM (${baseSql}) canonical_issue`);
  const rawCount = countResult.rows[0]?.issue_count;
  const count = Number(rawCount);
  if (!Number.isInteger(count)) {
    throw new Error(`Canonical readiness check ${check.id} returned a non-integer count: ${rawCount}`);
  }

  const sampleSql = sampleLimit === "all"
    ? `SELECT * FROM (${baseSql}) canonical_issue`
    : `SELECT * FROM (${baseSql}) canonical_issue LIMIT $1`;
  const sampleParams = sampleLimit === "all" ? [] : [sampleLimit];
  const sampleResult = count > 0 ? await pool.query(sampleSql, sampleParams) : { rows: [] };

  return {
    check,
    count,
    samples: sampleResult.rows,
  };
}

export function summarizeCanonicalResults(results: CanonicalCheckResult[]): CanonicalAuditSummary {
  const blockers = results
    .filter((result) => result.check.severity === "blocker")
    .reduce((total, result) => total + result.count, 0);
  const warnings = results
    .filter((result) => result.check.severity === "warning")
    .reduce((total, result) => total + result.count, 0);

  return {
    checks: results.length,
    blockers,
    warnings,
    issueCount: blockers + warnings,
  };
}

export async function runCanonicalAudit(flags: Flags): Promise<CanonicalAuditResult> {
  let checks = buildCanonicalReadinessChecks();
  if (flags.checkId !== null) {
    checks = checks.filter((check) => check.id === flags.checkId);
    if (checks.length === 0) {
      throw new Error(`Unknown readiness check id: ${flags.checkId}`);
    }
  }

  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  try {
    const results: CanonicalCheckResult[] = [];
    for (const check of checks) {
      results.push(await runCheck(pool, check, flags.sampleLimit));
    }
    return { summary: summarizeCanonicalResults(results), results };
  } finally {
    await pool.end();
  }
}

function printTextResult(result: CanonicalAuditResult, sampleLimit: SampleLimit): void {
  console.log(
    `[Fulfillment canonical readiness] checks=${result.summary.checks} sampleLimit=${sampleLimit}`,
  );

  for (const checkResult of result.results) {
    const { check, count, samples } = checkResult;
    console.log(
      `[${check.severity.toUpperCase()}] ${check.id}: count=${count} target="${check.canonicalTarget}"`,
    );
    console.log(`  ${check.description}`);
    for (const sample of samples) {
      console.log(`  sample ${JSON.stringify(sample)}`);
    }
  }

  console.log(JSON.stringify(result.summary));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const result = await runCanonicalAudit(flags);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result, flags.sampleLimit);
  }

  if (flags.failOnIssues && result.summary.issueCount > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("[Fulfillment canonical readiness] fatal:", error);
    process.exit(1);
  });
}
