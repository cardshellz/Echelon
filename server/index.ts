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
import { startEbayOrderPolling } from "./modules/oms/ebay-order-ingestion";
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
