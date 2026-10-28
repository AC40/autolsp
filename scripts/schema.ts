import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { configSchema } from '../core/config.js';

const descriptions: Record<string, string> = {
  enabled: 'Enable AutoLSP suggestions.',
  mode: 'Inline: ghost text accepted with Tab. Auto: insert the highest-ranked eligible completion after typing.',
  endpoint: 'TypeSafe System One endpoint. User/machine setting only; workspace values are ignored.',
  apiKeyEnv: 'Environment variable containing the API key; SecretStorage takes precedence. Workspace values are ignored.',
  languages: 'Enabled VS Code language IDs. Use * for every language.',
  excludedLanguages: 'Language IDs that must never be sent to Jev.',
  suspendDurationMs: 'Duration of the Temporarily Suspend command, in milliseconds.',
  'ranking.enabled': 'Send candidates to Jev for ranking. When disabled, inline mode can use LSP ordering.',
  'ranking.model': 'TypeSafe model ID.',
  'ranking.timeoutMs': 'Total Jev ranking deadline across all batches, in milliseconds.',
  'ranking.debounceMs': 'Wait this long before collecting and ranking completions.',
  'ranking.batchSize': 'Number of independent candidate questions per API request.',
  'ranking.concurrency': 'Maximum concurrent API batches for one ranking.',
  'ranking.maxCandidates': 'Candidate limit; 0 ranks all returned candidates. A capped ranking never auto-inserts.',
  'ranking.maxRequestsPerMinute': 'Local API request budget per extension host.',
  'ranking.cooldownMs': 'Pause API calls after authentication errors, throttling, or overload.',
  'ranking.cacheEntries': 'Maximum in-memory ranking cache entries. 0 disables caching.',
  'ranking.cacheTtlMs': 'Ranking cache lifetime in milliseconds.',
  'ranking.minScore': 'Minimum Jev usefulness score for an inline suggestion. This is not a measured acceptance rate.',
  'ranking.instructions': 'Question used to score each candidate. Candidate index is appended automatically.',
  'context.beforeChars': 'Maximum characters before the cursor sent to Jev.',
  'context.afterChars': 'Maximum characters after the cursor sent to Jev.',
  'context.recentEdits': 'Number of recent edits from the same workspace folder included in context; 0 disables.',
  'context.editChars': 'Maximum inserted characters included per recorded edit.',
  'context.otherOpenFiles': 'Number of other open files from the same workspace folder included; 0 disables.',
  'context.otherFileChars': 'Maximum characters included from each other open file.',
  'context.candidateChars': 'Maximum characters per candidate description field sent to Jev.',
  'context.excludeGlobs': 'Files matching these globs are excluded from suggestions, edit history, and context.',
  'auto.minScore': 'Minimum Jev usefulness score required for automatic insertion.',
  'auto.requireReversible': 'Require completions that support full Backspace rollback. Disable to allow provider commands, additional edits, snippets, and broader replacements; those completions use normal Undo instead.',
  'auto.minMargin': 'Required score lead over the runner-up. Noul scores are independent, not a sum-to-one distribution.',
  'auto.kinds': 'Allowed VS Code CompletionItemKind names for auto-insertion; empty means all kinds. Default: Keyword.',
  'auto.minPrefixLength': 'Minimum typed prefix length for automatic insertion.',
  'auto.delayMs': 'Idle time after typing before requesting an automatic insertion.',
  'auto.maxInsertChars': 'Maximum total replacement length for automatic insertion.',
  'inline.maxSuggestions': 'Maximum ranked ghost-text suggestions available for cycling.',
  'inline.minPrefixLength': 'Minimum typed prefix length for inline suggestions.',
  'inline.snippets': 'Allow snippet suggestions in inline mode. For automatic snippets, disable auto.requireReversible.',
  'inline.fallbackToLsp': 'Offer eligible completions in LSP order when Jev is unavailable.',
  'completion.resolveCount': 'Resolve up to this many provider items; 0 resolves all and can be slow. Unresolved items require supported deferred acceptance or must be plain TypeScript/JavaScript keywords.',
  'completion.providerTimeoutMs': 'Maximum time to wait for VS Code completion providers.',
  'completion.includeKinds': 'Rank only these CompletionItemKind names; empty ranks all kinds.',
  'completion.excludeLabels': 'Exact completion labels to exclude.',
};
const schema = z.toJSONSchema(configSchema) as any;
const properties: Record<string, unknown> = {};
for (const [key, value] of Object.entries(schema.properties) as [string, any][]) {
  const entries = value.type === 'object' ? Object.entries(value.properties).map(([child, v]) => [`${key}.${child}`, v]) : [[key, value]];
  for (const [name, field] of entries as [string, any][]) {
    if (!descriptions[name]) throw new Error(`Missing setting description: ${name}`);
    properties[`autolsp.${name}`] = { ...field, description: descriptions[name],
      scope: ['endpoint', 'apiKeyEnv'].includes(name) ? 'machine' : 'language-overridable' };
  }
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
manifest.contributes.configuration = { title: 'AutoLSP', properties };
writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\n');
writeFileSync('autolsp.schema.json', JSON.stringify(schema, null, 2) + '\n');
console.log(`Generated ${Object.keys(properties).length} VS Code settings.`);
