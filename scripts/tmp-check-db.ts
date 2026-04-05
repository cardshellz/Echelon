import { db, sql } from "../server/storage/base";
import "dotenv/config";

async function run() {
  try {
    const wms = await db.execute(sql`SELECT COUNT(*) as count FROM wms.orders WHERE warehouse_status IN ('ready', 'in_progress')`);
    console.log('WMS Picks:', wms.rows);
  } catch (e: any) {
    console.log("WMS orders threw error:", e.message);
  }

  try {
    const pub = await db.execute(sql`SELECT COUNT(*) as count FROM public.orders WHERE warehouse_status IN ('ready', 'in_progress')`);
    console.log('Public Picks:', pub.rows);
  } catch (e: any) {
    console.log("Public orders threw error:", e.message);
  }

  process.exit(0);
}
run();
