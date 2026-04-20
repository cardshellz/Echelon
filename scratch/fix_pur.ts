import fs from 'fs';
let c = fs.readFileSync('client/src/pages/PurchaseOrderDetail.tsx', 'utf8');

// Remove existing import if any
c = c.replace(/import \{ dollarsToCents \} from "@shared\/utils\/money";\n/g, '');

// Replace parseFloat
c = c.replace(/parseFloat\(([^)]+)\)\s*\*\s*100/g, 'dollarsToCents($1)');

// Replace Math.round wrapper around dollarsToCents
c = c.replace(/Math\.round\(\s*dollarsToCents\(([^)]+)\)\s*\)/g, 'dollarsToCents($1)');

// Add import
c = 'import { dollarsToCents } from "@shared/utils/money";\n' + c;

// Remove local function declaration
const localFuncRegex = /\/\*\* Convert a dollar string to cents without floating-point artifacts \*\/[\s\S]*?function dollarsToCents[\s\S]*?return whole \+ cents \+ subCent;\n\}\n/g;
c = c.replace(localFuncRegex, '');

fs.writeFileSync('client/src/pages/PurchaseOrderDetail.tsx', c);
