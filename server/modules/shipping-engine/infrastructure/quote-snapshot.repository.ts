import { shippingQuoteSnapshots } from "@shared/schema";
import { db } from "../../../db";

export async function insertCheckoutQuoteSnapshot(
  values: typeof shippingQuoteSnapshots.$inferInsert,
  database: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await database.insert(shippingQuoteSnapshots).values(values);
}
