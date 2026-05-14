/**
 * Monitor pick/replen health and optionally notify operators.
 *
 * Dry run:
 *   npx tsx scripts/monitor-pick-replen-health.ts --json
 *
 * Scheduler/production notification:
 *   npx tsx scripts/monitor-pick-replen-health.ts --notify --json
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInt(arg: string, prefix: string): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix.slice(0, -1)} must be a positive integer`);
  }
  return value;
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

  if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) return;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const key of ["EXTERNAL_DATABASE_URL", "DATABASE_URL"]) {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL && !process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("DATABASE_URL or EXTERNAL_DATABASE_URL is required");
  }

  const { sql } = await import("drizzle-orm");
  const { db, pool } = await import("../server/db");
  const { createOperationsDashboardService } = await import("../server/modules/orders/operations-dashboard.service");
  const { notify } = await import("../server/modules/notifications/notifications.service");

  try {
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
          message: "Open Pick/Replen Health to clean stale tasks, duplicates, unresolved shorts, and allocation exceptions.",
          data: {
            counts: health.counts,
            total,
            critical,
            warehouseId: options.warehouseId,
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
      mode: options.notify ? "notify" : "dry-run",
      warehouseId: options.warehouseId,
      threshold: options.threshold,
      total,
      critical,
      counts: health.counts,
      sampleItems: health.items,
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
