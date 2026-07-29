import type { Express, Request, Response } from "express";
import { z } from "zod";

import { requirePermission } from "../../../../routes/middleware";
import { financialCommandFromRequest } from "../../../../platform/commands/http-command";
import {
  FinancialCommandError,
  type FinancialCommandDescriptor,
  type FinancialCommandResult,
} from "../../../../platform/commands/transactional-command.service";
import {
  rateProgramCloneCommand,
  type CopyRateProgramCommandInput,
} from "../../application/rate-program-clone.command";

const RATE_PROGRAM_COPY_ROUTE =
  "/api/shipping/admin/rate-books/:targetRateBookId/copy-rates";
const idSchema = z.coerce.number().int().positive();
const copyRatesBodySchema = z.object({
  sourceRateBookId: z.number().int().positive(),
}).strict();

type CloneCommand = {
  execute(
    input: CopyRateProgramCommandInput,
    descriptor: FinancialCommandDescriptor,
  ): Promise<FinancialCommandResult>;
};

export interface RateProgramCloneRouteDependencies {
  command?: CloneCommand;
}

export function registerRateProgramCloneRoutes(
  app: Express,
  dependencies: RateProgramCloneRouteDependencies = {},
): void {
  const command = dependencies.command ?? rateProgramCloneCommand;

  app.post(
    RATE_PROGRAM_COPY_ROUTE,
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const targetRateBookId = idSchema.parse(
          req.params.targetRateBookId,
        );
        const body = copyRatesBodySchema.parse(req.body);
        const descriptor = financialCommandFromRequest(req, {
          actorId: auditActor(req),
          routeTemplate: RATE_PROGRAM_COPY_ROUTE,
          resourceKey: `shipping_rate_book:${targetRateBookId}`,
          commandName: "shipping.rate_program.copy_rates",
        });
        const result = await command.execute({
          sourceRateBookId: body.sourceRateBookId,
          targetRateBookId,
          actor: descriptor.actorId,
        }, descriptor);
        return sendCommandResult(res, result);
      } catch (error) {
        return sendCloneError(res, error);
      }
    },
  );
}

function sendCommandResult(
  res: Response,
  result: FinancialCommandResult,
): Response {
  res.setHeader(
    "Idempotency-Replayed",
    result.replayed ? "true" : "false",
  );
  return res.status(result.httpStatus).json(result.body);
}

function sendCloneError(res: Response, error: unknown): Response {
  if (error instanceof FinancialCommandError) {
    for (const [name, value] of Object.entries(
      error.responseHeaders ?? {},
    )) {
      res.setHeader(name, value);
    }
    return res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined
          ? {}
          : { context: error.details }),
      },
    });
  }

  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: {
        code: "SHIPPING_ADMIN_COPY_INPUT_INVALID",
        message: "Valid source and target pricing program IDs are required.",
        details: error.issues.map((issue) => issue.message),
      },
    });
  }

  console.error(JSON.stringify({
    code: "SHIPPING_ADMIN_COPY_REQUEST_FAILED",
    message: "Shipping rate program copy request failed.",
    context: {
      error: error instanceof Error ? error.message : String(error),
    },
  }));
  return res.status(500).json({
    error: {
      code: "SHIPPING_ADMIN_COPY_REQUEST_FAILED",
      message: "Could not copy the shipping rates.",
    },
  });
}

function auditActor(req: Request): string | undefined {
  const request = req as Request & {
    user?: { id?: unknown };
    session?: { user?: { id?: unknown } };
  };
  const actor = request.user?.id ?? request.session?.user?.id;
  return actor === undefined || actor === null ? undefined : String(actor);
}
