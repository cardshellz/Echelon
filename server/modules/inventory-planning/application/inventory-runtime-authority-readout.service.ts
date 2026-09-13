import type { InventoryRuntimeAuthorityReadout } from "@shared/types/inventory-runtime-authority";
import {
  buildInventoryRuntimeAuthorityReadout,
  type InventoryRuntimeAuthorityRecord,
} from "../domain/inventory-runtime-authority-readout";

export interface InventoryRuntimeAuthorityReadoutStore {
  /** Returns every singleton row as persisted; the domain decides whether that is valid. */
  read(): Promise<InventoryRuntimeAuthorityRecord[]>;
}

/** Read-only. It never claims, activates or publishes; the readout is evidence, not a command. */
export class InventoryRuntimeAuthorityReadoutService {
  constructor(private readonly store: InventoryRuntimeAuthorityReadoutStore) {}

  async read(): Promise<InventoryRuntimeAuthorityReadout> {
    return buildInventoryRuntimeAuthorityReadout(await this.store.read());
  }
}
