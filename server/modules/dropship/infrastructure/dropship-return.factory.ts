import {
  DropshipReturnService,
  makeDropshipReturnLogger,
  systemDropshipReturnClock,
} from "../application/dropship-return-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipReturnRepository } from "./dropship-return.repository";

export function createDropshipReturnServiceFromEnv(): DropshipReturnService {
  return new DropshipReturnService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipReturnRepository(),
    clock: systemDropshipReturnClock,
    logger: makeDropshipReturnLogger(),
  });
}
