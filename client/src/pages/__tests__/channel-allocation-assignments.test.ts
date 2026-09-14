import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The warehouse assignment grid is an on/off matrix. The per-assignment
 * priority number is not consulted by anything an operator can see, so the
 * page must not offer it; ordering lives in the engine (orderWarehouseAssignments).
 */
describe("Channel Allocation warehouse assignments UI", () => {
  const page = readFileSync(join(process.cwd(), "client", "src", "pages", "ChannelAllocation.tsx"), "utf8");

  it("offers only the enable checkbox per channel and warehouse", () => {
    expect(page).toContain("onCheckedChange={() => handleToggle(ch.id, wh.id)}");
    expect(page).not.toContain("handlePriorityChange");
    expect(page).not.toContain("value={assignment.priority}");
    expect(page).not.toMatch(/Priority \(higher = preferred\)/);
  });

  it("does not send a priority when creating an assignment", () => {
    expect(page).toContain('apiPost("/api/channel-warehouse-assignments", { ...data, enabled: true })');
  });

  it("tells operators that Dropship OMS does not get the all-warehouses fallback", () => {
    expect(page).toContain("Dropship OMS is the exception");
  });
});
