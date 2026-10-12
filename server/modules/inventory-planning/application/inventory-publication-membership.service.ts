/** Stable structured error identity for historical stock setup and receipt
 * readers. Listing owners now supply the only live stock selection. */
export class InventoryPublicationMembershipError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "InventoryPublicationMembershipError";
  }
}
