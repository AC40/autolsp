import * as vscode from 'vscode';
import type { Candidate } from '../core/ranker.js';
import type { Config } from '../core/config.js';

export interface Completion {
  candidate: Candidate;
  item: vscode.CompletionItem;
  range: vscode.Range;
  insertion: string | vscode.SnippetString;
  eligible: boolean;
  reversible: boolean;
}

export class CompletionProviderTimeoutError extends Error {
  constructor() { super('Completion providers timed out'); }
}

// TypeScript defers its edits and follow-up actions to this acceptance command.
// Keep the original command object, including its provider-owned arguments.
function resolvesOnAcceptance(item: vscode.CompletionItem): boolean {
  return item.command?.command === '_typescript.applyCompletionCommand';
}

const typescriptLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
const plainKeywords = new Set(('abstract accessor any as asserts async await bigint boolean break case catch class '
  + 'const constructor continue debugger declare default delete do else enum export extends false finally for from '
  + 'function get global if implements import in infer instanceof interface intrinsic is keyof let module namespace '
  + 'never new null number object of out override package private protected public readonly require return satisfies '
  + 'set static string super switch symbol this throw true try type typeof undefined unique unknown using var void '
  + 'while with yield').split(' '));

function isPlainTypeScriptKeyword(item: vscode.CompletionItem, document: vscode.TextDocument, text: string): boolean {
  const label = typeof item.label === 'string' ? item.label : item.label.label;
  // A bare language keyword needs no import, snippet expansion, or acceptance
  // side effect. Insert only its text in auto mode; do not run the TS command.
  return typescriptLanguages.has(document.languageId) && resolvesOnAcceptance(item)
    && item.kind === vscode.CompletionItemKind.Keyword && text === label && plainKeywords.has(text)
    && !(item.insertText instanceof vscode.SnippetString) && !item.additionalTextEdits?.length;
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
    // The command API returns unfiltered provider lists, including names that
    // cannot extend the typed prefix. They are not useful ranking candidates.
    if (!text.startsWith(prefix)) continue;
    const identity = JSON.stringify([label, text, range, item.additionalTextEdits, item.command]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const snippet = insertion instanceof vscode.SnippetString;
    const plainKeyword = config.mode === 'auto' && isPlainTypeScriptKeyword(item, document, text);
    const allowProviderEdits = config.mode === 'auto' && !config.auto.requireReversible;
    const ready = resolved.has(item) || plainKeyword
      || ((config.mode === 'inline' || allowProviderEdits) && resolvesOnAcceptance(item));
    const valid = range.contains(position) && document.validateRange(range).isEqual(range)
      && (snippet || text !== existing);
    const reversible = ready && valid && (!item.command || plainKeyword) && !item.additionalTextEdits?.length
      && !snippet && range.isSingleLine && range.end.isEqual(position) && !/[\r\n]/.test(text);
    const eligible = config.mode === 'auto'
      ? (allowProviderEdits ? ready && valid : reversible)
      : ready && valid && range.isSingleLine && !item.additionalTextEdits?.length;
    output.push({ candidate: { id: `c${output.length}`, label, kind, insertText: text,
      detail: item.detail, documentation: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value },
      item, range, insertion, eligible, reversible });
  }
  return output;
}

export async function collect(document: vscode.TextDocument, position: vscode.Position,
  config: Config, signal: AbortSignal): Promise<Completion[]> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CompletionProviderTimeoutError()), config.completion.providerTimeoutMs);
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    const request = (count: number) => Promise.race([
      vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', document.uri, position, undefined, count), deadline,
    ]);
    const initial = (await request(0))?.items ?? [];
    signal.throwIfAborted();
    const applicable = normalize(initial, document, position, config);
    if (!applicable.some(completion => completion.eligible && !resolvesOnAcceptance(completion.item))) {
      return normalize(initial, document, position, config, new Set());
    }
    const list = await request(config.completion.resolveCount || Number.MAX_SAFE_INTEGER);
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
