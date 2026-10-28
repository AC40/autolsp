/** A completion that can be inserted and exactly reverted without snippet side effects. */
export interface Insertion {
  start: number;
  end: number;
  text: string;
}
export interface Receipt {
  uri: string;
  version: number;
  start: number;
  inserted: string;
  original: string;
  cursor: number;
}

export function receiptFor(uri: string, version: number, originalText: string, edit: Insertion): Receipt {
  return { uri, version, start: edit.start, inserted: edit.text,
    original: originalText.slice(edit.start, edit.end), cursor: edit.start + edit.text.length };
}

export function canRevert(receipt: Receipt, uri: string, version: number, text: string, cursor: number): boolean {
  return receipt.uri === uri && receipt.version === version && receipt.cursor === cursor
    && text.slice(receipt.start, receipt.start + receipt.inserted.length) === receipt.inserted;
}

export function inverse(receipt: Receipt): Insertion {
  return { start: receipt.start, end: receipt.start + receipt.inserted.length, text: receipt.original };
}

export function isAutoEligible(kind: string, text: string, prefix: string,
  score: number | undefined, nextScore: number | undefined,
  config: { kinds: string[]; minScore: number; minMargin: number; minPrefixLength: number; maxInsertChars: number; requireReversible?: boolean }): boolean {
  return autoIneligibilityReason(kind, text, prefix, score, nextScore, config) === undefined;
}

export function autoIneligibilityReason(kind: string, text: string, prefix: string,
  score: number | undefined, nextScore: number | undefined,
  config: { kinds: string[]; minScore: number; minMargin: number; minPrefixLength: number; maxInsertChars: number; requireReversible?: boolean }): string | undefined {
  if (score === undefined) return 'The best candidate has no Jev score.';
  if (score < config.minScore) return `Best score ${score.toFixed(3)} is below auto.minScore ${config.minScore}.`;
  const margin = score - (nextScore ?? 0);
  if (margin < config.minMargin) return `Score lead ${margin.toFixed(3)} is below auto.minMargin ${config.minMargin} (best ${score.toFixed(3)}, next ${(nextScore ?? 0).toFixed(3)}).`;
  if (config.kinds.length && !config.kinds.includes(kind)) return `Completion kind ${kind} is excluded by auto.kinds.`;
  if (prefix.length < config.minPrefixLength) return `Prefix length ${prefix.length} is below auto.minPrefixLength ${config.minPrefixLength}.`;
  if (!text.startsWith(prefix)) return 'The candidate does not extend the typed prefix.';
  if (text.length <= prefix.length) return 'The candidate adds no text.';
  if (text.length > config.maxInsertChars) return `Insertion length ${text.length} exceeds auto.maxInsertChars ${config.maxInsertChars}.`;
  if (config.requireReversible !== false && /[\r\n]/.test(text)) return 'Automatic insertion excludes multiline text.';
  return undefined;
}
