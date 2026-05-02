import {
  DropshipOrderCancellationService,
  makeDropshipOrderCancellationLogger,
  systemDropshipOrderCancellationClock,
} from "../application/dropship-order-cancellation-service";
import { createDropshipMarketplaceOrderCancellationProviderFromEnv } from "./dropship-marketplace-order-cancellation.providers";
import { PgDropshipOrderCancellationRepository } from "./dropship-order-cancellation.repository";

export function createDropshipOrderCancellationServiceFromEnv(): DropshipOrderCancellationService {
  return new DropshipOrderCancellationService({
    repository: new PgDropshipOrderCancellationRepository(),
    marketplaceCancellation: createDropshipMarketplaceOrderCancellationProviderFromEnv(),
    clock: systemDropshipOrderCancellationClock,
    logger: makeDropshipOrderCancellationLogger(),
  });
}
