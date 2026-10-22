import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CustomerOrderCancellationInput,
  CustomerOrderCancellationReview,
  CustomerOrderCancellation as Cancellation,
} from "@shared/customer-account/order-cancellation";
import {
  CustomerAccountRequestError,
  type CustomerAccountTransport,
} from "./customer-account.transport";
import { formatOrderEditMoney } from "@/lib/order-edits";
import {
  loadCancellationRequest,
  saveCancellationRequest,
  clearCancellationRequest,
  type CancellationRequestScope,
} from "./order-cancellation-request";
import { useCustomerOperationStatus } from "./use-order-edit-status";

const progressing = (value: Cancellation): boolean =>
  !["completed", "not_submitted", "review_required"].includes(value.status);
const points = (value: string): string => value.replace(/\.00$/, "");
export function CustomerOrderCancellation({
  api,
  scope,
  existingRequestKey,
  onBack,
  onDone,
}: {
  api: CustomerAccountTransport;
  scope: CancellationRequestScope;
  existingRequestKey: string | null;
  onBack(): void;
  onDone(): void;
}) {
  const [review, setReview] = useState<CustomerOrderCancellationReview | null>(
    null,
  );
  const [operation, setOperation] = useState<Cancellation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const approved = useRef<CustomerOrderCancellationInput | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const keepOrder = useRef<HTMLButtonElement>(null);
  const check = useCallback(
    (result: Cancellation, requestKey: string): Cancellation => {
      if (
        result.omsOrderId !== scope.omsOrderId ||
        result.requestKey !== requestKey
      )
        throw new Error("The cancellation status did not match this order.");
      return result;
    },
    [scope.omsOrderId],
  );
  const received = useCallback(
    (result: Cancellation) => {
      setOperation(result);
      setUncertain(false);
      setError(null);
      if (["completed", "not_submitted"].includes(result.status)) {
        try {
          clearCancellationRequest(
            window.sessionStorage,
            scope,
            result.requestKey,
          );
        } catch {
          console.warn(
            JSON.stringify({
              event: "customer_cancellation_storage_cleanup_failed",
              operationId: result.operationId,
            }),
          );
        }
      }
    },
    [scope.customerId, scope.connectionId, scope.omsOrderId],
  );
  const observation = useCustomerOperationStatus({
    operationId: operation?.operationId ?? null,
    watching: operation !== null && progressing(operation),
    read: async (_id, signal) =>
      check(
        await api.cancellation.status(
          scope.connectionId,
          scope.omsOrderId,
          operation!.requestKey,
          signal,
        ),
        operation!.requestKey,
      ),
    received,
    busy: () => busy.current,
    revision: () => revision.current,
    isProgressing: progressing,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current += 1;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const saved = loadCancellationRequest(window.sessionStorage, scope);
        approved.current = saved;
        const requestKey = existingRequestKey ?? saved?.requestKey;
        if (requestKey) {
          const result = check(
            await api.cancellation.status(
              scope.connectionId,
              scope.omsOrderId,
              requestKey,
              controller.signal,
            ),
            requestKey,
          );
          if (!controller.signal.aborted) received(result);
        } else {
          const result = await api.cancellation.review(
            scope.connectionId,
            scope.omsOrderId,
            controller.signal,
          );
          if (
            result.connectionId !== scope.connectionId ||
            result.omsOrderId !== scope.omsOrderId
          )
            throw new Error(
              "The cancellation review did not match this order.",
            );
          if (!controller.signal.aborted) {
            setReview(result);
            setOperation(null);
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(
            "We couldn’t load the cancellation details. Please try again.",
          );
          setUncertain(Boolean(approved.current || existingRequestKey));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [
    api,
    scope.customerId,
    scope.connectionId,
    scope.omsOrderId,
    existingRequestKey,
    attempt,
    check,
    received,
  ]);
  useEffect(() => {
    if (review && !loading && !operation) keepOrder.current?.focus();
  }, [review, loading, operation]);

  async function submit(): Promise<void> {
    if (busy.current || (!review?.eligibility.allowed && !approved.current))
      return;
    busy.current = true;
    revision.current += 1;
    setLoading(true);
    setError(null);
    try {
      const input = approved.current ?? {
        connectionId: scope.connectionId,
        omsOrderId: scope.omsOrderId,
        expectedRevision: review!.revision,
        requestKey: window.crypto.randomUUID(),
      };
      saveCancellationRequest(window.sessionStorage, scope, input);
      approved.current = input;
      const result = check(
        await api.cancellation.submit(input),
        input.requestKey,
      );
      if (mounted.current) received(result);
    } catch (cause) {
      if (mounted.current) {
        // This specific service result is emitted before operation creation.
        // Refreshing the review requires fresh approval; unknown results retain
        // the original key and can never silently start a new cancellation.
        if (
          cause instanceof CustomerAccountRequestError &&
          cause.code === "ORDER_CANCELLATION_REVIEW_CHANGED" &&
          approved.current
        ) {
          try {
            clearCancellationRequest(
              window.sessionStorage,
              scope,
              approved.current.requestKey,
            );
            approved.current = null;
            setReview(null);
            setUncertain(false);
            setError(
              "The order or rewards changed. Review the cancellation again before confirming.",
            );
          } catch {
            setUncertain(true);
            setError(
              "We couldn’t refresh your saved cancellation. Contact us for help.",
            );
          }
        } else {
          setError(
            approved.current
              ? "We couldn’t confirm the cancellation response. Check its status before trying again."
              : "We couldn’t save this request. No cancellation was submitted from this screen.",
          );
          setUncertain(Boolean(approved.current));
        }
      }
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  const retryRead = () => {
    if (operation) observation.retry();
    else setAttempt((value) => value + 1);
  };
  if (!operation)
    return (
      <section aria-labelledby="csz-cancellation-review-title">
        <h3 id="csz-cancellation-review-title">
          {uncertain ? "Checking your cancellation" : "Cancel this order?"}
        </h3>
        {loading && (
          <p role="status">
            {busy.current
              ? "Sending your cancellation…"
              : "Loading cancellation details…"}
          </p>
        )}
        {error && (
          <div className="csz-panel-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="csz-action"
              disabled={loading}
              onClick={() => {
                if (uncertain && approved.current) void submit();
                else retryRead();
              }}
            >
              Try again
            </button>
          </div>
        )}
        {!uncertain && review && !loading && (
          <>
            <p>Review what will be returned before confirming.</p>
            <dl className="csz-panel-amounts">
              <div>
                <dt>Refund to original payment method</dt>
                <dd>
                  {formatOrderEditMoney(review.refundCents, review.currency)}
                </dd>
              </div>
              {review.rewards.returnedPoints !== "0.00" && (
                <div>
                  <dt>Rewards returned to your account</dt>
                  <dd>{points(review.rewards.returnedPoints)} points</dd>
                </div>
              )}
              {review.rewards.deductedEarnedPoints !== "0.00" && (
                <div>
                  <dt>Points earned on this order removed</dt>
                  <dd>{points(review.rewards.deductedEarnedPoints)} points</dd>
                </div>
              )}
            </dl>
            {review.rewards.returnedPoints !== "0.00" && (
              <p className="csz-panel-explanation">
                Returned rewards keep their original expiry dates.
              </p>
            )}
            {!review.eligibility.allowed && (
              <p role="status">
                {review.eligibility.reasons[0] ??
                  "Contact us to cancel this order."}
              </p>
            )}
            <div className="csz-panel-confirmation">
              <button
                type="button"
                className="csz-action"
                ref={keepOrder}
                onClick={onBack}
              >
                Keep order
              </button>
              {review.eligibility.allowed && (
                <button
                  type="button"
                  className="csz-action csz-cancel-confirm"
                  onClick={() => void submit()}
                >
                  Confirm cancellation
                </button>
              )}
            </div>
          </>
        )}
      </section>
    );
  const done = operation.status === "completed",
    notSubmitted = operation.status === "not_submitted";
  return (
    <section aria-labelledby="csz-cancellation-status-title">
      <h3 id="csz-cancellation-status-title">
        {done
          ? "Order cancelled"
          : notSubmitted
            ? "Cancellation not submitted"
            : operation.status === "review_required"
              ? "We need to check your cancellation"
              : "Cancellation in progress"}
      </h3>
      <p role="status">
        {done
          ? "Your order is cancelled. The refund has been processed; your payment provider controls when it appears in your account."
          : notSubmitted
            ? "This cancellation request was not submitted. Return to your order options to see the current status."
            : operation.status === "review_required"
              ? "Your request is saved. Contact us with the cancellation reference below so we can verify it."
              : "We’re confirming your cancellation and refund. This will update automatically."}
      </p>
      {!notSubmitted && (
        <dl className="csz-panel-amounts">
          <div>
            <dt>
              {operation.refundStatus === "completed"
                ? "Refund processed"
                : "Refund pending"}
            </dt>
            <dd>
              {formatOrderEditMoney(operation.refundCents, operation.currency)}
            </dd>
          </div>
          {operation.rewards.returnedPoints !== "0.00" && (
            <div>
              <dt>
                {operation.rewards.settled
                  ? "Rewards returned"
                  : "Rewards to be returned"}
              </dt>
              <dd>{points(operation.rewards.returnedPoints)} points</dd>
            </div>
          )}
        </dl>
      )}
      {(observation.error || operation.error) && (
        <div className="csz-panel-error" role="alert">
          <p>{observation.error ?? operation.error?.message}</p>
          {(observation.error || operation.error?.retryable) && (
            <button
              type="button"
              className="csz-action"
              disabled={observation.reading}
              onClick={retryRead}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {(done || notSubmitted) && (
        <button type="button" className="csz-action" onClick={onDone}>
          Done
        </button>
      )}
      <p className="csz-panel-reference">
        Cancellation reference: {operation.operationId}
      </p>
    </section>
  );
}
