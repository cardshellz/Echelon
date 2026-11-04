import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgHistoricalShipStationContentsReviewRepository } from "../../historical-shipstation-contents-review.repository";

describe("historical contents review assigned-role authority", () => {
  it.each([
    { label: "legacy admin without assignments", roles: [], allowed: false },
    { label: "custom same-name administrator", roles: [{ id: 7, name: "Administrator", isSystem: false }], allowed: false },
    { label: "assigned lead", roles: [{ id: 7, name: "Team Lead", isSystem: true }], allowed: true },
    { label: "assigned administrator", roles: [{ id: 7, name: "Administrator", isSystem: true }], allowed: true },
  ])("checks $label before locking or changing review evidence", async ({ roles, allowed }) => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM identity.users")) return { rows: [{ active: 1, role: allowed ? "picker" : "admin" }] };
      if (text.includes("identity.auth_user_roles")) return { rows: roles };
      return { rows: [] };
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const repository = new PgHistoricalShipStationContentsReviewRepository({ connect: async () => client } as unknown as Pool);
    await expect(repository.recordDecision({ exceptionId: "1", expectedPreviewHash: "a".repeat(64), actorUserId: "operator",
      decision: "cannot_prove", reason: "Synthetic authority test" }))
      .rejects.toMatchObject({ code: allowed ? "REVIEW_NOT_FOUND" : "LEAD_AUTHORIZATION_REQUIRED" });
    const statements = query.mock.calls.map(([text]) => text);
    expect(statements.some(text => text.includes("FOR UPDATE OF exception, label"))).toBe(allowed);
    expect(statements.some(text => /^\s*(UPDATE|INSERT|DELETE)/.test(text))).toBe(false);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
