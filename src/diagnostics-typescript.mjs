import { typescript as ts } from '../node_modules/monaco-editor/esm/vs/languages/features/typescript/lib/typescriptServices.js';
import { libFileMap } from '../node_modules/monaco-editor/esm/vs/languages/features/typescript/lib/lib.js';

export function diagnose({ path, text, sources, syntax }) {
  const entry = '/project/' + path;
  const files = new Map(Object.entries(sources).map(([name, source]) => ['/project/' + name, source]));
  files.set(entry, text);
  for (const [name, source] of Object.entries(libFileMap)) files.set('/lib/' + name, source);
  files.set('/project/node-globals.d.ts', 'declare var process: any; declare var Buffer: any; declare var module: any; declare var exports: any; declare function require(name: string): any;');
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, moduleDetection: ts.ModuleDetectionKind.Force, jsx: ts.JsxEmit.Preserve, allowJs: true, checkJs: syntax === 'javascript', noEmit: true, skipLibCheck: true, allowNonTsExtensions: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
  const host = {
    getScriptFileNames: () => [...files.keys()].filter(name => name.startsWith('/project/')),
    getScriptVersion: () => '1',
    getScriptSnapshot: name => files.has(name) ? ts.ScriptSnapshot.fromString(files.get(name)) : undefined,
    getCompilationSettings: () => options, getCurrentDirectory: () => '/project',
    getDefaultLibFileName: () => '/lib/lib.d.ts',
    fileExists: name => files.has(name), readFile: name => files.get(name),
    readDirectory: () => [...files.keys()], directoryExists: () => true,
    getScriptKind: name => name === entry ? (name.endsWith('.tsx') ? ts.ScriptKind.TSX : name.endsWith('.jsx') ? ts.ScriptKind.JSX : syntax === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS) : ts.getScriptKindFromFileName(name)
  };
  const service = ts.createLanguageService(host);
  try {
    return [...service.getSyntacticDiagnostics(entry), ...service.getSemanticDiagnostics(entry)].map(issue => {
      const source = issue.file;
      const start = source.getLineAndCharacterOfPosition(issue.start ?? 0);
      const end = source.getLineAndCharacterOfPosition((issue.start ?? 0) + Math.max(1, issue.length ?? 1));
      return { path, message: ts.flattenDiagnosticMessageText(issue.messageText, '\n'), code: String(issue.code), severity: issue.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error', startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 };
    });
  } finally { service.dispose(); }
}
