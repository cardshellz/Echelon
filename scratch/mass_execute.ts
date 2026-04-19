import { db } from "../server/db";
import { replenTasks } from "@shared/schema";
import { ReplenishmentUseCases } from "../server/modules/inventory/application/replenishment.use-cases";
import { inventoryMethods } from "../server/modules/inventory/infrastructure/inventory.repository";
import { cycleCountMethods } from "../server/modules/inventory/infrastructure/cycle-count.repository";
import { replenishmentMethods } from "../server/modules/inventory/infrastructure/replenishment.repository";
import { InventoryUseCases } from "../server/modules/inventory/application/inventory.use-cases";
import { eq, and } from "drizzle-orm";

async function massExecute() {
  console.log("Starting Mass Task Execution...");
  
  // Construct real inventoryCore
  const storage = { ...inventoryMethods, ...cycleCountMethods, ...replenishmentMethods };
  const mockLotService = { withTx: () => ({ recordAdjustment: async () => {}, adjustLots: async () => {} }), processTaskAdjustments: async () => {} };
  const mockCogsService = { withTx: () => ({ applyCostBasis: async () => {} }) };
  const invCore = new InventoryUseCases(db as any, storage as any, mockLotService as any, mockCogsService as any);
  
  // Construct real replenishmentService
  const replenApi = new ReplenishmentUseCases(db as any, invCore);

  const pendingTasks = await db.select().from(replenTasks)
    .where(and(eq(replenTasks.status, "pending"), eq(replenTasks.executionMode, "inline")));
  
  console.log("Found " + pendingTasks.length + " pending inline tasks...");
  
  let executed = 0;
  
  for (const task of pendingTasks) {
    try {
      console.log("Executing Task #" + task.id + "...");
      await replenApi.executeTask(task.id, "system:mass_eval");
      executed++;
    } catch (err: any) {
      console.warn("Failed on task " + task.id + ": " + err.message);
    }
  }

  console.log("");
  console.log("Mass Execution Complete.");
  console.log("Executed " + executed + " tasks.");
  process.exit(0);
}

massExecute().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
