const fs = require('fs');
const files = [
  'server/modules/dropship/application/orderOrchestrator.ts',
  'server/modules/dropship/application/walletOrchestrator.ts'
];
files.forEach(f => {
  let txt = fs.readFileSync(f, 'utf8');
  txt = txt.replace(/\\`/g, '`');
  txt = txt.replace(/\\\${/g, '${');
  fs.writeFileSync(f, txt);
});
