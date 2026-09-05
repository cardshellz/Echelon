import { describe, expect, it } from "vitest";
import { createReceivingNavigationSession } from "../../receiving-navigation-session";

describe("receiving navigation visits", () => {
  it("allows updates only after a screen visit is active", () => {
    const session = createReceivingNavigationSession();
    expect(session.isCurrent(session.capture())).toBe(false);
    expect(session.isCurrent(undefined)).toBe(false);
    session.enter("/receiving?open=41");
    expect(session.isCurrent(session.capture())).toBe(true);
  });

  it("keeps outstanding callbacks valid during the same visit", () => {
    const session = createReceivingNavigationSession();
    session.enter("/receiving?open=41");
    const first = session.capture();
    const second = session.capture();
    expect(session.isCurrent(first)).toBe(true);
    expect(session.isCurrent(second)).toBe(true);
  });

  it("rejects a delayed callback after navigating to another receipt", () => {
    const session = createReceivingNavigationSession();
    session.enter("/receiving?open=41");
    const previous = session.capture();
    session.leave();
    session.enter("/receiving?open=42");
    expect(session.isCurrent(previous)).toBe(false);
    expect(session.isCurrent(session.capture())).toBe(true);
  });

  it("rejects a delayed callback after A to B to A despite the restored URL", () => {
    const session = createReceivingNavigationSession();
    session.enter("/receiving?open=41");
    const firstVisit = session.capture();
    session.leave();
    session.enter("/receiving?open=42");
    session.leave();
    session.enter("/receiving?open=41");
    const returningVisit = session.capture();
    expect(firstVisit.address).toBe(returningVisit.address);
    expect(session.isCurrent(firstVisit)).toBe(false);
    expect(session.isCurrent(returningVisit)).toBe(true);
  });

  it("rejects callbacks after unmount and after a fresh visit to the same address", () => {
    const session = createReceivingNavigationSession();
    session.enter("/receiving?open=41");
    const previous = session.capture();
    session.leave();
    expect(session.isCurrent(previous)).toBe(false);
    session.enter("/receiving?open=41");
    expect(session.isCurrent(previous)).toBe(false);
  });

  it("keeps captured visits unchanged when the current visit advances", () => {
    const session = createReceivingNavigationSession();
    session.enter("/receiving?open=41");
    const previous = session.capture();
    const snapshot = { ...previous };
    session.enter("/receiving?open=42");
    expect(previous).toEqual(snapshot);
  });
});
