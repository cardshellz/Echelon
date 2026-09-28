import { randomUUID } from "node:crypto";
import { createCustomerReturnLiveService } from "./customer-return-live.composition";
import { PostgresCustomerReturnSettingsStore } from "./customer-return-label-settings.repository";
import { PostgresCustomerReturnLabelStore } from "./customer-return-labels.repository";
import { PostgresCustomerReturnSubmissionStore } from "./customer-return-submission.repository";
import { PostgresCustomerReturnIntakeStore } from "./customer-return-intake.repository";
import { downloadCustomerReturnLabel } from "./customer-return-label-download";
import {
  CustomerReturnLabelSettingsService,
  type ReturnLabelCapabilities,
} from "../application/customer-return-label-settings.service";
import { CustomerReturnLabelsService } from "../application/customer-return-labels.service";
import { CustomerReturnSubmissionService } from "../application/customer-return-submission.service";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import { createShipStationReturnLabelAdapter } from "../../shipping-engine/infrastructure/shipstation-return-label.adapter";
import { createShipStationReturnRateAdapter } from "../../shipping-engine/infrastructure/shipstation-return-rate.adapter";
import { ReturnRateProviderError } from "../../shipping-engine/application/return-rate-provider.port";
import { isReturnRateCatalogServiceEligible } from "../../shipping-engine/application/return-rate-catalog";
import { createShipStationV2RatingAdapter } from "../../shipping-engine/infrastructure/shipstation-v2-rating.adapter";
import {
  ReturnLabelProviderError,
  type ReturnLabelProvider,
} from "../../shipping-engine/application/return-label-provider.port";
import type { CustomerReturnLabelRouteServices } from "../interfaces/http/customer-return-label.routes";

/** Instantiated only after the private route's fresh staff authorization. */
export async function createCustomerReturnLabelServices(): Promise<CustomerReturnLabelRouteServices> {
  const [{ db, pool }, live] = await Promise.all([
    import("../../../db"),
    createCustomerReturnLiveService(),
  ]);
  const now = (): Date => new Date();
  const apiKey = process.env.SHIPSTATION_V2_API_KEY?.trim() ?? "";
  const authorizeChannel = async (channelId: number): Promise<void> => {
    if (
      !(await live.getState()).shops.some(
        (shop) => shop.channelId === channelId,
      )
    )
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SHOP_UNAVAILABLE",
        "Select a configured returns store.",
        409,
      );
  };
  const settingsStore = new PostgresCustomerReturnSettingsStore(db);
  const settings = new CustomerReturnLabelSettingsService({
    store: settingsStore,
    authorizeChannel,
    capabilities: () => readReturnLabelCapabilities(apiKey),
    now,
  });
  // A missing credential must not prevent read/replay/download of saved returns.
  const unavailable: ReturnLabelProvider = {
    purchase: async () => {
      throw new ReturnLabelProviderError(
        "RETURN_LABEL_CONFIGURATION_INVALID",
        "rejected",
      );
    },
    recover: async () => {
      throw new ReturnLabelProviderError(
        "RETURN_LABEL_CONFIGURATION_INVALID",
        "unknown",
      );
    },
  };
  const labels = new CustomerReturnLabelsService({
    store: new PostgresCustomerReturnLabelStore(pool, now),
    provider: apiKey
      ? createShipStationReturnLabelAdapter({ apiKey })
      : unavailable,
    rates: apiKey
      ? createShipStationReturnRateAdapter({ apiKey })
      : {
          quote: async () => {
            throw new ReturnRateProviderError(
              "RETURN_RATE_CONFIGURATION_INVALID",
              "configuration",
            );
          },
        },
    authorizeChannel,
    now,
    requirePurchaseConfiguration: (channelId, authorizationId) => settings.requireAcceptedShippingEnabled(channelId, authorizationId),
  });
  const submissions = new CustomerReturnSubmissionService({
    commands: new PostgresCustomerReturnSubmissionStore(pool),
    intake: new PostgresCustomerReturnIntakeStore(db, now),
    live,
    settings,
    labels,
    authorizeChannel,
    now,
    newToken: randomUUID,
  });
  return {
    settings,
    labels,
    submissions,
    download: downloadCustomerReturnLabel,
  };
}

export async function readReturnLabelCapabilities(
  apiKey: string,
): Promise<ReturnLabelCapabilities> {
  if (!apiKey) return { configured: false, carriers: [] };
  const adapter = createShipStationV2RatingAdapter({ apiKey });
  const result = await adapter.listCarriers();
  if (!result.configured || result.carriers.length > 100)
    throw new CustomerReturnIntakeError(
      "RETURN_LABEL_CARRIER_UNAVAILABLE",
      "Connected return carriers could not be verified.",
      503,
    );
  const carriers: ReturnLabelCapabilities["carriers"] = [];
  // Bound provider concurrency without silently dropping a connected account.
  for (let index = 0; index < result.carriers.length; index += 3) {
    const batch = await Promise.all(
      result.carriers.slice(index, index + 3).map(async (carrier) => {
        const services = await adapter.listCarrierServices(carrier);
        if (!services.configured || services.services.length > 200)
          throw new CustomerReturnIntakeError(
            "RETURN_LABEL_SERVICE_UNAVAILABLE",
            "Connected return services could not be verified.",
            503,
          );
        return {
          id: carrier.carrierId,
          code: carrier.code,
          name: carrier.name,
          services: services.services
            .filter(isReturnRateCatalogServiceEligible)
            .map((service) => ({
              code: service.serviceCode,
              name: service.serviceName,
            })),
        };
      }),
    );
    carriers.push(...batch.filter((carrier) => carrier.services.length > 0));
  }
  return { configured: true, carriers };
}
