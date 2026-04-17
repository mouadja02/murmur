import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
console.log('[copy-html] src/renderer/index.html -> dist/renderer/index.html');
