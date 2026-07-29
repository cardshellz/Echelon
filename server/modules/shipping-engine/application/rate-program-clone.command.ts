import { financialCommandRepository } from "../../../platform/commands/command-results.repository";
import {
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
  type FinancialCommandRepository,
} from "../../../platform/commands/transactional-command.service";
import { RateCoverageAdminError } from "./rate-coverage-admin.service";
import {
  copyActiveRatesToProgram,
  RateProgramCloneError,
  type CopyActiveRatesResult,
} from "./rate-program-clone.service";
import { PostgresRateProgramCloneRepository } from "../infrastructure/rate-program-clone.repository";
import { db } from "../../../db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RateProgramCloneClock {
  now(): Date;
}

export interface CopyRateProgramCommandInput {
  sourceRateBookId: number;
  targetRateBookId: number;
  actor: string;
}

export function classifyRateProgramCloneFailure(
  error: unknown,
): FinancialCommandFailureDisposition {
  if (error instanceof RateProgramCloneError) {
    if (error.statusCode >= 400 && error.statusCode <= 499) {
      return {
        kind: "rejected",
        httpStatus: error.statusCode,
        body: {
          error: {
            code: error.code,
            message: error.message,
            ...(error.context === undefined
              ? {}
              : { context: error.context }),
          },
        },
        errorCode: error.code,
        errorMessage: error.message,
      };
    }
  }

  if (
    error instanceof RateCoverageAdminError
    && error.status >= 400
    && error.status <= 499
  ) {
    return {
      kind: "rejected",
      httpStatus: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      errorCode: error.code,
      errorMessage: error.message,
    };
  }

  return {
    kind: "retryable",
    errorCode: "SHIPPING_ADMIN_COPY_TRANSIENT_FAILURE",
    errorMessage:
      "Shipping rate program copy failed before its transaction committed.",
  };
}

export function createRateProgramCloneCommand(
  repository: FinancialCommandRepository<Transaction> =
    financialCommandRepository,
  clock: RateProgramCloneClock = { now: () => new Date() },
) {
  return {
    async execute(
      input: CopyRateProgramCommandInput,
      descriptor: FinancialCommandDescriptor,
    ) {
      return runTransactionalFinancialCommand<
        Transaction,
        CopyActiveRatesResult
      >({
        repository,
        descriptor,
        classifyFailure: classifyRateProgramCloneFailure,
        work: async (tx) => {
          const result = await copyActiveRatesToProgram(
            new PostgresRateProgramCloneRepository(tx),
            {
              ...input,
              now: clock.now(),
            },
          );
          return {
            httpStatus: 201,
            body: result,
            resultType: "shipping_rate_book",
            resultId: input.targetRateBookId,
          };
        },
      });
    },
  };
}

export const rateProgramCloneCommand = createRateProgramCloneCommand();
