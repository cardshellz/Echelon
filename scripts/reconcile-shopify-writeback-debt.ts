import { pathToFileURL } from "node:url";

/**
 * Reconcile dead internal Shopify fulfillment writeback retries against
 * canonical package evidence.
 *
 * Dry-run is the default. It reads Shopify fulfillment evidence but never writes the database.
 * Execute requires an exact candidate count plus operator/reason attribution.
 */

import {
  ShopifyFulfillmentSnapshotReader,
  type ShopifyFulfillmentSnapshot,
} from "../server/modules/oms/shopify-fulfillment-snapshot";
import {
  findShopifyWritebackDebtOrders,
  resolveShopifyWritebackDebtForOrder,
  type ShopifyWritebackDebtOrder,
} from "../server/modules/oms/shopify-writeback-debt.service";

type Mode = "dry-run" | "execute";

export interface Flags {
  readonly help: boolean;
  readonly mode: Mode;
  readonly limit: number;
  readonly confirmCount: number | null;
  readonly operator: string | null;
  readonly reason: string | null;
  readonly json: boolean;
}

export interface ReconcileSummary {
  readonly mode: Mode;
  readonly candidates: number;
  readonly providerSnapshotsComplete: number;
  readonly ordersResolved: number;
  readonly retryRowsResolved: number;
  readonly inboxRowsResolved: number;
  readonly reviewMarkersCleared: number;
  readonly unresolvedShipments: number;
  readonly failed: number;
  readonly failures: readonly Readonly<Record<string, unknown>>[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function textFlag(argv: readonly string[], prefix: string): string | null {
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = raw.slice(prefix.length).trim();
  if (!value) throw new Error(`${prefix.slice(0, -1)} cannot be blank`);
  if (value.length > 200) throw new Error(`${prefix.slice(0, -1)} cannot exceed 200 characters`);
  return value;
}

export function parseFlags(argv: readonly string[]): Flags {
  const known = /^(--help|-h|--dry-run|--execute|--json|--limit=|--confirm-count=|--operator=|--reason=)/;
  const unknown = argv.find((arg) => !known.test(arg));
  if (unknown) throw new Error(`Unknown flag: ${unknown}`);

  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) throw new Error("Cannot pass both --execute and --dry-run");

  const limitText = textFlag(argv, "--limit=");
  const limit = limitText ? parsePositiveInteger(limitText, "--limit") : DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) throw new Error(`--limit cannot exceed ${MAX_LIMIT}`);

  const confirmText = textFlag(argv, "--confirm-count=");
  const confirmCount = confirmText
    ? parsePositiveInteger(confirmText, "--confirm-count")
    : null;
  const operator = textFlag(argv, "--operator=");
  const reason = textFlag(argv, "--reason=");

  if (execute && confirmCount === null) {
    throw new Error("--execute requires --confirm-count from the immediately preceding dry-run");
  }
  if (execute && !operator) throw new Error("--execute requires --operator");
  if (execute && !reason) throw new Error("--execute requires --reason");

  return Object.freeze({
    help: argv.includes("--help") || argv.includes("-h"),
    mode: execute ? "execute" : "dry-run",
    limit,
    confirmCount,
    operator,
    reason,
    json: argv.includes("--json"),
  });
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/reconcile-shopify-writeback-debt.ts --dry-run --limit=100",
    "  npx tsx scripts/reconcile-shopify-writeback-debt.ts --execute --limit=100 --confirm-count=N --operator=EMAIL --reason=TEXT",
    "",
    "Flags:",
    "  --dry-run          Read Shopify evidence and evaluate without database writes. Default.",
    "  --execute          Read Shopify packages, prove coverage, and close proven debt.",
    "  --limit=N          Maximum candidate orders, 1-500. Default 100.",
    "  --confirm-count=N  Exact candidate count from the preceding dry-run.",
    "  --operator=TEXT    Required execution attribution.",
    "  --reason=TEXT      Required execution reason.",
    "  --json             Print only the final machine-readable summary.",
  ].join("\n");
}

function logPlan(flags: Flags, order: ShopifyWritebackDebtOrder, result: {
  candidateShipmentCount: number;
  resolvedRetryIds: readonly number[];
  unresolved: readonly { shipmentId: number; reason: string }[];
}): void {
  if (flags.json) return;
  console.log(
    `[Shopify writeback debt] ${flags.mode === "execute" ? "RESULT" : "PLAN"}`
      + ` oms=${order.id}`
      + ` order=${order.external_order_number ?? order.external_order_id}`
      + ` deadRetries=${order.dead_retry_count}`
      + ` shipments=${result.candidateShipmentCount}`
      + ` currentlyProvenRetries=${result.resolvedRetryIds.length}`
      + ` unresolved=${JSON.stringify(result.unresolved)}`,
  );
}

export async function runReconciliation(
  flags: Flags,
  dependencies: {
    readonly loadCandidates: (limit: number) => Promise<ShopifyWritebackDebtOrder[]>;
    readonly fetchSnapshot: (
      order: ShopifyWritebackDebtOrder,
    ) => Promise<ShopifyFulfillmentSnapshot>;
    readonly evaluateOrder: (
      order: ShopifyWritebackDebtOrder,
      snapshot: ShopifyFulfillmentSnapshot,
    ) => Promise<Awaited<ReturnType<typeof resolveShopifyWritebackDebtForOrder>>>;
    readonly resolveOrder: (
      order: ShopifyWritebackDebtOrder,
      source: string,
      snapshot: ShopifyFulfillmentSnapshot,
    ) => Promise<Awaited<ReturnType<typeof resolveShopifyWritebackDebtForOrder>>>;
  },
): Promise<ReconcileSummary> {
  const candidates = await dependencies.loadCandidates(flags.limit);
  if (flags.mode === "execute" && flags.confirmCount !== candidates.length) {
    throw new Error(
      `--confirm-count=${flags.confirmCount} does not match selected candidate count ${candidates.length}`,
    );
  }

  let providerSnapshotsComplete = 0;
  let ordersResolved = 0;
  let retryRowsResolved = 0;
  let inboxRowsResolved = 0;
  let reviewMarkersCleared = 0;
  let unresolvedShipments = 0;
  let failed = 0;
  const failures: Readonly<Record<string, unknown>>[] = [];

  for (const order of candidates) {
    try {
      const snapshot = await dependencies.fetchSnapshot(order);
      if (!snapshot.complete) {
        unresolvedShipments++;
        const failure = Object.freeze({
          omsOrderId: order.id,
          orderNumber: order.external_order_number,
          code: "SHOPIFY_FULFILLMENT_SNAPSHOT_INCOMPLETE",
          incompleteReasons: snapshot.incompleteReasons,
        });
        failures.push(failure);
        if (!flags.json) console.warn(`[Shopify writeback debt] REVIEW ${JSON.stringify(failure)}`);
        continue;
      }
      providerSnapshotsComplete++;

      if (flags.mode === "dry-run") {
        const result = await dependencies.evaluateOrder(order, snapshot);
        unresolvedShipments += result.unresolved.length;
        logPlan(flags, order, result);
        continue;
      }

      const source = [
        "script:shopify-writeback-debt",
        flags.operator,
        flags.reason,
      ].join(":");
      const result = await dependencies.resolveOrder(order, source, snapshot);
      retryRowsResolved += result.retryRowsResolved;
      inboxRowsResolved += result.inboxRowsResolved;
      reviewMarkersCleared += result.reviewMarkersCleared;
      unresolvedShipments += result.unresolved.length;
      if (result.retryRowsResolved > 0) ordersResolved++;
      logPlan(flags, order, result);
    } catch (error) {
      failed++;
      const record = error as { code?: unknown };
      const failure = Object.freeze({
        omsOrderId: order.id,
        orderNumber: order.external_order_number,
        code: typeof record?.code === "string" ? record.code : null,
        message: error instanceof Error ? error.message : String(error),
      });
      failures.push(failure);
      if (!flags.json) console.error(`[Shopify writeback debt] ERROR ${JSON.stringify(failure)}`);
    }
  }

  return Object.freeze({
    mode: flags.mode,
    candidates: candidates.length,
    providerSnapshotsComplete,
    ordersResolved,
    retryRowsResolved,
    inboxRowsResolved,
    reviewMarkersCleared,
    unresolvedShipments,
    failed,
    failures: Object.freeze(failures),
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const { db, pool } = await import("../server/db");
  try {
    const snapshotReader = new ShopifyFulfillmentSnapshotReader();
    const summary = await runReconciliation(flags, {
      loadCandidates: (limit) => findShopifyWritebackDebtOrders(
        db,
        limit,
        { includeDeferred: true },
      ),
      fetchSnapshot: (order) => snapshotReader.fetch(order),
      evaluateOrder: (order, snapshot) => resolveShopifyWritebackDebtForOrder(db, {
        omsOrderId: order.id,
        mode: "full_snapshot",
        source: "script:shopify-writeback-debt:dry-run",
        execute: false,
        providerSnapshot: snapshot,
      }),
      resolveOrder: (order, source, snapshot) => resolveShopifyWritebackDebtForOrder(db, {
        omsOrderId: order.id,
        mode: "full_snapshot",
        source,
        providerSnapshot: snapshot,
      }),
    });
    console.log(JSON.stringify(summary));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      `[Shopify writeback debt] fatal: ${error instanceof Error ? error.stack : String(error)}`,
    );
    process.exitCode = 1;
  });
}
