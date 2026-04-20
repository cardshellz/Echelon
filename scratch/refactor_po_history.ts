import fs from "fs";
import path from "path";

const targetFile = path.resolve("./server/modules/procurement/purchasing.service.ts");
let content = fs.readFileSync(targetFile, "utf-8");

// Remove the `recordStatusChange` function
content = content.replace(
  /async function recordStatusChange\([\s\S]*?\n  \}/m,
  "// recordStatusChange removed in favor of storage.updatePurchaseOrderStatusWithHistory"
);

// We need to replace pairs of:
// await storage.updatePurchaseOrder(id, { ...updates });
// await recordStatusChange(id, oldStatus, newStatus, userId, notes);
// with:
// await storage.updatePurchaseOrderStatusWithHistory(id, { ...updates }, { oldStatus, newStatus, changedBy: userId, changeNotes: notes })

// Simple regex matching the standard block layout:
content = content.replace(
  /await storage\.updatePurchaseOrder\(([^,]+),\s*(\{[\s\S]*?\})\s*\);\s*await recordStatusChange\([^,]+,\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*(.*?)\);/g,
  "await storage.updatePurchaseOrderStatusWithHistory($1, $2, {\n        oldStatus: $3,\n        newStatus: $4,\n        changedBy: $5,\n        changeNotes: $6\n      });"
);

content = content.replace(
  /await storage\.updatePurchaseOrder\(([^,]+),\s*patch\);\s*await recordStatusChange\([^,]+,\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*(.*?)\);/g,
  "await storage.updatePurchaseOrderStatusWithHistory($1, patch, {\n      oldStatus: $2,\n      newStatus: $3,\n      changedBy: $4,\n      changeNotes: $5\n    });"
);

// We have one without updates block?: `await recordStatusChange(po.id, null, "draft", data.createdBy, "PO created");` comes after a `storage.createPurchaseOrder(..)`
// The creation itself doesn't need to be atomic with status change because if creation fails, it throws immediately. It's safe to just use the direct history insert there.
// Actually, `storage.createPoStatusHistory` is perfectly fine for initial creation!
content = content.replace(
  /await recordStatusChange\((po\.id),\s*(null),\s*("draft"),\s*(data\.createdBy),\s*("PO created")\);/g,
  "await storage.createPoStatusHistory({\n      purchaseOrderId: $1,\n      oldStatus: $2,\n      newStatus: $3,\n      changedBy: $4,\n      changeNotes: $5\n    });"
);


fs.writeFileSync(targetFile, content);
console.log("Refactored purchasing.service.ts successfully!");
