import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
console.log('[copy-html] src/renderer/index.html -> dist/renderer/index.html');

mkdirSync('dist/main/control-panel/ui', { recursive: true });
cpSync('src/main/control-panel/ui', 'dist/main/control-panel/ui', { recursive: true });
console.log('[copy-html] src/main/control-panel/ui -> dist/main/control-panel/ui');
