import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresFulfillmentProviderConnectionStore } from "../../infrastructure/fulfillment-provider-connections.repository";

describe("PostgresFulfillmentProviderConnectionStore", () => {
  it("returns connection health and credential presence without returning credential material", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: "11",
        provider: "shipstation_v2",
        name: "Primary ShipStation",
        status: "active",
        credential_source: "vault",
        credential_ref: null,
        credential_present: true,
        system_managed: false,
        revision: 3,
        routed_method_count: "2",
        last_verified_at: new Date("2026-09-02T12:00:00.000Z"),
        last_error_code: null,
        last_error_message: null,
        created_by: "operator-1",
        created_at: new Date("2026-09-01T12:00:00.000Z"),
        updated_by: "operator-2",
        updated_at: new Date("2026-09-02T12:00:00.000Z"),
      }],
    });
    const store = new PostgresFulfillmentProviderConnectionStore({ query } as unknown as Pool);

    const connections = await store.listConnections();

    expect(connections).toEqual([expect.objectContaining({
      id: 11,
      credentialPresent: true,
      routedMethodCount: 2,
      revision: 3,
    })]);
    expect(JSON.stringify(connections)).not.toMatch(/ciphertext|auth_tag|secret/i);
    expect(String(query.mock.calls[0][0])).toContain("EXISTS (");
  });

  it("rolls back a failed provider-connection transaction", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
    const store = new PostgresFulfillmentProviderConnectionStore(pool);

    await expect(store.transaction(async () => {
      throw new Error("failed write");
    })).rejects.toThrow("failed write");

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("locks the connection before loading its current route count", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "11" }] })
      .mockResolvedValueOnce({
        rows: [{
          id: "11",
          provider: "shipstation_v2",
          name: "Primary ShipStation",
          status: "active",
          credential_source: "vault",
          credential_ref: null,
          credential_present: true,
          system_managed: false,
          revision: 1,
          routed_method_count: "1",
          last_verified_at: now,
          last_error_code: null,
          last_error_message: null,
          created_by: "operator-1",
          created_at: now,
          updated_by: "operator-1",
          updated_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
    const store = new PostgresFulfillmentProviderConnectionStore(pool);

    await expect(store.transaction((tx) => tx.getConnectionForUpdate(11))).resolves.toMatchObject({
      id: 11,
      routedMethodCount: 1,
    });

    expect(String(query.mock.calls[1][0])).toContain("FOR UPDATE");
    expect(String(query.mock.calls[2][0])).toContain("routed_method_count");
    expect(query.mock.calls[3][0]).toBe("COMMIT");
  });
});
