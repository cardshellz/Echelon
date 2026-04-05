const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(dirPath);
  });
}

function processFile(filePath) {
  if (!filePath.endsWith('.ts')) return;
  // skip the drizzle schema definitions themselves!
  if (filePath.includes('schema\\orders.schema.ts') || filePath.includes('schema/orders.schema.ts')) return;

  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // We want to replace raw SQL representations!
  // It's usually inside template literals like sql`SELECT ... FROM orders o`
  // We'll use a regex that looks for SQL keywords followed by orders or order_items.

  content = content.replace(/(UPDATE\s+)orders(\s+)/gi, '$1wms.orders$2');
  content = content.replace(/(FROM\s+)orders(\s+)/gi, '$1wms.orders$2');
  content = content.replace(/(INTO\s+)orders(\s+)/gi, '$1wms.orders$2');
  content = content.replace(/(JOIN\s+)orders(\s+)/gi, '$1wms.orders$2');

  content = content.replace(/(UPDATE\s+)order_items(\s+)/gi, '$1wms.order_items$2');
  content = content.replace(/(FROM\s+)order_items(\s+)/gi, '$1wms.order_items$2');
  content = content.replace(/(INTO\s+)order_items(\s+)/gi, '$1wms.order_items$2');
  content = content.replace(/(JOIN\s+)order_items(\s+)/gi, '$1wms.order_items$2');

  // Prevent double wms.wms.
  content = content.replace(/wms\.wms\./g, 'wms.');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log("Updated:", filePath);
  }
}

walkDir(path.join(__dirname, '../server'), processFile);
console.log("Done");
