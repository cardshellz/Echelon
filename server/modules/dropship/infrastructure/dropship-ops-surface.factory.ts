import {
  DropshipOpsSurfaceService,
  makeDropshipOpsSurfaceLogger,
  systemDropshipOpsSurfaceClock,
} from "../application/dropship-ops-surface-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipOpsSurfaceRepository } from "./dropship-ops-surface.repository";

export function createDropshipOpsSurfaceServiceFromEnv(): DropshipOpsSurfaceService {
  return new DropshipOpsSurfaceService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipOpsSurfaceRepository(),
    clock: systemDropshipOpsSurfaceClock,
    logger: makeDropshipOpsSurfaceLogger(),
  });
}
