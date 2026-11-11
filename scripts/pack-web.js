// deploy-web: локальный pack + upload уже описаны; здесь только helper повторного деплоя
const { execSync } = require('child_process');
execSync('tar -czf /tmp-pack.tar.gz -C dist .', { cwd: process.env.CLIENT_DIR || '.', stdio: 'inherit' });
console.log('pack ready');
