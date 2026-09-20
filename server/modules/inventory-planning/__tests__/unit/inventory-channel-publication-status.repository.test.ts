import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresChannelPublicationStatusReader } from "../../infrastructure/inventory-channel-publication-status.repository";

vi.mock("../../infrastructure/inventory-channel-exposure-runtime.repository", () => ({
  loadManagedSellableVariantIds: vi.fn(),
}));

describe("publication status transaction recovery", () => {
  it.each([false, true])("discards the connection only if rollback fails: %s", async rollbackFails => {
    const readError = new Error("status query failed");
    const rollbackError = new Error("connection lost during rollback");
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("SELECT target.revision")) throw readError;
        if (statement === "ROLLBACK" && rollbackFails) throw rollbackError;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const connectionPool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">;
    const result = new PostgresChannelPublicationStatusReader(connectionPool)
      .read({ publicationTargetId: 5, productId: 10 });

    if (rollbackFails) {
      await expect(result).rejects.toMatchObject({ errors: [readError, rollbackError] });
    } else {
      await expect(result).rejects.toBe(readError);
    }
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(rollbackFails);
  });
});
