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
  config: { kinds: string[]; minScore: number; minMargin: number; minPrefixLength: number; maxInsertChars: number }): boolean {
  return score !== undefined && score >= config.minScore && score - (nextScore ?? 0) >= config.minMargin
    && (config.kinds.length === 0 || config.kinds.includes(kind))
    && prefix.length >= config.minPrefixLength && text.startsWith(prefix)
    && text.length > prefix.length && text.length <= config.maxInsertChars && !/[\r\n]/.test(text);
}
