import {
  DROPSHIP_LISTING_ACCESS_BLOCK_CODES,
  DROPSHIP_LISTING_ACCESS_RESOLUTIONS,
} from "../../../../shared/dropship/listing-access";
import { z } from "zod";
import {
  intentNeedsReview,
  type IntentDelivery,
  type IntentHandoff,
} from "../domain/listing-intent-propagation";

export interface ListingIntentRetryCommand {
  id: string;
  channelId?: number;
  vendorId?: number;
  storeConnectionId?: number;
  actor: string;
  now: Date;
}
export interface ListingIntentPropagationStore {
  retry(input: ListingIntentRetryCommand): Promise<boolean>;
  expand(limit: number, now: Date): Promise<number>;
  claim(token: string, now: Date): Promise<IntentDelivery | null>;
  finish(
    delivery: IntentDelivery,
    outcome: IntentHandoff,
    now: Date,
  ): Promise<void>;
  defer(delivery: IntentDelivery, code: string, now: Date): Promise<void>;
}
export interface ListingIntentHandoffPort {
  /** Must read a saved exact-scope receipt before generating fresh intent. */
  handoff(delivery: IntentDelivery): Promise<IntentHandoff>;
}

/** This owner ends at a durable existing operation receipt. It never sends to a
 * provider, chooses quantities, or calls an execution job "synchronized". */
export class ListingIntentPropagationService {
  constructor(
    private readonly deps: {
      store: ListingIntentPropagationStore;
      handoff: ListingIntentHandoffPort;
      now(): Date;
      uuid(): string;
    },
  ) {}

  async requestRetry(input: unknown): Promise<boolean> {
    const positive = z.number().int().positive().max(2_147_483_647);
    const command = z
      .object({
        id: z.string().regex(/^[1-9][0-9]{0,18}$/),
        channelId: positive.optional(),
        vendorId: positive.optional(),
        storeConnectionId: positive.optional(),
        actor: z.string().trim().min(1).max(200),
      })
      .strict()
      .refine(
        (value) =>
          value.channelId !== undefined
            ? value.vendorId === undefined &&
              value.storeConnectionId === undefined
            : value.vendorId !== undefined &&
              value.storeConnectionId !== undefined,
        "An exact authorized channel or store is required.",
      )
      .parse(input);
    return this.deps.store.retry({ ...command, now: this.deps.now() });
  }

  async processDue(limit = 20): Promise<{ processed: number; failed: number }> {
    z.number().int().min(1).max(100).parse(limit);
    await this.deps.store.expand(limit, this.deps.now());
    const result = { processed: 0, failed: 0 };
    for (let index = 0; index < limit; index++) {
      const delivery = await this.deps.store.claim(
        this.deps.uuid(),
        this.deps.now(),
      );
      if (!delivery) break;
      try {
        const destination = delivery.destination;
        const outcome: IntentHandoff =
          destination.ambiguousConnection || !destination.accountId
            ? {
                state: "blocked",
                code: "LISTING_INTENT_ACCOUNT_UNRESOLVED",
                message:
                  "The saved publication needs one verified account connection. Reconnect the account, then review the listing in its workspace. This saved change cannot be redirected to another account.",
              }
            : delivery.changes.some(intentNeedsReview)
              ? {
                  state: "needs_review",
                  code: "LISTING_INTENT_STRUCTURE_REVIEW",
                  message:
                    "The product identity or category changed. Review this existing listing before applying the change.",
                }
              : await this.deps.handoff.handoff(delivery);
        await this.deps.store.finish(delivery, outcome, this.deps.now());
        result.processed++;
      } catch (error) {
        const raw =
          error && typeof error === "object"
            ? (error as { code?: unknown }).code
            : null;
        const code =
          typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(raw)
            ? raw
            : "LISTING_INTENT_HANDOFF_RETRY";
        const permanent = new Set<string>([
          ...DROPSHIP_LISTING_ACCESS_BLOCK_CODES,
          "EBAY_SYNC_IDENTITY_CHANGED",
          "EBAY_SYNC_ACCOUNT_UNVERIFIED",
          "EBAY_SYNC_AUTH_REQUIRED",
          "DROPSHIP_LISTING_ACCOUNT_CHANGED",
          "DROPSHIP_LISTING_MANAGED_SCOPE_CHANGED",
          "DROPSHIP_IDEMPOTENCY_CONFLICT",
          "EBAY_POLICY_UNAVAILABLE",
          "EBAY_POLICY_REQUIRED",
          "EBAY_POLICY_SCOPE_CHANGED",
        ]);
        if (permanent.has(code)) {
          const accessBlock = DROPSHIP_LISTING_ACCESS_BLOCK_CODES.some(
            (value) => value === code,
          );
          const resolution = z
            .enum(DROPSHIP_LISTING_ACCESS_RESOLUTIONS)
            .safeParse(
              error && typeof error === "object"
                ? (error as { context?: { resolution?: unknown } }).context
                    ?.resolution
                : undefined,
            );
          const safeMessage =
            accessBlock && error instanceof Error && error.message.trim()
              ? error.message.slice(0, 1000)
              : "The change is saved, but its account, listing identity or required policy needs review in the listing workspace before an update can be accepted.";
          await this.deps.store.finish(
            delivery,
            {
              state: "blocked",
              code,
              message: safeMessage,
              ...(accessBlock && resolution.success
                ? { resolution: resolution.data }
                : {}),
            },
            this.deps.now(),
          );
        } else await this.deps.store.defer(delivery, code, this.deps.now());
        console.error(
          JSON.stringify({
            event: permanent.has(code)
              ? "listing_intent_handoff_blocked"
              : "listing_intent_handoff_deferred",
            deliveryId: delivery.id,
            code,
          }),
        );
        result.failed++;
      }
    }
    return result;
  }
}
