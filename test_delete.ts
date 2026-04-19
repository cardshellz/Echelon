import { db } from "./server/db/index";
import { products } from "@shared/schema";
import { eq } from "drizzle-orm";

async function run() {
  try {
    const res = await db.delete(products).where(eq(products.id, 102)).returning();
    console.log("Success", res);
    process.exit(0);
  } catch (err: any) {
    console.error("DB Error:", err.message);
    process.exit(1);
  }
}
run();
