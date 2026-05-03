import {
  DropshipOmsChannelConfigService,
  makeDropshipOmsChannelConfigLogger,
  systemDropshipOmsChannelConfigClock,
} from "../application/dropship-oms-channel-config-service";
import { PgDropshipOmsChannelConfigRepository } from "./dropship-oms-channel-config.repository";

export function createDropshipOmsChannelConfigServiceFromEnv(): DropshipOmsChannelConfigService {
  return new DropshipOmsChannelConfigService({
    repository: new PgDropshipOmsChannelConfigRepository(),
    clock: systemDropshipOmsChannelConfigClock,
    logger: makeDropshipOmsChannelConfigLogger(),
  });
}
