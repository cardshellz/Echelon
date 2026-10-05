import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const storagePrefix = "echelon.picking.pending.v1:";
type Command = { commandId: string; payload: Record<string, unknown> };
const storedCommandSchema = z
  .object({ commandId: z.string().uuid(), payload: z.record(z.unknown()) })
  .strict();

/** A lost response retains the exact intent across retry and page restart. Success releases it for the next action. */
export async function sendPickingCommand<T>(
  action:
    | "pick"
    | "unpick"
    | "replenishment_create"
    | "replenishment_update"
    | "replenishment_exception",
  itemId: number,
  payload: Record<string, unknown>,
  send: (command: Command) => Promise<T>,
  storage: Storage = localStorage,
  newId = () => crypto.randomUUID(),
): Promise<T> {
  const key = `${storagePrefix}${action}:${itemId}`;
  const stored = storage.getItem(key);
  const command: Command = storedCommandSchema.parse(
    stored
      ? JSON.parse(stored)
      : { commandId: newId(), payload: JSON.parse(JSON.stringify(payload)) },
  );
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
    throw new Error(
      "The previous picking action still needs confirmation. Retry that action before recording different work.",
    );
  }
  if (!stored) storage.setItem(key, JSON.stringify(command));
  try {
    const result = await send(command);
    if (storage.getItem(key) === JSON.stringify(command))
      storage.removeItem(key);
    return result;
  } catch (error) {
    // Only a definitive rejection can release intent. Network/5xx failures can follow a committed operation.
    if (
      error instanceof PickingCommandRejectedError &&
      storage.getItem(key) === JSON.stringify(command)
    )
      storage.removeItem(key);
    throw error;
  }
}

export class PickingCommandRejectedError extends Error {}
