import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AutoLsp } from '../../extension/extension.js';
import { excluded } from '../../extension/context.js';
import { configSchema } from '../../core/config.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await sleep(25); }
}

export async function run(): Promise<void> {
  let requestDelay = 0;
  let needsImport = false;
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    await sleep(requestDelay);
    response.end(JSON.stringify({ answers: Object.fromEntries(body.state.candidates.map((item: any, index: number) =>
      [`c${index}`, { type: 'noul', noul: item.label === 'return' ? 0.999 : 0.01 }])) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = vscode.workspace.getConfiguration('autolsp');
  const set = (key: string, value: unknown) => settings.update(key, value, vscode.ConfigurationTarget.Global);
  const provider = vscode.languages.registerCompletionItemProvider('plaintext', {
    provideCompletionItems(document, position) {
      return ['retry', 'return', 'retrieve'].map(label => {
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
        item.range = document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
        return item;
      });
    },
    resolveCompletionItem(item) {
      if (needsImport && item.label === 'return') {
        item.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), 'import something;\n')];
      }
      return item;
    },
  });
  try {
    await set('endpoint', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`);
    await set('excludedLanguages', []);
    await set('ranking.debounceMs', 0);
    await set('ranking.timeoutMs', 3000);
    await set('auto.delayMs', 100);
    await set('mode', 'inline');
    await vscode.workspace.getConfiguration('editor').update('quickSuggestions', false, vscode.ConfigurationTarget.Global);
    // Disable background inline requests while directly testing the provider.
    await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', false, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension<AutoLsp>('autolsp-local.autolsp');
    assert.ok(extension, 'AutoLSP extension is loaded');
    const api = await extension.activate();
    let completedInlineRequests = 0;
    const provideInline = api.provideInlineCompletionItems.bind(api);
    api.provideInlineCompletionItems = async (...args) => {
      const result = await provideInline(...args);
      if (result.length && !args[3].isCancellationRequested) completedInlineRequests++;
      return result;
    };
    const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'ret' });
    const editor = await vscode.window.showTextDocument(document);
    const end = () => document.positionAt(document.getText().length);
    const moveEnd = () => { editor.selection = new vscode.Selection(end(), end()); };
    const replace = async (text: string) => {
      await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), end()), text));
      moveEnd(); await sleep(100);
    };
    moveEnd(); await sleep(150);
    const token = new vscode.CancellationTokenSource();
    const inline = await api.provideInlineCompletionItems(document, end(), {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined,
    }, token.token);
    assert.equal(inline[0]?.insertText, 'return');
    assert.equal(document.getText(), 'ret', 'Ghost text does not mutate the buffer');
    console.log('PASS inline provider: real completion collection → ranking → ghost text');

    // Exercise the actual VS Code ghost-text acceptance command, not a mock editor.
    const previousInlineRequests = completedInlineRequests;
    await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    await eventually(() => completedInlineRequests > previousInlineRequests, 15000);
    // Committing while a request is pending cancels it in VS Code. Wait for the
    // actual provider result and a render turn before invoking the Tab command.
    await sleep(300);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    await eventually(() => document.getText() === 'return');
    console.log('PASS native inline acceptance (the Tab binding invokes this command)');

    await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', false, vscode.ConfigurationTarget.Global);

    await set('mode', 'auto');
    await replace('ret');
    assert.equal(await api.autoInsert(), true);
    assert.equal(document.getText(), 'return');
    await vscode.commands.executeCommand('autolsp.undoInsertion');
    assert.equal(document.getText(), 'ret');
    await sleep(200);
    assert.equal(document.getText(), 'ret', 'Rollback must not retrigger insertion');
    console.log('PASS auto insertion and full Backspace-command rollback');

    await replace('re');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('type', { text: 't' });
    assert.equal(document.getText(), 'ret', 'Typing command must target the fixture editor');
    await eventually(() => document.getText() === 'return');
    await vscode.commands.executeCommand('autolsp.undoInsertion');
    assert.equal(document.getText(), 'ret');
    console.log('PASS typing triggers automatic insertion after the idle delay');

    api.setSuspended(true);
    assert.equal(await api.autoInsert(), false);
    api.setSuspended(false);
    await replace('ret');
    requestDelay = 350;
    await set('ranking.cacheEntries', 0);
    const before = bodies.length;
    const pending = api.autoInsert();
    await eventually(() => bodies.length > before);
    await replace('retx');
    assert.equal(await pending, false);
    assert.equal(document.getText(), 'retx', 'Stale API results must never insert');
    requestDelay = 0;
    console.log('PASS suspend and stale-result cancellation');

    needsImport = true;
    await replace('ret');
    assert.equal(await api.autoInsert(), false, 'Resolved side effects must prevent automatic application');
    needsImport = false;
    await set('completion.resolveCount', 1);
    await replace('ret');
    assert.equal(await api.autoInsert(), false, 'An unresolved high-ranked candidate must not be applied');
    await set('completion.resolveCount', 0);
    console.log('PASS completion resolution and additional-edit restrictions');

    // A normal edit invalidates the special Backspace action; it becomes deleteLeft.
    await replace('ret');
    assert.equal(await api.autoInsert(), true);
    await vscode.commands.executeCommand('type', { text: ' ' });
    await vscode.commands.executeCommand('autolsp.undoInsertion');
    assert.equal(document.getText(), 'return');
    console.log('PASS Backspace falls back after subsequent user editing');
    assert.ok(bodies.some(body => body.state.recentEdits.length > 0), 'Recent edits reached the ranking API');
    assert.ok(bodies.every(body => body.state.cursor.encoding === 'utf-16'));
    assert.equal(excluded(vscode.Uri.file('/project/.env'), configSchema.parse({}).context), true);
    assert.equal(excluded(vscode.Uri.file('/project/.env.local'), configSchema.parse({}).context), true);
    assert.equal(excluded(vscode.Uri.file('/project/main.ts'), configSchema.parse({}).context), false);
    const scoped = vscode.workspace.getConfiguration('autolsp', document);
    await scoped.update('mode', 'inline', vscode.ConfigurationTarget.Global, true);
    assert.equal(api.settings(document).mode, 'inline');
    await vscode.commands.executeCommand('autolsp.toggleMode');
    assert.equal(api.settings(document).mode, 'auto');
    await scoped.update('mode', undefined, vscode.ConfigurationTarget.Global, true);
    console.log('PASS exclusions and per-language mode customization');
    token.dispose();
    console.log('AutoLSP extension-host tests passed.');
  } finally {
    provider.dispose(); server.closeAllConnections(); server.close();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}
