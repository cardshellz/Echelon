import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupWebSocket } from "./websocket";
// REMOVED: order-sync-listener deleted (Phase 3 - duplicate path eliminated)
// REMOVED: reconciliation rebuilt without syncSingleOrder for OMS decoupling
import { initReconciliation, startShopifyReconciliation } from "./modules/orders/shopify-order-reconciliation";
import { runStartupMigrations, db } from "./db";
import { createServices } from "./services";
import { startEbayOrderPolling, setShipStationService, setWmsServices, setWmsSyncService } from "./modules/oms/ebay-order-ingestion";
import { startVendorOrderPolling, setDropshipOmsService, setDropshipShipStationService, setDropshipWmsServices } from "./modules/dropship/vendor-order-polling";
import { startBillingScheduler } from "./modules/subscriptions/subscription.scheduler";
import { startWebhookRetryWorker } from "./modules/oms/webhook-retry.worker";
import { createEbayOrderWebhookHandler, reingestEbayOrder } from "./modules/oms/ebay-order-ingestion";
import { registerOmsWebhooks } from "./modules/oms/oms-webhooks";
import { startShopifyBridgeListener } from "./modules/oms/shopify-bridge";
import { eq, and, sql } from "drizzle-orm";
import type { SafeUser } from "@shared/schema";
import { channels as channelsTable, syncLog as syncLogTable } from "@shared/schema";
import { pool as dbPool } from "./db";
import * as http from "http";
import { createEbayAuthConfig, EbayAuthService } from "./modules/channels/adapters/ebay/ebay-auth.service";
import { createEbayApiClient } from "./modules/channels/adapters/ebay/ebay-api.client";
import { requireAuth } from "./routes/middleware";

declare module "express-session" {
  interface SessionData {
    user?: SafeUser;
  }
}

const app = express();
const httpServer = createServer(app);

// setupWebSocket is deferred until sessionMiddleware is created

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Trust proxy for Heroku (needed for secure cookies behind load balancer)
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

if (!process.env.SESSION_SECRET) {
  throw new Error("FATAL: SESSION_SECRET environment variable is missing. Halting startup to prevent fallback secret exploitation.");
}

// Set up PostgreSQL session store for persistent sessions
const PgSession = connectPgSimple(session);
const dbConnectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
const useSSL = process.env.EXTERNAL_DATABASE_URL || process.env.NODE_ENV === "production";
const sessionPool = new Pool({
  connectionString: dbConnectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  max: 2, // Limit session pool connections (Heroku Hobby = 20 total)
});

const sessionMiddleware = session({
  store: new PgSession({
    pool: sessionPool,
    schemaName: "identity",
    tableName: "session",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.TRUST_PROXY === "true",
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: "lax", // Required for PWA compatibility
  },
});

app.use(sessionMiddleware);

// Initialize WebSocket server with session support
setupWebSocket(httpServer, sessionMiddleware);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // Log response body only for errors (status >= 400)
        if (res.statusCode >= 400) {
          const jsonStr = JSON.stringify(capturedJsonResponse);
          if (jsonStr.length > 500) {
            logLine += ` :: ${jsonStr.slice(0, 500)}...`;
          } else {
            logLine += ` :: ${jsonStr}`;
          }
        }
      }

      log(logLine);
    }
  });

  next();
});

/**
 * Echelon Sync Scheduler — periodically runs the Echelon orchestrator
 * as the sole sync engine, respecting the sync control hierarchy:
 *
 *   sync_settings.global_enabled → per-channel sync_enabled → sync_mode (live/dry_run)
 *
 * Replaces the old channelSync.syncAllProducts() scheduled interval.
 */
function startEchelonSyncScheduler(services: ReturnType<typeof createServices>, dbInstance: any) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function runSweep() {
    const startTime = Date.now();
    try {
      // 1. Check global kill switch
      const globalSettings = await services.syncSettings.getGlobalSettings();
      if (!globalSettings.globalEnabled) {
        return; // Silently skip — global sync is off
      }

      // 2. Get all active channels with sync enabled
      const activeChannels = await dbInstance
        .select()
        .from(channelsTable)
        .where(and(
          eq(channelsTable.status, "active"),
          eq(channelsTable.syncEnabled, true),
        ));

      if (activeChannels.length === 0) {
        await services.syncSettings.updateLastSweep(Date.now() - startTime);
        return;
      }

      log(`[Echelon Sync] Starting sweep for ${activeChannels.length} enabled channel(s)`, "echelon-sync");

      // 3. Run the Echelon orchestrator for all enabled channels
      try {
        // Determine if ALL channels are dry_run or if any are live
        const hasDryRunOnly = activeChannels.every((c: any) => c.syncMode === "dry_run");
        const dryRun = hasDryRunOnly;

        const result = await services.echelonOrchestrator.runFullSync({ dryRun });

        // Log results to sync_log
        for (const inv of result.inventory) {
          for (const detail of (inv.details || [])) {
            await services.syncSettings.writeSyncLog({
              channelId: inv.channelId,
              channelName: inv.channelName,
              action: "inventory_push",
              sku: detail.sku,
              productVariantId: detail.variantId,
              previousValue: detail.previousQty != null ? String(detail.previousQty) : null,
              newValue: String(detail.allocatedQty),
              status: detail.status === "success" ? "pushed" : detail.status === "dry_run" ? "dry_run" : detail.status === "error" ? "error" : "skipped",
              errorMessage: detail.error || null,
              source: "sweep",
            });
          }
        }

        const totalPushed = result.inventory.reduce((s: number, i: any) => s + i.variantsPushed, 0);
        const totalErrors = result.inventory.reduce((s: number, i: any) => s + i.variantsErrored, 0);
        log(
          `[Echelon Sync] Orchestrator: ${totalPushed} pushed, ${totalErrors} errors across ${result.inventory.length} channels`,
          "echelon-sync",
        );
      } catch (err: any) {
        log(`[Echelon Sync] Orchestrator error: ${err.message}`, "echelon-sync");
        await services.syncSettings.writeSyncLog({
          channelId: null,
          channelName: "ALL",
          action: "inventory_push",
          status: "error",
          errorMessage: err.message,
          source: "sweep",
        });
      }

      const durationMs = Date.now() - startTime;
      await services.syncSettings.updateLastSweep(durationMs);
      log(`[Echelon Sync] Sweep completed in ${durationMs}ms`, "echelon-sync");
    } catch (err: any) {
      console.warn("[Echelon Sync] Sweep error:", err?.message);
    }
  }

  async function setupInterval() {
    try {
      const globalSettings = await services.syncSettings.getGlobalSettings();

      if (!globalSettings.globalEnabled) {
        log("[Echelon Sync] Disabled (global_enabled = false)", "echelon-sync");
        return;
      }

      const intervalMinutes = globalSettings.sweepIntervalMinutes || 15;
      if (intervalMinutes <= 0) {
        log("[Echelon Sync] Disabled (interval = 0)", "echelon-sync");
        return;
      }

      log(`[Echelon Sync] Starting with ${intervalMinutes}-minute sweep interval`, "echelon-sync");

      // Run first sweep immediately on boot
      runSweep();

      intervalHandle = setInterval(() => runSweep(), intervalMinutes * 60 * 1000);
    } catch (err: any) {
      console.warn("[Echelon Sync] Failed to start scheduler:", err?.message);
    }
  }

  setupInterval();
}

(async () => {
  // Run startup migrations to ensure database schema is up to date
  await runStartupMigrations();

  // Create WMS service container and attach to app for route handlers
  const services = createServices(db);
  app.locals.services = services;
  // REMOVED: initOrderSyncServices deleted with order-sync-listener
  // initOrderSyncServices(services);

  // Start Echelon sync scheduler (replaces old channelSync scheduler)
  startEchelonSyncScheduler(services, db);

  // --- ShipStation SHIP_NOTIFY webhook (BEFORE auth middleware — unauthenticated) ---
  app.post("/api/shipstation/webhooks/ship-notify", async (req, res) => {
    try {
      const { resource_url, resource_type } = req.body || {};
      if (resource_type !== "SHIP_NOTIFY" || !resource_url) {
        return res.status(400).json({ error: "Invalid webhook payload" });
      }

      console.log(`[ShipStation Webhook] Received SHIP_NOTIFY`);
      const processed = await services.shipStation.processShipNotify(resource_url);
      console.log(`[ShipStation Webhook] Processed ${processed} shipment(s)`);

      res.status(200).json({ status: "ok", processed });
    } catch (err: any) {
      console.error(`[ShipStation Webhook] Error: ${err.message}`);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // --- OMS Shopify Webhooks (BEFORE auth middleware — HMAC verified) ---
  registerOmsWebhooks(app, services.oms, {
    reservation: services.reservation,
    fulfillmentRouter: services.fulfillmentRouter,
    slaMonitor: services.slaMonitor,
  }, services.shipStation, services.wmsSync);

  // Wire fulfillment push into ShipStation service for tracking push on ship notify
  (db as any).__fulfillmentPush = services.fulfillmentPush;

  // Inject ShipStation service into eBay ingestion for auto-push
  setShipStationService(services.shipStation);
  setWmsServices({
    reservation: services.reservation,
    fulfillmentRouter: services.fulfillmentRouter,
    slaMonitor: services.slaMonitor,
  });

  // Start eBay Order Polling (5-min safety net — NON-NEGOTIABLE)
  try {
    const ebayConfig = createEbayAuthConfig();
    const ebayAuthService = new EbayAuthService(db, ebayConfig);
    const ebayApiClient = createEbayApiClient(ebayAuthService, 67);

    // Wire eBay client into fulfillment push service for tracking push
    services.fulfillmentPush.setEbayClient(ebayApiClient);

    // Wire WMS sync service into eBay ingestion
    setWmsSyncService(services.wmsSync);

    startEbayOrderPolling(services.oms, ebayApiClient);

    // Register eBay order webhook
    const webhookHandler = createEbayOrderWebhookHandler(services.oms, ebayApiClient);
    app.get("/api/ebay/webhooks/order", requireAuth, webhookHandler);
    app.post("/api/ebay/webhooks/order", requireAuth, webhookHandler);

    // Admin: manually reingest an eBay order that the poller missed.
    // POST /api/admin/ebay/reingest { orderId: '21-14508-76944' }
    app.post("/api/admin/ebay/reingest", requireAuth, async (req, res) => {
      try {
        const role = (req.session as any)?.user?.role;
        if (role !== "admin" && role !== "lead") {
          return res.status(403).json({ error: "admin/lead only" });
        }
        const { orderId } = req.body || {};
        if (!orderId || typeof orderId !== "string") {
          return res.status(400).json({ error: "orderId (string) required" });
        }
        const result = await reingestEbayOrder(orderId, services.oms, ebayApiClient);
        res.json(result);
      } catch (err: any) {
        console.error(`[eBay Reingest] ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    log("eBay order polling and webhook registered", "oms");
  } catch (err: any) {
    log(`eBay order polling not started (config missing): ${err.message}`, "oms");
  }

  // Start Vendor (Dropship) Order Polling — polls each vendor's eBay for orders
  try {
    setDropshipOmsService(services.oms);
    setDropshipShipStationService(services.shipStation);
    setDropshipWmsServices({
      reservation: services.reservation,
      fulfillmentRouter: services.fulfillmentRouter,
      slaMonitor: services.slaMonitor,
    });
    startVendorOrderPolling();
    log("Vendor dropship order polling started", "dropship");
  } catch (err: any) {
    log(`Vendor order polling not started: ${err.message}`, "dropship");
  }

  // ---- eBay Listing Reconciliation (every 30 minutes) ----
  // Checks synced listings against eBay to detect ended/deleted items
  const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  let reconcileRunning = false;

  async function runEbayReconciliation() {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      const client = await dbPool.connect();
      try {
        // Check if there are any synced eBay listings to verify
        const countResult = await client.query(
          `SELECT COUNT(*) AS cnt FROM channels.channel_listings WHERE channel_id = 67 AND sync_status = 'synced'`,
        );
        const count = parseInt(countResult.rows[0]?.cnt || "0");
        if (count === 0) {
          return; // Nothing to reconcile
        }

        // Call the reconcile endpoint directly (bypass auth)
        const port = process.env.PORT || 5000;
        const reqData = JSON.stringify({});
        const options = {
          hostname: "127.0.0.1",
          port,
          path: "/api/ebay/listings/reconcile?_internal=1",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(reqData),
          },
        };

        await new Promise<void>((resolve, reject) => {
          const req = http.request(options, (res: any) => {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
              try {
                const data = JSON.parse(body);
                const changes = (data.ended || 0) + (data.deleted || 0);
                if (data.checked > 0) {
                  console.log(
                    `[eBay Reconcile] checked=${data.checked} active=${data.active} ended=${data.ended} deleted=${data.deleted} errors=${data.errors}`,
                  );
                }
                if (changes > 0) {
                  console.log(`[eBay Reconcile] ⚠️ ${changes} listing(s) ended/deleted on eBay — check listing feed`);
                  // Fire notification
                  try {
                    // @ts-ignore
                    services.notifications?.notify?.("listing_status_change", {
                      title: `eBay Listings Changed`,
                      message: `${changes} listing(s) ended or deleted on eBay since last check`,
                      data: { ended: data.ended, deleted: data.deleted, changes: data.changes },
                    });
                  } catch {}
                }
              } catch { /* ignore parse errors */ }
              resolve();
            });
          });
          req.on("error", (err: any) => {
            console.warn(`[eBay Reconcile] Scheduled run failed: ${err.message}`);
            resolve(); // Don't reject — just log
          });
          req.write(reqData);
          req.end();
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn(`[eBay Reconcile] Scheduled error: ${err.message}`);
    } finally {
      reconcileRunning = false;
    }
  }

  // Start after 2 minutes (let server settle), then every 30 min
  setTimeout(() => {
    runEbayReconciliation();
    setInterval(runEbayReconciliation, RECONCILE_INTERVAL_MS);
    log("[eBay Reconcile] Scheduled reconciliation started (every 30 min)", "ebay-reconcile");
  }, 2 * 60 * 1000);

  // Register ShipStation SHIP_NOTIFY webhook if environment variables are configured (idempotent, non-blocking)
  setTimeout(async () => {
    try {
      const webhookUrl = process.env.SHIPSTATION_WEBHOOK_URL;
      if (services.shipStation.isConfigured() && webhookUrl) {
        await services.shipStation.registerWebhook(webhookUrl);
      } else if (services.shipStation.isConfigured() && !webhookUrl) {
        console.log(`[ShipStation] Skipping webhook registration - SHIPSTATION_WEBHOOK_URL unset.`);
      }
    } catch (err: any) {
      console.error(`[ShipStation] Webhook registration error: ${err.message}`);
    }
  }, 15_000);

  // Sync Recovery — unified gap-recovery orchestrator. Runs every 10 min and
  // closes the full pipeline Shopify → shopify_orders → OMS → WMS. Replaces the
  // old one-shot boot-time backfill.
  if (services.syncRecovery) {
    services.syncRecovery.startScheduled(10, 30_000);
  }

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    console.error("[Global Error Handler] Unhandled exception:", err);
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  try {
    const res = await db.execute(sql`SELECT id, variant_id, location_id, variant_qty FROM inventory_levels WHERE variant_qty < 0`);
    if ((res as any).rows.length > 0) {
      console.warn(`[Startup Warning] Found ${(res as any).rows.length} negative inventory levels. They have NOT been cleared. Writing to audit log.`);
      for (const row of (res as any).rows) {
        await db.execute(sql`INSERT INTO startup_inventory_anomalies (variant_id, location_id, qty_on_hand) VALUES (${row.variant_id}, ${row.location_id}, ${row.variant_qty})`);
      }
    }

    // P1-18 extracted: Startup fix for dangling completed items has been moved to scripts/backfill/fix-dangling-order-items.ts
  } catch (err) {
    console.error("[Startup Fix] Failed to clear negative inventory balances or dangling items", err);
  }

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      
      // REMOVED: order-sync-listener deleted (duplicate path)
      // Now using: Echelon OMS webhooks → oms_orders → wmsSync → orders

      // Start Shopify order reconciliation (catches TikTok, POS, missed webhooks)
      initReconciliation(services.oms);
      startShopifyReconciliation();
      
      // Hook up continuous Shopify Bridge listener (M18)
      startShopifyBridgeListener(db, services.oms);

      // Start subscription billing scheduler (runs hourly)
      startBillingScheduler();

      // Start webhook DLQ recovery worker
      if (process.env.DISABLE_SCHEDULERS !== 'true') {
        startWebhookRetryWorker();
      }
    }
  );

  // eBay order reconciliation — check for stuck orders every 4 hours
  if (process.env.DISABLE_SCHEDULERS !== 'true') {
    setInterval(async () => {
      try {
        // Find eBay OMS orders stuck in "confirmed" for > 48 hours
        const stuckOrders = await db.execute(sql`
          SELECT o.id, o.external_order_id, o.order_number
          FROM oms.oms_orders o
          WHERE o.channel_id = 67
            AND o.status = 'confirmed'
            AND o.created_at < NOW() - INTERVAL '48 hours'
          LIMIT 50
        `);
        if (stuckOrders.rows.length === 0) return;

        console.log(`[eBay Reconcile] Found ${stuckOrders.rows.length} stuck orders, checking ShipStation...`);
        // @ts-ignore
        const ss = services.shipStation;
        if (!ss?.isConfigured()) return;

        for (const order of stuckOrders.rows) {
          try {
            // Check ShipStation for this order
            const ssOrder = await ss.getOrderByKey(`EB-${order.order_number || order.external_order_id}`);
            if (ssOrder && ssOrder.orderStatus === "shipped") {
              const shipment = ssOrder;
              await db.execute(sql`
                UPDATE oms_orders SET status = 'shipped',
                  tracking_number = ${shipment.trackingNumber || null},
                  carrier = ${shipment.carrierCode || null},
                  updated_at = NOW()
                WHERE id = ${order.id}
              `);
              console.log(`[eBay Reconcile] Auto-shipped OMS order ${order.id} (${order.external_order_id})`);

              // Push tracking to eBay
              try {
                // @ts-ignore
                await services.fulfillmentPush.pushTracking(order.id);
              } catch (e: any) {
                console.warn(`[eBay Reconcile] Tracking push failed for ${order.id}: ${e.message}`);
              }
            }
          } catch (e: any) {
            console.warn(`[eBay Reconcile] Failed to check order ${order.id}: ${e.message}`);
          }
          // Rate limit
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err: any) {
        console.warn("[eBay Reconcile] Sweep error:", err?.message);
      }
    }, 4 * 60 * 60 * 1000); // Every 4 hours
  }

  // OMS<->WMS reconciliation — catches webhook delivery failures where
  // an OMS order got cancelled/shipped/refunded but the WMS row is
  // still sitting in ready/in_progress. Hourly sweep.
  if (process.env.DISABLE_SCHEDULERS !== 'true') {
    const runOmsWmsReconcile = async () => {
      try {
        const result = await db.execute(sql`
          UPDATE wms.orders w
          SET warehouse_status = CASE
                WHEN oms.status = 'cancelled' THEN 'cancelled'
                WHEN oms.status = 'shipped'   THEN 'shipped'
                ELSE w.warehouse_status
              END,
              assigned_picker_id = NULL,
              cancelled_at = CASE WHEN oms.status = 'cancelled' THEN COALESCE(w.cancelled_at, NOW()) ELSE w.cancelled_at END,
              updated_at = NOW()
          FROM oms.oms_orders oms
          WHERE (
                  (w.source = 'oms'     AND w.oms_fulfillment_order_id = oms.id::text)
              OR  (w.source = 'shopify' AND w.source_table_id = oms.id::text)
                )
            AND oms.status IN ('cancelled', 'shipped', 'refunded')
            AND w.warehouse_status IN ('ready', 'in_progress')
          RETURNING w.id, w.order_number, oms.status AS oms_status
        `);
        if (result.rows.length > 0) {
          console.warn(`[OMS<->WMS Reconcile] Corrected ${result.rows.length} divergent order(s):`,
            result.rows.map((r: any) => `${r.order_number} (oms=${r.oms_status})`).join(", "));
        }
      } catch (err: any) {
        console.warn("[OMS<->WMS Reconcile] Sweep error:", err?.message);
      }
    };
    setTimeout(runOmsWmsReconcile, 15_000);
    setInterval(runOmsWmsReconcile, 60 * 60 * 1000);
  }

  // OMS<->ShipStation reconciliation — catches cases where an order got
  // shipped/cancelled/refunded in Shopify (native connector shipped it, or
  // customer cancelled) but Echelon's copy in ShipStation is still in
  // Awaiting Shipment. Hourly sweep.
  if (process.env.DISABLE_SCHEDULERS !== 'true') {
    const runShipStationReconcile = async () => {
      try {
        const ss = (services as any).shipStation;
        if (!ss?.isConfigured()) return;

        // Find OMS orders that are shipped/cancelled/refunded in our DB but
        // still have a shipstation_order_id and no reconciliation marker.
        const rows: any = await db.execute(sql`
          SELECT id, external_order_number, status, shipstation_order_id,
                 tracking_number, tracking_carrier, shipped_at
          FROM oms.oms_orders
          WHERE shipstation_order_id IS NOT NULL
            AND status IN ('shipped', 'cancelled', 'refunded')
            AND (shipstation_reconciled_at IS NULL OR shipstation_reconciled_at < updated_at)
          ORDER BY updated_at DESC  -- newest divergences first
          LIMIT 500
        `);

        if (!rows.rows?.length) return;

        let markedShipped = 0;
        let cancelled = 0;
        for (const row of rows.rows) {
          try {
            if (row.status === 'shipped') {
              await ss.markAsShipped(Number(row.shipstation_order_id), {
                shipDate: row.shipped_at || new Date(),
                trackingNumber: row.tracking_number || null,
                carrierCode: row.tracking_carrier?.toLowerCase() || 'other',
                notifyCustomer: false,
              });
              markedShipped++;
            } else {
              // cancelled or refunded — remove from ShipStation store
              await ss.cancelOrder(Number(row.shipstation_order_id));
              cancelled++;
            }
            // Stamp reconciliation marker so we don't re-hit this row next sweep
            await db.execute(sql`
              UPDATE oms.oms_orders SET shipstation_reconciled_at = NOW() WHERE id = ${row.id}
            `);
            // Rate limit — ShipStation allows ~40 req/min; keep under that.
            await new Promise(r => setTimeout(r, 1000));
          } catch (err: any) {
            console.warn(`[ShipStation Reconcile] Failed for OMS ${row.id}:`, err?.message);
          }
        }
        if (markedShipped || cancelled) {
          console.warn(`[ShipStation Reconcile] Swept ${rows.rows.length} divergent order(s): ${markedShipped} marked shipped, ${cancelled} cancelled`);
        }
      } catch (err: any) {
        console.warn("[ShipStation Reconcile] Sweep error:", err?.message);
      }
    };
    setTimeout(runShipStationReconcile, 30_000);
    setInterval(runShipStationReconcile, 60 * 60 * 1000);
  }
})();
