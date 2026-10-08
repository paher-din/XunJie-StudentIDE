import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = await build({
  absWorkingDir: root,
  entryPoints: { app: 'web/app.mjs', 'monaco-api': 'web/monaco-api.mjs', 'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
  outdir: 'public/build', bundle: true, minify: true, format: 'esm', splitting: true,
  loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]', metafile: true,
}).then(result => {
  mkdirSync(path.join(root, 'public/build'), { recursive: true });
  return result;
});
console.log('Monaco ESM build ready.');
const definitions = path.join(root, 'node_modules/monaco-editor/esm/vs/languages/definitions');
const syntaxEntries = Object.fromEntries(readdirSync(definitions).filter(id => existsSync(path.join(definitions, id, id + '.js'))).map(id => ['languages/' + id, path.join(definitions, id, id + '.js')]));
const grammars = await build({
  absWorkingDir: root, entryPoints: syntaxEntries, outdir: 'public/build', bundle: true, minify: true, format: 'esm', metafile: true,
  plugins: [{ name: 'shared-monaco-api', setup(builder) { builder.onResolve({ filter: /editor\/editor\.api\.js$/ }, () => ({ path: '/build/monaco-api.js', external: true })); } }]
});
writeFileSync(path.join(root, 'public/build/syntax-manifest.json'), JSON.stringify(Object.fromEntries(Object.keys(syntaxEntries).map(name => [name.split('/').at(-1), '/build/' + name + '.js']))));
writeFileSync(path.join(root, 'public/build/manifest.json'), JSON.stringify({ ...Object.fromEntries([...Object.entries(frontend.metafile.outputs), ...Object.entries(grammars.metafile.outputs)].map(([name, entry]) => [name, entry.bytes])), 'public/build/syntax-manifest.json': readFileSync(path.join(root, 'public/build/syntax-manifest.json')).length }, null, 2));
const mcp = await build({
  absWorkingDir: root, entryPoints: ['src/mcp.mjs'], outfile: 'runtime/mcp.mjs',
  bundle: true, minify: true, format: 'esm', platform: 'node', target: 'node22', metafile: true,
  external: ['../src/server.mjs'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
});
console.log('Standalone MCP bundle ready.');
const diagnostics = await build({ absWorkingDir: root, entryPoints: { 'diagnostics-worker': 'src/diagnostics-worker.mjs' }, outdir: 'runtime', outExtension: { '.js': '.mjs' }, chunkNames: 'diagnostics-[hash]', bundle: true, minify: true, splitting: true, format: 'esm', platform: 'node', target: 'node22', metafile: true });
writeFileSync(path.join(root, 'runtime/diagnostics-manifest.json'), JSON.stringify(Object.fromEntries(Object.entries(diagnostics.metafile.outputs).map(([name, entry]) => [name, entry.bytes])), null, 2));
console.log('Lazy diagnostic providers ready.');
const packages = new Set([...Object.keys(frontend.metafile.inputs), ...Object.keys(grammars.metafile.inputs), ...Object.keys(mcp.metafile.inputs), ...Object.keys(diagnostics.metafile.inputs)].map(file => file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
const notices = [];
for (const name of packages) {
  const directory = path.join(root, 'node_modules', name);
  if (!existsSync(directory)) continue;
  for (const file of readdirSync(directory).filter(file => /^(?:LICENSE|LICENCE|COPYING)(?:[._-]|$)|^ThirdPartyNotices/i.test(file))) {
    notices.push(`${name} / ${file}\n${readFileSync(path.join(directory, file), 'utf8')}`);
  }
}
writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
