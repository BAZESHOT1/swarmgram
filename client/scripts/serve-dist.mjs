import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] || 'dist';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    let file = join(root, normalize(url));
    if (url === '/' || !existsSync(file) || statSync(file).isDirectory()) {
      const html = join(root, `${url.replace(/\/$/, '')}.html`);
      file = existsSync(html) ? html : join(root, 'index.html');
    }
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })
  .listen(4173, '127.0.0.1', () => console.log('serve dist on 4173'));
