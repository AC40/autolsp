# AutoLSP

A VS Code extension that asks **TypeSafe Jev** to rank the completions your installed language extensions already provide. It uses the current file around the cursor, recent edits, and optional excerpts from other open files.

**Inline mode** displays the highest-ranked eligible candidates as native ghost text. Press **Tab** to accept; use VS Code's next/previous inline suggestion commands to cycle.

**Auto mode** inserts a sufficiently high-scoring completion after a typing pause. It defaults to keywords only. Immediately press **Backspace** to revert the entire insertion, preserving the prefix you typed. Ordinary Undo also treats the insertion as a separate edit.

This repository was originally intended for Zed. It targets VS Code because Zed's public extension API does not expose the editor hooks these modes need. No custom editor build is required.

## Install

Requirements: VS Code 1.96+, Node.js 22+ for development, and a TypeSafe API key. Install your usual language extension first (for example, the built-in TypeScript support, Python/Pylance, or rust-analyzer).

```sh
npm ci
npm run package
code --install-extension autolsp-0.1.0.vsix
```

Alternatively, use **Extensions → … → Install from VSIX**, or open this repository in VS Code and press **F5** to launch the Extension Development Host.

Run **AutoLSP: Set TypeSafe API Key** from the Command Palette. The key is stored in VS Code SecretStorage. Alternatively, set `TYPESAFE_API_KEY` in the environment that launches VS Code. Remote SSH/containers run the extension in the remote extension host, so the environment variable belongs there. The extension does not automatically read keys from workspace `.env` files.

Inline mode is enabled by default. Ensure `editor.inlineSuggest.enabled` is enabled. For uninterrupted Jev suggestions, disable competing inline providers and optionally set `editor.quickSuggestions` to `false` for the relevant language; an open native suggestion popup can constrain what ghost text VS Code permits. Manual IntelliSense remains available via Ctrl+Space.

## Controls

| Action | Linux / Windows | macOS |
| --- | --- | --- |
| Accept visible AutoLSP ghost text | Tab | Tab |
| Switch inline / auto mode | Ctrl+Alt+M | Cmd+Alt+M |
| Suspend / resume | Ctrl+Alt+Space | Cmd+Alt+Space |
| Suspend for 30 seconds | Ctrl+Alt+Shift+Space | Cmd+Alt+Shift+Space |
| Revert the last automatic insertion | Backspace | Backspace |

Every binding can be changed in **Keyboard Shortcuts** (search `autolsp`). The status bar shows the current mode and can be clicked to pause/resume. The Command Palette also provides **Suggest Now**, **Show Ranked Completions**, and **Show Output**.

VS Code does not expose bare modifier key-down/key-up events to extensions. Temporary disabling therefore uses a modifier shortcut (toggle or timed suspension), not holding a modifier alone.

Backspace reverts an insertion only while the document version and caret match that insertion. With the caret elsewhere, Backspace retains its normal behavior; returning to the insertion endpoint without editing restores rollback availability. Further typing, switching editors, or another edit clears the receipt. Undoing an automatic insertion does not immediately reinsert it. Auto mode runs after single-character typing, not paste, deletion, or undo/redo, and does not run with multiple cursors or a selection.

## Customize

All **42 settings** appear in VS Code Settings under **AutoLSP**, with defaults, validation, and descriptions. Settings are language-overridable except the endpoint and API-key environment variable, which are user/machine settings. `autolsp.schema.json` describes the underlying configuration object; the VS Code settings use dotted names.

Example `settings.json`:

```jsonc
{
  "autolsp.mode": "inline",
  "autolsp.languages": ["typescript", "typescriptreact", "python", "rust"],
  "autolsp.ranking.model": "jev-latest",
  "autolsp.ranking.timeoutMs": 1200,
  "autolsp.ranking.debounceMs": 100,
  "autolsp.ranking.maxCandidates": 0,
  "autolsp.ranking.batchSize": 100,
  "autolsp.ranking.concurrency": 3,
  "autolsp.ranking.minScore": 0.55,
  "autolsp.auto.minScore": 0.95,
  "autolsp.auto.minMargin": 0.2,
  "autolsp.auto.kinds": ["Keyword"],
  "autolsp.auto.delayMs": 350,
  "autolsp.auto.minPrefixLength": 2,
  "autolsp.inline.maxSuggestions": 3,
  "autolsp.context.beforeChars": 8000,
  "autolsp.context.afterChars": 4000,
  "autolsp.context.recentEdits": 12,
  "autolsp.context.otherOpenFiles": 2,
  "autolsp.context.excludeGlobs": ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
  "[python]": {
    "autolsp.mode": "auto",
    "autolsp.auto.kinds": ["Keyword"],
    "autolsp.context.otherOpenFiles": 0
  }
}
```

The settings cover model/endpoint, prompts, score thresholds, permitted completion kinds, exact excluded labels, languages, context lengths, file exclusion globs, edit history, batching, concurrency, debounce, timeouts, caching, request budgets, error cooldowns, snippet support, fallback behavior, and suspension duration. Completion kind names follow `vscode.CompletionItemKind`, such as `Keyword`, `Function`, `Method`, `Variable`, and `Property`. An empty `auto.kinds` permits any kind that passes the other checks.

`ranking.maxCandidates: 0` evaluates every returned candidate after configured filters and duplicate removal. A positive limit ranks only that many and preserves the rest in provider order. Automatic insertion is disabled for capped results containing unscored candidates. Larger lists cost more requests and tokens; if the overall deadline or request budget is exceeded, the whole ranking falls back to provider ordering. Auto mode never inserts from that fallback.

Scores are Jev's estimated usefulness of each candidate, **not an independently measured probability that you will accept it**. Tune thresholds using your own workflow. The default auto threshold is deliberately conservative, so some reasonable candidates appear inline but do not auto-insert.

## How it works and limits

1. VS Code's public `vscode.executeCompletionItemProvider` command collects completions from the active providers for the document. Install/configure the desired language server through its normal extension.
2. AutoLSP captures bounded context and sends independent `noul` questions to `POST https://api.typesafe.ai/v1/systemone`, using `model: "jev-latest"` by default.
3. Every candidate gets a score. Independent scores can be sorted across batches; this avoids treating probabilities from separate Choice questions as comparable. Lists larger than 255 are supported.
4. Inline mode returns native `InlineCompletionItem`s. Auto mode applies a single editor transaction and keeps an exact rollback receipt. Results are discarded if the document, cursor, mode, or suspension state changes while the request is pending.

VS Code exposes the returned completion list, not the originating provider IDs. AutoLSP cannot select an individual LSP by name or extract extra candidates a provider did not return. Configure/disable providers through VS Code's normal language extensions to choose the underlying server. AutoLSP does not launch another LSP process.

The native IntelliSense popup cannot be globally reordered through this API. AutoLSP's ranking drives its ghost text and auto insertion; **Show Ranked Completions** is a separate read-only inspector showing all ranked items.

Candidates requiring additional edits (such as adding an import) or follow-up commands are still ranked, but are not applied through AutoLSP's inline/auto modes. The public inline API has no `additionalTextEdits` support; use the native completion popup for those candidates. By default all candidates are resolved to discover these side effects. With a positive `completion.resolveCount` limit, candidates beyond that limit are ranked but are not applied by AutoLSP. Auto mode also skips snippets, multiline text, and replacements extending past the caret. Inline mode permits compatible snippets. It does not generate new code or invent symbols.

Context is transmitted to TypeSafe when ranking is enabled. Excluded files are excluded from both current-file suggestions and contextual history/excerpts. Context comes only from open documents and observed edits; the extension does not crawl the repository. History is in memory, and the ranking cache retains hashes and scores. Output logs contain generic diagnostics, not source, API keys, or response bodies. Endpoint and credential variable settings ignore workspace overrides. Restricted workspaces are unsupported.

## Develop and test

```sh
npm ci
npm run check        # strict TypeScript
npm test             # deterministic HTTP, ranking, and edit-rollback tests
npm run test:host    # download and run VS Code extension-host integration tests
npm run test:live    # small real Jev smoke test; reads the ignored .env
npm run package     # build a self-contained VSIX
```

On headless Linux, run the host tests under a virtual display: `xvfb-run -a npm run test:host`.

`test:live` accepts either `TYPESAFE_API_KEY=...` or a bare temporary key in `.env`. It sends only the synthetic code fixture and prints scores, latency, and usage. It makes a billable API call and is intentionally excluded from `npm test` and CI.

The extension host tests use a local HTTP fixture and synthetic completions to exercise actual completion collection, native inline acceptance, timed automatic insertion, rollback, suspension, and stale-response rejection. They do not use your key. `npm run schema` regenerates the settings contributions and JSON schema from `core/config.ts`.

Source references: [TypeSafe API](https://docs.typesafe.ai/api), [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul), [VS Code completion command](https://code.visualstudio.com/api/references/commands#_commands), [VS Code inline completion API](https://code.visualstudio.com/api/references/vscode-api#InlineCompletionItemProvider).
