import { describe, expect, it, vi } from "vitest";
import { reportBackgroundWork } from "../background-work-report";

describe("background work reporting", () => {
  it("keeps routine order results at debug while preserving failures and retries", () => {
    const sink = {debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()};
    reportBackgroundWork("order_action_projection", {outcome:"published",omsOrderId:1}, sink);
    reportBackgroundWork("shipping_package_history", {outcome:"superseded",omsOrderId:2}, sink);
    reportBackgroundWork("shipping_package_history", {outcome:"retry",omsOrderId:3,code:"PACKAGE_HISTORY_LABEL_MISSING"}, sink);
    reportBackgroundWork("order_action_edit_inspection", {outcome:"failed",omsOrderId:4,code:"ORDER_ACTION_EDIT_UNAVAILABLE"}, sink);
    expect(sink.debug).toHaveBeenCalledTimes(2);
    expect(sink.warn).toHaveBeenCalledWith("shipping_package_history",{outcome:"retry",omsOrderId:3,error_code:"PACKAGE_HISTORY_LABEL_MISSING"});
    expect(sink.error).toHaveBeenCalledWith("order_action_edit_inspection",{outcome:"failed",omsOrderId:4,error_code:"ORDER_ACTION_EDIT_UNAVAILABLE"});
    expect(sink.info).not.toHaveBeenCalled();
  });
});
