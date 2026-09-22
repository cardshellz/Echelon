import {
  DropshipOpsSurfaceService,
  makeDropshipOpsSurfaceLogger,
  systemDropshipOpsSurfaceClock,
} from "../application/dropship-ops-surface-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipOpsSurfaceRepository } from "./dropship-ops-surface.repository";
import { createStripeDropshipFundingProviderFromEnv } from "./dropship-stripe-funding.provider";
import { createDropshipStripeRailAvailabilityReader } from "./dropship-stripe-rail-availability.reader";

export function createDropshipOpsSurfaceServiceFromEnv(): DropshipOpsSurfaceService {
  const clock = systemDropshipOpsSurfaceClock;
  return new DropshipOpsSurfaceService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipOpsSurfaceRepository(),
    clock,
    logger: makeDropshipOpsSurfaceLogger(),
    env: process.env,
    // One reader per service instance: it caches, so the readiness page does
    // not call Stripe on every render.
    stripeRails: createDropshipStripeRailAvailabilityReader({
      provider: createStripeDropshipFundingProviderFromEnv(),
      clock,
    }),
  });
}
