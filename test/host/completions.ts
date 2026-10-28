import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { AutoLsp } from '../../extension/extension.js';
import { collect, normalize, CompletionProviderTimeoutError } from '../../extension/completions.js';
import { configSchema } from '../../core/config.js';

export async function run(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('autolsp');
  const set = (key: string, value: unknown) => settings.update(key, value, vscode.ConfigurationTarget.Global);
  await set('enabled', true);
  await set('mode', 'inline');
  await set('ranking.enabled', false);
  await set('ranking.debounceMs', 0);
  await set('excludedLanguages', []);
  await set('completion.resolveCount', undefined);
  await vscode.workspace.getConfiguration('editor').update('inlineSuggest.enabled', false, vscode.ConfigurationTarget.Global);
  const api = await vscode.extensions.getExtension<AutoLsp>('autolsp-local.autolsp')!.activate();
  const token = new vscode.CancellationTokenSource();
  const suggest = async (language: string, content: string, offset = content.length) => {
    const document = await vscode.workspace.openTextDocument({ language, content });
    const editor = await vscode.window.showTextDocument(document);
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    await new Promise(resolve => setTimeout(resolve, 150));
    const deadline = Date.now() + 5000;
    do {
      const items = await api.provideInlineCompletionItems(document, position,
        { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, token.token);
      if (items.length) return items;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return [];
  };
  let accepted = 0;
  const command = vscode.commands.registerCommand('autolsp.testAccepted', (value: number) => { accepted += value; });
  const provider = vscode.languages.registerCompletionItemProvider('plaintext', {
    provideCompletionItems() {
      const item = new vscode.CompletionItem('return', vscode.CompletionItemKind.Keyword);
      item.command = { command: 'autolsp.testAccepted', title: 'Accepted', arguments: [7] };
      return [item];
    },
  });
  try {
    const items = await suggest('plaintext', 'ret');
    assert.equal(items[0]?.insertText, 'return', 'Command-bearing completions must produce ghost text');
    assert.equal(accepted, 0, 'Requesting ghost text must not execute its command');
    await vscode.commands.executeCommand(items[0].command!.command, ...(items[0].command!.arguments ?? []));
    assert.equal(accepted, 7, 'Acceptance must preserve the provider command and its arguments');
    console.log('PASS command-bearing inline suggestions and acceptance');

    const keywordDocument = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'el' });
    const keywordPosition = keywordDocument.positionAt(2);
    const keyword = new vscode.CompletionItem('else', vscode.CompletionItemKind.Keyword);
    keyword.command = { command: '_typescript.applyCompletionCommand', title: '' };
    const autoConfig = configSchema.parse({ mode: 'auto', auto: { kinds: [] } });
    const eligibility = () => normalize([keyword], keywordDocument, keywordPosition, autoConfig, new Set())[0]?.eligible;
    assert.equal(eligibility(), true, 'A plain TS keyword does not need eager resolution');
    keyword.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), 'import something;\n')];
    assert.equal(eligibility(), false, 'Additional edits must prevent the keyword exception');
    keyword.additionalTextEdits = undefined;
    keyword.insertText = new vscode.SnippetString('else${1: body}');
    assert.equal(eligibility(), false, 'Snippets must prevent the keyword exception');
    keyword.insertText = undefined;
    keyword.command = { command: 'autolsp.testAccepted', title: '' };
    assert.equal(eligibility(), false, 'An arbitrary command must not gain automatic execution');
    console.log('PASS automatic keyword side-effect restrictions');

    await vscode.extensions.getExtension('vscode.typescript-language-features')!.activate();
    for (const [content, expected] of [
      ['const t = () => {};\nt.app', 'apply'],
      ['const foo = async () => {\n if (true) {\n } el', 'else'],
    ]) {
      const items = await suggest('typescript', content);
      assert.ok(items.some(item => item.insertText === expected), `TypeScript ${expected} must produce ghost text`);
      const selected = items.find(item => item.insertText === expected)!;
      const editor = vscode.window.activeTextEditor!;
      await editor.edit(edit => edit.replace(selected.range!, selected.insertText as string));
      const providerCommand = selected.command!.arguments![0] as vscode.Command;
      // Execute directly so any provider failure fails the test instead of
      // being caught by the user-facing acceptance handler.
      await vscode.commands.executeCommand(providerCommand.command, ...(providerCommand.arguments ?? []));
      assert.ok(editor.document.getText().endsWith(expected));
      console.log(`PASS real TypeScript ${expected} suggestion`);
    }

    let slowResolutions = 0;
    const slow = vscode.languages.registerCompletionItemProvider({ language: 'markdown', scheme: 'untitled' }, {
      provideCompletionItems() {
        return Array.from({ length: 25 }, (_, i) => {
          const item = new vscode.CompletionItem(`ret${String(i).padStart(2, '0')}`, vscode.CompletionItemKind.Keyword);
          return item;
        });
      },
      async resolveCompletionItem(item) {
        if (item.label === 'ret24') {
          slowResolutions++;
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        return item;
      },
    });
    try {
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: 'ret' });
      const position = document.positionAt(3);
      const defaults = configSchema.parse({ completion: { providerTimeoutMs: 400 } });
      const results = await collect(document, position, defaults, new AbortController().signal);
      assert.equal(slowResolutions, 0, 'Default resolution must not wait for the slow tail');
      assert.equal(results.filter(item => item.eligible).length, 20);
      assert.equal(results.length, 25, 'Resolution limits must preserve ranking candidates');
      await assert.rejects(collect(document, position,
        configSchema.parse({ completion: { resolveCount: 0, providerTimeoutMs: 100 } }),
        new AbortController().signal), CompletionProviderTimeoutError);
      console.log('PASS bounded resolution and identifiable provider timeout');
    } finally { slow.dispose(); }
  } finally {
    command.dispose(); provider.dispose(); token.dispose();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}
