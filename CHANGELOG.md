# Changelog

## 0.1.4

- Add `auto.requireReversible`, enabled by default. Disable it to automatically apply provider commands, import edits, snippets, and broader replacement ranges using normal Undo.
- Test real TypeScript function, method, and variable completions alongside command execution, snippet/import edits, and strict-mode restrictions.

## 0.1.3

- Explain skipped automatic insertions in Output and the status tooltip, including score thresholds, score margins, provider fallback, and edit triggers.
- Log the activated extension version to distinguish installed updates from the running version.

## 0.1.2

- Restore automatic insertion of plain TypeScript and JavaScript keywords without running their deferred acceptance command.
- Avoid eager TypeScript completion resolution in auto mode and verify typing `el` inserts `else`, with full Backspace rollback.

## 0.1.1

- Restore TypeScript inline suggestions by preserving provider acceptance commands and deferring their detail requests until acceptance.
- Bound other providers' default resolution to 20 items and filter out candidates that cannot extend the typed prefix.
- Report completion provider timeouts and the failing request stage.
- Cover TypeScript suggestions and slow providers in editor integration tests.

## 0.1.0

- VS Code inline and keyword auto-insertion modes using existing completion providers.
- Jev System One candidate ranking with cursor/file/edit-history context.
- Atomic Backspace rollback and modifier shortcuts for pause and timed suspension.
- 42 configurable settings, with per-language overrides.
- API timeouts, cancellation, bounded request budget, caching, cooldowns, and LSP fallback.
- Unit, extension-host, and opt-in live API tests.
