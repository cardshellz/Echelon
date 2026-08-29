import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { type Express, type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoricalShipStationContentsClientError } from "../../historical-shipstation-contents-audit.client";
import { HistoricalShipStationContentsAttestationRepositoryError } from "../../historical-shipstation-contents-attestation.repository";
import {
  HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH,
  registerHistoricalShipStationContentsAttestationAdminRoutes,
  type HistoricalShipStationContentsAttestationApi,
} from "../../historical-shipstation-contents-attestation.routes";
import { HistoricalShipStationContentsAttestationServiceError } from "../../historical-shipstation-contents-attestation.service";

const { requirePermissionMock } = vi.hoisted(() => ({
  requirePermissionMock: vi.fn(
    (_resource: string, _action: string) => (
      _request: unknown,
      _response: unknown,
      next: () => void,
    ) => next(),
  ),
}));

vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));

const openServers: http.Server[] = [];
const preview = Object.freeze({
  shippingProviderLabelId: "51",
  providerShipmentId: 44_001,
  providerContentsStatus: "authoritative",
  recoveryStatus: "provider_line_keys_authoritative" as const,
  previewEvidenceHash: "a".repeat(64),
  providerEvidenceHash: "b".repeat(64),
  reviewContext: Object.freeze({
    trackingNumber: "9400111899223856928499",
    shipStationOrderId: "700100200",
    wmsOrders: Object.freeze([
      Object.freeze({ wmsOrderId: 301, orderNumber: "#1001" }),
    ]),
    linkedShipments: Object.freeze([
      Object.freeze({ source: "legacy_wms_shipment" as const, shipmentId: "88" }),
    ]),
    linePresentations: Object.freeze([
      Object.freeze({ wmsShipmentItemId: 7_001, itemName: "Card Shell" }),
    ]),
  }),
  expectedContents: Object.freeze({
    kind: "available" as const,
    source: "legacy_wms_shipment" as const,
    lines: Object.freeze([
      Object.freeze({ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 }),
    ]),
  }),
  attestedContents: Object.freeze([
    Object.freeze({ wmsShipmentItemId: 7_001, quantity: 2 }),
  ]),
});

function fakeService(): {
  readonly value: HistoricalShipStationContentsAttestationApi;
  readonly preview: ReturnType<typeof vi.fn>;
  readonly attest: ReturnType<typeof vi.fn>;
} {
  const previewMethod = vi.fn(async () => preview);
  const attest = vi.fn(async () => Object.freeze({
    kind: "created" as const,
    attestationId: "901",
    shippingProviderLabelId: "51",
    previewEvidenceHash: preview.previewEvidenceHash,
    resolvedEventCount: 2,
  }));
  return { value: { preview: previewMethod, attest }, preview: previewMethod, attest };
}

function buildApp(
  service: HistoricalShipStationContentsAttestationApi,
  actorUserId: string | null = "lead-user-1",
  factory: () => HistoricalShipStationContentsAttestationApi = () => service,
): Express {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const sessionRequest = request as Request & {
      session: { user?: { id: string } };
    };
    sessionRequest.session = actorUserId === null
      ? {}
      : { user: { id: actorUserId } };
    next();
  });
  registerHistoricalShipStationContentsAttestationAdminRoutes(app, factory);
  return app;
}

async function listen(app: Express): Promise<string> {
  const server = http.createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function jsonRequest(
  url: string,
  input: Readonly<{ readonly method?: string; readonly body?: unknown }> = {},
): Promise<Readonly<{ readonly status: number; readonly body: unknown }>> {
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: input.body === undefined ? undefined : { "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

beforeEach(() => {
  requirePermissionMock.mockClear();
});

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => (
    new Promise<void>((resolve) => server.close(() => resolve()))
  )));
});

describe("historical ShipStation contents attestation admin routes", () => {
  it("loads an exact provider-and-WMS preview behind inventory view permission", async () => {
    const service = fakeService();
    const baseUrl = await listen(buildApp(service.value));

    const response = await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51/preview`,
    );

    expect(response).toEqual({ status: 200, body: { preview } });
    expect(service.preview).toHaveBeenCalledWith("51");
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "view");
  });

  it("submits the authenticated session actor and exact reviewed fingerprint", async () => {
    const service = fakeService();
    const baseUrl = await listen(buildApp(service.value, "lead-user-7"));
    const body = {
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      reason: "Reviewed exact ShipStation contents against the linked WMS shipment",
    };

    const response = await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      { method: "POST", body },
    );

    expect(response.status).toBe(201);
    expect(service.attest).toHaveBeenCalledWith({
      shippingProviderLabelId: "51",
      authenticatedActorUserId: "lead-user-7",
      ...body,
    });
    expect(requirePermissionMock).toHaveBeenCalledWith("inventory", "adjust");
  });

  it("returns 200 for an exact idempotent replay", async () => {
    const service = fakeService();
    service.attest.mockResolvedValue({
      kind: "already_persisted",
      attestationId: "901",
      shippingProviderLabelId: "51",
      previewEvidenceHash: preview.previewEvidenceHash,
      resolvedEventCount: 2,
    });
    const baseUrl = await listen(buildApp(service.value));

    const response = await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      {
        method: "POST",
        body: {
          expectedPreviewEvidenceHash: preview.previewEvidenceHash,
          reason: "Reviewed exact ShipStation contents against the linked WMS shipment",
        },
      },
    );

    expect(response.status).toBe(200);
  });

  it("rejects caller-supplied actor fields before invoking the service", async () => {
    const service = fakeService();
    const baseUrl = await listen(buildApp(service.value));

    const response = await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      {
        method: "POST",
        body: {
          expectedPreviewEvidenceHash: preview.previewEvidenceHash,
          reason: "Reviewed exact contents",
          authenticatedActorUserId: "forged-admin",
        },
      },
    );

    expect(response).toMatchObject({
      status: 400,
      body: { error: { code: "HISTORICAL_CONTENTS_ATTESTATION_REQUEST_INVALID" } },
    });
    expect(service.attest).not.toHaveBeenCalled();
  });

  it("requires a server-authenticated actor even after permission middleware", async () => {
    const service = fakeService();
    const baseUrl = await listen(buildApp(service.value, null));

    const response = await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      {
        method: "POST",
        body: {
          expectedPreviewEvidenceHash: preview.previewEvidenceHash,
          reason: "Reviewed exact contents",
        },
      },
    );

    expect(response).toMatchObject({
      status: 401,
      body: { error: { code: "HISTORICAL_CONTENTS_ATTESTATION_ACTOR_REQUIRED" } },
    });
    expect(service.attest).not.toHaveBeenCalled();
  });

  it("maps authorization and stale-preview failures to fail-closed responses", async () => {
    const unauthorized = fakeService();
    unauthorized.attest.mockRejectedValue(new HistoricalShipStationContentsAttestationServiceError(
      "LEAD_AUTHORIZATION_REQUIRED",
      "lead required",
    ));
    const unauthorizedUrl = await listen(buildApp(unauthorized.value));
    const request = {
      method: "POST",
      body: {
        expectedPreviewEvidenceHash: preview.previewEvidenceHash,
        reason: "Reviewed exact contents",
      },
    } as const;

    const unauthorizedResponse = await jsonRequest(
      `${unauthorizedUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      request,
    );
    expect(unauthorizedResponse.status).toBe(403);

    const stale = fakeService();
    stale.attest.mockRejectedValue(new HistoricalShipStationContentsAttestationServiceError(
      "PREVIEW_EVIDENCE_MISMATCH",
      "preview changed",
    ));
    const staleUrl = await listen(buildApp(stale.value));
    const staleResponse = await jsonRequest(
      `${staleUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      request,
    );
    expect(staleResponse.status).toBe(409);
  });

  it("classifies provider timeouts and database conflicts", async () => {
    const timeout = fakeService();
    timeout.preview.mockRejectedValue(new HistoricalShipStationContentsClientError(
      "TIMEOUT",
      "provider timed out",
    ));
    const timeoutUrl = await listen(buildApp(timeout.value));
    const timeoutResponse = await jsonRequest(
      `${timeoutUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51/preview`,
    );
    expect(timeoutResponse.status).toBe(504);

    const conflict = fakeService();
    conflict.attest.mockRejectedValue(new HistoricalShipStationContentsAttestationRepositoryError(
      "ATTESTATION_CONFLICT",
      "already resolved",
    ));
    const conflictUrl = await listen(buildApp(conflict.value));
    const conflictResponse = await jsonRequest(
      `${conflictUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51`,
      {
        method: "POST",
        body: {
          expectedPreviewEvidenceHash: preview.previewEvidenceHash,
          reason: "Reviewed exact contents",
        },
      },
    );
    expect(conflictResponse.status).toBe(409);
  });

  it("fails closed when the service returns an invalid preview contract", async () => {
    const service = fakeService();
    service.preview.mockResolvedValue({ ...preview, providerShipmentId: 0 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const baseUrl = await listen(buildApp(service.value));
      const response = await jsonRequest(
        `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51/preview`,
      );

      expect(response).toMatchObject({
        status: 500,
        body: {
          error: { code: "HISTORICAL_CONTENTS_ATTESTATION_INTERNAL_ERROR" },
        },
      });
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects invalid label identities and reuses one lazily-created service", async () => {
    const service = fakeService();
    const factory = vi.fn(() => service.value);
    const baseUrl = await listen(buildApp(service.value, "lead-user-1", factory));

    const invalid = await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/0/preview`,
    );
    expect(invalid.status).toBe(400);
    expect(factory).not.toHaveBeenCalled();

    await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51/preview`,
    );
    await jsonRequest(
      `${baseUrl}${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/51/preview`,
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
