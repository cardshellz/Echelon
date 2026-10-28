import type { db as applicationDb } from "../db";
import type { ChannelFulfillmentProviderClients } from "../modules/channels/channel-fulfillment-provider-clients.service";
import { createChannelFulfillmentAuthorityRepository } from "../modules/oms/channel-fulfillment-authority.repository";
import { createChannelFulfillmentProjector } from "../modules/oms/channel-fulfillment-projection.repository";
import { createFulfillmentPushService } from "../modules/oms/fulfillment-push.service";
import { PackageReconciliationService } from "../modules/oms/package-reconciliation.service";
import { createShipStationPackageReconciliationClient, type ShipStationPackageReconciliationClient } from "../modules/shipping/shipstation-package-reconciliation.client";

export function createPackageReconciliationService(dependencies: {
  database: Pick<typeof applicationDb,"execute"|"transaction">;
  channels: ChannelFulfillmentProviderClients;
  runExclusive<T>(key: number, work: () => Promise<T>): Promise<T | null>;
  clock?: { now(): Date };
  provider?: ShipStationPackageReconciliationClient;
  logger?: { info(event: Readonly<Record<string,unknown>>): void; error(event: Readonly<Record<string,unknown>>): void };
}) {
  const repository=createChannelFulfillmentAuthorityRepository(dependencies.database);
  const clock=dependencies.clock??{now:()=>new Date()};
  const logger=dependencies.logger??{info:(event:Readonly<Record<string,unknown>>)=>console.log(JSON.stringify(event)),
    error:(event:Readonly<Record<string,unknown>>)=>console.error(JSON.stringify(event))};
  return new PackageReconciliationService({
    repository:{loadPackageReconciliationSnapshot:ids=>repository.loadPackageReconciliationSnapshot!(ids),
      reconcilePackages:(command,now)=>repository.reconcilePackages!(command,now),
      completePackageReconciliation:(id,readbacks,now)=>repository.completePackageReconciliation!(id,readbacks,now),
      readPackageReconciliationChannelScopes:id=>repository.readPackageReconciliationChannelScopes!(id),
      loadPackageReconciliationReplay:key=>repository.loadPackageReconciliationReplay!(key),
      findPendingPackageReconciliations:(limit,now)=>repository.findPendingPackageReconciliations!(limit,now),
      markPackageReconciliationProjected:(id,physicalId,now)=>repository.markPackageReconciliationProjected!(id,physicalId,now),
      recordPackageReconciliationFailure:(key,code,now)=>repository.recordPackageReconciliationFailure!(key,code,now)},
    provider:dependencies.provider??{load:snapshot=>createShipStationPackageReconciliationClient({apiKey:process.env.SHIPSTATION_API_KEY??"",
      apiSecret:process.env.SHIPSTATION_API_SECRET??"",clock:()=>clock.now()}).load(snapshot)},
    channels:dependencies.channels,projector:createChannelFulfillmentProjector(dependencies.database,()=>clock.now()),clock,logger,
    runExclusive:dependencies.runExclusive,
    recordTrackingIntent:input=>repository.recordPackageReconciliationTrackingIntent!(input,clock.now()),
    updateTracking:async(client,fulfillmentId,tracking,notifyCustomer)=>{
      const push=createFulfillmentPushService(dependencies.database,null,{providerClients:dependencies.channels,runExclusive:dependencies.runExclusive});
      push.setShopifyClient(client);
      await push.updateShopifyFulfillmentTracking(fulfillmentId,tracking,{notifyCustomer});
    },
  });
}
