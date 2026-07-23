import { randomUUID } from "node:crypto";

import { z } from "zod";

import { EBAY_FULFILLMENT_IDEMPOTENCY_CONFLICT } from "../channels/adapters/ebay/ebay-api.client";
import { isEbayTrackingConflictError } from "./channel-fulfillment-conflict";
import {
  FulfillmentAuthorityError,
  type ChannelFulfillmentAuthorityRepository,
  type ClaimedChannelFulfillmentCommand,
  type MaterializePhysicalPackageInput,
  type MaterializePhysicalPackageResult,
} from "./channel-fulfillment-authority.repository";
import {
  ChannelFulfillmentProviderInputError,
  SHOPIFY_PUSH_INVALID_INPUT,
  SHOPIFY_PUSH_PACKAGE_STATE_CONFLICT,
  type ChannelFulfillmentProviderCommandInput,
} from "./fulfillment-push.service";
import type {
  ChannelFulfillmentProjector,
} from "./channel-fulfillment-projection.repository";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_DURATION_MS = 120_000;
const BASE_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

const legacyShipmentIdsSchema = z.array(z.number().int().positive()).min(1);

export interface ChannelFulfillmentAuthorityClock {
  now(): Date;
}

export interface ChannelFulfillmentAuthorityLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
  error(event: Readonly<Record<string, unknown>>): void;
}

export interface ChannelFulfillmentProviderExecutionResult {
  readonly outcome: "success" | "ignored";
  readonly providerResponseId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ChannelFulfillmentProviderExecutor {
  execute(
    command: ClaimedChannelFulfillmentCommand,
  ): Promise<ChannelFulfillmentProviderExecutionResult>;
}

export interface ChannelFulfillmentBatchResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly ignored: number;
  readonly retryScheduled: number;
  readonly reviewRequired: number;
  readonly deadLettered: number;
}

export interface MaterializeAndDispatchResult {
  readonly materialized: MaterializePhysicalPackageResult;
  readonly dispatch: ChannelFulfillmentBatchResult;
}

export interface ChannelFulfillmentAuthorityService {
  recordPhysicalPackage(
    input: MaterializePhysicalPackageInput,
    options?: { executeImmediately?: boolean },
  ): Promise<MaterializeAndDispatchResult>;
  ensureLegacyShipment(
    legacyWmsShipmentId: number,
    options?: { executeImmediately?: boolean; source?: string },
  ): Promise<MaterializeAndDispatchResult>;
  projectPhysicalPackage(physicalShipmentId: number): Promise<void>;
  runDueBatch(options?: {
    commandIds?: readonly number[];
    limit?: number;
  }): Promise<ChannelFulfillmentBatchResult>;
}

class UnsupportedChannelProviderError extends Error {
  readonly code = "UNSUPPORTED_CHANNEL_PROVIDER";

  constructor(provider: string) {
    super(`No channel fulfillment provider executor is registered for ${provider}`);
    this.name = "UnsupportedChannelProviderError";
  }
}

function defaultLogger(): ChannelFulfillmentAuthorityLogger {
  return {
    info: (event) => console.log(JSON.stringify(event)),
    warn: (event) => console.warn(JSON.stringify(event)),
    error: (event) => console.error(JSON.stringify(event)),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof UnsupportedChannelProviderError) return error.code;
  if (error instanceof FulfillmentAuthorityError) return error.code;
  if (typeof (error as any)?.context?.code === "string") {
    return String((error as any).context.code);
  }
  if (typeof (error as any)?.code === "string") return String((error as any).code);
  return "CHANNEL_FULFILLMENT_PROVIDER_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReviewRequired(error: unknown): boolean {
  return error instanceof UnsupportedChannelProviderError
    || error instanceof FulfillmentAuthorityError
    || error instanceof ChannelFulfillmentProviderInputError
    || errorCode(error) === SHOPIFY_PUSH_INVALID_INPUT
    || errorCode(error) === SHOPIFY_PUSH_PACKAGE_STATE_CONFLICT
    || errorCode(error) === EBAY_FULFILLMENT_IDEMPOTENCY_CONFLICT;
}

export function calculateChannelFulfillmentRetryAt(
  completedAt: Date,
  attemptNumber: number,
): Date {
  const exponent = Math.max(0, Math.min(20, attemptNumber - 1));
  const delayMs = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** exponent));
  return new Date(completedAt.getTime() + delayMs);
}

function legacyShipmentIdsFromCommand(
  command: ClaimedChannelFulfillmentCommand,
): readonly number[] {
  const parsed = legacyShipmentIdsSchema.safeParse(command.metadata.legacyWmsShipmentIds);
  if (!parsed.success) {
    throw new FulfillmentAuthorityError(
      "INVALID_INPUT",
      `Channel command ${command.id} has no exact legacy WMS shipment lineage`,
      { commandId: command.id, issues: parsed.error.issues },
    );
  }
  return Object.freeze([...new Set(parsed.data)].sort((left, right) => left - right));
}

function providerCommandInput(
  command: ClaimedChannelFulfillmentCommand,
): ChannelFulfillmentProviderCommandInput {
  const packageShipmentIds = new Set(legacyShipmentIdsFromCommand(command));
  for (const item of command.items) {
    if (!packageShipmentIds.has(item.legacyWmsShipmentId)) {
      throw new ChannelFulfillmentProviderInputError(
        "channel_fulfillment_lineage_mismatch",
        `Command ${command.id} item references a shipment outside its physical package`,
        {
          commandId: command.id,
          legacyWmsShipmentId: item.legacyWmsShipmentId,
          packageLegacyWmsShipmentIds: [...packageShipmentIds],
        },
      );
    }
  }
  if (command.items.length === 0) {
    throw new ChannelFulfillmentProviderInputError(
      "channel_fulfillment_lineage_mismatch",
      `Command ${command.id} has no exact legacy shipment items`,
      { commandId: command.id },
    );
  }

  return Object.freeze({
    commandId: command.id,
    physicalShipmentId: command.physicalShipmentId,
    omsOrderId: command.omsOrderId,
    legacyWmsShipmentIds: Object.freeze([...packageShipmentIds].sort((left, right) => left - right)),
    trackingNumber: command.trackingNumber,
    carrier: command.carrier,
    trackingUrl: command.trackingUrl,
    shippedAt: command.shippedAt,
    items: Object.freeze(command.items
      .slice()
      .sort((left, right) => left.legacyWmsShipmentItemId - right.legacyWmsShipmentItemId)
      .map((item) => Object.freeze({
        legacyWmsShipmentId: item.legacyWmsShipmentId,
        legacyWmsShipmentItemId: item.legacyWmsShipmentItemId,
        omsOrderLineId: item.omsOrderLineId,
        channelOrderLineId: item.channelOrderLineId,
        quantity: item.quantity,
      }))),
  });
}

/**
 * Transitional provider adapter. Canonical commands own orchestration and
 * retries; the existing channel clients remain the protocol adapters until
 * their request builders are moved behind a provider-neutral port.
 */
export function createCompatibilityChannelFulfillmentProviderExecutor(
  fulfillmentPush: any,
): ChannelFulfillmentProviderExecutor {
  return {
    async execute(command) {
      const providerInput = providerCommandInput(command);
      const shipmentIds = providerInput.legacyWmsShipmentIds;

      if (command.channelProvider === "shopify") {
        if (typeof fulfillmentPush?.pushShopifyFulfillmentForCommand !== "function") {
          throw Object.assign(new Error("Shopify fulfillment provider is not initialized"), {
            code: "CHANNEL_PROVIDER_NOT_READY",
          });
        }
        const result = await fulfillmentPush.pushShopifyFulfillmentForCommand(providerInput);
        if (result?.writebackComplete !== true) {
          throw Object.assign(
            new Error(`Shopify writeback is incomplete for physical shipment ${command.physicalShipmentId}`),
            { code: "SHOPIFY_WRITEBACK_INCOMPLETE" },
          );
        }
        const fulfillmentIds = typeof result.shopifyFulfillmentId === "string"
          && result.shopifyFulfillmentId.length > 0
          ? [result.shopifyFulfillmentId]
          : [];
        const alreadySatisfied = result.alreadySatisfied === true || result.alreadyPushed === true;
        return {
          outcome: alreadySatisfied ? "ignored" : "success",
          providerResponseId: fulfillmentIds[0] ?? null,
          metadata: Object.freeze({
            legacyWmsShipmentIds: shipmentIds,
            fulfillmentIds: Object.freeze([...new Set(fulfillmentIds)]),
            alreadySatisfied,
          }),
        };
      }

      if (command.channelProvider === "ebay") {
        if (typeof fulfillmentPush?.pushTrackingForShipmentCommand !== "function") {
          throw Object.assign(new Error("eBay fulfillment provider is not initialized"), {
            code: "CHANNEL_PROVIDER_NOT_READY",
          });
        }
        try {
          const pushed = await fulfillmentPush.pushTrackingForShipmentCommand(providerInput);
          if (pushed !== true) {
            throw Object.assign(
              new Error(`eBay writeback returned false for physical shipment ${command.physicalShipmentId}`),
              { code: "EBAY_WRITEBACK_INCOMPLETE" },
            );
          }
        } catch (error) {
          if (isEbayTrackingConflictError(error)) {
            return {
              outcome: "ignored",
              providerResponseId: null,
              metadata: Object.freeze({
                legacyWmsShipmentIds: shipmentIds,
                reconciliationRequired: true,
              }),
            };
          }
          throw error;
        }
        return {
          outcome: "success",
          providerResponseId: null,
          metadata: Object.freeze({ legacyWmsShipmentIds: shipmentIds }),
        };
      }

      throw new UnsupportedChannelProviderError(command.channelProvider);
    },
  };
}

export function createChannelFulfillmentAuthorityService(dependencies: {
  repository: ChannelFulfillmentAuthorityRepository;
  projector: ChannelFulfillmentProjector;
  providerExecutor: ChannelFulfillmentProviderExecutor;
  clock?: ChannelFulfillmentAuthorityClock;
  logger?: ChannelFulfillmentAuthorityLogger;
  createLeaseToken?: () => string;
  leaseDurationMs?: number;
}): ChannelFulfillmentAuthorityService {
  const clock = dependencies.clock ?? { now: () => new Date() };
  const logger = dependencies.logger ?? defaultLogger();
  const createLeaseToken = dependencies.createLeaseToken ?? randomUUID;
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;

  async function runDueBatch(options: {
    commandIds?: readonly number[];
    limit?: number;
  } = {}): Promise<ChannelFulfillmentBatchResult> {
    const limit = options.limit ?? DEFAULT_BATCH_SIZE;
    const claimed = await dependencies.repository.claimCommands({
      now: clock.now(),
      leaseToken: createLeaseToken(),
      leaseDurationMs,
      limit,
      commandIds: options.commandIds,
    });
    const result = {
      claimed: claimed.length,
      succeeded: 0,
      ignored: 0,
      retryScheduled: 0,
      reviewRequired: 0,
      deadLettered: 0,
    };

    for (const command of claimed) {
      const startedAt = clock.now();
      try {
        const providerResult = await dependencies.providerExecutor.execute(command);
        const completedAt = clock.now();
        await dependencies.repository.completeAttempt({
          commandId: command.id,
          leaseToken: command.leaseToken,
          outcome: providerResult.outcome,
          providerResponseId: providerResult.providerResponseId,
          startedAt,
          completedAt,
          metadata: providerResult.metadata,
        });
        if (providerResult.outcome === "success") result.succeeded += 1;
        else result.ignored += 1;
        logger.info({
          code: "CHANNEL_FULFILLMENT_COMMAND_COMPLETED",
          commandId: command.id,
          commandKey: command.commandKey,
          provider: command.channelProvider,
          outcome: providerResult.outcome,
          attemptNumber: command.attemptNumber,
        });
      } catch (error) {
        const completedAt = clock.now();
        const code = errorCode(error);
        const message = errorMessage(error);
        if (isReviewRequired(error)) {
          await dependencies.repository.completeAttempt({
            commandId: command.id,
            leaseToken: command.leaseToken,
            outcome: "review_required",
            startedAt,
            completedAt,
            errorCode: code,
            errorMessage: message,
          });
          result.reviewRequired += 1;
          logger.error({
            code: "CHANNEL_FULFILLMENT_COMMAND_REVIEW_REQUIRED",
            commandId: command.id,
            commandKey: command.commandKey,
            provider: command.channelProvider,
            errorCode: code,
            errorMessage: message,
          });
          continue;
        }

        const exhausted = command.attemptNumber >= command.maxAttempts;
        await dependencies.repository.completeAttempt({
          commandId: command.id,
          leaseToken: command.leaseToken,
          outcome: exhausted ? "dead_lettered" : "retry_scheduled",
          startedAt,
          completedAt,
          nextAttemptAt: exhausted
            ? null
            : calculateChannelFulfillmentRetryAt(completedAt, command.attemptNumber),
          errorCode: code,
          errorMessage: message,
        });
        if (exhausted) result.deadLettered += 1;
        else result.retryScheduled += 1;
        logger.warn({
          code: exhausted
            ? "CHANNEL_FULFILLMENT_COMMAND_DEAD_LETTERED"
            : "CHANNEL_FULFILLMENT_COMMAND_RETRY_SCHEDULED",
          commandId: command.id,
          commandKey: command.commandKey,
          provider: command.channelProvider,
          attemptNumber: command.attemptNumber,
          maxAttempts: command.maxAttempts,
          errorCode: code,
          errorMessage: message,
        });
      }
    }

    return Object.freeze(result);
  }

  async function recordPhysicalPackage(
    input: MaterializePhysicalPackageInput,
    options: { executeImmediately?: boolean } = {},
  ): Promise<MaterializeAndDispatchResult> {
    const materialized = await dependencies.repository.materializePhysicalPackage(input);
    await dependencies.projector.projectPhysicalShipment(materialized.physicalShipmentId);
    const commandIds = materialized.channelCommands.map((command) => command.id);
    const dispatch = options.executeImmediately !== true || commandIds.length === 0
      ? Object.freeze({ claimed: 0, succeeded: 0, ignored: 0, retryScheduled: 0, reviewRequired: 0, deadLettered: 0 })
      : await runDueBatch({ commandIds, limit: commandIds.length });
    return Object.freeze({ materialized, dispatch });
  }

  async function projectPhysicalPackage(physicalShipmentId: number): Promise<void> {
    await dependencies.projector.projectPhysicalShipment(physicalShipmentId);
  }

  async function ensureLegacyShipment(
    legacyWmsShipmentId: number,
    options: { executeImmediately?: boolean; source?: string } = {},
  ): Promise<MaterializeAndDispatchResult> {
    const resolved = await dependencies.repository.resolveLegacyPhysicalPackage(legacyWmsShipmentId);
    return recordPhysicalPackage({
      ...resolved,
      legacyWmsShipmentIds: [...resolved.legacyWmsShipmentIds],
      source: options.source ?? "legacy_fulfillment_reconciliation",
    }, options);
  }

  return { recordPhysicalPackage, ensureLegacyShipment, projectPhysicalPackage, runDueBatch };
}
