import * as vscode from 'vscode';
import { configSchema, type Config } from '../core/config.js';
import { JevRanker, delay, type Ranking } from '../core/ranker.js';
import { autoIneligibilityReason, canRevert, inverse, receiptFor, type Receipt } from '../core/edits.js';
import { ContextCollector, excluded } from './context.js';
import { collect, CompletionProviderTimeoutError, type Completion } from './completions.js';

const secretName = 'typesafe-api-key';
type Result = { completions: Map<string, Completion>; ranking: Ranking; version: number; config: Config };

export class AutoLsp implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly ranker = new JevRanker();
  private readonly collector = new ContextCollector();
  private readonly output = vscode.window.createOutputChannel('AutoLSP');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  private readonly disposables: vscode.Disposable[] = [];
  private pending?: AbortController;
  private pendingState?: { document: vscode.TextDocument; version: number; position: vscode.Position };
  private timer?: ReturnType<typeof setTimeout>;
  private snoozeTimer?: ReturnType<typeof setTimeout>;
  private scheduled?: { uri: string; version: number; offset: number };
  private receipt?: Receipt;
  private readonly ownVersions = new Map<string, number>();
  private ownEdit = false;
  private suspended = false;
  private lastReason = '';
  private lastAutoDecision = '';

  get autoInsertionStatus(): string { return this.lastAutoDecision; }

  private reportAutoDecision(reason: string): false {
    if (reason !== this.lastAutoDecision) this.output.appendLine(`Auto-insert: ${reason}`);
    this.lastAutoDecision = reason;
    this.status.tooltip = `Jev completion ranking. ${reason} Click to ${this.suspended ? 'resume' : 'pause'}.`;
    return false;
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = 'autolsp.toggleSuspended';
    this.status.show();
    const command = (id: string, handler: (...args: any[]) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(`autolsp.${id}`, handler));
    };
    command('setApiKey', async () => {
      const value = await vscode.window.showInputBox({ password: true, prompt: 'TypeSafe API key (stored in VS Code SecretStorage)', ignoreFocusOut: true });
      if (value?.trim()) { await context.secrets.store(secretName, value.trim()); this.ranker.clear(); this.updateStatus(); }
    });
    command('clearApiKey', async () => { await context.secrets.delete(secretName); this.ranker.clear(); this.cancel(); });
    command('toggleSuspended', () => this.setSuspended(!this.suspended));
    command('snooze', () => {
      this.setSuspended(true);
      this.snoozeTimer = setTimeout(() => this.setSuspended(false), this.settings().suspendDurationMs);
    });
    command('toggleMode', async () => {
      const config = vscode.workspace.getConfiguration('autolsp', vscode.window.activeTextEditor?.document);
      const inspected = config.inspect('mode');
      const languageOverride = inspected?.workspaceFolderLanguageValue !== undefined
        || inspected?.workspaceLanguageValue !== undefined || inspected?.globalLanguageValue !== undefined;
      const target = (languageOverride ? inspected?.workspaceFolderLanguageValue : inspected?.workspaceFolderValue) !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : (languageOverride ? inspected?.workspaceLanguageValue : inspected?.workspaceValue) !== undefined
          ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('mode', this.settings().mode === 'auto' ? 'inline' : 'auto', target, languageOverride);
    });
    command('undoInsertion', () => this.undoInsertion());
    command('showOutput', () => this.output.show());
    command('showRanking', () => this.showRanking());
    command('suggest', async () => {
      if (this.settings().mode === 'auto') await this.autoInsert();
      else await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    });
    command('inlineAccepted', async (providerCommand?: vscode.Command) => {
      await vscode.commands.executeCommand('setContext', 'autolsp.inlineVisible', false);
      if (providerCommand) {
        try { await vscode.commands.executeCommand(providerCommand.command, ...(providerCommand.arguments ?? [])); }
        catch { this.output.appendLine('The completion was inserted, but its provider acceptance command failed. Check the extension host log.'); }
      }
    });
    this.disposables.push(
      vscode.languages.registerInlineCompletionItemProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this),
      vscode.workspace.onDidChangeTextDocument(event => this.onChange(event)),
      vscode.workspace.onDidCloseTextDocument(document => {
        this.collector.close(document.uri); this.ownVersions.delete(document.uri.toString()); this.cancel(); this.clearReceipt();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => { this.cancel(); this.clearReceipt(); this.updateStatus(); }),
      vscode.window.onDidChangeWindowState(state => { if (!state.focused) this.cancel(); }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (this.ownEdit) return;
        const request = this.pendingState;
        if (request && !this.current(request.document, request.position, request.version)) this.pending?.abort();
        void vscode.commands.executeCommand('setContext', 'autolsp.inlineVisible', false);
        // Selection events can lag behind the corresponding document event.
        // The typing timer verifies the final position when it fires; canceling
        // it here can lose a valid request on the pre-typing caret event.
        // The renderer may deliver the pre-insertion caret after edit() resolves.
        // Keep the receipt until a document edit; derive keybinding eligibility
        // from the current selection instead of destroying the receipt here.
        if (this.receipt) void vscode.commands.executeCommand('setContext', 'autolsp.canUndoInsertion', this.receiptValid(event.textEditor));
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('autolsp')) {
          this.cancel(); this.ranker.clear(); this.collector.clear(); this.clearReceipt(); this.updateStatus();
        }
      }),
    );
    this.updateStatus();
    this.output.appendLine(`AutoLSP ${context.extension.packageJSON.version} activated in ${this.settings().mode} mode.`);
  }

  settings(document = vscode.window.activeTextEditor?.document): Config {
    const settings = vscode.workspace.getConfiguration('autolsp', document);
    const values = Object.fromEntries(Object.keys(configSchema.shape).map(key => [key, settings.get(key)]));
    // Credentials must never follow a workspace-controlled endpoint. These two
    // settings are machine-scoped, and we also ignore workspace values explicitly.
    values.endpoint = settings.inspect('endpoint')?.globalValue;
    values.apiKeyEnv = settings.inspect('apiKeyEnv')?.globalValue;
    try { return configSchema.parse(values); }
    catch { this.output.appendLine('Invalid AutoLSP settings; suggestions disabled until corrected.'); return configSchema.parse({ enabled: false }); }
  }

  private enabled(document: vscode.TextDocument, config: Config): boolean {
    return vscode.workspace.isTrusted && config.enabled && !this.suspended && !document.isClosed
      && ['file', 'untitled'].includes(document.uri.scheme)
      && !excluded(document.uri, config.context)
      && !config.excludedLanguages.includes(document.languageId)
      && (config.languages.includes('*') || config.languages.includes(document.languageId));
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    clearTimeout(this.snoozeTimer);
    this.cancel();
    void vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
    this.updateStatus();
  }

  private updateStatus(): void {
    const config = this.settings();
    this.status.text = `$(sparkle) AutoLSP: ${!config.enabled ? 'off' : this.suspended ? 'paused' : config.mode}`;
    this.status.tooltip = `Jev completion ranking. Click to ${this.suspended ? 'resume' : 'pause'}.`;
  }

  private cancel(): void {
    this.pending?.abort(); this.pending = undefined; this.pendingState = undefined;
    clearTimeout(this.timer); this.scheduled = undefined;
    void vscode.commands.executeCommand('setContext', 'autolsp.inlineVisible', false);
  }

  private clearReceipt(): void {
    this.receipt = undefined;
    void vscode.commands.executeCommand('setContext', 'autolsp.canUndoInsertion', false);
  }

  private receiptValid(editor: vscode.TextEditor): boolean {
    return !!this.receipt && editor.selections.length === 1 && editor.selection.isEmpty
      && canRevert(this.receipt, editor.document.uri.toString(), editor.document.version,
        editor.document.getText(), editor.document.offsetAt(editor.selection.active));
  }

  private onChange(event: vscode.TextDocumentChangeEvent): void {
    this.collector.record(event, this.settings(event.document).context);
    const uri = event.document.uri.toString();
    if (this.ownVersions.get(uri) === event.document.version) { this.ownVersions.delete(uri); return; }
    if (this.ownEdit || !event.contentChanges.length) return;
    this.cancel(); this.clearReceipt();
    const editor = vscode.window.activeTextEditor;
    const config = this.settings(event.document);
    if (!editor || editor.document !== event.document || !this.enabled(event.document, config)
      || config.mode !== 'auto' || event.reason) return;
    if (event.contentChanges.length !== 1) {
      this.reportAutoDecision(`No trigger: edit contains ${event.contentChanges.length} changes; expected single-character typing.`);
      return;
    }
    const change = event.contentChanges[0];
    // Trigger on ordinary typing, not paste, deletion, undo/redo or multiline edits.
    if ([...change.text].length !== 1 || /\s/.test(change.text)) {
      this.reportAutoDecision('No trigger: paste, deletion, or whitespace edit. Use AutoLSP: Suggest Now to evaluate explicitly.');
      return;
    }
    this.scheduled = { uri: event.document.uri.toString(), version: event.document.version,
      offset: change.rangeOffset + change.text.length };
    this.timer = setTimeout(() => {
      const current = this.scheduled;
      this.scheduled = undefined;
      if (current && editor.document.version === current.version
        && editor.document.offsetAt(editor.selection.active) === current.offset) void this.autoInsert();
    }, config.auto.delayMs);
  }

  private current(document: vscode.TextDocument, position: vscode.Position, version: number): boolean {
    const editor = vscode.window.activeTextEditor;
    return editor?.document === document && document.version === version
      && editor.selections.length === 1 && editor.selection.isEmpty && editor.selection.active.isEqual(position);
  }

  async evaluate(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<Result | undefined> {
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const subscription = token?.onCancellationRequested(() => controller.abort());
    if (token?.isCancellationRequested) controller.abort();
    const config = this.settings(document);
    const version = document.version;
    this.pendingState = { document, version, position };
    let stage = 'collecting completions';
    try {
      if (!this.enabled(document, config) || !this.current(document, position, version)) return;
      await delay(config.ranking.debounceMs, controller.signal);
      const completions = await collect(document, position, config, controller.signal);
      if (!this.current(document, position, version)) return;
      stage = 'collecting editor context';
      const state = this.collector.collect(document, position, config.context);
      stage = 'reading the API key';
      const apiKey = await this.context.secrets.get(secretName) ?? process.env[config.apiKeyEnv];
      stage = 'ranking completions';
      const ranking = await this.ranker.rank(completions.map(item => item.candidate), state, config, apiKey, controller.signal);
      if (!this.current(document, position, version) || !this.enabled(document, this.settings(document))) return;
      if (ranking.reason && ranking.reason !== this.lastReason) this.output.appendLine(ranking.reason);
      this.lastReason = ranking.reason ?? '';
      return { completions: new Map(completions.map(item => [item.candidate.id, item])), ranking, version, config };
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = error instanceof CompletionProviderTimeoutError
          ? `Completion providers timed out after ${config.completion.providerTimeoutMs} ms. Check the language server or increase autolsp.completion.providerTimeoutMs.`
          : `Completion request failed while ${stage}. Check the extension host log.`;
        if (reason !== this.lastReason) this.output.appendLine(reason);
        this.lastReason = reason;
      }
      return;
    } finally {
      subscription?.dispose();
      if (this.pending === controller) { this.pending = undefined; this.pendingState = undefined; }
    }
  }

  async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position,
    context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[]> {
    const config = this.settings(document);
    if (config.mode !== 'inline' || this.ownEdit) return [];
    const word = document.getWordRangeAtPosition(position);
    const prefix = document.getText(new vscode.Range(word?.start ?? position, position));
    if (prefix.length < config.inline.minPrefixLength) return [];
    const result = await this.evaluate(document, position, token);
    if (!result || token.isCancellationRequested) return [];
    if (result.ranking.source === 'lsp' && !config.inline.fallbackToLsp) return [];
    const items: vscode.InlineCompletionItem[] = [];
    for (const ranked of result.ranking.items) {
      const completion = result.completions.get(ranked.candidate.id)!;
      if (!completion.eligible || (ranked.score !== undefined && ranked.score < config.ranking.minScore)) continue;
      if (!config.inline.snippets && completion.insertion instanceof vscode.SnippetString) continue;
      if (context.selectedCompletionInfo && (!context.selectedCompletionInfo.range.isEqual(completion.range)
        || !completion.candidate.insertText.startsWith(context.selectedCompletionInfo.text))) continue;
      const item = new vscode.InlineCompletionItem(completion.insertion, completion.range,
        { command: 'autolsp.inlineAccepted', title: 'Accepted AutoLSP suggestion', arguments: [completion.item.command] });
      items.push(item);
      if (items.length >= config.inline.maxSuggestions) break;
    }
    await vscode.commands.executeCommand('setContext', 'autolsp.inlineVisible', items.length > 0);
    return items;
  }

  async autoInsert(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || this.ownEdit || this.receipt || this.settings(editor.document).mode !== 'auto') return false;
    const { document } = editor;
    const position = editor.selection.active;
    const result = await this.evaluate(document, position);
    if (!result) {
      if (this.current(document, position, document.version)) this.reportAutoDecision(this.lastReason || 'Request cancelled or suggestions disabled.');
      return false;
    }
    if (result.ranking.source === 'lsp') return this.reportAutoDecision(`Jev ranking unavailable: ${result.ranking.reason ?? 'LSP fallback'}.`);
    if (!result.ranking.items.length) return this.reportAutoDecision('No candidates.');
    const [best, runnerUp] = result.ranking.items;
    const completion = result.completions.get(best.candidate.id)!;
    if (!completion.eligible) return this.reportAutoDecision(result.config.auto.requireReversible
      ? 'The highest-ranked candidate is not eligible for a reversible insertion. Disable auto.requireReversible to allow provider edits and commands.'
      : 'The highest-ranked candidate is unresolved or has an incompatible replacement range.');
    const prefix = document.getText(new vscode.Range(completion.range.start, position));
    const reason = autoIneligibilityReason(completion.candidate.kind, completion.candidate.insertText, prefix,
      best.score, runnerUp?.score, result.config.auto);
    if (reason) return this.reportAutoDecision(reason);
    // A truncated ranking cannot justify an automatic decision against all candidates.
    if (result.ranking.items.some(item => item.score === undefined)) return this.reportAutoDecision('The ranking contains unscored candidates.');
    if (!this.current(document, position, result.version) || !this.enabled(document, this.settings(document))) return false;
    if (!completion.reversible) return this.applyProviderCompletion(editor, completion);
    const receipt = receiptFor(document.uri.toString(), result.version + 1, document.getText(), {
      start: document.offsetAt(completion.range.start), end: document.offsetAt(completion.range.end), text: completion.insertion as string,
    });
    this.ownEdit = true;
    this.ownVersions.set(document.uri.toString(), result.version + 1);
    try {
      const applied = await editor.edit(edit => edit.replace(completion.range, completion.insertion as string),
        { undoStopBefore: true, undoStopAfter: true });
      if (!applied) { this.ownVersions.delete(document.uri.toString()); return false; }
      if (document.version !== result.version + 1 || vscode.window.activeTextEditor !== editor) return true;
      receipt.version = document.version;
      const cursor = document.positionAt(receipt.cursor);
      editor.selection = new vscode.Selection(cursor, cursor);
      this.receipt = receipt;
      await vscode.commands.executeCommand('setContext', 'autolsp.canUndoInsertion', true);
      this.reportAutoDecision(`Inserted completion (score ${best.score!.toFixed(3)}). Backspace reverts it.`);
      return true;
    } finally { this.ownEdit = false; }
  }

  private async applyProviderCompletion(editor: vscode.TextEditor, completion: Completion): Promise<boolean> {
    const { document } = editor;
    const additional = completion.item.additionalTextEdits ?? [];
    const ranges = [completion.range, ...additional.map(edit => edit.range)];
    if (ranges.some(range => !document.validateRange(range).isEqual(range))) {
      return this.reportAutoDecision('Provider supplied an invalid edit range.');
    }
    // Completion edits must not overlap. Validate before applying anything.
    const offsets = ranges.map(range => ({ start: document.offsetAt(range.start), end: document.offsetAt(range.end) }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < offsets.length; i++) {
      const previous = offsets[i - 1], current = offsets[i];
      if (current.start < previous.end || current.start === previous.start) {
        return this.reportAutoDecision('Provider supplied overlapping completion edits.');
      }
    }
    // A workspace snippet edit keeps the caret/placeholders in the completion
    // while applying imports in the same native undo transaction.
    const snippet = typeof completion.insertion === 'string'
      ? new vscode.SnippetString().appendText(completion.insertion).appendTabstop(0)
      : completion.insertion;
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, [new vscode.SnippetTextEdit(completion.range, snippet), ...additional]);
    this.clearReceipt();
    this.ownEdit = true;
    let applied = false;
    try {
      applied = await vscode.workspace.applyEdit(edit);
      if (!applied) return this.reportAutoDecision('The editor could not apply the provider completion.');
      const command = completion.item.command;
      if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      this.reportAutoDecision('Inserted provider completion. Use normal Undo; full Backspace rollback is unavailable.');
      return true;
    } catch {
      this.reportAutoDecision(applied
        ? 'Completion inserted, but its provider command failed. Use normal Undo to revert the edit.'
        : 'The editor could not apply the provider completion.');
      return applied;
    } finally {
      if (applied) this.ownVersions.set(document.uri.toString(), document.version);
      this.ownEdit = false;
    }
  }

  async undoInsertion(): Promise<boolean> {
    this.cancel();
    const editor = vscode.window.activeTextEditor;
    const receipt = this.receipt;
    this.clearReceipt();
    if (!editor || editor.selections.length !== 1 || !receipt || !canRevert(receipt, editor.document.uri.toString(), editor.document.version,
      editor.document.getText(), editor.document.offsetAt(editor.selection.active)) || !editor.selection.isEmpty) {
      await vscode.commands.executeCommand('deleteLeft');
      return false;
    }
    const edit = inverse(receipt);
    this.ownEdit = true;
    this.ownVersions.set(editor.document.uri.toString(), editor.document.version + 1);
    try {
      const range = new vscode.Range(editor.document.positionAt(edit.start), editor.document.positionAt(edit.end));
      const applied = await editor.edit(builder => builder.replace(range, edit.text), { undoStopBefore: true, undoStopAfter: true });
      if (!applied) this.ownVersions.delete(editor.document.uri.toString());
      if (applied) {
        const cursor = editor.document.positionAt(edit.start + edit.text.length);
        editor.selection = new vscode.Selection(cursor, cursor);
      }
      return applied;
    } finally { this.ownEdit = false; }
  }

  private async showRanking(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const result = await this.evaluate(editor.document, editor.selection.active);
    if (!result) return;
    await vscode.window.showQuickPick(result.ranking.items.map(item => ({
      label: item.candidate.label,
      description: `${item.candidate.kind} · ${item.score === undefined ? 'LSP fallback' : `${Math.round(item.score * 100)}%`} · ${result.completions.get(item.candidate.id)?.eligible ? 'inline eligible' : 'use native completion menu'}`,
      detail: item.candidate.detail,
    })), { title: `AutoLSP ranking · ${result.ranking.source} · ${result.ranking.elapsedMs} ms`,
      placeHolder: 'Read-only ranking inspector; Escape to return to the editor', matchOnDescription: true });
  }

  dispose(): void {
    this.cancel(); clearTimeout(this.snoozeTimer); this.clearReceipt();
    this.disposables.forEach(disposable => disposable.dispose());
    this.output.dispose(); this.status.dispose(); this.collector.clear(); this.ranker.clear(); this.ownVersions.clear();
  }
}

export function activate(context: vscode.ExtensionContext): AutoLsp {
  const extension = new AutoLsp(context);
  context.subscriptions.push(extension);
  return extension;
}
