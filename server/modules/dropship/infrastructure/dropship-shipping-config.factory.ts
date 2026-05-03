import {
  DropshipShippingConfigService,
  makeDropshipShippingConfigLogger,
  systemDropshipShippingConfigClock,
} from "../application/dropship-shipping-config-service";
import { PgDropshipShippingConfigRepository } from "./dropship-shipping-config.repository";

export function createDropshipShippingConfigServiceFromEnv(): DropshipShippingConfigService {
  return new DropshipShippingConfigService({
    repository: new PgDropshipShippingConfigRepository(),
    clock: systemDropshipShippingConfigClock,
    logger: makeDropshipShippingConfigLogger(),
  });
}
