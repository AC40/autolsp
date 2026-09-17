import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configSchema } from '../core/config.js';
import { JevRanker, type Candidate } from '../core/ranker.js';

async function server(handler: (body: any, response: import('node:http').ServerResponse) => void) {
  const requests: any[] = [];
  const http = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    handler(body, response);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return { requests, endpoint: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/systemone`,
    close: () => { http.closeAllConnections(); http.close(); } };
}
function candidates(count: number): Candidate[] {
  return Array.from({ length: count }, (_, i) => ({ id: `c${i}`, label: `label${i}`, kind: 'Keyword', insertText: `item${i}` }));
}
const signal = () => new AbortController().signal;

test('ranks ALL 520 suggestions with comparable per-candidate scores, caching, and stable ties', async t => {
  const api = await server((body, response) => {
    assert.equal(body.model, 'jev-latest');
    for (const [key, question] of Object.entries(body.questions) as [string, any][]) {
      assert.equal(question.type, 'noul');
      assert.ok(question.instructions.includes(`state.candidates[${key.slice(1)}]`));
    }
    response.end(JSON.stringify({ answers: Object.fromEntries(body.state.candidates.map((c: Candidate, i: number) =>
      [`c${i}`, { type: 'noul', noul: Number(c.label.slice(5)) / 520 }])) }));
  });
  t.after(api.close);
  const config = configSchema.parse({ endpoint: api.endpoint, ranking: { batchSize: 100, timeoutMs: 3000 } });
  const ranker = new JevRanker();
  const input = candidates(520);
  const ranked = await ranker.rank(input, { before: 'abc' }, config, 'test-only', signal());
  assert.equal(ranked.source, 'jev');
  assert.equal(ranked.items.length, 520);
  assert.equal(ranked.items[0].candidate.label, 'label519');
  assert.equal(api.requests.length, 6);
  assert.ok(api.requests.every(body => Object.keys(body.questions).length <= 100));
  assert.equal((await ranker.rank(input, { before: 'abc' }, config, 'test-only', signal())).source, 'cache');
  assert.equal((await ranker.rank(input, { before: 'changed' }, config, 'test-only', signal())).source, 'jev');
});

test('a malformed batch fails the entire ranking back to the original list', async t => {
  const api = await server((_, response) => response.end(JSON.stringify({ answers: { c0: { type: 'noul', noul: 7 } } })));
  t.after(api.close);
  const input = candidates(3);
  const ranked = await new JevRanker().rank(input, {}, configSchema.parse({ endpoint: api.endpoint }), 'test', signal());
  assert.equal(ranked.source, 'lsp');
  assert.equal(ranked.reason, 'Invalid TypeSafe answer');
  assert.deepEqual(ranked.items.map(i => i.candidate), input);
});

test('timeout falls back, explicit cancellation rejects, and 429 starts cooldown', async t => {
  const slow = await server(() => {});
  t.after(slow.close);
  const config = configSchema.parse({ endpoint: slow.endpoint, ranking: { timeoutMs: 50 } });
  assert.equal((await new JevRanker().rank(candidates(2), {}, config, 'test', signal())).source, 'lsp');
  const controller = new AbortController();
  const pending = new JevRanker().rank(candidates(2), {}, config, 'test', controller.signal);
  controller.abort();
  await assert.rejects(pending);
  const api = await server((_, response) => { response.writeHead(429); response.end('private error body'); });
  t.after(api.close);
  const ranker = new JevRanker();
  const throttled = configSchema.parse({ endpoint: api.endpoint });
  assert.equal((await ranker.rank(candidates(2), {}, throttled, 'test', signal())).reason, 'TypeSafe HTTP 429');
  assert.equal((await ranker.rank(candidates(2), {}, throttled, 'test', signal())).reason, 'API cooling down');
  assert.equal(api.requests.length, 1);
});

test('missing key makes no calls and candidate caps retain the unscored tail', async t => {
  const api = await server((body, response) => response.end(JSON.stringify({ answers: Object.fromEntries(
    Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) })));
  t.after(api.close);
  const config = configSchema.parse({ endpoint: api.endpoint, ranking: { maxCandidates: 2 } });
  const ranker = new JevRanker();
  assert.equal((await ranker.rank(candidates(4), {}, config, undefined, signal())).source, 'lsp');
  assert.equal(api.requests.length, 0);
  const result = await ranker.rank(candidates(4), {}, config, 'test', signal());
  assert.deepEqual(result.items.map(item => item.score), [0.9, 0.9, undefined, undefined]);
});

test('strict configuration validates ranges and rejects misspelled settings', () => {
  assert.throws(() => configSchema.parse({ auto: { minScore: 1.2 } }));
  assert.throws(() => configSchema.parse({ ranking: { batchSze: 10 } }));
  assert.equal(configSchema.parse({}).ranking.maxCandidates, 0);
});
