/**
 * Scheduled Shopify product-mapping reconciliation.
 *
 * The reconciler itself already existed — it verifies every local mapping
 * against the live Shopify catalog and reports `remote_product_missing`,
 * `duplicate_local_owner`, `shipping_group_conflict` and friends. It was only
 * ever reachable as a manual admin endpoint, so nothing ran it, and drift
 * accumulated unseen: 23 mappings pointing at deleted listings and 81 listings
 * with more than one local owner by the time anyone looked.
 *
 * Webhooks keep identity current going forward; this is the backstop for
 * whatever they miss — a webhook that never fired, a bulk edit, a restore.
 *
 * Retirement is deliberately conservative: the domain decides per item via
 * `canRetireDeadMapping`, and even then the job only acts when
 * SHOPIFY_MAPPING_AUTO_RETIRE=1. Otherwise it reports and leaves the existing
 * reviewed path to a human. Duplicate ownership is never auto-resolved —
 * choosing which row survives is a judgement call.
 */
import { createShopifyProductMappingReconciliationService } from "../modules/catalog/shopify-product-mapping-reconciliation.service";
import { channelsStorage } from "../modules/channels";

const ACTOR = "scheduled-mapping-reconciler";

export interface MappingReconciliationRunResult {
  channelId: number | null;
  scanned: number;
  issues: number;
  retired: number;
  retireFailures: number;
  skippedAutoRetire: number;
}

export async function runShopifyMappingReconciliation(): Promise<MappingReconciliationRunResult> {
  const empty: MappingReconciliationRunResult = {
    channelId: null, scanned: 0, issues: 0, retired: 0, retireFailures: 0, skippedAutoRetire: 0,
  };

  const channels = await channelsStorage.getAllChannels().catch(() => []);
  const shopify = channels.find((c: any) => c.provider === "shopify" && c.isDefault === 1)
    ?? channels.find((c: any) => c.provider === "shopify");
  if (!shopify) {
    console.warn("[mapping-reconciler] no Shopify channel configured — skipping");
    return empty;
  }

  const service = createShopifyProductMappingReconciliationService();
  const report = await service.scan(shopify.id);
  const autoRetire = process.env.SHOPIFY_MAPPING_AUTO_RETIRE === "1";

  const retirable = report.items.filter((item) => item.canRetireDeadMapping);
  let retired = 0;
  let retireFailures = 0;

  if (autoRetire) {
    for (const item of retirable) {
      try {
        await service.retireStaleMapping({
          channelId: shopify.id,
          productId: item.productId,
          expectedProductId: item.shopifyProductId as string,
          expectedFingerprint: item.mappingFingerprint,
          expectedShopDomain: report.channel.shopDomain,
          actor: ACTOR,
        });
        retired++;
      } catch (error: unknown) {
        // A fingerprint mismatch means the row changed under us — the next run
        // re-evaluates it against fresh evidence rather than forcing the write.
        retireFailures++;
        console.warn(JSON.stringify({
          event: "shopify_mapping_retire_failed",
          productId: item.productId,
          shopifyProductId: item.shopifyProductId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  const result: MappingReconciliationRunResult = {
    channelId: shopify.id,
    scanned: report.summary.localProductCount,
    issues: report.summary.issueProductCount,
    retired,
    retireFailures,
    skippedAutoRetire: autoRetire ? 0 : retirable.length,
  };

  console.log(JSON.stringify({
    event: "shopify_mapping_reconciliation",
    ...result,
    issueCounts: report.summary.issueCounts,
    autoRetireEnabled: autoRetire,
  }));

  return result;
}
