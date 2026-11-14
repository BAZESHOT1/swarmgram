import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (/\.(tsx|ts)$/.test(name)) {
      const text = fs.readFileSync(full, 'utf8');
      const uses = text.includes('<Ionicons') || text.includes('Ionicons.');
      const imports = text.includes("from '@expo/vector-icons'");
      if (uses && !imports) console.log(full);
    }
  }
}

walk('src');
walk('app');
