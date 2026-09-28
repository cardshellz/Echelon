import {
  makeDropshipCostChangePolicyLogger,
  systemDropshipCostChangePolicyClock,
} from "../application/dropship-cost-change-policy-service";
import { DropshipCostChangeNoticeService } from "../application/dropship-cost-change-notice-service";
import { createDropshipCostChangePolicyServiceFromEnv } from "./dropship-cost-change-policy.factory";
import { PgDropshipCostChangeNoticeRepository } from "./dropship-cost-change-notice.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";

export function createDropshipCostChangeNoticeServiceFromEnv(): DropshipCostChangeNoticeService {
  return new DropshipCostChangeNoticeService({
    repository: new PgDropshipCostChangeNoticeRepository(),
    policy: createDropshipCostChangePolicyServiceFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    clock: systemDropshipCostChangePolicyClock,
    logger: makeDropshipCostChangePolicyLogger(),
  });
}
