import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import type { ContextConfig } from '../core/config.js';

export function excluded(uri: vscode.Uri, config: ContextConfig): boolean {
  return config.excludeGlobs.some(pattern => minimatch(uri.path, pattern, { dot: true }));
}

export class ContextCollector {
  private edits: { file: string; version: number; changes: { range: unknown; text: string }[] }[] = [];
  private touched = new Map<string, number>();

  record(event: vscode.TextDocumentChangeEvent, config: ContextConfig): void {
    if (excluded(event.document.uri, config) || !event.contentChanges.length) return;
    const file = event.document.uri.toString();
    this.touched.set(file, Date.now());
    this.edits.push({ file, version: event.document.version, changes: event.contentChanges.map(change => ({
      range: { start: { line: change.range.start.line, character: change.range.start.character },
        end: { line: change.range.end.line, character: change.range.end.character } }, text: change.text.slice(0, 10000),
    })) });
    this.edits = this.edits.slice(-100);
  }

  close(uri: vscode.Uri): void {
    this.touched.delete(uri.toString());
    this.edits = this.edits.filter(edit => edit.file !== uri.toString());
  }

  clear(): void { this.edits = []; this.touched.clear(); }

  collect(document: vscode.TextDocument, position: vscode.Position, config: ContextConfig): Record<string, unknown> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return {
      file: vscode.workspace.asRelativePath(document.uri), language: document.languageId,
      cursor: { line: position.line, character: position.character, encoding: 'utf-16' },
      before: text.slice(Math.max(0, offset - config.beforeChars), offset),
      after: text.slice(offset, offset + config.afterChars),
      recentEdits: config.recentEdits === 0 ? [] : this.edits
        .filter(edit => !excluded(vscode.Uri.parse(edit.file), config)
          && vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(edit.file))?.uri.toString() === folder?.uri.toString())
        .slice(-config.recentEdits)
        .map(edit => ({ ...edit, file: vscode.workspace.asRelativePath(vscode.Uri.parse(edit.file)),
          changes: edit.changes.map(change => ({ ...change, text: change.text.slice(0, config.editChars) })) })),
      otherOpenFiles: [...vscode.workspace.textDocuments]
        .filter(other => other !== document && !other.isClosed && ['file', 'untitled'].includes(other.uri.scheme)
          && !excluded(other.uri, config)
          && vscode.workspace.getWorkspaceFolder(other.uri)?.uri.toString() === folder?.uri.toString())
        .sort((a, b) => (this.touched.get(b.uri.toString()) ?? 0) - (this.touched.get(a.uri.toString()) ?? 0))
        .slice(0, config.otherOpenFiles)
        .map(other => ({ file: vscode.workspace.asRelativePath(other.uri), language: other.languageId,
          text: other.getText().slice(0, config.otherFileChars) })),
    };
  }
}
