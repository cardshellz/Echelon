import { z } from "zod";
import { ShippingConfigurationError } from "../domain/configuration-error";
import {
  saveCatalogBoxSchema,
  saveChannelPackagingSchema,
  packagingPolicyOverviewSchema,
  type SaveCatalogBox,
  type SaveChannelPackaging,
  type ChannelPackagingPolicy,
  type PackagingPolicyOverview,
} from "@shared/shipping/packaging-policy";

export interface ChannelPackagingStore {
  overview(): Promise<PackagingPolicyOverview>;
  savePolicy(
    input: SaveChannelPackaging,
    actor: string,
    now: Date,
  ): Promise<ChannelPackagingPolicy>;
  saveBox(
    input: SaveCatalogBox,
    actor: string,
    now: Date,
  ): Promise<{ box: unknown }>;
}

export class ChannelPackagingService {
  constructor(
    private readonly store: ChannelPackagingStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly resolveDropshipChannel?: () => Promise<number | null>,
  ) {}
  async overview() {
    return packagingPolicyOverviewSchema.parse(await this.store.overview());
  }
  async dropshipOverview() {
    const data = await this.overview();
    const channelId = await this.dropshipChannel();
    const channels = data.channels.filter((c) => c.id === channelId);
    const ids = new Set(channels.map((c) => c.id));
    return {
      ...data,
      channels,
      policies: data.policies.filter((p) => ids.has(p.channelId)),
      pricing: data.pricing.filter((p) => ids.has(p.channelId)),
      warehouseAssignments: data.warehouseAssignments.filter((a) =>
        ids.has(a.channelId),
      ),
    };
  }
  async saveDropshipPolicy(body: unknown, actor: string) {
    const input = saveChannelPackagingSchema.parse(body);
    if (input.channelId !== (await this.dropshipChannel()))
      throw new ShippingConfigurationError(
        "SHIPPING_CHANNEL_FORBIDDEN",
        "This endpoint only configures the active Dropship OMS channel.",
        403,
      );
    return this.savePolicy(input, actor);
  }
  savePolicy(body: unknown, actor: string) {
    return this.store.savePolicy(
      saveChannelPackagingSchema.parse(body),
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  saveBox(body: unknown, actor: string) {
    return this.store.saveBox(
      saveCatalogBoxSchema.parse(body),
      z.string().min(1).parse(actor),
      this.clock(),
    );
  }
  private dropshipChannel(): Promise<number | null> {
    if (!this.resolveDropshipChannel)
      throw new ShippingConfigurationError(
        "SHIPPING_CHANNEL_BINDING_REQUIRED",
        "Dropship channel resolution is not configured.",
        503,
      );
    return this.resolveDropshipChannel();
  }
}
