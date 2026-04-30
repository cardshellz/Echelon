import { describe, expect, it } from "vitest";
import { dropshipPortalPath, isDropshipPortalHost } from "../dropship-auth";

describe("dropship portal routing helpers", () => {
  it("recognizes the dedicated customer portal hostnames", () => {
    expect(isDropshipPortalHost("cardshellz.io")).toBe(true);
    expect(isDropshipPortalHost("www.cardshellz.io")).toBe(true);
    expect(isDropshipPortalHost("echelon.cardshellz.test")).toBe(false);
  });

  it("keeps dedicated-host paths at the site root", () => {
    expect(dropshipPortalPath("/login", "cardshellz.io")).toBe("/login");
    expect(dropshipPortalPath("dashboard", "cardshellz.io")).toBe("/dashboard");
  });

  it("uses a prefixed path in the shared Echelon app", () => {
    expect(dropshipPortalPath("/login", "localhost")).toBe("/dropship-portal/login");
    expect(dropshipPortalPath("dashboard", "localhost")).toBe("/dropship-portal/dashboard");
  });
});
