import { z } from "zod";
import {
  fulfillmentChannelSchema,
  saveBoxSuiteSchema,
  savePackagingAssignmentSchema,
  saveFulfillmentServiceSchema,
  saveDropshipProgramSchema,
  saveProgramChargesSchema,
} from "@shared/shipping/configuration";
import { ShippingConfigurationError } from "../domain/configuration-error";
import type { SharedShippingConfigurationStore } from "./shared-configuration.port";

const positiveId = z.coerce.number().int().positive();
/** Boundary validation is shared by HTTP and future CLI importers. Persistence
 * owns atomic revision/idempotency checks; domain modules own selection/math. */
export class SharedShippingConfigurationService {
  constructor(
    private readonly repository: SharedShippingConfigurationStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  listPackaging() {
    return this.repository.listPackaging();
  }
  loadPackaging(channel: unknown, warehouseId: unknown) {
    return this.repository.loadPackaging(
      fulfillmentChannelSchema.parse(channel),
      positiveId.parse(warehouseId),
    );
  }
  saveSuite(body: unknown, actor: string) {
    return this.repository.saveSuite(
      saveBoxSuiteSchema.parse(body),
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  saveAssignment(body: unknown, actor: string) {
    return this.repository.saveAssignment(
      savePackagingAssignmentSchema.parse(body),
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  loadCharges(id: unknown) {
    return this.repository.readChargeConfiguration(positiveId.parse(id));
  }
  dropshipConfig(channelId: number | null) {
    return this.repository.dropshipConfig(channelId);
  }
  saveDropshipProgram(body: unknown, actor: string, channelId: number | null) {
    if (channelId !== null)
      throw new ShippingConfigurationError(
        "SHIPPING_CANONICAL_ROUTING_REQUIRED",
        "This channel uses versioned routing. Change its pricing program in Shipping Settings > Channel routing.",
      );
    return this.repository.saveDropshipProgram(
      saveDropshipProgramSchema.parse(body),
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  saveDropshipService(body: unknown, actor: string) {
    const input = saveFulfillmentServiceSchema.parse(body);
    if (input.channel !== "dropship")
      throw new ShippingConfigurationError(
        "SHIPPING_CHANNEL_FORBIDDEN",
        "This endpoint only configures Dropship.",
        403,
      );
    return this.repository.saveService(
      input,
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  saveCharges(id: unknown, body: unknown, actor: string) {
    return this.repository.saveCharges(
      positiveId.parse(id),
      saveProgramChargesSchema.parse(body),
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  history(key: unknown) {
    return this.repository.history(
      z
        .string()
        .regex(/^(suite|program-charges):[1-9][0-9]*$/)
        .parse(key),
    );
  }
}
