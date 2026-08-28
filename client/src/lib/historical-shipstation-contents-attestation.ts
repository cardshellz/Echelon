import {
  HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_API_PATH,
  historicalShipStationContentsAttestationPreviewResponseSchema,
  historicalShipStationContentsAttestationRequestSchema,
  historicalShipStationContentsAttestationResponseSchema,
  historicalShipStationContentsLabelIdSchema,
  type HistoricalShipStationContentsAttestationPreview,
  type HistoricalShipStationContentsAttestationRequest,
  type HistoricalShipStationContentsAttestationResult,
} from "@shared/types/historical-shipstation-contents-attestation";
import { z } from "zod";

type FetchImplementation = typeof fetch;

export const HISTORICAL_SHIPMENT_CONTENTS_REVIEW_PATH =
  "/shipping/historical-contents-review";

const serverErrorSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }).passthrough(),
}).passthrough();

export class HistoricalShipStationContentsAttestationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsAttestationApiError";
  }
}

function exactLabelId(rawLabelId: string): string {
  const parsed = historicalShipStationContentsLabelIdSchema.safeParse(rawLabelId);
  if (!parsed.success) {
    throw new HistoricalShipStationContentsAttestationApiError(
      0,
      "INVALID_LABEL_ID",
      "Shipping provider label ID must be a positive integer.",
    );
  }
  return parsed.data;
}

export function historicalShipStationContentsPreviewUrl(rawLabelId: string): string {
  const labelId = exactLabelId(rawLabelId);
  return `${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_API_PATH}/${labelId}/preview`;
}

export function historicalShipStationContentsAttestationUrl(rawLabelId: string): string {
  const labelId = exactLabelId(rawLabelId);
  return `${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_API_PATH}/${labelId}`;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function responseError(response: Response, body: unknown): Error {
  const parsed = serverErrorSchema.safeParse(body);
  return new HistoricalShipStationContentsAttestationApiError(
    response.status,
    parsed.success ? parsed.data.error.code ?? "REQUEST_FAILED" : "REQUEST_FAILED",
    parsed.success
      ? parsed.data.error.message ?? `Request failed (${response.status}).`
      : `Request failed (${response.status}).`,
  );
}

export async function loadHistoricalShipStationContentsAttestationPreview(
  shippingProviderLabelId: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<HistoricalShipStationContentsAttestationPreview> {
  const response = await fetchImplementation(
    historicalShipStationContentsPreviewUrl(shippingProviderLabelId),
    { credentials: "include" },
  );
  const body = await readJson(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = historicalShipStationContentsAttestationPreviewResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new HistoricalShipStationContentsAttestationApiError(
      response.status,
      "INVALID_RESPONSE",
      "The server returned an invalid historical contents preview.",
    );
  }
  return parsed.data.preview;
}

export async function submitHistoricalShipStationContentsAttestation(
  shippingProviderLabelId: string,
  request: HistoricalShipStationContentsAttestationRequest,
  fetchImplementation: FetchImplementation = fetch,
): Promise<HistoricalShipStationContentsAttestationResult> {
  const parsedRequest = historicalShipStationContentsAttestationRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new HistoricalShipStationContentsAttestationApiError(
      0,
      "INVALID_REQUEST",
      "Historical contents attestation reason or preview identity is invalid.",
    );
  }
  const response = await fetchImplementation(
    historicalShipStationContentsAttestationUrl(shippingProviderLabelId),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(parsedRequest.data),
    },
  );
  const body = await readJson(response);
  if (!response.ok) throw responseError(response, body);
  const parsed = historicalShipStationContentsAttestationResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new HistoricalShipStationContentsAttestationApiError(
      response.status,
      "INVALID_RESPONSE",
      "The server returned an invalid historical contents attestation receipt.",
    );
  }
  return parsed.data.attestation;
}
