import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import cookieParser from "cookie-parser";
import { timingSafeEqual } from "crypto";
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
import { startDropshipListingPushWorker } from "./modules/dropship/infrastructure/dropship-listing-push-job-runner";
import { startDropshipOrderProcessingWorker } from "./modules/dropship/infrastructure/dropship-order-processing-runner";
import { startDropshipEbayOrderIntakeWorker } from "./modules/dropship/infrastructure/dropship-ebay-order-intake-runner";
import { setDropshipFulfillmentSync } from "./modules/dropship/infrastructure/dropship-fulfillment-sync.registry";
import { startFulfillmentSweeper } from "./modules/oms/fulfillment-sweeper.scheduler";
import { startCycleCountFreezeGuard } from "./modules/inventory/cycle-count-freeze-guard.scheduler";
import { startOmsFlowReconciliationScheduler } from "./modules/oms/oms-flow-reconciliation.service";
import { startOmsOpsAlertScheduler } from "./modules/oms/oms-ops-alert.service";
import {
  startWebhookRetryWorker,
  enqueueShipStationRetry,
  enqueueDelayedTrackingPush,
  enqueueShipStationSortRankSyncRetry,
} from "./modules/oms/webhook-retry.worker";
import { createEbayOrderWebhookHandler, reingestEbayOrder } from "./modules/oms/ebay-order-ingestion";
import { registerOmsWebhooks } from "./modules/oms/oms-webhooks";
import { startShopifyBridgeListener } from "./modules/oms/shopify-bridge";
import { eq, and, sql } from "drizzle-orm";
import { dispatchShipmentEvent, recomputeOrderStatusFromShipments } from "./modules/orders/shipment-rollup";
import { cancelOrder, markOrderShipped, completeOrder } from "./modules/orders/order-status-core";
import { engineRefFromRow, toEngineRef } from "./modules/shipping";
import { deriveReconcileEvent } from "./modules/shipping/reconcile-derive";
import type { SafeUser } from "@shared/schema";
import { channels as channelsTable, syncLog as syncLogTable } from "@shared/schema";
import { pool as dbPool } from "./db";
import * as http from "http";
import { createEbayAuthConfig, EbayAuthService } from "./modules/channels/adapters/ebay/ebay-auth.service";
import { createEbayApiClient } from "./modules/channels/adapters/ebay/ebay-api.client";
import { requireAuth } from "./routes/middleware";
import {
  envPositiveInteger,
  getSchedulerDisableReason,
  schedulerIsDisabled,
} from "./infrastructure/scheduler-config";
import { reportError, runWithContext } from "./platform/observability";

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

// Per-request correlation context via AsyncLocalStorage.
// Reads x-request-id from upstream (load balancer) or generates one.
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers["x-request-id"] as string) ?? require("node:crypto").randomUUID();
  res.setHeader("x-correlation-id", correlationId);
  runWithContext({ correlationId }, () => next());
});

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

sessionPool.on("error", (error) => {
  console.error("[SessionDatabasePool] Unexpected idle client error:", error);
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

function schedulersDisabled(disableEnvName?: string): boolean {
  return schedulerIsDisabled(disableEnvName);
}

function logSchedulerDisabled(source: string, name: string, disableEnvName?: string): boolean {
  const reason = getSchedulerDisableReason(disableEnvName);
  if (!reason) return false;
  log(`${name} disabled (${reason})`, source);
  return true;
}

let warnedMissingShipStationWebhookSecret = false;

function safeCompareSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function getShipStationWebhookCredential(req: Request): string | null {
  const bearer = req.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    return bearer.slice("bearer ".length).trim();
  }

  const headerSecret =
    req.get("x-shipstation-webhook-secret") ||
    req.get("x-shipstation-secret") ||
    req.get("x-webhook-secret");
  if (headerSecret) {
    return headerSecret.trim();
  }

  const querySecret = req.query.secret;
  if (typeof querySecret === "string") {
    return querySecret.trim();
  }

  const bodySecret = (req.body as any)?.secret;
  if (typeof bodySecret === "string") {
    return bodySecret.trim();
  }

  return null;
}

function verifyShipStationWebhook(req: Request): { ok: boolean; status: number; reason: string } {
  const expected = process.env.SHIPSTATION_WEBHOOK_SECRET?.trim();
  const mustVerify =
    process.env.NODE_ENV === "production" ||
    process.env.SHIPSTATION_WEBHOOK_SECRET_REQUIRED === "true";

  if (!expected) {
    if (mustVerify) {
      return {
        ok: false,
        status: 503,
        reason: "SHIPSTATION_WEBHOOK_SECRET is required before accepting ShipStation webhooks",
      };
    }

    if (!warnedMissingShipStationWebhookSecret) {
      warnedMissingShipStationWebhookSecret = true;
      console.warn(
        "[ShipStation Webhook] SHIPSTATION_WEBHOOK_SECRET is not configured; accepting webhook only because production verification is not required",
      );
    }
    return { ok: true, status: 200, reason: "secret not configured outside production" };
  }

  const actual = getShipStationWebhookCredential(req);
  if (!actual || !safeCompareSecret(actual, expected)) {
    return { ok: false, status: 401, reason: "invalid ShipStation webhook credential" };
  }

  return { ok: true, status: 200, reason: "verified" };
}

function isAllowedShipStationResourceUrl(resourceUrl: string): boolean {
  try {
    const parsed = new URL(resourceUrl);
    return parsed.protocol === "https:" && parsed.hostname === "ssapi.shipstation.com";
  } catch {
    return false;
  }
}

function buildShipStationWebhookTargetUrl(targetUrl: string): string {
  const secret = process.env.SHIPSTATION_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return targetUrl;
  }

  const parsed = new URL(targetUrl);
  if (!parsed.searchParams.has("secret")) {
    parsed.searchParams.set("secret", secret);
  }
  return parsed.toString();
}

async function enqueueEbayReconcileTrackingRetry(orderId: number, reason: string): Promise<void> {
  try {
    await enqueueDelayedTrackingPush(db, orderId);
    console.warn(`[eBay Reconcile] ${reason} for ${orderId}; delayed retry enqueued`);
  } catch (enqueueErr: any) {
    console.error(`[eBay Reconcile] Failed to enqueue tracking retry for ${orderId}: ${enqueueErr.message}`);
  }
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
  if (logSchedulerDisabled("echelon-sync", "Echelon sync scheduler", "ECHELON_SYNC_SCHEDULER_DISABLED")) {
    return;
  }

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
  app.locals.db = db; // Provide db to routes that expect it
  // REMOVED: initOrderSyncServices deleted with order-sync-listener
  // initOrderSyncServices(services);

  // Start Echelon sync scheduler (replaces old channelSync scheduler)
  startEchelonSyncScheduler(services, db);

  // --- ShipStation SHIP_NOTIFY webhook (BEFORE auth middleware; shared-secret verified) ---
  app.post("/api/shipstation/webhooks/ship-notify", async (req, res) => {
    const { resource_url, resource_type } = req.body || {};
    const verification = verifyShipStationWebhook(req);
    if (!verification.ok) {
      console.warn(`[ShipStation Webhook] Rejected SHIP_NOTIFY: ${verification.reason}`);
      return res.status(verification.status).json({ error: "Unauthorized webhook" });
    }

    if (resource_type !== "SHIP_NOTIFY" || !resource_url || typeof resource_url !== "string") {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }
    if (!isAllowedShipStationResourceUrl(resource_url)) {
      console.warn("[ShipStation Webhook] Rejected invalid resource_url host");
      return res.status(400).json({ error: "Invalid webhook resource_url" });
    }

    try {
      console.log(`[ShipStation Webhook] Received SHIP_NOTIFY`);
      const processed = await services.shippingEngine.processWebhook(resource_url);
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
  }, services.shipStation, services.wmsSync, services.shippingEngine);

  // Wire fulfillment push into ShipStation service for tracking push on ship notify
  (db as any).__fulfillmentPush = services.fulfillmentPush;

  // Stash ShipStation service for the webhook-retry worker to pick up
  // (mirrors the __fulfillmentPush pattern — keeps the scheduler start
  // surface free of service threading).
  (db as any).__shipStationService = services.shipStation;
  (db as any).__shippingEngine = services.shippingEngine;
  (db as any).__wmsSyncService = services.wmsSync;

  // Inject ShipStation service into eBay ingestion for auto-push
  setShipStationService(services.shipStation);
  setWmsServices({
    reservation: services.reservation,
    fulfillmentRouter: services.fulfillmentRouter,
    slaMonitor: services.slaMonitor,
  });
  setDropshipFulfillmentSync(services.wmsSync);

  // Start eBay Order Polling (5-min safety net — NON-NEGOTIABLE)
  try {
    const ebayConfig = createEbayAuthConfig();
    const ebayAuthService = new EbayAuthService(db, ebayConfig);
    const ebayApiClient = createEbayApiClient(ebayAuthService, 67);

    // Wire eBay client into fulfillment push service for tracking push
    services.fulfillmentPush.setEbayClient(ebayApiClient);

    // Wire WMS sync service into eBay ingestion
    setWmsSyncService(services.wmsSync);
    (db as any).__ebayWebhookReplay = {
      omsService: services.oms,
      ebayApiClient,
      reingestEbayOrder,
    };

    if (!schedulersDisabled("EBAY_ORDER_POLLING_DISABLED")) {
      startEbayOrderPolling(services.oms, ebayApiClient);
    } else {
      logSchedulerDisabled("oms", "eBay order polling", "EBAY_ORDER_POLLING_DISABLED");
    }

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

  // Dropship V2 vendor eBay intake now polls connected vendor stores into the dropship order intake pipeline.
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

        const internalApiKey = process.env.INTERNAL_API_KEY;
        if (!internalApiKey) {
          console.warn("[eBay Reconcile] Skipping scheduled listing reconciliation: INTERNAL_API_KEY is not configured");
          return;
        }

        // Call the reconcile endpoint through the same internal API contract used by other workers.
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
            "Authorization": `Bearer ${internalApiKey}`,
          },
        };

        await new Promise<void>((resolve, reject) => {
          const req = http.request(options, (res: any) => {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
              if (res.statusCode < 200 || res.statusCode >= 300) {
                console.warn(
                  `[eBay Reconcile] Scheduled endpoint returned ${res.statusCode}: ${body.slice(0, 300)}`,
                );
                resolve();
                return;
              }

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

  if (!schedulersDisabled("EBAY_LISTING_RECONCILE_DISABLED")) {
    // Start after 2 minutes (let server settle), then every 30 min
    setTimeout(() => {
      runEbayReconciliation();
      setInterval(runEbayReconciliation, RECONCILE_INTERVAL_MS);
      log("[eBay Reconcile] Scheduled reconciliation started (every 30 min)", "ebay-reconcile");
    }, 2 * 60 * 1000);
  } else {
    logSchedulerDisabled("ebay-reconcile", "eBay listing reconciliation", "EBAY_LISTING_RECONCILE_DISABLED");
  }

  // Register ShipStation SHIP_NOTIFY webhook if environment variables are configured (idempotent, non-blocking)
  if (!schedulersDisabled("SHIPSTATION_WEBHOOK_REGISTRATION_DISABLED")) {
    setTimeout(async () => {
      try {
        const webhookUrl = process.env.SHIPSTATION_WEBHOOK_URL;
        if (services.shippingEngine.isConfigured() && webhookUrl) {
          await services.shippingEngine.registerWebhook(
            buildShipStationWebhookTargetUrl(webhookUrl),
          );
        } else if (services.shippingEngine.isConfigured() && !webhookUrl) {
          console.log(`[ShipStation] Skipping webhook registration - SHIPSTATION_WEBHOOK_URL unset.`);
        }
      } catch (err: any) {
        console.error(`[ShipStation] Webhook registration error: ${err.message}`);
      }
    }, 15_000);
  } else {
    const reason = getSchedulerDisableReason("SHIPSTATION_WEBHOOK_REGISTRATION_DISABLED");
    console.log(`[ShipStation] Webhook registration disabled (${reason}).`);
  }

  // Sync Recovery — unified gap-recovery orchestrator. Runs every 10 min and
  // closes the full pipeline Shopify → shopify_orders → OMS → WMS. Replaces the
  // old one-shot boot-time backfill.
  if (!schedulersDisabled("SYNC_RECOVERY_SCHEDULER_DISABLED") && services.syncRecovery) {
    services.syncRecovery.startScheduled(
      envPositiveInteger("SYNC_RECOVERY_INTERVAL_MINUTES", 15),
      envPositiveInteger("SYNC_RECOVERY_INITIAL_DELAY_MS", 120_000),
    );
  } else if (schedulersDisabled("SYNC_RECOVERY_SCHEDULER_DISABLED")) {
    const reason = getSchedulerDisableReason("SYNC_RECOVERY_SCHEDULER_DISABLED");
    console.log(`[SyncRecovery] Scheduled recovery disabled (${reason}).`);
  }

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    reportError(err, { action: "global_error_handler", context: { status } });
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
    const res = await db.execute(sql`SELECT id, product_variant_id, warehouse_location_id, variant_qty FROM inventory.inventory_levels WHERE variant_qty < 0`);
    if ((res as any).rows.length > 0) {
      console.warn(`[Startup Warning] Found ${(res as any).rows.length} negative inventory levels. They have NOT been cleared.`);
    }

    // P1-18 extracted: Startup fix for dangling completed items has been moved to scripts/backfill/fix-dangling-order-items.ts
  } catch (err) {
    console.error("[Startup Fix] Failed to clear negative inventory balances or dangling items", err);
  }

  // Crash handlers — surface unhandled errors instead of silent death.
  process.on("unhandledRejection", (reason) => {
    reportError(reason, { action: "unhandled_rejection" });
  });
  process.on("uncaughtException", (err) => {
    reportError(err, { action: "uncaught_exception" });
  });

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
      initReconciliation(services.oms, services.wmsSync);
      if (!schedulersDisabled("SHOPIFY_RECONCILIATION_SCHEDULER_DISABLED")) {
        startShopifyReconciliation();
      } else {
        logSchedulerDisabled("scheduler", "Shopify order reconciliation", "SHOPIFY_RECONCILIATION_SCHEDULER_DISABLED");
      }

      if (!schedulersDisabled("SHOPIFY_BRIDGE_LISTENER_DISABLED")) {
        // Hook up continuous Shopify Bridge listener (M18)
        startShopifyBridgeListener(db, services.oms);
      } else {
        logSchedulerDisabled("scheduler", "Shopify bridge listener", "SHOPIFY_BRIDGE_LISTENER_DISABLED");
      }

      if (!schedulersDisabled("BILLING_SCHEDULER_DISABLED")) {
        // Start subscription billing scheduler (runs hourly)
        startBillingScheduler();
      } else {
        logSchedulerDisabled("scheduler", "Billing scheduler", "BILLING_SCHEDULER_DISABLED");
      }

      // Start webhook DLQ recovery worker
      if (!schedulersDisabled("WEBHOOK_RETRY_WORKER_DISABLED")) {
        startWebhookRetryWorker();
      } else {
        logSchedulerDisabled("scheduler", "Webhook retry worker", "WEBHOOK_RETRY_WORKER_DISABLED");
      }

      if (!schedulersDisabled("FULFILLMENT_SWEEPER_DISABLED")) {
        startFulfillmentSweeper(db);
      } else {
        logSchedulerDisabled("scheduler", "Fulfillment sweeper", "FULFILLMENT_SWEEPER_DISABLED");
      }

      if (!schedulersDisabled("CYCLE_COUNT_FREEZE_GUARD_DISABLED")) {
        startCycleCountFreezeGuard(db);
      } else {
        logSchedulerDisabled("scheduler", "Cycle-count freeze guard", "CYCLE_COUNT_FREEZE_GUARD_DISABLED");
      }

      if (!schedulersDisabled("OMS_FLOW_RECONCILIATION_SCHEDULER_DISABLED")) {
        startOmsFlowReconciliationScheduler(db);
      } else {
        logSchedulerDisabled("scheduler", "OMS flow reconciliation scheduler", "OMS_FLOW_RECONCILIATION_SCHEDULER_DISABLED");
      }

      if (!schedulersDisabled("OMS_OPS_ALERT_SCHEDULER_DISABLED")) {
        startOmsOpsAlertScheduler(db);
      } else {
        logSchedulerDisabled("scheduler", "OMS ops alert scheduler", "OMS_OPS_ALERT_SCHEDULER_DISABLED");
      }

      if (!schedulersDisabled()) {
        startDropshipListingPushWorker();
        startDropshipOrderProcessingWorker();
        startDropshipEbayOrderIntakeWorker();
      } else {
        logSchedulerDisabled("scheduler", "Dropship workers");
      }
    }
  );

  // eBay order reconciliation — check for stuck orders every 4 hours
  if (!schedulersDisabled("EBAY_FULFILLMENT_RECONCILE_DISABLED")) {
    const runEbayReconcile = async () => {
      try {
        const engine = services.shippingEngine;
        if (!engine?.isConfigured()) return;

        // Find eBay OMS orders stuck in "confirmed" for > 2 hours,
        // joining through WMS to get engine columns from outbound_shipments.
        const stuckOrders = await db.execute(sql`
          SELECT DISTINCT ON (o.id)
                 o.id, o.external_order_id, o.external_order_number,
                 o.shipstation_order_id AS oms_shipstation_order_id,
                 os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
                 os.shipstation_order_id, os.shipstation_order_key
          FROM oms.oms_orders o
          LEFT JOIN wms.orders w ON w.oms_fulfillment_order_id = o.id::text
          LEFT JOIN wms.outbound_shipments os ON os.order_id = w.id
            AND os.status NOT IN ('cancelled', 'voided')
          WHERE o.channel_id = 67
            AND o.status = 'confirmed'
            AND o.created_at < NOW() - INTERVAL '2 hours'
          ORDER BY o.id, os.engine_order_ref NULLS LAST
          LIMIT 50
        `);
        if (stuckOrders.rows.length === 0) return;

        console.log(`[eBay Reconcile] Found ${stuckOrders.rows.length} stuck orders, checking engine...`);

        for (const order of stuckOrders.rows) {
          try {
            let ref = engineRefFromRow(order);
            if (!ref && order.oms_shipstation_order_id) {
              ref = toEngineRef(Number(order.oms_shipstation_order_id));
            }
            if (!ref) {
              console.warn(`[eBay Reconcile] No engine ref for OMS order ${order.id} — skipping`);
              continue;
            }

            const engineState = await engine.getState(ref);
            if (engineState && engineState.status === "shipped") {
              await db.execute(sql`
                UPDATE oms.oms_orders SET status = 'shipped',
                  tracking_number = ${engineState.trackingNumber || null},
                  tracking_carrier = ${engineState.carrier || null},
                  shipped_at = NOW(),
                  updated_at = NOW()
                WHERE id = ${order.id}
              `);
              console.log(`[eBay Reconcile] Auto-shipped OMS order ${order.id} (${order.external_order_id})`);

              // Push tracking to eBay
              try {
                // @ts-ignore
                const pushed = await services.fulfillmentPush.pushTracking(order.id);
                if (pushed === false) {
                  await enqueueEbayReconcileTrackingRetry(Number(order.id), "Tracking push returned false");
                }
              } catch (e: any) {
                console.warn(`[eBay Reconcile] Tracking push failed for ${order.id}: ${e.message}`);
                await enqueueEbayReconcileTrackingRetry(Number(order.id), "Tracking push failed");
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
    };
    
    // Run immediately on boot, then every hour
    setTimeout(runEbayReconcile, 5000);
    setInterval(runEbayReconcile, 1 * 60 * 60 * 1000);
  } else {
    logSchedulerDisabled("ebay-reconcile", "eBay fulfillment reconciliation", "EBAY_FULFILLMENT_RECONCILE_DISABLED");
  }

  // OMS<->WMS reconciliation — catches webhook delivery failures where
  // an OMS order got cancelled/shipped/refunded but the WMS row is
  // still sitting in ready/in_progress. Hourly sweep.
  if (!schedulersDisabled("OMS_WMS_RECONCILE_DISABLED")) {
    const runOmsWmsReconcile = async () => {
      try {
        const divergent: any = await db.execute(sql`
          SELECT w.id, w.order_number, oms.status AS oms_status
          FROM wms.orders w
          JOIN oms.oms_orders oms ON (
                  (w.source = 'oms'     AND w.oms_fulfillment_order_id = oms.id::text)
              OR  (w.source = 'shopify' AND w.source_table_id = oms.id::text)
                )
          WHERE oms.status IN ('cancelled', 'shipped', 'refunded')
            AND w.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship', 'completed')
        `);
        const corrected: any[] = [];
        for (const row of divergent.rows as any[]) {
          const transResult = row.oms_status === "shipped"
            ? await markOrderShipped(db, row.id, "oms_wms_reconcile")
            : await cancelOrder(db, row.id, "oms_wms_reconcile");
          if (transResult.transitioned) {
            await db.execute(sql`UPDATE wms.orders SET assigned_picker_id = NULL WHERE id = ${row.id}`);
            corrected.push(row);
          }
        }
        if (corrected.length > 0) {
          console.warn(`[OMS<->WMS Reconcile] Corrected ${corrected.length} divergent order(s):`,
            corrected.map((r: any) => `${r.order_number} (oms=${r.oms_status})`).join(", "));

          const cancelledIds = corrected
            .filter((r: any) => r.oms_status !== "shipped")
            .map((r: any) => r.id);
          if (cancelledIds.length > 0) {
            try {
              const ssRows: any = await db.execute(sql`
                SELECT os.id AS shipment_id, os.shipstation_order_id,
                       os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
                       os.shipstation_order_key
                FROM wms.outbound_shipments os
                WHERE os.order_id = ANY(${cancelledIds})
                  AND COALESCE(os.engine_order_ref, os.shipstation_order_id::text) IS NOT NULL
                  AND os.status NOT IN ('cancelled', 'shipped', 'voided', 'returned', 'lost')
                  AND os.shipped_at IS NULL  -- never cancel a shipment that already shipped (terminal)
              `);
              const engine = services.shippingEngine;
              if (engine?.isConfigured() && ssRows.rows.length > 0) {
                for (const row of ssRows.rows) {
                  try {
                    const ref = engineRefFromRow(row);
                    if (!ref) continue;
                    const cancelResult = await engine.cancel(ref);
                    if (cancelResult?.alreadyInState) {
                      await db.execute(sql`
                        UPDATE wms.outbound_shipments
                        SET status = 'shipped', updated_at = NOW()
                        WHERE id = ${row.shipment_id}
                          AND status NOT IN ('shipped', 'returned', 'lost')
                      `);
                      console.log(`[OMS<->WMS Reconcile] Engine order ${ref.engineOrderRef} already terminal — recorded shipped for shipment ${row.shipment_id}`);
                    } else {
                      await db.execute(sql`
                        UPDATE wms.outbound_shipments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                        WHERE id = ${row.shipment_id}
                      `);
                      console.log(`[OMS<->WMS Reconcile] Cancelled engine order ${ref.engineOrderRef} for shipment ${row.shipment_id}`);
                    }
                  } catch (ssErr: any) {
                    console.warn(`[OMS<->WMS Reconcile] Failed to cancel engine order for shipment ${row.shipment_id}: ${ssErr?.message}`);
                  }
                }
              }
            } catch (err: any) {
              console.warn("[OMS<->WMS Reconcile] SS cascade error:", err?.message);
            }
          }
        }
      } catch (err: any) {
        console.warn("[OMS<->WMS Reconcile] Sweep error:", err?.message);
      }
    };
    setTimeout(runOmsWmsReconcile, 15_000);
    setInterval(runOmsWmsReconcile, 60 * 60 * 1000);
  } else {
    logSchedulerDisabled("scheduler", "OMS WMS reconciliation", "OMS_WMS_RECONCILE_DISABLED");
  }

  // One-time data repair: shipped orders whose items were never completed
  // (caused by wms_order_id column-name bug in SHIP_NOTIFY legacy paths).
  // Also cancels orphaned planned/queued shipments for shipped orders so
  // they don't get re-pushed to ShipStation.
  setTimeout(async () => {
    try {
      const itemFix = await db.execute(sql`
        UPDATE wms.order_items oi SET
          status = 'completed',
          fulfilled_quantity = oi.quantity,
          picked_quantity = GREATEST(oi.picked_quantity, oi.quantity)
        FROM wms.orders o
        WHERE o.id = oi.order_id
          AND o.warehouse_status IN ('shipped', 'cancelled')
          AND oi.status NOT IN ('completed', 'short', 'cancelled')
        RETURNING oi.id
      `);
      if (itemFix.rows.length > 0) {
        console.warn(`[Data Repair] Completed ${itemFix.rows.length} orphaned item(s) on shipped/cancelled orders`);
      }
      const shipmentFix = await db.execute(sql`
        UPDATE wms.outbound_shipments os SET
          status = 'cancelled',
          cancelled_at = COALESCE(os.cancelled_at, NOW()),
          updated_at = NOW()
        FROM wms.orders o
        WHERE o.id = os.order_id
          AND o.warehouse_status IN ('shipped', 'cancelled')
          AND os.status IN ('planned', 'queued')
          AND os.shipped_at IS NULL  -- never cancel a shipment that already shipped (terminal)
        RETURNING os.id, os.order_id
      `);
      if (shipmentFix.rows.length > 0) {
        console.warn(`[Data Repair] Cancelled ${shipmentFix.rows.length} orphaned planned/queued shipment(s) on shipped/cancelled orders`);
      }
      // Zombie orders: active warehouse_status but no pending shippable items.
      // These get stuck in the pick queue forever because nothing triggers
      // their status transition.
      const zombieCandidates: any = await db.execute(sql`
        SELECT o.id, o.order_number,
          CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM wms.order_items ai WHERE ai.order_id = o.id
            ) THEN 'cancelled'
            WHEN EXISTS (
              SELECT 1 FROM wms.order_items ai
              WHERE ai.order_id = o.id
                AND ai.status NOT IN ('cancelled')
            ) THEN 'completed'
            ELSE 'cancelled'
          END AS target_status
        FROM wms.orders o
        WHERE o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
          AND NOT EXISTS (
            SELECT 1 FROM wms.order_items oi
            WHERE oi.order_id = o.id
              AND COALESCE(oi.requires_shipping, 1) <> 0
              AND COALESCE(oi.quantity, 0) > 0
              AND oi.status NOT IN ('cancelled', 'completed', 'short')
          )
      `);
      const zombieFixed: string[] = [];
      for (const row of zombieCandidates.rows as any[]) {
        const result = row.target_status === "cancelled"
          ? await cancelOrder(db, row.id, "zombie_data_repair")
          : await completeOrder(db, row.id, "zombie_data_repair");
        if (result.transitioned) {
          zombieFixed.push(`${row.order_number}→${row.target_status}`);
        }
      }
      if (zombieFixed.length > 0) {
        console.warn(`[Data Repair] Transitioned ${zombieFixed.length} zombie order(s) with no pending items:`,
          zombieFixed.join(', '));
      }
    } catch (err: any) {
      console.warn("[Data Repair] Shipped-order cleanup error:", err?.message);
    }
  }, 12_000);

  // One-time duplicate shipment cleanup: for each order with multiple
  // active shipments, keep the one furthest along and cancel the rest.
  // Also cancels the duplicate in ShipStation if it has a SS order ID.
  //
  // DISABLED 2026-06-15. This job conflated legitimate SPLIT shipments (one
  // order legitimately ships as multiple packages) with duplicates: it ranks
  // shipments per order and cancels all but one — and its candidate set
  // INCLUDED already-shipped shipments. That cancelled 606 shipments that had
  // already shipped (shipped_at + tracking set), with a null voided_reason,
  // making their units look un-shipped (root cause of the stale-partial /
  // "lost order" symptoms). A shipped shipment is TERMINAL and must never be
  // cancelled. True duplicate-SS-order prevention belongs at shipment-creation
  // time (idempotency key), not a destructive boot-time sweep — see the
  // fulfillment-state redesign. Gated off by default; set
  // ENABLE_DUP_SHIPMENT_CLEANUP=true only to force a (still-unsafe) run.
  setTimeout(async () => {
    if (process.env.ENABLE_DUP_SHIPMENT_CLEANUP !== "true") {
      return;
    }
    try {
      const dupes = await db.execute(sql`
        WITH ranked AS (
          SELECT
            os.id,
            os.order_id,
            os.status,
            os.shipstation_order_id,
            os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
            os.shipstation_order_key,
            ROW_NUMBER() OVER (
              PARTITION BY os.order_id
              ORDER BY CASE os.status
                WHEN 'shipped'  THEN 0
                WHEN 'labeled'  THEN 1
                WHEN 'queued'   THEN 2
                WHEN 'planned'  THEN 3
                ELSE 5
              END,
              os.created_at ASC
            ) AS rn
          FROM wms.outbound_shipments os
          WHERE os.status NOT IN ('voided', 'cancelled')
        )
        SELECT id, order_id, status,
               shipping_engine, engine_order_ref, engine_shipment_ref,
               shipstation_order_id, shipstation_order_key
        FROM ranked
        WHERE rn > 1
      `);
      if (dupes.rows.length > 0) {
        const engine = services.shippingEngine;
        for (const row of dupes.rows as any[]) {
          await db.execute(sql`
            UPDATE wms.outbound_shipments
            SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
            WHERE id = ${row.id}
          `);
          const ref = engineRefFromRow(row);
          if (ref && engine?.isConfigured()) {
            try {
              await engine.cancel(ref);
            } catch (ssErr: any) {
              console.warn(`[Data Repair] Could not cancel engine order ${ref.engineOrderRef}: ${ssErr?.message}`);
            }
          }
        }
        console.warn(
          `[Data Repair] Cancelled ${dupes.rows.length} duplicate shipment(s):`,
          (dupes.rows as any[]).map((r: any) => `shipment ${r.id} (order ${r.order_id}, status=${r.status})`).join(', '),
        );
      }
    } catch (err: any) {
      console.warn("[Data Repair] Duplicate shipment cleanup error:", err?.message);
    }
  }, 15_000);

  // One-time sort_rank recompute for active orders (formula changed from
  // relative-to-sync-time SLA to absolute-deadline encoding).
  setTimeout(async () => {
    try {
      const { recomputeAllActiveSortRanksDetailed } = await import("./modules/orders/orders.storage");
      const { updated, orderIds } = await recomputeAllActiveSortRanksDetailed();
      if (updated > 0) {
        console.log(`[Sort-Rank] Recomputed sort_rank for ${updated} active order(s)`);
        for (const orderId of orderIds) {
          await enqueueShipStationSortRankSyncRetry(
            db,
            orderId,
            "startup sort_rank recompute",
          );
        }
        console.log(`[Sort-Rank] Queued ShipStation customField1 sync for ${orderIds.length} active order(s)`);
      }
    } catch (err: any) {
      console.warn("[Sort-Rank] Recompute error:", err?.message);
    }
  }, 20_000);

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
  if (!schedulersDisabled("SHIPSTATION_RECONCILE_DISABLED")) {

    // ── V2: shipment-based reconcile ────────────────────────────────────
    const runShipStationReconcileV2 = async () => {
      try {
        const engine = services.shippingEngine;
        if (!engine?.isConfigured()) return;

        // Select active shipments that have been pushed to ShipStation and
        // haven't been checked recently. last_reconciled_at IS NULL rows
        // come first so new shipments are verified promptly.
        const rows: any = await db.execute(sql`
          SELECT os.id AS shipment_id, os.order_id,
                 os.shipstation_order_id, os.status AS wms_shipment_status,
                 os.tracking_number, os.carrier,
                 os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
                 os.shipstation_order_key,
                 w.order_number,
                 w.oms_fulfillment_order_id AS oms_id
          FROM wms.outbound_shipments os
          JOIN wms.orders w ON w.id = os.order_id
          WHERE COALESCE(os.engine_order_ref, os.shipstation_order_id::text) IS NOT NULL
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
          const ref = engineRefFromRow(row);
          try {
            if (!ref) {
              console.warn(
                `[Reconcile V2] No engine ref for shipment ${shipmentId} — skipping`,
              );
              continue;
            }

            // 1. Fetch engine order state + shipments
            const engineState = await engine.getState(ref);
            if (!engineState) {
              console.warn(
                `[Reconcile V2] Engine order ${ref.engineOrderRef} not found (shipment=${shipmentId}) — skipping`,
              );
              continue;
            }

            const canonicalShipments = await engine.getShipments(ref);

            // 2. Derive reconcile event from canonical types
            let event: { kind: string; [key: string]: any } | null =
              deriveReconcileEvent({
                engineState,
                currentWmsShipmentStatus: row.wms_shipment_status,
                currentTrackingNumber: row.tracking_number,
                currentCarrier: row.carrier,
                shipments: canonicalShipments,
              });

            // 3. Push WMS shipped/cancelled status outward when engine has drifted.
            if (!event) {
              if (
                engineState.status !== "shipped" &&
                row.wms_shipment_status === "shipped"
              ) {
                await engine.markShipped(ref, {
                  shipDate: new Date(),
                  trackingNumber: row.tracking_number || "",
                  carrierCode: row.carrier || "other",
                  notifyCustomer: false,
                });
                console.log(`[Reconcile V2] Outbound sync: marked engine order ${ref.engineOrderRef} shipped`);
                markedShipped++;

                await db.execute(sql`
                  UPDATE wms.outbound_shipments
                  SET last_reconciled_at = NOW()
                  WHERE id = ${shipmentId}
                `);
                continue;
              } else if (
                engineState.status !== "cancelled" &&
                row.wms_shipment_status === "cancelled"
              ) {
                const cancelResult = await engine.cancel(ref);
                if (cancelResult?.alreadyInState) {
                  await db.execute(sql`
                    UPDATE wms.outbound_shipments
                    SET status = 'shipped', last_reconciled_at = NOW(), updated_at = NOW()
                    WHERE id = ${shipmentId}
                      AND status NOT IN ('shipped', 'returned', 'lost')
                  `);
                  console.log(`[Reconcile V2] Outbound sync: engine order ${ref.engineOrderRef} already terminal — recorded shipped`);
                  markedShipped++;
                } else {
                  console.log(`[Reconcile V2] Outbound sync: cancelled engine order ${ref.engineOrderRef}`);
                  markedCancelled++;
                  await db.execute(sql`
                    UPDATE wms.outbound_shipments
                    SET last_reconciled_at = NOW()
                    WHERE id = ${shipmentId}
                  `);
                }
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

            // 4. Dispatch via shipment-rollup helpers. Thread the
            //    fulfillment-push handle so a reconcile-driven re-ship
            //    converges Shopify tracking too (void→re-ship heal /
            //    CHANNEL_TRACKING_STALE), matching the SHIP_NOTIFY path.
            const { wmsOrderId, changed } = await dispatchShipmentEvent(
              db,
              shipmentId,
              event as any,
              { fulfillmentPush: (db as any).__fulfillmentPush },
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
              if (row.oms_id && row.oms_id.match(/^[0-9]+$/)) {
                const omsId = Number(row.oms_id);
                if (event.kind === "shipped") {
                  const nextOmsStatus =
                    rollup.warehouseStatus === "partially_shipped"
                      ? "partially_shipped"
                      : "shipped";
                  const nextFulfillmentStatus =
                    nextOmsStatus === "partially_shipped" ? "partial" : "fulfilled";
                  await db.execute(sql`
                    UPDATE oms.oms_orders SET
                      status = ${nextOmsStatus},
                      fulfillment_status = ${nextFulfillmentStatus},
                      tracking_number = ${event.trackingNumber},
                      tracking_carrier = ${event.carrier},
                      shipped_at = ${event.shipDate},
                      updated_at = NOW()
                    WHERE id = ${omsId}
                  `);
                  await db.execute(sql`
                    WITH shipped_by_line AS (
                      SELECT
                        wi.oms_order_line_id AS oms_order_line_id,
                        SUM(COALESCE(si.qty, 0))::int AS shipped_qty
                      FROM wms.outbound_shipment_items si
                      JOIN wms.outbound_shipments os ON os.id = si.shipment_id
                      JOIN wms.order_items wi ON wi.id = si.order_item_id
                      WHERE os.order_id = ${row.order_id}
                        AND os.status IN ('shipped', 'returned', 'lost')
                        AND wi.oms_order_line_id IS NOT NULL
                      GROUP BY wi.oms_order_line_id
                    ),
                    line_status AS (
                      SELECT
                        ol.id AS oms_order_line_id,
                        CASE
                          WHEN COALESCE(s.shipped_qty, 0) >= COALESCE(ol.quantity, 0) THEN 'fulfilled'
                          WHEN COALESCE(s.shipped_qty, 0) > 0 THEN 'partial'
                          ELSE 'unfulfilled'
                        END AS next_status
                      FROM oms.oms_order_lines ol
                      LEFT JOIN shipped_by_line s ON s.oms_order_line_id = ol.id
                      WHERE ol.order_id = ${omsId}
                    )
                    UPDATE oms.oms_order_lines ol
                    SET fulfillment_status = line_status.next_status,
                        updated_at = NOW()
                    FROM line_status
                    WHERE ol.id = line_status.oms_order_line_id
                  `);
                  markedShipped++;

                  // Push tracking to channels through the delayed retry worker.
                  // eBay tracking validation is asynchronous; the worker also
                  // supports shipment-scoped pushes for split shipments.
                  try {
                    await enqueueDelayedTrackingPush(db, omsId, shipmentId);
                  } catch (pushErr: any) {
                    console.error(`[ShipStation Reconcile V2] Failed to enqueue tracking push for order ${omsId}, shipment ${shipmentId}:`, pushErr.message);
                  }
                } else if (event.kind === "cancelled") {
                  await db.execute(sql`
                    UPDATE oms.oms_orders SET
                      status = 'cancelled',
                      updated_at = NOW()
                    WHERE id = ${omsId}
                  `);
                  markedCancelled++;
                } else if (event.kind === "voided") {
                  markedVoided++;
                }
              }

              // Record audit event
              if (row.oms_id && row.oms_id.match(/^[0-9]+$/)) {
                const omsId = Number(row.oms_id);
                try {
                  await db.execute(sql`
                    INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
                    VALUES (
                      ${omsId},
                      ${event.kind === "shipped"
                        ? "shipped_via_shipstation"
                        : event.kind === "cancelled"
                          ? "cancelled_via_shipstation"
                          : "voided_via_shipstation"},
                      ${JSON.stringify({
                        wmsShipmentId: shipmentId,
                        engineOrderRef: ref.engineOrderRef,
                        ...(event.kind === "shipped"
                          ? { trackingNumber: event.trackingNumber, carrier: event.carrier }
                          : { reason: (event as any).reason }),
                      })}::jsonb,
                      NOW()
                    )
                  `);
                } catch (auditErr: any) {
                  console.warn(
                    `[ShipStation Reconcile V2] audit insert failed for order ${omsId}:`,
                    auditErr?.message,
                  );
                }
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
            console.warn(
              `[Reconcile V2] Failed to reconcile order ${row.order_id} / engineRef ${ref?.engineOrderRef}:`,
              err?.message,
            );
            const errMsg = String(err?.message || err).slice(0, 255);
            // A transient DB connection/pool timeout means we couldn't CHECK this shipment
            // this run — it's infra, not a shipment problem. Don't flag it for human review
            // (and don't attempt another DB write that would also fail); the next sweep
            // retries. Only a genuine reconcile failure gets a review flag.
            const isTransientDbError = /timeout exceeded when trying to connect|connection terminated|ECONNRESET|too many clients|Client has encountered a connection error/i.test(errMsg);
            if (!isTransientDbError) {
              await db.execute(sql`
                UPDATE wms.outbound_shipments
                SET last_reconciled_at = NOW(),
                    requires_review = true,
                    review_reason = ${errMsg}
                WHERE id = ${shipmentId}
              `);
            }
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
        if (!services.shippingEngine?.isConfigured()) return;

        const rows: any = await db.execute(sql`
          SELECT w.id AS wms_id, w.order_number AS wms_order_number,
                 w.warehouse_status, w.completed_at, w.tracking_number,
                 o.id AS oms_id, o.status AS oms_status,
                 o.shipping_engine, o.engine_order_ref,
                 o.shipstation_order_id, o.shipstation_reconciled_at,
                 o.tracking_carrier
          FROM wms.orders w
          JOIN oms.oms_orders o ON (
                 (w.oms_fulfillment_order_id ~ '^[0-9]+$'
                    AND o.id = w.oms_fulfillment_order_id::int)
              OR (w.oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'
                    AND o.external_order_id = w.oms_fulfillment_order_id)
          )
          WHERE COALESCE(o.engine_order_ref, o.shipstation_order_id::text) IS NOT NULL
            AND w.warehouse_status IN ('shipped', 'cancelled')
            AND (o.shipstation_reconciled_at IS NULL OR o.shipstation_reconciled_at < w.completed_at)
          ORDER BY w.updated_at DESC
          LIMIT 1000
        `);

        if (!rows.rows?.length) return;

        let markedShipped = 0;
        let skippedCancelled = 0;
        for (const row of rows.rows) {
          try {
            const v1Ref = engineRefFromRow(row) ?? toEngineRef(Number(row.shipstation_order_id));
            if (row.warehouse_status === 'shipped') {
              await services.shippingEngine.markShipped(v1Ref, {
                shipDate: row.completed_at || new Date(),
                trackingNumber: row.tracking_number || null,
                carrierCode: row.tracking_carrier?.toLowerCase() || 'other',
                notifyCustomer: false,
              });
              markedShipped++;
            } else {
              const cancelResult = await services.shippingEngine.cancel(v1Ref);
              if (cancelResult?.alreadyInState) {
                markedShipped++;
              } else {
                skippedCancelled++;
              }
            }
            await db.execute(sql`
              UPDATE oms.oms_orders SET shipstation_reconciled_at = NOW() WHERE id = ${row.oms_id}
            `);
            await new Promise(r => setTimeout(r, 1000));
          } catch (err: any) {
            console.warn(`[ShipStation Reconcile V1] Failed for OMS ${row.oms_id}:`, err?.message);
          }
        }
        if (markedShipped || skippedCancelled) {
          console.warn(`[ShipStation Reconcile V1] Swept ${rows.rows.length} divergent order(s): ${markedShipped} marked shipped, ${skippedCancelled} skipped cancelled`);
        }
      } catch (err: any) {
        console.warn("[ShipStation Reconcile V1] Sweep error:", err?.message);
      }
    };

    // Schedule: V2 when flag is ON, V1 otherwise.
    const runShipStationReconcile = async () => {
      if (process.env.RECONCILE_V2 === "true") {
        await runShipStationReconcileV2();

        // Run the engine queue sweeper (review-only — flags stranded orders).
        const engine = services.shippingEngine;
        await engine?.sweepQueue?.().catch((e: any) => console.warn("[Engine Sweeper] error:", e.message));
      } else {
        await runShipStationReconcileV1();
      }
    };

    setTimeout(runShipStationReconcile, 30_000);
    setInterval(runShipStationReconcile, 10 * 60 * 1000); // Every 10 minutes
  } else {
    logSchedulerDisabled("scheduler", "ShipStation reconciliation", "SHIPSTATION_RECONCILE_DISABLED");
  }
})();
