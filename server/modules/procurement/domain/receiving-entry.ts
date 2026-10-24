import type { CommandAuthorityActor } from "../../identity";

export class ReceivingEntryError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message);
    this.name = "ReceivingEntryError";
  }
}

export function assertReceivingEntryAuthority(actor: CommandAuthorityActor): void {
  if (!actor.active || !actor.permissions.includes("inventory:adjust")) {
    throw new ReceivingEntryError("RECEIVING_ENTRY_FORBIDDEN", "Your current account needs inventory adjustment permission to enter or recover a receipt.", 403);
  }
}
