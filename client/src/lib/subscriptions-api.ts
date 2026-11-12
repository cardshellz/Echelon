export const SUBSCRIPTIONS_API = "/api/subscriptions";
export const MEMBERSHIP_ADMIN_API = "/api/membership";

export class SubscriptionRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly uncertain: boolean;
  readonly skipped: boolean;

  constructor(
    message: string,
    options: {
      status?: number | null;
      code?: string | null;
      uncertain?: boolean;
      skipped?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "SubscriptionRequestError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.uncertain = options.uncertain ?? false;
    this.skipped = options.skipped ?? false;
  }
}

export interface CancelSubscriptionCommandResponse {
  success: true;
  providerStatus?: "not_linked" | "confirmed" | "provider_failed";
  warning?: string;
}

export interface RetryBillingCommandResponse {
  success: true;
  status?: "pending";
  idempotencyKey?: string;
  attemptId?: string | null;
}

export interface ManualBillingPassResponse {
  success: true;
  skipped?: boolean;
  reason?: "billing_lock_held";
  processed: number;
  succeeded: number;
  failed: number;
  uncertain?: number;
  errors: string[];
}

export interface SubscriptionFeedbackToast {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function subscriptionJsonRequest<T>(
  url: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    signal?: AbortSignal;
  } = {},
  request: typeof fetch = fetch,
): Promise<T> {
  const method = options.method ?? "GET";
  const isMutation = method !== "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await request(url, {
      method,
      headers,
      credentials: "include",
      signal: options.signal,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    if (!isMutation && err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    throw new SubscriptionRequestError(
      isMutation
        ? "Network failure while submitting subscription command. Reload details before retrying."
        : "Unable to reach subscription service.",
      {
        status: null,
        code: "SUBSCRIPTION_NETWORK_ERROR",
        uncertain: isMutation,
      },
    );
  }

  let parsedBody: unknown = null;
  let validJson = false;
  try {
    parsedBody = await response.json();
    validJson = true;
  } catch {
    validJson = false;
  }

  const record = isObjectRecord(parsedBody) ? parsedBody : null;
  const serverMessage =
    typeof record?.error === "string" && record.error.trim().length > 0
      ? record.error
      : typeof record?.message === "string" && record.message.trim().length > 0
        ? record.message
        : null;
  const serverCode = typeof record?.code === "string" ? record.code : null;
  const serverUncertain = record?.uncertain === true;
  const serverSkipped = record?.skipped === true || record?.reason === "billing_lock_held";

  if (!response.ok) {
    const defaultError =
      response.status === 401 || response.status === 403
        ? "You do not have permission to manage subscriptions."
        : `Subscription request failed (HTTP ${response.status}).`;

    throw new SubscriptionRequestError(serverMessage ?? defaultError, {
      status: response.status,
      code:
        serverCode ??
        (response.status === 401 || response.status === 403
          ? "PERMISSION_DENIED"
          : "HTTP_ERROR"),
      uncertain:
        serverUncertain ||
        (isMutation &&
          response.status >= 500 &&
          serverCode === null &&
          !validJson),
      skipped: serverSkipped,
    });
  }

  if (!validJson || parsedBody === null) {
    throw new SubscriptionRequestError(
      isMutation
        ? "Subscription response could not be verified. Check latest subscription status before retrying."
        : "Received an invalid subscription response.",
      {
        status: response.status,
        code: "INVALID_RESPONSE",
        uncertain: isMutation,
      },
    );
  }

  if (record && (record.success === false || (typeof record.error === "string" && record.error.length > 0))) {
    throw new SubscriptionRequestError(
      serverMessage ?? "Subscription command failed.",
      {
        status: response.status,
        code: serverCode ?? "COMMAND_FAILED",
        uncertain: serverUncertain,
        skipped: serverSkipped,
      },
    );
  }

  return parsedBody as T;
}

export async function cancelSubscriptionCommand(
  subscriptionId: number,
  reason: string,
  request: typeof fetch = fetch,
): Promise<CancelSubscriptionCommandResponse> {
  return subscriptionJsonRequest<CancelSubscriptionCommandResponse>(
    `${SUBSCRIPTIONS_API}/${subscriptionId}/cancel`,
    {
      method: "POST",
      body: { reason: reason.trim() || "Admin cancelled" },
    },
    request,
  );
}

export async function retrySubscriptionBillingCommand(
  subscriptionId: number,
  request: typeof fetch = fetch,
): Promise<RetryBillingCommandResponse> {
  return subscriptionJsonRequest<RetryBillingCommandResponse>(
    `${SUBSCRIPTIONS_API}/${subscriptionId}/retry-billing`,
    { method: "POST" },
    request,
  );
}

export async function pauseSubscriptionCommand(
  subscriptionId: number,
  paused: boolean,
  request: typeof fetch = fetch,
): Promise<{ success: true; paused: boolean }> {
  return subscriptionJsonRequest<{ success: true; paused: boolean }>(
    `${SUBSCRIPTIONS_API}/${subscriptionId}/pause`,
    {
      method: "POST",
      body: { paused },
    },
    request,
  );
}

export async function changeSubscriptionPlanCommand(
  subscriptionId: number,
  planId: number,
  request: typeof fetch = fetch,
): Promise<{ success: true }> {
  return subscriptionJsonRequest<{ success: true }>(
    `${SUBSCRIPTIONS_API}/${subscriptionId}/change-plan`,
    {
      method: "POST",
      body: { plan_id: planId },
    },
    request,
  );
}

export async function setupSellingPlansCommand(
  request: typeof fetch = fetch,
): Promise<{ success?: boolean; sellingPlanGroupGid?: string }> {
  return subscriptionJsonRequest<{ success?: boolean; sellingPlanGroupGid?: string }>(
    `${MEMBERSHIP_ADMIN_API}/setup-selling-plans`,
    { method: "POST" },
    request,
  );
}

export async function registerSubscriptionWebhooksCommand(
  request: typeof fetch = fetch,
): Promise<{ disabled?: boolean; registered?: string[]; message?: string }> {
  return subscriptionJsonRequest<{ disabled?: boolean; registered?: string[]; message?: string }>(
    `${MEMBERSHIP_ADMIN_API}/register-webhooks`,
    { method: "POST" },
    request,
  );
}

export async function runManualBillingPassCommand(
  request: typeof fetch = fetch,
): Promise<ManualBillingPassResponse> {
  return subscriptionJsonRequest<ManualBillingPassResponse>(
    `${SUBSCRIPTIONS_API}/billing/run`,
    { method: "POST" },
    request,
  );
}

export function presentSubscriptionCancelFeedback(
  result: CancelSubscriptionCommandResponse,
): SubscriptionFeedbackToast {
  if (result.providerStatus === "provider_failed") {
    return {
      title: "Cancelled locally — Shopify confirmation needed",
      description:
        result.warning ??
        "Local membership was cancelled, but remote Shopify contract cancellation could not be confirmed.",
      variant: "destructive",
    };
  }
  return {
    title: "Subscription cancelled",
    description:
      result.providerStatus === "confirmed"
        ? "Local membership and Shopify contract cancelled."
        : undefined,
  };
}

export function presentSubscriptionCommandError(
  err: unknown,
  fallbackTitle = "Command failed",
): SubscriptionFeedbackToast {
  if (err instanceof SubscriptionRequestError) {
    if (err.skipped) {
      return {
        title: "Billing run already in progress",
        description: err.message,
      };
    }
    if (err.uncertain) {
      return {
        title: "Outcome uncertain — check status before retrying",
        description: err.message,
        variant: "destructive",
      };
    }
    return {
      title: fallbackTitle,
      description: err.message,
      variant: "destructive",
    };
  }
  return {
    title: fallbackTitle,
    description: err instanceof Error ? err.message : "Unexpected subscription error.",
    variant: "destructive",
  };
}

export function presentManualBillingFeedback(
  result: ManualBillingPassResponse,
): SubscriptionFeedbackToast {
  const uncertainCount = result.uncertain ?? 0;
  if (uncertainCount > 0) {
    return {
      title: "Billing run finished with uncertain outcomes",
      description: `Processed: ${result.processed}, Dispatched: ${result.succeeded}, Rejected: ${result.failed}, Uncertain (locked): ${uncertainCount}`,
      variant: "destructive",
    };
  }
  return {
    title: "Billing run complete",
    description: `Processed: ${result.processed}, Dispatched: ${result.succeeded}, Failed: ${result.failed}`,
  };
}
