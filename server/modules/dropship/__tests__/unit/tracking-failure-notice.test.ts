import { describe, expect, it } from "vitest";
import { decideTrackingFailureNotice } from "../../domain/tracking-failure-notice";

describe("decideTrackingFailureNotice", () => {
  it("tells the vendor once when a push first fails and will be retried", () => {
    expect(decideTrackingFailureNotice({ retryable: true, attemptCount: 1, lastAttempt: false })).toBe("retrying");
  });

  it("sends nothing for the retries in between", () => {
    for (const attemptCount of [2, 3, 11]) {
      expect(decideTrackingFailureNotice({ retryable: true, attemptCount, lastAttempt: false })).toBe("none");
    }
  });

  it("tells the vendor when the push fails for good", () => {
    // The caller's last attempt, even though the error itself could be retried.
    expect(decideTrackingFailureNotice({ retryable: true, attemptCount: 12, lastAttempt: true })).toBe("failed");
    // A failure that can never succeed, on any attempt.
    expect(decideTrackingFailureNotice({ retryable: false, attemptCount: 1, lastAttempt: false })).toBe("failed");
    expect(decideTrackingFailureNotice({ retryable: false, attemptCount: 5, lastAttempt: false })).toBe("failed");
    // A single-attempt caller: first and last at once, reported as final.
    expect(decideTrackingFailureNotice({ retryable: true, attemptCount: 1, lastAttempt: true })).toBe("failed");
  });

  it("treats an unreadable attempt count as a first failure", () => {
    for (const attemptCount of [0, -1, 1.5, Number.NaN]) {
      expect(decideTrackingFailureNotice({ retryable: true, attemptCount, lastAttempt: false })).toBe("retrying");
    }
  });
});
