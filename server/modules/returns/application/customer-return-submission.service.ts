import {
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { customerReturnCanonicalOrderScopeSchema, type CustomerReturnCanonicalOrderScope } from "./customer-return-order-access.service";
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
export interface CustomerReturnSubmissionDependencies {
  commands: CustomerReturnSubmissionStore;
  intake: CustomerReturnIntakeStore;
  live: Pick<CustomerReturnLiveService, "inspectForIntake"> & Partial<Pick<CustomerReturnLiveService, "inspectCanonicalForIntake">>;
  settings: Pick<CustomerReturnLabelSettingsService, "requireEnabled">;
  labels: Pick<CustomerReturnLabelsService, "status"> & Partial<Pick<CustomerReturnLabelsService, "preflight">>;
  authorizeChannel: (channelId: number) => Promise<void>;
  now: () => Date;
  newToken: () => string;
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
  async submitForOrder(raw: unknown, actor: string, scope: CustomerReturnCanonicalOrderScope) {
    return this.submitInternal(raw, actor, customerReturnCanonicalOrderScopeSchema.parse(scope));
  }
  private async submitInternal(raw: unknown, actor: string, scope?: CustomerReturnCanonicalOrderScope) {
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
  async resumeForOrder(channelId: number, key: string, actor: string, scope: CustomerReturnCanonicalOrderScope) {
    const checked = customerReturnCanonicalOrderScopeSchema.parse(scope);
    if (checked.channelId !== channelId) throw commandConflict();
    return this.resumeInternal(channelId, key, actor, checked);
  }
  private async resumeInternal(channelId: number, key: string, actor: string, scope?: CustomerReturnCanonicalOrderScope) {
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
  private async execute(command: ReturnSubmissionCommand, scope?: CustomerReturnCanonicalOrderScope) {
    if (command.status !== "preparing") return this.completed(command);
    const { request } = command;
    try {
      const { settings, operationalPolicy } =
        await this.dependencies.settings.requireEnabled(
          request.channelId,
          request.settingsVersion,
        );
      const inspection = command.omsOrderId === null
        ? await this.dependencies.live.inspectForIntake({ channelId: request.channelId, orderReference: request.orderReference })
        : await this.inspectCanonical(command, scope);
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
        if (!this.dependencies.labels.preflight) throw new CustomerReturnIntakeError(
          "RETURN_RATE_UNAVAILABLE", "Prepaid shipping could not be verified before creating this return.", 503);
        await this.dependencies.labels.preflight(prepared, settings);
      }
      const result = await this.dependencies.intake.persist({
        ...prepared,
        now: this.dependencies.now(),
      });
      return this.dependencies.labels.status(
        request.channelId,
        result.authorizationId,
      );
    } catch (error) {
      // Only known validation failures prove preparation did not authorize a return.
      // Unknown database/transport failures retain the original durable intent.
      const definitive =
        error instanceof CustomerReturnBoxPlanError ||
        ((error instanceof CustomerReturnIntakeError ||
          error instanceof CustomerReturnLiveError) &&
          error.status < 500);
      if (definitive) {
        const code =
          error instanceof CustomerReturnBoxPlanError
            ? "RETURN_LABEL_BOX_PLAN_INVALID"
            : error.code;
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
            error.message,
            410,
          );
      }
      throw processing();
    }
  }
  private inspectCanonical(command: ReturnSubmissionCommand, scope?: CustomerReturnCanonicalOrderScope) {
    const inspect = this.dependencies.live.inspectCanonicalForIntake;
    if (!inspect || !scope) throw new CustomerReturnIntakeError(
      "RETURN_CUSTOMER_INTAKE_UNAVAILABLE", "This return is temporarily unavailable. Check its saved status before retrying.", 503,
    );
    assertBoundOrder(command, scope.omsOrderId);
    if (command.request.channelId !== scope.channelId) throw commandConflict();
    return inspect.call(this.dependencies.live, scope);
  }
  private completed(command: ReturnSubmissionCommand) {
    if (command.status === "rejected")
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SUBMISSION_REJECTED",
        "This request was not accepted. Reload the order to review it again.",
        410,
      );
    if (command.status !== "accepted" || command.authorizationId === null)
      throw processing();
    return this.dependencies.labels.status(
      command.request.channelId,
      command.authorizationId,
    );
  }
}
function assertBoundOrder(command: ReturnSubmissionCommand, omsOrderId: number | undefined): void {
  if (omsOrderId !== undefined && command.omsOrderId !== omsOrderId) throw commandConflict();
}
function commandConflict(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_COMMAND_CONFLICT", "This request belongs to different return details.", 409,
  );
}
export function processing(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_SUBMISSION_PROCESSING",
    "Your return is being checked. Check its status before starting another request.",
    409,
  );
}
export function submissionNotFound(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_SUBMISSION_NOT_FOUND",
    "This request has not been recorded yet. Check again before starting another return.",
    404,
  );
}
