import {
  CATALOG_EXPORT_MAX_PAGE_SIZE,
  decodeCatalogExportCursor,
  encodeCatalogExportCursor,
  normalizeCatalogVariant,
  validateCatalogExportSourceId,
  type CatalogVariantSnapshot,
  type NormalizedCatalogExportPage,
} from "../domain/catalog-export";

export interface CatalogExportRepository {
  listVariantSnapshots(input: {
    afterVariantId: number | null;
    limit: number;
  }): Promise<CatalogVariantSnapshot[]>;
}

export class CatalogExportService {
  private readonly externalSourceId: string;

  constructor(
    private readonly repository: CatalogExportRepository,
    externalSourceId: string,
  ) {
    this.externalSourceId = validateCatalogExportSourceId(externalSourceId);
  }

  async listPage(input: {
    cursor: string | null;
    limit: number;
  }): Promise<NormalizedCatalogExportPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CATALOG_EXPORT_MAX_PAGE_SIZE) {
      throw new TypeError(`Catalog export limit must be between 1 and ${CATALOG_EXPORT_MAX_PAGE_SIZE}.`);
    }

    const afterVariantId = decodeCatalogExportCursor(input.cursor);
    const rows = await this.repository.listVariantSnapshots({
      afterVariantId,
      limit: input.limit + 1,
    });
    this.assertRepositoryOrder(rows, afterVariantId);

    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const lastRow = pageRows.at(-1);
    return {
      externalSourceId: this.externalSourceId,
      items: pageRows.map(normalizeCatalogVariant),
      nextCursor: hasMore && lastRow
        ? encodeCatalogExportCursor(lastRow.variantId)
        : null,
    };
  }

  private assertRepositoryOrder(
    rows: readonly CatalogVariantSnapshot[],
    afterVariantId: number | null,
  ): void {
    let priorId = afterVariantId ?? 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.variantId) || row.variantId <= priorId) {
        throw new Error("Catalog export repository returned non-monotonic variant identities.");
      }
      priorId = row.variantId;
    }
  }
}
