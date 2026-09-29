import { z } from "zod";
import {
  CUSTOMER_RETURNS_API,
  RETURN_CUSTOMER_SESSION_HEADER,
  customerReturnSessionStateSchema,
  customerReturnCustomerOrderSchema,
  customerReturnCustomerOrderPageSchema,
  customerReturnCustomerProfileSchema,
} from "@shared/returns/customer-return-access.contract";
import {
  customerReturnCustomerSubmitInputSchema,
  customerReturnCustomerLabelStatusSchema,
  customerReturnCustomerHistorySchema,
  type CustomerReturnCustomerSubmitInput,
  type CustomerReturnCustomerLabelStatus,
} from "@shared/returns/customer-return-customer.contract";
import {
  customerReturnFlowReviewInputSchema,
  customerReturnFlowReviewSchema,
} from "@shared/returns/customer-return-flow.contract";
import {
  PreviewAccessError,
  ReturnSourceChangedError,
} from "./customer-return-preview";

type FetchRequest = typeof fetch;
const id = z.number().int().positive().safe();
const key = z.string().uuid();
const sessionKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const reviewInput = customerReturnFlowReviewInputSchema
  .omit({ orderReference: true })
  .strict();

export class CustomerReturnRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CustomerReturnRequestError";
  }
}

async function responseBody<T extends z.ZodTypeAny>(
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  if (response.status === 401 || response.status === 403)
    throw new PreviewAccessError(
      "Sign in again to continue with your returns.",
    );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ code: z.string().max(100) }) })
      .safeParse(body);
    const code = parsed.success
      ? parsed.data.error.code
      : "CUSTOMER_RETURN_REQUEST_FAILED";
    if (
      code === "RETURN_LIVE_REVIEW_CHANGED" ||
      code === "RETURN_LABEL_SETTINGS_CHANGED"
    ) {
      throw new ReturnSourceChangedError(
        "This order changed. Choose it again to review the available items.",
      );
    }
    throw new CustomerReturnRequestError(
      code,
      code === "RETURN_LABEL_SUBMISSION_REJECTED"
        ? "This request was not accepted. Choose the order again to review its availability."
        : code === "RETURN_LABEL_SUBMISSION_PROCESSING"
          ? "Your request is still being checked. Check its status again shortly."
          : code === "RETURN_LABEL_SUBMISSION_NOT_FOUND"
            ? "We have not confirmed your request yet. Retry this saved request to continue."
            : "We could not confirm the result. Your saved request will be kept. Please try again.",
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new CustomerReturnRequestError(
      "CUSTOMER_RETURN_RESPONSE_INVALID",
      "The response could not be verified. Please check its status again.",
    );
  return parsed.data;
}

export function assertCustomerReturnStatus(
  raw: unknown,
  authorizationId?: number,
  parcelCount?: number,
): CustomerReturnCustomerLabelStatus {
  const status = customerReturnCustomerLabelStatusSchema.parse(raw);
  if (
    (authorizationId !== undefined &&
      status.authorizationId !== authorizationId) ||
    (parcelCount !== undefined && status.parcels.length !== parcelCount) ||
    new Set(status.parcels.map((parcel) => parcel.parcelId)).size !==
      status.parcels.length ||
    new Set(status.parcels.map((parcel) => parcel.number)).size !==
      status.parcels.length ||
    status.parcels.some(
      (parcel) =>
        parcel.number > status.parcels.length ||
        (parcel.downloadPath !== null &&
          (parcel.status !== "ready" ||
            parcel.downloadPath !==
              `${CUSTOMER_RETURNS_API}/returns/${status.authorizationId}/parcels/${parcel.parcelId}/download`)),
    )
  ) {
    throw new CustomerReturnRequestError(
      "CUSTOMER_RETURN_RESPONSE_INVALID",
      "The labels could not be matched to this return. Check its status again.",
    );
  }
  return status;
}

export function createCustomerReturnTransport(
  request: FetchRequest = fetch,
  expectedSessionKey?: string,
) {
  if (expectedSessionKey !== undefined) sessionKey.parse(expectedSessionKey);
  async function call<T extends z.ZodTypeAny>(
    path: string,
    signal: AbortSignal,
    schema: T,
    body?: unknown,
  ): Promise<z.output<T>> {
    const headers: Record<string, string> = {};
    if (path !== "/session")
      headers[RETURN_CUSTOMER_SESSION_HEADER] =
        sessionKey.parse(expectedSessionKey);
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["X-Return-Command"] = "1";
    }
    return responseBody(
      await request(`${CUSTOMER_RETURNS_API}${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        signal,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      schema,
    );
  }
  return {
    session: (signal: AbortSignal) =>
      call("/session", signal, customerReturnSessionStateSchema),
    profile: (signal: AbortSignal) =>
      call("/profile", signal, customerReturnCustomerProfileSchema),
    logout: (signal: AbortSignal) =>
      call("/logout", signal, z.object({ ok: z.literal(true) }).strict(), {}),
    async orders(before: number | null, signal: AbortSignal) {
      const result = await call(
        `/orders${before === null ? "" : `?before=${id.parse(before)}`}`,
        signal,
        customerReturnCustomerOrderPageSchema,
      );
      if (
        new Set(result.orders.map((order) => order.omsOrderId)).size !==
          result.orders.length ||
        (before !== null &&
          result.orders.some((order) => order.omsOrderId >= before)) ||
        (result.nextBeforeOmsOrderId !== null &&
          before !== null &&
          result.nextBeforeOmsOrderId >= before)
      )
        throw new Error("The order page changed. Refresh your orders.");
      return result;
    },
    async order(orderId: number, signal: AbortSignal) {
      const result = await call(
        `/orders/${id.parse(orderId)}`,
        signal,
        customerReturnCustomerOrderSchema,
      );
      if (result.omsOrderId !== orderId)
        throw new Error("The order could not be verified. Choose it again.");
      return result;
    },
    review: (orderId: number, raw: unknown, signal: AbortSignal) =>
      call(
        `/orders/${id.parse(orderId)}/review`,
        signal,
        customerReturnFlowReviewSchema,
        reviewInput.parse(raw),
      ),
    async submit(orderId: number, raw: unknown, signal: AbortSignal) {
      const input = customerReturnCustomerSubmitInputSchema.parse(raw);
      return assertCustomerReturnStatus(
        await call(
          `/orders/${id.parse(orderId)}/returns`,
          signal,
          customerReturnCustomerLabelStatusSchema,
          input,
        ),
        undefined,
        input.parcels.length,
      );
    },
    async byCommand(commandKey: string, signal: AbortSignal) {
      return assertCustomerReturnStatus(
        await call(
          `/commands/${key.parse(commandKey)}`,
          signal,
          customerReturnCustomerLabelStatusSchema,
        ),
      );
    },
    async resume(commandKey: string, signal: AbortSignal) {
      return assertCustomerReturnStatus(
        await call(
          `/commands/${key.parse(commandKey)}/resume`,
          signal,
          customerReturnCustomerLabelStatusSchema,
          {},
        ),
      );
    },
    async status(authorizationId: number, signal: AbortSignal) {
      return assertCustomerReturnStatus(
        await call(
          `/returns/${id.parse(authorizationId)}`,
          signal,
          customerReturnCustomerLabelStatusSchema,
        ),
        authorizationId,
      );
    },
    async progress(authorizationId: number, signal: AbortSignal) {
      return assertCustomerReturnStatus(
        await call(
          `/returns/${id.parse(authorizationId)}/progress`,
          signal,
          customerReturnCustomerLabelStatusSchema,
          {},
        ),
        authorizationId,
      );
    },
    history: (before: number | null, signal: AbortSignal) =>
      call(
        `/returns${before === null ? "" : `?before=${id.parse(before)}`}`,
        signal,
        customerReturnCustomerHistorySchema,
      ),
  };
}
export type CustomerReturnTransport = ReturnType<
  typeof createCustomerReturnTransport
>;

export const customerReturnSavedRequestSchema = z
  .object({
    version: z.literal(1),
    sessionKey,
    omsOrderId: id,
    authorizationId: id.nullable(),
    input: customerReturnCustomerSubmitInputSchema,
  })
  .strict();
export type CustomerReturnSavedRequest = z.infer<
  typeof customerReturnSavedRequestSchema
>;
export interface CustomerReturnCommandState {
  record: CustomerReturnSavedRequest | null;
  status: CustomerReturnCustomerLabelStatus | null;
  busy: boolean;
  error: string | null;
  storageBlocked: boolean;
  rejected: boolean;
}
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Exact intent is persisted before any write so a lost initial response can be
 * retried with the original key even after a reload. Storage is session-scoped. */
export class CustomerReturnCommandSession {
  private state: CustomerReturnCommandState = {
    record: null,
    status: null,
    busy: false,
    error: null,
    storageBlocked: false,
    rejected: false,
  };
  private listeners = new Set<() => void>();
  private active = true;
  private controller: AbortController | null = null;
  private readonly storageKey: string;
  constructor(
    private readonly identity: string,
    private readonly storage: RecoveryStorage | null,
    private readonly api: CustomerReturnTransport,
    private readonly denied: (message: string) => void,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {
    this.storageKey = `customer-return-request:${sessionKey.parse(identity)}`;
    try {
      if (!storage) throw new Error("Unavailable");
      const raw = storage.getItem(this.storageKey);
      if (raw !== null) {
        if (raw.length > 2_000_000) throw new Error("Invalid saved request");
        const record = customerReturnSavedRequestSchema.parse(JSON.parse(raw));
        if (record.sessionKey !== identity) throw new Error("Wrong session");
        this.state.record = record;
      }
    } catch {
      this.state.storageBlocked = true;
      this.state.error =
        "This browser could not restore your return request. Contact support before starting another return.";
    }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<CustomerReturnCommandState>) {
    if (this.active) {
      this.state = { ...this.state, ...patch };
      this.listeners.forEach((listener) => listener());
    }
  }
  private save(record: CustomerReturnSavedRequest) {
    if (!this.storage) throw new Error("Recovery storage unavailable");
    this.storage.setItem(
      this.storageKey,
      JSON.stringify(customerReturnSavedRequestSchema.parse(record)),
    );
  }
  private accept(raw: CustomerReturnCustomerLabelStatus) {
    const record = this.state.record;
    if (!record) throw new Error("The saved return request is missing.");
    const status = assertCustomerReturnStatus(
      raw,
      record.authorizationId ?? undefined,
      record.input.parcels.length,
    );
    if (
      this.state.status &&
      (this.state.status.authorizationNumber !== status.authorizationNumber ||
        this.state.status.parcels.some(
          (parcel) =>
            !status.parcels.some(
              (next) =>
                next.parcelId === parcel.parcelId &&
                next.number === parcel.number,
            ),
        ))
    ) {
      throw new Error(
        "The saved box identities changed. Contact support before continuing.",
      );
    }
    const saved = { ...record, authorizationId: status.authorizationId };
    let error: string | null = null;
    try {
      this.save(saved);
    } catch {
      error =
        "Keep this page open. The latest status could not be saved; your original recovery key is retained.";
    }
    this.update({ record: saved, status, error });
  }
  private async run(
    work: (signal: AbortSignal) => Promise<CustomerReturnCustomerLabelStatus>,
  ) {
    if (!this.active || this.state.busy) return;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ busy: true, error: null });
    try {
      const status = await work(controller.signal);
      if (!controller.signal.aborted && this.active) this.accept(status);
    } catch (cause) {
      if (!controller.signal.aborted && this.active) {
        if (cause instanceof PreviewAccessError) this.denied(cause.message);
        else
          this.update({
            error:
              cause instanceof Error
                ? cause.message
                : "The outcome is unknown. Check this saved request again.",
            rejected:
              this.state.rejected ||
              (cause instanceof CustomerReturnRequestError &&
                cause.code === "RETURN_LABEL_SUBMISSION_REJECTED" &&
                this.state.record?.authorizationId === null),
          });
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      if (!controller.signal.aborted && this.active)
        this.update({ busy: false });
    }
  }
  async begin(
    orderId: number,
    raw: Omit<CustomerReturnCustomerSubmitInput, "idempotencyKey">,
  ) {
    if (this.state.record || this.state.busy || this.state.storageBlocked)
      return;
    const record = customerReturnSavedRequestSchema.parse({
      version: 1,
      sessionKey: this.identity,
      omsOrderId: orderId,
      authorizationId: null,
      input: { ...raw, idempotencyKey: this.newKey() },
    });
    try {
      this.save(record);
    } catch {
      this.update({
        storageBlocked: true,
        error: "Enable browser session storage before creating return labels.",
      });
      return;
    }
    this.update({ record, rejected: false });
    await this.run(async (signal) => {
      let status = await this.api.submit(
        record.omsOrderId,
        record.input,
        signal,
      );
      const attempted = new Set<number>();
      // The explicit Get labels action authorizes each reviewed box. Stop at
      // uncertainty; reloads/checks never enter this purchase loop.
      while (
        !signal.aborted &&
        this.active &&
        status.canProgress &&
        !status.parcels.some(
          (parcel) =>
            parcel.status === "processing" || parcel.status === "needs_review",
        )
      ) {
        this.accept(status);
        const next = [...status.parcels]
          .sort((left, right) => left.number - right.number)
          .find((parcel) => parcel.status === "pending");
        if (!next || attempted.has(next.parcelId)) break;
        attempted.add(next.parcelId);
        status = await this.api.progress(status.authorizationId, signal);
      }
      return status;
    });
  }
  async check() {
    const record = this.state.record;
    if (record)
      await this.run((signal) =>
        record.authorizationId === null
          ? this.api.byCommand(record.input.idempotencyKey, signal)
          : this.api.status(record.authorizationId, signal),
      );
  }
  async retry() {
    const record = this.state.record;
    if (!record || record.authorizationId !== null || this.state.rejected)
      return;
    await this.run(async (signal) => {
      try {
        return await this.api.resume(record.input.idempotencyKey, signal);
      } catch (cause) {
        if (
          cause instanceof CustomerReturnRequestError &&
          (cause.status === 404 ||
            cause.code === "RETURN_LABEL_SUBMISSION_NOT_FOUND")
        )
          return this.api.submit(record.omsOrderId, record.input, signal);
        throw cause;
      }
    });
  }
  async progress() {
    const record = this.state.record;
    if (record?.authorizationId && this.state.status?.canProgress)
      await this.run((signal) =>
        this.api.progress(record.authorizationId!, signal),
      );
  }
  finish() {
    if (
      this.state.busy ||
      (!this.state.rejected && !customerReturnCanLeave(this.state.status))
    )
      return;
    try {
      this.storage?.removeItem(this.storageKey);
      this.update({ record: null, status: null, error: null, rejected: false });
    } catch {
      this.update({
        error:
          "The saved request could not be cleared. Keep this page open and try again.",
      });
    }
  }
  activate() {
    this.active = true;
    this.update({ busy: false });
  }
  dispose() {
    this.active = false;
    this.controller?.abort();
  }
}

export function customerReturnCanLeave(
  status: CustomerReturnCustomerLabelStatus | null,
): boolean {
  return Boolean(
    status &&
      !status.canProgress &&
      status.parcels.every(
        (parcel) => parcel.status === "ready" || parcel.status === "failed",
      ),
  );
}

export async function downloadCustomerReturnLabel(
  status: CustomerReturnCustomerLabelStatus,
  parcelId: number,
  expectedSessionKey: string,
  signal: AbortSignal,
  request: FetchRequest = fetch,
): Promise<Blob> {
  const parcel = assertCustomerReturnStatus(status).parcels.find(
    (item) => item.parcelId === parcelId,
  );
  if (!parcel?.downloadPath || parcel.status !== "ready")
    throw new Error("This label is not ready to download.");
  const response = await request(parcel.downloadPath, {
    credentials: "include",
    cache: "no-store",
    signal,
    headers: {
      [RETURN_CUSTOMER_SESSION_HEADER]: sessionKey.parse(expectedSessionKey),
    },
  });
  if (!response.ok) await responseBody(response, z.never());
  const maximum = 10 * 1024 * 1024;
  if (
    response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/pdf" ||
    Number(response.headers.get("Content-Length") ?? 0) > maximum
  )
    throw new Error("The label file could not be verified.");
  const blob = await response.blob();
  if (
    !blob.size ||
    blob.size > maximum ||
    (await blob.slice(0, 5).text()) !== "%PDF-"
  )
    throw new Error("The label file could not be verified.");
  return blob;
}
