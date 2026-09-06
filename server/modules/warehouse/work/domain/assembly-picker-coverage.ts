import type { AssemblyOwnership } from "@shared/warehouse-assembly-execution";
import type { AssemblyTask } from "@shared/warehouse-assembly-work";

export interface PickerCoverageLine {
  id: number; quantity: number; pickedQuantity: number | null;
  status: string; requiresShipping: number | null; onHold?: boolean | null;
}
/** Work custody is separate from physical picking. Never mutate item statuses.
 * Mixed ready/build or partially picked lines remain on the gun until supported
 * quantity-level custody exists. Excess output is not extra order coverage.
 */
export function isFullyHandedToAssembly(items: readonly PickerCoverageLine[], ownership: readonly AssemblyOwnership[], tasks: readonly AssemblyTask[]): boolean {
  let handedOff = false;
  const active = items.filter((item) => item.requiresShipping === 1 && !item.onHold && item.status !== "cancelled" && item.quantity > 0);
  if (active.length === 0) return false;
  for (const item of active) {
    if (item.status === "completed" && item.pickedQuantity === item.quantity) continue;
    if (!["pending", "in_progress"].includes(item.status) || (item.pickedQuantity ?? 0) !== 0) return false;
    const eligible = ownership.filter((row) => row.orderItemId === item.id && row.requestedQty === String(item.quantity));
    const covered = eligible.filter((row) => {
      const task = tasks.find((candidate) => candidate.claimId === row.claimId && candidate.claimOperationId === row.operationId
        && candidate.orderItemId === item.id && candidate.state !== "cancelled");
      return task && row.committedQty === String(item.quantity) && BigInt(task.outputQty) >= BigInt(item.quantity);
    });
    if (eligible.length !== 1 || covered.length !== 1) return false;
    handedOff = true;
  }
  return handedOff;
}
