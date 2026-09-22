/** JSON evidence is an immutable snapshot supplied by the trusted application. */
export type ReturnAuthorizationJson =
  | null | boolean | number | string
  | readonly ReturnAuthorizationJson[]
  | { readonly [key: string]: ReturnAuthorizationJson };
export type ReturnAuthorizationSnapshot = { readonly [key: string]: ReturnAuthorizationJson };

export interface CustomerReturnAuthorizationResult {
  authorizationId: number;
  authorizationNumber: string;
  replayed: boolean;
}

export interface CustomerReturnAuthorizationCommand {
  channelId: number;
  idempotencyKey: string;
}

export interface CustomerReturnAuthorizationAllocation {
  wmsOrderItemId: number;
  fulfillmentId: string;
  fulfillmentLineItemId: string;
  quantity: number;
  /** Original purchased units on this exact WMS item and provider fulfillment line. */
  originalQuantity: number;
  /** Total eligible units for this original fulfillment line, before claims. */
  eligibleQuantity: number;
  deliveryEvidence: ReturnAuthorizationSnapshot;
}

export interface PersistCustomerReturnAuthorizationInput extends CustomerReturnAuthorizationCommand {
  omsOrderId: number;
  /** SHA-256 of semantic customer intent; delivery observations are separate. */
  semanticHash: string;
  eligibilityRevision: string;
  actor: string;
  now: Date;
  policySnapshot: ReturnAuthorizationSnapshot;
  warehouseSnapshot: ReturnAuthorizationSnapshot;
  lines: readonly {
    omsOrderLineId: number;
    externalLineItemId: string;
    quantity: number;
    reasonCode: string | null;
    allocations: readonly CustomerReturnAuthorizationAllocation[];
  }[];
}

export interface LockedCustomerReturnAuthorizationSource {
  channelId: number;
  omsOrderId: number;
  lines: {
    omsOrderLineId: number;
    externalLineItemId: string | null;
    orderedQuantity: number;
    legacyExpectedQuantity: number;
    claimedQuantity: number;
    wmsItems: {
      wmsOrderId: number;
      wmsOrderItemId: number;
      fulfilledQuantity: number;
      legacyExpectedQuantity: number;
      claimedQuantity: number;
    }[];
  }[];
  allocationClaims: {
    omsOrderLineId: number;
    wmsOrderItemId: number;
    fulfillmentId: string;
    fulfillmentLineItemId: string;
    quantity: number;
  }[];
}

export interface CustomerReturnAuthorizationTransaction {
  lockCommand(command: CustomerReturnAuthorizationCommand): Promise<void>;
  findCommand(command: CustomerReturnAuthorizationCommand): Promise<{
    semanticHash: string;
    result: CustomerReturnAuthorizationResult;
  } | null>;
  /** Locks the OMS order and requested lines, then all associated WMS rows. */
  lockSource(input: {
    channelId: number;
    omsOrderId: number;
    omsOrderLineIds: readonly number[];
  }): Promise<LockedCustomerReturnAuthorizationSource | null>;
  /** Requires command/source locks; rejects stale capacity and commits no effects itself. */
  persist(input: PersistCustomerReturnAuthorizationInput): Promise<CustomerReturnAuthorizationResult>;
}

export interface CustomerReturnAuthorizationStore {
  transaction<T>(work: (tx: CustomerReturnAuthorizationTransaction) => Promise<T>): Promise<T>;
}

export class CustomerReturnAuthorizationPersistenceError extends Error {
  constructor(
    readonly code: "RETURN_AUTHORIZATION_INPUT_INVALID" | "RETURN_AUTHORIZATION_COMMAND_CONFLICT"
      | "RETURN_AUTHORIZATION_LOCK_REQUIRED" | "RETURN_AUTHORIZATION_SOURCE_CONFLICT"
      | "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED" | "RETURN_AUTHORIZATION_DATA_INVALID",
    message: string,
    readonly context: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "CustomerReturnAuthorizationPersistenceError";
  }
}
