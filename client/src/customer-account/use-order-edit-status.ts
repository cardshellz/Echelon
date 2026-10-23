import { useEffect, useRef, useState } from "react";
import type {
  OrderEditOperation,
  OrderEditStatus,
} from "@shared/order-edits/order-edit.contract";

export const ORDER_EDIT_STATUS_POLL_MS = 5_000;
const MINIMUM_FOCUS_READ_MS = 1_000;
const progressing = new Set<OrderEditStatus>([
  "committing",
  "awaiting_payment",
  "refunding",
  "synchronizing",
  "recovering",
]);
export const orderEditWatchesStatus = (status: OrderEditStatus): boolean =>
  progressing.has(status);

interface StatusOptions<
  T extends { operationId: string; status: string } = OrderEditOperation,
> {
  operationId: string | null;
  watching: boolean;
  read(id: string, signal: AbortSignal): Promise<T>;
  received(operation: T): void;
  busy(): boolean;
  revision(): number;
  clock?: () => number;
}
/** Display-only observer. Financial progress belongs to the canonical worker;
 * neither timers nor browser-return events may submit reconciliation commands.
 */
interface StatusObservationOptions<
  T extends { operationId: string; status: string },
> extends Omit<StatusOptions<T>, "operationId"> {
  identity: string | null;
  identityType: "operation" | "cancellation_request";
  identify(result: T): string;
  isProgressing(result: T): boolean;
  readImmediately?: boolean;
}

export function useCustomerStatusObservation<
  T extends { operationId: string; status: string },
>(
  options: StatusObservationOptions<T>,
): {
  error: string | null;
  errorCode: string | null;
  reading: boolean;
  retry(): void;
} {
  const latest = useRef(options);
  latest.current = options;
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    setErrorCode(null);
    setReading(false);
    if (!options.identity || !options.watching) return;
    const id = options.identity;
    let stopped = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | null = null;
    let lastRead = Number.NEGATIVE_INFINITY;
    const visible = () => document.visibilityState === "visible";
    const cancelTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delay: number) => {
      cancelTimer();
      if (!stopped && !failed && visible())
        timer = setTimeout(() => {
          void refresh();
        }, delay);
    };
    async function refresh(): Promise<void> {
      cancelTimer();
      if (stopped || request || !visible()) return;
      if (latest.current.busy()) {
        schedule(ORDER_EDIT_STATUS_POLL_MS);
        return;
      }
      const now = (latest.current.clock ?? Date.now)();
      const remaining = MINIMUM_FOCUS_READ_MS - (now - lastRead);
      if (remaining > 0) {
        schedule(remaining);
        return;
      }
      const controller = new AbortController();
      const revision = latest.current.revision();
      request = controller;
      lastRead = now;
      setReading(true);
      try {
        const result = await latest.current.read(id, controller.signal);
        if (
          stopped ||
          controller.signal.aborted ||
          latest.current.identity !== id ||
          latest.current.busy() ||
          latest.current.revision() !== revision
        )
          return;
        if (latest.current.identify(result) !== id)
          throw new Error("The order status did not match the saved request.");
        failed = false;
        setError(null);
        setErrorCode(null);
        latest.current.received(result);
        if (!latest.current.isProgressing(result)) stopped = true;
      } catch (cause) {
        if (!stopped && !controller.signal.aborted) {
          failed = true;
          const code =
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            typeof cause.code === "string"
              ? cause.code
              : "ORDER_STATUS_UNAVAILABLE";
          setError("We couldn’t check your order’s status. Please try again.");
          setErrorCode(code);
          console.warn(
            JSON.stringify({
              event: "customer_order_status_read_failed",
              identityType: options.identityType,
              identity: id,
              code,
            }),
          );
        }
      } finally {
        request = null;
        if (!stopped) setReading(false);
        schedule(ORDER_EDIT_STATUS_POLL_MS);
      }
    }
    const wake = () => {
      if (!visible()) {
        cancelTimer();
        request?.abort();
        return;
      }
      failed = false;
      void refresh();
    };
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    // readImmediately only controls the first read of this observation. The
    // recovered response must not restart it when the caller learns its ID.
    schedule(
      attempt > 0 || options.readImmediately ? 0 : ORDER_EDIT_STATUS_POLL_MS,
    );
    return () => {
      stopped = true;
      cancelTimer();
      request?.abort();
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [options.identity, options.watching, attempt]);
  return {
    error,
    errorCode,
    reading,
    retry: () => setAttempt((value) => value + 1),
  };
}

export function useCustomerOperationStatus<
  T extends { operationId: string; status: string },
>(options: StatusOptions<T> & { isProgressing(operation: T): boolean }) {
  return useCustomerStatusObservation({
    ...options,
    identity: options.operationId,
    identityType: "operation",
    identify: (result) => result.operationId,
  });
}

export function useOrderEditStatus(options: StatusOptions) {
  return useCustomerOperationStatus({
    ...options,
    isProgressing: (operation) => orderEditWatchesStatus(operation.status),
  });
}
