import {
  DropshipNoInspectionReviewService,
  makeDropshipNoInspectionReviewLogger,
  systemDropshipNoInspectionReviewClock,
} from "../application/dropship-no-inspection-review-service";
import { PgDropshipNoInspectionReviewRepository } from "./dropship-no-inspection-review.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

export function createDropshipNoInspectionReviewServiceFromEnv(): DropshipNoInspectionReviewService {
  return new DropshipNoInspectionReviewService({
    repository: new PgDropshipNoInspectionReviewRepository(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipNoInspectionReviewClock,
    logger: makeDropshipNoInspectionReviewLogger(),
  });
}
