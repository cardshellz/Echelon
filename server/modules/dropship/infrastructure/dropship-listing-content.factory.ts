import { DropshipListingContentService } from "../application/dropship-listing-content-service";
import { makeDropshipListingPreviewLogger, systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { PgDropshipListingContentRepository } from "./dropship-listing-content.repository";

export function createDropshipListingContentService(): DropshipListingContentService {
  return new DropshipListingContentService({ repository: new PgDropshipListingContentRepository(),
    clock: systemDropshipListingPreviewClock, logger: makeDropshipListingPreviewLogger() });
}
