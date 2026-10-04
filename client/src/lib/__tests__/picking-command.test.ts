import { describe, expect, it, vi } from "vitest";
import {
  sendPickingCommand,
  PickingCommandRejectedError,
} from "../picking-command";
type PickingCommandSender = Parameters<typeof sendPickingCommand>[3];
const uuid = "123e4567-e89b-42d3-a456-426614174000";
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
describe("retained warehouse command intent", () => {
  it("retains one UUID/body through response loss and page restart", async () => {
    const storage = memoryStorage();
    const send = vi
      .fn<PickingCommandSender>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ pickedQuantity: 3 });
    await expect(
      sendPickingCommand("unpick", 11, { qty: 1 }, send, storage, () => uuid),
    ).rejects.toThrow("response lost");
    expect(storage.length).toBe(1);
    await sendPickingCommand("unpick", 11, { qty: 1 }, send, storage, () => {
      throw new Error("must reuse persisted UUID");
    });
    expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
    expect(storage.length).toBe(0);
  });
  it("retains the original task revision after refresh while forbidding different work", async () => {
    const storage = memoryStorage();
    await expect(
      sendPickingCommand(
        "replenishment_update",
        1,
        { status: "assigned", expectedStatus: "pending", expectedRevision: 0 },
        async () => {
          throw new Error("lost");
        },
        storage,
        () => uuid,
      ),
    ).rejects.toThrow("lost");
    const send = vi.fn<PickingCommandSender>(async () => ({ accepted: true }));
    await expect(
      sendPickingCommand(
        "replenishment_update",
        1,
        {
          status: "cancelled",
          expectedStatus: "assigned",
          expectedRevision: 1,
        },
        send,
        storage,
      ),
    ).rejects.toThrow("previous picking action");
    expect(send).not.toHaveBeenCalled();
    await sendPickingCommand(
      "replenishment_update",
      1,
      { status: "assigned", expectedStatus: "assigned", expectedRevision: 1 },
      send,
      storage,
    );
    expect(send.mock.calls[0][0]).toMatchObject({
      commandId: uuid,
      payload: {
        expectedStatus: "pending",
        expectedRevision: 0,
        status: "assigned",
      },
    });
  });
  it("releases a definitive rejection and keeps an uncertain server error", async () => {
    const storage = memoryStorage();
    await expect(
      sendPickingCommand(
        "pick",
        11,
        { status: "completed" },
        async () => {
          throw new PickingCommandRejectedError("bad input");
        },
        storage,
        () => uuid,
      ),
    ).rejects.toThrow("bad input");
    expect(storage.length).toBe(0);
    await expect(
      sendPickingCommand(
        "pick",
        11,
        { status: "completed" },
        async () => {
          throw new Error("server failure");
        },
        storage,
        () => uuid,
      ),
    ).rejects.toThrow("server failure");
    expect(storage.length).toBe(1);
  });
  it("does not let a late duplicate response clear a newer pending action", async () => {
    const storage = memoryStorage();
    let completeFirst!: (result: boolean) => void,
      completeDuplicate!: (result: boolean) => void;
    const first = sendPickingCommand(
      "unpick",
      11,
      { qty: 1 },
      () =>
        new Promise<boolean>((resolve) => {
          completeFirst = resolve;
        }),
      storage,
      () => uuid,
    );
    const duplicate = sendPickingCommand(
      "unpick",
      11,
      { qty: 1 },
      () =>
        new Promise<boolean>((resolve) => {
          completeDuplicate = resolve;
        }),
      storage,
    );
    completeFirst(true);
    await first;
    const newer = "123e4567-e89b-42d3-a456-426614174001";
    await expect(
      sendPickingCommand(
        "unpick",
        11,
        { qty: 2 },
        async () => {
          throw new Error("new response lost");
        },
        storage,
        () => newer,
      ),
    ).rejects.toThrow("new response lost");
    completeDuplicate(true);
    await duplicate;
    expect(storage.getItem(storage.key(0)!)).toContain(newer);
  });
});
