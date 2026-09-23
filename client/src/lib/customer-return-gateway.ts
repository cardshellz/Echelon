import { z } from "zod";
import {
  customerReturnFlowOrderSchema,
  customerReturnFlowReviewInputSchema,
  customerReturnFlowReviewSchema,
  type CustomerReturnFlowOrder,
  type CustomerReturnFlowReview,
  type CustomerReturnFlowReviewInput,
} from "@shared/returns/customer-return-flow.contract";
import {
  returnPreviewLookupInputSchema,
  returnPreviewOrderSchema,
  returnPreviewReviewInputSchema,
  returnPreviewReviewSchema,
  type ReturnPreviewScenarioId,
} from "@shared/returns/customer-return-preview.contract";
import {
  customerReturnLiveLookupInputSchema,
  customerReturnLiveOrderSchema,
  customerReturnLiveReviewInputSchema,
  customerReturnLiveReviewSchema,
} from "@shared/returns/customer-return-live.contract";
import { CUSTOMER_RETURN_PREVIEW_API_PATH } from "@shared/returns/customer-return-portal-paths";
import {
  assertReturnFlowOrderMatches,
  readPreviewResponse,
} from "@/lib/customer-return-preview";

export interface CustomerReturnFlowGateway {
  lookup(
    reference: string,
    signal: AbortSignal,
  ): Promise<CustomerReturnFlowOrder>;
  review(
    input: CustomerReturnFlowReviewInput,
    signal: AbortSignal,
  ): Promise<CustomerReturnFlowReview>;
}

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Sample scenario identity belongs to this adapter, never to the customer flow. */
export function createSampleReturnGateway(
  scenarioId: ReturnPreviewScenarioId,
  request: FetchRequest = fetch,
): CustomerReturnFlowGateway {
  return {
    async lookup(reference, signal) {
      const input = returnPreviewLookupInputSchema.parse({
        scenarioId,
        orderReference: reference,
      });
      const result = await post(
        request,
        "/order",
        input,
        signal,
        returnPreviewOrderSchema,
      );
      if (result.scenarioId !== scenarioId)
        throw new Error(
          "The sample order response could not be verified. Please try again.",
        );
      const { mode: _mode, scenarioId: _scenario, ...fields } = result;
      const order = customerReturnFlowOrderSchema.parse({
        ...fields,
        sourceRevision: null,
      });
      assertReturnFlowOrderMatches(order, reference);
      return order;
    },
    async review(rawInput, signal) {
      const neutral = customerReturnFlowReviewInputSchema.parse(rawInput);
      if (neutral.sourceRevision !== null)
        throw new Error("The order source changed. Find the order again.");
      const { sourceRevision: _revision, ...fields } = neutral;
      const input = returnPreviewReviewInputSchema.parse({
        ...fields,
        scenarioId,
      });
      const result = await post(
        request,
        "/review",
        input,
        signal,
        returnPreviewReviewSchema,
      );
      const { mode: _mode, ...review } = result;
      return customerReturnFlowReviewSchema.parse({
        ...review,
        sourceRevision: null,
      });
    },
  };
}

/** The selected shop is fixed for this adapter's lifetime and sent on every read. */
export function createLiveReturnGateway(
  channelId: number,
  request: FetchRequest = fetch,
): CustomerReturnFlowGateway {
  return {
    async lookup(reference, signal) {
      const input = customerReturnLiveLookupInputSchema.parse({
        channelId,
        orderReference: reference,
      });
      const result = await post(
        request,
        "/live/order",
        input,
        signal,
        customerReturnLiveOrderSchema,
      );
      const { mode: _mode, ...fields } = result;
      const order = customerReturnFlowOrderSchema.parse(fields);
      assertReturnFlowOrderMatches(order, reference);
      return order;
    },
    async review(rawInput, signal) {
      const input = customerReturnLiveReviewInputSchema.parse({
        ...rawInput,
        channelId,
      });
      const result = await post(
        request,
        "/live/review",
        input,
        signal,
        customerReturnLiveReviewSchema,
      );
      const { mode: _mode, ...fields } = result;
      return customerReturnFlowReviewSchema.parse(fields);
    },
  };
}

async function post<T extends z.ZodTypeAny>(
  request: FetchRequest,
  path: string,
  body: unknown,
  signal: AbortSignal,
  schema: T,
): Promise<z.output<T>> {
  const response = await request(`${CUSTOMER_RETURN_PREVIEW_API_PATH}${path}`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readPreviewResponse(response, schema);
}
