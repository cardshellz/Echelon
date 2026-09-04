import {
  DropshipEbayOAuthBrandingService,
  makeDropshipEbayOAuthBrandingLogger,
  systemDropshipEbayOAuthBrandingClock,
} from "../application/dropship-ebay-oauth-branding-service";
import { PgDropshipEbayOAuthBrandingRepository } from "./dropship-ebay-oauth-branding.repository";

export function createDropshipEbayOAuthBrandingServiceFromEnv(): DropshipEbayOAuthBrandingService {
  return new DropshipEbayOAuthBrandingService({
    env: process.env,
    repository: new PgDropshipEbayOAuthBrandingRepository(),
    clock: systemDropshipEbayOAuthBrandingClock,
    logger: makeDropshipEbayOAuthBrandingLogger(),
  });
}
