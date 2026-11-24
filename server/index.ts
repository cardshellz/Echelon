import {
  createAccountNativeSummariesWorker,
  customerAccountServices,
} from "./modules/customer-account/runtime.api";
import {
  createCustomerReturnWorkflowWorker,
  startCustomerReturnWorkflowScheduler,
  type ReturnWorkflowReport,
} from "./modules/returns/runtime-workflow.api";
import { createChannelSyncBatchService } from "./channel-sync-batch.composition";
import { registerChannelSyncBatchRoutes } from "./modules/marketplace-listings/infrastructure/channel-sync-batch.routes";
import { createListingIntentPropagationService } from "./listing-intent-propagation.composition";
import { registerListingIntentPropagationRoutes } from "./modules/marketplace-listings/infrastructure/listing-intent-propagation.routes";
import { ebayListingSyncService } from './modules/channels/ebay-listing-sync.api';
import { startWalmartOrderPolling } from "./modules/channels/adapters/walmart/walmart-order-poll.service";
import { startWalmartStockConnectionWorker } from "./modules/channels/adapters/walmart/walmart-stock-connection.service";
import { startShopifyProductConnectionWorker } from "./modules/catalog/application/shopify-product-connection.worker";
import { createDefaultShopifyProductConnectionService } from "./services/shopify-product-connection";
import {
  createOrderEditService,
  registerOrderEditRoutes,
  startOrderEditScheduler,
} from "./modules/order-edits/runtime.api";
import { registerCustomerAccountRoutes } from "./modules/customer-account/routes.api";
import {
  createOrderActionProjectionWorker,
  startOrderActionProjectionScheduler,
  type OrderActionProjectionReport,
} from "./modules/customer-account/order-action-projection.api";
import { createPackageHistoryWorker, startPackageHistoryScheduler } from "./modules/shipping/package-history-and-delivery.api";
import { logger } from "./platform/observability/logger";
import { reportBackgroundWork } from "./platform/observability/background-work-report";
import { hasPermission } from "./modules/identity";
import { startListingPublicationWorker } from "./modules/marketplace-listings/application/listing-publication-worker";
import {
  startArchonOrderDelivery,
  startFulfillmentSweeper,
  startChannelFulfillmentCommandWorker,
} from "./modules/oms/channel-fulfillment-authority.api";
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import { createStaffSessionGate } from "./modules/identity/staff-session.api";
import connectPgSimple from "connect-pg-simple";
import { Pool } from "pg";
import cookieParser from "cookie-parser";
import { randomUUID, timingSafeEqual } from "crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupWebSocket } from "./websocket";
// REMOVED: order-sync-listener deleted (Phase 3 - duplicate path eliminated)
// REMOVED: reconciliation rebuilt without syncSingleOrder for OMS decoupling
import {
  initReconciliation,
  runStartupZombieOrderRepair,
  startOmsWmsCancelReconcileScheduler,
  startShopifyReconciliation,
} from "./modules/orders/reconciliation-and-repair.api";
import { db, pool as dbPool } from "./db";
import { resolvePostgresPoolSslConfig } from "./database-pool-config";
import { createServices } from "./services";
import {
  startEbayOrderPolling,
  setWmsServices,
  setWmsSyncService,
  createEbayOrderWebhookHandler,
  reingestEbayOrder,
  startEbayFulfillmentStuckOrderScheduler,
} from "./modules/oms/channel-order-intake.api";
import { startBillingScheduler } from "./modules/subscriptions/runtime-scheduler.api";
import {
  setDropshipFulfillmentSync,
  setDropshipInventoryRuntimeAuthorityGate,
  setDropshipMarketplaceCancelStop,
  startDropshipCatalogArrivalsWorker,
  startDropshipCategoryMarksWorker,
  startDropshipCostDetectionWorker,
  startDropshipEbayOrderIntakeWorker,
  startDropshipListingEndWorker,
  startDropshipListingPushWorker,
  startDropshipMarketplaceSyncBackWorker,
  startDropshipOrderProcessingWorker,
  startDropshipProcessHeartbeatFromEnv,
  startDropshipReturnIntakeWorker,
  startDropshipReturnsMaintenanceWorker,
  startDropshipRulesConversionWorker,
  startDropshipUsdcWatcherWorker,
} from "./modules/dropship/runtime-workers.api";
import { createDropshipMarketplaceCancelStop } from "./modules/oms/dropship-order-authority.api";
import { startCycleCountFreezeGuard } from "./modules/inventory/application/cycle-count-freeze-guard.scheduler";
import {
  startOmsFlowReconciliationScheduler,
  startOmsOpsAlertScheduler,
} from "./modules/oms/operations-observability.api";
import { startControlTowerProjectionScheduler } from "./modules/operations/projection-scheduler.api";
import {
  createReceiptCostRecoveryRepository,
  startCostReportingWorker,
  startInboundTrackingScheduler,
  startPoEmailOutboxWorker,
  startReceiptCostRecoveryWorker,
} from "./modules/procurement/runtime-workers.api";
import { startVariantAvailabilitySyncWorker } from "./modules/channels/application/variant-availability-sync.worker";
import {
  startEchelonSyncScheduler,
  startEbayListingReconciliationScheduler,
  startShopifyMappingReconcileScheduler,
} from "./modules/channels/runtime-schedulers.api";
import { requestInventoryPublicationWorkerRun, startInventoryPublicationOutboxWorker } from "./modules/inventory-planning/application/inventory-publication-outbox.worker";
import { startPublicationWakeListener } from "./modules/inventory-planning/infrastructure/publication-wake-listener";
import { startQuantityPublicationCatchupWorker } from "./modules/inventory-planning/application/quantity-publication-catchup.worker";
import { startStockLinkRunner } from "./modules/inventory-planning/infrastructure/stock-link-runner";
import { startProductSyncWorkflowRunner } from "./modules/inventory-planning/infrastructure/product-sync-workflow.runner";
import { registerProductSyncWorkflowRoutes } from "./modules/inventory-planning/interfaces/http/inventory-product-sync.routes";
import { startFinancialCommandRetentionWorker } from "./platform/commands/financial-command-retention.worker";
import {
  startWebhookRetryWorker,
  enqueueShipStationRetry,
  buildShipStationWebhookInboxInput,
  recordWebhookReceived,
  markWebhookProcessing,
  markWebhookSucceeded,
  markWebhookFailed,
  registerOmsWebhooks,
} from "./modules/oms/webhook-retry.api";
import { startShopifyBridgeListener } from "./modules/oms/shopify-intake.api";
import { startPickingFollowupWorker } from "./modules/wms/picking-execution.api";
import { startCarrierTrackingReconciliationScheduler } from "./modules/shipping/carrier-tracking-and-dispatch.api";
import { startShipStationLabelReconciliationScheduler } from "./modules/oms/shipstation-execution.api";
import {
  installShipStationTrackingRawBodyCapture,
  registerShipStationTrackingWebhook,
} from "./modules/shipping/shipstation-tracking-transport.api";
import { installGlobalJsonBodyParser } from "./modules/shipping-engine/routes.api";
import { createDefaultShipStationV2WebhookVerifier } from "./modules/shipping/shipstation-tracking-transport.api";
import { createCarrierTrackingProjectionReader } from "./modules/shipping/carrier-tracking-and-dispatch.api";
import { registerCarrierTrackingProjectionRoutes } from "./modules/shipping/carrier-tracking-and-dispatch.api";
import {
  startWmsShipStationReconcileScheduler,
  toEngineRef,
} from "./modules/shipping/engine-and-reconcile.api";
import { createEbayAuthConfig, EbayAuthService } from "./modules/channels/adapters/ebay/ebay-auth.service";
import { createEbayApiClient } from "./modules/channels/adapters/ebay/ebay-api.client";
import { requirePermission } from "./routes/middleware";
import {
  envBoundedPositiveInteger,
  envPositiveInteger,
  getSchedulerDisableReason,
  schedulerIsDisabled,
} from "./infrastructure/scheduler-config";
import { registerScheduledJob } from "./infrastructure/job-registry";
import { registerExternalRuntimeJobs } from "./infrastructure/runtime-job-catalog";
import {
  installStructuredConsoleBridge,
  reportError,
  runWithContext,
} from "./platform/observability";
import { createHttpRequestLogger } from "./platform/observability/http-request-log";
import { observeRuntimeRequests, startRuntimeMemoryTelemetry } from "./platform/observability/runtime-memory";
import { getPostgresPoolSnapshot } from "./infrastructure/postgres-pool-observability";
import { getSchedulerLockPoolSnapshot } from "./infrastructure/scheduler-lock";

if (!process.env.VITEST && process.env.DISABLE_STRUCTURED_CONSOLE_BRIDGE !== "true") {
  installStructuredConsoleBridge();
}

const app = express();
const httpServer = createServer(app);
const stopMemoryTelemetry = startRuntimeMemoryTelemetry({
  readContext: () => ({
    databasePool: getPostgresPoolSnapshot(dbPool),
    schedulerPool: getSchedulerLockPoolSnapshot(),
  }),
});
httpServer.once("close", stopMemoryTelemetry);
app.use(observeRuntimeRequests);

// setupWebSocket is deferred until sessionMiddleware is created

installShipStationTrackingRawBodyCapture(app);

installGlobalJsonBodyParser(app);

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Per-request correlation context via AsyncLocalStorage.
// Reads x-correlation-id / x-request-id from upstream (load balancer) or generates one,
// and captures inbound webhook event identifiers (`channel_event_id`).
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId =
    (req.headers["x-correlation-id"] as string | undefined)?.trim() ||
    (req.headers["x-request-id"] as string | undefined)?.trim() ||
    randomUUID();
  const channelEventId =
    (req.headers["x-shopify-webhook-id"] as string | undefined)?.trim() ||
    (req.headers["x-ebay-notification-id"] as string | undefined)?.trim() ||
    undefined;
  res.setHeader("x-correlation-id", correlationId);
  runWithContext(
    {
      correlationId,
      ...(channelEventId ? { channelEventId } : {}),
    },
    () => next(),
  );
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
const sessionPool = new Pool({
  connectionString: dbConnectionString,
  ssl: resolvePostgresPoolSslConfig(dbConnectionString),
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
app.use(createStaffSessionGate());

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

app.use(createHttpRequestLogger());

(async () => {
  // The web process never changes table structure. Schema is applied in the
  // release phase (scripts/release.sh) before this process starts. Schema
  // changes at boot need exclusive locks on live tables, and one blocked lock
  // kept every dyno from starting (outages on 2026-11-10 and 2026-11-11).

  // Create WMS service container and attach to app for route handlers
  const services = createServices(db, dbPool);
  app.locals.services = services;
  app.locals.db = db; // Provide db to routes that expect it
  // REMOVED: initOrderSyncServices deleted with order-sync-listener
  // initOrderSyncServices(services);

  // Start Echelon sync scheduler (replaces old channelSync scheduler)
  app.locals.inventoryPublicationSweepScheduler = startEchelonSyncScheduler({
    db,
    syncSettings: services.syncSettings,
    inventoryPublicationWork: services.inventoryPublicationWork,
    log,
  });

  // Authenticated ShipStation V2 carrier-status observations. This public
  // endpoint is registered before session-protected application routes and
  // verifies the dedicated custom-header secret before retaining exact bytes.
  registerShipStationTrackingWebhook(app, {
    service: services.carrierTracking,
    webhookVerifier: createDefaultShipStationV2WebhookVerifier(),
    logger: services.carrierTrackingLogger,
  });
  registerCarrierTrackingProjectionRoutes(app, {
    reader: createCarrierTrackingProjectionReader(db),
  });

  // --- ShipStation SHIP_NOTIFY webhook (P1.6: persist to inbox → ACK → process from inbox) ---
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

    let inboxReceiptId: number;
    try {
      const receipt = await recordWebhookReceived(
        db,
        buildShipStationWebhookInboxInput(req, resource_url, req.body),
      );
      if (!receipt.inserted && (receipt.status === "succeeded" || receipt.status === "processing")) {
        console.log(`[ShipStation Webhook] Duplicate SHIP_NOTIFY (inbox=${receipt.id}, status=${receipt.status}), skipping`);
        return res.status(200).json({ status: "ok", duplicate: true, inboxId: receipt.id });
      }
      inboxReceiptId = receipt.id;
      await markWebhookProcessing(db, inboxReceiptId);
    } catch (inboxErr: any) {
      console.error(`[ShipStation Webhook] Failed to persist SHIP_NOTIFY to webhook_inbox: ${inboxErr?.message || inboxErr}`);
      return res.status(500).json({ error: "Webhook inbox unavailable" });
    }

    // Durable receipt persisted: ACK immediately before processing from inbox.
    res.status(200).json({ status: "accepted", inboxId: inboxReceiptId });

    try {
      console.log(`[ShipStation Webhook] Processing SHIP_NOTIFY (inbox=${inboxReceiptId})`);
      const processed = await services.shippingEngine.processWebhook(resource_url);
      await markWebhookSucceeded(db, inboxReceiptId);
      console.log(`[ShipStation Webhook] Processed ${processed} shipment(s) (inbox=${inboxReceiptId})`);
    } catch (err: any) {
      console.error(
        `[ShipStation Webhook] processShipNotify failed (inbox=${inboxReceiptId}), enqueueing for retry: ${err.message}`
      );
      try {
        await markWebhookFailed(db, inboxReceiptId, err);
      } catch (markErr: any) {
        console.error(
          `[ShipStation Webhook] failed to mark inbox ${inboxReceiptId} failed: ${markErr?.message || markErr}`
        );
      }

      try {
        await enqueueShipStationRetry(db, { resource_url }, {
          sourceInboxId: inboxReceiptId,
          lastError: err?.message || String(err),
        });
      } catch (enqueueErr: any) {
        console.error(
          `[ShipStation Webhook] retry-queue enqueue failed: ${enqueueErr?.message || enqueueErr}`
        );
      }
    }
  });

  // --- OMS Shopify Webhooks (BEFORE auth middleware — HMAC verified) ---
  registerOmsWebhooks(app, services.oms, {
    reservation: services.reservation,
    fulfillmentRouter: services.fulfillmentRouter,
    slaMonitor: services.slaMonitor,
  }, services.shipStation, services.wmsSync, services.shippingEngine, services.channelFulfillmentIngress);

  // Transitional service references used by retry handlers that have not yet
  // moved to constructor-injected dependencies.
  (db as any).__shipStationService = services.shipStation;
  (db as any).__shippingEngine = services.shippingEngine;
  (db as any).__wmsSyncService = services.wmsSync;

  setWmsServices({
    reservation: services.reservation,
    fulfillmentRouter: services.fulfillmentRouter,
    slaMonitor: services.slaMonitor,
  });
  setDropshipFulfillmentSync(services.wmsSync);
  setDropshipInventoryRuntimeAuthorityGate(services.dropshipInventoryRuntimeAuthority);
  // OMS's stop for accepted dropship orders eBay cancelled (eBay sync-back plan v4 §7.2): dropship asks, OMS cancels.
  setDropshipMarketplaceCancelStop(createDropshipMarketplaceCancelStop({
    db,
    reservation: services.reservation,
    // The engine's own answer (cancelled, already cancelled, already shipped or not found) decides the stop (review MS1).
    engine: services.shippingEngine
      ? { cancelOrder: (engineOrderRef: number) => services.shippingEngine.cancel(toEngineRef(engineOrderRef)) }
      : undefined,
    clock: () => new Date(),
  }));
  const channelSyncBatches = createChannelSyncBatchService();
  registerChannelSyncBatchRoutes(app, channelSyncBatches);
  startListingPublicationWorker(channelSyncBatches, "channel_sync_batch_admission_worker");
  const listingIntentPropagation=createListingIntentPropagationService();
  registerListingIntentPropagationRoutes(app,listingIntentPropagation);
  startListingPublicationWorker(listingIntentPropagation, "listing_intent_propagation_worker");
  startListingPublicationWorker(ebayListingSyncService, "ebay_listing_sync_worker");
  startListingPublicationWorker(services.listingPublication);
  startListingPublicationWorker(services.listingUpdates, "listing_update_worker");
  startListingPublicationWorker(services.listingLifecycle, "listing_lifecycle_worker");
  startWalmartStockConnectionWorker(services.walmartStockConnection);
  startShopifyProductConnectionWorker(createDefaultShopifyProductConnectionService({
    startInventorySync: (command, actor) => services.productInventorySync.start(command, actor),
    onConnected: async (_productId, variantIds) => {
      for (const variantId of variantIds) services.inventoryCore.triggerNotifyChange(variantId, "shopify_product_connection");
    },
  }));

  if (process.env.WALMART_ORDER_POLLING_ENABLED !== "false" && !schedulersDisabled("WALMART_ORDER_POLLING_DISABLED")) {
    startWalmartOrderPolling(services.walmartOrderPoll, services.walmart);
  }

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

    // Register eBay order webhook — PUBLIC (P0.6): eBay cannot hold a
    // session, so requireAuth 401'd every challenge GET and notification
    // POST, silently disabling real-time intake. The handler verifies the
    // challenge hash (GET) and requires the notification signature header +
    // re-fetches order data from eBay's authenticated API (POST) — the
    // payload itself is never trusted.
    const webhookHandler = createEbayOrderWebhookHandler(services.oms, ebayApiClient);
    app.get("/api/ebay/webhooks/order", webhookHandler);
    app.post("/api/ebay/webhooks/order", webhookHandler);

    // Admin: manually reingest an eBay order that the poller missed.
    // POST /api/admin/ebay/reingest { orderId: '21-14508-76944' }
    app.post("/api/admin/ebay/reingest", requirePermission("channels", "sync"), async (req, res) => {
      try {

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
  startEbayListingReconciliationScheduler({
    db,
    dbPool,
    notify: (event, payload) =>
      (
        services as {
          notifications?: {
            notify?: (e: string, p: Record<string, unknown>) => void;
          };
        }
      ).notifications?.notify?.(event, payload),
    log,
  });

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

  const orderEdits = createOrderEditService(dbPool, services);
  if (!schedulersDisabled()) {
    try {
      const packages = createPackageHistoryWorker(dbPool, db, event => {
        const { action, ...fields } = event;
        reportBackgroundWork(action, fields);
      });
      if (packages) httpServer.once("close", startPackageHistoryScheduler(packages, () => {
        logger.error("shipping_package_history_sweep", { outcome: "failed", error_code: "PACKAGE_HISTORY_SWEEP_FAILED" });
      }));
      else logger.warn("shipping_package_history_start", { outcome: "unconfigured", error_code: "PACKAGE_HISTORY_PROVIDER_NOT_CONFIGURED" });
    } catch {
      logger.error("shipping_package_history_start", { outcome: "failed", error_code: "PACKAGE_HISTORY_CONFIGURATION_INVALID" });
    }
    try {
      const reportReturns: ReturnWorkflowReport = event =>
        console.info(JSON.stringify(event));
      const returnWorkflow = await createCustomerReturnWorkflowWorker(reportReturns);
      httpServer.once("close", startCustomerReturnWorkflowScheduler(returnWorkflow, reportReturns));
    } catch {
      logger.error("customer_return_workflow_start", { outcome: "failed", error_code: "RETURN_WORKFLOW_CONFIGURATION_INVALID" });
    }
    const reportActions: OrderActionProjectionReport = ({ action, ...event }) => {
      reportBackgroundWork(action, event);
    };
    try {
      const actionWorker = createOrderActionProjectionWorker(dbPool, orderEdits, reportActions);
      const nativeWorker = createAccountNativeSummariesWorker(dbPool, reportActions);
      httpServer.once("close", startOrderActionProjectionScheduler({ run: async () => {
        const outcomes = await Promise.allSettled([actionWorker.run(), nativeWorker.run()]);
        if (outcomes.some(outcome => outcome.status === "rejected")) throw new Error("ACCOUNT_PROJECTION_SWEEP_FAILED");
      } }, reportActions));
    } catch {
      // A read-model configuration problem must not prevent the shared service
      // from starting. The account's existing authorization gate still applies.
      logger.error("order_action_projection_start", { outcome: "failed", error_code: "ORDER_ACTION_CONFIG_INVALID" });
    }
  }
  // Register the exact account suffix before the existing returns proxy's 404.
  // Its default-off gate does not change staff APIs or public return access.
  registerCustomerAccountRoutes(app, { services: customerAccountServices(dbPool, orderEdits),
    report: event => console.error(JSON.stringify({ event: "customer_account_request_failed", ...event })) });
  await registerRoutes(httpServer, app);
  registerProductSyncWorkflowRoutes(app, services.productInventorySync);

  registerOrderEditRoutes(app, { service: orderEdits, hasPermission,
    report: event => console.error(JSON.stringify({ event: "order_edit_request_failed", ...event })) });
  if (!schedulersDisabled("ORDER_EDIT_SCHEDULER_DISABLED")) {
    httpServer.once("close", startOrderEditScheduler(orderEdits,
      event => console.error(JSON.stringify({ event: "order_edit_worker_failed", ...event }))));
  } else {
    logSchedulerDisabled("scheduler", "Order edit recovery", "ORDER_EDIT_SCHEDULER_DISABLED");
  }

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
    await services.inventoryAlerts.warnNegativeInventoryBalances();

    // P1-18 extracted: Startup fix for dangling completed items has been moved to scripts/backfill/fix-dangling-order-items.ts
  } catch (err) {
    console.error("[Startup Fix] Failed to check negative inventory balances", err);
  }

  // Crash handlers — surface unhandled errors instead of silent death.
  process.on("unhandledRejection", (reason) => {
    reportError(reason, { action: "unhandled_rejection" });
  });
  process.on("uncaughtException", (err) => {
    reportError(err, { action: "uncaught_exception" });
  });

  const serverHost = process.env.SERVER_HOST || "0.0.0.0";
  const listenOptions: Parameters<typeof httpServer.listen>[0] = {
    port,
    host: serverHost,
    ...(process.platform === "win32" ? {} : { reusePort: true }),
  };

  httpServer.listen(
    listenOptions,
    async () => {
      // First: this process's catalog code version heartbeat (step 1 plan S2-5
      // §4.9 item 1). Its first write is awaited, bounded and never throws,
      // before any worker below starts (the dropship stock planner is the
      // inventory publication selection-work worker, not only the dropship
      // block), so a later release's gates count every running worker. It is
      // not a scheduler: DISABLE_SCHEDULERS does not stop it.
      await startDropshipProcessHeartbeatFromEnv();
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

      if (!schedulersDisabled("ARCHON_ORDER_DELIVERY_DISABLED")) {
        const stopArchonDelivery = startArchonOrderDelivery();
        if (stopArchonDelivery) httpServer.once("close", stopArchonDelivery);
      } else {
        logSchedulerDisabled("scheduler", "Archon order delivery", "ARCHON_ORDER_DELIVERY_DISABLED");
      }

      if (!schedulersDisabled("BILLING_SCHEDULER_DISABLED")) {
        // Start subscription billing scheduler (runs hourly)
        startBillingScheduler();
      } else {
        logSchedulerDisabled("scheduler", "Billing scheduler", "BILLING_SCHEDULER_DISABLED");
      }

      // Start webhook DLQ recovery worker
      if (!schedulersDisabled("WEBHOOK_RETRY_WORKER_DISABLED")) {
        startWebhookRetryWorker({
          channelFulfillmentAuthority: services.channelFulfillmentAuthority,
        });
      } else {
        logSchedulerDisabled("scheduler", "Webhook retry worker", "WEBHOOK_RETRY_WORKER_DISABLED");
      }

      if (!schedulersDisabled("CHANNEL_FULFILLMENT_COMMAND_WORKER_DISABLED")) {
        startChannelFulfillmentCommandWorker(services.channelFulfillmentAuthority);
      } else {
        logSchedulerDisabled(
          "scheduler",
          "Channel fulfillment command worker",
          "CHANNEL_FULFILLMENT_COMMAND_WORKER_DISABLED",
        );
      }

      if (!schedulersDisabled("WAREHOUSE_OPERATION_FOLLOWUP_WORKER_DISABLED")) {
        const worker = startPickingFollowupWorker({
          recoverPendingPickingCommands: () => services.picking.recoverPendingPickingCommands(),
          recoverReplenishmentFollowups: () => services.replenishment.recoverReplenishmentFollowups(),
          recoverInventoryTransfers: () => services.inventoryTransfers.recoverPending(),
          recoverInterwarehouseTransfers: () => services.interwarehouseTransfers.recoverPending(),
          recoverSupplierReturns: () => services.supplierReturnFollowups.recoverPending(),
        });
        httpServer.once("close", () => worker.stop());
      } else {
        logSchedulerDisabled("scheduler", "Warehouse operation follow-up worker", "WAREHOUSE_OPERATION_FOLLOWUP_WORKER_DISABLED");
      }

      if (!schedulersDisabled("VARIANT_AVAILABILITY_SYNC_WORKER_DISABLED")) {
        startVariantAvailabilitySyncWorker(services.variantAvailabilitySync);
      } else {
        logSchedulerDisabled(
          "scheduler",
          "Variant availability sync worker",
          "VARIANT_AVAILABILITY_SYNC_WORKER_DISABLED",
        );
      }

      if (!schedulersDisabled("INVENTORY_PUBLICATION_WORKER_DISABLED")) {
        startInventoryPublicationOutboxWorker(services.inventoryPublicationOutbox, services.inventoryPublicationSelectionWork);
        // Committed work wakes the worker at once; its timer is only the backstop.
        const wakeListener = startPublicationWakeListener(dbPool, requestInventoryPublicationWorkerRun);
        httpServer.once("close", () => {
          void wakeListener.stop().catch(() => {
            console.error(JSON.stringify({ event: "publication_wake_listener_shutdown_failed", code: "PUBLICATION_WAKE_LISTENER_SHUTDOWN_FAILED" }));
          });
        });
        const catchupWorker = startQuantityPublicationCatchupWorker(services.quantityPublicationCatchup, {
          reconcile: () => services.ebayPublicationReconciliation.processDue(),
        });
        httpServer.once("close", () => {
          void catchupWorker.stop().catch(() => {
            console.error(JSON.stringify({ event: "quantity_publication_catchup_shutdown_failed", code: "PUBLICATION_CATCHUP_SHUTDOWN_FAILED" }));
          });
        });
      } else {
        logSchedulerDisabled(
          "scheduler",
          "Inventory publication outbox worker",
          "INVENTORY_PUBLICATION_WORKER_DISABLED",
        );
      }

      // Channels PR2 (PLAN-CH2 v4.1 §7.1): link each Shopify size to its store item by SKU, one tick a minute, one
      // process of the cluster at a time (advisory lock STOCK_LINK_LOCK_ID). STOCK_LINK_AUTO_DISABLED stops it for every store.
      if (!schedulersDisabled("STOCK_LINK_AUTO_DISABLED")) {
        const stockLinkRunner = startStockLinkRunner(services.stockLink);
        if (stockLinkRunner) httpServer.once("close", () => stockLinkRunner.stop());
        const productSyncRunner = startProductSyncWorkflowRunner(services.productInventorySync);
        httpServer.once("close", () => productSyncRunner.stop());
      } else {
        logSchedulerDisabled("scheduler", "Stock link runner", "STOCK_LINK_AUTO_DISABLED");
      }

      if (!schedulersDisabled("PO_EMAIL_OUTBOX_WORKER_DISABLED")) {
        startPoEmailOutboxWorker();
      } else {
        logSchedulerDisabled("scheduler", "PO email outbox worker", "PO_EMAIL_OUTBOX_WORKER_DISABLED");
      }

      const receiptCostRecovery = startReceiptCostRecoveryWorker({ repository: createReceiptCostRecoveryRepository(dbPool), receiving: services.receiving });
      if (receiptCostRecovery) httpServer.once("close", () => receiptCostRecovery.stop());

      if (!schedulersDisabled("PROCUREMENT_TRACKING_DISABLED")) {
        const inboundTracking = startInboundTrackingScheduler();
        httpServer.once("close", () => inboundTracking.stop());
      } else {
        logSchedulerDisabled("scheduler", "Inbound procurement tracking", "PROCUREMENT_TRACKING_DISABLED");
      }

      if (!schedulersDisabled("COST_REPORT_DELIVERY_DISABLED")) {
        const stopCostReporting = startCostReportingWorker(services.costReporting);
        httpServer.once("close", () => {
          void stopCostReporting().catch(() => {
            console.error(JSON.stringify({ event: "cost_reporting_shutdown_failed", code: "COST_REPORT_SHUTDOWN_FAILED" }));
          });
        });
      } else {
        logSchedulerDisabled("scheduler", "Procurement cost report delivery", "COST_REPORT_DELIVERY_DISABLED");
      }

      if (!schedulersDisabled("FINANCIAL_COMMAND_RETENTION_WORKER_DISABLED")) {
        startFinancialCommandRetentionWorker();
      } else {
        logSchedulerDisabled(
          "scheduler",
          "Financial command retention worker",
          "FINANCIAL_COMMAND_RETENTION_WORKER_DISABLED",
        );
      }

      if (!schedulersDisabled("FULFILLMENT_SWEEPER_DISABLED")) {
        startFulfillmentSweeper(
          db,
          services.channelFulfillmentAuthority,
          services.channelFulfillmentIngress,
          services.shipStationPhysicalRecovery,
        );
      } else {
        logSchedulerDisabled("scheduler", "Fulfillment sweeper", "FULFILLMENT_SWEEPER_DISABLED");
      }

      if (!schedulersDisabled("CYCLE_COUNT_FREEZE_GUARD_DISABLED")) {
        startCycleCountFreezeGuard(db);
      } else {
        logSchedulerDisabled("scheduler", "Cycle-count freeze guard", "CYCLE_COUNT_FREEZE_GUARD_DISABLED");
      }

      // 'completed'-status fix: the pick-queue self-heal completes orders and
      // must release their leftover reservations (storage can't reach services).

      if (!schedulersDisabled("OMS_FLOW_RECONCILIATION_SCHEDULER_DISABLED")) {
        startOmsFlowReconciliationScheduler(db, {
          reservation: services.reservation,
          fulfillmentAuthority: services.channelFulfillmentAuthority,
          pickCorrections: services.pickCorrections,
          pickExceptions: services.picking,
        });
      } else {
        logSchedulerDisabled("scheduler", "OMS flow reconciliation scheduler", "OMS_FLOW_RECONCILIATION_SCHEDULER_DISABLED");
      }

      if (!schedulersDisabled("OMS_OPS_ALERT_SCHEDULER_DISABLED")) {
        startOmsOpsAlertScheduler(db);
      } else {
        logSchedulerDisabled("scheduler", "OMS ops alert scheduler", "OMS_OPS_ALERT_SCHEDULER_DISABLED");
      }

      if (!schedulersDisabled("CONTROL_TOWER_PROJECTOR_DISABLED")) {
        startControlTowerProjectionScheduler();
      } else {
        logSchedulerDisabled("scheduler", "Operations Control Tower projector", "CONTROL_TOWER_PROJECTOR_DISABLED");
      }

      if (!schedulersDisabled("CARRIER_TRACKING_RECONCILIATION_DISABLED")) {
        startCarrierTrackingReconciliationScheduler(
          services.carrierTracking,
          services.carrierTrackingLogger,
          {
            intervalMs: envPositiveInteger(
              "CARRIER_TRACKING_RECONCILIATION_INTERVAL_MS",
              5 * 60 * 1_000,
            ),
            initialDelayMs: envPositiveInteger(
              "CARRIER_TRACKING_RECONCILIATION_INITIAL_DELAY_MS",
              60 * 1_000,
            ),
            batchLimit: envBoundedPositiveInteger(
              "CARRIER_TRACKING_RECONCILIATION_BATCH_LIMIT",
              100,
              500,
            ),
          },
        );
      } else {
        logSchedulerDisabled(
          "scheduler",
          "Carrier tracking reconciliation",
          "CARRIER_TRACKING_RECONCILIATION_DISABLED",
        );
      }

      if (!schedulersDisabled("SHIPSTATION_LABEL_RECONCILIATION_DISABLED")) {
        startShipStationLabelReconciliationScheduler(services.shipStationLabelReconciliation);
      } else {
        logSchedulerDisabled("scheduler", "ShipStation label reconciliation", "SHIPSTATION_LABEL_RECONCILIATION_DISABLED");
      }

      if (!schedulersDisabled()) {
        startDropshipListingPushWorker();
        startDropshipOrderProcessingWorker();
        startDropshipEbayOrderIntakeWorker();
        startDropshipReturnsMaintenanceWorker();
        startDropshipReturnIntakeWorker();
        startDropshipUsdcWatcherWorker();
        startDropshipCostDetectionWorker();
        startDropshipListingEndWorker();
        startDropshipCatalogArrivalsWorker();
        startDropshipCategoryMarksWorker();
        startDropshipRulesConversionWorker();
        startDropshipMarketplaceSyncBackWorker();
      } else {
        logSchedulerDisabled("scheduler", "Dropship workers");
      }
    }
  );

  // Register all externally-driven background workers & schedulers in the canonical job registry (P1.5)
  registerExternalRuntimeJobs();

  startEbayFulfillmentStuckOrderScheduler({
    db,
    shippingEngine: services.shippingEngine,
  });

  startOmsWmsCancelReconcileScheduler({
    db,
    reservation: services.reservation,
    shippingEngine: services.shippingEngine,
  });

  startShopifyMappingReconcileScheduler({ db });

  // Startup & periodic reconciliation for orders whose line state is already
  // terminal but whose aggregate warehouse status remained active.
  registerScheduledJob({
    name: "orders.zombie_order_reconcile",
    cadenceMs: 6 * 60 * 60 * 1000,
    initialDelayMs: 12_000,
    advisoryLockId: 918507,
    writableStates: [
      "wms.orders.warehouse_status:completed|cancelled",
      "inventory.inventory_levels.reserved_qty",
    ],
    deadLetterPolicy: "log_and_retry_next_tick",
    disableEnvVar: "ZOMBIE_ORDER_RECONCILE_DISABLED",
    db,
    gateInitialRunOnSchedule: true,
    run: async () => {
      try {
        const { transitioned: zombieFixed } = await runStartupZombieOrderRepair({
          db,
          reservation: services.reservation,
        });
        if (zombieFixed.length > 0) {
          console.warn(
            `[Data Repair] Transitioned ${zombieFixed.length} zombie order(s) with no pending items:`,
            zombieFixed.join(", "),
          );
        }
      } catch (err: any) {
        console.warn("[Data Repair] Zombie-order reconciliation error:", err?.message);
      }
    },
  });

  startWmsShipStationReconcileScheduler({
    db,
    shippingEngine: services.shippingEngine,
  });
})();
