import {
  customerReturnLabelStatusSchema,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSettings,
} from "@shared/returns/customer-return-label.contract";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";
import {
  ReturnLabelProviderError,
  returnLabelRecordSchema,
  type ReturnLabelInput,
  type ReturnLabelProvider,
  type ReturnLabelRecord,
} from "../../shipping-engine/application/return-label-provider.port";
import {
  ReturnRateProviderError,
  returnRateResultSchema,
  type ReturnRateProvider,
  type ReturnRateInput,
} from "../../shipping-engine/application/return-rate-provider.port";
import {
  CustomerReturnRateSelectionError,
  selectCustomerReturnRate,
} from "../domain/customer-return-rate-selection";
import { returnCarrierRuleAllowsWeight } from "@shared/returns/customer-return-carrier-policy";
import {
  customerReturnShipmentHash,
  RETURN_RATE_QUOTE_MAX_AGE_MS,
  type CustomerReturnQuoteDecision,
} from "./customer-return-label-quote";

// A provider call has a bounded 30-second deadline. A crash after its durable
// intent is indistinguishable from a lost response, so expiry permits GET only.
export const RETURN_LABEL_EXECUTION_WINDOW_MS = 60_000;
export interface ReturnLabelAttempt {
  id: number;
  status: "executing" | "succeeded" | "failed" | "uncertain";
  startedAt: Date;
  result: ReturnLabelRecord | null;
}
export interface StoredReturnLabels {
  channelId: number;
  authorizationId: number;
  authorizationNumber: string;
  parcels: {
    id: number;
    number: number;
    selectionMode: "fixed_service" | "cheapest_eligible";
    shipment: ReturnRateInput["shipment"];
    input: ReturnLabelInput | null;
    attempt: ReturnLabelAttempt | null;
  }[];
}
export interface CustomerReturnLabelStore {
  read(channelId: number, authorizationId: number): Promise<StoredReturnLabels>;
  recordQuote(
    channelId: number,
    authorizationId: number,
    parcelId: number,
    decision: CustomerReturnQuoteDecision,
    actor: string,
    now: Date,
  ): Promise<number>;
  /** Locks the parcel and settings; commits intent before any carrier request. */
  begin(
    channelId: number,
    authorizationId: number,
    parcelId: number,
    actor: string,
    now: Date,
    quoteDecisionId?: number,
  ): Promise<{ id: number; input: ReturnLabelInput } | null>;
  finish(
    attemptId: number,
    outcome:
      | { status: "succeeded"; result: ReturnLabelRecord }
      | {
          status: "failed" | "uncertain";
          code: string;
        },
    actor: string,
    now: Date,
  ): Promise<void>;
}
export interface CustomerReturnLabelsDependencies {
  store: CustomerReturnLabelStore;
  provider: ReturnLabelProvider;
  rates: ReturnRateProvider;
  authorizeChannel: (channelId: number) => Promise<void>;
  requirePurchaseConfiguration: (
    channelId: number,
  ) => Promise<CustomerReturnLabelSettings>;
  now: () => Date;
}

/** One parcel per explicit command. Unknown outcomes never authorize another POST. */
export class CustomerReturnLabelsService {
  constructor(
    private readonly dependencies: CustomerReturnLabelsDependencies,
  ) {}

  async status(
    channelId: number,
    authorizationId: number,
  ): Promise<CustomerReturnLabelStatus> {
    await this.dependencies.authorizeChannel(channelId);
    return this.present(
      await this.dependencies.store.read(channelId, authorizationId),
    );
  }

  async progress(
    channelId: number,
    authorizationId: number,
    actor: string,
  ): Promise<CustomerReturnLabelStatus> {
    await this.dependencies.authorizeChannel(channelId);
    const stored = await this.dependencies.store.read(
      channelId,
      authorizationId,
    );
    const pending = stored.parcels.find((parcel) => parcel.attempt === null);
    const recovery = stored.parcels.find(
      (parcel) => parcel.attempt && this.needsRecovery(parcel.attempt),
    );
    // Keep read-only reconciliation available when new purchases are paused.
    if (recovery) return this.recover(stored, recovery, actor);
    // "Check status" must never turn a recent unknown outcome into a purchase of
    // another box. Resolve the in-flight request before continuing new labels.
    if (stored.parcels.some((parcel) => parcel.attempt?.status === "executing"))
      return this.present(stored);
    const parcel = pending;
    if (!parcel) return this.present(stored);
    const settings =
      await this.dependencies.requirePurchaseConfiguration(channelId);
    const quoteDecisionId =
      parcel.selectionMode === "cheapest_eligible"
        ? await this.quote(stored, parcel, settings, actor)
        : undefined;
    const attempt = await this.dependencies.store.begin(
      channelId,
      authorizationId,
      parcel.id,
      actor,
      this.dependencies.now(),
      quoteDecisionId,
    );
    if (attempt === null) return this.status(channelId, authorizationId);
    let outcome: Parameters<CustomerReturnLabelStore["finish"]>[1];
    try {
      const result = returnLabelRecordSchema.parse(
        await this.dependencies.provider.purchase(attempt.input),
      );
      assertLabelIdentity(result, attempt.input);
      outcome = { status: "succeeded", result };
    } catch (error) {
      outcome = {
        status:
          error instanceof ReturnLabelProviderError &&
          error.outcome === "rejected"
            ? "failed"
            : "uncertain",
        code:
          error instanceof ReturnLabelProviderError
            ? error.code
            : "RETURN_LABEL_OUTCOME_UNKNOWN",
      };
    }
    // A database failure here leaves the durable executing intent intact. It must
    // not be translated into a new purchase or a definitive carrier rejection.
    await this.dependencies.store.finish(
      attempt.id,
      outcome,
      actor,
      this.dependencies.now(),
    );
    return this.status(channelId, authorizationId);
  }

  private async quote(
    stored: StoredReturnLabels,
    parcel: StoredReturnLabels["parcels"][number],
    settings: CustomerReturnLabelSettings,
    actor: string,
  ): Promise<number> {
    const quotedAt = this.dependencies.now();
    const decision: CustomerReturnQuoteDecision = {
      settings,
      shipment: parcel.shipment,
      shipmentHash: customerReturnShipmentHash(parcel.shipment),
      result: null,
      selected: null,
      errorCode: null,
      quotedAt: quotedAt.toISOString(),
      expiresAt: new Date(
        quotedAt.getTime() + RETURN_RATE_QUOTE_MAX_AGE_MS,
      ).toISOString(),
    };
    try {
      const carrierIds =
        settings.selectionMode === "fixed_service"
          ? [settings.carrierId!]
          : settings.carrierRules
              .filter((rule) =>
                returnCarrierRuleAllowsWeight(
                  rule,
                  parcel.shipment.parcel.weightGrams,
                ),
              )
              .map((rule) => rule.carrierId);
      if (carrierIds.length === 0)
        throw new CustomerReturnRateSelectionError("RETURN_RATE_NONE_ELIGIBLE");
      decision.result = returnRateResultSchema.parse(
        await this.dependencies.rates.quote({
          shipment: parcel.shipment,
          carrierIds,
        }),
      );
      decision.selected = selectCustomerReturnRate({
        policy: settings,
        weightGrams: parcel.shipment.parcel.weightGrams,
        result: decision.result,
      }).selected;
    } catch (error) {
      decision.errorCode =
        error instanceof ReturnRateProviderError ||
        error instanceof CustomerReturnRateSelectionError
          ? error.code
          : "RETURN_RATE_UNAVAILABLE";
    }
    const id = await this.dependencies.store.recordQuote(
      stored.channelId,
      stored.authorizationId,
      parcel.id,
      decision,
      actor,
      this.dependencies.now(),
    );
    if (decision.errorCode)
      throw new CustomerReturnIntakeError(
        decision.errorCode,
        decision.errorCode === "RETURN_RATE_NONE_ELIGIBLE"
          ? "No allowed return service is available for this box. Review the carrier rules before continuing."
          : "Return rates could not be verified. No label was purchased; try again.",
        decision.errorCode === "RETURN_RATE_NONE_ELIGIBLE" ? 409 : 503,
      );
    return id;
  }

  async artifact(
    channelId: number,
    authorizationId: number,
    parcelId: number,
  ): Promise<ReturnLabelRecord> {
    await this.dependencies.authorizeChannel(channelId);
    const parcel = (
      await this.dependencies.store.read(channelId, authorizationId)
    ).parcels.find((row) => row.id === parcelId);
    if (
      !parcel ||
      parcel.attempt?.status !== "succeeded" ||
      !parcel.attempt.result
    )
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_NOT_READY",
        "This box's label is not ready to download.",
        409,
      );
    return returnLabelRecordSchema.parse(parcel.attempt.result);
  }

  private async recover(
    stored: StoredReturnLabels,
    parcel: StoredReturnLabels["parcels"][number],
    actor: string,
  ) {
    const attempt = parcel.attempt!;
    let outcome: Parameters<CustomerReturnLabelStore["finish"]>[1];
    try {
      if (!parcel.input)
        throw new Error("Saved return purchase request is missing.");
      const raw = await this.dependencies.provider.recover(parcel.input);
      if (raw === null)
        outcome = { status: "uncertain", code: "RETURN_LABEL_NOT_FOUND_YET" };
      else {
        const result = returnLabelRecordSchema.parse(raw);
        assertLabelIdentity(result, parcel.input);
        outcome = { status: "succeeded", result };
      }
    } catch (error) {
      outcome = {
        status: "uncertain",
        code:
          error instanceof ReturnLabelProviderError
            ? error.code
            : "RETURN_LABEL_RECOVERY_UNAVAILABLE",
      };
    }
    await this.dependencies.store.finish(
      attempt.id,
      outcome,
      actor,
      this.dependencies.now(),
    );
    return this.status(stored.channelId, stored.authorizationId);
  }
  private needsRecovery(attempt: ReturnLabelAttempt): boolean {
    return (
      attempt.status === "uncertain" ||
      (attempt.status === "executing" &&
        this.dependencies.now().getTime() - attempt.startedAt.getTime() >=
          RETURN_LABEL_EXECUTION_WINDOW_MS)
    );
  }
  private present(stored: StoredReturnLabels): CustomerReturnLabelStatus {
    const parcels = stored.parcels.map((parcel) => {
      const attempt = parcel.attempt;
      const status = !attempt
        ? "pending"
        : attempt.status === "succeeded"
          ? "ready"
          : attempt.status === "failed"
            ? "failed"
            : this.needsRecovery(attempt)
              ? "needs_review"
              : "processing";
      return {
        parcelId: parcel.id,
        number: parcel.number,
        status,
        trackingNumber:
          status === "ready" ? attempt!.result!.trackingNumber : null,
        downloadPath:
          status === "ready"
            ? `/api/returns/admin/portal-preview/live/labels/${stored.channelId}/${stored.authorizationId}/parcels/${parcel.id}/download`
            : null,
      };
    });
    return customerReturnLabelStatusSchema.parse({
      channelId: stored.channelId,
      authorizationId: stored.authorizationId,
      authorizationNumber: stored.authorizationNumber,
      parcels,
      canProgress: parcels.some(
        (parcel) =>
          parcel.status === "pending" || parcel.status === "needs_review",
      ),
    });
  }
}
function assertLabelIdentity(
  result: ReturnLabelRecord,
  input: ReturnLabelInput,
): void {
  if (
    result.externalShipmentId !== input.externalShipmentId ||
    result.carrierId !== input.carrierId ||
    result.serviceCode !== input.serviceCode
  )
    throw new ReturnLabelProviderError(
      "RETURN_LABEL_IDENTITY_MISMATCH",
      "unknown",
    );
}
