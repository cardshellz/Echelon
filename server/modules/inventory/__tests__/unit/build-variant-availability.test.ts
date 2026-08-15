import { describe, expect, it, vi } from "vitest";
import { assertBuildVariantsActive } from "../../infrastructure/build.repository";

describe("assertBuildVariantsActive", () => {
  it("locks and accepts every active catalog variant", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { id: 11, is_active: true },
        { id: 22, is_active: true },
      ],
    });

    await expect(assertBuildVariantsActive({ execute }, [11, 22, 11])).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects archived and missing variants with operation context", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { id: 11, is_active: true },
        { id: 22, is_active: false },
      ],
    });

    await expect(
      assertBuildVariantsActive({ execute }, [11, 22, 33], { buildOrderId: 77 }),
    ).rejects.toMatchObject({
      code: "BUILD_VARIANT_UNAVAILABLE",
      context: {
        buildOrderId: 77,
        variantIds: [22, 33],
      },
    });
  });

  it("rejects an empty build variant set", async () => {
    const execute = vi.fn();

    await expect(assertBuildVariantsActive({ execute }, [])).rejects.toMatchObject({
      code: "INVALID_BUILD_INPUT",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
