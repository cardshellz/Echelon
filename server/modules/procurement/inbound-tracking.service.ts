import { z } from "zod";
import { inboundTrackingViewSchema, saveInboundTrackingSchema, refreshInboundTrackingSchema, type InboundTrackingView, type InboundTrackingHistory } from "@shared/procurement/inbound-tracking";
import { InboundTrackingError, InboundTrackingProviderError } from "./inbound-tracking.domain";
import type { InboundTrackingProviders } from "./inbound-tracking.providers";
import type { InboundTrackingCommandResult, InboundTrackingRepository } from "./inbound-tracking.repository";
const identifier = z.number().int().positive().max(2_147_483_647);
const actor = z.string().trim().min(1).max(500);
export interface InboundTrackingLogger { info(event: Record<string, unknown>): void; error(event: Record<string, unknown>): void; }
export class InboundTrackingService {
  constructor(private readonly repository: InboundTrackingRepository, private readonly providers: InboundTrackingProviders, private readonly pollingEnabled: boolean, private readonly now: () => Date, private readonly logger: InboundTrackingLogger) {}
  async read(shipmentId: number): Promise<InboundTrackingView> {
    return inboundTrackingViewSchema.parse({ pollingEnabled: this.pollingEnabled, providers: [
      { provider: "searates", configured: this.providers.searates.configured(), setup: "Requires a SeaRates Container Tracking subscription and SEARATES_TRACKING_API_KEY. Vessel position uses the account's AIS entitlement." },
      { provider: "shipstation", configured: this.providers.shipstation.configured(), setup: "Uses SHIPSTATION_V2_API_KEY. Tracking access and the named carrier must be enabled on that account." },
    ], references: await this.repository.read(identifier.parse(shipmentId)) });
  }
  async history(shipmentId: number, referenceId: number, beforeId: unknown): Promise<InboundTrackingHistory> {
    const cursor = beforeId == null ? null : z.string().regex(/^[1-9]\d{0,18}$/).refine((value) => BigInt(value) <= BigInt("9223372036854775807")).parse(beforeId);
    return this.repository.history(identifier.parse(shipmentId), identifier.parse(referenceId), cursor);
  }
  async save(shipmentId: number, input: unknown, actorId: unknown): Promise<InboundTrackingCommandResult> {
    return this.repository.save(identifier.parse(shipmentId), saveInboundTrackingSchema.parse(input), actor.parse(actorId), this.now());
  }
  async refresh(shipmentId: number, referenceId: number, input: unknown, actorId: unknown): Promise<InboundTrackingCommandResult> {
    const command = refreshInboundTrackingSchema.parse(input);
    if (!this.pollingEnabled) throw new InboundTrackingError("TRACKING_POLLING_DISABLED", "Automatic tracking refresh is disabled in deployment settings.", 409);
    const references = await this.repository.read(identifier.parse(shipmentId));
    const reference = references.find((candidate) => candidate.id === identifier.parse(referenceId));
    if (!reference) throw new InboundTrackingError("TRACKING_REFERENCE_NOT_FOUND", "Tracking reference not found on this shipment.", 404);
    if (!this.providers[reference.config.identity.provider].configured()) throw new InboundTrackingError("TRACKING_PROVIDER_NOT_CONFIGURED", "Configure this tracking provider's credentials before refreshing.", 409);
    return this.repository.requestRefresh(shipmentId, referenceId, command.requestKey, actor.parse(actorId), this.now());
  }
  async poll(limit = 10): Promise<{ claimed: number; failed: number }> {
    z.number().int().min(1).max(20).parse(limit);
    if (!this.pollingEnabled) return { claimed: 0, failed: 0 };
    const available = (["searates", "shipstation"] as const).filter((provider) => this.providers[provider].configured());
    let claimed = 0; let failed = 0;
    for (let index = 0; index < limit; index++) {
      const claim = await this.repository.claim(this.now(), available);
      if (!claim) break;
      claimed++;
      let result: Parameters<InboundTrackingRepository["complete"]>[2];
      try { result = { snapshot: await this.providers[claim.config.identity.provider].fetch(claim.config) }; }
      catch (error) {
        const failure = error instanceof InboundTrackingProviderError ? error : new InboundTrackingProviderError("TRACKING_PROVIDER_FAILURE", "Tracking provider failed unexpectedly. Retry or review the provider configuration.", true);
        result = { failure: { code: failure.code, message: failure.message, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs } };
        failed++;
      }
      const outcome = await this.repository.complete(claim, this.now(), result);
      this.logger.info({ event: "procurement.inbound_tracking.poll_completed", referenceId: claim.referenceId, shipmentId: claim.shipmentId, claimVersion: claim.version, outcome });
    }
    return { claimed, failed };
  }
}
