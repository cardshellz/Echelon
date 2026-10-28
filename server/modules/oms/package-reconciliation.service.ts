import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { knownCarrierCode } from "@shared/utils/carrier-identity";
import type { ChannelFulfillmentProviderClients } from "../channels/channel-fulfillment-provider-clients.service";
import type { ShipStationPackageReconciliationClient } from "../shipping/shipstation-package-reconciliation.client";
import type { ChannelFulfillmentAuthorityRepository } from "./channel-fulfillment-authority.repository";
import type { ChannelFulfillmentProjector } from "./channel-fulfillment-projection.repository";
import { packageReconciliationInputFromProof, PackageReconciliationError, type PackageReconciliationCommand,
  type PackageReconciliationResult, type PackageChannelReadback, type PackageReconciliationChannelScope } from "./package-reconciliation.repository";
import { planPackageReconciliation } from "./package-reconciliation.domain";
import { readShopifyLabelPackages } from "./shopify-label-lifecycle.client";
import { shopifyOrderFulfillmentLockId } from "./shopify-fulfillment-lock";
import type { ShopifyAdminGraphQLClient } from "../shopify/admin-gql-client";
import type { ShopifyLabelPackage } from "./shopify-label-lifecycle.domain";

const requestSchema = z.object({ sourceItemIds: z.array(z.number().int().positive().safe()).min(1).max(500),
  correctedPreviousLabelIds: z.array(z.number().int().positive().safe()).max(100).default([]),
  actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500), commandKey: z.string().trim().min(1).max(200),
}).strict();
export type PackageReconciliationRequest = z.input<typeof requestSchema>;
type Repository = Required<Pick<ChannelFulfillmentAuthorityRepository, "loadPackageReconciliationSnapshot" | "reconcilePackages" |
  "completePackageReconciliation" | "readPackageReconciliationChannelScopes" | "loadPackageReconciliationReplay" |
  "findPendingPackageReconciliations" | "recordPackageReconciliationFailure" | "markPackageReconciliationProjected">>;
const orderGid = (value: string) => value.startsWith("gid://shopify/Order/") ? value : `gid://shopify/Order/${value}`;
const lineGid = (value: string) => value.startsWith("gid://shopify/LineItem/") ? value : `gid://shopify/LineItem/${value}`;
function exactItems(scope: PackageReconciliationChannelScope, pkg: ShopifyLabelPackage): boolean {
  const expected = scope.items.map(item => ({ lineId: lineGid(item.channelOrderLineId), quantity: item.quantity })).sort((a, b) => a.lineId.localeCompare(b.lineId));
  const actual = pkg.items.map(item => ({ lineId: item.lineId, quantity: item.quantity })).sort((a, b) => a.lineId.localeCompare(b.lineId));
  return canonicalJson(expected) === canonicalJson(actual);
}
async function allPackages(client: ShopifyAdminGraphQLClient, orderId: string): Promise<readonly ShopifyLabelPackage[]> {
  const value = await client.request<{ order: null | { id: string; fulfillmentsCount: { count: number }; fulfillments: { id: string }[] } }>(
    `query reconciliationFulfillmentHandles($id: ID!) { order(id: $id) { id fulfillmentsCount { count } fulfillments(first: 100) { id } } }`, { id: orderId });
  if (!value.order || value.order.id !== orderId || !Array.isArray(value.order.fulfillments)
    || value.order.fulfillmentsCount?.count !== value.order.fulfillments.length) throw new PackageReconciliationError("CHANNEL_READ_INCOMPLETE", "The originating Shopify order fulfillment read is incomplete");
  return readShopifyLabelPackages(client, orderId, "", value.order.fulfillments.map(item => item.id));
}

/** Operator application owner. Remote reads and optional tracking-only updates
 * happen outside allocation transactions, under the existing Shopify order lock.
 * A crash after allocation commit resumes from its durable receipt and held
 * commands; it never creates another fulfillment or deducts inventory. */
export class PackageReconciliationService {
  constructor(private readonly dependencies: {
    repository: Repository;
    provider: ShipStationPackageReconciliationClient;
    channels: ChannelFulfillmentProviderClients;
    projector: ChannelFulfillmentProjector;
    updateTracking(client: ShopifyAdminGraphQLClient, fulfillmentId: string, tracking: { number: string; company: string }, notifyCustomer: false): Promise<void>;
    recordTrackingIntent(input: { commandId: number; omsOrderId: number; actor: string; before: ShopifyLabelPackage; trackingNumber: string }): Promise<void>;
    runExclusive<T>(key: number, work: () => Promise<T>): Promise<T | null>;
    clock: { now(): Date };
    logger: { info(event: Readonly<Record<string, unknown>>): void; error(event: Readonly<Record<string, unknown>>): void };
  }) {}

  async preview(rawRequest: PackageReconciliationRequest) {
    const request = requestSchema.parse(rawRequest);
    const snapshot = await this.dependencies.repository.loadPackageReconciliationSnapshot(request.sourceItemIds);
    const proof = await this.dependencies.provider.load(snapshot);
    const correction = request.correctedPreviousLabelIds.length ? { kind: "confirmed_package_contents_correction" as const,
      actorId: request.actor, reason: request.reason, previousLabelIds: request.correctedPreviousLabelIds } : null;
    const input = packageReconciliationInputFromProof(snapshot, proof, correction);
    const plan = planPackageReconciliation(input);
    return { request, snapshotHash: snapshot.hash, sourceItemIds: snapshot.sourceIds, input, plan, providerProof: proof };
  }

  async execute(rawRequest: PackageReconciliationRequest, expectedPlanHash?: string) {
    try { return await this.executeAuthorized(rawRequest, expectedPlanHash); }
    catch (error) {
      const code = error instanceof PackageReconciliationError ? error.code : "PACKAGE_RECONCILIATION_FAILED";
      this.dependencies.logger.error({ code, commandKey: rawRequest.commandKey, sourceItemIds: rawRequest.sourceItemIds });
      try { await this.dependencies.repository.recordPackageReconciliationFailure(rawRequest.commandKey, code, this.dependencies.clock.now()); }
      catch { this.dependencies.logger.error({ code: "PACKAGE_RECONCILIATION_RETRY_RECORD_FAILED", commandKey: rawRequest.commandKey }); }
      throw error;
    }
  }

  async resumeDue(limit = 5): Promise<Readonly<{ scanned: number; completed: number; failed: number }>> {
    const commands = await this.dependencies.repository.findPendingPackageReconciliations(limit, this.dependencies.clock.now());
    let completed = 0, failed = 0;
    for (const command of commands) {
      try { await this.execute({ sourceItemIds: command.sourceItemIds, correctedPreviousLabelIds: command.correction?.previousLabelIds ?? [],
        actor: command.actor, reason: command.reason, commandKey: command.commandKey }); completed++; }
      catch { failed++; }
    }
    return { scanned: commands.length, completed, failed };
  }

  private async executeAuthorized(rawRequest: PackageReconciliationRequest, expectedPlanHash?: string) {
    const request = requestSchema.parse(rawRequest);
    const existing = await this.dependencies.repository.loadPackageReconciliationReplay(request.commandKey);
    let result: PackageReconciliationResult;
    if (existing) {
      const previous = existing.command;
      if (previous.actor !== request.actor || previous.reason !== request.reason
        || (expectedPlanHash !== undefined && expectedPlanHash !== previous.expectedPlanHash)
        || canonicalJson([...previous.sourceItemIds].sort((a, b) => a - b)) !== canonicalJson([...request.sourceItemIds].sort((a, b) => a - b))
        || canonicalJson([...(previous.correction?.previousLabelIds ?? [])].sort((a, b) => a - b)) !== canonicalJson([...request.correctedPreviousLabelIds].sort((a, b) => a - b))) {
        throw new PackageReconciliationError("RECONCILIATION_REPLAY_CONFLICT", "The command key belongs to different package correction intent");
      }
      result = await this.dependencies.repository.reconcilePackages(previous, this.dependencies.clock.now());
      if (existing.state === 'complete') {
        if (!existing.readbacks) throw new PackageReconciliationError('RECEIPT_READBACK_MISSING', 'Completed reconciliation lacks its immutable channel readback');
        // A completed command replays its receipt. Re-projecting its old parcels
        // after a later relabel could reinterpret history or fail on newer state.
        return { ...result, completion: { replayed: true, resolvedReviewIds: [] as readonly number[] }, readbacks: existing.readbacks };
      }
    } else {
      const preview = await this.preview(request);
      if (preview.plan.outcome !== "ready" && preview.plan.outcome !== "unchanged") {
        throw new PackageReconciliationError("PACKAGE_RECONCILIATION_REVIEW_REQUIRED", "The package graph cannot be safely reconciled", { reason: 'reason' in preview.plan ? preview.plan.reason : 'unavailable' });
      }
      if (expectedPlanHash && preview.plan.evidenceHash !== expectedPlanHash) throw new PackageReconciliationError("PACKAGE_PLAN_CHANGED", "Provider or package evidence changed after preview");
      const command: PackageReconciliationCommand = { commandKey: request.commandKey, expectedSnapshotHash: preview.snapshotHash,
        expectedPlanHash: preview.plan.evidenceHash, sourceItemIds: request.sourceItemIds, actor: request.actor, reason: request.reason,
        mode: "adopt_existing", correction: preview.input.correction, providerProof: preview.providerProof };
      result = await this.dependencies.repository.reconcilePackages(command, this.dependencies.clock.now());
    }
    for (const physicalShipmentId of result.physicalShipmentIds) {
      await this.dependencies.projector.projectPhysicalShipment(physicalShipmentId);
      await this.dependencies.repository.markPackageReconciliationProjected(result.commandId,physicalShipmentId,this.dependencies.clock.now());
    }
    const scopes = await this.dependencies.repository.readPackageReconciliationChannelScopes(result.commandId);
    const orderIds = [...new Set(scopes.map(scope => scope.omsOrderId))].sort((a, b) => a - b);
    const readbacks: PackageChannelReadback[] = [];
    for (const omsOrderId of orderIds) {
      const orderScopes = scopes.filter(scope => scope.omsOrderId === omsOrderId);
      const completed = await this.dependencies.runExclusive(shopifyOrderFulfillmentLockId(omsOrderId), async () => {
        const first = orderScopes[0];
        if (first.channelProvider !== "shopify" || orderScopes.some(scope => scope.channelId !== first.channelId || scope.externalOrderId !== first.externalOrderId)) {
          throw new PackageReconciliationError("CHANNEL_SCOPE_UNSUPPORTED", "Historical channel adoption requires one exact originating Shopify account and order");
        }
        const account = await this.dependencies.channels.shopify(first.channelId);
        if (account.channelId !== first.channelId) throw new PackageReconciliationError("CHANNEL_SCOPE_CONFLICT", "Provider client belongs to a different originating channel");
        const nativeOrderId = orderGid(first.externalOrderId);
        let packages = await allPackages(account.client, nativeOrderId);
        const orderReadbacks: PackageChannelReadback[] = [];
        for (const scope of orderScopes) {
          let matches = packages.filter(pkg => pkg.status === "SUCCESS" && pkg.trackingNumbers.length === 1 && pkg.trackingNumbers[0] === scope.trackingNumber && exactItems(scope, pkg));
          if (matches.length === 0) {
            const candidates = packages.filter(pkg => pkg.status === "SUCCESS" && pkg.trackingNumbers.length === 1
              && scope.allowedPreviousTrackingNumbers.includes(pkg.trackingNumbers[0]) && exactItems(scope, pkg));
            if (candidates.length !== 1) throw new PackageReconciliationError("CHANNEL_PACKAGE_MAPPING_UNPROVEN", "No unique earlier fulfillment matches the complete current package's exact order portion");
            const candidate = candidates[0];
            // A historical fulfillment cannot be assigned to two current parcels.
            if (orderScopes.some(other => other.physicalShipmentId !== scope.physicalShipmentId && candidate.trackingNumbers.includes(other.trackingNumber))) {
              throw new PackageReconciliationError("CHANNEL_PACKAGE_MAPPING_UNPROVEN", "The candidate fulfillment belongs to another current parcel");
            }
            const company = knownCarrierCode(scope.carrier);
            if (!company) throw new PackageReconciliationError("CARRIER_IDENTITY_MISSING", "The verified parcel carrier cannot be mapped for channel tracking");
            await this.dependencies.recordTrackingIntent({ commandId: result.commandId, omsOrderId, actor: request.actor, before: candidate, trackingNumber: scope.trackingNumber });
            await this.dependencies.updateTracking(account.client, candidate.id, { number: scope.trackingNumber, company }, false);
            packages = await allPackages(account.client, nativeOrderId);
            matches = packages.filter(pkg => pkg.id === candidate.id && pkg.status === "SUCCESS" && pkg.trackingNumbers.length === 1
              && pkg.trackingNumbers[0] === scope.trackingNumber && exactItems(scope, pkg));
          }
          if (matches.length !== 1) throw new PackageReconciliationError("CHANNEL_PACKAGE_MAPPING_UNPROVEN", "The current package has no unique exact successful channel readback");
          orderReadbacks.push({ physicalShipmentId: scope.physicalShipmentId, omsOrderId, channelId: scope.channelId,
            fulfillmentId: matches[0].id, trackingNumber: scope.trackingNumber, items: [...scope.items], observedAt: this.dependencies.clock.now().toISOString() });
        }
        return orderReadbacks;
      });
      if (!completed) throw new PackageReconciliationError("CHANNEL_ORDER_BUSY", "Another fulfillment operation owns the order; retry the same reconciliation command");
      readbacks.push(...completed);
    }
    const completion = await this.dependencies.repository.completePackageReconciliation(result.commandId, readbacks, this.dependencies.clock.now());
    this.dependencies.logger.info({ code: "PACKAGE_RECONCILIATION_COMPLETE", commandId: result.commandId,
      physicalShipmentIds: result.physicalShipmentIds, orderIds: result.omsOrderIds, resolvedReviewIds: completion.resolvedReviewIds,
      replayed: result.replayed, inventoryMutated: false, notifyCustomer: false });
    return { ...result, completion, readbacks };
  }
}
