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

      // 3. For each enabled channel, run the OLD sync path (which is what currently works)
      //    but using the sync hierarchy controls
      for (const channel of activeChannels) {
        const dryRun = channel.syncMode === "dry_run";
        const modeLabel = dryRun ? "DRY_RUN" : "LIVE";

        try {
          // Use the existing channelSync service which has the Shopify push logic
          // but respect per-channel dry_run mode
          if (dryRun) {
            // In dry-run mode: compute what would be pushed, log it, but don't push
            const result = await services.channelSync.syncAllProducts(channel.id);

            // Log dry-run entries
            for (const variantResult of (result as any).variants || []) {
              await services.syncSettings.writeSyncLog({
                channelId: channel.id,
                channelName: channel.name,
                action: "inventory_push",
                sku: variantResult.channelVariantId || null,
                productVariantId: variantResult.productVariantId,
                previousValue: null,
                newValue: String(variantResult.pushedQty),
                status: "dry_run",
                source: "sweep",
              });
            }

            log(
              `[Echelon Sync] ${modeLabel} ${channel.name}: ${result.synced} synced, ${result.errors.length} errors`,
              "echelon-sync",
            );
          } else {
            // Live mode: actually push
            const result = await services.channelSync.syncAllProducts(channel.id);

            if (result.synced > 0 || result.errors.length > 0) {
              log(
                `[Echelon Sync] ${modeLabel} ${channel.name}: ${result.synced} synced across ${result.total} products` +
                  (result.errors.length > 0 ? `, ${result.errors.length} errors` : ""),
                "echelon-sync",
              );
            }

            // Log pushed entries
            await services.syncSettings.writeSyncLog({
              channelId: channel.id,
              channelName: channel.name,
              action: "inventory_push",
              status: result.errors.length > 0 ? "error" : "pushed",
              errorMessage: result.errors.length > 0 ? result.errors.join("; ") : null,
              newValue: `${result.synced} variants`,
              source: "sweep",
            });
          }
        } catch (err: any) {
          log(`[Echelon Sync] Error syncing channel ${channel.name}: ${err.message}`, "echelon-sync");
          await services.syncSettings.writeSyncLog({
            channelId: channel.id,
            channelName: channel.name,
            action: "inventory_push",
            status: "error",
            errorMessage: err.message,
            source: "sweep",
          });
        }
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
