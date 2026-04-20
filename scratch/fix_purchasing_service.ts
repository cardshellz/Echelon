import fs from 'fs';
let code = fs.readFileSync('server/modules/procurement/purchasing.service.ts', 'utf8');
code = code.replace(
  'updatePurchaseOrder(id: number, updates: any): Promise<any>;',
  'updatePurchaseOrder(id: number, updates: any): Promise<any>;\n  updatePurchaseOrderStatusWithHistory(id: number, updates: any, historyData: any): Promise<any>;'
);
fs.writeFileSync('server/modules/procurement/purchasing.service.ts', code);
console.log('Fixed purchasing.service.ts');
