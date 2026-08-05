import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

/**
 * No-inspection review (design spec D3; build spec B2 "No-inspection branch").
 *
 * Admin decision surface for RMAs the watcher queued in no_inspection_review.
 *
 * - Approve → credit the vendor from the INSURANCE POOL (existing
 *   insurance_pool_credit wallet ledger type) and move the RMA to `credited`
 *   via the system-ledger path. One-time per RMA: the credit idempotency key
 *   is deterministic per RMA, so a double-approve replays instead of
 *   double-paying. A pool-ledger row (no_inspection_payout) records the pool
 *   side of the movement.
 * - Deny → close the RMA with a reason (state machine requires reason +
 *   actor for no_inspection_review → closed).
 *
 * Pool replenishment: when a carrier claim linked to the RMA later pays out,
 * recordClaimReplenishment credits the POOL (claim_replenishment), never the
 * vendor twice. Idempotent per claim.
 */

const positiveIdSchema = z.number().int().positive();

const reviewNoInspectionInputSchema = z.object({
  rmaId: positiveIdSchema,
  decision: z.enum(["approve", "deny"]),
  /** Required for deny; optional note on approve. */
  reason: z.string().trim().min(1).max(2000).nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  actor: z.object({
    actorType: z.enum(["admin"]),
    actorId: z.string().trim().min(1).max(255),
  }).strict(),
}).strict();

const recordClaimReplenishmentInputSchema = z.object({
  carrierClaimId: positiveIdSchema,
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("USD"),
  providerPayoutReference: z.string().trim().min(1).max(255),
  idempotencyKey: z.string().trim().min(8).max(200),
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

export interface DropshipNoInspectionReviewRecord {
  rmaId: number;
  rmaNumber: string;
  vendorId: number;
  status: string;
  noInspectionEvidence: Record<string, unknown> | null;
  policyVersionId: number | null;
}

export interface DropshipNoInspectionReviewResult {
  rmaId: number;
  decision: "approve" | "deny";
  status: string;
  creditCents: number;
  walletLedgerEntryId: number | null;
  poolLedgerEntryId: number | null;
  idempotentReplay: boolean;
}

export interface DropshipPoolReplenishmentResult {
  poolLedgerEntryId: number;
  carrierClaimId: number;
  amountCents: number;
  idempotentReplay: boolean;
}

export interface DropshipNoInspectionReviewRepository {
  getRmaForReview(input: { rmaId: number }): Promise<DropshipNoInspectionReviewRecord | null>;

  /**
   * Credit basis for the pool payout (D3 credit basis: wholesale cost
   * actually debited × units requested, + allocated original shipping —
   * carrier-fault matrix row). Returns null when the RMA has no linked
   * economics snapshot (cannot price the payout — admin must deny or the
   * RMA takes the normal inspection path).
   */
  getPoolCreditBasis(input: { rmaId: number }): Promise<{
    wholesaleProductCents: number;
    allocatedShippingCents: number;
    currency: string;
  } | null>;

  /**
   * Approve path, one transaction:
   *  1. Lock the RMA row; assert status = no_inspection_review.
   *  2. Insert the vendor wallet credit (insurance_pool_credit) with the
   *     deterministic per-RMA idempotency key — a double-approve replays.
   *  3. Insert the pool-ledger payout row (no_inspection_payout).
   *  4. Transition the RMA no_inspection_review → credited via the
   *     system-ledger path (state machine: credited is system-only).
   * Returns the created ids; idempotentReplay=true when the credit key
   * already existed (the RMA is returned as-is).
   */
  approveReview(input: {
    rmaId: number;
    vendorId: number;
    creditCents: number;
    currency: string;
    reason: string | null;
    policyVersionId: number | null;
    idempotencyKey: string;
    requestHash: string;
    actor: { actorType: "admin"; actorId: string };
    now: Date;
  }): Promise<{
    status: string;
    walletLedgerEntryId: number | null;
    poolLedgerEntryId: number | null;
    idempotentReplay: boolean;
  }>;

  /**
   * Deny path: no_inspection_review → closed with reason + actor (state
   * machine enforced under row lock). Idempotent via the status-update key.
   */
  denyReview(input: {
    rmaId: number;
    vendorId: number;
    reason: string;
    policyVersionId: number | null;
    idempotencyKey: string;
    requestHash: string;
    actor: { actorType: "admin"; actorId: string };
    now: Date;
  }): Promise<{ status: string; idempotentReplay: boolean }>;

  /**
   * Pool replenishment (D3): a linked carrier claim paid out — credit the
   * POOL. Idempotent per claim via the unique pool-ledger idempotency key.
   * The vendor wallet is NEVER touched here.
   */
  recordClaimReplenishment(input: {
    carrierClaimId: number;
    amountCents: number;
    currency: string;
    providerPayoutReference: string;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  }): Promise<{ poolLedgerEntryId: number; idempotentReplay: boolean }>;
}

export class DropshipNoInspectionReviewService {
  constructor(
    private readonly deps: {
      repository: DropshipNoInspectionReviewRepository;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async review(input: unknown): Promise<DropshipNoInspectionReviewResult> {
    const parsed = parseReviewInput(input);
    const now = this.deps.clock.now();
    const rma = await this.deps.repository.getRmaForReview({ rmaId: parsed.rmaId });
    if (!rma) {
      throw new DropshipError(
        "DROPSHIP_RMA_NOT_FOUND",
        "Dropship RMA was not found.",
        { rmaId: parsed.rmaId },
      );
    }
    if (rma.status !== "no_inspection_review") {
      throw new DropshipError(
        "DROPSHIP_RMA_NOT_IN_NO_INSPECTION_REVIEW",
        "Dropship RMA is not queued for no-inspection review.",
        { rmaId: parsed.rmaId, status: rma.status },
      );
    }

    if (parsed.decision === "deny") {
      const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
      if (!reason) {
        throw new DropshipError(
          "DROPSHIP_NO_INSPECTION_REASON_REQUIRED",
          "Denying a no-inspection review requires a reason.",
          { rmaId: parsed.rmaId },
        );
      }
      const result = await this.deps.repository.denyReview({
        rmaId: rma.rmaId,
        vendorId: rma.vendorId,
        reason,
        policyVersionId: rma.policyVersionId,
        idempotencyKey: parsed.idempotencyKey,
        requestHash: hashNoInspectionDecision({
          rmaId: rma.rmaId,
          decision: "deny",
          reason,
        }),
        actor: parsed.actor,
        now,
      });
      if (!result.idempotentReplay) {
        this.deps.logger.info({
          code: "DROPSHIP_NO_INSPECTION_DENIED",
          message: "Dropship no-inspection review was denied.",
          context: { rmaId: rma.rmaId, actorId: parsed.actor.actorId },
        });
      }
      return {
        rmaId: rma.rmaId,
        decision: "deny",
        status: result.status,
        creditCents: 0,
        walletLedgerEntryId: null,
        poolLedgerEntryId: null,
        idempotentReplay: result.idempotentReplay,
      };
    }

    const basis = await this.deps.repository.getPoolCreditBasis({ rmaId: rma.rmaId });
    if (!basis) {
      throw new DropshipError(
        "DROPSHIP_NO_INSPECTION_CREDIT_BASIS_MISSING",
        "Dropship RMA has no linked order economics snapshot; the pool credit cannot be priced.",
        { rmaId: rma.rmaId },
      );
    }
    const creditCents = basis.wholesaleProductCents + basis.allocatedShippingCents;
    if (creditCents <= 0) {
      throw new DropshipError(
        "DROPSHIP_NO_INSPECTION_CREDIT_BASIS_INVALID",
        "Dropship RMA pool credit basis is not positive.",
        { rmaId: rma.rmaId, creditCents },
      );
    }

    const result = await this.deps.repository.approveReview({
      rmaId: rma.rmaId,
      vendorId: rma.vendorId,
      creditCents,
      currency: basis.currency,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() || null : null,
      policyVersionId: rma.policyVersionId,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: hashNoInspectionDecision({
        rmaId: rma.rmaId,
        decision: "approve",
        reason: null,
      }),
      actor: parsed.actor,
      now,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_NO_INSPECTION_APPROVED",
        message: "Dropship no-inspection review was approved and the pool credit posted.",
        context: {
          rmaId: rma.rmaId,
          vendorId: rma.vendorId,
          creditCents,
          walletLedgerEntryId: result.walletLedgerEntryId,
          poolLedgerEntryId: result.poolLedgerEntryId,
          actorId: parsed.actor.actorId,
        },
      });
      await this.notifyPoolCreditPosted({
        vendorId: rma.vendorId,
        rmaId: rma.rmaId,
        rmaNumber: rma.rmaNumber,
        creditCents,
        currency: basis.currency,
      });
    }
    return {
      rmaId: rma.rmaId,
      decision: "approve",
      status: result.status,
      creditCents,
      walletLedgerEntryId: result.walletLedgerEntryId,
      poolLedgerEntryId: result.poolLedgerEntryId,
      idempotentReplay: result.idempotentReplay,
    };
  }

  /**
   * Pool replenishment (D3): a carrier claim linked to a no-inspection RMA
   * paid out. The payout credits the POOL — the vendor was already credited
   * once at approve time and is never credited twice.
   */
  async recordClaimReplenishment(input: unknown): Promise<DropshipPoolReplenishmentResult> {
    const parsed = parseReplenishmentInput(input);
    const now = this.deps.clock.now();
    const result = await this.deps.repository.recordClaimReplenishment({
      carrierClaimId: parsed.carrierClaimId,
      amountCents: parsed.amountCents,
      currency: parsed.currency,
      providerPayoutReference: parsed.providerPayoutReference,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      now,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_POOL_CLAIM_REPLENISHMENT_RECORDED",
        message: "Carrier claim payout replenished the dropship insurance pool.",
        context: {
          carrierClaimId: parsed.carrierClaimId,
          amountCents: parsed.amountCents,
          poolLedgerEntryId: result.poolLedgerEntryId,
        },
      });
    }
    return {
      poolLedgerEntryId: result.poolLedgerEntryId,
      carrierClaimId: parsed.carrierClaimId,
      amountCents: parsed.amountCents,
      idempotentReplay: result.idempotentReplay,
    };
  }

  private async notifyPoolCreditPosted(input: {
    vendorId: number;
    rmaId: number;
    rmaNumber: string;
    creditCents: number;
    currency: string;
  }): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: input.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.RETURN_CREDIT_POSTED,
      critical: false,
      channels: ["email", "in_app"],
      title: "Lost-in-transit return credit posted",
      message: `Your return ${input.rmaNumber} was approved under the lost-in-transit review and a credit was posted to your wallet.`,
      payload: {
        rmaId: input.rmaId,
        rmaNumber: input.rmaNumber,
        creditCents: input.creditCents,
        currency: input.currency,
        source: "insurance_pool",
      },
      idempotencyKey: `dropship-no-inspection-credit-notify:${input.rmaId}`,
    }, {
      code: "DROPSHIP_NO_INSPECTION_CREDIT_NOTIFICATION_FAILED",
      message: "Dropship no-inspection credit notification failed.",
      context: { rmaId: input.rmaId, vendorId: input.vendorId },
    });
  }
}

export function makeDropshipNoInspectionReviewLogger(): DropshipLogger {
  return {
    info: (event) => logReviewEvent("info", event),
    warn: (event) => logReviewEvent("warn", event),
    error: (event) => logReviewEvent("error", event),
  };
}

export const systemDropshipNoInspectionReviewClock: DropshipClock = {
  now: () => new Date(),
};

function hashNoInspectionDecision(input: {
  rmaId: number;
  decision: "approve" | "deny";
  reason: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    command: "dropship_no_inspection_review",
    rmaId: input.rmaId,
    decision: input.decision,
    reason: input.reason,
  })).digest("hex");
}

function parseReviewInput(input: unknown): z.infer<typeof reviewNoInspectionInputSchema> {
  const result = reviewNoInspectionInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_NO_INSPECTION_REVIEW_INVALID_INPUT",
      "Dropship no-inspection review input failed validation.",
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

function parseReplenishmentInput(input: unknown): z.infer<typeof recordClaimReplenishmentInputSchema> {
  const result = recordClaimReplenishmentInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_POOL_REPLENISHMENT_INVALID_INPUT",
      "Dropship pool replenishment input failed validation.",
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

function logReviewEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
