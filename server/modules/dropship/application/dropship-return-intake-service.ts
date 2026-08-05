import { createHash } from "node:crypto";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipReturnIntakeDraft,
  DropshipReturnIntakeStoreConnection,
} from "./dropship-return-intake-provider";

/**
 * Channel return-intake service (design spec D2a; build spec "Channel return
 * intake adapters", item D).
 *
 * Turns one normalized channel return draft into an RMA:
 *   - Dedupe by (store connection, channel return id) — a re-polled channel
 *     return replays the existing RMA, never duplicates.
 *   - Links to the original intake order (channel orderRef →
 *     dropship_order_intake.external_order_id for the same store).
 *   - Creates the RMA in `requested`, or `in_transit` when the channel
 *     already exposes return tracking (D4: requested → in_transit is the
 *     label-created leg).
 *   - Sets return_expected_delivery_at from channel tracking — that feeds
 *     the PR 3 no-inspection watcher's timeout path.
 *   - Unknown order / unmapped items → exception queue row, NEVER a crash
 *     (deep review 3.5 poison-pill lesson).
 *
 * Money: labelCostCents is stored in the channel evidence jsonb; the fee
 * engine reads the actual label cost from there at inspection time (D2a).
 */

export const DROPSHIP_RETURN_INTAKE_UNKNOWN_ORDER_CODE = "DROPSHIP_RETURN_INTAKE_UNKNOWN_ORDER";
export const DROPSHIP_RETURN_INTAKE_NO_ITEMS_CODE = "DROPSHIP_RETURN_INTAKE_NO_MAPPED_ITEMS";

export type DropshipReturnIntakeRecordResult =
  | { outcome: "created"; rmaId: number; rmaNumber: string }
  | { outcome: "replayed"; rmaId: number; rmaNumber: string }
  | { outcome: "exception"; exceptionId: number; failureCode: string };

export interface DropshipReturnIntakeOrderLine {
  externalLineItemId: string | null;
  sku: string | null;
  productVariantId: number | null;
}

export interface DropshipReturnIntakeOrderReference {
  intakeId: number;
  storeConnectionId: number;
  vendorId: number;
  omsOrderId: number | null;
  lines: DropshipReturnIntakeOrderLine[];
}

export interface DropshipReturnIntakeResolvedPolicy {
  policyId: number;
  returnWindowDays: number;
}

export interface DropshipReturnIntakeRepository {
  /** Find the original intake order by channel order ref for this store. */
  findIntakeOrderByExternalId(input: {
    storeConnectionId: number;
    externalOrderId: string;
  }): Promise<DropshipReturnIntakeOrderReference | null>;

  /** Dedupe lookup: existing RMA for this channel return, if any. */
  findRmaByChannelReturnId(input: {
    storeConnectionId: number;
    channelReturnId: string;
  }): Promise<{ rmaId: number; rmaNumber: string } | null>;

  /**
   * Insert the RMA (+ items) for a validated draft. Runs in one transaction;
   * the (store_connection_id, channel_return_id) unique index is the
   * concurrency guard — a conflicting concurrent insert is surfaced as
   * { created: false } and the caller re-reads the existing row.
   */
  createRmaFromChannelDraft(input: {
    draft: DropshipReturnIntakeDraft;
    vendorId: number;
    storeConnectionId: number;
    intakeId: number;
    omsOrderId: number | null;
    status: "requested" | "in_transit";
    rmaNumber: string;
    returnWindowDays: number;
    policyVersionId: number | null;
    items: { productVariantId: number | null; quantity: number }[];
    idempotencyKey: string;
    requestHash: string;
    now: Date;
  }): Promise<{ created: boolean; rmaId: number; rmaNumber: string }>;

  /** Quarantine a draft that could not become an RMA. Idempotent per open row. */
  recordException(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: "ebay" | "shopify";
    channelReturnId: string;
    failureCode: string;
    message: string;
    channelPayload: Record<string, unknown> | null;
    now: Date;
  }): Promise<{ exceptionId: number }>;

  resolvePolicyForStore(input: {
    vendorId: number;
    storeConnectionId: number;
    at: Date;
  }): Promise<DropshipReturnIntakeResolvedPolicy | null>;
}

export interface DropshipReturnIntakeServiceDependencies {
  repository: DropshipReturnIntakeRepository;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipReturnIntakeService {
  constructor(private readonly deps: DropshipReturnIntakeServiceDependencies) {}

  /**
   * Record one channel return draft. Never throws for draft-level problems
   * (unknown order, unmappable items) — those become exception queue rows.
   * Infrastructure errors (DB down) still throw: the poll service treats the
   * whole store poll as failed and does not advance the watermark.
   */
  async recordChannelReturn(input: {
    connection: DropshipReturnIntakeStoreConnection;
    platform: "ebay" | "shopify";
    draft: DropshipReturnIntakeDraft;
  }): Promise<DropshipReturnIntakeRecordResult> {
    const now = this.deps.clock.now();
    const { connection, draft } = input;

    const existing = await this.deps.repository.findRmaByChannelReturnId({
      storeConnectionId: connection.storeConnectionId,
      channelReturnId: draft.channelReturnId,
    });
    if (existing) {
      return { outcome: "replayed", rmaId: existing.rmaId, rmaNumber: existing.rmaNumber };
    }

    const order = await this.deps.repository.findIntakeOrderByExternalId({
      storeConnectionId: connection.storeConnectionId,
      externalOrderId: draft.orderRef,
    });
    if (!order) {
      return this.quarantine(input, {
        failureCode: DROPSHIP_RETURN_INTAKE_UNKNOWN_ORDER_CODE,
        message: `Channel return references unknown order ${draft.orderRef}.`,
        now,
      });
    }

    const items = mapDraftItemsToOrder({ draft, order });
    if (items.length === 0) {
      return this.quarantine(input, {
        failureCode: DROPSHIP_RETURN_INTAKE_NO_ITEMS_CODE,
        message: `Channel return ${draft.channelReturnId} has no items mappable to intake order ${order.intakeId}.`,
        now,
      });
    }

    const policy = await this.deps.repository.resolvePolicyForStore({
      vendorId: connection.vendorId,
      storeConnectionId: connection.storeConnectionId,
      at: now,
    });

    const status = draft.returnTracking ? "in_transit" : "requested";
    const idempotencyKey = buildReturnIntakeIdempotencyKey({
      storeConnectionId: connection.storeConnectionId,
      channelReturnId: draft.channelReturnId,
    });
    const requestHash = hashReturnIntakeDraft({
      storeConnectionId: connection.storeConnectionId,
      draft,
    });

    const created = await this.deps.repository.createRmaFromChannelDraft({
      draft,
      vendorId: connection.vendorId,
      storeConnectionId: connection.storeConnectionId,
      intakeId: order.intakeId,
      omsOrderId: order.omsOrderId,
      status,
      rmaNumber: buildRmaNumber({ storeConnectionId: connection.storeConnectionId, channelReturnId: draft.channelReturnId }),
      returnWindowDays: policy?.returnWindowDays ?? 30,
      policyVersionId: policy?.policyId ?? null,
      items,
      idempotencyKey,
      requestHash,
      now,
    });

    if (!created.created) {
      // Concurrent poll inserted first — replay the winner.
      const winner = await this.deps.repository.findRmaByChannelReturnId({
        storeConnectionId: connection.storeConnectionId,
        channelReturnId: draft.channelReturnId,
      });
      if (winner) {
        return { outcome: "replayed", rmaId: winner.rmaId, rmaNumber: winner.rmaNumber };
      }
      throw new DropshipError(
        "DROPSHIP_RETURN_INTAKE_CONFLICT_UNRESOLVED",
        "Dropship return intake insert conflicted but no existing RMA was found.",
        { storeConnectionId: connection.storeConnectionId, channelReturnId: draft.channelReturnId, retryable: true },
      );
    }

    this.deps.logger.info({
      code: "DROPSHIP_RETURN_INTAKE_RMA_CREATED",
      message: "Dropship RMA was created from a channel return.",
      context: {
        rmaId: created.rmaId,
        rmaNumber: created.rmaNumber,
        vendorId: connection.vendorId,
        storeConnectionId: connection.storeConnectionId,
        platform: input.platform,
        channelReturnId: draft.channelReturnId,
        status,
      },
    });
    return { outcome: "created", rmaId: created.rmaId, rmaNumber: created.rmaNumber };
  }

  private async quarantine(
    input: {
      connection: DropshipReturnIntakeStoreConnection;
      platform: "ebay" | "shopify";
      draft: DropshipReturnIntakeDraft;
    },
    failure: { failureCode: string; message: string; now: Date },
  ): Promise<DropshipReturnIntakeRecordResult> {
    const recorded = await this.deps.repository.recordException({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      platform: input.platform,
      channelReturnId: input.draft.channelReturnId,
      failureCode: failure.failureCode,
      message: failure.message,
      channelPayload: input.draft.evidence,
      now: failure.now,
    });
    this.deps.logger.warn({
      code: "DROPSHIP_RETURN_INTAKE_EXCEPTION_QUEUED",
      message: "Dropship channel return could not be turned into an RMA; queued for review.",
      context: {
        exceptionId: recorded.exceptionId,
        vendorId: input.connection.vendorId,
        storeConnectionId: input.connection.storeConnectionId,
        platform: input.platform,
        channelReturnId: input.draft.channelReturnId,
        failureCode: failure.failureCode,
      },
    });
    return { outcome: "exception", exceptionId: recorded.exceptionId, failureCode: failure.failureCode };
  }
}

/**
 * Map draft items onto the original order's lines. A draft item maps when its
 * external line item id or SKU matches an order line; unmapped draft items are
 * dropped (the channel may return partial lines). Returns [] when nothing
 * maps — the caller quarantines rather than creating an empty RMA.
 */
export function mapDraftItemsToOrder(input: {
  draft: DropshipReturnIntakeDraft;
  order: DropshipReturnIntakeOrderReference;
}): { productVariantId: number | null; quantity: number }[] {
  const items: { productVariantId: number | null; quantity: number }[] = [];
  for (const draftItem of input.draft.items) {
    const line = input.order.lines.find((candidate) => {
      if (draftItem.externalLineItemId && candidate.externalLineItemId === draftItem.externalLineItemId) {
        return true;
      }
      return Boolean(draftItem.sku && candidate.sku && candidate.sku === draftItem.sku);
    });
    if (!line) continue;
    items.push({ productVariantId: line.productVariantId, quantity: draftItem.quantity });
  }
  return items;
}

export function buildReturnIntakeIdempotencyKey(input: {
  storeConnectionId: number;
  channelReturnId: string;
}): string {
  return `dropship:return-intake:${input.storeConnectionId}:${input.channelReturnId}`;
}

export function buildRmaNumber(input: {
  storeConnectionId: number;
  channelReturnId: string;
}): string {
  const suffix = createHash("sha256")
    .update(`${input.storeConnectionId}:${input.channelReturnId}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return `RMA-CH-${input.storeConnectionId}-${suffix}`;
}

export function hashReturnIntakeDraft(input: {
  storeConnectionId: number;
  draft: DropshipReturnIntakeDraft;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      storeConnectionId: input.storeConnectionId,
      channelReturnId: input.draft.channelReturnId,
      orderRef: input.draft.orderRef,
      items: input.draft.items,
      labelCostCents: input.draft.labelCostCents,
      returnTracking: input.draft.returnTracking,
    }))
    .digest("hex");
}

export function makeDropshipReturnIntakeLogger(): DropshipLogger {
  return {
    info: (event) => logReturnIntakeEvent("info", event),
    warn: (event) => logReturnIntakeEvent("warn", event),
    error: (event) => logReturnIntakeEvent("error", event),
  };
}

export const systemDropshipReturnIntakeClock: DropshipClock = {
  now: () => new Date(),
};

function logReturnIntakeEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
