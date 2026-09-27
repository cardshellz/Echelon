import { z } from "zod";
import {
  CUSTOMER_RETURN_LABEL_API,
  customerReturnLabelSettingsInputSchema,
  customerReturnLabelSettingsStateSchema,
  customerReturnLabelStatusSchema,
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSettingsInput,
  type CustomerReturnLabelSettingsState,
  type CustomerReturnLabelStatus,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { PreviewAccessError } from "./customer-return-preview";

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
const positiveId = z.number().int().positive().safe();
const errorSchema = z.object({
  error: z.object({ code: z.string().max(100).optional() }),
});

export class ReturnLabelRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReturnLabelRequestError";
  }
}

async function readLabelResponse<T extends z.ZodTypeAny>(
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  if (response.status === 401 || response.status === 403) {
    throw new PreviewAccessError(
      "Admin access is required. Sign in with an authorized admin account and try again.",
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorSchema.safeParse(body);
    const code = error.success
      ? (error.data.error.code ?? "RETURN_LABEL_REQUEST_FAILED")
      : "RETURN_LABEL_REQUEST_FAILED";
    const message =
      code === "RETURN_LABEL_SUBMISSION_REJECTED"
        ? "This return was not created. Find the order again to review its current availability."
        : code === "RETURN_LABEL_SUBMISSION_PROCESSING"
          ? "Your return is still being checked. Check its status again shortly."
          : code === "RETURN_LABEL_SUBMISSION_NOT_FOUND"
            ? "We have not confirmed the outcome yet. Check status before starting another return."
            : code === "RETURN_LABEL_SETTINGS_CHANGED" ||
                code === "RETURN_LABEL_SETTINGS_DISABLED"
              ? "Label settings changed or are paused. Refresh label settings in Testing controls, then check label status."
              : response.status === 409
                ? "The saved configuration or return changed. Refresh its status before trying again."
                : "The label service is unavailable. Your saved request will be kept so you can check its status.";
    throw new ReturnLabelRequestError(code, message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      "The label response could not be verified. Check status before trying again.",
    );
  return parsed.data;
}

async function requestLabel<T extends z.ZodTypeAny>(
  request: FetchRequest,
  path: string,
  signal: AbortSignal,
  schema: T,
  body?: unknown,
  method = "POST",
): Promise<z.output<T>> {
  const response = await request(`${CUSTOMER_RETURN_LABEL_API}${path}`, {
    method: body === undefined ? "GET" : method,
    credentials: "include",
    cache: "no-store",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: {
            "Content-Type": "application/json",
            "X-Return-Command": "1",
          },
          body: JSON.stringify(body),
        }),
  });
  return readLabelResponse(response, schema);
}

function assertSettingsScope(
  state: CustomerReturnLabelSettingsState,
  channelId: number,
) {
  if (
    state.channelId !== channelId ||
    new Set(state.warehouses.map((item) => item.id)).size !==
      state.warehouses.length ||
    new Set(state.policies.map((item) => item.id)).size !==
      state.policies.length ||
    new Set(state.carriers.map((item) => item.id)).size !==
      state.carriers.length ||
    state.carriers.some(
      (carrier) =>
        new Set(carrier.services.map((item) => item.code)).size !==
        carrier.services.length,
    )
  ) {
    throw new Error(
      "The label configuration could not be verified. Refresh it before continuing.",
    );
  }
  return state;
}

export async function loadReturnLabelSettings(
  channelId: number,
  signal: AbortSignal,
  request: FetchRequest = fetch,
) {
  positiveId.parse(channelId);
  return assertSettingsScope(
    await requestLabel(
      request,
      `/label-settings/${channelId}`,
      signal,
      customerReturnLabelSettingsStateSchema,
    ),
    channelId,
  );
}

export async function saveReturnLabelSettings(
  channelId: number,
  raw: CustomerReturnLabelSettingsInput,
  signal: AbortSignal,
  request: FetchRequest = fetch,
) {
  positiveId.parse(channelId);
  const input = customerReturnLabelSettingsInputSchema.parse(raw);
  return assertSettingsScope(
    await requestLabel(
      request,
      `/label-settings/${channelId}`,
      signal,
      customerReturnLabelSettingsStateSchema,
      input,
      "PUT",
    ),
    channelId,
  );
}

export function returnLabelsEnabled(
  state: CustomerReturnLabelSettingsState | null,
): boolean {
  const settings = state?.settings;
  return Boolean(
    state?.providerConfigured &&
      settings?.enabled &&
      state.warehouses.some(
        (item) => item.id === settings.warehouseId && item.address !== null,
      ) &&
      state.policies.some((item) => item.id === settings.policyId) &&
      state.carriers.some(
        (item) =>
          item.id === settings.carrierId &&
          item.services.some(
            (service) => service.code === settings.serviceCode,
          ),
      ),
  );
}

export function assertReturnLabelStatus(
  status: CustomerReturnLabelStatus,
  channelId: number,
  authorizationId?: number,
  parcelCount?: number,
) {
  if (
    status.channelId !== channelId ||
    (authorizationId !== undefined &&
      status.authorizationId !== authorizationId) ||
    (parcelCount !== undefined && status.parcels.length !== parcelCount) ||
    new Set(status.parcels.map((item) => item.parcelId)).size !==
      status.parcels.length ||
    new Set(status.parcels.map((item) => item.number)).size !==
      status.parcels.length ||
    status.parcels.some(
      (item) =>
        item.number > status.parcels.length ||
        (item.downloadPath !== null &&
          (item.status !== "ready" ||
            item.downloadPath !==
              `${CUSTOMER_RETURN_LABEL_API}/labels/${channelId}/${status.authorizationId}/parcels/${item.parcelId}/download`)),
    )
  ) {
    throw new Error(
      "The labels could not be matched to this return. Check status before continuing.",
    );
  }
  return status;
}

export interface CustomerReturnLabelTransport {
  submit(
    input: CustomerReturnLabelSubmitInput,
    signal: AbortSignal,
  ): Promise<CustomerReturnLabelStatus>;
  status(
    authorizationId: number,
    signal: AbortSignal,
  ): Promise<CustomerReturnLabelStatus>;
  byCommand(
    key: string,
    signal: AbortSignal,
  ): Promise<CustomerReturnLabelStatus>;
  resume(key: string, signal: AbortSignal): Promise<CustomerReturnLabelStatus>;
  progress(
    authorizationId: number,
    signal: AbortSignal,
  ): Promise<CustomerReturnLabelStatus>;
}

export function createReturnLabelTransport(
  channelId: number,
  request: FetchRequest = fetch,
): CustomerReturnLabelTransport {
  positiveId.parse(channelId);
  const status = async (
    path: string,
    signal: AbortSignal,
    body?: unknown,
    authorizationId?: number,
  ) =>
    assertReturnLabelStatus(
      await requestLabel(
        request,
        path,
        signal,
        customerReturnLabelStatusSchema,
        body,
      ),
      channelId,
      authorizationId,
    );
  return {
    async submit(raw, signal) {
      const input = customerReturnLabelSubmitInputSchema.parse(raw);
      if (input.channelId !== channelId)
        throw new Error("The Shopify shop changed. Find the order again.");
      return assertReturnLabelStatus(
        await requestLabel(
          request,
          "/labels",
          signal,
          customerReturnLabelStatusSchema,
          input,
        ),
        channelId,
        undefined,
        input.parcels.length,
      );
    },
    status(id, signal) {
      positiveId.parse(id);
      return status(`/labels/${channelId}/${id}`, signal, undefined, id);
    },
    byCommand(key, signal) {
      z.string().uuid().parse(key);
      return status(`/labels/${channelId}/by-command/${key}`, signal);
    },
    resume(key, signal) {
      z.string().uuid().parse(key);
      return status(
        `/labels/${channelId}/by-command/${key}/resume`,
        signal,
        {},
      );
    },
    progress(id, signal) {
      positiveId.parse(id);
      return status(`/labels/${channelId}/${id}/progress`, signal, {}, id);
    },
  };
}

export async function downloadReturnLabel(
  status: CustomerReturnLabelStatus,
  parcelId: number,
  signal: AbortSignal,
  request: FetchRequest = fetch,
): Promise<Blob> {
  const verified = assertReturnLabelStatus(
    customerReturnLabelStatusSchema.parse(status),
    status.channelId,
    status.authorizationId,
  );
  const parcel = verified.parcels.find((item) => item.parcelId === parcelId);
  if (parcel?.status !== "ready" || !parcel.downloadPath)
    throw new Error(
      "This label is not ready. Check its status before downloading.",
    );
  const response = await request(parcel.downloadPath, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (!response.ok) await readLabelResponse(response, z.never());
  const maximumBytes = 10 * 1024 * 1024;
  if (
    response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/pdf" ||
    Number(response.headers.get("Content-Length") ?? 0) > maximumBytes
  ) {
    throw new Error(
      "The label file could not be verified. Check its status and try again.",
    );
  }
  const blob = await response.blob();
  if (
    blob.size === 0 ||
    blob.size > maximumBytes ||
    (await blob.slice(0, 5).text()) !== "%PDF-"
  )
    throw new Error(
      "The label file could not be verified. Check its status and try again.",
    );
  return blob;
}
