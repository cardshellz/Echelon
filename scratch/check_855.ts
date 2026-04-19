import { db } from "../server/db";
import { replenTasks } from "@shared/schema";
import { eq } from "drizzle-orm";

async function run() {
  const [task] = await db.select().from(replenTasks).where(eq(replenTasks.id, 855)).limit(1);
  console.log(JSON.stringify(task, null, 2));
  process.exit(0);
}
run();
