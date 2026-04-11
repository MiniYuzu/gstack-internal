#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '..', 'src');
const cliPath = join(srcDir, 'find-browse.ts');

const child = spawn('bun', ['run', cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
  windowsHide: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => { console.error('[gstack] Failed to start:', err.message); process.exit(1); });
