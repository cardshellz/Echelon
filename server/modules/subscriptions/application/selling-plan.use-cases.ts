import { db } from "../../../db";
import * as domain from "../domain/subscription.domain";
import * as storage from "../infrastructure/subscription.repository";
import * as shopifyAdapter from "../infrastructure/shopify.adapter";

export async function createSellingPlanGroupUseCase(membershipProductGid: string) {
  const existingPlans = await storage.getAllPlans();
  
  // Extract pure logic out to Domain
  const resolvedConfigs = domain.mapPlansToSellingPlanConfigs(existingPlans);
  const sellingPlansToCreate = domain.buildShopifySellingPlanCreatePayload(resolvedConfigs);

  // Network call via adapter (Infrastructure)
  const group = await shopifyAdapter.createSellingPlanGroupGraphql(
    membershipProductGid,
    sellingPlansToCreate
  );

  const sellingPlansGids = group.sellingPlans.edges.map((e: any) => ({
    gid: e.node.id,
    name: e.node.name,
  }));

  // Map and Persist (Transactionally)
  try {
    await db.transaction(async (tx) => {
      for (const sp of sellingPlansGids) {
        const matchingConfig = resolvedConfigs.find(c => c.name === sp.name);
        if (matchingConfig) {
          const numericId = parseInt(sp.gid.split("/").pop() || "0");
          
          await storage.updatePlanSellingPlan(matchingConfig.planId, sp.gid, numericId, tx);
          await storage.upsertSellingPlanMap({
            shopify_selling_plan_gid: sp.gid,
            shopify_selling_plan_group_gid: group.id,
            plan_id: matchingConfig.planId,
            plan_name: matchingConfig.name,
            billing_interval: matchingConfig.billingInterval === "MONTH" ? "month" : "year",
            price_cents: matchingConfig.priceCents,
          }, tx);
        }
      }
    });
    console.log(`[SellingPlans UseCase] Persisted group ${group.id}`);
  } catch (e) {
    console.error(`[SellingPlans UseCase] Failed to persist group ${group.id}`, e);
    throw e;
  }

  return {
    sellingPlanGroupGid: group.id,
    sellingPlans: sellingPlansGids,
  };
}

export async function listSellingPlanGroupsUseCase() {
  return await shopifyAdapter.fetchSellingPlanGroupsGraphql();
}
