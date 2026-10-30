import { CustomerReturnAuthorizationPersistenceError } from "./customer-return-authorization.ports";
import { customerReturnRejectionMessage } from "@shared/returns/customer-return-errors";
import {
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import {
  customerReturnCanonicalOrderScopeSchema,
  type CustomerReturnCanonicalOrderScope,
} from "./customer-return-order-access.service";
import {
  CustomerReturnIntakeError,
  type CustomerReturnIntakeStore,
} from "./customer-return-intake.ports";
import { CustomerReturnBoxPlanError } from "./customer-return-box-plan";
import { CustomerReturnLiveError } from "./customer-return-live-error";
import {
  customerReturnSubmissionHash,
  prepareCustomerReturnIntake,
} from "./customer-return-intake-preparation";
import type { CustomerReturnLiveService } from "./customer-return-live.service";
import type { CustomerReturnLabelSettingsService } from "./customer-return-label-settings.service";
import type { CustomerReturnLabelsService } from "./customer-return-labels.service";

export interface ReturnSubmissionCommand {
  request: CustomerReturnLabelSubmitInput;
  /** Null for historical/staff intent; customer commands always bind a canonical order. */
  omsOrderId: number | null;
  actor: string;
  leaseToken: string;
  status: "preparing" | "accepted" | "rejected";
  authorizationId: number | null;
  errorCode?: string | null;
}
export interface CustomerReturnSubmissionStore {
  read(channelId: number, key: string): Promise<ReturnSubmissionCommand | null>;
  acquire(input: {
    channelId: number;
    key: string;
    request?: CustomerReturnLabelSubmitInput;
    hash?: string;
    actor: string;
    token: string;
    now: Date;
    omsOrderId?: number;
  }): Promise<ReturnSubmissionCommand>;
  /** CAS rejection cannot invalidate an accepted intake or a newer worker lease. */
  reject(
    channelId: number,
    key: string,
    token: string,
    code: string,
    now: Date,
  ): Promise<void>;
}
export type ReturnSubmissionStage = "settings" | "inspection" | "preparation" | "rate_quote" | "intake" | "label_status";
export interface ReturnSubmissionFailure {
  event: "customer_return_submission_failed";
  stage: ReturnSubmissionStage;
  code: string;
  channelId: number;
  omsOrderId: number | null;
  idempotencyKey: string;
}
export interface CustomerReturnSubmissionDependencies {
  commands: CustomerReturnSubmissionStore;
  intake: CustomerReturnIntakeStore;
  live: Pick<CustomerReturnLiveService, "inspectForIntake"> &
    Partial<Pick<CustomerReturnLiveService, "inspectCanonicalForIntake">>;
  settings: Pick<CustomerReturnLabelSettingsService, "requireEnabled">;
  labels: Pick<CustomerReturnLabelsService, "status"> &
    Partial<Pick<CustomerReturnLabelsService, "preflight">>;
  authorizeChannel: (channelId: number) => Promise<void>;
  now: () => Date;
  newToken: () => string;
  reportFailure?: (event: ReturnSubmissionFailure) => void;
}
/** No carrier purchase happens here. Intake persists all receiving evidence atomically. */
export class CustomerReturnSubmissionService {
  constructor(
    private readonly dependencies: CustomerReturnSubmissionDependencies,
  ) {}
  async submit(raw: unknown, actor: string) {
    return this.submitInternal(raw, actor);
  }
  /** Trusted application entry point; customer ownership must be verified first. */
  async submitForOrder(
    raw: unknown,
    actor: string,
    scope: CustomerReturnCanonicalOrderScope,
  ) {
    return this.submitInternal(
      raw,
      actor,
      customerReturnCanonicalOrderScopeSchema.parse(scope),
    );
  }
  private async submitInternal(
    raw: unknown,
    actor: string,
    scope?: CustomerReturnCanonicalOrderScope,
  ) {
    const parsed = customerReturnLabelSubmitInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_INPUT_INVALID",
        "Review the return items and boxes.",
        400,
      );
    const request = parsed.data;
    if (scope && scope.channelId !== request.channelId) throw commandConflict();
    const omsOrderId = scope?.omsOrderId;
    await this.dependencies.authorizeChannel(request.channelId);
    const command = await this.dependencies.commands.acquire({
      channelId: request.channelId,
      key: request.idempotencyKey,
      request,
      hash: customerReturnSubmissionHash(request, omsOrderId),
      ...(omsOrderId === undefined ? {} : { omsOrderId }),
      actor,
      token: this.dependencies.newToken(),
      now: this.dependencies.now(),
    });
    assertBoundOrder(command, omsOrderId);
    return this.execute(command, scope);
  }
  async resume(channelId: number, key: string, actor: string) {
    return this.resumeInternal(channelId, key, actor);
  }
  async resumeForOrder(
    channelId: number,
    key: string,
    actor: string,
    scope: CustomerReturnCanonicalOrderScope,
  ) {
    const checked = customerReturnCanonicalOrderScopeSchema.parse(scope);
    if (checked.channelId !== channelId) throw commandConflict();
    return this.resumeInternal(channelId, key, actor, checked);
  }
  private async resumeInternal(
    channelId: number,
    key: string,
    actor: string,
    scope?: CustomerReturnCanonicalOrderScope,
  ) {
    const omsOrderId = scope?.omsOrderId;
    await this.dependencies.authorizeChannel(channelId);
    const command = await this.dependencies.commands.acquire({
      channelId,
      key,
      actor,
      token: this.dependencies.newToken(),
      now: this.dependencies.now(),
      ...(omsOrderId === undefined ? {} : { omsOrderId }),
    });
    assertBoundOrder(command, omsOrderId);
    return this.execute(command, scope);
  }
  async status(channelId: number, key: string) {
    await this.dependencies.authorizeChannel(channelId);
    const command = await this.dependencies.commands.read(channelId, key);
    if (!command) throw submissionNotFound();
    return this.completed(command);
  }
  private async execute(
    command: ReturnSubmissionCommand,
    scope?: CustomerReturnCanonicalOrderScope,
  ) {
    if (command.status !== "preparing") return this.completed(command);
    const { request } = command;
    let stage: ReturnSubmissionStage = "settings";
    try {
      const { settings, operationalPolicy } =
        await this.dependencies.settings.requireEnabled(
          request.channelId,
          request.settingsVersion,
        );
      stage = "inspection";
      const inspection =
        command.omsOrderId === null
          ? await this.dependencies.live.inspectForIntake({
              channelId: request.channelId,
              orderReference: request.orderReference,
            })
          : await this.inspectCanonical(command, scope);
      stage = "preparation";
      const prepared = prepareCustomerReturnIntake(
        request,
        inspection,
        settings,
        operationalPolicy,
        command.actor,
        command.leaseToken,
        command.omsOrderId ?? undefined,
      );
      if (settings.parcelGuardrails != null) {
        stage = "rate_quote";
        if (!this.dependencies.labels.preflight)
          throw new CustomerReturnIntakeError(
            "RETURN_RATE_UNAVAILABLE",
            "Prepaid shipping could not be verified before creating this return.",
            503,
          );
        await this.dependencies.labels.preflight(prepared, settings);
      }
      stage = "intake";
      const result = await this.dependencies.intake.persist({
        ...prepared,
        now: this.dependencies.now(),
      });
      stage = "label_status";
      return await this.dependencies.labels.status(
        request.channelId,
        result.authorizationId,
      );
    } catch (error) {
      const event: ReturnSubmissionFailure = {
        event: "customer_return_submission_failed", stage, code: submissionFailureCode(error),
        channelId: request.channelId, omsOrderId: command.omsOrderId, idempotencyKey: request.idempotencyKey,
      };
      // Trace the failed boundary without serializing customer details, SQL,
      // provider payloads, or exception messages. Reporting cannot change intent.
      try {
        if (this.dependencies.reportFailure) this.dependencies.reportFailure(event);
        else console.error(JSON.stringify(event));
      } catch {
        console.error(JSON.stringify({ ...event, reportingFailed: true }));
      }
      // Only known validation failures prove preparation did not authorize a return.
      // Unknown database/transport failures retain the original durable intent.
      const code = definitiveFailureCode(error);
      if (code !== null) {
        await this.dependencies.commands.reject(
          request.channelId,
          request.idempotencyKey,
          command.leaseToken,
          code,
          this.dependencies.now(),
        );
        const latest = await this.dependencies.commands.read(
          request.channelId,
          request.idempotencyKey,
        );
        if (latest?.status === "accepted") return this.completed(latest);
        if (latest?.status === "rejected")
          throw new CustomerReturnIntakeError(
            "RETURN_LABEL_SUBMISSION_REJECTED",
            customerReturnRejectionMessage(latest.errorCode ?? code),
            410,
            latest.errorCode ?? code,
          );
      }
      throw processing({ code: event.code, stage: event.stage });
    }
  }
  private inspectCanonical(
    command: ReturnSubmissionCommand,
    scope?: CustomerReturnCanonicalOrderScope,
  ) {
    const inspect = this.dependencies.live.inspectCanonicalForIntake;
    if (!inspect || !scope)
      throw new CustomerReturnIntakeError(
        "RETURN_CUSTOMER_INTAKE_UNAVAILABLE",
        "This return is temporarily unavailable. Check its saved status before retrying.",
        503,
      );
    assertBoundOrder(command, scope.omsOrderId);
    if (command.request.channelId !== scope.channelId) throw commandConflict();
    return inspect.call(this.dependencies.live, scope);
  }
  private completed(command: ReturnSubmissionCommand) {
    if (command.status === "rejected")
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SUBMISSION_REJECTED",
        customerReturnRejectionMessage(command.errorCode),
        410,
        command.errorCode ?? undefined,
      );
    if (command.status !== "accepted" || command.authorizationId === null)
      throw processing();
    return this.dependencies.labels.status(
      command.request.channelId,
      command.authorizationId,
    );
  }
}
function assertBoundOrder(
  command: ReturnSubmissionCommand,
  omsOrderId: number | undefined,
): void {
  if (omsOrderId !== undefined && command.omsOrderId !== omsOrderId)
    throw commandConflict();
}
function commandConflict(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_COMMAND_CONFLICT",
    "This request belongs to different return details.",
    409,
  );
}
export class CustomerReturnSubmissionProcessingError extends CustomerReturnIntakeError {
  constructor(readonly failure?: { code: string; stage: ReturnSubmissionStage }) {
    super("RETURN_LABEL_SUBMISSION_PROCESSING", "Your label request is saved. Please try again to continue.", 409);
  }
}
export function processing(failure?: { code: string; stage: ReturnSubmissionStage }): CustomerReturnIntakeError {
  return new CustomerReturnSubmissionProcessingError(failure);
}
export function submissionNotFound(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_SUBMISSION_NOT_FOUND",
    "This request has not been recorded yet. Check again before starting another return.",
    404,
  );
}

function definitiveFailureCode(error: unknown): string | null {
  if (error instanceof CustomerReturnBoxPlanError) return "RETURN_LABEL_BOX_PLAN_INVALID";
  if ((error instanceof CustomerReturnIntakeError || error instanceof CustomerReturnLiveError) && error.status < 500) return error.code;
  if (error instanceof CustomerReturnAuthorizationPersistenceError
    && (error.code === "RETURN_AUTHORIZATION_SOURCE_CONFLICT" || error.code === "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED")) return error.code;
  return null;
}

/** Drizzle wraps PostgreSQL errors in cause. Read only bounded, recognizable
 * codes; never pass arbitrary provider text or query parameters to logs. */
function submissionFailureCode(error: unknown): string {
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause !== null && typeof cause === "object"; depth++) {
    const detail = cause as { code?: unknown; cause?: unknown };
    if (typeof detail.code === "string" && /^(?:[A-Z0-9]{5}|RETURN_[A-Z0-9_]{1,74})$/.test(detail.code)) return detail.code;
    cause = detail.cause;
  }
  return "RETURN_SUBMISSION_UNEXPECTED_FAILURE";
}
