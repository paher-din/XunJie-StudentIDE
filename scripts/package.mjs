import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = new Set(['runtime/mcp.mjs', 'runtime/diagnostics-manifest.json', 'public/build/manifest.json']);
for (const [manifest, prefix] of [['public/build/manifest.json', 'public/build/'], ['runtime/diagnostics-manifest.json', 'runtime/']]) {
  for (const file of Object.keys(JSON.parse(readFileSync(path.join(root, manifest), 'utf8')))) {
    assert.ok(file.startsWith(prefix) && !path.isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..'), 'Unsafe build output: ' + file);
    assert.ok(statSync(path.join(root, file)).isFile(), 'Missing build output: ' + file);
    files.add(file);
  }
}
const distribution = path.join(root, 'dist');
mkdirSync(distribution, { recursive: true });
const marketplaceRoot = mkdtempSync(path.join(distribution, 'xunjie-studentide-' + metadata.version + '-'));
const pluginRoot = path.join(marketplaceRoot, 'student-ide');
mkdirSync(pluginRoot);
for (const file of ['.codex-plugin', '.mcp.json', 'hooks', 'skills', 'src', 'shared.mjs', 'THIRD_PARTY_NOTICES.txt', 'public/index.html', 'public/style.css', 'scripts/hook.mjs', ...files]) {
  const destination = path.join(pluginRoot, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(path.join(root, file), destination, { recursive: true, errorOnExist: true, force: false });
}
writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, private: true, type: 'module', engines: metadata.engines }, null, 2) + '\n');
const catalogDirectory = path.join(marketplaceRoot, '.agents/plugins');
mkdirSync(catalogDirectory, { recursive: true });
writeFileSync(path.join(catalogDirectory, 'marketplace.json'), JSON.stringify({
  name: 'xunjie-studentide', interface: { displayName: 'XunJie-StudentIDE' },
  plugins: [{ name: 'student-ide', source: { source: 'local', path: './student-ide' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
}, null, 2) + '\n');
let bytes = 0;
for (const file of files) bytes += statSync(path.join(pluginRoot, file)).size;
console.log(JSON.stringify({ marketplaceRoot, pluginRoot, buildFiles: files.size, buildBytes: bytes, nodeRequired: metadata.engines.node }));
