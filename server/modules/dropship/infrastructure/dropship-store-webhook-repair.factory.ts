import {
  DropshipStoreWebhookRepairService,
  makeDropshipStoreWebhookRepairLogger,
  systemDropshipStoreWebhookRepairClock,
} from "../application/dropship-store-webhook-repair-service";
import { ShopifyDropshipWebhookSubscriptionProvider } from "./dropship-shopify-webhook-subscription.provider";
import { PgDropshipStoreWebhookRepairRepository } from "./dropship-store-webhook-repair.repository";

export function createDropshipStoreWebhookRepairServiceFromEnv(): DropshipStoreWebhookRepairService {
  return new DropshipStoreWebhookRepairService({
    repository: new PgDropshipStoreWebhookRepairRepository(),
    postConnectProvider: ShopifyDropshipWebhookSubscriptionProvider.fromEnv(),
    clock: systemDropshipStoreWebhookRepairClock,
    logger: makeDropshipStoreWebhookRepairLogger(),
  });
}
