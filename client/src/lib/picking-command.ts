import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const storagePrefix = "echelon.picking.pending.v1:";
export type PickingCommandAction =
  | "pick"
  | "unpick"
  | "replenishment_create"
  | "replenishment_update"
  | "replenishment_exception";

export type StoredPickingCommand = {
  commandId: string;
  payload: Record<string, unknown>;
};

const storedCommandSchema = z
  .object({ commandId: z.string().uuid(), payload: z.record(z.unknown()) })
  .strict();

function readStoredCommand(
  storage: Storage,
  key: string,
): { raw: string; command: StoredPickingCommand } | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = storedCommandSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      storage.removeItem(key);
      return null;
    }
    return { raw, command: parsed.data };
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function getPendingPickingCommand(
  action: PickingCommandAction,
  itemId: number,
  storage: Storage = localStorage,
): StoredPickingCommand | null {
  return readStoredCommand(storage, `${storagePrefix}${action}:${itemId}`)?.command ?? null;
}

export function clearPendingPickingCommand(
  action: PickingCommandAction,
  itemId: number,
  storage: Storage = localStorage,
): void {
  storage.removeItem(`${storagePrefix}${action}:${itemId}`);
}

export class PendingPickingCommandConflictError extends Error {
  constructor(
    public readonly action: PickingCommandAction,
    public readonly itemId: number,
    public readonly pendingCommand: StoredPickingCommand,
  ) {
    super(
      "The previous picking action still needs confirmation. Retry that action before recording different work.",
    );
    this.name = "PendingPickingCommandConflictError";
  }
}

/** A lost response retains the exact intent across retry and page restart. Success releases it for the next action. */
export async function sendPickingCommand<T>(
  action: PickingCommandAction,
  itemId: number,
  payload: Record<string, unknown>,
  send: (command: StoredPickingCommand) => Promise<T>,
  storage: Storage = localStorage,
  newId = () => crypto.randomUUID(),
): Promise<T> {
  const key = `${storagePrefix}${action}:${itemId}`;
  const existing = readStoredCommand(storage, key);
  const command: StoredPickingCommand = existing
    ? existing.command
    : storedCommandSchema.parse({
        commandId: newId(),
        payload: JSON.parse(JSON.stringify(payload)),
      });
  // The server snapshot belongs to the original intent, even after a queue
  // refresh. Only the requested operation is compared; the stored body is sent.
  const intent = (body: Record<string, unknown>) => {
    const {
      expectedRevision: _revision,
      expectedStatus: _status,
      ...rest
    } = body;
    return action === "replenishment_update" ||
      action === "replenishment_exception"
      ? rest
      : body;
  };
  if (
    canonicalJson(intent(command.payload)) !==
    canonicalJson(intent(JSON.parse(JSON.stringify(payload))))
  ) {
    throw new PendingPickingCommandConflictError(action, itemId, command);
  }
  const serialized = JSON.stringify(command);
  if (!existing) storage.setItem(key, serialized);
  try {
    const result = await send(command);
    if (storage.getItem(key) === serialized) storage.removeItem(key);
    return result;
  } catch (error) {
    // Only a definitive rejection can release intent. Network/5xx failures can follow a committed operation.
    if (
      error instanceof PickingCommandRejectedError &&
      storage.getItem(key) === serialized
    )
      storage.removeItem(key);
    throw error;
  }
}

export class PickingCommandRejectedError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PickingCommandRejectedError";
  }
}
