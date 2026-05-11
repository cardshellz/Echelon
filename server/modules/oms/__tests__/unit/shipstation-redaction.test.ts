import { describe, expect, it } from "vitest";

import { redactSensitiveUrl } from "../../shipstation.service";

describe("redactSensitiveUrl", () => {
  it("redacts sensitive query parameters from valid URLs", () => {
    const result = redactSensitiveUrl(
      "https://cardshellz.example/api/shipstation/webhooks/ship-notify?secret=abc123&store=1&token=def456",
    );

    expect(result).toBe(
      "https://cardshellz.example/api/shipstation/webhooks/ship-notify?secret=%5Bredacted%5D&store=1&token=%5Bredacted%5D",
    );
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("def456");
  });

  it("redacts sensitive query parameters from malformed URL strings", () => {
    const result = redactSensitiveUrl("/ship-notify?secret=abc123&signature=sig456&safe=value");

    expect(result).toBe("/ship-notify?secret=[redacted]&signature=[redacted]&safe=value");
  });
});
