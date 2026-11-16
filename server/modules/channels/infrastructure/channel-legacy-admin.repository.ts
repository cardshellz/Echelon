import { eq } from "drizzle-orm";
import {
  channelAllocationRules,
  channelWarehouseAssignments,
} from "@shared/schema";
import type { db } from "../../../db";

type LegacyChannelTx = Pick<typeof db, "insert" | "update" | "delete">;

export function insertChannelWarehouseAssignmentInTx(
  transaction: LegacyChannelTx,
  values: typeof channelWarehouseAssignments.$inferInsert,
) {
  return transaction.insert(channelWarehouseAssignments).values(values).returning();
}

export function updateChannelWarehouseAssignmentInTx(
  transaction: LegacyChannelTx,
  id: number,
  updates: Partial<typeof channelWarehouseAssignments.$inferInsert>,
) {
  return transaction
    .update(channelWarehouseAssignments)
    .set(updates)
    .where(eq(channelWarehouseAssignments.id, id))
    .returning();
}

export function deleteChannelWarehouseAssignmentInTx(
  transaction: LegacyChannelTx,
  id: number,
) {
  return transaction
    .delete(channelWarehouseAssignments)
    .where(eq(channelWarehouseAssignments.id, id))
    .returning();
}

export function insertChannelAllocationRuleInTx(
  transaction: LegacyChannelTx,
  values: typeof channelAllocationRules.$inferInsert,
) {
  return transaction.insert(channelAllocationRules).values(values).returning();
}

export function updateChannelAllocationRuleInTx(
  transaction: LegacyChannelTx,
  id: number,
  updates: Partial<typeof channelAllocationRules.$inferInsert>,
) {
  return transaction
    .update(channelAllocationRules)
    .set(updates)
    .where(eq(channelAllocationRules.id, id))
    .returning();
}

export function deleteChannelAllocationRuleInTx(
  transaction: LegacyChannelTx,
  id: number,
) {
  return transaction
    .delete(channelAllocationRules)
    .where(eq(channelAllocationRules.id, id))
    .returning();
}
