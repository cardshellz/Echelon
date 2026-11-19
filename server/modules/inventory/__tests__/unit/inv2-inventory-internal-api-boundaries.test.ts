import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as inventoryIndex from "../../index";
import { InventoryUseCases } from "../../application/inventory.use-cases";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const owner = "server/modules/inventory/";
const privateRepositories = new Set([
  `${owner}infrastructure/inventory.repository.ts`,
  `${owner}infrastructure/replenishment.repository.ts`,
  `${owner}infrastructure/cycle-count.repository.ts`,
  `${owner}infrastructure/replenishment-archive.repository.ts`,
  `${owner}infrastructure/tracking-stop.repository.ts`,
  `${owner}infrastructure/product-102-count-identity.repository.ts`,
  `${owner}infrastructure/shipment-quantity-evidence.sql.ts`,
  `${owner}infrastructure/physical-return-quantity.reader.ts`,
  `${owner}infrastructure/return-command.repository.ts`,
  `${owner}infrastructure/build-execution.repository.ts`,
  `${owner}infrastructure/operational-quantity-posting.ts`,
]);

function privateInventoryImports(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  function edge(specifier: string) {
    const clean = specifier.replace(/[?#].*$/, "");
    let destination: string;
    if (clean.startsWith(".")) destination = posix.join(posix.dirname(file), clean);
    else if (clean.startsWith("@/")) destination = posix.join("client/src", clean.slice(2));
    else if (clean.startsWith("@shared/")) destination = posix.join("shared", clean.slice(8));
    else return;
    destination = posix.normalize(destination).replace(/\.[cm]?js$/, ".ts");
    if (!/\.[cm]?tsx?$/.test(destination)) destination += ".ts";
    if (privateRepositories.has(destination) && !file.startsWith(owner)) {
      violations.add(destination);
    }
  }
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      edge(node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      edge(node.moduleReference.expression.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      edge(node.argument.literal.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      edge(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...violations].sort();
}

function productionFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    if (["__tests__", "node_modules", "dist", "build"].includes(entry.name)) return [];
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [file] : [];
  });
}

describe("Batch INV-2: Inventory Internal API Boundaries & CI-03", () => {
  it("prevents production modules outside inventory from importing private inventory repositories directly", () => {
    const failures = ["server", "client/src", "scripts"].flatMap(productionFiles).flatMap((file) =>
      privateInventoryImports(file, readFileSync(join(root, file), "utf8")).map((destination) => ({
        file,
        destination,
      })),
    );
    expect(failures).toEqual([]);
  });

  it("rejects literal direct/alias/re-export/dynamic imports of private inventory repositories from non-inventory modules", () => {
    expect(
      privateInventoryImports(
        "server/modules/catalog/catalog.storage.ts",
        'import { cancelProductReplenishmentTasksInTx } from "../inventory/infrastructure/replenishment-archive.repository";',
      ),
    ).toEqual(["server/modules/inventory/infrastructure/replenishment-archive.repository.ts"]);
    expect(
      privateInventoryImports(
        "server/modules/orders/operations-dashboard.service.ts",
        'import { shipmentQuantityEvidenceProjection } from "../inventory/infrastructure/shipment-quantity-evidence.sql";',
      ),
    ).toEqual(["server/modules/inventory/infrastructure/shipment-quantity-evidence.sql.ts"]);
    expect(
      privateInventoryImports(
        "server/modules/catalog/catalog.storage.ts",
        'import { cancelProductReplenishmentTasksInTx } from "../inventory/catalog-inventory.api";',
      ),
    ).toEqual([]);
  });

  it("hides raw repository method objects from server/modules/inventory/index.ts", () => {
    expect("inventoryMethods" in inventoryIndex).toBe(false);
    expect("replenishmentMethods" in inventoryIndex).toBe(false);
    expect("cycleCountMethods" in inventoryIndex).toBe(false);
    expect("inventoryStorage" in inventoryIndex).toBe(true);
  });

  it("delegates undoTransfer and deleteEmptyUnassignedLevel through InventoryUseCases with safety guards", async () => {
    const storageMock = {
      undoTransfer: vi.fn().mockResolvedValue({
        id: 901,
        productVariantId: 44,
        transactionType: "transfer",
      }),
      getInventoryLevelById: vi.fn(),
      hasProductLocationAssignment: vi.fn(),
      deleteInventoryLevel: vi.fn().mockResolvedValue(undefined),
    };
    const useCases = new InventoryUseCases({} as any, storageMock as any);
    const changes: Array<{ variantId: number; trigger: string }> = [];
    useCases.onInventoryChange((variantId, trigger) => {
      changes.push({ variantId, trigger });
    });

    await expect(useCases.undoTransfer(0, "op-1")).rejects.toThrow("Invalid transfer transaction ID");
    const undone = await useCases.undoTransfer(500, "op-1");
    expect(undone.id).toBe(901);
    expect(storageMock.undoTransfer).toHaveBeenCalledWith(500, "op-1");
    expect(changes).toEqual([{ variantId: 44, trigger: "undo_transfer" }]);

    storageMock.getInventoryLevelById.mockResolvedValueOnce(undefined);
    await expect(useCases.deleteEmptyUnassignedLevel(10)).resolves.toEqual({
      deleted: false,
      error: "Inventory level not found",
      statusCode: 404,
    });

    storageMock.getInventoryLevelById.mockResolvedValueOnce({
      id: 11,
      productVariantId: 44,
      warehouseLocationId: 7,
      variantQty: 3,
      reservedQty: 0,
    });
    await expect(useCases.deleteEmptyUnassignedLevel(11)).resolves.toEqual({
      deleted: false,
      error: "Cannot delete — row still has quantity or reservations",
      statusCode: 400,
    });

    storageMock.getInventoryLevelById.mockResolvedValueOnce({
      id: 12,
      productVariantId: 44,
      warehouseLocationId: 7,
      variantQty: 0,
      reservedQty: 0,
    });
    storageMock.hasProductLocationAssignment.mockResolvedValueOnce(true);
    await expect(useCases.deleteEmptyUnassignedLevel(12)).resolves.toEqual({
      deleted: false,
      error: "Cannot delete — variant is assigned to this location",
      statusCode: 400,
    });

    storageMock.getInventoryLevelById.mockResolvedValueOnce({
      id: 13,
      productVariantId: 44,
      warehouseLocationId: 7,
      variantQty: 0,
      reservedQty: 0,
    });
    storageMock.hasProductLocationAssignment.mockResolvedValueOnce(false);
    await expect(useCases.deleteEmptyUnassignedLevel(13)).resolves.toEqual({
      deleted: true,
    });
    expect(storageMock.deleteInventoryLevel).toHaveBeenCalledWith(13);
  });
});
