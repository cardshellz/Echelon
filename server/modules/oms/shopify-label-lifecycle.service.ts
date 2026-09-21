import type { ChannelFulfillmentProviderClients } from "../channels/channel-fulfillment-provider-clients.service";
import { ChannelFulfillmentProviderError } from "../channels/channel-fulfillment-provider.error";
import type { FulfillmentPushExclusiveRunner } from "./fulfillment-push.service";
import type { ShopifyLabelLifecycleRepository } from "./shopify-label-lifecycle.repository";
import { shopifyOrderFulfillmentLockId } from "./shopify-fulfillment-lock";
import { planShopifyLabelCancellation, labelLifecycleConflict } from "./shopify-label-lifecycle.domain";
import { cancelExactShopifyLabelPackage, readShopifyLabelPackages } from "./shopify-label-lifecycle.client";

const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 60_000;
const VOID_BATCH_SIZE = 5;
export function createShopifyLabelLifecycleService(dependencies: {
  repository: ShopifyLabelLifecycleRepository; providerClients: ChannelFulfillmentProviderClients;
  runExclusive: FulfillmentPushExclusiveRunner; clock: { now(): Date };
  logger: { info(event: Readonly<Record<string, unknown>>): void; error(event: Readonly<Record<string, unknown>>): void };
}) {
  return {
    observe: (labelId: number) => dependencies.repository.observe(labelId, dependencies.clock.now()),
    async runDueBatch(): Promise<void> {
      for (const candidate of await dependencies.repository.due(dependencies.clock.now(), VOID_BATCH_SIZE)) {
        try {
          await dependencies.runExclusive(shopifyOrderFulfillmentLockId(candidate.omsOrderId), async () => {
            const work = await dependencies.repository.load(candidate.id);
            if (!work || work.processing) return; // Wait for an already claimed create, including a lost-response retry.
            let evidence: Readonly<Record<string, unknown>> = {};
            try {
              if (work.carrierPossession) labelLifecycleConflict('SHOPIFY_VOID_CARRIER_POSSESSION');
              if (!work.labelVoidProven) labelLifecycleConflict('SHOPIFY_VOID_EVIDENCE_UNPROVEN');
              const account = await dependencies.providerClients.shopify(work.channelId);
              if (account.channelId !== work.channelId) labelLifecycleConflict('FULFILLMENT_ACCOUNT_CHANNEL_MISMATCH');
              const before = await readShopifyLabelPackages(account.client, work.orderGid, work.trackingNumber, work.fulfillmentIds);
              const plan = planShopifyLabelCancellation({ ...work, packages: before, expectedFulfillmentIds: work.fulfillmentIds });
              evidence = { channelId: work.channelId, connectionId: account.connectionId, externalAccountId: account.externalAccountId,
                labelId: work.labelId, physicalShipmentId: work.physicalShipmentId, before, cancelledFulfillmentIds: plan };
              for (const fulfillmentId of plan) await cancelExactShopifyLabelPackage(account.client, fulfillmentId);
              const after = await readShopifyLabelPackages(account.client, work.orderGid, work.trackingNumber, work.fulfillmentIds);
              if (planShopifyLabelCancellation({ ...work, packages: after, expectedFulfillmentIds: [...new Set([...work.fulfillmentIds, ...plan])] }).length > 0) {
                throw new ChannelFulfillmentProviderError('SHOPIFY_VOID_READBACK_PENDING', 'Shopify still reports the voided fulfillment', 'transient');
              }
              evidence = { ...evidence, after };
            } catch (error) {
              const code = error instanceof ChannelFulfillmentProviderError ? error.code : 'SHOPIFY_VOID_ATTEMPT_FAILED';
              const review = (error instanceof ChannelFulfillmentProviderError && error.failureClass === 'permanent')
                || work.attemptCount + 1 >= MAX_ATTEMPTS;
              const now = dependencies.clock.now();
              await dependencies.repository.finish(work, { now, state: review ? 'review' : 'pending',
                nextAttemptAt: review ? null : new Date(now.getTime() + RETRY_DELAY_MS * 2 ** work.attemptCount), errorCode: code, evidence });
              dependencies.logger.error({ code, workId: work.id, review });
              return;
            }
            // A failed receipt commit is not another provider attempt. Leave it
            // pending; the next run proves remote state again before committing.
            await dependencies.repository.finish(work, { now: dependencies.clock.now(), state: 'complete', nextAttemptAt: null,
              errorCode: null, evidence });
            dependencies.logger.info({ code: 'SHOPIFY_LABEL_VOID_COMPLETED', workId: work.id, labelId: work.labelId });
          });
        } catch (error) {
          dependencies.logger.error({ code: 'SHOPIFY_LABEL_VOID_WORK_FAILED', workId: candidate.id,
            error: error instanceof Error ? error.message : 'Unknown label correction failure' });
        }
      }
    },
  };
}
export type ShopifyLabelLifecycleService = ReturnType<typeof createShopifyLabelLifecycleService>;
