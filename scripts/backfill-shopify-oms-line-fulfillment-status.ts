/**
 * Backfill OMS line fulfillment status from live Shopify order line data.
 *
 * Defaults to dry-run. This intentionally uses Shopify as the source of truth
 * because historical OMS line fulfillment_status is known to be stale.
 *
 * Usage:
 *   npx tsx scripts/backfill-shopify-oms-line-fulfillment-status.ts --dry-run --order-id=172543
 *   npx tsx scripts/backfill-shopify-oms-line-fulfillment-status.ts --execute --order-id=172543
 *   npx tsx scripts/backfill-shopify-oms-line-fulfillment-status.ts --dry-run --limit=100 --batch-size=25
 */

import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

interface Flags {
  execute: boolean;
  dryRun: boolean;
  limit: number;
  batchSize: number;
  orderId: number | null;
  sleepMs: number;
}

interface CandidateOrder {
  oms_order_id: number;
  external_order_number: string | null;
  external_order_id: string;
}

interface ShopifyLineItem {
  id: number | string;
  quantity: number;
  fulfillable_quantity: number | null;
  fulfillment_status: string | null;
  requires_shipping?: boolean | null;
}

interface ShopifyOrder {
  id: number | string;
  fulfillment_status: string | null;
  line_items: ShopifyLineItem[];
}

interface ShopifyConfig {
  shopDomain: string;
  accessToken: string;
}

interface LinePlan {
  orderId: number;
  lineId: number;
  externalLineItemId: string;
  currentStatus: string | null;
  currentFulfillableQuantity: number | null;
  nextStatus: "fulfilled" | "partial" | "unfulfilled";
  nextFulfillableQuantity: number | null;
}

function parseFlags(argv: string[]): Flags {
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const readInt = (name: string, fallback: number): number => {
    const arg = argv.find((value) => value.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const parsed = Number(arg.slice(name.length + 3));
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return parsed;
  };

  const orderArg = argv.find((value) => value.startsWith("--order-id="));
  const orderId = orderArg ? Number(orderArg.slice("--order-id=".length)) : null;
  if (orderId !== null && (!Number.isInteger(orderId) || orderId <= 0)) {
    throw new Error("--order-id must be a positive integer");
  }

  return {
    execute,
    dryRun: !execute,
    limit: readInt("limit", orderId ? 1 : 100),
    batchSize: Math.min(readInt("batch-size", 25), 50),
    orderId,
    sleepMs: readInt("sleep-ms", 600),
  };
}

function loadDotenvIfAvailable(): void {
  if (
    process.env.DATABASE_URL &&
    process.env.SHOPIFY_SHOP_DOMAIN &&
    process.env.SHOPIFY_ACCESS_TOKEN
  ) {
    return;
  }

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
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeShopifyLineStatus(
  line: ShopifyLineItem,
  orderStatus: string | null,
): "fulfilled" | "partial" | "unfulfilled" {
  const raw = String(line.fulfillment_status ?? "").trim().toLowerCase();
  if (raw === "fulfilled") return "fulfilled";
  if (raw === "partial" || raw === "partially_fulfilled") return "partial";
  if (raw === "unfulfilled") return "unfulfilled";

  const fulfillableQuantity = Number(line.fulfillable_quantity);
  const rawOrderStatus = String(orderStatus ?? "").trim().toLowerCase();
  if (
    rawOrderStatus === "fulfilled" &&
    Number.isFinite(fulfillableQuantity) &&
    fulfillableQuantity <= 0
  ) {
    return "fulfilled";
  }

  return "unfulfilled";
}

function normalizeOrderStatus(status: string | null): "fulfilled" | "partial" | "unfulfilled" {
  const raw = String(status ?? "").trim().toLowerCase();
  if (raw === "fulfilled") return "fulfilled";
  if (raw === "partial" || raw === "partially_fulfilled") return "partial";
  return "unfulfilled";
}

async function resolveShopifyConfig(pool: Pool): Promise<ShopifyConfig> {
  if (process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ACCESS_TOKEN) {
    return {
      shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
      accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    };
  }

  const result = await pool.query<{
    shop_domain: string | null;
    access_token: string | null;
  }>(`
    SELECT cc.shop_domain, cc.access_token
    FROM channels.channel_connections cc
    JOIN channels.channels c ON c.id = cc.channel_id
    WHERE c.provider = 'shopify'
      AND cc.shop_domain IS NOT NULL
      AND cc.access_token IS NOT NULL
    ORDER BY c.is_default DESC, c.priority DESC, cc.id ASC
    LIMIT 1
  `);

  const connection = result.rows[0];
  if (!connection?.shop_domain || !connection.access_token) {
    throw new Error(
      "Shopify credentials are required via env or channels.channel_connections",
    );
  }

  return {
    shopDomain: connection.shop_domain,
    accessToken: connection.access_token,
  };
}

async function fetchShopifyOrders(
  config: ShopifyConfig,
  ids: string[],
): Promise<Map<string, ShopifyOrder>> {
  const store = config.shopDomain.replace(/\.myshopify\.com$/, "");
  const idsParam = ids.join(",");
  const fields = "id,fulfillment_status,line_items";
  const url =
    `https://${store}.myshopify.com/admin/api/2024-01/orders.json` +
    `?ids=${encodeURIComponent(idsParam)}&status=any&fields=${fields}`;

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": config.accessToken,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 429) {
    await sleep(2000);
    return fetchShopifyOrders(config, ids);
  }
  if (!response.ok) {
    throw new Error(`Shopify API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { orders?: ShopifyOrder[] };
  const byId = new Map<string, ShopifyOrder>();
  for (const order of data.orders ?? []) {
    byId.set(String(order.id), order);
  }
  return byId;
}

async function loadCandidates(pool: Pool, flags: Flags): Promise<CandidateOrder[]> {
  const params: unknown[] = [];
  let orderFilter = "";
  if (flags.orderId !== null) {
    params.push(flags.orderId);
    orderFilter = `AND oo.id = $${params.length}`;
  }
  params.push(flags.limit);

  const result = await pool.query<CandidateOrder>(`
    SELECT DISTINCT
      oo.id AS oms_order_id,
      oo.external_order_number,
      oo.external_order_id
    FROM oms.oms_orders oo
    JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
    WHERE oo.fulfillment_status = 'fulfilled'
      AND COALESCE(ol.fulfillment_status, 'unfulfilled') <> 'fulfilled'
      AND oo.external_order_id IS NOT NULL
      ${orderFilter}
    ORDER BY oo.id
    LIMIT $${params.length}
  `, params);

  return result.rows;
}

async function buildLinePlans(
  pool: Pool,
  candidate: CandidateOrder,
  shopifyOrder: ShopifyOrder,
): Promise<LinePlan[]> {
  const localLines = await pool.query<{
    id: number;
    external_line_item_id: string | null;
    fulfillment_status: string | null;
    fulfillable_quantity: number | null;
  }>(`
    SELECT id, external_line_item_id, fulfillment_status, fulfillable_quantity
    FROM oms.oms_order_lines
    WHERE order_id = $1
  `, [candidate.oms_order_id]);

  const localByExternalId = new Map(
    localLines.rows
      .filter((line) => line.external_line_item_id)
      .map((line) => [String(line.external_line_item_id), line]),
  );

  const plans: LinePlan[] = [];
  for (const shopifyLine of shopifyOrder.line_items ?? []) {
    const externalLineItemId = String(shopifyLine.id);
    const local = localByExternalId.get(externalLineItemId);
    if (!local) continue;

    const nextStatus = normalizeShopifyLineStatus(
      shopifyLine,
      shopifyOrder.fulfillment_status,
    );
    const parsedFulfillable = Number(shopifyLine.fulfillable_quantity);
    const nextFulfillableQuantity = Number.isFinite(parsedFulfillable)
      ? parsedFulfillable
      : null;

    if (
      local.fulfillment_status !== nextStatus ||
      local.fulfillable_quantity !== nextFulfillableQuantity
    ) {
      plans.push({
        orderId: candidate.oms_order_id,
        lineId: local.id,
        externalLineItemId,
        currentStatus: local.fulfillment_status,
        currentFulfillableQuantity: local.fulfillable_quantity,
        nextStatus,
        nextFulfillableQuantity,
      });
    }
  }

  return plans;
}

async function applyPlans(
  pool: Pool,
  candidate: CandidateOrder,
  shopifyOrder: ShopifyOrder,
  plans: LinePlan[],
  execute: boolean,
): Promise<void> {
  if (!execute) return;

  await pool.query("BEGIN");
  try {
    for (const plan of plans) {
      await pool.query(`
        UPDATE oms.oms_order_lines
        SET fulfillment_status = $2,
            fulfillable_quantity = $3,
            updated_at = NOW()
        WHERE id = $1
      `, [plan.lineId, plan.nextStatus, plan.nextFulfillableQuantity]);
    }

    await pool.query(`
      UPDATE oms.oms_orders
      SET fulfillment_status = $2,
          status = CASE WHEN $2 = 'fulfilled' THEN 'shipped' ELSE status END,
          updated_at = NOW()
      WHERE id = $1
    `, [candidate.oms_order_id, normalizeOrderStatus(shopifyOrder.fulfillment_status)]);

    await pool.query(`
      INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
      VALUES ($1, 'shopify_line_fulfillment_backfilled', $2::jsonb, NOW())
    `, [
      candidate.oms_order_id,
      JSON.stringify({
        source: "backfill-shopify-oms-line-fulfillment-status",
        externalOrderId: candidate.external_order_id,
        updatedLines: plans.length,
      }),
    ]);

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  loadDotenvIfAvailable();
  const flags = parseFlags(process.argv.slice(2));
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  const stats = {
    candidates: 0,
    fetched: 0,
    missingShopifyOrder: 0,
    plannedOrders: 0,
    plannedLines: 0,
    updatedOrders: 0,
    errors: 0,
  };

  try {
    const shopifyConfig = await resolveShopifyConfig(pool);
    const candidates = await loadCandidates(pool, flags);
    stats.candidates = candidates.length;
    console.log(
      `[Shopify line backfill] mode=${flags.execute ? "execute" : "dry-run"} ` +
      `candidates=${candidates.length} limit=${flags.limit} batchSize=${flags.batchSize}`,
    );

    for (let index = 0; index < candidates.length; index += flags.batchSize) {
      const batch = candidates.slice(index, index + flags.batchSize);
      const orders = await fetchShopifyOrders(
        shopifyConfig,
        batch.map((row) => row.external_order_id),
      );
      stats.fetched += orders.size;

      for (const candidate of batch) {
        try {
          const shopifyOrder = orders.get(candidate.external_order_id);
          if (!shopifyOrder) {
            stats.missingShopifyOrder++;
            console.warn(
              `[Shopify line backfill] missing Shopify order oms=${candidate.oms_order_id} external=${candidate.external_order_id}`,
            );
            continue;
          }

          const plans = await buildLinePlans(pool, candidate, shopifyOrder);
          if (plans.length === 0) continue;

          stats.plannedOrders++;
          stats.plannedLines += plans.length;
          console.log(
            `[Shopify line backfill] ${flags.execute ? "UPDATE" : "PLAN"} ` +
            `oms=${candidate.oms_order_id} order=${candidate.external_order_number ?? candidate.external_order_id} ` +
            `lines=${plans.length}`,
          );
          for (const plan of plans.slice(0, 5)) {
            console.log(
              `  line=${plan.lineId} shopifyLine=${plan.externalLineItemId} ` +
              `${plan.currentStatus ?? "null"}(${plan.currentFulfillableQuantity ?? "null"}) -> ` +
              `${plan.nextStatus}(${plan.nextFulfillableQuantity ?? "null"})`,
            );
          }

          await applyPlans(pool, candidate, shopifyOrder, plans, flags.execute);
          if (flags.execute) stats.updatedOrders++;
        } catch (error: any) {
          stats.errors++;
          console.error(
            `[Shopify line backfill] error oms=${candidate.oms_order_id}: ${error?.message ?? error}`,
          );
        }
      }

      if (index + flags.batchSize < candidates.length) {
        await sleep(flags.sleepMs);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`[Shopify line backfill] complete ${JSON.stringify(stats)}`);
  if (stats.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[Shopify line backfill] fatal:", error);
  process.exit(1);
});
