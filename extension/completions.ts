import * as vscode from 'vscode';
import type { Candidate } from '../core/ranker.js';
import type { Config } from '../core/config.js';

export interface Completion {
  candidate: Candidate;
  item: vscode.CompletionItem;
  range: vscode.Range;
  insertion: string | vscode.SnippetString;
  eligible: boolean;
}

export function normalize(items: vscode.CompletionItem[], document: vscode.TextDocument,
  position: vscode.Position, config: Config, resolved = new Set(items)): Completion[] {
  const output: Completion[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const label = typeof item.label === 'string' ? item.label : item.label.label;
    const kind = item.kind === undefined ? 'Text' : vscode.CompletionItemKind[item.kind];
    if (config.completion.includeKinds.length && !config.completion.includeKinds.includes(kind)) continue;
    if (config.completion.excludeLabels.includes(label)) continue;
    let range = item.textEdit?.range ?? (item.range instanceof vscode.Range ? item.range : item.range?.replacing);
    if (!range) {
      const word = document.getWordRangeAtPosition(position);
      range = word ?? new vscode.Range(position, position);
    }
    const insertion = item.textEdit?.newText ?? item.insertText ?? label;
    const text = typeof insertion === 'string' ? insertion : insertion.value;
    const prefix = document.getText(new vscode.Range(range.start, position));
    const existing = document.getText(range);
    const identity = JSON.stringify([label, text, range, item.additionalTextEdits, item.command]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const snippet = insertion instanceof vscode.SnippetString;
    // Public inline completion API has no additionalTextEdits field. Keep those
    // candidates in the ranking, but let the normal suggest UI apply them.
    const eligible = resolved.has(item) && !item.command && !item.additionalTextEdits?.length
      && range.isSingleLine && range.contains(position)
      && document.validateRange(range).isEqual(range)
      && text.startsWith(prefix) && (snippet || text !== existing);
    output.push({ candidate: { id: `c${output.length}`, label, kind, insertText: text,
      detail: item.detail, documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value },
      item, range, insertion, eligible });
  }
  return output;
}

export async function collect(document: vscode.TextDocument, position: vscode.Position,
  config: Config, signal: AbortSignal): Promise<Completion[]> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const list = await Promise.race([
      vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', document.uri, position, undefined,
        config.completion.resolveCount || Number.MAX_SAFE_INTEGER),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Completion providers timed out')), config.completion.providerTimeoutMs);
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    // Preserve the provider's sort order as the stable tie break and fallback.
    const returned = list?.items ?? [];
    const resolved = new Set(returned.slice(0, config.completion.resolveCount || returned.length));
    const items = [...returned].sort((a, b) => {
      const left = a.sortText ?? (typeof a.label === 'string' ? a.label : a.label.label);
      const right = b.sortText ?? (typeof b.label === 'string' ? b.label : b.label.label);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return normalize(items, document, position, config, resolved);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
