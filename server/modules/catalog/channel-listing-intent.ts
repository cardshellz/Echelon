import type { PoolClient } from "pg";
import { z } from "zod";
/** Catalog owns its legacy exclusion mirror. Caller composes its own channel
 * intent and durable command in the same local transaction. */
export async function setCatalogEbayProductExclusion(client:PoolClient,productId:number,excluded:boolean):Promise<void>{
  z.number().int().positive().max(2147483647).parse(productId);z.boolean().parse(excluded);
  const updated=await client.query("UPDATE catalog.products SET ebay_listing_excluded=$2 WHERE id=$1",[productId,excluded]);
  if(updated.rowCount!==1)throw new Error("Catalog product not found while saving listing intent.");
}
