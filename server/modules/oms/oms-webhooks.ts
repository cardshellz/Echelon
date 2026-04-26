/**
 * OMS Shopify Webhooks — Direct Shopify → OMS order ingestion
 *
 * Registered BEFORE auth middleware and JSON body parser.
 * Uses express.raw() for HMAC verification, then parses JSON manually.
 *
 * Endpoints:
 *   POST /api/oms/webhooks/orders/paid       — New paid order
 *   POST /api/oms/webhooks/orders/updated     — Order updated
 *   POST /api/oms/webhooks/orders/cancelled   — Order cancelled
 *   POST /api/oms/webhooks/orders/fulfilled   — Order fulfilled
 *   POST /api/oms/webhooks/refunds/create     — Refund created
 */

import { createHmac } from "crypto";
import type { Request, Response, Express } from "express";
import * as crypto from "crypto";
import { sql, eq, and, ilike } from "drizzle-orm";
import type { OmsService, OrderData, LineItemData } from "./oms.service";
import { omsOrders, omsOrderLines, omsOrderEvents, productVariants, channelConnections, webhookRetryQueue } from "@shared/schema";
import { db } from "../../db";
import { pushToMissionControl } from "./mc-push";
import { enrichOrderWithMemberTier } from "./member-tier-enrichment";
import { normalizeShopifyLineItems } from "./shopify-line-item-normalizer";
import rateLimit from "express-rate-limit";
import { createDefaultShopifyAdminClient, type ShopifyAdminGraphQLClient } from "../shopify/admin-gql-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[OMS Shopify Webhook]";

// ---------------------------------------------------------------------------
// Types for injected services
// ---------------------------------------------------------------------------

interface WmsServices {
  reservation: {
    reserveOrder: (orderId: number) => Promise<any>;
    releaseOrderReservation: (orderId: number, reason: string) => Promise<any>;
  };
  fulfillmentRouter: {
    routeOrder: (ctx: any) => Promise<any>;
    assignWarehouseToOrder: (orderId: number, routing: any) => Promise<void>;
  };
  slaMonitor: {
    setSLAForOrder: (orderId: number) => Promise<void>;
  };
}

interface ShipStationService {
  isConfigured: () => boolean;
  pushOrder: (order: any) => Promise<any>;
  markAsShipped: (shipstationOrderId: number, opts?: {
    shipDate?: Date | string;
    trackingNumber?: string | null;
    carrierCode?: string | null;
    notifyCustomer?: boolean;
  }) => Promise<{ alreadyInState: boolean } | void>;
  cancelOrder: (shipstationOrderId: number) => Promise<{ alreadyInState: boolean } | void>;
}

// ---------------------------------------------------------------------------
// HMAC Verification
// ---------------------------------------------------------------------------

function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader) return false;
  // Try both app API secret and admin webhook secret
  const secrets = [process.env.SHOPIFY_API_SECRET, process.env.SHOPIFY_WEBHOOK_SECRET].filter(Boolean) as string[];
  for (const secret of secrets) {
    const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    try {
      if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader))) return true;
    } catch {
      if (computed === hmacHeader) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shopify payload → OMS OrderData mapping
// ---------------------------------------------------------------------------

function dollarsToCents(value: string | number | undefined | null): number {
  if (value === null || value === undefined) return 0;
  return Math.round(parseFloat(String(value)) * 100);
}

// ---------------------------------------------------------------------------
// C22b — Shopify fraud-risk extraction (§6 Group E, Decision D3)
// ---------------------------------------------------------------------------
//
// Shopify exposes risk in two shapes depending on Admin API version:
//
//   - Modern (2024-10+): `risk_assessments` array, each entry carrying
//     `risk_level` (LOW/MEDIUM/HIGH), optional `recommendation`, optional
//     numeric `score`, and a `facts` array.
//   - Legacy: a single `risk` object with `level` + `recommendation` and
//     no numeric score.
//
// We collect whichever shape is present, defensively, and fall back to
// NULL on absent / malformed data. Severity ordering for the modern
// payload picks the highest-risk assessment so a single HIGH assessment
// can't be hidden by a LOW one.
//
// Pure: no DB, no network, no globals. Exported via __test__ for unit
// tests (Rule #9, Rule #13).

const RISK_LEVEL_SEVERITY: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function normalizeRiskLevel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function normalizeRiskRecommendation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed;
}

function parseRiskScore(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return String(parsed);
  }
  return null;
}

export interface ExtractedRisk {
  riskLevel: string | null;
  riskScore: string | null;
  riskRecommendation: string | null;
  riskFacts: unknown;
}

function extractShopifyRisk(shopifyOrder: any): ExtractedRisk {
  const empty: ExtractedRisk = {
    riskLevel: null,
    riskScore: null,
    riskRecommendation: null,
    riskFacts: null,
  };
  if (!shopifyOrder || typeof shopifyOrder !== "object") return empty;

  // Modern payload: risk_assessments array.
  const assessments = (shopifyOrder as any).risk_assessments;
  if (Array.isArray(assessments) && assessments.length > 0) {
    let bestLevel: string | null = null;
    let bestSeverity = -1;
    let bestRecommendation: string | null = null;
    let bestScore: string | null = null;

    for (const a of assessments) {
      if (!a || typeof a !== "object") continue;
      const level = normalizeRiskLevel((a as any).risk_level ?? (a as any).level);
      const severity = level !== null ? RISK_LEVEL_SEVERITY[level] ?? -1 : -1;
      if (severity > bestSeverity) {
        bestSeverity = severity;
        bestLevel = level;
        bestRecommendation = normalizeRiskRecommendation((a as any).recommendation);
        bestScore = parseRiskScore((a as any).score);
      }
    }

    return {
      riskLevel: bestLevel,
      riskScore: bestScore,
      riskRecommendation: bestRecommendation,
      riskFacts: assessments,
    };
  }

  // Legacy payload: single risk object with level + recommendation.
  const legacy = (shopifyOrder as any).risk;
  if (legacy && typeof legacy === "object") {
    const level = normalizeRiskLevel(legacy.level);
    const recommendation = normalizeRiskRecommendation(legacy.recommendation);
    if (level === null && recommendation === null) {
      return empty;
    }
    return {
      riskLevel: level,
      riskScore: parseRiskScore(legacy.score),
      riskRecommendation: recommendation,
      riskFacts: legacy,
    };
  }

  return empty;
}

// Exposed for unit testing the extractor in isolation. Keeping the
// helper private to the module avoids leaking an internal contract;
// `__test__` is the conventional escape hatch in this codebase
// (mirrors fulfillment-push.service.ts).
/**
 * Cascade a Shopify orders/cancelled event through the per-shipment C19
 * helpers. Pre-label shipments cancel cleanly (with SS removeFromList
 * if pushed). Post-label shipments are flagged `requires_review` +
 * `on_hold` per Overlord's "Option B" decision — operator decides
 * void/ship/intercept. After the cascade, recomputes order-level
 * warehouse_status from the shipment states.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 28.
 *
 * Returns the per-shipment outcomes for logging + tests.
 */
export async function cascadeShopifyCancelToShipments(
  db: any,
  wmsOrderId: number,
  helpers: {
    handleCustomerCancelOnShipment: (
      db: any,
      shipmentId: number,
      opts?: any,
    ) => Promise<
      | { mode: "cancelled"; wmsOrderId: number }
      | { mode: "requires_review"; shipmentId: number }
      | { mode: "noop"; reason: string }
    >;
    recomputeOrderStatusFromShipments: (
      db: any,
      wmsOrderId: number,
    ) => Promise<{ warehouseStatus: string; changed: boolean }>;
  },
  opts: {
    now?: Date;
    shipstation?: { removeFromList?: (id: number) => Promise<void> };
    logPrefix?: string;
  } = {},
): Promise<{
  hadShipments: boolean;
  cascadeResults: Array<{ shipmentId: number; mode: string; error?: string }>;
  rollupChanged?: boolean;
}> {
  const logPrefix = opts.logPrefix ?? "[cascadeShopifyCancelToShipments]";
  const now = opts.now ?? new Date();

  // Find all non-terminal shipments for this WMS order
  const shipmentsResult: any = await db.execute(sql`
    SELECT id
    FROM wms.outbound_shipments
    WHERE order_id = ${wmsOrderId}
      AND status NOT IN ('cancelled', 'voided', 'returned', 'lost')
    ORDER BY id ASC
  `);
  const shipmentRows: Array<{ id: number }> = shipmentsResult?.rows ?? [];

  if (shipmentRows.length === 0) {
    return { hadShipments: false, cascadeResults: [] };
  }

  const cascadeResults: Array<{ shipmentId: number; mode: string; error?: string }> = [];
  for (const { id: shipmentId } of shipmentRows) {
    try {
      const result = await helpers.handleCustomerCancelOnShipment(db, shipmentId, {
        shipstation: opts.shipstation,
        now,
      });
      cascadeResults.push({ shipmentId, mode: result.mode });
    } catch (e: any) {
      console.error(
        `${logPrefix} handleCustomerCancelOnShipment failed for shipment ${shipmentId}: ${e.message}`,
      );
      cascadeResults.push({ shipmentId, mode: "error", error: e.message });
    }
  }

  // Roll up order status from cascaded shipment states
  let rollupChanged: boolean | undefined;
  try {
    const result = await helpers.recomputeOrderStatusFromShipments(db, wmsOrderId);
    rollupChanged = result.changed;
  } catch (e: any) {
    console.error(
      `${logPrefix} recomputeOrderStatusFromShipments failed for order ${wmsOrderId}: ${e.message}`,
    );
  }

  return { hadShipments: true, cascadeResults, rollupChanged };
}

export const __test__ = { extractShopifyRisk, cascadeShopifyCancelToShipments };

function mapShopifyOrderToOrderData(shopifyOrder: any): OrderData {
  const shipping = shopifyOrder.shipping_address || {};
  const customer = shopifyOrder.customer || {};

  // Use normalizer to extract line items with full discount splitting
  const discountApplications = shopifyOrder.discount_applications || [];
  const normalizedItems = normalizeShopifyLineItems(
    shopifyOrder.line_items || [], 
    discountApplications,
    shopifyOrder.order_number
  );

  const lineItems: LineItemData[] = normalizedItems.map((item) => ({
    externalLineItemId: item.externalLineItemId,
    externalProductId: item.externalProductId,
    sku: item.sku,
    title: item.title,
    variantTitle: item.variantTitle,
    quantity: item.quantity,
    paidPriceCents: item.paidPriceCents,
    totalCents: item.totalCents,
    taxCents: 0, // Tax handled at order level
    discountCents: item.discountCents,
    requiresShipping: item.requiresShipping,
  }));

  // Financial status
  let financialStatus = shopifyOrder.financial_status || "paid";

  // Fulfillment status
  let fulfillmentStatus = shopifyOrder.fulfillment_status || "unfulfilled";

  // OMS status
  let status = "pending";
  if (shopifyOrder.cancelled_at) {
    status = "cancelled";
  } else if (fulfillmentStatus === "fulfilled") {
    status = "shipped";
  } else if (financialStatus === "paid" || financialStatus === "partially_paid") {
    status = "confirmed";
  }

  const customerName =
    shipping.name ||
    `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
    shopifyOrder.name;

  // C22b — capture fraud risk from the webhook payload (§6 Group E D3).
  // Defensive: if no risk data is present we leave all fields null.
  const risk = extractShopifyRisk(shopifyOrder);

  return {
    externalOrderNumber: shopifyOrder.name || shopifyOrder.order_number?.toString(),
    status,
    financialStatus,
    fulfillmentStatus,
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
    riskRecommendation: risk.riskRecommendation,
    riskFacts: risk.riskFacts,
    customerName,
    customerEmail: shopifyOrder.email || customer.email,
    customerPhone: shipping.phone || customer.phone,
    shipToName: shipping.name,
    shipToAddress1: shipping.address1,
    shipToAddress2: shipping.address2,
    shipToCity: shipping.city,
    shipToState: shipping.province_code || shipping.province,
    shipToZip: shipping.zip,
    shipToCountry: shipping.country_code || shipping.country,
    shippingMethod: shopifyOrder.shipping_lines?.[0]?.title || null,
    shippingMethodCode: shopifyOrder.shipping_lines?.[0]?.code || null,
    // Card Shellz only offers 'standard' today. When expedited/overnight
    // tiers launch, map from shipping_lines[0].code here.
    shippingServiceLevel: "standard" as const,
    subtotalCents: dollarsToCents(shopifyOrder.subtotal_price),
    shippingCents: (shopifyOrder.shipping_lines || []).reduce(
      (sum: number, s: any) => sum + dollarsToCents(s.price), 0
    ),
    taxCents: dollarsToCents(shopifyOrder.total_tax),
    discountCents: dollarsToCents(shopifyOrder.total_discounts),
    totalCents: dollarsToCents(shopifyOrder.total_price),
    currency: shopifyOrder.currency || "USD",
    rawPayload: shopifyOrder,
    notes: shopifyOrder.note || undefined,
    tags: shopifyOrder.tags ? shopifyOrder.tags.split(",").map((t: string) => t.trim()) : undefined,
    orderedAt: shopifyOrder.created_at ? new Date(shopifyOrder.created_at) : new Date(),
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// Register Webhook Routes
// ---------------------------------------------------------------------------
//
// §6 C9b: legacy `createWmsOrderFromShopify` direct-write helper was
// deleted. Shopify → WMS now goes exclusively through
// wmsSyncService.syncOmsOrderToWms. If wmsSyncService is unwired the
// webhook handlers throw loudly so the missing wiring is diagnosable.

export function registerOmsWebhooks(
  app: Express,
  omsService: OmsService,
  wmsServices: WmsServices | null,
  shipStationService: ShipStationService | null,
  wmsSyncService?: any, // WmsSyncService - will be set from server/index.ts
) {
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 webhook requests per `window`
    message: "Too many webhooks from this IP, please try again later",
    standardHeaders: true,
    legacyHeaders: false,
  });

  // C22b — lazily create a single default Shopify Admin GraphQL client
  // for FO ID population at ingest. Lazy because tests don't need it and
  // because the env may not be wired at module-load time.
  let _shopifyAdminClient: ShopifyAdminGraphQLClient | null = null;
  function getShopifyAdminClient(): ShopifyAdminGraphQLClient {
    if (_shopifyAdminClient === null) {
      _shopifyAdminClient = createDefaultShopifyAdminClient();
    }
    return _shopifyAdminClient;
  }

  // Helper: verify HMAC using rawBody from express.json verify callback, return parsed body or null
  function verifyAndParse(req: Request, res: Response): any | null {
    const hmac = req.headers["x-shopify-hmac-sha256"] as string | undefined;
    // rawBody is set by the global express.json({ verify }) middleware
    const rawBody = (req as any).rawBody as Buffer | undefined;

    // Allow internal worker bypass
    if (req.headers["x-internal-retry"] === process.env.SESSION_SECRET) {
      return req.body;
    }

    if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      console.warn(`${LOG_PREFIX} Empty or missing rawBody`);
      res.status(200).send("ok"); // Return 200 to prevent retries
      return null;
    }

    if (rawBody && !verifyShopifyHmac(rawBody as Buffer, hmac)) {
      const s = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET;
      if (s) {
        const computed = crypto.createHmac("sha256", s).update(rawBody as Buffer).digest("base64");
        console.warn(`${LOG_PREFIX} HMAC debug: expected=${computed.substring(0,20)}... got=${(hmac||"").substring(0,20)}... secret_len=${s.length} body_len=${(rawBody as Buffer).length} rawBody_type=${typeof rawBody} is_buffer=${Buffer.isBuffer(rawBody)}`);
      }
      console.warn(`${LOG_PREFIX} HMAC verification failed`);
      res.status(401).send("Unauthorized");
      return null;
    }

    // Body is already parsed by express.json()
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      return req.body;
    }

    // Fallback: parse from raw
    try {
      return JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      console.error(`${LOG_PREFIX} JSON parse failed:`, err);
      res.status(200).send("ok");
      return null;
    }
  }

  // Helper: get Shopify GID as string
  function getExternalOrderId(shopifyOrder: any): string {
    return String(shopifyOrder.admin_graphql_api_id || shopifyOrder.id);
  }

  // Helper: Get dynamic Channel ID
  async function getChannelId(req: Request, shopifyOrder?: any): Promise<number | null> {
    const domain = (req.headers["x-shopify-shop-domain"] as string) || (shopifyOrder && shopifyOrder.shop_domain) || "";
    if (!domain) return null;

    const [conn] = await db
      .select({ channelId: channelConnections.channelId })
      .from(channelConnections)
      .where(ilike(channelConnections.shopDomain, `%${domain}%`))
      .limit(1);

    return conn ? conn.channelId : null;
  }

  // =========================================================================
  // 1. POST /api/oms/webhooks/orders/paid
  // =========================================================================
  app.post("/api/oms/webhooks/orders/paid", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    // Return 200 immediately — process async
    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/paid → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Dedup: check OMS first
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const omsOrder = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      // Check if newly created (within last 5 seconds)
      const isNew = omsOrder.createdAt && (Date.now() - new Date(omsOrder.createdAt).getTime()) < 5000;
      if (!isNew) {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already exists in OMS (id=${omsOrder.id}), skipping`);
        return;
      }

      // Enrich with member tier (non-blocking, logs errors)
      enrichOrderWithMemberTier(omsOrder.id, omsOrder.customerEmail || '').catch(err => {
        console.error(`${LOG_PREFIX} Member tier enrichment failed:`, err);
      });

      // Sync to WMS via sync service. §6 C9b: legacy
      // createWmsOrderFromShopify fallback removed (unreachable in
      // prod per Overlord Q2 decision). If wmsSyncService is absent
      // we fail loudly so the missing wiring is diagnosable.
      if (!wmsSyncService) {
        throw new Error("wmsSyncService required; legacy createWmsOrderFromShopify fallback removed (§6 C9b)");
      }
      try {
        await wmsSyncService.syncOmsOrderToWms(omsOrder.id);
        console.log(`${LOG_PREFIX} Synced ${shopifyOrder.name} to WMS`);
      } catch (e: any) {
        console.error(`${LOG_PREFIX} WMS sync failed for ${shopifyOrder.name}: ${e.message}`);
      }

      // OMS-level reservation (delegates to WMS reservation service)
      try {
        await omsService.reserveInventory(omsOrder.id);
        await omsService.assignWarehouse(omsOrder.id);
      } catch (e: any) {
        console.error(`${LOG_PREFIX} Post-ingest processing failed for ${shopifyOrder.name}: ${e.message}`);
      }

      // C22b — populate Shopify fulfillment-order line item IDs at ingest
      // (§6 Group E D2/D4). Failure is non-fatal: C22c's Path B fallback
      // re-resolves at push time. We swallow errors here so a Shopify GQL
      // hiccup doesn't block ingestion of an otherwise good order.
      try {
        const externalGid = String(
          shopifyOrder.admin_graphql_api_id ??
            (shopifyOrder.id ? `gid://shopify/Order/${shopifyOrder.id}` : externalOrderId),
        );
        const summary = await (omsService as any).populateShopifyFulfillmentOrderIds?.(
          omsOrder.id,
          externalGid,
          getShopifyAdminClient(),
        );
        if (summary) {
          console.log(
            `${LOG_PREFIX} FO IDs populated for ${shopifyOrder.name}: matched=${summary.matched} unmatched=${summary.unmatched} updates=${summary.updates}`,
          );
        }
      } catch (err: any) {
        console.error(
          `${LOG_PREFIX} populateShopifyFulfillmentOrderIds failed for ${shopifyOrder.name}: ${err?.message ?? String(err)} (non-fatal; Path B fallback will retry at push)`,
        );
      }

      console.log(`${LOG_PREFIX} ✅ Processed new order ${shopifyOrder.name} (OMS id=${omsOrder.id})`);
      pushToMissionControl(omsOrder.id, "order.created");
      
      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/paid error for ${shopifyOrder.name}: ${err.message}`);
      await db.insert(webhookRetryQueue).values({
        provider: "shopify",
        topic: "orders/paid",
        payload: shopifyOrder,
        lastError: err.message || String(err)
      });
    }
  });

  // =========================================================================
  // 2. POST /api/oms/webhooks/orders/updated
  // =========================================================================
  app.post("/api/oms/webhooks/orders/updated", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/updated → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder (UPSERT behavior)
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);


      const shipping = shopifyOrder.shipping_address || {};
      const now = new Date();

      // Update OMS order fields
      await db
        .update(omsOrders)
        .set({
          financialStatus: shopifyOrder.financial_status || existing.financialStatus,
          fulfillmentStatus: shopifyOrder.fulfillment_status || existing.fulfillmentStatus,
          customerName:
            shipping.name ||
            `${shopifyOrder.customer?.first_name || ""} ${shopifyOrder.customer?.last_name || ""}`.trim() ||
            existing.customerName,
          customerEmail: shopifyOrder.email || existing.customerEmail,
          shipToName: shipping.name || existing.shipToName,
          shipToAddress1: shipping.address1 || existing.shipToAddress1,
          shipToAddress2: shipping.address2 ?? existing.shipToAddress2,
          shipToCity: shipping.city || existing.shipToCity,
          shipToState: shipping.province_code || shipping.province || existing.shipToState,
          shipToZip: shipping.zip || existing.shipToZip,
          shipToCountry: shipping.country_code || existing.shipToCountry,
          notes: shopifyOrder.note ?? existing.notes,
          rawPayload: shopifyOrder as any,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Update line items if changed
      const newLineItems = (shopifyOrder.line_items || []) as any[];
      if (newLineItems.length > 0) {
        // Get existing OMS lines
        const existingLines = await db
          .select()
          .from(omsOrderLines)
          .where(eq(omsOrderLines.orderId, existing.id));

        const existingLineMap = new Map(
          existingLines.map((l) => [l.externalLineItemId, l]),
        );

        for (const item of newLineItems) {
          const lineId = String(item.id);
          const existingLine = existingLineMap.get(lineId);

          // Resolve variant
          let productVariantId: number | null = null;
          if (item.sku) {
            const [variant] = await db
              .select({ id: productVariants.id })
              .from(productVariants)
              .where(eq(productVariants.sku, item.sku.toUpperCase()))
              .limit(1);
            if (variant) productVariantId = variant.id;
          }

          if (existingLine) {
            // Update existing line
            await db
              .update(omsOrderLines)
              .set({
                sku: item.sku || existingLine.sku,
                title: item.title || existingLine.title,
                quantity: item.quantity ?? existingLine.quantity,
                totalDiscountCents: item.total_discount ? dollarsToCents(item.total_discount) : 0,
                productVariantId: productVariantId || existingLine.productVariantId,
              })
              .where(eq(omsOrderLines.id, existingLine.id));
          } else {
            // Insert new line
            await db.insert(omsOrderLines).values({
              orderId: existing.id,
              productVariantId,
              externalLineItemId: lineId,
              sku: item.sku,
              title: item.title,
              variantTitle: item.variant_title,
              quantity: item.quantity || 1,
              totalDiscountCents: item.total_discount ? dollarsToCents(item.total_discount) : 0,
            }).onConflictDoNothing({ target: [omsOrderLines.orderId, omsOrderLines.externalLineItemId] });
          }
        }

        // Update WMS order items if they exist
        const wmsOrder = await db.execute<{ id: number }>(sql`
          SELECT id FROM wms.orders
          WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
             OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
          LIMIT 1
        `);
        if (wmsOrder.rows.length > 0) {
          const wmsOrderId = wmsOrder.rows[0].id;
          // Update WMS order shipping address
          await db.execute(sql`
            UPDATE wms.orders SET
              shipping_name = ${shipping.name || null},
              shipping_address = ${shipping.address1 || null},
              shipping_city = ${shipping.city || null},
              shipping_state = ${shipping.province_code || shipping.province || null},
              shipping_postal_code = ${shipping.zip || null},
              shipping_country = ${shipping.country_code || null},
              financial_status = ${shopifyOrder.financial_status || "paid"},
              customer_name = ${shipping.name || existing.customerName || null},
              customer_email = ${shopifyOrder.email || null}
            WHERE id = ${wmsOrderId}
          `);
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "updated",
        details: {
          source: "shopify_webhook",
          financialStatus: shopifyOrder.financial_status,
          fulfillmentStatus: shopifyOrder.fulfillment_status,
        },
      });

      console.log(`${LOG_PREFIX} ✅ Updated order ${shopifyOrder.name} (OMS id=${existing.id})`);
      pushToMissionControl(existing.id, "order.updated");

      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/updated error for ${shopifyOrder.name}: ${err.message}`);
      await db.insert(webhookRetryQueue).values({
        provider: "shopify",
        topic: "orders/updated",
        payload: shopifyOrder,
        lastError: err.message || String(err)
      });
    }
  });

  // =========================================================================
  // 3. POST /api/oms/webhooks/orders/cancelled
  // =========================================================================
  app.post("/api/oms/webhooks/orders/cancelled", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/cancelled → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      if (existing.status === "cancelled") {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already cancelled`);
        return;
      }

      const now = new Date();

      // Update OMS order
      await db
        .update(omsOrders)
        .set({
          status: "cancelled",
          cancelledAt: now,
          financialStatus: shopifyOrder.financial_status || existing.financialStatus,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Release inventory reservation via WMS
      if (wmsServices) {
        // Find WMS order. wms-sync.service creates rows with source='oms' and
        // links via oms_fulfillment_order_id; legacy direct-write path used
        // source='shopify' with source_table_id. Match either.
        const wmsOrder = await db.execute<{ id: number }>(sql`
          SELECT id FROM wms.orders
          WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
             OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
          LIMIT 1
        `);
        if (wmsOrder.rows.length > 0) {
          const wmsOrderId = wmsOrder.rows[0].id;
          try {
            await wmsServices.reservation.releaseOrderReservation(wmsOrderId, "Order cancelled in Shopify");
            console.log(`${LOG_PREFIX} Released reservations for cancelled order ${shopifyOrder.name}`);
          } catch (e: any) {
            console.error(`${LOG_PREFIX} Failed to release reservations for ${shopifyOrder.name}: ${e.message}`);
          }

          // Per Plan §6 Commit 28: cascade through the C19 per-shipment
          // helper so post-label shipments are flagged for operator review
          // (Overlord's "Option B") rather than force-cancelled. Pre-label
          // shipments cancel cleanly via markShipmentCancelled (which calls
          // SS removeFromList if pushed).
          const rollupModule = await import("../orders/shipment-rollup");

          // Build SS adapter for the helper
          const ssAdapter = shipStationService
            ? {
                removeFromList: async (ssOrderId: number) => {
                  try {
                    await shipStationService.cancelOrder(ssOrderId);
                  } catch (e: any) {
                    console.error(
                      `${LOG_PREFIX} SS removeFromList failed for ssOrderId=${ssOrderId}: ${e.message}`,
                    );
                    throw e;
                  }
                },
              }
            : undefined;

          const cascade = await cascadeShopifyCancelToShipments(
            db,
            wmsOrderId,
            {
              handleCustomerCancelOnShipment: rollupModule.handleCustomerCancelOnShipment,
              recomputeOrderStatusFromShipments: rollupModule.recomputeOrderStatusFromShipments,
            },
            { now, shipstation: ssAdapter, logPrefix: LOG_PREFIX },
          );

          if (cascade.hadShipments) {
            console.log(
              `${LOG_PREFIX} cancel cascade for order ${shopifyOrder.name}: ${JSON.stringify(cascade.cascadeResults)}`,
            );
          } else {
            // No shipments — order cancelled before any shipment was created.
            // Direct-write the WMS order to cancelled per fallback per Plan §6 C28.
            await db.execute(sql`
              UPDATE wms.orders SET
                warehouse_status = 'cancelled',
                cancelled_at = ${now}
              WHERE id = ${wmsOrderId}
                AND warehouse_status NOT IN ('in_progress', 'ready_to_ship', 'shipped', 'cancelled')
            `);
          }
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "cancelled",
        details: {
          source: "shopify_webhook",
          reason: shopifyOrder.cancel_reason || "cancelled_by_shopify",
          cancelledAt: now.toISOString(),
        },
      });

      console.log(`${LOG_PREFIX} ✅ Cancelled order ${shopifyOrder.name} (OMS id=${existing.id})`);
      pushToMissionControl(existing.id, "order.cancelled");

      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/cancelled error for ${shopifyOrder.name}: ${err.message}`);
      await db.insert(webhookRetryQueue).values({
        provider: "shopify",
        topic: "orders/cancelled",
        payload: shopifyOrder,
        lastError: err.message || String(err)
      });
    }
  });

  // =========================================================================
  // 4. POST /api/oms/webhooks/orders/fulfilled
  // =========================================================================
  app.post("/api/oms/webhooks/orders/fulfilled", webhookLimiter, async (req: Request, res: Response) => {
    const shopifyOrder = verifyAndParse(req, res);
    if (!shopifyOrder) return;

    res.status(200).send("ok");

    const externalOrderId = getExternalOrderId(shopifyOrder);
    console.log(`${LOG_PREFIX} orders/fulfilled → ${shopifyOrder.name || externalOrderId}`);

    try {
      const channelId = await getChannelId(req, shopifyOrder);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find or create existing OMS order via ingestOrder
      const orderData = mapShopifyOrderToOrderData(shopifyOrder);
      const existing = await omsService.ingestOrder(channelId, externalOrderId, orderData);

      if (existing.status === "shipped") {
        console.log(`${LOG_PREFIX} Order ${shopifyOrder.name} already shipped`);
        return;
      }

      // Extract tracking from fulfillments
      const fulfillments = shopifyOrder.fulfillments || [];
      const latestFulfillment = fulfillments[fulfillments.length - 1];
      const trackingNumber = latestFulfillment?.tracking_number || null;
      const carrier = latestFulfillment?.tracking_company || null;
      const now = new Date();

      // Update OMS order
      await db
        .update(omsOrders)
        .set({
          status: "shipped",
          fulfillmentStatus: "fulfilled",
          trackingNumber,
          trackingCarrier: carrier,
          shippedAt: now,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Update all OMS line items to fulfilled
      await db
        .update(omsOrderLines)
        .set({ fulfillmentStatus: "fulfilled" })
        .where(eq(omsOrderLines.orderId, existing.id));

      // Update WMS order tracking
      const wmsOrder = await db.execute<{ id: number }>(sql`
        SELECT id FROM wms.orders
        WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
           OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
        LIMIT 1
      `);
      if (wmsOrder.rows.length > 0) {
        // If WMS order isn't shipped yet, transition it
        await db.execute(sql`
          UPDATE wms.orders SET
            warehouse_status = CASE
              WHEN warehouse_status NOT IN ('shipped', 'cancelled') THEN 'shipped'
              ELSE warehouse_status
            END
          WHERE id = ${wmsOrder.rows[0].id}
        `);
      }

      // Mirror to ShipStation: mark the Echelon-pushed order shipped so it
      // leaves Awaiting Shipment. Non-blocking — local state is authoritative.
      if (shipStationService?.isConfigured() && existing.shipstationOrderId) {
        try {
          await shipStationService.markAsShipped(existing.shipstationOrderId, {
            shipDate: now,
            trackingNumber,
            carrierCode: carrier?.toLowerCase() || "other",
            notifyCustomer: false,
          });
        } catch (err: any) {
          console.error(`${LOG_PREFIX} ShipStation markAsShipped failed for ${shopifyOrder.name}: ${err.message}`);
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "shipped",
        details: {
          source: "shopify_webhook",
          trackingNumber,
          carrier,
          fulfillmentId: latestFulfillment?.id,
        },
      });

      console.log(`${LOG_PREFIX} ✅ Fulfilled order ${shopifyOrder.name} (tracking: ${trackingNumber || "none"})`);
      pushToMissionControl(existing.id, "order.fulfilled");

      // M18: Trigger real-time backfill bridge
      await db.execute(sql`NOTIFY shopify_order_ingested`);
    } catch (err: any) {
      console.error(`${LOG_PREFIX} orders/fulfilled error for ${shopifyOrder.name}: ${err.message}`);
      await db.insert(webhookRetryQueue).values({
        provider: "shopify",
        topic: "orders/fulfilled",
        payload: shopifyOrder,
        lastError: err.message || String(err)
      });
    }
  });

  // =========================================================================
  // 5. POST /api/oms/webhooks/refunds/create
  // =========================================================================
  app.post("/api/oms/webhooks/refunds/create", async (req: Request, res: Response) => {
    const refundPayload = verifyAndParse(req, res);
    if (!refundPayload) return;

    res.status(200).send("ok");

    // Shopify refund payload has order_id at top level
    const shopifyOrderId = refundPayload.order_id;
    const shopifyOrderGid = `gid://shopify/Order/${shopifyOrderId}`;
    console.log(`${LOG_PREFIX} refunds/create → order ${shopifyOrderId}`);

    try {
      const channelId = await getChannelId(req, refundPayload);
      if (!channelId) throw new Error("Unknown Shopify channel domain");

      // Find OMS order — try GID first, then numeric ID
      let existing = await db
        .select()
        .from(omsOrders)
        .where(
          and(
            eq(omsOrders.channelId, channelId),
            eq(omsOrders.externalOrderId, shopifyOrderGid),
          ),
        )
        .limit(1)
        .then((r: any[]) => r[0]);

      if (!existing) {
        existing = await db
          .select()
          .from(omsOrders)
          .where(
            and(
              eq(omsOrders.channelId, channelId),
              eq(omsOrders.externalOrderId, String(shopifyOrderId)),
            ),
          )
          .limit(1)
          .then((r: any[]) => r[0]);
      }

      if (!existing) {
        console.log(`${LOG_PREFIX} Order ${shopifyOrderId} not in OMS, skipping refund`);
        return;
      }

      const now = new Date();

      // Determine financial status
      const refundLineItems = refundPayload.refund_line_items || [];
      const omsLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, existing.id));

      // Check if full or partial refund
      const totalOrderQty = omsLines.reduce((s: number, l: any) => s + l.quantity, 0);
      const refundedQty = refundLineItems.reduce((s: number, l: any) => s + (l.quantity || 0), 0);
      const financialStatus = refundedQty >= totalOrderQty ? "refunded" : "partially_refunded";

      // Update OMS order
      await db
        .update(omsOrders)
        .set({
          financialStatus,
          refundedAt: now,
          updatedAt: now,
        })
        .where(eq(omsOrders.id, existing.id));

      // Handle restock — release inventory for restocked items
      if (wmsServices) {
        const restockItems = refundLineItems.filter((li: any) => li.restock === true);

        if (restockItems.length > 0) {
          // Find WMS order
          const wmsOrder = await db.execute<{ id: number }>(sql`
            SELECT id FROM wms.orders
            WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(existing.id)})
               OR (source = 'shopify' AND source_table_id = ${String(existing.id)})
            LIMIT 1
          `);

          if (wmsOrder.rows.length > 0) {
            const wmsOrderId = wmsOrder.rows[0].id;
            try {
              // For restocked items, release their reservations
              await wmsServices.reservation.releaseOrderReservation(
                wmsOrderId,
                `Refund restock (${restockItems.length} items)`,
              );
              console.log(`${LOG_PREFIX} Released reservations for restocked items in order ${existing.externalOrderNumber}`);
            } catch (e: any) {
              console.error(`${LOG_PREFIX} Failed to release restock reservations: ${e.message}`);
            }
          }
        }
      }

      // Log event
      await db.insert(omsOrderEvents).values({
        orderId: existing.id,
        eventType: "refunded",
        details: {
          source: "shopify_webhook",
          refundId: refundPayload.id,
          financialStatus,
          refundedLineItems: refundLineItems.length,
          restockedItems: refundLineItems.filter((li: any) => li.restock === true).length,
          totalRefundAmount: refundPayload.transactions?.reduce(
            (sum: number, t: any) => sum + parseFloat(t.amount || "0"), 0
          ),
        },
      });

      console.log(`${LOG_PREFIX} ✅ Processed refund for order ${existing.externalOrderNumber} → ${financialStatus}`);
      pushToMissionControl(existing.id, "order.refunded");
    } catch (err: any) {
      console.error(`${LOG_PREFIX} refunds/create error for order ${shopifyOrderId}: ${err.message}`);
      await db.insert(webhookRetryQueue).values({
        provider: "shopify",
        topic: "refunds/create",
        payload: refundPayload,
        lastError: err.message || String(err)
      });
    }
  });

  console.log(`${LOG_PREFIX} Registered 5 webhook endpoints`);
}
