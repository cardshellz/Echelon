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
import { startBillingScheduler } from "./modules/subscriptions/subscription.scheduler";
import { startWebhookRetryWorker, enqueueShipStationRetry } from "./modules/oms/webhook-retry.worker";
import { createEbayOrderWebhookHandler, reingestEbayOrder } from "./modules/oms/ebay-order-ingestion";
import { registerOmsWebhooks } from "./modules/oms/oms-webhooks";
import { startShopifyBridgeListener } from "./modules/oms/shopify-bridge";
import { eq, and, sql } from "drizzle-orm";
import { dispatchShipmentEvent, recomputeOrderStatusFromShipments } from "./modules/orders/shipment-rollup";
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
  try {
    await runStartupMigrations();
  } catch (err) {
    console.error("Startup migrations failed, continuing anyway:", err);
  }

  // Create WMS service container and attach to app for route handlers
  const services = createServices(db);
  app.locals.services = services;
  // REMOVED: initOrderSyncServices deleted with order-sync-listener
  // initOrderSyncServices(services);

  // Start Echelon sync scheduler (replaces old channelSync scheduler)
  startEchelonSyncScheduler(services, db);

  // --- ShipStation SHIP_NOTIFY webhook (BEFORE auth middleware — unauthenticated) ---
  app.post("/api/shipstation/webhooks/ship-notify", async (req, res) => {
    const { resource_url, resource_type } = req.body || {};
    if (resource_type !== "SHIP_NOTIFY" || !resource_url || typeof resource_url !== "string") {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }

    try {
      console.log(`[ShipStation Webhook] Received SHIP_NOTIFY`);
      const processed = await services.shipStation.processShipNotify(resource_url);
      console.log(`[ShipStation Webhook] Processed ${processed} shipment(s)`);

      return res.status(200).json({ status: "ok", processed });
    } catch (err: any) {
      console.error(
        `[ShipStation Webhook] processShipNotify failed, enqueueing for retry: ${err.message}`
      );

      // Enqueue for the webhook-retry worker. Best-effort: if the enqueue
      // itself fails we still 500 so SS's own retry layer can take over —
      // we don't want an enqueue blip to mask the original processing error.
      try {
        await enqueueShipStationRetry(db, { resource_url });
      } catch (enqueueErr: any) {
        console.error(
          `[ShipStation Webhook] retry-queue enqueue failed: ${enqueueErr?.message || enqueueErr}`
        );
      }

      return res.status(500).json({ error: "Internal error" });
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

  // Stash ShipStation service for the webhook-retry worker to pick up
  // (mirrors the __fulfillmentPush pattern — keeps the scheduler start
  // surface free of service threading).
  (db as any).__shipStationService = services.shipStation;

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

  // Dropship V2 vendor polling remains disabled until the replacement use-case layer lands.
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

  // WMS<->ShipStation reconciliation.
  //
  // V2 (RECONCILE_V2=true): reads from wms.outbound_shipments (source of
  // truth after C8/C12/C15). Each shipment owns its own shipstation_order_id;
  // we fetch SS state and dispatch via the shipment-rollup helpers
  // (markShipmentShipped/Cancelled/Voided), then recompute order status.
  // Tracks freshness via outbound_shipments.last_reconciled_at.
  //
  // V1 (default, RECONCILE_V2 unset/false): legacy path joins wms.orders →
  // oms.oms_orders and calls ss.markAsShipped / ss.cancelOrder directly.
  // Retained for rollback safety; remove after V2 soak.
  if (process.env.DISABLE_SCHEDULERS !== 'true') {

    // ── V2: shipment-based reconcile ────────────────────────────────────
    const runShipStationReconcileV2 = async () => {
      try {
        const ss = (services as any).shipStation;
        if (!ss?.isConfigured()) return;

        // Select active shipments that have been pushed to ShipStation and
        // haven't been checked recently. last_reconciled_at IS NULL rows
        // come first so new shipments are verified promptly.
        const rows: any = await db.execute(sql`
          SELECT os.id AS shipment_id, os.order_id,
                 os.shipstation_order_id, os.status AS wms_shipment_status,
                 os.tracking_number, os.carrier
          FROM wms.outbound_shipments os
          WHERE os.shipstation_order_id IS NOT NULL
            AND os.status IN ('queued', 'labeled', 'shipped')
            AND (
              os.last_reconciled_at IS NULL
              OR os.last_reconciled_at < NOW() - INTERVAL '1 hour'
            )
          ORDER BY os.last_reconciled_at NULLS FIRST, os.id ASC
          LIMIT 100
        `);

        if (!rows.rows?.length) return;

        let markedShipped = 0;
        let markedCancelled = 0;
        let markedVoided = 0;

        for (const row of rows.rows) {
          const shipmentId: number = row.shipment_id;
          const ssOrderId: number = Number(row.shipstation_order_id);
          try {
            // 1. Fetch SS order state
            const ssOrder = await ss.getOrderById(ssOrderId);
            if (!ssOrder) {
              console.warn(
                `[ShipStation Reconcile V2] SS order ${ssOrderId} not found (shipment=${shipmentId}) — skipping`,
              );
              continue;
            }

            let event: { kind: string; [key: string]: any } | null = null;

            // 2. Detect voided labels first (voidDate beats orderStatus)
            if (row.wms_shipment_status !== "voided") {
              const ssShipments = await ss.getShipments(ssOrderId);
              const hasVoidedLabel = ssShipments.some(
                (s: any) => s.voidDate != null,
              );
              if (hasVoidedLabel) {
                event = { kind: "voided", reason: "ss_label_void" };
              }
            }

            // 3. Detect shipped / cancelled from order status
            if (!event) {
              if (
                ssOrder.orderStatus === "shipped" &&
                row.wms_shipment_status !== "shipped"
              ) {
                const ssShipments = await ss.getShipments(ssOrderId);
                const latest = ssShipments[ssShipments.length - 1];
                event = {
                  kind: "shipped",
                  trackingNumber: latest?.trackingNumber || row.tracking_number || "",
                  carrier: latest?.carrierCode || row.carrier || "other",
                  shipDate: latest?.shipDate
                    ? new Date(latest.shipDate)
                    : new Date(),
                };
              } else if (
                ssOrder.orderStatus === "cancelled" &&
                row.wms_shipment_status !== "cancelled"
              ) {
                event = { kind: "cancelled", reason: "ss_cancelled" };
              } else if (
                ssOrder.orderStatus !== "shipped" &&
                row.wms_shipment_status === "shipped"
              ) {
                // Outbound Sync: Push shipped status to ShipStation if it drifted
                await ss.markAsShipped(ssOrderId, {
                  shipDate: new Date(),
                  trackingNumber: row.tracking_number || "",
                  carrierCode: row.carrier || "other",
                  notifyCustomer: false,
                });
                console.log(`[ShipStation Reconcile V2] Outbound sync: marked SS order ${ssOrderId} shipped`);
                markedShipped++;

                await db.execute(sql`
                  UPDATE wms.outbound_shipments
                  SET last_reconciled_at = NOW()
                  WHERE id = ${shipmentId}
                `);
                continue;
              } else if (
                ssOrder.orderStatus !== "cancelled" &&
                row.wms_shipment_status === "cancelled"
              ) {
                // Outbound Sync: Push cancelled status to ShipStation if it drifted
                await ss.cancelOrder(ssOrderId);
                console.log(`[ShipStation Reconcile V2] Outbound sync: cancelled SS order ${ssOrderId}`);
                markedCancelled++;

                await db.execute(sql`
                  UPDATE wms.outbound_shipments
                  SET last_reconciled_at = NOW()
                  WHERE id = ${shipmentId}
                `);
                continue;
              }
            }

            if (!event) {
              // No divergence — stamp to prove we checked
              await db.execute(sql`
                UPDATE wms.outbound_shipments
                SET last_reconciled_at = NOW()
                WHERE id = ${shipmentId}
              `);
              continue;
            }

            // 4. Dispatch via shipment-rollup helpers
            const { wmsOrderId, changed } = await dispatchShipmentEvent(
              db,
              shipmentId,
              event as any,
            );

            if (changed) {
              // 5. Recompute order-level warehouse_status
              const rollup = await recomputeOrderStatusFromShipments(
                db,
                row.order_id,
              );
              console.log(
                `[ShipStation Reconcile V2] shipment=${shipmentId} → ${event.kind}, ` +
                  `order ${row.order_id} warehouse_status=${rollup.warehouseStatus}`,
              );

              // 6. Update OMS derived fields (inline — mirrors
              //    updateOmsDerivedFromEvent in shipstation.service.ts)
              if (event.kind === "shipped") {
                await db.execute(sql`
                  UPDATE oms.oms_orders SET
                    status = 'shipped',
                    fulfillment_status = 'fulfilled',
                    tracking_number = ${event.trackingNumber},
                    tracking_carrier = ${event.carrier},
                    shipped_at = ${event.shipDate},
                    updated_at = NOW()
                  WHERE id = ${row.order_id}
                `);
                await db.execute(sql`
                  UPDATE oms.oms_order_lines SET
                    fulfillment_status = 'fulfilled',
                    updated_at = NOW()
                  WHERE order_id = ${row.order_id}
                `);
                markedShipped++;
              } else if (event.kind === "cancelled") {
                await db.execute(sql`
                  UPDATE oms.oms_orders SET
                    status = 'cancelled',
                    updated_at = NOW()
                  WHERE id = ${row.order_id}
                `);
                markedCancelled++;
              } else if (event.kind === "voided") {
                // Voided: no OMS state change by design (shipment can be
                // re-labeled; OMS stays in pre-ship state).
                markedVoided++;
              }

              // Record audit event
              try {
                await db.execute(sql`
                  INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
                  VALUES (
                    ${row.order_id},
                    ${event.kind === "shipped"
                      ? "shipped_via_shipstation"
                      : event.kind === "cancelled"
                        ? "cancelled_via_shipstation"
                        : "voided_via_shipstation"},
                    ${JSON.stringify({
                      wmsShipmentId: shipmentId,
                      ssOrderId,
                      ...(event.kind === "shipped"
                        ? { trackingNumber: event.trackingNumber, carrier: event.carrier }
                        : { reason: event.reason }),
                    })}::jsonb,
                    NOW()
                  )
                `);
              } catch (auditErr: any) {
                console.warn(
                  `[ShipStation Reconcile V2] audit insert failed for order ${row.order_id}:`,
                  auditErr?.message,
                );
              }
            }

            // 7. Stamp last_reconciled_at
            await db.execute(sql`
              UPDATE wms.outbound_shipments
              SET last_reconciled_at = NOW()
              WHERE id = ${shipmentId}
            `);

            // Rate limit — ShipStation allows ~40 req/min
            await new Promise(r => setTimeout(r, 1000));
          } catch (err: any) {
            // Per spec: log + skip + DON'T stamp last_reconciled_at so it
            // gets retried next sweep.
            console.warn(
              `[ShipStation Reconcile V2] Failed for shipment ${shipmentId} (SS ${ssOrderId}):`,
              err?.message,
            );
          }
        }

        if (markedShipped || markedCancelled || markedVoided) {
          console.warn(
            `[ShipStation Reconcile V2] Swept ${rows.rows.length} candidate(s): ` +
              `${markedShipped} shipped, ${markedCancelled} cancelled, ${markedVoided} voided`,
          );
        }
      } catch (err: any) {
        console.warn("[ShipStation Reconcile V2] Sweep error:", err?.message);
      }
    };

    // ── V1: legacy order-based reconcile (fallback) ─────────────────────
    const runShipStationReconcileV1 = async () => {
      try {
        const ss = (services as any).shipStation;
        if (!ss?.isConfigured()) return;

        const rows: any = await db.execute(sql`
          SELECT w.id AS wms_id, w.order_number AS wms_order_number,
                 w.warehouse_status, w.completed_at, w.tracking_number,
                 o.id AS oms_id, o.status AS oms_status,
                 o.shipstation_order_id, o.shipstation_reconciled_at,
                 o.tracking_carrier
          FROM wms.orders w
          JOIN oms.oms_orders o ON (
                 (w.oms_fulfillment_order_id ~ '^[0-9]+$'
                    AND o.id = w.oms_fulfillment_order_id::int)
              OR (w.oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'
                    AND o.external_order_id = w.oms_fulfillment_order_id)
          )
          WHERE o.shipstation_order_id IS NOT NULL
            AND w.warehouse_status IN ('shipped', 'cancelled')
            AND (o.shipstation_reconciled_at IS NULL OR o.shipstation_reconciled_at < w.completed_at)
          ORDER BY w.updated_at DESC
          LIMIT 1000
        `);

        if (!rows.rows?.length) return;

        let markedShipped = 0;
        let cancelled = 0;
        for (const row of rows.rows) {
          try {
            if (row.warehouse_status === 'shipped') {
              await ss.markAsShipped(Number(row.shipstation_order_id), {
                shipDate: row.completed_at || new Date(),
                trackingNumber: row.tracking_number || null,
                carrierCode: row.tracking_carrier?.toLowerCase() || 'other',
                notifyCustomer: false,
              });
              markedShipped++;
            } else {
              await ss.cancelOrder(Number(row.shipstation_order_id));
              cancelled++;
            }
            await db.execute(sql`
              UPDATE oms.oms_orders SET shipstation_reconciled_at = NOW() WHERE id = ${row.oms_id}
            `);
            await new Promise(r => setTimeout(r, 1000));
          } catch (err: any) {
            console.warn(`[ShipStation Reconcile V1] Failed for OMS ${row.oms_id}:`, err?.message);
          }
        }
        if (markedShipped || cancelled) {
          console.warn(`[ShipStation Reconcile V1] Swept ${rows.rows.length} divergent order(s): ${markedShipped} marked shipped, ${cancelled} cancelled`);
        }
      } catch (err: any) {
        console.warn("[ShipStation Reconcile V1] Sweep error:", err?.message);
      }
    };

    // Schedule: V2 when flag is ON, V1 otherwise.
    const runShipStationReconcile = async () => {
      if (process.env.RECONCILE_V2 === "true") {
        await runShipStationReconcileV2();
      } else {
        await runShipStationReconcileV1();
      }
    };

    setTimeout(runShipStationReconcile, 30_000);
    setInterval(runShipStationReconcile, 10 * 60 * 1000); // Every 10 minutes
  }
})();
