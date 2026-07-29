import { describe, expect, it } from "vitest";

import {
  classifyRateProgramCloneFailure,
} from "../../application/rate-program-clone.command";
import { RateCoverageAdminError } from "../../application/rate-coverage-admin.service";
import { RateProgramCloneError } from "../../application/rate-program-clone.service";

describe("classifyRateProgramCloneFailure", () => {
  it("stores domain conflicts as terminal rejected command results", () => {
    expect(classifyRateProgramCloneFailure(
      new RateProgramCloneError(
        409,
        "SHIPPING_ADMIN_COPY_TARGET_NOT_EMPTY",
        "The target is not empty.",
        { serviceLevelCode: "standard" },
      ),
    )).toEqual({
      kind: "rejected",
      httpStatus: 409,
      body: {
        error: {
          code: "SHIPPING_ADMIN_COPY_TARGET_NOT_EMPTY",
          message: "The target is not empty.",
          context: { serviceLevelCode: "standard" },
        },
      },
      errorCode: "SHIPPING_ADMIN_COPY_TARGET_NOT_EMPTY",
      errorMessage: "The target is not empty.",
    });
  });

  it("preserves destination-group conflict details", () => {
    expect(classifyRateProgramCloneFailure(
      new RateCoverageAdminError(
        409,
        "SHIPPING_ADMIN_DESTINATION_GROUP_NAME_CONFLICT",
        "West Coast already exists.",
        ["Choose a different name."],
      ),
    )).toMatchObject({
      kind: "rejected",
      httpStatus: 409,
      body: {
        error: {
          code: "SHIPPING_ADMIN_DESTINATION_GROUP_NAME_CONFLICT",
          details: ["Choose a different name."],
        },
      },
    });
  });

  it("leaves unknown infrastructure failures retryable", () => {
    expect(classifyRateProgramCloneFailure(
      new Error("connection reset"),
    )).toEqual({
      kind: "retryable",
      errorCode: "SHIPPING_ADMIN_COPY_TRANSIENT_FAILURE",
      errorMessage:
        "Shipping rate program copy failed before its transaction committed.",
    });
  });
});
