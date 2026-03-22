import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupWebSocket } from "./websocket";
import { setupOrderSyncListener, initOrderSyncServices } from "./modules/orders/order-sync-listener";
import { runStartupMigrations, db } from "./db";
import { createServices } from "./services";
import { startEbayOrderPolling, setShipStationService, setWmsServices } from "./modules/oms/ebay-order-ingestion";
import { createEbayOrderWebhookHandler } from "./modules/oms/ebay-order-ingestion";
import { backfillShopifyOrders } from "./modules/oms/shopify-bridge";
import { eq } from "drizzle-orm";
import type { SafeUser } from "@shared/schema";

declare module "express-session" {
  interface SessionData {
    user?: SafeUser;
  }
}

const app = express();
const httpServer = createServer(app);

setupWebSocket(httpServer);

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

// Trust proxy for Heroku (needed for secure cookies behind load balancer)
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Set up PostgreSQL session store for persistent sessions
const PgSession = connectPgSimple(session);
const dbConnectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
const useSSL = process.env.EXTERNAL_DATABASE_URL || process.env.NODE_ENV === "production";
const sessionPool = new Pool({
  connectionString: dbConnectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

app.use(
  session({
    store: new PgSession({
      pool: sessionPool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "echelon-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: "lax", // Required for PWA compatibility
    },
  })
);

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
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
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
      const { channels: channelsTable, syncLog: syncLogTable } = require("@shared/schema");
      const { and: andOp, eq: eqOp } = require("drizzle-orm");

      const activeChannels = await dbInstance
        .select()
        .from(channelsTable)
        .where(andOp(
          eqOp(channelsTable.status, "active"),
          eqOp(channelsTable.syncEnabled, true),
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

      // Skip startup sync — deploying triggers a full inventory push to Shopify which
      // floods downstream webhook receivers (shellz-club-app) with fulfillment events.
      // The scheduled interval handles catch-up within minutes anyway.
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
  initOrderSyncServices(services);

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
    const { createEbayAuthConfig, EbayAuthService } = require("./modules/channels/adapters/ebay/ebay-auth.service");
    const { createEbayApiClient } = require("./modules/channels/adapters/ebay/ebay-api.client");

    const ebayConfig = createEbayAuthConfig();
    const ebayAuthService = new EbayAuthService(db, ebayConfig);
    const ebayApiClient = createEbayApiClient(ebayAuthService, 67);

    startEbayOrderPolling(services.oms, ebayApiClient);

    // Register eBay order webhook
    const webhookHandler = createEbayOrderWebhookHandler(services.oms, ebayApiClient);
    app.get("/api/ebay/webhooks/order", webhookHandler);
    app.post("/api/ebay/webhooks/order", webhookHandler);
    log("eBay order polling and webhook registered", "oms");
  } catch (err: any) {
    log(`eBay order polling not started (config missing): ${err.message}`, "oms");
  }

  // ---- eBay Listing Reconciliation (every 30 minutes) ----
  // Checks synced listings against eBay to detect ended/deleted items
  const RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  let reconcileRunning = false;

  async function runEbayReconciliation() {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      const { pool: dbPool } = require("./db");
      const client = await dbPool.connect();
      try {
        // Check if there are any synced eBay listings to verify
        const countResult = await client.query(
          `SELECT COUNT(*) AS cnt FROM channel_listings WHERE channel_id = 67 AND sync_status = 'synced'`,
        );
        const count = parseInt(countResult.rows[0]?.cnt || "0");
        if (count === 0) {
          return; // Nothing to reconcile
        }

        // Call the reconcile endpoint directly (bypass auth)
        const http = require("http");
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

  // Register ShipStation SHIP_NOTIFY webhook (idempotent, non-blocking)
  setTimeout(async () => {
    try {
      if (services.shipStation.isConfigured()) {
        await services.shipStation.registerWebhook(
          "https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/shipstation/webhooks/ship-notify",
        );
      }
    } catch (err: any) {
      console.error(`[ShipStation] Webhook registration error: ${err.message}`);
    }
  }, 15_000);

  // Shopify Bridge — backfill existing orders to OMS (runs once at startup, non-blocking)
  setTimeout(async () => {
    try {
      await backfillShopifyOrders(db, services.oms, 500);
    } catch (err: any) {
      console.error("[Shopify Bridge] Backfill error:", err.message);
    }
  }, 10_000);

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
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
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      
      // Start listening for new orders in shopify_orders table
      setupOrderSyncListener();
    },
  );
})();

  // eBay order reconciliation — check for stuck orders every 4 hours
  setInterval(async () => {
    try {
      const { sql } = require("drizzle-orm");
      // Find eBay OMS orders stuck in "confirmed" for > 48 hours
      const stuckOrders = await db.execute(sql`
        SELECT o.id, o.external_order_id, o.order_number
        FROM oms_orders o
        WHERE o.channel_id = 67
          AND o.status = 'confirmed'
          AND o.created_at < NOW() - INTERVAL '48 hours'
        LIMIT 50
      `);
      if (stuckOrders.rows.length === 0) return;

      console.log(`[eBay Reconcile] Found ${stuckOrders.rows.length} stuck orders, checking ShipStation...`);
      const ss = services.shipStation;
      if (!ss?.isConfigured()) return;

      for (const order of stuckOrders.rows) {
        try {
          // Check ShipStation for this order
          const ssOrders = await ss.findOrderByNumber(`EB-${order.order_number || order.external_order_id}`);
          if (ssOrders?.length > 0 && ssOrders[0].orderStatus === "shipped") {
            const shipment = ssOrders[0];
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
