import { z } from "zod";

import {
  planHistoricalShipStationContentsCorrection,
  type HistoricalShipStationContentsCorrectionPlan,
} from "./historical-shipstation-contents-correction.domain";
import type {
  HistoricalShipStationContentsCorrectionRepository,
} from "./historical-shipstation-contents-correction.repository";
import type {
  HistoricalShipStationContentsResolutionPreview,
} from "./historical-shipstation-contents-review.service";

const positiveBigintText = z.string().regex(/^[1-9][0-9]*$/);

export interface HistoricalShipStationContentsLiveReviewService {
  preview(exceptionId: string): Promise<HistoricalShipStationContentsResolutionPreview>;
}

export type HistoricalShipStationContentsCorrectionServiceErrorCode =
  | "CORRECTION_NOT_AUTHORIZED"
  | "INVALID_COMMAND";

export class HistoricalShipStationContentsCorrectionServiceError extends Error {
  constructor(
    readonly code: HistoricalShipStationContentsCorrectionServiceErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "HistoricalShipStationContentsCorrectionServiceError";
  }
}

export class HistoricalShipStationContentsCorrectionService {
  constructor(
    private readonly repository: HistoricalShipStationContentsCorrectionRepository,
    private readonly liveReviewService: HistoricalShipStationContentsLiveReviewService,
  ) {}

  async preview(rawExceptionId: string): Promise<HistoricalShipStationContentsCorrectionPlan> {
    const parsedExceptionId = positiveBigintText.safeParse(rawExceptionId);
    if (!parsedExceptionId.success) {
      throw new HistoricalShipStationContentsCorrectionServiceError(
        "INVALID_COMMAND",
        "Historical contents correction exception identifier failed validation",
      );
    }
    // The review preview performs the live ShipStation re-fetch and verifies that
    // both the provider observation and WMS candidate still match the intake.
    const review = await this.liveReviewService.preview(parsedExceptionId.data);
    if (review.recordedDecision !== "provider_confirmed_pending_inventory_correction") {
      throw new HistoricalShipStationContentsCorrectionServiceError(
        "CORRECTION_NOT_AUTHORIZED",
        "ShipStation contents must be confirmed before a correction can be previewed",
      );
    }
    const facts = await this.repository.loadFacts(Object.freeze({
      exceptionId: parsedExceptionId.data,
      reviewPreviewEvidenceHash: review.previewEvidenceHash,
      orderNumber: review.orderNumber,
      trackingNumber: review.trackingNumber,
      providerLines: review.providerContents,
    }));
    return planHistoricalShipStationContentsCorrection(facts);
  }
}
