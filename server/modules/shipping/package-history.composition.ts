import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ChannelIdentityService } from "../channels/channel-identity.service";
import { ShopifyCustomerReturnSnapshotReader } from "../returns/infrastructure/customer-return-shopify-snapshot.reader";
import {
  createPackageHistoryShipStationRequester,
  createPackageHistorySource,
} from "./package-history.source";
import { PostgresPackageHistoryStore } from "./package-history.repository";
import { PackageHistoryWorker } from "./package-history.worker";
import type { PackageHistoryReport } from "./package-history.ports";

export function createPackageHistoryWorker(
  pool: Pool,
  db: ConstructorParameters<typeof ChannelIdentityService>[0],
  report: (event: PackageHistoryReport) => void,
  actor?: string,
): PackageHistoryWorker | null {
  const apiKey = process.env.SHIPSTATION_API_KEY,
    apiSecret = process.env.SHIPSTATION_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const now = () => new Date(),
    identity = new ChannelIdentityService(db);
  const source = createPackageHistorySource({
    pool,
    now,
    shopify: new ShopifyCustomerReturnSnapshotReader({
      resolveConnection: (id) => identity.shopifyConnection(id),
      request: fetch,
      now,
    }),
    shipstation: createPackageHistoryShipStationRequester({
      apiKey,
      apiSecret,
    }),
  });
  return new PackageHistoryWorker({
    source,
    store: new PostgresPackageHistoryStore(pool, now, actor),
    now,
    newId: randomUUID,
    report,
  });
}

/** Normal source events enqueue captures; historical seeding is explicit. */
export function startPackageHistoryScheduler(
  worker: Pick<PackageHistoryWorker, "run">,
  reportFailure: () => void,
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await worker.run();
    } catch {
      reportFailure();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), 5_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
