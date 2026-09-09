import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateShippingAdmin } from "../pricing-programs/api";

describe("shared configuration refresh", () => {
  it("invalidates the Dropship screen, program Used by and packaging together", () => {
    const client = new QueryClient();
    const affected = [
      "/api/dropship/admin/shipping/shared",
      "/api/shipping/admin/rate-tables",
      "/api/shipping/admin/packaging",
    ];
    for (const key of [...affected, "/api/orders"])
      client.setQueryData([key], { saved: true });
    invalidateShippingAdmin(client);
    for (const key of affected)
      expect(client.getQueryState([key])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["/api/orders"])?.isInvalidated).toBe(false);
    client.clear();
  });
});
