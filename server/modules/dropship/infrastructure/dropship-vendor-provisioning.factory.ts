import {
  DropshipVendorProvisioningService,
  makeDropshipVendorProvisioningLogger,
  systemDropshipVendorProvisioningClock,
} from "../application/dropship-vendor-provisioning-service";
import type { DropshipNotificationSender, DropshipNotificationSenderInput } from "../application/dropship-ports";
import { ShellzClubEntitlementAdapter } from "./shellz-club-entitlement.adapter";
import { PgDropshipVendorProvisioningRepository } from "./dropship-vendor-provisioning.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

export function createDropshipVendorProvisioningServiceFromEnv(): DropshipVendorProvisioningService {
  const entitlementAdapter = new ShellzClubEntitlementAdapter();
  return new DropshipVendorProvisioningService({
    entitlement: entitlementAdapter,
    repository: new PgDropshipVendorProvisioningRepository(),
    notificationSender: new LazyDropshipNotificationSender(),
    clock: systemDropshipVendorProvisioningClock,
    logger: makeDropshipVendorProvisioningLogger(),
  });
}

class LazyDropshipNotificationSender implements DropshipNotificationSender {
  private service: DropshipNotificationSender | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<unknown> {
    if (!this.service) {
      this.service = createDropshipNotificationServiceFromEnv();
    }
    return this.service.send(input);
  }
}
