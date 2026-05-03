import type { Express, Request, Response } from "express";
import { DropshipError } from "../../domain/errors";
import { normalizeShopifyShopDomain } from "../../domain/store-connection";
import type { DropshipClock } from "../../application/dropship-ports";
import type { DropshipOrderIntakeService } from "../../application/dropship-order-intake-service";
import { createDropshipOrderIntakeServiceFromEnv } from "../../infrastructure/dropship-order-intake.factory";
import {
  PgDropshipOrderIntakeSourceRepository,
  type DropshipOrderIntakeSourceRepository,
} from "../../infrastructure/dropship-order-intake-source.repository";
import {
  buildShopifyDropshipOrderIntakeInput,
  shouldRecordShopifyDropshipOrder,
} from "../../infrastructure/dropship-shopify-order-intake.mapper";
import {
  resolveShopifyDropshipWebhookSecrets,
  verifyShopifyDropshipWebhookHmac,
} from "../../infrastructure/dropship-shopify-webhook-security";

type RawBodyRequest = Request & { rawBody?: unknown };

export function registerDropshipMarketplaceOrderIntakeRoutes(
  app: Express,
  deps: {
    orderIntakeService?: DropshipOrderIntakeService;
    sourceRepository?: DropshipOrderIntakeSourceRepository;
    shopifyWebhookSecrets?: readonly string[];
    clock?: DropshipClock;
  } = {},
): void {
  const orderIntakeService = deps.orderIntakeService ?? createDropshipOrderIntakeServiceFromEnv();
  const sourceRepository = deps.sourceRepository ?? new PgDropshipOrderIntakeSourceRepository();
  const clock = deps.clock ?? { now: () => new Date() };

  app.post("/api/dropship/webhooks/shopify/orders/paid", async (req, res) => {
    return handleShopifyOrderWebhook(req, res, {
      orderIntakeService,
      sourceRepository,
      requirePaid: false,
      secrets: deps.shopifyWebhookSecrets,
      topic: "orders/paid",
    });
  });

  app.post("/api/dropship/webhooks/shopify/orders/create", async (req, res) => {
    return handleShopifyOrderWebhook(req, res, {
      orderIntakeService,
      sourceRepository,
      requirePaid: true,
      secrets: deps.shopifyWebhookSecrets,
      topic: "orders/create",
    });
  });

  app.post("/api/dropship/webhooks/shopify/app/uninstalled", async (req, res) => {
    return handleShopifyAppUninstalledWebhook(req, res, {
      sourceRepository,
      secrets: deps.shopifyWebhookSecrets,
      clock,
    });
  });
}

async function handleShopifyOrderWebhook(
  req: Request,
  res: Response,
  input: {
    orderIntakeService: DropshipOrderIntakeService;
    sourceRepository: DropshipOrderIntakeSourceRepository;
    requirePaid: boolean;
    secrets?: readonly string[];
    topic: string;
  },
): Promise<Response> {
  try {
    const rawBody = getRawBody(req);
    const secrets = input.secrets ?? resolveShopifyDropshipWebhookSecrets();
    if (secrets.length === 0) {
      return res.status(503).json({
        error: {
          code: "DROPSHIP_SHOPIFY_WEBHOOK_SECRET_REQUIRED",
          message: "Shopify dropship webhook secret is required.",
        },
      });
    }

    const hmacHeader = req.get("x-shopify-hmac-sha256");
    if (!rawBody || !hmacHeader || !verifyShopifyDropshipWebhookHmac({ rawBody, hmacHeader, secrets })) {
      return res.status(401).json({
        error: {
          code: "DROPSHIP_SHOPIFY_WEBHOOK_UNAUTHORIZED",
          message: "Shopify dropship webhook signature verification failed.",
        },
      });
    }

    const order = parseWebhookBody(req, rawBody);
    const decision = shouldRecordShopifyDropshipOrder({
      order,
      requirePaid: input.requirePaid,
    });
    if (!decision.record) {
      logShopifyWebhookIgnored({
        topic: input.topic,
        reason: decision.reason,
        shopDomain: req.get("x-shopify-shop-domain") ?? null,
      });
      return res.status(202).json({ status: "ignored", reason: decision.reason });
    }

    const shopDomain = normalizeShopifyShopDomain(
      req.get("x-shopify-shop-domain") ?? readString(order.shop_domain) ?? "",
    );
    const storeConnection = await input.sourceRepository.findShopifyStoreConnectionByShopDomain(shopDomain);
    if (!storeConnection) {
      logShopifyWebhookIgnored({
        topic: input.topic,
        reason: "store_connection_not_found",
        shopDomain,
      });
      return res.status(202).json({ status: "ignored", reason: "store_connection_not_found" });
    }

    const result = await input.orderIntakeService.recordMarketplaceOrder(
      buildShopifyDropshipOrderIntakeInput({
        store: {
          vendorId: storeConnection.vendorId,
          storeConnectionId: storeConnection.storeConnectionId,
        },
        order,
      }),
    );
    return res.status(200).json({
      status: "recorded",
      action: result.action,
      intakeId: result.intake.intakeId,
      intakeStatus: result.intake.status,
    });
  } catch (error) {
    return sendDropshipMarketplaceOrderIntakeError(res, error);
  }
}

async function handleShopifyAppUninstalledWebhook(
  req: Request,
  res: Response,
  input: {
    sourceRepository: DropshipOrderIntakeSourceRepository;
    secrets?: readonly string[];
    clock: DropshipClock;
  },
): Promise<Response> {
  try {
    const rawBody = getRawBody(req);
    const secrets = input.secrets ?? resolveShopifyDropshipWebhookSecrets();
    if (secrets.length === 0) {
      return res.status(503).json({
        error: {
          code: "DROPSHIP_SHOPIFY_WEBHOOK_SECRET_REQUIRED",
          message: "Shopify dropship webhook secret is required.",
        },
      });
    }

    const hmacHeader = req.get("x-shopify-hmac-sha256");
    if (!rawBody || !hmacHeader || !verifyShopifyDropshipWebhookHmac({ rawBody, hmacHeader, secrets })) {
      return res.status(401).json({
        error: {
          code: "DROPSHIP_SHOPIFY_WEBHOOK_UNAUTHORIZED",
          message: "Shopify dropship webhook signature verification failed.",
        },
      });
    }

    const payload = parseWebhookBody(req, rawBody);
    const shopDomain = normalizeShopifyShopDomain(
      req.get("x-shopify-shop-domain")
        ?? readString(payload.myshopify_domain)
        ?? "",
    );
    const result = await input.sourceRepository.markShopifyStoreUninstalled({
      shopDomain,
      occurredAt: input.clock.now(),
      webhookId: req.get("x-shopify-webhook-id") ?? null,
    });
    if (!result.matched) {
      logShopifyWebhookIgnored({
        topic: "app/uninstalled",
        reason: "store_connection_not_found",
        shopDomain,
      });
      return res.status(202).json({ status: "ignored", reason: "store_connection_not_found" });
    }

    return res.status(200).json({
      status: "disconnected",
      changed: result.changed,
      storeConnectionId: result.storeConnectionId,
      previousStatus: result.previousStatus,
    });
  } catch (error) {
    return sendDropshipMarketplaceOrderIntakeError(res, error);
  }
}

function sendDropshipMarketplaceOrderIntakeError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipMarketplaceOrderIntakeError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipMarketplaceOrderIntakeRoutes] Unexpected webhook error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_MARKETPLACE_ORDER_INTAKE_INTERNAL_ERROR",
      message: "Dropship marketplace order intake webhook failed.",
    },
  });
}

function statusForDropshipMarketplaceOrderIntakeError(code: string): number {
  switch (code) {
    case "DROPSHIP_SHOP_DOMAIN_REQUIRED":
    case "DROPSHIP_INVALID_SHOP_DOMAIN":
    case "DROPSHIP_SHOPIFY_ORDER_GID_INVALID":
    case "DROPSHIP_SHOPIFY_ORDER_ID_REQUIRED":
    case "DROPSHIP_SHOPIFY_ORDER_LINES_REQUIRED":
    case "DROPSHIP_SHOPIFY_ORDER_LINE_INVALID":
    case "DROPSHIP_SHOPIFY_ORDER_QUANTITY_INVALID":
    case "DROPSHIP_SHOPIFY_ORDER_MONEY_INVALID":
    case "DROPSHIP_SHOPIFY_ORDER_MONEY_UNSAFE":
    case "DROPSHIP_SHOPIFY_ORDER_SHIPPING_TOTAL_UNSAFE":
    case "DROPSHIP_SHOPIFY_ORDERED_AT_INVALID":
    case "DROPSHIP_SHOPIFY_WEBHOOK_BODY_INVALID":
    case "DROPSHIP_ORDER_INTAKE_INVALID_INPUT":
      return 400;
    case "DROPSHIP_SHOPIFY_STORE_CONNECTION_AMBIGUOUS":
      return 409;
    default:
      return 500;
  }
}

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as RawBodyRequest).rawBody;
  return Buffer.isBuffer(rawBody) && rawBody.length > 0 ? rawBody : null;
}

function parseWebhookBody(req: Request, rawBody: Buffer): Record<string, unknown> {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body) && Object.keys(req.body).length > 0) {
    return req.body as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Normalize below.
  }
  throw new DropshipError(
    "DROPSHIP_SHOPIFY_WEBHOOK_BODY_INVALID",
    "Shopify dropship webhook body must be a JSON object.",
    { retryable: false },
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function logShopifyWebhookIgnored(input: {
  topic: string;
  reason: string;
  shopDomain: string | null;
}): void {
  console.warn(JSON.stringify({
    code: "DROPSHIP_SHOPIFY_ORDER_WEBHOOK_IGNORED",
    message: "Shopify dropship order webhook was ignored.",
    context: input,
  }));
}
