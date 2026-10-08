export const sensitive = text => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|AKIA)[a-zA-Z0-9_-]{8,}|\beyJ[a-zA-Z0-9_-]{16,}\.[a-zA-Z0-9_-]+\.|\b(?:password|passwd|api[_-]?key|access[_-]?token|secret|token)["']?\s*[=:]\s*["'][^"']+/i.test(text);

export function applyChanges(text, changes) {
  let previous = text.length + 1;
  for (const change of changes) {
    const { offset, length, text: inserted } = change;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > text.length || offset + length > previous || typeof inserted !== 'string') {
      throw Object.assign(new Error('编辑范围无效或相互重叠'), { status: 409 });
    }
    text = text.slice(0, offset) + inserted + text.slice(offset + length);
    previous = offset;
  }
  return text;
}
