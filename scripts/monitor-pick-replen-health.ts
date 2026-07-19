/**
 * Monitor pick/replen health and optionally notify operators.
 *
 * Dry run:
 *   npx tsx scripts/monitor-pick-replen-health.ts --json
 *
 * Scheduler/production notification:
 *   npx tsx scripts/monitor-pick-replen-health.ts --notify --json
 *
 * Scheduler with system-owned pick-bin replen queueing:
 *   npx tsx scripts/monitor-pick-replen-health.ts --notify --queueMissingReplen --json
 *
 * Scheduler with all system-owned replen recovery:
 *   npx tsx scripts/monitor-pick-replen-health.ts --notify --recoverInlineReplen --queueMissingReplen --json
 */

import fs from "node:fs";
import path from "node:path";

type CliOptions = {
  notify: boolean;
  force: boolean;
  json: boolean;
  warehouseId: number | null;
  threshold: number;
  sampleLimit: number;
  dedupeHours: number;
  recoverInlineReplen: boolean;
  recoveryLimit: number;
  queueMissingReplen: boolean;
  queueLimit: number;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    notify: false,
    force: false,
    json: false,
    warehouseId: null,
    threshold: 1,
    sampleLimit: 10,
    dedupeHours: 2,
    recoverInlineReplen: false,
    recoveryLimit: 25,
    queueMissingReplen: false,
    queueLimit: 25,
  };

  for (const arg of args) {
    if (arg === "--notify") {
      options.notify = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--warehouseId=")) {
      options.warehouseId = parsePositiveInt(arg, "--warehouseId=");
    } else if (arg.startsWith("--threshold=")) {
      options.threshold = parsePositiveInt(arg, "--threshold=");
    } else if (arg.startsWith("--sampleLimit=")) {
      options.sampleLimit = parsePositiveInt(arg, "--sampleLimit=");
    } else if (arg.startsWith("--dedupeHours=")) {
      options.dedupeHours = parsePositiveInt(arg, "--dedupeHours=");
    } else if (arg === "--recoverInlineReplen") {
      options.recoverInlineReplen = true;
    } else if (arg.startsWith("--recoveryLimit=")) {
      options.recoveryLimit = parsePositiveInt(arg, "--recoveryLimit=");
    } else if (arg === "--queueMissingReplen") {
      options.queueMissingReplen = true;
    } else if (arg.startsWith("--queueLimit=")) {
      options.queueLimit = parsePositiveInt(arg, "--queueLimit=");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  applyNpmConfigDefaults(options);

  return options;
}

function parsePositiveInt(arg: string, prefix: string): number {
  const value = Number(arg.slice(prefix.length));
  return parsePositiveIntValue(value, prefix.slice(0, -1));
}

function parsePositiveIntValue(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseBooleanValue(rawValue: string | undefined, label: string): boolean | null {
  if (rawValue === undefined) return null;
  const raw = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${label} must be true or false`);
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function applyNpmConfigDefaults(options: CliOptions): void {
  const notify = parseBooleanValue(firstEnv("npm_config_notify"), "--notify");
  if (notify !== null) options.notify = notify;

  const force = parseBooleanValue(firstEnv("npm_config_force"), "--force");
  if (force !== null) options.force = force;

  const json = parseBooleanValue(firstEnv("npm_config_json"), "--json");
  if (json !== null) options.json = json;

  const queueMissing = parseBooleanValue(
    firstEnv("npm_config_queuemissingreplen", "npm_config_queue_missing_replen"),
    "--queueMissingReplen",
  );
  if (queueMissing !== null) options.queueMissingReplen = queueMissing;

  const recoverInline = parseBooleanValue(
    firstEnv("npm_config_recoverinlinereplen", "npm_config_recover_inline_replen"),
    "--recoverInlineReplen",
  );
  if (recoverInline !== null) options.recoverInlineReplen = recoverInline;

  const warehouseId = firstEnv("npm_config_warehouseid", "npm_config_warehouse_id");
  if (warehouseId !== undefined && options.warehouseId === null) {
    options.warehouseId = parsePositiveIntValue(Number(warehouseId), "--warehouseId");
  }

  const threshold = firstEnv("npm_config_threshold");
  if (threshold !== undefined) {
    options.threshold = parsePositiveIntValue(Number(threshold), "--threshold");
  }

  const sampleLimit = firstEnv("npm_config_samplelimit", "npm_config_sample_limit");
  if (sampleLimit !== undefined) {
    options.sampleLimit = parsePositiveIntValue(Number(sampleLimit), "--sampleLimit");
  }

  const dedupeHours = firstEnv("npm_config_dedupehours", "npm_config_dedupe_hours");
  if (dedupeHours !== undefined) {
    options.dedupeHours = parsePositiveIntValue(Number(dedupeHours), "--dedupeHours");
  }

  const queueLimit = firstEnv("npm_config_queuelimit", "npm_config_queue_limit");
  if (queueLimit !== undefined) {
    options.queueLimit = parsePositiveIntValue(Number(queueLimit), "--queueLimit");
  }

  const recoveryLimit = firstEnv("npm_config_recoverylimit", "npm_config_recovery_limit");
  if (recoveryLimit !== undefined) {
    options.recoveryLimit = parsePositiveIntValue(Number(recoveryLimit), "--recoveryLimit");
  }
}

async function loadDotenvIfAvailable(): Promise<void> {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("dotenv")) {
      throw error;
    }
  }

  if (process.env.DATABASE_URL) return;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const key of ["DATABASE_URL"]) {
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
    if (!line) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    break;
  }
}

function totalCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function criticalCount(counts: Record<string, number>): number {
  return [
    "stuck_replen",
    "short_pick_unresolved",
    "open_allocation_exception",
    "exception_order_no_blocker",
    "inventory_at_invalid_location",
    "invalid_pick_assignment",
  ].reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
}

function hasSystemActions(options: CliOptions): boolean {
  return options.recoverInlineReplen || options.queueMissingReplen;
}

function outputMode(options: CliOptions): "read-only" | "notify" | "system-actions" | "notify-system-actions" {
  if (options.notify && hasSystemActions(options)) return "notify-system-actions";
  if (options.notify) return "notify";
  if (hasSystemActions(options)) return "system-actions";
  return "read-only";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const { sql } = await import("drizzle-orm");
  const { db, pool } = await import("../server/db");
  const { createOperationsDashboardService } = await import("../server/modules/orders/operations-dashboard.service");
  const { notify } = await import("../server/modules/notifications/notifications.service");

  try {
    let replenishment: any = null;
    const getReplenishment = async () => {
      if (replenishment) return replenishment;
      const {
        InventoryUseCases,
        inventoryStorage,
        createInventoryLotService,
        createCOGSService,
        createReplenishmentService,
      } = await import("../server/modules/inventory");

      const inventoryLots = createInventoryLotService(db);
      const cogs = createCOGSService(db);
      const inventoryCore = new InventoryUseCases(db, inventoryStorage, inventoryLots, cogs);
      replenishment = createReplenishmentService(db, inventoryCore);
      return replenishment;
    };

    let inlineReplenRecovery: any = null;
    if (options.recoverInlineReplen) {
      const replen = await getReplenishment();
      inlineReplenRecovery = await replen.cleanupHealthIssues({
        mode: "inline_execution",
        warehouseId: options.warehouseId,
        limit: options.recoveryLimit,
        userId: "system:health-monitor",
      });
    }

    let missingReplenQueue: any = null;
    if (options.queueMissingReplen) {
      const replen = await getReplenishment();
      missingReplenQueue = await replen.queueMissingPickBinReplen({
        mode: "queue_missing_replen",
        warehouseId: options.warehouseId,
        limit: options.queueLimit,
      });
    }

    const operationsDashboard = createOperationsDashboardService(db);
    const health = await operationsDashboard.getPickReplenHealth({
      warehouseId: options.warehouseId,
      page: 1,
      pageSize: options.sampleLimit,
    });

    const total = totalCount(health.counts);
    const critical = criticalCount(health.counts);
    let notificationSent = false;
    let notificationSuppressed = false;

    if (options.notify && total >= options.threshold) {
      if (!options.force) {
        const recent = await db.execute(sql`
          SELECT 1
          FROM notifications n
          JOIN notification_types nt ON nt.id = n.notification_type_id
          WHERE nt.key = 'pick_replen_health_attention'
            AND n.created_at > NOW() - make_interval(hours => ${options.dedupeHours})
          LIMIT 1
        `);
        notificationSuppressed = recent.rows.length > 0;
      }

      if (!notificationSuppressed) {
        await notify("pick_replen_health_attention", {
          title: critical > 0
            ? `Pick/Replen health has ${critical} critical item${critical === 1 ? "" : "s"}`
            : `Pick/Replen health has ${total} item${total === 1 ? "" : "s"}`,
          message: hasSystemActions(options)
            ? "System replen recovery ran first. Open Pick/Replen Health for remaining manual replen, QA counts, stale tasks, duplicates, unresolved shorts, and allocation exceptions."
            : "Open Pick/Replen Health to clean stale tasks, duplicates, unresolved shorts, and allocation exceptions.",
          data: {
            counts: health.counts,
            total,
            critical,
            warehouseId: options.warehouseId,
            inlineReplenRecovery,
            missingReplenQueue,
            sampleItems: health.items.map((item) => ({
              id: item.id,
              type: item.type,
              priority: item.priority,
              taskId: item.taskId,
              exceptionId: item.exceptionId,
              cycleCountId: item.cycleCountId,
              orderId: item.orderId,
              orderNumber: item.orderNumber,
              sku: item.sku,
              locationCode: item.locationCode,
              action: item.action,
            })),
            url: "/operations",
          },
        });
        notificationSent = true;
      }
    }

    const output = {
      mode: outputMode(options),
      readOnly: !hasSystemActions(options),
      warehouseId: options.warehouseId,
      threshold: options.threshold,
      total,
      critical,
      counts: health.counts,
      sampleItems: health.items,
      systemActions: {
        inlineReplenRecovery,
        missingReplenQueue,
      },
      inlineReplenRecovery,
      missingReplenQueue,
      notificationSent,
      notificationSuppressed,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(
        `Pick/Replen health: total=${total}, critical=${critical}, notificationSent=${notificationSent}, suppressed=${notificationSuppressed}`,
      );
      for (const item of health.items) {
        console.log(`- ${item.type}: ${item.sku ?? item.orderNumber ?? item.id} ${item.detail ?? ""}`.trim());
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
