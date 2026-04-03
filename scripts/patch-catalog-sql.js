import fs from 'fs';
import path from 'path';

function patchDirectory(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      patchDirectory(fullPath);
    } else if (fullPath.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      
      const originalLines = content.split('\n');
      let changed = false;
      
      // We only want to patch raw SQL. A simple approach is replacing FROM products with FROM catalog.products
      // taking care to avoid double-patching FROM catalog.products
      
      const replacements = [
        { regex: /\bFROM\s+(?:public\.)?products\b/g, replacement: 'FROM catalog.products' },
        { regex: /\bJOIN\s+(?:public\.)?products\b/g, replacement: 'JOIN catalog.products' },
        { regex: /\bFROM\s+(?:public\.)?product_variants\b/g, replacement: 'FROM catalog.product_variants' },
        { regex: /\bJOIN\s+(?:public\.)?product_variants\b/g, replacement: 'JOIN catalog.product_variants' },
        { regex: /\bFROM\s+(?:public\.)?product_types\b/g, replacement: 'FROM catalog.product_types' },
        { regex: /\bJOIN\s+(?:public\.)?product_types\b/g, replacement: 'JOIN catalog.product_types' },
        { regex: /\bFROM\s+(?:public\.)?product_lines\b/g, replacement: 'FROM catalog.product_lines' },
        { regex: /\bJOIN\s+(?:public\.)?product_lines\b/g, replacement: 'JOIN catalog.product_lines' },
        { regex: /\bFROM\s+(?:public\.)?product_line_products\b/g, replacement: 'FROM catalog.product_line_products' },
        { regex: /\bJOIN\s+(?:public\.)?product_line_products\b/g, replacement: 'JOIN catalog.product_line_products' },
        { regex: /\bFROM\s+(?:public\.)?product_assets\b/g, replacement: 'FROM catalog.product_assets' },
        { regex: /\bJOIN\s+(?:public\.)?product_assets\b/g, replacement: 'JOIN catalog.product_assets' },
        
        { regex: /\bUPDATE\s+(?:public\.)?products\b/g, replacement: 'UPDATE catalog.products' },
        { regex: /\bUPDATE\s+(?:public\.)?product_variants\b/g, replacement: 'UPDATE catalog.product_variants' },
        { regex: /\bUPDATE\s+(?:public\.)?product_types\b/g, replacement: 'UPDATE catalog.product_types' },
        { regex: /\bUPDATE\s+(?:public\.)?product_lines\b/g, replacement: 'UPDATE catalog.product_lines' },
        { regex: /\bUPDATE\s+(?:public\.)?product_line_products\b/g, replacement: 'UPDATE catalog.product_line_products' },
        { regex: /\bUPDATE\s+(?:public\.)?product_assets\b/g, replacement: 'UPDATE catalog.product_assets' },
        
        { regex: /\bINSERT\s+INTO\s+(?:public\.)?products\b/g, replacement: 'INSERT INTO catalog.products' },
        { regex: /\bINSERT\s+INTO\s+(?:public\.)?product_variants\b/g, replacement: 'INSERT INTO catalog.product_variants' },
        { regex: /\bINSERT\s+INTO\s+(?:public\.)?product_types\b/g, replacement: 'INSERT INTO catalog.product_types' },
        { regex: /\bINSERT\s+INTO\s+(?:public\.)?product_lines\b/g, replacement: 'INSERT INTO catalog.product_lines' },
        { regex: /\bINSERT\s+INTO\s+(?:public\.)?product_line_products\b/g, replacement: 'INSERT INTO catalog.product_line_products' },
        { regex: /\bINSERT\s+INTO\s+(?:public\.)?product_assets\b/g, replacement: 'INSERT INTO catalog.product_assets' }
      ];

      for (let i=0; i<originalLines.length; i++) {
        let line = originalLines[i];
        
        // Ensure we don't mess up Drizzle imports or typescript types which might have "FROM products" ? No, types don't use FROM.
        // But let's check if the line contains a template literal or string quote which indicates raw SQL.
        if (line.includes('`') || line.includes("'") || line.includes('"')) {
          for (const rule of replacements) {
            if (rule.regex.test(line)) {
              line = line.replace(rule.regex, rule.replacement);
              changed = true;
            }
          }
        }
        originalLines[i] = line;
      }

      if (changed) {
        fs.writeFileSync(fullPath, originalLines.join('\n'), 'utf8');
        console.log(`Patched: ${fullPath}`);
      }
    }
  }
}

patchDirectory(path.resolve('./server'));
console.log('Done patching raw SQL strings.');
