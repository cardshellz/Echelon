import { pool } from "../../../db";
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    for (const sp of sellingPlansGids) {
      const matchingConfig = resolvedConfigs.find(c => c.name === sp.name);
      if (matchingConfig) {
        const numericId = parseInt(sp.gid.split("/").pop() || "0");

        // We replace direct storage calls with transactional client calls
        // Wait, the storage methods do not currently accept a db client!
        // We will invoke the existing storage methods which might use their own pool.
        // Wait, rule 7 says "Never do multi-step writes without transaction... Use transactions!".
        // I need to use the `db` transaction context natively. 
        // For now, I will use `pool.query` natively inside the orchestrator for this batch write
        // or ensure storage has transactional support.
        
        // I'll call storage updatePlanSellingPlan and upsertSellingPlanMap using standalone queries 
        // if they don't support `client`, or better: pass `client` into storage!
        await storage.updatePlanSellingPlan(matchingConfig.planId, sp.gid, numericId, client);
        await storage.upsertSellingPlanMap({
          shopify_selling_plan_gid: sp.gid,
          shopify_selling_plan_group_gid: group.id,
          plan_id: matchingConfig.planId,
          plan_name: matchingConfig.name,
          billing_interval: matchingConfig.billingInterval === "MONTH" ? "month" : "year",
          price_cents: matchingConfig.priceCents,
        }, client);
      }
    }

    await client.query('COMMIT');
    console.log(`[SellingPlans UseCase] Persisted group ${group.id}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return {
    sellingPlanGroupGid: group.id,
    sellingPlans: sellingPlansGids,
  };
}

export async function listSellingPlanGroupsUseCase() {
  return await shopifyAdapter.fetchSellingPlanGroupsGraphql();
}
