import { createHash } from 'node:crypto';
import type { Config } from './config.js';

export interface Candidate {
  id: string;
  label: string;
  kind: string;
  insertText: string;
  detail?: string;
  documentation?: string;
}
export interface RankedCandidate { candidate: Candidate; score?: number }
export interface Ranking {
  items: RankedCandidate[];
  source: 'jev' | 'cache' | 'lsp';
  reason?: string;
  elapsedMs: number;
  usage?: { input_tokens: number; output_tokens: number };
}
interface CacheEntry { expires: number; scores: number[] }

export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Scores each candidate independently, so scores remain comparable across batches. */
export class JevRanker {
  private cache = new Map<string, CacheEntry>();
  private requests: number[] = [];
  private cooldownUntil = 0;

  clear(): void { this.cache.clear(); }

  async rank(candidates: Candidate[], context: Record<string, unknown>, config: Config,
    apiKey: string | undefined, signal: AbortSignal): Promise<Ranking> {
    const start = Date.now();
    const fallback = (reason: string): Ranking => ({
      items: candidates.map(candidate => ({ candidate })), source: 'lsp', reason, elapsedMs: Date.now() - start,
    });
    signal.throwIfAborted();
    if (!config.ranking.enabled) return fallback('Ranking disabled');
    if (!candidates.length) return fallback('No candidates');
    if (!apiKey) return fallback('API key not configured');
    if (Date.now() < this.cooldownUntil) return fallback('API cooling down');
    const options = config.ranking;
    const count = options.maxCandidates || candidates.length;
    const selected = candidates.slice(0, count);
    // Cache only hashes and scores; no source text or credentials are retained here.
    const key = hash([context, selected, options.model, options.instructions, config.endpoint, hash(apiKey)]);
    const cached = this.cache.get(key);
    const finish = (scores: number[], source: 'jev' | 'cache', usage?: Ranking['usage']): Ranking => ({
      items: [
        ...selected.map((candidate, index) => ({ candidate, score: scores[index] }))
          .sort((a, b) => b.score - a.score),
        ...candidates.slice(selected.length).map(candidate => ({ candidate })),
      ], source, elapsedMs: Date.now() - start, usage,
    });
    if (cached && cached.expires > Date.now()) return finish(cached.scores, 'cache');
    this.cache.delete(key);
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new Error('Ranking timed out')), options.timeoutMs);
    const scores: number[] = new Array(selected.length);
    const usage = { input_tokens: 0, output_tokens: 0 };
    let next = 0;
    try {
      const worker = async () => {
        while (next < selected.length) {
          combined.throwIfAborted();
          const first = next;
          next += options.batchSize;
          const batch = selected.slice(first, first + options.batchSize);
          this.requests = this.requests.filter(time => time > Date.now() - 60000);
          if (this.requests.length >= options.maxRequestsPerMinute) throw new Error('Local request budget reached');
          this.requests.push(Date.now());
          const descriptions = batch.map(candidate => ({
            label: candidate.label.slice(0, config.context.candidateChars), kind: candidate.kind,
            insertText: candidate.insertText.slice(0, config.context.candidateChars),
            detail: candidate.detail?.slice(0, config.context.candidateChars),
            documentation: candidate.documentation?.slice(0, config.context.candidateChars),
          }));
          const questions = Object.fromEntries(batch.map((_, index) => [`c${index}`, {
            type: 'noul',
            instructions: `${options.instructions}\nEvaluate only the candidate at state.candidates[${index}].`,
          }]));
          const response = await fetch(config.endpoint, {
            method: 'POST', signal: combined, redirect: 'error',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: options.model, state: { ...context, candidates: descriptions }, questions }),
          });
          if (!response.ok) {
            if ([401, 403, 429, 529].includes(response.status)) {
              this.cooldownUntil = Date.now() + options.cooldownMs;
            }
            await response.body?.cancel();
            // Do not log server response bodies, which can echo user data.
            throw new Error(`TypeSafe HTTP ${response.status}`);
          }
          const json = await response.json() as { answers?: Record<string, { type?: string; noul?: number }>; usage?: Ranking['usage'] };
          for (let index = 0; index < batch.length; index++) {
            const answer = json.answers?.[`c${index}`];
            if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
              throw new Error('Invalid TypeSafe answer');
            }
            scores[first + index] = answer.noul;
          }
          usage.input_tokens += json.usage?.input_tokens ?? 0;
          usage.output_tokens += json.usage?.output_tokens ?? 0;
        }
      };
      // Consume every worker rejection before returning, including aborted siblings.
      const workers = Array.from({ length: Math.min(options.concurrency, Math.ceil(selected.length / options.batchSize)) },
        () => worker().catch(error => { timeout.abort(error); throw error; }));
      const results = await Promise.allSettled(workers);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      signal.throwIfAborted();
      if (options.cacheEntries > 0) {
        while (this.cache.size >= options.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { scores, expires: Date.now() + options.cacheTtlMs });
      }
      return finish(scores, 'jev', usage);
    } catch (error) {
      signal.throwIfAborted();
      const message = error instanceof Error ? error.message : '';
      const safe = /^(TypeSafe HTTP \d+|Invalid TypeSafe answer|Local request budget reached|Ranking timed out)$/.test(message);
      return fallback(safe ? message : 'TypeSafe request failed or timed out');
    } finally { clearTimeout(timer); }
  }
}
