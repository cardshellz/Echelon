import { db } from "../server/db";
import { channelConnections } from "../shared/schema";
async function read() {
  const rows = await db.select().from(channelConnections);
  console.log(rows.map(r => r.provider));
  process.exit();
}
read();
