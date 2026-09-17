import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import { configSchema } from '../core/config.js';
import { JevRanker, type Candidate } from '../core/ranker.js';

// Accept the user's existing bare-key file as well as conventional dotenv syntax.
const contents = readFileSync('.env', 'utf8').trim();
const parsed = parseEnv(contents);
const apiKey = process.env.TYPESAFE_API_KEY ?? parsed.TYPESAFE_API_KEY ?? (!contents.includes('\n') && !contents.includes('=') ? contents : undefined);
if (!apiKey) throw new Error('No temporary API key found. Expected TYPESAFE_API_KEY or a bare key in .env.');
const config = configSchema.parse({ ranking: { timeoutMs: 15000, cacheEntries: 0 } });
const candidates: Candidate[] = ['break', 'return', 'continue', 'throw'].map((label, index) => ({
  id: `c${index}`, label, kind: 'Keyword', insertText: label,
}));
const result = await new JevRanker().rank(candidates, {
  file: 'synthetic-example.ts', language: 'typescript', cursor: { line: 2, character: 2, encoding: 'utf-16' },
  before: 'function double(value: number): number {\n  const result = value * 2;\n  ',
  after: ' result;\n}', recentEdits: [], otherOpenFiles: [],
}, config, apiKey, new AbortController().signal);
assert.equal(result.source, 'jev', result.reason);
assert.equal(result.items.length, candidates.length);
assert.ok(result.items.every(item => typeof item.score === 'number'));
console.log(JSON.stringify({ source: result.source, elapsedMs: result.elapsedMs, usage: result.usage,
  ranking: result.items.map(item => ({ label: item.candidate.label, score: item.score })) }, null, 2));
assert.equal(result.items[0].candidate.label, 'return', 'Expected return in the synthetic function example');
console.log('Live Jev API smoke test passed. Only synthetic code was submitted.');
