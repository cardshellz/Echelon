/**
 * Classify shipped legacy WMS shipment rows that still cannot be projected into
 * canonical physical shipments without inventing provider physical ids.
 *
 * This script is intentionally conservative:
 * - dry-run by default
 * - only touches shipped rows with tracking and no external_fulfillment_id
 * - never overwrites an existing requires_review classification
 * - records immutable before/after snapshots in
 *   wms.oms_wms_authority_cleanup_audit before each execute update
 *
 * Usage:
 *   npx tsx scripts/classify-physical-identity-review-exceptions.ts --dry-run --limit=25
 *   npx tsx scripts/classify-physical-identity-review-exceptions.ts --execute --limit=all
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

type Mode = "dry-run" | "execute";

interface Flags {
  mode: Mode;
  help: boolean;
  limit: number | null;
  operator: string;
}

interface ReviewCandidate {
  sourceId: number;
  reviewReason: string;
  beforeRow: Record<string, unknown>;
  afterRow: Record<string, unknown>;
  summary: Record<string, unknown>;
}

interface ClassificationSummary {
  runId: string;
  mode: Mode;
  candidates: number;
  classified: number;
  byReason: Record<string, number>;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_OPERATOR = "script:classify-physical-identity-review-exceptions";
const OPERATION = "physical-identity-review-exception";
const SOURCE_TABLE = "wms.outbound_shipments";
const ACTION = "update";

export const TRACKING_COLLISION_REVIEW_REASON = "physical_identity_tracking_collision";
export const NOT_FOUND_REVIEW_REASON = "physical_identity_not_found_after_enrichment";

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const unknown = argv.find((arg) => !(
    arg === "--help" ||
    arg === "-h" ||
    arg === "--execute" ||
    arg === "--dry-run" ||
    arg.startsWith("--limit=") ||
    arg.startsWith("--operator=")
  ));
  if (unknown) {
    throw new Error(`Unknown flag: ${unknown}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = parseLimit(limitArg);

  const operatorArg = argv.find((arg) => arg.startsWith("--operator="));
  const operator = operatorArg == null
    ? DEFAULT_OPERATOR
    : operatorArg.slice("--operator=".length).trim();
  if (operator.length === 0) {
    throw new Error("--operator cannot be blank");
  }

  return {
    mode: execute ? "execute" : "dry-run",
    help,
    limit,
    operator,
  };
}

function parseLimit(limitArg: string | undefined): number | null {
  if (limitArg == null) return DEFAULT_LIMIT;
  const raw = limitArg.slice("--limit=".length).trim().toLowerCase();
  if (raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer or all");
  }
  return parsed;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/classify-physical-identity-review-exceptions.ts --dry-run --limit=25",
    "  npx tsx scripts/classify-physical-identity-review-exceptions.ts --execute --limit=all",
    "",
    "Flags:",
    "  --dry-run          Classify and print planned review exceptions. Default.",
    "  --execute          Stamp review exceptions transactionally with audit snapshots.",
    "  --limit=N|all      Max candidates. Default 100.",
    "  --operator=TEXT    Audit operator label.",
  ].join("\n");
}

function limitClause(limit: number | null): string {
  return limit == null ? "" : `LIMIT ${limit}`;
}

export function physicalIdentityReviewCandidateSql(limit: number | null, forUpdate = false): string {
  return `
    WITH candidates AS (
      SELECT
        s.id::int AS source_id,
        s.order_id,
        o.order_number,
        s.shipstation_order_id,
        s.shipstation_order_key,
        s.tracking_number,
        s.carrier,
        s.shipped_at,
        EXISTS (
          SELECT 1
          FROM wms.outbound_shipments physical_owner
          WHERE physical_owner.id <> s.id
            AND NULLIF(BTRIM(COALESCE(physical_owner.tracking_number, '')), '') =
              NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '')
            AND NULLIF(BTRIM(COALESCE(physical_owner.external_fulfillment_id, '')), '') IS NOT NULL
        ) AS has_existing_physical_id_for_tracking,
        to_jsonb(s) AS before_row
      FROM wms.outbound_shipments s
      JOIN wms.orders o ON o.id = s.order_id
      WHERE s.status::text = 'shipped'
        AND NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL
        AND NULLIF(BTRIM(COALESCE(s.external_fulfillment_id, '')), '') IS NULL
        AND COALESCE(s.requires_review, false) = false
        AND COALESCE(NULLIF(BTRIM(s.shipping_engine), ''), 'shipstation') = 'shipstation'
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
      ${limitClause(limit)}
      ${forUpdate ? "FOR UPDATE OF s" : ""}
    )
    SELECT
      source_id,
      CASE
        WHEN has_existing_physical_id_for_tracking THEN '${TRACKING_COLLISION_REVIEW_REASON}'
        ELSE '${NOT_FOUND_REVIEW_REASON}'
      END AS review_reason,
      before_row,
      before_row || jsonb_build_object(
        'requires_review', true,
        'review_reason', CASE
          WHEN has_existing_physical_id_for_tracking THEN '${TRACKING_COLLISION_REVIEW_REASON}'
          ELSE '${NOT_FOUND_REVIEW_REASON}'
        END
      ) AS after_row,
      jsonb_build_object(
        'wms_order_id', order_id,
        'order_number', order_number,
        'shipstation_order_id', shipstation_order_id,
        'shipstation_order_key', shipstation_order_key,
        'tracking_number', tracking_number,
        'carrier', carrier,
        'shipped_at', shipped_at,
        'has_existing_physical_id_for_tracking', has_existing_physical_id_for_tracking
      ) AS summary
    FROM candidates
    ORDER BY shipped_at DESC NULLS LAST, source_id DESC
  `;
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

function coerceCandidates(rows: any[]): ReviewCandidate[] {
  return rows.map((row) => ({
    sourceId: Number(row.source_id),
    reviewReason: String(row.review_reason),
    beforeRow: row.before_row ?? {},
    afterRow: row.after_row ?? {},
    summary: row.summary ?? {},
  }));
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function fetchCandidates(
  client: PoolClient,
  limit: number | null,
  forUpdate: boolean,
): Promise<ReviewCandidate[]> {
  const result = await client.query(physicalIdentityReviewCandidateSql(limit, forUpdate));
  return coerceCandidates(result.rows);
}

async function insertAuditRow(
  client: PoolClient,
  runId: string,
  candidate: ReviewCandidate,
  operator: string,
): Promise<void> {
  await client.query(`
    INSERT INTO wms.oms_wms_authority_cleanup_audit (
      run_id,
      operation,
      source_table,
      source_id,
      action,
      reason,
      before_row,
      after_row,
      operator
    )
    VALUES (
      $1::uuid,
      $2::text,
      $3::text,
      $4::bigint,
      $5::text,
      $6::text,
      $7::jsonb,
      $8::jsonb,
      $9::text
    )
  `, [
    runId,
    OPERATION,
    SOURCE_TABLE,
    candidate.sourceId,
    ACTION,
    candidate.reviewReason,
    toJson(candidate.beforeRow),
    toJson(candidate.afterRow),
    operator,
  ]);
}

async function classifyCandidate(client: PoolClient, candidate: ReviewCandidate): Promise<boolean> {
  const result = await client.query(`
    UPDATE wms.outbound_shipments
       SET requires_review = true,
           review_reason = $2,
           updated_at = NOW()
     WHERE id = $1
       AND status::text = 'shipped'
       AND NULLIF(BTRIM(COALESCE(tracking_number, '')), '') IS NOT NULL
       AND NULLIF(BTRIM(COALESCE(external_fulfillment_id, '')), '') IS NULL
       AND COALESCE(requires_review, false) = false
     RETURNING id
  `, [candidate.sourceId, candidate.reviewReason]);
  return result.rowCount === 1;
}

function printPlan(candidates: ReviewCandidate[], flags: Flags): void {
  console.log(
    `[Physical identity review classifier] mode=${flags.mode} candidates=${candidates.length} ` +
    `limit=${flags.limit ?? "all"}`,
  );
  for (const candidate of candidates) {
    const summary = candidate.summary;
    console.log(
      `[Physical identity review classifier] PLAN shipment=${candidate.sourceId} ` +
      `order=${String(summary.order_number ?? "unknown")} ` +
      `tracking=${String(summary.tracking_number ?? "unknown")} ` +
      `reason=${candidate.reviewReason}`,
    );
  }
}

function byReason(candidates: ReviewCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.reviewReason] = (counts[candidate.reviewReason] ?? 0) + 1;
  }
  return counts;
}

async function runClassifier(flags: Flags): Promise<ClassificationSummary> {
  const pool = new Pool({
    connectionString: connectionStringFromEnv(),
    ssl: { rejectUnauthorized: false },
  });
  const runId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidates = await fetchCandidates(client, flags.limit, flags.mode === "execute");
    printPlan(candidates, flags);

    let classified = 0;
    if (flags.mode === "execute") {
      for (const candidate of candidates) {
        await insertAuditRow(client, runId, candidate, flags.operator);
        if (await classifyCandidate(client, candidate)) {
          classified += 1;
        }
      }
    }

    await client.query("COMMIT");
    return {
      runId,
      mode: flags.mode,
      candidates: candidates.length,
      classified,
      byReason: byReason(candidates),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const summary = await runClassifier(flags);
  console.log(`[Physical identity review classifier] complete ${JSON.stringify(summary)}`);
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  main().catch((error) => {
    console.error("[Physical identity review classifier] fatal:", error);
    process.exit(1);
  });
}
