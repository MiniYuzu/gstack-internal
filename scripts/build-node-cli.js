#!/usr/bin/env node
/**
 * Build script for Node.js CLI wrappers.
 * Makes wrapper scripts executable and writes version files.
 */

import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Make wrapper scripts executable
const wrappers = [
  join(rootDir, 'browse', 'dist', 'browse.js'),
  join(rootDir, 'browse', 'dist', 'find-browse.js'),
  join(rootDir, 'design', 'dist', 'design.js'),
];

for (const wrapper of wrappers) {
  try {
    chmodSync(wrapper, 0o755);
    console.log(`Made executable: ${wrapper}`);
  } catch (err) {
    console.error(`Failed to chmod ${wrapper}:`, err.message);
    process.exit(1);
  }
}

// Write version files
try {
  const gitHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: rootDir,
  });

  if (gitHead.exitCode === 0) {
    const version = gitHead.stdout.toString().trim();
    writeFileSync(join(rootDir, 'browse', 'dist', '.version'), version + '\n');
    writeFileSync(join(rootDir, 'design', 'dist', '.version'), version + '\n');
    console.log(`Wrote version files: ${version}`);
  } else {
    console.warn('Warning: Could not get git HEAD, skipping version files');
  }
} catch (err) {
  console.warn('Warning: Failed to write version files:', err.message);
}

console.log('Node CLI build complete');
