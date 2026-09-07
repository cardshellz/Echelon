import { randomUUID } from "node:crypto";
import { DropshipPricingRulesService } from "../application/dropship-pricing-rules-service";
import { makeDropshipListingPreviewLogger, systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { PgDropshipPricingRulesRepository } from "./dropship-pricing-rules.repository";

export function createDropshipPricingRulesService(): DropshipPricingRulesService {
  return new DropshipPricingRulesService({ repository: new PgDropshipPricingRulesRepository(),
    clock: systemDropshipListingPreviewClock, newId: randomUUID, logger: makeDropshipListingPreviewLogger() });
}
