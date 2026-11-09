import { createHash } from "node:crypto";
import { z } from "zod";

import {
  changeSalesStatusRequestSchema,
  salesStatusChangeResultSchema,
  salesStatusListQuerySchema,
  salesStatusListSchema,
  salesStatusProductViewSchema,
  type ChangeSalesStatusRequest,
  type SalesStatus,
  type SalesStatusChangeResult,
  type SalesStatusList,
  type SalesStatusProductView,
} from "@shared/types/inventory-sales-status";
import { canonicalJson } from "@shared/utils/canonical-json";

import { SalesStatusError } from "../domain/inventory-sales-status";

/**
 * Use cases for the all-channels sales status (shared/types/inventory-sales-status.ts):
 * read one product's settings, list what is stopped, and change settings.
 * A change is validated here, hashed into its request identity and written
 * by the store in one transaction together with its history rows and the
 * republication of the affected products. Nothing here talks to a provider.
 */

const COMMAND_TYPE = "inventory_sales_status_change";
const actorSchema = z.string().trim().min(1).max(100);
const productIdSchema = z.coerce.number().int().positive().max(2_147_483_647);

export interface SalesStatusCommand extends ChangeSalesStatusRequest {
  actorId: string;
  /** sha256 of the command type, actor and request: a reused key with other inputs is refused. */
  requestHash: string;
  occurredAt: Date;
}

export interface SalesStatusStore {
  change(command: SalesStatusCommand): Promise<SalesStatusChangeResult>;
  readProduct(productId: number): Promise<SalesStatusProductView>;
  list(status: SalesStatus): Promise<SalesStatusList>;
}

export interface SalesStatusClock { now(): Date }

export interface SalesStatusLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
}

const systemClock: SalesStatusClock = { now: () => new Date() };
const consoleLogger: SalesStatusLogger = {
  info: (event) => console.info(JSON.stringify(event)),
  warn: (event) => console.warn(JSON.stringify(event)),
};

export class SalesStatusService {
  constructor(
    private readonly store: SalesStatusStore,
    private readonly clock: SalesStatusClock = systemClock,
    private readonly logger: SalesStatusLogger = consoleLogger,
  ) {}

  async change(input: unknown, actorInput: unknown): Promise<SalesStatusChangeResult> {
    const request = changeSalesStatusRequestSchema.safeParse(input);
    if (!request.success) {
      throw new SalesStatusError(400, "SALES_STATUS_INVALID_REQUEST", "Review the sales status change.", "permanent", {
        issues: request.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      });
    }
    const actor = actorSchema.safeParse(actorInput);
    if (!actor.success) {
      throw new SalesStatusError(401, "SALES_STATUS_ACTOR_REQUIRED", "An authenticated operator is required.", "permanent");
    }
    const occurredAt = this.clock.now();
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
      throw new SalesStatusError(500, "SALES_STATUS_CLOCK_INVALID", "The server clock returned an invalid time. Nothing was changed.", "transient");
    }
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: COMMAND_TYPE,
      actorId: actor.data,
      request: request.data,
    }), "utf8").digest("hex");
    const raw = await this.store.change({ ...request.data, actorId: actor.data, requestHash, occurredAt });
    // The store has committed by now. A malformed answer is not a refusal: keep
    // the retry identity so the operator replays the same key and reads the receipt.
    const result = salesStatusChangeResultSchema.safeParse(raw);
    if (!result.success) {
      throw new SalesStatusError(500, "SALES_STATUS_RESULT_INVALID",
        "The change may have been saved, but its result could not be verified. Retry the same change to read it.", "transient");
    }
    for (const change of result.data.changes.filter((entry) => entry.changed)) {
      this.logger.info({
        level: "info",
        event: "sales_status_changed",
        action: "sales_status_change",
        outcome: result.data.alreadyApplied ? "replayed" : "applied",
        error_code: null,
        actor: actor.data,
        scope_key: change.scopeKey,
        channel_id: change.scope.channelId,
        product_id: change.scope.productId,
        product_variant_id: change.scope.productVariantId,
        before: change.before,
        after: change.after,
        idempotency_key: request.data.idempotencyKey,
        occurred_at: occurredAt.toISOString(),
      });
    }
    this.logger.info({
      level: "info",
      event: "sales_status_republished",
      action: "sales_status_change",
      outcome: result.data.alreadyApplied ? "replayed" : "applied",
      error_code: null,
      actor: actor.data,
      product_ids: result.data.affectedProductIds,
      republished_product_ids: result.data.republished.map((product) => product.productId),
      queued: result.data.queued.map((product) => ({ product_id: product.productId, reason: product.reason,
        error_code: product.errorCode })),
      idempotency_key: request.data.idempotencyKey,
    });
    // Saved, but some stock did not update in this command. The stock-update
    // worker retries a queued product; a skipped destination waits for its own
    // listing data to be fixed. Both recover without the operator retrying.
    if (!result.data.alreadyApplied) {
      for (const product of result.data.queued.filter((entry) => entry.reason === "could_not_republish")) {
        this.logger.warn({
          level: "warn", event: "sales_status_republish_deferred", action: "sales_status_change", outcome: "queued",
          error_code: product.errorCode, actor: actor.data, product_id: product.productId,
          idempotency_key: request.data.idempotencyKey,
        });
      }
      for (const product of result.data.republished) {
        for (const destination of product.skippedDestinations) {
          this.logger.warn({
            level: "warn", event: "sales_status_destination_skipped", action: "sales_status_change", outcome: "target_skipped",
            error_code: destination.errorCode, actor: actor.data, product_id: product.productId,
            publication_target_id: destination.publicationTargetId, channel_id: destination.channelId,
            idempotency_key: request.data.idempotencyKey,
          });
        }
      }
    }
    return result.data;
  }

  async readProduct(productIdInput: unknown): Promise<SalesStatusProductView> {
    const productId = productIdSchema.safeParse(productIdInput);
    if (!productId.success) {
      throw new SalesStatusError(400, "SALES_STATUS_INVALID_PRODUCT", "A valid product id is required.", "permanent");
    }
    return verified(salesStatusProductViewSchema, await this.store.readProduct(productId.data));
  }

  async list(queryInput: unknown): Promise<SalesStatusList> {
    const query = salesStatusListQuerySchema.safeParse(queryInput ?? {});
    if (!query.success) {
      throw new SalesStatusError(400, "SALES_STATUS_INVALID_QUERY", "Status must be selling or stopped.", "permanent");
    }
    return verified(salesStatusListSchema, await this.store.list(query.data.status));
  }
}

function verified<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SalesStatusError(500, "SALES_STATUS_READ_INVALID", "Sales status could not be read. Reload to try again.", "transient");
  }
  return result.data;
}
