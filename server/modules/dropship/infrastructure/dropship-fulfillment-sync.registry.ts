import type { DropshipOmsFulfillmentSync } from "../application/dropship-ports";

let fulfillmentSync: DropshipOmsFulfillmentSync | null = null;

export function setDropshipFulfillmentSync(sync: DropshipOmsFulfillmentSync): void {
  fulfillmentSync = sync;
}

export function getDropshipFulfillmentSync(): DropshipOmsFulfillmentSync | undefined {
  return fulfillmentSync ?? undefined;
}
