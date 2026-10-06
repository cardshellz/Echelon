import { describe, expect, it } from "vitest";
import { listingPhotoLeftOutReason } from "../../domain/listing-photo-reasons";

describe("listingPhotoLeftOutReason", () => {
  it("names a missing public photo address as Card Shellz setup", () => {
    expect(listingPhotoLeftOutReason("CATALOG_PUBLIC_URL_REQUIRED")).toBe("catalog_photo_public_address_missing");
  });

  it.each(["CATALOG_IMAGE_UNAVAILABLE", "IMAGE_FORMAT_UNSUPPORTED", "IMAGE_TOO_LARGE", "CATALOG_IMAGE_INVALID", "SOMETHING_NEW"])(
    "names %s as a problem with the stored file",
    (code) => {
      expect(listingPhotoLeftOutReason(code)).toBe("catalog_photo_unavailable");
    },
  );
});
