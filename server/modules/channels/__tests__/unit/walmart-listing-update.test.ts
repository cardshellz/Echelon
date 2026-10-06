import { describe, expect, it, vi } from "vitest";
import { WalmartListingUpdateProvider } from "../../adapters/walmart/walmart-listing-update.provider";
import type { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import {
  WalmartApiError,
  WalmartClient,
} from "../../adapters/walmart/walmart-client";
import {
  WALMART_LISTING_SPEC,
  WalmartListingApi,
} from "../../adapters/walmart/walmart-listing-api";
import {
  compileListingSchema,
  listingSubmissionSchema,
} from "../../adapters/walmart/walmart-listing-schema";
import { listingHash } from "../../../marketplace-listings/domain/listing-publication";
import {
  listingUpdateRecord,
  updateSource,
} from "../../../marketplace-listings/__tests__/fixtures/listing-update.fixture";
import {
  testId,
  fixedNow,
} from "../../../marketplace-listings/__tests__/fixtures/listing-publication.fixture";
// Official 5.0.20260803-17_50_56-api schema, downloaded 2026-10-05:
// https://developer.walmart.com/file/mp/us/Consolidated_Schema_File_MP_MAINTENANCE.zip
// The real header, Orderable and Trading Card Sleeves & Holders schemas are retained,
// including constraints and annotations; only unrelated Visible branches are omitted.
import maintenanceSchema from "../fixtures/walmart-maintenance-sleeves.schema.json";

function setup() {
  const record = listingUpdateRecord();
  record.intent.account.market = "us";
  const account = record.intent.account;
  const connection = {
    channel_id: account.channelId,
    connection_id: account.connectionId,
    revision: account.revision,
    environment: account.environment,
    partner_id: account.accountId,
    ship_node_id: account.scopeId,
  };
  const api = {
    requirements: vi
      .fn()
      .mockResolvedValue({
        version: WALMART_LISTING_SPEC.MP_MAINTENANCE,
        schema: maintenanceSchema,
      }),
    observe: vi
      .fn()
      .mockResolvedValue({
        sku: updateSource.sku,
        wpid: updateSource.externalProductId,
        gtin: updateSource.identifier.value,
        productName: updateSource.title,
        productType: updateSource.productType,
        lifecycleStatus: "ACTIVE",
        publishedStatus: "SYSTEM_PROBLEM",
        price: { amount: "24.99" },
      }),
    submitMaintenance: vi.fn().mockResolvedValue("feed@US"),
    feedStatus: vi
      .fn()
      .mockResolvedValue({
        feedId: "feed@US",
        feedStatus: "PROCESSED",
        itemsReceived: 1,
        itemDetails: {
          itemIngestionStatus: [
            {
              sku: updateSource.sku,
              wpid: updateSource.externalProductId,
              ingestionStatus: "SUCCESS",
            },
          ],
        },
      }),
    taxonomy: vi.fn(),
  };
  const channels = {
    connection: vi.fn(async () => connection),
    listingApi: vi.fn(() => api),
    requireRuntime: vi.fn(),
  };
  const provider = new WalmartListingUpdateProvider(
    channels as unknown as WalmartChannelService,
  );
  return { record, account, connection, api, channels, provider };
}

describe("Walmart existing-listing maintenance", () => {
  it("validates category-only repairs against Walmart's unchanged maintenance schema", async () => {
    const { provider, account, record } = setup();
    const prepared = await provider.prepare(
      account,
      { ...updateSource, productType: "default" },
      { ...record.intent.command, changes: {} },
    );
    const validate = compileListingSchema(maintenanceSchema);
    expect(validate(prepared.payload), JSON.stringify(validate.errors)).toBe(true);
    expect(prepared.issues).toEqual([]);
    expect(prepared.payload).toMatchObject({
      MPItem: [{
        Orderable: {
          sku: updateSource.sku,
          productIdentifiers: {
            productIdType: updateSource.identifier.type,
            productId: updateSource.identifier.value,
          },
        },
        Visible: { [record.intent.command.productType]: {} },
      }],
    });
    expect(prepared.schemaHash).toBe(listingHash(maintenanceSchema));
    expect(listingSubmissionSchema(
      maintenanceSchema, "MP_MAINTENANCE", record.intent.command.productType,
    )).toBe(maintenanceSchema);
  });
  it("does not allow specProductType through maintenance schema validation", () => {
    const schema = listingSubmissionSchema(
      maintenanceSchema, "MP_MAINTENANCE", updateSource.productType,
    );
    const validate = compileListingSchema(schema);
    const payload = {
      MPItemFeedHeader: {
        businessUnit: "WALMART_US", locale: "en", version: WALMART_LISTING_SPEC.MP_MAINTENANCE,
      },
      MPItem: [{
        Orderable: {
          sku: updateSource.sku,
          productIdentifiers: { productIdType: updateSource.identifier.type, productId: updateSource.identifier.value },
          specProductType: updateSource.productType,
        },
        Visible: { [updateSource.productType]: {} },
      }],
    };
    expect(validate(payload)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        keyword: "additionalProperties",
        instancePath: "/MPItem/0/Orderable",
        params: { additionalProperty: "specProductType" },
      }),
    ]));
  });
  it("sends only the changed price, exact identifier and bound product type, without stock or creation defaults", async () => {
    const { provider, account, record, api } = setup();
    const source = await provider.observe(account, updateSource.sku);
    expect(source).toEqual(updateSource);
    const prepared = await provider.prepare(
      account,
      source,
      record.intent.command,
    );
    expect(prepared.issues).toEqual([]);
    expect(api.requirements).toHaveBeenCalledWith(
      "MP_MAINTENANCE",
      updateSource.productType,
    );
    expect(prepared.payload).toEqual({
      MPItemFeedHeader: {
        businessUnit: "WALMART_US",
        locale: "en",
        version: WALMART_LISTING_SPEC.MP_MAINTENANCE,
      },
      MPItem: [
        {
          Orderable: {
            sku: "SKU-10",
            productIdentifiers: {
              productIdType: "GTIN",
              productId: "00036000291452",
            },
            price: 27.99,
          },
          Visible: { [updateSource.productType]: {} },
        },
      ],
    });
    const beforeSend = vi.fn(async () => {
      expect(api.submitMaintenance).not.toHaveBeenCalled();
    });
    await expect(
      provider.send({ ...record.intent, prepared }, testId(4), beforeSend),
    ).resolves.toBe("feed@US");
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(api.submitMaintenance).toHaveBeenCalledExactlyOnceWith(
      prepared.payload,
      testId(4),
    );
  });
  it("validates shipping, packaging, content and category repair with the real maintenance schema", async () => {
    const { provider, account, record } = setup();
    const source = { ...updateSource, productType: "default" };
    const changes = {
      title: "Updated sleeves",
      attributes: {
        Orderable: {
          ShippingWeight: 0.75,
          MustShipAlone: "No",
          product_package_dimensions_and_weight: {
            product_package_dimensions_height: 5,
            product_package_dimensions_depth: 4,
            product_package_dimensions_width: 3,
            product_package_weight: 0.75,
          },
        },
        Visible: {
          keyFeatures: ["Clear sleeves", "Archival material", "Pack of 100"],
        },
      },
    };
    const prepared = await provider.prepare(account, source, {
      ...record.intent.command,
      changes,
    });
    expect(prepared.issues).toEqual([]);
    expect(JSON.stringify(prepared.payload)).not.toContain('"price"');
    expect(JSON.stringify(prepared.payload)).not.toContain('"inventory"');
    expect(JSON.stringify(prepared.payload)).toContain('"ShippingWeight":0.75');
  });
  it("requires a new review for a previously prepared payload containing specProductType", async () => {
    const { provider, account, record, api } = setup();
    const prepared = await provider.prepare(account, updateSource, record.intent.command);
    const legacyPayload = structuredClone(prepared.payload);
    const items = legacyPayload.MPItem as Array<{ Orderable: Record<string, unknown> }>;
    items[0].Orderable.specProductType = record.intent.command.productType;
    const beforeSend = vi.fn(async () => {});
    await expect(provider.send({
      ...record.intent,
      prepared: { ...prepared, payload: legacyPayload },
    }, testId(4), beforeSend)).rejects.toMatchObject({
      code: "LISTING_UPDATE_STALE", effect: "not_sent",
    });
    expect(beforeSend).not.toHaveBeenCalled();
    expect(api.submitMaintenance).not.toHaveBeenCalled();
  });
  it.each(["Unknown type", "__proto__"])("rejects an unsupported maintenance product type (%s)", async (productType) => {
    const { provider, account, record, api } = setup();
    await expect(provider.prepare(account, updateSource, {
      ...record.intent.command, productType,
    })).rejects.toMatchObject({ code: "WALMART_LISTING_SCHEMA_INVALID" });
    expect(api.submitMaintenance).not.toHaveBeenCalled();
  });
  it.each([
    "inventory",
    "sku",
    "productIdentifiers",
    "specProductType",
    "price",
    "country_of_origin_substantial_transformation",
    "externalProductIdentifier",
    "businessPrice",
    "automate_pricing",
  ])("rejects raw protected field %s", async (key) => {
    const { provider, account, record } = setup();
    const prepared = await provider.prepare(account, updateSource, {
      ...record.intent.command,
      changes: { attributes: { Orderable: { [key]: "bad" } } },
    });
    expect(
      prepared.issues.some(
        (issue) => issue.code === "LISTING_UPDATE_PROTECTED_FIELD",
      ),
    ).toBe(true);
  });
  it("excludes fixed fields from the editor and rejects condition, unknown fields and invalid weights", async () => {
    const { provider, account, record } = setup();
    const schema = await provider.requirements(
      account,
      updateSource.productType,
    );
    const offer = (schema.properties as any).Orderable.properties;
    expect(offer).toHaveProperty("ShippingWeight");
    for (const key of [
      "inventory",
      "sku",
      "price",
      "businessPrice",
      "country_of_origin_substantial_transformation",
      "externalProductIdentifier",
    ])
      expect(offer).not.toHaveProperty(key);
    for (const attributes of [
      { Visible: { condition: "New" } },
      { Visible: { invented: "bad" } },
      { Orderable: { ShippingWeight: -1 } },
    ]) {
      const prepared = await provider.prepare(account, updateSource, {
        ...record.intent.command,
        changes: { attributes },
      });
      expect(prepared.issues.length).toBeGreaterThan(0);
    }
  });
  it("does not send after source, schema, runtime or lease validation fails", async () => {
    const { provider, account, record, api, channels } = setup();
    const prepared = await provider.prepare(
      account,
      updateSource,
      record.intent.command,
    );
    const intent = { ...record.intent, prepared };
    api.observe.mockResolvedValueOnce({
      ...(await api.observe()),
      price: { amount: "30.00" },
    });
    await expect(
      provider.send(intent, testId(4), async () => {}),
    ).rejects.toMatchObject({ effect: "not_sent" });
    await expect(
      provider.send(
        { ...intent, prepared: { ...prepared, schemaHash: "b".repeat(64) } },
        testId(4),
        async () => {},
      ),
    ).rejects.toMatchObject({ effect: "not_sent" });
    channels.requireRuntime.mockImplementationOnce(() => {
      throw new Error("Disabled");
    });
    await expect(
      provider.send(intent, testId(4), async () => {}),
    ).rejects.toMatchObject({ effect: "not_sent" });
    await expect(
      provider.send(intent, testId(4), async () => {
        throw new Error("lease lost");
      }),
    ).rejects.toMatchObject({ effect: "not_sent" });
    expect(api.submitMaintenance).not.toHaveBeenCalled();
  });
  it.each([
    [401, "rejected"],
    [403, "rejected"],
    [429, "rejected"],
    [500, "uncertain"],
    [null, "uncertain"],
  ])("classifies %s without replay", async (status, effect) => {
    const { provider, account, record, api } = setup();
    const prepared = await provider.prepare(
      account,
      updateSource,
      record.intent.command,
    );
    api.submitMaintenance.mockRejectedValue(
      new WalmartApiError(
        "FAILED",
        "Provider failed",
        true,
        status as number | null,
      ),
    );
    await expect(
      provider.send({ ...record.intent, prepared }, testId(4), async () => {}),
    ).rejects.toMatchObject({ effect });
    expect(api.submitMaintenance).toHaveBeenCalledOnce();
  });
  it("polls a receipt using rotated credentials for the same account and rejects account drift", async () => {
    const { provider, account, connection } = setup();
    connection.revision++;
    await expect(
      provider.status(
        account,
        "feed@US",
        updateSource.sku,
        updateSource.externalProductId,
      ),
    ).resolves.toMatchObject({ state: "accepted" });
    connection.partner_id = "different-seller";
    await expect(
      provider.status(
        account,
        "feed@US",
        updateSource.sku,
        updateSource.externalProductId,
      ),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_STALE" });
  });
  it("rejects incorrect SKU/product receipts and exposes bounded, redacted field errors", async () => {
    const { provider, account, api } = setup();
    const response = await api.feedStatus();
    response.itemDetails.itemIngestionStatus[0].sku = "OTHER";
    await expect(
      provider.status(
        account,
        "feed@US",
        updateSource.sku,
        updateSource.externalProductId,
      ),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_RECEIPT_MISMATCH" });
    response.itemDetails.itemIngestionStatus[0] = {
      sku: updateSource.sku,
      wpid: "OTHER",
      ingestionStatus: "SUCCESS",
    };
    await expect(
      provider.status(
        account,
        "feed@US",
        updateSource.sku,
        updateSource.externalProductId,
      ),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_PRODUCT_CHANGED" });
    Object.assign(response.itemDetails.itemIngestionStatus[0], {
      wpid: updateSource.externalProductId,
      ingestionStatus: "DATA_ERROR",
      ingestionErrors: {
        ingestionError: [
          {
            code: "INVALID",
            description: "Invalid weight. access_token=secret",
          },
        ],
      },
    });
    const result = await provider.status(
      account,
      "feed@US",
      updateSource.sku,
      updateSource.externalProductId,
    );
    expect(result.state).toBe("needs_attention");
    expect(result.message).toContain("Invalid weight");
    expect(result.message).not.toContain("=secret");
  });
  it("requires a verified identity and an active seller item", async () => {
    const { provider, account, api } = setup();
    api.observe.mockResolvedValueOnce({
      ...(await api.observe()),
      gtin: undefined,
    });
    await expect(
      provider.observe(account, updateSource.sku),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_IDENTITY_UNAVAILABLE" });
    api.observe.mockResolvedValueOnce({
      ...(await api.observe()),
      lifecycleStatus: "RETIRED",
    });
    await expect(
      provider.observe(account, updateSource.sku),
    ).rejects.toMatchObject({ code: "LISTING_UPDATE_ITEM_INACTIVE" });
  });
  it("does not treat an inconsistent completed feed as acceptance", async () => {
    const { provider, account, api } = setup();
    api.feedStatus.mockResolvedValue({ ...(await api.feedStatus()), itemsReceived: 0 });
    await expect(provider.status(account, "feed@US", updateSource.sku, updateSource.externalProductId)).rejects.toMatchObject({ code: "LISTING_UPDATE_RECEIPT_MISMATCH" });
  });
  it.each([200, 401, 429, 503])(
    "uploads MP_MAINTENANCE as one file with no transport replay (%s)",
    async (status) => {
      const { provider, account, record } = setup();
      const prepared = await provider.prepare(
        account,
        updateSource,
        record.intent.command,
      );
      const requests: { url: string; init?: RequestInit }[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/v3/token"))
          return Response.json({
            access_token: "test-token",
            expires_in: 3600,
          });
        return Response.json(
          status === 200
            ? { feedId: "feed@US" }
            : { error: [{ code: "ERROR" }] },
          { status },
        );
      };
      const api = new WalmartListingApi(
        new WalmartClient(
          {
            clientId: "test",
            clientSecret: "test",
            market: "us",
            environment: "sandbox",
          },
          {
            fetch: fetcher,
            now: () => fixedNow,
            correlationId: () => testId(5),
          },
        ),
      );
      if (status === 200)
        await expect(
          api.submitMaintenance(prepared.payload, testId(4)),
        ).resolves.toBe("feed@US");
      else
        await expect(
          api.submitMaintenance(prepared.payload, testId(4)),
        ).rejects.toBeInstanceOf(WalmartApiError);
      const sends = requests.filter((request) =>
        request.url.includes("/v3/feeds"),
      );
      expect(sends).toHaveLength(1);
      expect(sends[0].url).toContain("feedType=MP_MAINTENANCE");
      const file = (sends[0].init?.body as FormData).get("file") as File;
      const submitted = JSON.parse(await file.text());
      const validate = compileListingSchema(maintenanceSchema);
      expect(validate(submitted), JSON.stringify(validate.errors)).toBe(true);
      expect(Object.keys(submitted.MPItem[0].Visible)).toEqual([updateSource.productType]);
      expect(listingHash(submitted)).toBe(
        listingHash(prepared.payload),
      );
    },
  );
});
