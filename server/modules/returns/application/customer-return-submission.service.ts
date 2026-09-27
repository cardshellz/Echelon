import {
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
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
  live: Pick<CustomerReturnLiveService, "inspectForIntake">;
  settings: Pick<CustomerReturnLabelSettingsService, "requireEnabled">;
  labels: Pick<CustomerReturnLabelsService, "status">;
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
    const parsed = customerReturnLabelSubmitInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_INPUT_INVALID",
        "Review the return items and boxes.",
        400,
      );
    const request = parsed.data;
    await this.dependencies.authorizeChannel(request.channelId);
    const command = await this.dependencies.commands.acquire({
      channelId: request.channelId,
      key: request.idempotencyKey,
      request,
      hash: customerReturnSubmissionHash(request),
      actor,
      token: this.dependencies.newToken(),
      now: this.dependencies.now(),
    });
    return this.execute(command);
  }
  async resume(channelId: number, key: string, actor: string) {
    await this.dependencies.authorizeChannel(channelId);
    const command = await this.dependencies.commands.acquire({
      channelId,
      key,
      actor,
      token: this.dependencies.newToken(),
      now: this.dependencies.now(),
    });
    return this.execute(command);
  }
  async status(channelId: number, key: string) {
    await this.dependencies.authorizeChannel(channelId);
    const command = await this.dependencies.commands.read(channelId, key);
    if (!command) throw submissionNotFound();
    return this.completed(command);
  }
  private async execute(command: ReturnSubmissionCommand) {
    if (command.status !== "preparing") return this.completed(command);
    const { request } = command;
    try {
      const { settings, operationalPolicy } =
        await this.dependencies.settings.requireEnabled(
          request.channelId,
          request.settingsVersion,
        );
      const inspection = await this.dependencies.live.inspectForIntake({
        channelId: request.channelId,
        orderReference: request.orderReference,
      });
      const prepared = prepareCustomerReturnIntake(
        request,
        inspection,
        settings,
        operationalPolicy,
        command.actor,
        command.leaseToken,
      );
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
