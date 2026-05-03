import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipStoreConnectionPostConnectProvider } from "./dropship-store-connection-service";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const repairDropshipStoreWebhooksInputSchema = z.object({
  storeConnectionId: positiveIdSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

export type RepairDropshipStoreWebhooksInput = z.infer<typeof repairDropshipStoreWebhooksInputSchema>;

export interface DropshipStoreWebhookRepairCredentials {
  vendorId: number;
  storeConnectionId: number;
  platform: "shopify";
  shopDomain: string;
  accessToken: string;
}

export interface DropshipStoreWebhookRepairRepository {
  loadShopifyStoreConnectionForWebhookRepair(input: {
    storeConnectionId: number;
  }): Promise<DropshipStoreWebhookRepairCredentials>;

  recordShopifyWebhookRepair(input: {
    vendorId: number;
    storeConnectionId: number;
    shopDomain: string;
    idempotencyKey: string;
    actor: RepairDropshipStoreWebhooksInput["actor"];
    repairedAt: Date;
  }): Promise<void>;
}

export interface DropshipStoreWebhookRepairResult {
  storeConnectionId: number;
  vendorId: number;
  platform: "shopify";
  shopDomain: string;
  repairedAt: Date;
}

export interface DropshipStoreWebhookRepairServiceDependencies {
  repository: DropshipStoreWebhookRepairRepository;
  postConnectProvider: DropshipStoreConnectionPostConnectProvider;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipStoreWebhookRepairService {
  constructor(private readonly deps: DropshipStoreWebhookRepairServiceDependencies) {}

  async repairShopifyWebhooks(input: unknown): Promise<DropshipStoreWebhookRepairResult> {
    const parsed = parseRepairInput(input);
    const credentials = await this.deps.repository.loadShopifyStoreConnectionForWebhookRepair({
      storeConnectionId: parsed.storeConnectionId,
    });
    const repairedAt = this.deps.clock.now();

    await this.deps.postConnectProvider.afterStoreConnected({
      vendorId: credentials.vendorId,
      storeConnectionId: credentials.storeConnectionId,
      platform: credentials.platform,
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      connectedAt: repairedAt,
    });
    await this.deps.repository.recordShopifyWebhookRepair({
      vendorId: credentials.vendorId,
      storeConnectionId: credentials.storeConnectionId,
      shopDomain: credentials.shopDomain,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      repairedAt,
    });

    this.deps.logger.info({
      code: "DROPSHIP_SHOPIFY_WEBHOOK_REPAIR_COMPLETED",
      message: "Dropship Shopify webhook subscriptions were repaired.",
      context: {
        vendorId: credentials.vendorId,
        storeConnectionId: credentials.storeConnectionId,
        idempotencyKey: parsed.idempotencyKey,
      },
    });

    return {
      storeConnectionId: credentials.storeConnectionId,
      vendorId: credentials.vendorId,
      platform: credentials.platform,
      shopDomain: credentials.shopDomain,
      repairedAt,
    };
  }
}

export function makeDropshipStoreWebhookRepairLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipStoreWebhookRepairEvent("info", event),
    warn: (event) => logDropshipStoreWebhookRepairEvent("warn", event),
    error: (event) => logDropshipStoreWebhookRepairEvent("error", event),
  };
}

export const systemDropshipStoreWebhookRepairClock: DropshipClock = {
  now: () => new Date(),
};

function parseRepairInput(input: unknown): RepairDropshipStoreWebhooksInput {
  const result = repairDropshipStoreWebhooksInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_STORE_WEBHOOK_REPAIR_INVALID_INPUT",
      "Dropship store webhook repair input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function logDropshipStoreWebhookRepairEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
