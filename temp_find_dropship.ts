import fs from 'fs';
import path from 'path';

function searchDir(dir: string, depth = 0) {
  if (depth > 5) return;
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f === 'node_modules' || f === '.git' || f === 'dist') continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) searchDir(full, depth + 1);
      else if (f.includes('dropship') || f.includes('vendor')) {
        console.log(full);
      }
    }
  } catch(e) {}
}
searchDir('c:/Users/owner/Echelon/server');
searchDir('c:/Users/owner/Echelon/shared');
