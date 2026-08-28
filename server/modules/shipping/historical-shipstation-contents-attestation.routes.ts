import type { Express, Request, Response } from "express";
import {
  HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_API_PATH,
  historicalShipStationContentsAttestationPreviewResponseSchema,
  historicalShipStationContentsAttestationRequestSchema,
  historicalShipStationContentsAttestationResponseSchema,
  historicalShipStationContentsLabelIdSchema,
} from "@shared/types/historical-shipstation-contents-attestation";
import { z } from "zod";

import { pool } from "../../db";
import { requirePermission } from "../../routes/middleware";
import {
  createHistoricalShipStationContentsClient,
  HistoricalShipStationContentsClientError,
} from "./historical-shipstation-contents-audit.client";
import {
  HistoricalShipStationContentsAttestationRepositoryError,
  PgHistoricalShipStationContentsAttestationRepository,
  type PersistedHistoricalShipStationContentsAttestation,
} from "./historical-shipstation-contents-attestation.repository";
import {
  HistoricalShipStationContentsAttestationService,
  HistoricalShipStationContentsAttestationServiceError,
  type HistoricalShipStationContentsAttestationCommand,
  type HistoricalShipStationContentsAttestationPreview,
} from "./historical-shipstation-contents-attestation.service";

export const HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH =
  HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_API_PATH;

export interface HistoricalShipStationContentsAttestationApi {
  preview(shippingProviderLabelId: string): Promise<HistoricalShipStationContentsAttestationPreview>;
  attest(
    command: HistoricalShipStationContentsAttestationCommand,
  ): Promise<PersistedHistoricalShipStationContentsAttestation>;
}

export type HistoricalShipStationContentsAttestationApiFactory =
  () => HistoricalShipStationContentsAttestationApi;

function createHistoricalShipStationContentsAttestationApiFromEnv():
  HistoricalShipStationContentsAttestationApi {
  return new HistoricalShipStationContentsAttestationService(
    new PgHistoricalShipStationContentsAttestationRepository(pool),
    createHistoricalShipStationContentsClient(),
  );
}

function validationIssues(error: z.ZodError): readonly Readonly<{
  readonly code: string;
  readonly path: readonly string[];
  readonly message: string;
}>[] {
  return Object.freeze(error.issues.map((issue) => Object.freeze({
    code: issue.code,
    path: issue.path.map(String),
    message: issue.message,
  })));
}

function readAuthenticatedActorUserId(request: Request): string | null {
  const rawUserId = request.session?.user?.id;
  if (rawUserId === undefined || rawUserId === null) return null;
  const userId = String(rawUserId).trim();
  return userId.length > 0 && userId.length <= 190 ? userId : null;
}

function sendValidationError(response: Response, error: z.ZodError): Response {
  return response.status(400).json({
    error: {
      code: "HISTORICAL_CONTENTS_ATTESTATION_REQUEST_INVALID",
      message: "Historical contents attestation request is invalid.",
      context: { issues: validationIssues(error) },
    },
  });
}

function serviceErrorStatus(code: HistoricalShipStationContentsAttestationServiceError["code"]):
  number {
  switch (code) {
    case "INVALID_COMMAND":
      return 400;
    case "LEAD_AUTHORIZATION_REQUIRED":
      return 403;
    case "CANDIDATE_NOT_FOUND":
    case "PROVIDER_SHIPMENT_NOT_FOUND":
      return 404;
    case "CANDIDATE_CHANGED":
    case "NO_RESOLVABLE_EVENTS":
    case "PREVIEW_EVIDENCE_MISMATCH":
    case "PROVIDER_EVIDENCE_NOT_RECOVERABLE":
      return 409;
  }
}

function clientErrorStatus(code: HistoricalShipStationContentsClientError["code"]): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "CONFIGURATION":
      return 503;
    case "TIMEOUT":
      return 504;
    case "NETWORK":
    case "HTTP":
    case "INVALID_RESPONSE":
      return 502;
  }
}

function repositoryErrorStatus(
  code: HistoricalShipStationContentsAttestationRepositoryError["code"],
): number {
  return code === "ATTESTATION_CONFLICT" || code === "CONCURRENT_WRITE" ? 409 : 500;
}

function sendAttestationError(response: Response, error: unknown): Response {
  if (error instanceof HistoricalShipStationContentsAttestationServiceError) {
    return response.status(serviceErrorStatus(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  if (error instanceof HistoricalShipStationContentsClientError) {
    return response.status(clientErrorStatus(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  if (error instanceof HistoricalShipStationContentsAttestationRepositoryError) {
    return response.status(repositoryErrorStatus(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  console.error(JSON.stringify({
    code: "HISTORICAL_CONTENTS_ATTESTATION_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  }));
  return response.status(500).json({
    error: {
      code: "HISTORICAL_CONTENTS_ATTESTATION_INTERNAL_ERROR",
      message: "Historical contents attestation operation failed.",
    },
  });
}

export function registerHistoricalShipStationContentsAttestationAdminRoutes(
  app: Express,
  factory: HistoricalShipStationContentsAttestationApiFactory =
  createHistoricalShipStationContentsAttestationApiFromEnv,
): void {
  let service: HistoricalShipStationContentsAttestationApi | null = null;
  const resolveService = (): HistoricalShipStationContentsAttestationApi => {
    service ??= factory();
    return service;
  };

  app.get(
    `${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/:shippingProviderLabelId/preview`,
    requirePermission("inventory", "view"),
    async (request, response) => {
      const parsedLabelId = historicalShipStationContentsLabelIdSchema.safeParse(
        request.params.shippingProviderLabelId,
      );
      if (!parsedLabelId.success) return sendValidationError(response, parsedLabelId.error);
      try {
        const previewResponse = historicalShipStationContentsAttestationPreviewResponseSchema.parse({
          preview: await resolveService().preview(parsedLabelId.data),
        });
        return response.json(previewResponse);
      } catch (error) {
        return sendAttestationError(response, error);
      }
    },
  );

  app.post(
    `${HISTORICAL_SHIPSTATION_CONTENTS_ATTESTATION_ADMIN_PATH}/:shippingProviderLabelId`,
    requirePermission("inventory", "adjust"),
    async (request, response) => {
      const parsedLabelId = historicalShipStationContentsLabelIdSchema.safeParse(
        request.params.shippingProviderLabelId,
      );
      if (!parsedLabelId.success) return sendValidationError(response, parsedLabelId.error);
      const parsedBody = historicalShipStationContentsAttestationRequestSchema.safeParse(
        request.body,
      );
      if (!parsedBody.success) return sendValidationError(response, parsedBody.error);
      const authenticatedActorUserId = readAuthenticatedActorUserId(request);
      if (authenticatedActorUserId === null) {
        return response.status(401).json({
          error: {
            code: "HISTORICAL_CONTENTS_ATTESTATION_ACTOR_REQUIRED",
            message: "An authenticated audit actor is required.",
          },
        });
      }
      try {
        const attestation = await resolveService().attest({
          shippingProviderLabelId: parsedLabelId.data,
          expectedPreviewEvidenceHash: parsedBody.data.expectedPreviewEvidenceHash,
          authenticatedActorUserId,
          reason: parsedBody.data.reason,
        });
        const attestationResponse = historicalShipStationContentsAttestationResponseSchema.parse({
          attestation,
        });
        return response
          .status(attestation.kind === "created" ? 201 : 200)
          .json(attestationResponse);
      } catch (error) {
        return sendAttestationError(response, error);
      }
    },
  );
}
