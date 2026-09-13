import {
  INVENTORY_RUNTIME_AUTHORITY_READOUT_CONTRACT_VERSION,
  inventoryRuntimeAuthorityReadoutSchema,
  liveAllocatorForAuthority,
  type InventoryRuntimeAuthorityReadout,
} from "@shared/types/inventory-runtime-authority";

/** One persisted singleton row as handed over by the store. Every field is untrusted until parsed. */
export interface InventoryRuntimeAuthorityRecord {
  authority: unknown;
  revision: unknown;
  activationRunId: unknown;
  changedBy: unknown;
  changeReason: unknown;
  changedAt: unknown;
}

export type InventoryRuntimeAuthorityReadoutErrorCode =
  /** The singleton row is missing or duplicated. */
  | "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE"
  /** The singleton row exists but violates the readout contract. */
  | "INVENTORY_RUNTIME_AUTHORITY_INVALID"
  /** The store could not read the singleton at all. */
  | "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED";

export type InventoryRuntimeAuthorityReadoutErrorClassification = "transient" | "permanent";

export class InventoryRuntimeAuthorityReadoutError extends Error {
  constructor(
    readonly status: number,
    readonly code: InventoryRuntimeAuthorityReadoutErrorCode,
    message: string,
    readonly classification: InventoryRuntimeAuthorityReadoutErrorClassification,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InventoryRuntimeAuthorityReadoutError";
  }
}

/**
 * Builds the operator-facing readout from the persisted singleton. Pure: no
 * clock, no defaults. Anything other than exactly one contract-valid row is an
 * error, because a wrong "which allocator is live" answer misdirects operators
 * editing allocation rules that may or may not be in effect.
 */
export function buildInventoryRuntimeAuthorityReadout(
  records: readonly InventoryRuntimeAuthorityRecord[],
): InventoryRuntimeAuthorityReadout {
  if (records.length !== 1) {
    throw new InventoryRuntimeAuthorityReadoutError(
      503,
      "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE",
      "The inventory runtime authority singleton is missing or duplicated.",
      "permanent",
      { rowCount: records.length },
    );
  }
  const [record] = records;
  const authority = record.authority;
  const candidate = {
    contractVersion: INVENTORY_RUNTIME_AUTHORITY_READOUT_CONTRACT_VERSION,
    authority,
    liveAllocator: authority === "legacy" || authority === "canonical"
      ? liveAllocatorForAuthority(authority)
      : undefined,
    revision: record.revision,
    activationRunId: record.activationRunId,
    changedBy: record.changedBy,
    changeReason: record.changeReason,
    changedAt: record.changedAt,
  };
  const parsed = inventoryRuntimeAuthorityReadoutSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InventoryRuntimeAuthorityReadoutError(
      503,
      "INVENTORY_RUNTIME_AUTHORITY_INVALID",
      "The persisted inventory runtime authority does not satisfy its contract.",
      "permanent",
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    );
  }
  return parsed.data;
}
