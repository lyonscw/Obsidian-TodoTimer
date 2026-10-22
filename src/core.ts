import { parser, TaskList } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

export interface Entry {
  kind: 'task' | 'record';
  /** Start and end of the complete first line, excluding its line ending. */
  from: number;
  to: number;
  line: number;
  text: string;
  contentFrom: number;
  parentTaskFrom?: number;
  checked?: boolean;
  checkboxFrom?: number;
  hasContent: boolean;
}

export interface TimestampRange {
  from: number;
  to: number;
  kind: 'created' | 'completed' | 'record';
}

interface Line {
  from: number;
  to: number;
  text: string;
}

interface SuffixPart {
  from: number;
  to: number;
  separatorFrom: number;
}

interface Suffix {
  end: number;
  bodyEnd: number;
  created?: SuffixPart;
  completed?: SuffixPart;
  record?: SuffixPart;
}

const markdownParser = parser.configure(TaskList);
const TIME = String.raw`\d{4}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d`;
const CREATED = new RegExp(String.raw`([ \t]+)((?:📝|💪|\[🆕\]) ${TIME})$`, 'u');
const COMPLETED = new RegExp(String.raw`([ \t]+)((?:✅|\[✅\]) ${TIME})$`, 'u');
const RECORD_TIME = new RegExp(String.raw`([ \t]+)(${TIME})$`, 'u');

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  while (from <= source.length) {
    const newline = source.indexOf('\n', from);
    const end = newline < 0 ? source.length : newline;
    const to = end > from && source[end - 1] === '\r' ? end - 1 : end;
    lines.push({ from, to, text: source.slice(from, to) });
    if (newline < 0) break;
    from = newline + 1;
  }
  return lines;
}

function lineAt(lines: Line[], position: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle].from <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Frontmatter is not Markdown. Mask it without changing source offsets. */
function withoutFrontmatter(source: string, lines: Line[]): string {
  if (!/^\uFEFF?---[ \t]*$/.test(lines[0].text)) return source;
  const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line.text));
  const end = closing < 0 ? source.length : lines[closing].to;
  return source.slice(0, end).replace(/[^\r\n]/g, ' ') + source.slice(end);
}

function suffixPart(match: RegExpExecArray): SuffixPart {
  return {
    from: match.index + match[1].length,
    to: match.index + match[0].length,
    separatorFrom: match.index,
  };
}

/** Only the canonical end-of-line suffix is metadata; similar body text is left alone. */
function suffixOf(text: string, kind: Entry['kind']): Suffix {
  const end = text.trimEnd().length;
  const suffix: Suffix = { end, bodyEnd: end };
  if (kind === 'record') {
    const match = RECORD_TIME.exec(text.slice(0, end));
    if (match) {
      suffix.record = suffixPart(match);
      suffix.bodyEnd = match.index;
    }
    return suffix;
  }
  const completed = COMPLETED.exec(text.slice(0, suffix.bodyEnd));
  if (completed) {
    suffix.completed = suffixPart(completed);
    suffix.bodyEnd = completed.index;
  }
  const created = CREATED.exec(text.slice(0, suffix.bodyEnd));
  if (created) {
    suffix.created = suffixPart(created);
    suffix.bodyEnd = created.index;
  }
  return suffix;
}

/** Parse real list structure, including lists in blockquotes, rather than guessing indentation. */
function parseEntriesUncached(source: string): Entry[] {
  const lines = linesOf(source);
  const tree = markdownParser.parse(withoutFrontmatter(source, lines));
  const entries = new Map<number, Entry>();

  function visit(node: SyntaxNode, parentTaskFrom?: number): void {
    let enclosingTask = parentTaskFrom;
    if (node.name === 'ListItem') {
      const mark = node.getChild('ListMark');
      if (mark) {
        const index = lineAt(lines, mark.from);
        const line = lines[index];
        let contentFrom = mark.to;
        while (contentFrom < line.to && /[ \t]/.test(source[contentFrom])) contentFrom++;
        const checkbox = /^\[([ xX])\](?:[ \t]+|$)/.exec(source.slice(contentFrom, line.to));
        const firstBlock = mark.nextSibling;
        const excluded = firstBlock && ['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(firstBlock.name);
        if (checkbox || (parentTaskFrom !== undefined && !excluded)) {
          const checkboxFrom = checkbox ? contentFrom : undefined;
          if (checkbox) contentFrom += checkbox[0].length;
          const kind = checkbox ? 'task' : 'record';
          const suffix = suffixOf(line.text, kind);
          const entry: Entry = {
            kind,
            from: line.from,
            to: line.to,
            line: index,
            text: line.text,
            contentFrom,
            parentTaskFrom,
            ...(checkbox ? { checked: checkbox[1].toLowerCase() === 'x', checkboxFrom } : {}),
            hasContent: source.slice(contentFrom, line.from + suffix.bodyEnd).trim().length > 0,
          };
          // A nested list can start on its parent's first line. Keep its actual entry once.
          entries.set(line.from, entry);
          if (checkbox) enclosingTask = entry.from;
        }
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, enclosingTask);
  }
  visit(tree.topNode);
  return [...entries.values()].sort((a, b) => a.from - b.from);
}

// A transaction filter, state field and decorations inspect the same immutable text.
// Reuse that parse without retaining a cache of the user's document history.
let cachedSource: string | undefined;
let cachedEntries: Entry[] = [];

export function parseEntries(source: string): Entry[] {
  if (source !== cachedSource) {
    cachedEntries = parseEntriesUncached(source);
    cachedSource = source;
  }
  // Adapters own their arrays; callers cannot accidentally mutate the cached parse.
  return cachedEntries.map(entry => ({ ...entry }));
}

export function formatTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Cannot format an invalid date');
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}${two(date.getMonth() + 1)}${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function isCurrentEntry(source: string, entry: Entry): boolean {
  return entry.from >= 0 && entry.to <= source.length && source.slice(entry.from, entry.to) === entry.text;
}

export function creationChange(source: string, entry: Entry, now: Date): TextChange | null {
  if (!entry.hasContent || !isCurrentEntry(source, entry)) return null;
  const suffix = suffixOf(entry.text, entry.kind);
  if (entry.kind === 'record') {
    if (suffix.record) return null;
    return { from: entry.from + suffix.end, to: entry.from + suffix.end, insert: ` ${formatTime(now)}` };
  }
  if (suffix.created) return null;
  const position = entry.from + (suffix.completed?.separatorFrom ?? suffix.end);
  return { from: position, to: position, insert: ` 📝 ${formatTime(now)}` };
}

/** Changes are relative to the original source, sorted and never overlapping. */
export function completionChanges(
  source: string,
  entry: Entry,
  checked: boolean,
  now: Date,
  ensureCreated = false,
): TextChange[] {
  if (entry.kind !== 'task' || entry.checkboxFrom === undefined || !isCurrentEntry(source, entry)) return [];
  const changes: TextChange[] = [];
  if (entry.checked !== checked) {
    changes.push({ from: entry.checkboxFrom + 1, to: entry.checkboxFrom + 2, insert: checked ? 'x' : ' ' });
  }
  const suffix = suffixOf(entry.text, 'task');
  if (!checked) {
    if (suffix.completed) changes.push({
      from: entry.from + suffix.completed.separatorFrom,
      to: entry.from + suffix.completed.to,
      insert: '',
    });
  } else if (entry.hasContent) {
    const creation = ensureCreated ? creationChange(source, entry, now) : null;
    if (!suffix.completed) {
      const position = entry.from + suffix.end;
      // Combine coincident insertions so adapters can apply one atomic transaction.
      changes.push({ from: position, to: position, insert: `${creation?.insert ?? ''} ✅ ${formatTime(now)}` });
    } else if (creation) changes.push(creation);
  }
  return changes.sort((a, b) => a.from - b.from);
}

export function timestampRanges(source: string): TimestampRange[] {
  const ranges: TimestampRange[] = [];
  for (const entry of parseEntries(source)) {
    const suffix = suffixOf(entry.text, entry.kind);
    for (const kind of ['created', 'completed', 'record'] as const) {
      const range = suffix[kind];
      if (range) ranges.push({ from: entry.from + range.from, to: entry.from + range.to, kind });
    }
  }
  return ranges.sort((a, b) => a.from - b.from);
}
