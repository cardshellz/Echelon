import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("shipping fulfillment routing admin UI", () => {
  it("replaces the planned placeholder with an explicit selectable provider catalog", () => {
    const detail = readFileSync(
      join(process.cwd(), "client", "src", "pages", "ShippingServiceLevelDetail.tsx"),
      "utf8",
    );
    const editor = readFileSync(
      join(
        process.cwd(),
        "client",
        "src",
        "components",
        "shipping",
        "service-levels",
        "FulfillmentRoutingEditor.tsx",
      ),
      "utf8",
    );

    expect(detail).toContain("<FulfillmentRoutingEditor");
    expect(detail).not.toContain("Provider routing is not configured in the initial rollout");
    expect(editor).toContain("Allowed routing methods");
    expect(editor).toContain("Connected provider catalog");
    expect(editor).toContain("A connected method is only available to route after you select and save it here.");
    expect(editor).toContain("onChange={(event) => setSearch(event.target.value)}");
    expect(editor).toContain("Save fulfillment routing");
    expect(editor).toContain("No longer available");
    expect(detail).toContain("Save fulfillment routing before review");
    expect(detail).toContain("The routing resolver will fail closed");
  });
});
