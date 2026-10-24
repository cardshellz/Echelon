import type {
  DropshipCanonicalAcceptanceFulfillment,
  DropshipInventoryRuntimeAuthorityGate,
  DropshipMarketplaceCancelStop,
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

let marketplaceCancelStop: DropshipMarketplaceCancelStop | null = null;

/** OMS's stop for accepted orders the marketplace cancelled (plan v4 §7.2), set at boot (server/index.ts). */
export function setDropshipMarketplaceCancelStop(stop: DropshipMarketplaceCancelStop): void {
  marketplaceCancelStop = stop;
}

export function getDropshipMarketplaceCancelStop(): DropshipMarketplaceCancelStop | undefined {
  return marketplaceCancelStop ?? undefined;
}
