import {
  customerReturnLabelStatusSchema,
  type CustomerReturnLabelStatus,
} from "@shared/returns/customer-return-label.contract";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";
import {
  ReturnLabelProviderError,
  returnLabelRecordSchema,
  type ReturnLabelInput,
  type ReturnLabelProvider,
  type ReturnLabelRecord,
} from "../../shipping-engine/application/return-label-provider.port";

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
    input: ReturnLabelInput;
    attempt: ReturnLabelAttempt | null;
  }[];
}
export interface CustomerReturnLabelStore {
  read(channelId: number, authorizationId: number): Promise<StoredReturnLabels>;
  /** Locks the parcel and settings; commits intent before any carrier request. */
  begin(
    channelId: number,
    authorizationId: number,
    parcelId: number,
    actor: string,
    now: Date,
  ): Promise<number | null>;
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
  authorizeChannel: (channelId: number) => Promise<void>;
  requirePurchaseConfiguration: (channelId: number) => Promise<void>;
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
    await this.dependencies.requirePurchaseConfiguration(channelId);
    const attemptId = await this.dependencies.store.begin(
      channelId,
      authorizationId,
      parcel.id,
      actor,
      this.dependencies.now(),
    );
    if (attemptId === null) return this.status(channelId, authorizationId);
    let outcome: Parameters<CustomerReturnLabelStore["finish"]>[1];
    try {
      const result = returnLabelRecordSchema.parse(
        await this.dependencies.provider.purchase(parcel.input),
      );
      assertLabelIdentity(result, parcel.input);
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
      attemptId,
      outcome,
      actor,
      this.dependencies.now(),
    );
    return this.status(channelId, authorizationId);
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
