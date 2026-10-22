import { describe, expect, it } from 'vitest';
import { completionChanges, creationChange, formatTime, parseEntries, timestampRanges, type TextChange } from '../src/core';

const clock = new Date(2026, 0, 2, 8, 5, 59);

function apply(source: string, changes: TextChange[]): string {
  let previousEnd = -1;
  for (const change of changes) {
    expect(change.from).toBeGreaterThanOrEqual(previousEnd);
    expect(change.to).toBeGreaterThanOrEqual(change.from);
    previousEnd = change.to;
  }
  return [...changes].reverse().reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source);
}

describe('Markdown entries', () => {
  it('finds tasks, nested records and tasks while ignoring unrelated lists', () => {
    const source = '- unrelated\n- [ ] Parent\n  - Waiting\n    - Details\n  - [x] Child\n    - Child progress\n- Other';
    const entries = parseEntries(source);
    expect(entries.map(entry => [entry.kind, entry.line])).toEqual([
      ['task', 1], ['record', 2], ['record', 3], ['task', 4], ['record', 5],
    ]);
    expect(entries.slice(1, 4).map(entry => entry.parentTaskFrom)).toEqual(Array(3).fill(entries[0].from));
    expect(entries[4].parentTaskFrom).toBe(entries[3].from);
    expect(entries[3].checked).toBe(true);
    for (const entry of entries) expect(source.slice(entry.from, entry.to)).toBe(entry.text);
  });

  it('uses Markdown list structure for ordered lists, blank lines and quotes', () => {
    const source = '> 1. [ ] Quoted task\n>\n>    - waiting\n>    - [X] nested\n\n1. [ ] Ordered\n\n   - record\n\nParagraph\n- outside';
    const entries = parseEntries(source);
    expect(entries.map(entry => [entry.kind, entry.line])).toEqual([
      ['task', 0], ['record', 2], ['task', 3], ['task', 5], ['record', 7],
    ]);
    expect(entries[0].checkboxFrom).toBe(source.indexOf('[ ]'));
    expect(entries[2].checked).toBe(true);
  });

  it('excludes frontmatter, fenced and indented code, including nested fences', () => {
    const source = '---\nvalue: test\n- [ ] YAML\n---\n```md\n- [ ] fenced\n```\n\n    - [ ] indented\n\n- [ ] real\n  - ```md\n    - [ ] nested code\n    ```\n  - real record';
    expect(parseEntries(source).map(entry => entry.text.trim())).toEqual(['- [ ] real', '- real record']);
  });

  it('does not process an unclosed frontmatter block', () => {
    expect(parseEntries('---\n- [ ] not a task')).toEqual([]);
  });

  it('recognizes empty tasks and records without treating metadata as content', () => {
    const source = '- [ ]\n- [ ]   \n- [ ] Parent\n  -\n- [ ] 📝 20260101 17:00';
    expect(parseEntries(source).map(entry => entry.hasContent)).toEqual([false, false, true, false, false]);
  });

  it('recognizes a record entered into an initially empty nested item', () => {
    const empty = '- [ ] Parent\n  - ';
    const emptyRecord = parseEntries(empty)[1];
    expect(emptyRecord).toMatchObject({ kind: 'record', hasContent: false });
    expect(creationChange(empty, emptyRecord, clock)).toBeNull();
    const entered = `${empty}等待审批`;
    const record = parseEntries(entered)[1];
    expect(record.hasContent).toBe(true);
    expect(apply(entered, [creationChange(entered, record, clock)!])).toBe(`${entered} 20260102 08:05`);
  });

  it('keeps continuation lines unchanged and accepts tab-indented nested items', () => {
    const source = '- [ ] Parent\n\t- [ ] Child\n\t  continuation\n\t- note\n\t  continuation';
    const entries = parseEntries(source);
    expect(entries.map(entry => [entry.kind, entry.line])).toEqual([['task', 0], ['task', 1], ['record', 3]]);
    const changed = apply(source, [creationChange(source, entries[1], clock)!]);
    expect(changed).toBe('- [ ] Parent\n\t- [ ] Child 📝 20260102 08:05\n\t  continuation\n\t- note\n\t  continuation');
  });

  it('keeps correct absolute offsets with CRLF line endings', () => {
    const source = 'text\r\n- [ ] Task\r\n  - record\r\n';
    const entries = parseEntries(source);
    expect(entries[0]).toMatchObject({ from: 6, to: 16, line: 1, checkboxFrom: 8, contentFrom: 12 });
    expect(apply(source, [creationChange(source, entries[0], clock)!])).toBe('text\r\n- [ ] Task 📝 20260102 08:05\r\n  - record\r\n');
  });
});

describe('time formatting and creation', () => {
  it('formats local time with fixed-width values and no seconds', () => {
    expect(formatTime(clock)).toBe('20260102 08:05');
    expect(() => formatTime(new Date('invalid'))).toThrow(RangeError);
  });

  it('appends task creation once and preserves hard-break spaces', () => {
    const source = '- [ ] Task  ';
    const changed = apply(source, [creationChange(source, parseEntries(source)[0], clock)!]);
    expect(changed).toBe('- [ ] Task 📝 20260102 08:05  ');
    expect(creationChange(changed, parseEntries(changed)[0], clock)).toBeNull();
  });

  it('adds only a bare time to ordinary records, once', () => {
    const source = '- [ ] Parent\n  - Waiting';
    const changed = apply(source, [creationChange(source, parseEntries(source)[1], clock)!]);
    expect(changed).toBe('- [ ] Parent\n  - Waiting 20260102 08:05');
    expect(creationChange(changed, parseEntries(changed)[1], clock)).toBeNull();
  });

  it('does not create timestamps for empty or stale entries', () => {
    const source = '- [ ]';
    expect(creationChange(source, parseEntries(source)[0], clock)).toBeNull();
    expect(creationChange('- [ ] replacement', parseEntries('- [ ] original')[0], clock)).toBeNull();
  });

  it('treats body dates as content and only recognizes canonical suffixes', () => {
    const source = '- [ ] Discuss 📝 20260101 17:00 later';
    expect(apply(source, [creationChange(source, parseEntries(source)[0], clock)!])).toBe(`${source} 📝 20260102 08:05`);
  });

  it('inserts a requested creation timestamp before an existing completion', () => {
    const source = '- [x] Task ✅ 20260101 17:00';
    expect(apply(source, [creationChange(source, parseEntries(source)[0], clock)!])).toBe('- [x] Task 📝 20260102 08:05 ✅ 20260101 17:00');
  });
});

describe('completion lifecycle', () => {
  it.each(['💪', '[🆕]'])('recognizes legacy %s suffixes without duplicating or rewriting creation time', marker => {
    const source = `- [x] Legacy ${marker} 20260101 17:00 [✅] 20260102 08:05`;
    const entry = parseEntries(source)[0];
    expect(creationChange(source, entry, clock)).toBeNull();
    expect(completionChanges(source, entry, true, clock)).toEqual([]);
    expect(apply(source, completionChanges(source, entry, false, clock))).toBe(`- [ ] Legacy ${marker} 20260101 17:00`);
    expect(timestampRanges(source).map(range => [range.kind, source.slice(range.from, range.to)])).toEqual([
      ['created', `${marker} 20260101 17:00`], ['completed', '[✅] 20260102 08:05'],
    ]);
  });

  it('writes the new completion icon after an existing legacy creation suffix', () => {
    const source = '- [ ] Legacy [🆕] 20260101 17:00';
    expect(apply(source, completionChanges(source, parseEntries(source)[0], true, clock))).toBe('- [x] Legacy [🆕] 20260101 17:00 ✅ 20260102 08:05');
  });

  it('completes an old task without inventing its creation time', () => {
    const source = '- [ ] Old task';
    expect(apply(source, completionChanges(source, parseEntries(source)[0], true, clock))).toBe('- [x] Old task ✅ 20260102 08:05');
  });

  it('creates and completes a new candidate in the same non-overlapping patch set', () => {
    const source = '- [ ] New task';
    const changes = completionChanges(source, parseEntries(source)[0], true, clock, true);
    expect(changes).toHaveLength(2);
    expect(apply(source, changes)).toBe('- [x] New task 📝 20260102 08:05 ✅ 20260102 08:05');
  });

  it('preserves creation, removes completion on reopening, and uses the next completion time', () => {
    const source = '- [x] Task 📝 20260101 17:00 ✅ 20260102 08:05  \n  - Progress 20260102 08:06';
    const reopened = apply(source, completionChanges(source, parseEntries(source)[0], false, clock));
    expect(reopened).toBe('- [ ] Task 📝 20260101 17:00  \n  - Progress 20260102 08:06');
    const next = new Date(2026, 0, 3, 14, 20);
    const completed = apply(reopened, completionChanges(reopened, parseEntries(reopened)[0], true, next));
    expect(completed).toBe('- [x] Task 📝 20260101 17:00 ✅ 20260103 14:20  \n  - Progress 20260102 08:06');
  });

  it('does not duplicate or refresh an existing completion', () => {
    const source = '- [X] Task 📝 20260101 17:00 ✅ 20260101 18:00';
    expect(completionChanges(source, parseEntries(source)[0], true, clock, true)).toEqual([]);
  });

  it('leaves dates and completion-like body text intact when reopening', () => {
    const source = '- [x] Remember ✅ 20260101 17:00 then call someone';
    expect(apply(source, completionChanges(source, parseEntries(source)[0], false, clock))).toBe('- [ ] Remember ✅ 20260101 17:00 then call someone');
  });

  it('never completes ordinary records or changes another task', () => {
    const source = '- [ ] Parent\n  - [ ] Child\n  - record';
    const entries = parseEntries(source);
    expect(apply(source, completionChanges(source, entries[1], true, clock))).toBe('- [ ] Parent\n  - [x] Child ✅ 20260102 08:05\n  - record');
    expect(completionChanges(source, entries[2], true, clock)).toEqual([]);
  });

  it('does not timestamp an empty task or mutate a stale source line', () => {
    const source = '- [ ]';
    expect(apply(source, completionChanges(source, parseEntries(source)[0], true, clock, true))).toBe('- [x]');
    expect(completionChanges('- [ ] other', parseEntries('- [ ] task')[0], true, clock)).toEqual([]);
  });
});

describe('timestamp styling ranges', () => {
  it('returns complete timestamp tokens only at valid entry suffixes', () => {
    const source = '- [x] Task 📝 20260101 17:00 ✅ 20260102 08:05\n  - Waiting 20260102 09:00\nOutside 20260102 10:00\n- unrelated 20260102 10:00';
    expect(timestampRanges(source).map(range => [range.kind, source.slice(range.from, range.to)])).toEqual([
      ['created', '📝 20260101 17:00'], ['completed', '✅ 20260102 08:05'], ['record', '20260102 09:00'],
    ]);
  });

  it('does not style dates inside fenced examples or task body text', () => {
    const source = '```md\n- [ ] Example 📝 20260101 17:00\n```\n- [ ] Discuss ✅ 20260101 17:00 tomorrow';
    expect(timestampRanges(source)).toEqual([]);
  });
});
