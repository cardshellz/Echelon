import type {
  DropshipCanonicalAcceptanceFulfillment,
  DropshipInventoryRuntimeAuthorityGate,
  DropshipOmsFulfillmentSync,
} from "../application/dropship-ports";

type RegisteredDropshipFulfillmentSync = DropshipOmsFulfillmentSync
  & DropshipCanonicalAcceptanceFulfillment;

let fulfillmentSync: RegisteredDropshipFulfillmentSync | null = null;
let inventoryRuntimeAuthority: DropshipInventoryRuntimeAuthorityGate | null = null;

export function setDropshipFulfillmentSync(sync: RegisteredDropshipFulfillmentSync): void {
  fulfillmentSync = sync;
}

export function getDropshipFulfillmentSync(): DropshipOmsFulfillmentSync | undefined {
  return fulfillmentSync ?? undefined;
}

export function getDropshipCanonicalAcceptanceFulfillment(): DropshipCanonicalAcceptanceFulfillment | undefined {
  return fulfillmentSync ?? undefined;
}

export function setDropshipInventoryRuntimeAuthorityGate(
  gate: DropshipInventoryRuntimeAuthorityGate,
): void {
  inventoryRuntimeAuthority = gate;
}

export function getDropshipInventoryRuntimeAuthorityGate(): DropshipInventoryRuntimeAuthorityGate | undefined {
  return inventoryRuntimeAuthority ?? undefined;
}
