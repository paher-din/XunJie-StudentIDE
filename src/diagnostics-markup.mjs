import { TextDocument } from '../node_modules/monaco-editor/esm/external/vscode-languageserver-textdocument/lib/esm/main.js';
import { getLanguageService as getJSONService } from '../node_modules/monaco-editor/esm/external/vscode-json-languageservice/lib/esm/jsonLanguageService.js';
import { getCSSLanguageService } from '../node_modules/monaco-editor/esm/external/vscode-css-languageservice/lib/esm/cssLanguageService.js';
import { getLanguageService as getHTMLService } from '../node_modules/monaco-editor/esm/external/vscode-html-languageservice/lib/esm/htmlLanguageService.js';
import { TokenType } from '../node_modules/monaco-editor/esm/external/vscode-html-languageservice/lib/esm/htmlLanguageTypes.js';

const json = getJSONService({ schemaRequestService: async () => { throw new Error('远程 schema 不在本地诊断范围内'); } });
json.configure({ validate: true, allowComments: false });
const css = getCSSLanguageService();
const html = getHTMLService();
const optionalEnd = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'rt', 'rp', 'optgroup', 'option', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

export async function diagnose({ path, text, syntax }) {
  const document = TextDocument.create('file:///project/' + path, syntax, 1, text);
  if (syntax === 'json' || syntax === 'css') {
    const issues = syntax === 'json' ? await json.doValidation(document, json.parseJSONDocument(document)) : css.doValidation(document, css.parseStylesheet(document));
    return issues.map(issue => ({ path, message: issue.message, code: String(issue.code ?? ''), severity: issue.severity === 2 ? 'warning' : 'error', startLineNumber: issue.range.start.line + 1, startColumn: issue.range.start.character + 1, endLineNumber: issue.range.end.line + 1, endColumn: issue.range.end.character + 1 }));
  }
  const issues = [], closed = new Set(), nodes = [...html.parseHTMLDocument(document).roots];
  const add = (offset, length, message, severity = 'error') => {
    const start = document.positionAt(offset), end = document.positionAt(offset + Math.max(1, length));
    issues.push({ path, message, severity, startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 });
  };
  while (nodes.length) {
    const node = nodes.pop();
    if (node.endTagStart !== undefined) closed.add(node.endTagStart);
    if (node.tag && !node.closed && !optionalEnd.has(node.tag.toLowerCase())) add(node.start + 1, node.tag.length, '标签 <' + node.tag + '> 未闭合', 'warning');
    nodes.push(...node.children);
  }
  const scanner = html.createScanner(text);
  let attributes = new Set(), endStart = 0;
  for (let token = scanner.scan(); token !== TokenType.EOS; token = scanner.scan()) {
    const message = scanner.getTokenError();
    if (message) add(scanner.getTokenOffset(), scanner.getTokenLength(), message);
    if (token === TokenType.StartTagOpen) attributes = new Set();
    if (token === TokenType.AttributeName) {
      const name = scanner.getTokenText().toLowerCase();
      if (attributes.has(name)) add(scanner.getTokenOffset(), scanner.getTokenLength(), '重复属性 ' + name);
      attributes.add(name);
    }
    if (token === TokenType.EndTagOpen) endStart = scanner.getTokenOffset();
    if (token === TokenType.EndTag && !closed.has(endStart)) add(scanner.getTokenOffset(), scanner.getTokenLength(), '结束标签没有对应的开始标签', 'warning');
  }
  return issues;
}
