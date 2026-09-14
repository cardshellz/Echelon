import type {
  InventoryAvailabilityRuntimeAtpContext,
  InventoryAvailabilityRuntimeAtpExecutor,
} from "./inventory-availability-runtime-atp.service";

export type InventoryLegacyAdminControlKind =
  | "channel_allocation"
  | "channel_feed"
  | "channel_reserve"
  | "channel_sync"
  | "channel_warehouse_assignment"
  | "inventory_strategy";

export type InventoryLegacyAdminOperation =
  | "legacy_channel_allocation_configuration"
  | "legacy_channel_allocation_read"
  | "legacy_channel_feed_configuration"
  | "legacy_channel_feed_read"
  | "legacy_channel_reserve_configuration"
  | "legacy_channel_sync_configuration"
  | "legacy_channel_warehouse_assignment_configuration"
  | "legacy_inventory_strategy_configuration";

export interface InventoryLegacyAdminControl {
  kind: InventoryLegacyAdminControlKind;
  operation: InventoryLegacyAdminOperation;
  replacementEndpoint: string;
}

export const INVENTORY_LEGACY_ADMIN_CONTROLS = Object.freeze({
  channelAllocation: control(
    "channel_allocation",
    "legacy_channel_allocation_configuration",
    "/api/inventory-planning/admin/channel-exposure/policy-draft",
  ),
  channelAllocationRead: control(
    "channel_allocation",
    "legacy_channel_allocation_read",
    "/api/inventory-planning/admin/channel-exposure",
  ),
  channelFeed: control(
    "channel_feed",
    "legacy_channel_feed_configuration",
    "/api/inventory-planning/admin/channel-exposure/variant-mapping-draft",
  ),
  channelFeedRead: control(
    "channel_feed",
    "legacy_channel_feed_read",
    "/api/inventory-planning/admin/channel-exposure",
  ),
  channelReserve: control(
    "channel_reserve",
    "legacy_channel_reserve_configuration",
    "/api/inventory-planning/admin/channel-exposure/policy-draft",
  ),
  channelSync: control(
    "channel_sync",
    "legacy_channel_sync_configuration",
    "/api/inventory-planning/admin/channel-exposure/publication-target-preview-state",
  ),
  channelWarehouseAssignment: control(
    "channel_warehouse_assignment",
    "legacy_channel_warehouse_assignment_configuration",
    "/api/inventory-planning/admin/channel-exposure/source-binding-draft",
  ),
  inventoryStrategy: control(
    "inventory_strategy",
    "legacy_inventory_strategy_configuration",
    "/api/inventory-planning/admin/supply-transformations/:productId/drafts",
  ),
});

export type InventoryLegacyAdminControlErrorCode =
  | "INVENTORY_LEGACY_CONTROL_NOT_AUTHORITATIVE"
  | "INVENTORY_LEGACY_ADMIN_READ_RETIRED";

export class InventoryLegacyAdminControlError extends Error {
  constructor(
    readonly status: 409 | 410,
    readonly code: InventoryLegacyAdminControlErrorCode,
    message: string,
    readonly context: Readonly<{
      authority: "canonical";
      authorityRevision: string;
      activationRunId: string;
      controlKind: InventoryLegacyAdminControlKind;
      operation: InventoryLegacyAdminOperation;
      replacementEndpoint: string;
    }>,
  ) {
    super(message);
    this.name = "InventoryLegacyAdminControlError";
  }
}

type AuthorityAwareOperationHandlers<T, Transaction> = Readonly<{
  legacy: (
    transaction: Transaction,
    context: InventoryAvailabilityRuntimeAtpContext,
  ) => Promise<T>;
  canonical: (
    transaction: Transaction,
    context: InventoryAvailabilityRuntimeAtpContext,
  ) => Promise<T>;
}>;

export interface InventoryLegacyWriteGuard {
  /**
   * Call immediately before the first mutation that would change the selected
   * legacy control. Reads and proven no-op updates do not call this method.
   */
  assertLegacyMutation(): void;
}

/**
 * Pins the existing runtime-authority row for the complete operation.
 *
 * This boundary owns no ATP or allocation formula. It only preserves legacy
 * behavior while legacy is authoritative, rejects obsolete controls after the
 * one-way cutover, or selects an explicitly supplied canonical read path.
 */
export class InventoryLegacyAdminControlService<Transaction = unknown> {
  constructor(private readonly executor: InventoryAvailabilityRuntimeAtpExecutor<Transaction>) {}

  async executeLegacyWrite<T>(
    selectedControl: InventoryLegacyAdminControl,
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.executeGuardedLegacyWrite(selectedControl, async (guard, transaction) => {
      guard.assertLegacyMutation();
      return work(transaction);
    });
  }

  /**
   * Pins runtime authority while the caller locks and compares current state.
   * This permits an update payload that repeats an unchanged legacy value, but
   * still rejects an actual legacy-control mutation before it is written.
   */
  async executeGuardedLegacyWrite<T>(
    selectedControl: InventoryLegacyAdminControl,
    work: (guard: InventoryLegacyWriteGuard, transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.executor.execute((context, transaction) => work({
      assertLegacyMutation() {
        if (context.authority === "canonical") {
          throw retiredControlError(selectedControl, context, "write");
        }
      },
    }, transaction));
  }

  async executeLegacyRead<T>(
    selectedControl: InventoryLegacyAdminControl,
    work: (
      transaction: Transaction,
      context: InventoryAvailabilityRuntimeAtpContext,
    ) => Promise<T>,
  ): Promise<T> {
    return this.executor.execute(async (context, transaction) => {
      if (context.authority === "canonical") {
        throw retiredControlError(selectedControl, context, "read");
      }
      return work(transaction, context);
    });
  }

  async executeAuthorityAwareRead<T>(handlers: AuthorityAwareOperationHandlers<T, Transaction>): Promise<T> {
    return this.executeAuthorityAwareOperation(handlers);
  }

  /** Selects exactly one implementation while the runtime-authority row remains pinned. */
  async executeAuthorityAwareOperation<T>(handlers: AuthorityAwareOperationHandlers<T, Transaction>): Promise<T> {
    return this.executor.execute((context, transaction) => context.authority === "legacy"
      ? handlers.legacy(transaction, context)
      : handlers.canonical(transaction, context));
  }
}

function control(
  kind: InventoryLegacyAdminControlKind,
  operation: InventoryLegacyAdminOperation,
  replacementEndpoint: string,
): Readonly<InventoryLegacyAdminControl> {
  return Object.freeze({ kind, operation, replacementEndpoint });
}

function retiredControlError(
  selectedControl: InventoryLegacyAdminControl,
  context: InventoryAvailabilityRuntimeAtpContext,
  access: "read" | "write",
): InventoryLegacyAdminControlError {
  if (context.authority !== "canonical" || context.activationRunId === null) {
    throw new Error("Canonical inventory authority context is required for legacy-control retirement.");
  }
  const sharedContext = {
    authority: context.authority,
    authorityRevision: context.authorityRevision,
    activationRunId: context.activationRunId,
    controlKind: selectedControl.kind,
    operation: selectedControl.operation,
    replacementEndpoint: selectedControl.replacementEndpoint,
  } as const;
  return access === "write"
    ? new InventoryLegacyAdminControlError(
        409,
        "INVENTORY_LEGACY_CONTROL_NOT_AUTHORITATIVE",
        "This legacy inventory control is read-only after canonical inventory authority activation.",
        sharedContext,
      )
    : new InventoryLegacyAdminControlError(
        410,
        "INVENTORY_LEGACY_ADMIN_READ_RETIRED",
        "This legacy inventory view is retired after canonical inventory authority activation.",
        sharedContext,
      );
}
