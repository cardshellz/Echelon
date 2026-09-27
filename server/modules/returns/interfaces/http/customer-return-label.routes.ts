import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  CUSTOMER_RETURN_LABEL_API,
  customerReturnLabelSettingsInputSchema,
  customerReturnLabelSettingsStateSchema,
  customerReturnLabelStatusSchema,
  customerReturnLabelSubmitInputSchema,
} from "@shared/returns/customer-return-label.contract";
import { CustomerReturnIntakeError } from "../../application/customer-return-intake.ports";
import { CustomerReturnLiveError } from "../../application/customer-return-live-error";
import type { CustomerReturnLabelSettingsService } from "../../application/customer-return-label-settings.service";
import type { CustomerReturnLabelsService } from "../../application/customer-return-labels.service";
import type { CustomerReturnSubmissionService } from "../../application/customer-return-submission.service";

export interface CustomerReturnLabelRouteServices {
  settings: Pick<CustomerReturnLabelSettingsService, "get" | "save">;
  labels: Pick<CustomerReturnLabelsService, "status" | "progress" | "artifact">;
  submissions: Pick<
    CustomerReturnSubmissionService,
    "submit" | "resume" | "status"
  >;
  download: (url: string) => Promise<Uint8Array>;
}
export interface CustomerReturnLabelRouteDependencies {
  services?: () => Promise<CustomerReturnLabelRouteServices>;
  report?: (event: { operation: string; code: string }) => void;
}
/** Must be mounted after the existing fresh administrator gate and before its 404. */
export function registerCustomerReturnLabelRoutes(
  app: Express,
  dependencies: CustomerReturnLabelRouteDependencies = {},
): void {
  const services =
    dependencies.services ??
    (async () =>
      (
        await import("../../infrastructure/customer-return-label.composition")
      ).createCustomerReturnLabelServices());
  const base = CUSTOMER_RETURN_LABEL_API;
  const settingsPath = `${base}/label-settings/:channelId`;
  const commandPath = `${base}/labels/:channelId/by-command/:idempotencyKey`;
  const statusPath = `${base}/labels/:channelId/:authorizationId`;
  const downloadPath = `${statusPath}/parcels/:parcelId/download`;
  type Handler = (
    req: Request,
    service: CustomerReturnLabelRouteServices,
    actor: string,
  ) => Promise<unknown>;
  const handle =
    (operation: string, mutate: boolean, run: Handler) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        if (Object.keys(req.query).length) throw invalid();
        const actor = z
          .string()
          .trim()
          .min(1)
          .max(255)
          .parse((req.session as { user?: { id?: unknown } })?.user?.id);
        if (mutate) requireSameOriginCommand(req);
        const value = await run(req, await services(), actor);
        if (value instanceof Uint8Array) {
          res
            .type("application/pdf")
            .setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="return-${number(req.params.authorizationId)}-box-${number(req.params.parcelId)}.pdf"`,
          );
          res.send(Buffer.from(value));
        } else res.json(value);
      } catch (error) {
        const known =
          error instanceof CustomerReturnIntakeError ||
          error instanceof CustomerReturnLiveError;
        const code = known ? error.code : "RETURN_LABEL_UNAVAILABLE";
        try {
          (
            dependencies.report ??
            ((event) => console.error(JSON.stringify(event)))
          )({ operation, code });
        } catch {
          console.error(
            JSON.stringify({
              operation,
              code: "RETURN_LABEL_REPORTING_FAILED",
            }),
          );
        }
        res
          .status(known ? error.status : 503)
          .json({
            error: {
              code,
              message: known
                ? error.message
                : "Return labels are temporarily unavailable. Check the saved return status before trying again.",
            },
          });
      }
    };
  app.get(
    settingsPath,
    handle("return_label_settings_read", false, async (req, service) =>
      customerReturnLabelSettingsStateSchema.parse(
        await service.settings.get(number(req.params.channelId)),
      ),
    ),
  );
  app.put(
    settingsPath,
    handle("return_label_settings_save", true, async (req, service, actor) =>
      customerReturnLabelSettingsStateSchema.parse(
        await service.settings.save(
          number(req.params.channelId),
          input(customerReturnLabelSettingsInputSchema, req.body),
          actor,
        ),
      ),
    ),
  );
  app.post(
    `${base}/labels`,
    handle("return_label_submit", true, async (req, service, actor) =>
      customerReturnLabelStatusSchema.parse(
        await service.submissions.submit(
          input(customerReturnLabelSubmitInputSchema, req.body),
          actor,
        ),
      ),
    ),
  );
  app.get(
    commandPath,
    handle("return_label_submission_status", false, async (req, service) =>
      customerReturnLabelStatusSchema.parse(
        await service.submissions.status(
          number(req.params.channelId),
          input(z.string().uuid(), req.params.idempotencyKey),
        ),
      ),
    ),
  );
  app.post(
    `${commandPath}/resume`,
    handle(
      "return_label_submission_resume",
      true,
      async (req, service, actor) => {
        input(z.object({}).strict(), req.body);
        return customerReturnLabelStatusSchema.parse(
          await service.submissions.resume(
            number(req.params.channelId),
            input(z.string().uuid(), req.params.idempotencyKey),
            actor,
          ),
        );
      },
    ),
  );
  app.get(
    statusPath,
    handle("return_label_status", false, async (req, service) =>
      customerReturnLabelStatusSchema.parse(
        await service.labels.status(
          number(req.params.channelId),
          number(req.params.authorizationId),
        ),
      ),
    ),
  );
  app.post(
    `${statusPath}/progress`,
    handle("return_label_progress", true, async (req, service, actor) => {
      input(z.object({}).strict(), req.body);
      return customerReturnLabelStatusSchema.parse(
        await service.labels.progress(
          number(req.params.channelId),
          number(req.params.authorizationId),
          actor,
        ),
      );
    }),
  );
  app.get(
    downloadPath,
    handle("return_label_download", false, async (req, service) => {
      const record = await service.labels.artifact(
        number(req.params.channelId),
        number(req.params.authorizationId),
        number(req.params.parcelId),
      );
      return service.download(record.downloadUrl);
    }),
  );
  for (const [path, allow] of [
    [settingsPath, "GET, PUT"],
    [`${base}/labels`, "POST"],
    [commandPath, "GET"],
    [`${commandPath}/resume`, "POST"],
    [statusPath, "GET"],
    [`${statusPath}/progress`, "POST"],
    [downloadPath, "GET"],
  ]) {
    app.all(path, (_req, res) => {
      res.setHeader("Allow", allow);
      res
        .status(405)
        .json({
          error: {
            code: "RETURN_LABEL_METHOD_NOT_ALLOWED",
            message: "This return label method is not available.",
          },
        });
    });
  }
}
function requireSameOriginCommand(req: Request): void {
  const origin = req.get("origin");
  if (
    req.get("X-Return-Command") !== "1" ||
    req.get("Sec-Fetch-Site") === "cross-site" ||
    origin !== `${req.protocol}://${req.get("host")}`
  )
    throw new CustomerReturnIntakeError(
      "RETURN_LABEL_COMMAND_FORBIDDEN",
      "Refresh the private returns portal before continuing.",
      403,
    );
}
function input<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function number(value: unknown): number {
  return input(
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().positive().safe()),
    value,
  );
}
function invalid(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_INPUT_INVALID",
    "The return label request is invalid.",
    400,
  );
}
