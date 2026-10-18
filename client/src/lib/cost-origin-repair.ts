import { canonicalJson } from "@shared/utils/canonical-json";
import {
  originRepairContextSchema,
  originRepairId,
  originRepairRequestSchema,
} from "@shared/procurement/cost-origin-repair";
import {
  createFinancialCommandIntentStore,
  financialCommandFetchJson,
  FinancialCommandRequestError,
} from "./financial-command";

export function createOriginRepairClient(generateKey: () => string) {
  const intent = createFinancialCommandIntentStore(generateKey);
  let pending: string | null = null;
  return {
    async approve(lotId: number, input: unknown) {
      originRepairId.parse(lotId);
      const body = originRepairRequestSchema.parse(input),
        fingerprint = canonicalJson({ lotId, body });
      if (pending !== null && pending !== fingerprint)
        throw new FinancialCommandRequestError(
          "Retry the pending approval before changing this repair.",
          {
            status: null,
            code: "COST_ORIGIN_PENDING",
            ambiguous: true,
            retryable: true,
          },
        );
      const key = intent.acquire({ lotId, body });
      pending = fingerprint;
      try {
        const raw = await financialCommandFetchJson<unknown>(
          `/api/inventory-lots/${lotId}/cost-origin-repair`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify(body),
          },
        );
        const parsed = originRepairContextSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.lotId !== lotId ||
          !parsed.data.approval ||
          parsed.data.approval.destination !== body.destination
        )
          throw new FinancialCommandRequestError(
            "The saved repair could not be verified. Retry this approval or reload its saved result.",
            {
              status: 200,
              code: "COST_ORIGIN_RESPONSE",
              ambiguous: true,
              retryable: true,
            },
          );
        intent.complete(key);
        pending = null;
        return parsed.data;
      } catch (error) {
        intent.fail(key, error);
        if (
          !(error instanceof FinancialCommandRequestError) ||
          !error.ambiguous
        )
          pending = null;
        throw error;
      }
    },
  };
}
