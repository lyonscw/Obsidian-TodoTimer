// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Compartment, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { deleteCharBackward, history, indentLess, indentMore, isolateHistory, redo, undo } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import {
  compositionTodoTimerEffect, createTodoTimerExtension, flushTodoTimerEditors,
  documentFlushChanges, flushTodoTimerEffect, todoTimerStateField,
  type TodoTimerDocumentFlush,
} from '../src/editor';

const stamp = '20260102 08:05';
const options = { clock: () => new Date(2026, 0, 2, 8, 5) };
const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.useRealTimers();
});

function state(doc = ''): EditorState {
  return EditorState.create({ doc, extensions: [history(), createTodoTimerExtension(options)] });
}
function type(previous: EditorState, insert: string, from = previous.selection.main.head): EditorState {
  return previous.update({ changes: { from, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type' }).state;
}
function flush(previous: EditorState): EditorState {
  return previous.update({ effects: flushTodoTimerEffect.of(null) }).state;
}
function view(doc = '', live = false, extensions: Extension = []): EditorView {
  const result = new EditorView({
    state: EditorState.create({ doc, extensions: [history(), createTodoTimerExtension({ ...options, isLivePreview: () => live }), extensions] }),
    parent: document.body,
  });
  views.push(result);
  return result;
}

describe('new entry lifecycle', () => {
  it('waits until Enter, stamps once and leaves the new empty checkbox untouched', () => {
    let current = type(state(), '- [ ] 上架系统');
    expect(current.doc.toString()).toBe('- [ ] 上架系统');
    expect(current.field(todoTimerStateField).candidates).toEqual([0]);
    current = type(current, '\n- [ ] ');
    expect(current.doc.toString()).toBe(`- [ ] 上架系统 📝 ${stamp}\n- [ ] `);
    expect(current.selection.main.head).toBe(current.doc.length);
    expect(flush(current).doc.toString()).toBe(current.doc.toString());
  });

  it('stamps on a selection move out of the line while preserving the cursor', () => {
    let current = type(state('\n'), '- [ ] 新任务');
    const secondLine = current.doc.line(2).from;
    current = current.update({ selection: { anchor: secondLine }, userEvent: 'select.pointer' }).state;
    expect(current.doc.toString()).toBe(`- [ ] 新任务 📝 ${stamp}\n`);
    expect(current.selection.main.head).toBe(current.doc.length);
  });

  it('stamps nested records without icons and ignores other ordinary lists', () => {
    let current = state('- [ ] 旧任务\n');
    current = type(current, '  - 等待权限', current.doc.length);
    current = flush(current);
    expect(current.doc.toString()).toBe(`- [ ] 旧任务\n  - 等待权限 ${stamp}`);
    current = type(state(), '- 普通列表');
    expect(flush(current).doc.toString()).toBe('- 普通列表');
  });

  it('does not stamp empty entries, old tasks, or their text and indent edits', () => {
    expect(flush(type(state(), '- [ ] ')).doc.toString()).toBe('- [ ] ');
    let current = type(state('- [ ] 旧任务'), '修改', 8);
    current = current.update({ changes: { from: 0, insert: '  ' }, userEvent: 'input.indent' }).state;
    expect(flush(current).doc.toString()).not.toContain('📝');
  });

  it('recognizes an unannotated Obsidian checklist conversion', () => {
    const body = '准备网络规则';
    const current = state(body).update({ changes: { from: 0, insert: '- [ ] ' } }).state;
    expect(flush(current).doc.toString()).toBe(`- [ ] ${body} 📝 ${stamp}`);
  });

  it('does not timestamp existing ordinary child lists revealed by converting their parent', () => {
    const original = '- 父事项\n  - 旧的记录';
    const current = state(original).update({ changes: { from: 2, insert: '[ ] ' }, userEvent: 'input.type' }).state;
    expect(flush(current).doc.toString()).toBe(`- [ ] 父事项 📝 ${stamp}\n  - 旧的记录`);
  });

  it('supports checklist conversion within a blockquote', () => {
    const current = state('> - 待办').update({ changes: { from: 4, insert: '[ ] ' } }).state;
    expect(flush(current).doc.toString()).toBe(`> - [ ] 待办 📝 ${stamp}`);
  });

  it('preserves pasted/drop content after later text edits and excludes remote changes', () => {
    for (const userEvent of ['input.paste', 'input.drop', 'move.drop']) {
      let current = state().update({ changes: { from: 0, insert: '- [ ] 历史任务' }, userEvent }).state;
      current = type(current, '追加', current.doc.length);
      expect(flush(current).doc.toString()).toBe('- [ ] 历史任务追加');
    }
    let current = type(state(), '- [ ] 新任务');
    current = current.update({ changes: { from: current.doc.length, insert: '同步' }, annotations: Transaction.remote.of(true) }).state;
    expect(flush(current).doc.toString()).not.toContain('📝');
  });

  it('does not interpret a document load or file switch as new task creation', () => {
    let documentId = 'one.md';
    let current = EditorState.create({ extensions: createTodoTimerExtension({ ...options, documentId: () => documentId }) });
    current = current.update({ changes: { from: 0, insert: '- [ ] 打开的旧任务' } }).state;
    expect(flush(current).doc.toString()).not.toContain('📝');
    current = type(current, '\n- [ ] 新任务', current.doc.length);
    documentId = 'two.md';
    current = current.update({ changes: { from: 0, to: current.doc.length, insert: '- [ ] 第二篇旧任务' } }).state;
    expect(flush(current).doc.toString()).toBe('- [ ] 第二篇旧任务');
  });

  it('does not mistake a delayed new-file load for a checkbox toggle after metadata changes first', () => {
    let documentId = 'old.md';
    let current = EditorState.create({ doc: '- [ ] OLD', extensions: createTodoTimerExtension({ ...options, documentId: () => documentId }) });
    documentId = 'new.md';
    current = flush(current);
    current = current.update({ changes: { from: 0, to: current.doc.length, insert: '- [x] EXISTING' } }).state;
    expect(current.doc.toString()).toBe('- [x] EXISTING');
    expect(flush(current).doc.toString()).toBe('- [x] EXISTING');
    current = current.update({ changes: { from: 3, to: 4, insert: ' ' } }).state;
    current = current.update({ changes: { from: 3, to: 4, insert: 'x' } }).state;
    expect(current.doc.toString()).toBe(`- [x] EXISTING ✅ ${stamp}`);
  });

  it.each(['keyboard', 'pointer'])('preserves the first real %s checkbox interaction after switching files with identical content', eventType => {
    let documentId = 'old.md';
    const editor = new EditorView({ state: EditorState.create({ doc: '- [ ] SAME', extensions: createTodoTimerExtension({
      ...options, documentId: () => documentId,
    }) }), parent: document.body });
    views.push(editor);
    documentId = 'new.md';
    editor.dispatch({ effects: flushTodoTimerEffect.of(null) });
    // The host need not replace an unchanged document. Its native checkbox command
    // can then be unannotated, while the preceding key event proves user intent.
    editor.contentDOM.dispatchEvent(eventType === 'keyboard'
      ? new KeyboardEvent('keydown', { key: ' ', code: 'Space' })
      : new MouseEvent('click', { bubbles: true }));
    editor.dispatch({ changes: { from: 3, to: 4, insert: 'x' } });
    expect(editor.state.doc.toString()).toBe(`- [x] SAME ✅ ${stamp}`);
  });

  it('also treats a diff-based unannotated new-file load as baseline', () => {
    let documentId = 'old.md';
    let current = EditorState.create({ doc: '- [ ] OLD', extensions: createTodoTimerExtension({ ...options, documentId: () => documentId }) });
    documentId = 'new.md';
    current = flush(current);
    current = current.update({ changes: { from: 3, to: current.doc.length, insert: 'x] EXISTING' } }).state;
    expect(flush(current).doc.toString()).toBe('- [x] EXISTING');
  });

  it('keeps the old task identity when a new task is inserted before its first character', () => {
    const insert = '- [ ] NEW\n';
    let current = state('- [ ] OLD').update({
      changes: { from: 0, insert }, selection: { anchor: insert.length - 1 }, userEvent: 'input.type',
    }).state;
    expect(current.doc.toString()).toBe('- [ ] NEW\n- [ ] OLD');
    current = flush(current);
    expect(current.doc.toString()).toBe(`- [ ] NEW 📝 ${stamp}\n- [ ] OLD`);
  });

  it('drops a deleted candidate instead of transferring it to the following old task', () => {
    let current = type(state('\n- [ ] OLD'), '- [ ] NEW', 0);
    current = current.update({
      changes: { from: 0, to: current.doc.line(2).from }, selection: { anchor: 0 }, userEvent: 'delete',
    }).state;
    expect(current.field(todoTimerStateField).candidates).toEqual([]);
    expect(flush(current).doc.toString()).toBe('- [ ] OLD');
  });

  it('tracks markers independently when multiple tasks have identical text', () => {
    let current = type(state('\n- [ ] SAME\n- [ ] SAME'), '- [ ] SAME', 0);
    current = current.update({
      changes: { from: 0, to: current.doc.line(2).from }, selection: { anchor: 0 }, userEvent: 'delete',
    }).state;
    expect(flush(current).doc.toString()).toBe('- [ ] SAME\n- [ ] SAME');
  });

  it('reuses parsed entries and indexes for selection-only and empty flush transactions', () => {
    let current = state('- [ ] OLD\n  - 旧记录');
    const initial = current.field(todoTimerStateField);
    current = current.update({ selection: { anchor: current.doc.length }, userEvent: 'select.pointer' }).state;
    current = flush(current);
    expect(current.field(todoTimerStateField).entries).toBe(initial.entries);
    expect(current.field(todoTimerStateField).index).toBe(initial.index);
    expect(current.doc.toString()).toBe(initial.source);
  });
});

describe('completion and undo', () => {
  it('adds/removes completion time without inventing a creation date for old tasks', () => {
    let current = state('- [ ] 旧任务');
    current = current.update({ changes: { from: 3, to: 4, insert: 'x' } }).state;
    expect(current.doc.toString()).toBe(`- [x] 旧任务 ✅ ${stamp}`);
    current = current.update({ changes: { from: 3, to: 4, insert: ' ' } }).state;
    expect(current.doc.toString()).toBe('- [ ] 旧任务');
  });

  it('finds both changed tasks in a sparse multi-range transaction', () => {
    const original = '- [ ] FIRST\n- [ ] MIDDLE\n- [ ] LAST';
    let current = state(original);
    const last = current.doc.line(3).from + 3;
    current = current.update({ changes: [
      { from: 3, to: 4, insert: 'x' }, { from: last, to: last + 1, insert: 'x' },
    ] }).state;
    expect(current.doc.toString()).toBe(`- [x] FIRST ✅ ${stamp}\n- [ ] MIDDLE\n- [x] LAST ✅ ${stamp}`);
  });

  it('creates and completes a new task together, independently from its parent', () => {
    let current = state('- [ ] 父任务\n');
    current = type(current, '  - [ ] 新子任务', current.doc.length);
    const marker = current.doc.toString().lastIndexOf('[ ]') + 1;
    current = current.update({ changes: { from: marker, to: marker + 1, insert: 'x' } }).state;
    expect(current.doc.toString()).toBe(`- [ ] 父任务\n  - [x] 新子任务 📝 ${stamp} ✅ ${stamp}`);
    expect(current.field(todoTimerStateField).candidates).toEqual([]);
  });

  it('undoes and redoes checkbox and time together without regenerating either', () => {
    let current = state('- [ ] 旧任务');
    current = current.update({ changes: { from: 3, to: 4, insert: 'x' }, userEvent: 'input' }).state;
    const completed = current.doc.toString();
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe('- [ ] 旧任务');
    expect(flush(current).doc.toString()).toBe('- [ ] 旧任务');
    expect(redo(target)).toBe(true);
    expect(current.doc.toString()).toBe(completed);
  });

  it('does not automatically restore a creation timestamp removed with undo', () => {
    let current = type(state(), '- [ ] 新任务');
    current = type(current, '\n');
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    expect(undo(target)).toBe(true);
    expect(flush(current).doc.toString()).not.toContain('📝');
  });

  it('does not retain already-satisfied completion work after an adapter transaction', () => {
    let current = state('- [ ] 旧任务');
    current = current.update({ changes: [
      { from: 3, to: 4, insert: 'x' },
      { from: current.doc.length, insert: ` ✅ ${stamp}` },
    ] }).state;
    expect(current.field(todoTimerStateField).pendingCompletions).toEqual([]);
    current = type(current, ' 补充', current.doc.length);
    expect(current.doc.toString().match(/✅/gu)?.length).toBe(1);
  });

  it('retains an unsettled task when undo only removes a later body edit', () => {
    let current = type(state(), '- [ ] 新任务');
    current = current.update({
      changes: { from: current.doc.length, insert: '补充' }, selection: { anchor: current.doc.length + 2 },
      userEvent: 'input.type', annotations: isolateHistory.of('full'),
    }).state;
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe('- [ ] 新任务');
    expect(flush(current).doc.toString()).toBe(`- [ ] 新任务 📝 ${stamp}`);
  });

  it('restores an unsettled task identity when its deletion is undone', () => {
    let current = type(state(), '- [ ] 新任务');
    current = current.update({
      changes: { from: 0, to: current.doc.length }, userEvent: 'delete', annotations: isolateHistory.of('full'),
    }).state;
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe('- [ ] 新任务');
    expect(flush(current).doc.toString()).toBe(`- [ ] 新任务 📝 ${stamp}`);
  });

  it('retains candidate identity across undo and redo of its initial input', () => {
    let current = type(state(), '- [ ] 新任务');
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe('');
    expect(redo(target)).toBe(true);
    expect(flush(current).doc.toString()).toBe(`- [ ] 新任务 📝 ${stamp}`);
  });

  it('does not restamp when undo removes a timestamp from a group that also edited the body', () => {
    let current = type(state(), '- [ ] 新任务');
    current = current.update({
      changes: { from: current.doc.length, insert: '补充' }, selection: { anchor: current.doc.length + 2 },
      userEvent: 'input.type', annotations: isolateHistory.of('before'),
    }).state;
    current = type(current, '\n');
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    expect(undo(target)).toBe(true);
    expect(current.doc.toString()).toBe('- [ ] 新任务');
    expect(flush(current).doc.toString()).toBe('- [ ] 新任务');
  });
});

describe('ordinary records created through normal list editing', () => {
  function fixture(doc: string) {
    let current = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [
      history(), indentUnit.of('  '), createTodoTimerExtension(options),
    ] });
    const target = { get state() { return current; }, dispatch: (tr: ReturnType<EditorState['update']>) => { current = tr.state; } };
    return { target, get: () => current, set: (next: EditorState) => { current = next; } };
  }

  it('retains a new task identity across Enter, Tab, typing, and four real Backspaces removing its checkbox', () => {
    const editor = fixture('- [ ] parent');
    editor.set(type(editor.get(), '\n- [ ] '));
    indentMore(editor.target);
    editor.set(type(editor.get(), 'waiting'));
    const task = editor.get().field(todoTimerStateField).entries[1];
    editor.set(editor.get().update({ selection: { anchor: task.contentFrom } }).state);
    const actualView = new EditorView({ state: editor.get(), parent: document.body });
    views.push(actualView);
    for (let index = 0; index < 4; index++) deleteCharBackward(actualView);
    editor.set(actualView.state);
    editor.set(editor.get().update({ selection: { anchor: editor.get().doc.length } }).state);
    editor.set(type(editor.get(), '\n  - '));
    expect(editor.get().doc.toString()).toBe(`- [ ] parent\n  - waiting ${stamp}\n  - `);
  });

  it.each([undefined, 'delete.backward', 'input'])('does not timestamp an old task converted to a record by %s', userEvent => {
    const editor = fixture('- [ ] parent\n  - [ ] OLD');
    const task = editor.get().field(todoTimerStateField).entries[1];
    editor.set(editor.get().update({ changes: { from: task.checkboxFrom!, to: task.contentFrom, insert: '' }, userEvent }).state);
    expect(flush(editor.get()).doc.toString()).toBe('- [ ] parent\n  - OLD');
  });

  it.each(['old', 'pasted'])('does not mistake indentation of an %s ordinary sibling for record creation', origin => {
    const editor = fixture(origin === 'old' ? '- [ ] parent\n- OLD' : '- [ ] parent\n');
    if (origin === 'pasted') editor.set(editor.get().update({
      changes: { from: editor.get().doc.length, insert: '- OLD' },
      selection: { anchor: editor.get().doc.length + 5 }, userEvent: 'input.paste',
    }).state);
    indentMore(editor.target);
    expect(flush(editor.get()).doc.toString()).toBe('- [ ] parent\n  - OLD');
  });

  it('does not timestamp an old ordinary sibling when indentation is typed as spaces', () => {
    const editor = fixture('- [ ] parent\n- OLD');
    const from = editor.get().doc.line(2).from;
    editor.set(type(editor.get(), ' ', from));
    editor.set(type(editor.get(), ' '));
    expect(flush(editor.get()).doc.toString()).toBe('- [ ] parent\n  - OLD');
  });

  it('does not mark a whole-line edit of an old ordinary sibling as a newly born list', () => {
    const editor = fixture('- [ ] parent\n- OLD');
    const line = editor.get().doc.line(2);
    editor.set(editor.get().update({ changes: { from: line.from, to: line.to, insert: '- CHANGED' },
      selection: { anchor: line.from + 9 }, userEvent: 'input.type' }).state);
    indentMore(editor.target);
    expect(flush(editor.get()).doc.toString()).toBe('- [ ] parent\n  - CHANGED');
  });

  it.each(['input.indent', undefined])('remembers a freshly typed ordinary sibling until it enters task scope via %s', userEvent => {
    const editor = fixture('- [ ] parent\n');
    for (const text of ['-', ' ', '新', '记', '录']) editor.set(type(editor.get(), text));
    expect(flush(editor.get()).doc.toString()).toBe('- [ ] parent\n- 新记录');
    const from = editor.get().doc.line(2).from;
    editor.set(editor.get().update({ changes: { from, insert: '  ' }, selection: { anchor: editor.get().doc.length + 2 }, userEvent }).state);
    expect(flush(editor.get()).doc.toString()).toBe(`- [ ] parent\n  - 新记录 ${stamp}`);
  });

  it('preserves a new ordinary sibling identity through undo/redo before indentation', () => {
    const editor = fixture('- [ ] parent\n');
    editor.set(type(editor.get(), '- waiting'));
    editor.set(editor.get().update({ changes: { from: editor.get().doc.length, insert: ' extra' },
      selection: { anchor: editor.get().doc.length + 6 }, userEvent: 'input.type', annotations: isolateHistory.of('full') }).state);
    undo(editor.target);
    redo(editor.target);
    indentMore(editor.target);
    expect(flush(editor.get()).doc.toString()).toBe(`- [ ] parent\n  - waiting extra ${stamp}`);
  });

  it('restores a deleted fresh ordinary sibling through undo before it enters task scope', () => {
    const editor = fixture('- [ ] parent\n');
    editor.set(type(editor.get(), '- waiting'));
    const line = editor.get().doc.line(2);
    editor.set(editor.get().update({ changes: { from: line.from, to: line.to, insert: '' },
      userEvent: 'delete', annotations: isolateHistory.of('full') }).state);
    undo(editor.target);
    indentMore(editor.target);
    expect(flush(editor.get()).doc.toString()).toBe(`- [ ] parent\n  - waiting ${stamp}`);
  });

  it('keeps a fresh marker identity through undo/redo of task-to-record conversion', () => {
    const editor = fixture('- [ ] parent\n');
    editor.set(type(editor.get(), '  - [ ] waiting'));
    const task = editor.get().field(todoTimerStateField).entries[1];
    editor.set(editor.get().update({ changes: { from: task.checkboxFrom!, to: task.contentFrom, insert: '' },
      selection: { anchor: editor.get().doc.length - 4 }, userEvent: 'delete', annotations: isolateHistory.of('full') }).state);
    undo(editor.target);
    expect(editor.get().doc.toString()).toBe('- [ ] parent\n  - [ ] waiting');
    redo(editor.target);
    expect(flush(editor.get()).doc.toString()).toBe(`- [ ] parent\n  - waiting ${stamp}`);
  });

  it('uses a task creation marker when a fresh record becomes a checkbox before settlement', () => {
    const editor = fixture('- [ ] parent\n');
    editor.set(type(editor.get(), '  - waiting'));
    const record = editor.get().field(todoTimerStateField).entries[1];
    editor.set(editor.get().update({ changes: { from: record.contentFrom, insert: '[ ] ' } }).state);
    expect(flush(editor.get()).doc.toString()).toBe(`- [ ] parent\n  - [ ] waiting 📝 ${stamp}`);
  });

  it('does not regenerate a record timestamp undone before dedenting and indenting again', () => {
    const editor = fixture('- [ ] parent\n');
    editor.set(type(editor.get(), '- waiting'));
    indentMore(editor.target);
    editor.set(editor.get().update({ effects: flushTodoTimerEffect.of(null), annotations: isolateHistory.of('full') }).state);
    undo(editor.target);
    indentLess(editor.target);
    indentMore(editor.target);
    expect(flush(editor.get()).doc.toString()).toBe('- [ ] parent\n  - waiting');
  });

  it('defers a fresh Chinese record during composition and uses its final kind on line exit', () => {
    const editor = fixture('- [ ] parent\n');
    editor.set(type(editor.get(), '  - [ ] '));
    editor.set(editor.get().update({ effects: compositionTodoTimerEffect.of(true) }).state);
    editor.set(editor.get().update({ changes: { from: editor.get().doc.length, insert: '啊' },
      selection: { anchor: editor.get().doc.length + 1 }, userEvent: 'input.type.compose' }).state);
    expect(editor.get().doc.toString()).toBe('- [ ] parent\n  - [ ] 啊');
    editor.set(editor.get().update({ effects: compositionTodoTimerEffect.of(false) }).state);
    const task = editor.get().field(todoTimerStateField).entries[1];
    editor.set(editor.get().update({ changes: { from: task.checkboxFrom!, to: task.contentFrom, insert: '' },
      selection: { anchor: editor.get().doc.length - 4 }, userEvent: 'delete.backward' }).state);
    editor.set(type(editor.get(), '\n  - '));
    expect(editor.get().doc.toString()).toBe(`- [ ] parent\n  - 啊 ${stamp}\n  - `);
  });

  it('still treats explicit record-to-checkbox conversion as a new task while preserving body timestamps', () => {
    const doc = `- [ ] parent\n  - 旧记录 ${stamp}`;
    const editor = fixture(doc);
    const record = editor.get().field(todoTimerStateField).entries[1];
    editor.set(editor.get().update({ changes: { from: record.contentFrom, insert: '[ ] ' } }).state);
    expect(flush(editor.get()).doc.toString()).toBe(`- [ ] parent\n  - [ ] 旧记录 ${stamp} 📝 ${stamp}`);
  });
});

describe('composition and actual EditorView behavior', () => {
  it('defers blur/leave flushes during IME until the composition ends', () => {
    let current = type(state(), '- [ ] 中文');
    current = current.update({ effects: compositionTodoTimerEffect.of(true) }).state;
    current = flush(current);
    expect(current.doc.toString()).toBe('- [ ] 中文');
    current = type(current, '输入');
    current = current.update({ effects: compositionTodoTimerEffect.of(false) }).state;
    expect(current.doc.toString()).toBe(`- [ ] 中文输入 📝 ${stamp}`);
  });

  it('treats a composing Enter as candidate confirmation, not line finalization', () => {
    let current = type(state(), '- [ ] 中文');
    current = current.update({ changes: { from: current.doc.length, insert: '完成' }, userEvent: 'input.type.compose' }).state;
    expect(current.doc.toString()).toBe('- [ ] 中文完成');
    expect(flush(current).doc.toString()).toBe(`- [ ] 中文完成 📝 ${stamp}`);
  });

  it('does not finalize when an IME selection briefly leaves and returns before confirmation', () => {
    let current = type(state('\n'), '- [ ] 中文');
    current = current.update({ effects: compositionTodoTimerEffect.of(true) }).state;
    const head = current.selection.main.head;
    current = current.update({ selection: { anchor: current.doc.length }, userEvent: 'select.pointer' }).state;
    current = current.update({ selection: { anchor: head }, userEvent: 'select.pointer' }).state;
    current = current.update({ effects: compositionTodoTimerEffect.of(false) }).state;
    expect(current.doc.toString()).toBe('- [ ] 中文\n');
  });

  it('keeps the current line pending through a temporary blur and stamps on actual line exit', () => {
    const editor = view();
    const insert = '- [ ] 最后一行';
    editor.dispatch({ changes: { from: 0, insert }, selection: { anchor: insert.length }, userEvent: 'input.type' });
    editor.contentDOM.dispatchEvent(new FocusEvent('blur'));
    expect(editor.state.doc.toString()).toBe('- [ ] 最后一行');
    editor.dispatch({ changes: { from: insert.length, insert: '\n' }, selection: { anchor: insert.length + 1 }, userEvent: 'input.type' });
    expect(editor.state.doc.toString()).toBe(`- [ ] 最后一行 📝 ${stamp}\n`);
    editor.destroy();
    views.splice(views.indexOf(editor), 1);
    expect(() => flushTodoTimerEditors()).not.toThrow();
  });

  it('does not finalize an IME task after temporary blur and compositionend on the same line', async () => {
    vi.useFakeTimers();
    const editor = view();
    editor.dispatch({ changes: { from: 0, insert: '- [ ] 中文' }, selection: { anchor: 8 }, userEvent: 'input.type' });
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(editor.state.field(todoTimerStateField).composing).toBe(true);
    editor.contentDOM.dispatchEvent(new FocusEvent('blur'));
    expect(editor.state.field(todoTimerStateField).deferredFlush).toBe(false);
    expect(editor.state.doc.toString()).toBe('- [ ] 中文');
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend'));
    expect(editor.state.field(todoTimerStateField).composing).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(editor.state.field(todoTimerStateField).composing).toBe(false);
    expect(editor.state.field(todoTimerStateField).deferredFlush).toBe(false);
    expect(editor.state.doc.toString()).toBe('- [ ] 中文');
  });

  it('also flushes when CodeMirror defers a compositionend dispatched during its update', async () => {
    vi.useFakeTimers();
    const finish = StateEffect.define<null>();
    const dispatchDuringUpdate = ViewPlugin.define(editor => ({
      update(update) {
        if (update.transactions.some(tr => tr.effects.some(effect => effect.is(finish)))) {
          editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend'));
        }
      },
    }));
    const editor = view('', false, dispatchDuringUpdate);
    editor.dispatch({ changes: { from: 0, insert: '- [ ] 中文' }, selection: { anchor: 8 }, userEvent: 'input.type' });
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'));
    editor.dispatch({ effects: flushTodoTimerEffect.of(null) });
    editor.dispatch({ effects: finish.of(null) });
    expect(editor.state.field(todoTimerStateField).composing).toBe(true);
    expect(editor.state.field(todoTimerStateField).deferredFlush).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(editor.state.field(todoTimerStateField).composing).toBe(false);
    expect(editor.state.doc.toString()).toBe(`- [ ] 中文 📝 ${stamp}`);
  });

  it('only decorates timestamp text in Live Preview', () => {
    const doc = `- [ ] 任务 📝 ${stamp}`;
    const live = view(doc, true);
    expect(live.dom.querySelector('.todotimer-time-created')?.textContent).toBe(`📝 ${stamp}`);
    const source = view(doc);
    expect(source.dom.querySelector('.todotimer-time')).toBeNull();
  });

  it('refreshes marks when Live Preview changes without a document edit', () => {
    const modeEffect = StateEffect.define<boolean>();
    const mode = StateField.define({
      create: () => false,
      update: (value, tr) => tr.effects.find(effect => effect.is(modeEffect))?.value as boolean | undefined ?? value,
    });
    const editor = new EditorView({
      state: EditorState.create({
        doc: `- [ ] 任务 📝 ${stamp}`,
        extensions: [mode, createTodoTimerExtension({ ...options, isLivePreview: current => current.field(mode) })],
      }), parent: document.body,
    });
    views.push(editor);
    expect(editor.dom.querySelector('.todotimer-time')).toBeNull();
    editor.dispatch({ effects: modeEffect.of(true) });
    expect(editor.dom.querySelector('.todotimer-time-created')).not.toBeNull();
    editor.dispatch({ effects: modeEffect.of(false) });
    expect(editor.dom.querySelector('.todotimer-time')).toBeNull();
  });
});

describe('leaving a document in the same editor pane', () => {
  const apply = (source: string, pending: TodoTimerDocumentFlush): string | null => {
    const changes = documentFlushChanges(source, pending);
    return changes && [...changes].reverse().reduce((text, change) =>
      text.slice(0, change.from) + change.insert + text.slice(change.to), source);
  };

  it('captures the converted old document before setState destroys its view plugin', () => {
    let documentId = 'old.md';
    const pending: TodoTimerDocumentFlush[] = [];
    const extension = createTodoTimerExtension({ ...options, documentId: () => documentId, onDocumentLeave: item => pending.push(item) });
    const editor = new EditorView({ state: EditorState.create({ doc: '普通段落', extensions: extension }), parent: document.body });
    views.push(editor);
    editor.dispatch({ changes: { from: 0, insert: '- [ ] ' }, selection: { anchor: 0 } });
    expect(editor.state.field(todoTimerStateField).candidates).toEqual([0]);
    expect(editor.state.doc.toString()).toBe('- [ ] 普通段落');
    documentId = 'new.md';
    editor.setState(EditorState.create({ doc: '- [ ] 新文件的旧任务', extensions: extension }));
    flushTodoTimerEditors('old.md');
    expect(pending).toHaveLength(1);
    expect(pending[0].documentId).toBe('old.md');
    expect(apply('- [ ] 普通段落', pending[0])).toBe(`- [ ] 普通段落 📝 ${stamp}`);
    expect(editor.state.doc.toString()).toBe('- [ ] 新文件的旧任务');
  });

  it('captures the old snapshot when the host reuses a view and changes its file identity', () => {
    let documentId = 'old.md';
    const pending: TodoTimerDocumentFlush[] = [];
    const editor = new EditorView({ state: EditorState.create({ extensions: createTodoTimerExtension({
      ...options, documentId: () => documentId, onDocumentLeave: item => pending.push(item),
    }) }), parent: document.body });
    views.push(editor);
    editor.dispatch({ changes: { from: 0, insert: '- [ ] OLD NEW' }, selection: { anchor: 13 }, userEvent: 'input.type' });
    documentId = 'new.md';
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '- [ ] EXISTING' } });
    expect(pending).toHaveLength(1);
    expect(pending[0].documentId).toBe('old.md');
    expect(apply(pending[0].source, pending[0])).toBe(`- [ ] OLD NEW 📝 ${stamp}`);
    expect(editor.state.doc.toString()).toBe('- [ ] EXISTING');
  });

  it('preserves CRLF bytes and rejects concurrent changes to the captured source', () => {
    const source = '- [ ] 父任务\n  - 等待权限';
    const pending: TodoTimerDocumentFlush = { documentId: 'old.md', source, changes: [
      { from: source.length, to: source.length, insert: ` ${stamp}` },
    ] };
    expect(apply(source.replace(/\n/g, '\r\n'), pending)).toBe(`- [ ] 父任务\r\n  - 等待权限 ${stamp}`);
    expect(apply(source + '\n并发的新正文', pending)).toBeNull();
  });

  it('retains an unfinalized task when an extension detaches and reattaches on the same source', async () => {
    const compartment = new Compartment();
    const errors: unknown[] = [];
    const pending: TodoTimerDocumentFlush[] = [];
    const extension = createTodoTimerExtension({ ...options, documentId: () => 'old.md', onDocumentLeave: item => pending.push(item) });
    const editor = new EditorView({ state: EditorState.create({ extensions: [
      EditorView.exceptionSink.of(error => errors.push(error)),
      compartment.of(extension),
    ] }), parent: document.body });
    views.push(editor);
    const text = '- [ ] 尚未离行';
    editor.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: text.length }, userEvent: 'input.type' });
    editor.dispatch({ effects: compartment.reconfigure([]) });
    expect(errors).toEqual([]);
    expect(pending).toHaveLength(0);
    expect(editor.state.field(todoTimerStateField, false)).toBeUndefined();
    expect(editor.state.doc.toString()).toBe(text);
    editor.dispatch({ effects: compartment.reconfigure(extension) });
    await Promise.resolve();
    expect(editor.state.doc.toString()).toBe(text);
    editor.dispatch({ changes: { from: text.length, insert: '\n' }, selection: { anchor: text.length + 1 }, userEvent: 'input.type' });
    expect(editor.state.doc.toString()).toBe(`${text} 📝 ${stamp}\n`);
  });

  it('keeps creation identity through same-file setState without a leave callback', async () => {
    const pending: TodoTimerDocumentFlush[] = [];
    const extension = [history(), createTodoTimerExtension({ ...options, documentId: () => 'same.md', onDocumentLeave: item => pending.push(item) })];
    const editor = new EditorView({ state: EditorState.create({ extensions: extension }), parent: document.body });
    views.push(editor);
    const text = '- [ ] 同一文件';
    editor.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: text.length }, userEvent: 'input.type' });
    editor.setState(EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: extension }));
    await Promise.resolve();
    expect(pending).toEqual([]);
    expect(editor.state.doc.toString()).toBe(text);
    editor.dispatch({ changes: { from: text.length, insert: '\n' }, selection: { anchor: text.length + 1 }, userEvent: 'input.type' });
    expect(editor.state.doc.toString()).toBe(`${text} 📝 ${stamp}\n`);
  });

  it('does not revive a timestamp undone before same-file setState', async () => {
    const extension = [history(), createTodoTimerExtension({ ...options, documentId: () => 'same.md' })];
    const editor = new EditorView({ state: EditorState.create({ extensions: extension }), parent: document.body });
    views.push(editor);
    const text = '- [ ] 撤销时间';
    editor.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: text.length }, userEvent: 'input.type' });
    editor.dispatch({ effects: flushTodoTimerEffect.of(null), annotations: isolateHistory.of('full') });
    undo(editor);
    expect(editor.state.doc.toString()).toBe(text);
    editor.setState(EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: extension }));
    await Promise.resolve();
    editor.dispatch({ changes: { from: text.length, insert: '\n' }, selection: { anchor: text.length + 1 }, userEvent: 'input.type' });
    expect(editor.state.doc.toString()).toBe(`${text}\n`);
  });
});

describe('file-open persistence through the public workspace lifecycle', () => {
  let PluginClass: new () => {
    app: unknown;
    extension: Extension;
    onload(): void;
  };
  let hostInfo: StateField<unknown>;
  let FileClass: new (path: string) => { path: string; extension: string };
  let SourceViewClass: new () => object;

  beforeAll(async () => {
    vi.doMock('../src/reading', () => ({ registerTodoTimerReading: () => undefined }));
    vi.doMock('obsidian', () => {
      hostInfo = StateField.define<unknown>({ create: () => ({ file: null }), update: value => value });
      FileClass = class { extension = 'md'; constructor(public path: string) {} };
      SourceViewClass = class {};
      return {
        Plugin: class {
          extension: Extension = [];
          registerEditorExtension(extension: Extension) { this.extension = extension; }
          registerEvent() {}
        },
        TFile: FileClass, MarkdownView: SourceViewClass, editorInfoField: hostInfo,
        editorLivePreviewField: StateField.define({ create: () => false, update: value => value }),
      };
    });
    PluginClass = (await import('../src/main')).default as unknown as typeof PluginClass;
  });

  function fixture(initialSaved = '- [ ] 普通段落', switchImmediately = true) {
    const oldFile = new FileClass('old.md');
    const newFile = new FileClass('new.md');
    const disk = new Map([['old.md', initialSaved], ['new.md', '- [ ] 新文件旧任务']]);
    const workspaceEvents = new Map<string, (...args: unknown[]) => void>();
    const vaultEvents = new Map<string, (...args: unknown[]) => void>();
    const leaves: { view: object }[] = [];
    const compartment = new Compartment();
    let editor: EditorView;
    let mode = 'source';
    const sourceView = Object.assign(new SourceViewClass(), {
      file: oldFile,
      getMode: () => mode,
      editor: {
        getValue: () => editor.state.doc.toString(),
        offsetToPos: (offset: number) => ({ line: editor.state.doc.lineAt(offset).number - 1, ch: offset - editor.state.doc.lineAt(offset).from }),
        transaction: vi.fn((spec: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }) => {
          editor.dispatch({ changes: spec.changes.map(change => ({
            from: editor.state.doc.line(change.from.line + 1).from + change.from.ch,
            to: editor.state.doc.line(change.to.line + 1).from + change.to.ch, insert: change.text,
          })) });
        }),
      },
    });
    leaves.push({ view: sourceView });
    let beforeProcess: (() => void) | undefined;
    const read = vi.fn(async (file: { path: string }) => disk.get(file.path)!);
    const process = vi.fn(async (file: { path: string }, transform: (source: string) => string) => {
      beforeProcess?.();
      disk.set(file.path, transform(disk.get(file.path)!));
      vaultEvents.get('modify')?.(file);
      return disk.get(file.path)!;
    });
    const plugin = new PluginClass();
    plugin.app = {
      workspace: {
        on: (name: string, callback: (...args: unknown[]) => void) => { workspaceEvents.set(name, callback); },
        getLeavesOfType: () => leaves,
        getActiveViewOfType: () => sourceView,
      },
      vault: {
        on: (name: string, callback: (...args: unknown[]) => void) => { vaultEvents.set(name, callback); },
        getAbstractFileByPath: (path: string) => path === oldFile.path ? oldFile : path === newFile.path ? newFile : null,
        read, process,
      },
    };
    plugin.onload();
    editor = new EditorView({ state: EditorState.create({ doc: '普通段落', extensions: [
      hostInfo.init(() => ({ file: oldFile })), compartment.of(plugin.extension),
    ] }), parent: document.body });
    views.push(editor);
    editor.dispatch({ changes: { from: 0, insert: '- [ ] ' }, selection: { anchor: 0 } });
    const switchFile = (): void => {
      sourceView.file = newFile;
      editor.setState(EditorState.create({ doc: disk.get(newFile.path)!, extensions: [
        hostInfo.init(() => ({ file: newFile })), compartment.of(plugin.extension),
      ] }));
    };
    if (switchImmediately) switchFile();
    return {
      disk, read, process, editor,
      open: () => workspaceEvents.get('file-open')?.(sourceView.file),
      sameLeafEvent: () => workspaceEvents.get('active-leaf-change')?.({ view: sourceView }),
      switchFile,
      rebuild: () => editor.setState(EditorState.create({ doc: editor.state.doc.toString(), selection: editor.state.selection, extensions: [
        hostInfo.init(() => ({ file: sourceView.file })), compartment.of(plugin.extension),
      ] })),
      changeMode: (next: string) => {
        mode = next;
        editor.dispatch({ effects: compartment.reconfigure(next === 'source' ? plugin.extension : []) });
        workspaceEvents.get('layout-change')?.();
      },
      saved: (source: string) => { disk.set(oldFile.path, source); vaultEvents.get('modify')?.(oldFile); },
      beforeProcess: (callback: () => void) => { beforeProcess = callback; },
      addSourceEditor: (source: string) => {
        const transaction = vi.fn();
        leaves.push({ view: Object.assign(new SourceViewClass(), {
          file: oldFile, getMode: () => 'source',
          editor: { getValue: () => source, transaction, offsetToPos: (offset: number) => ({ line: 0, ch: offset }) },
        }) });
        return transaction;
      },
    };
  }

  it('does not finalize the current file for same-file workspace events', () => {
    const current = fixture(undefined, false);
    current.open();
    current.sameLeafEvent();
    expect(current.editor.state.doc.toString()).toBe('- [ ] 普通段落');
    expect(current.process).not.toHaveBeenCalled();
  });

  it('does not let autosave finalize a same-file editor rebuild', async () => {
    const current = fixture(undefined, false);
    current.rebuild();
    current.saved('- [ ] 普通段落');
    await Promise.resolve();
    expect(current.editor.state.doc.toString()).toBe('- [ ] 普通段落');
    expect(current.process).not.toHaveBeenCalled();
    const length = current.editor.state.doc.length;
    current.editor.dispatch({ changes: { from: length, insert: '\n' }, selection: { anchor: length + 1 }, userEvent: 'input.type' });
    expect(current.editor.state.doc.toString()).toMatch(/普通段落 📝 \d{8} \d{2}:\d{2}\n/);
  });

  it('settles a detached source when the active note enters reading mode', async () => {
    const current = fixture(undefined, false);
    current.changeMode('preview');
    await vi.waitFor(() => expect(current.disk.get('old.md')).toContain('普通段落 📝'));
  });

  it('preserves identity when source-reading-source completes before lifecycle confirmation', async () => {
    const current = fixture(undefined, false);
    current.changeMode('preview');
    current.changeMode('source');
    await Promise.resolve();
    expect(current.editor.state.doc.toString()).toBe('- [ ] 普通段落');
    const length = current.editor.state.doc.length;
    current.editor.dispatch({ changes: { from: length, insert: '\n' }, selection: { anchor: length + 1 }, userEvent: 'input.type' });
    expect(current.editor.state.doc.toString()).toMatch(/普通段落 📝 \d{8} \d{2}:\d{2}\n/);
  });

  it('flushes only the document that was actually left', async () => {
    const current = fixture();
    const length = current.editor.state.doc.length;
    current.editor.dispatch({ changes: { from: length, insert: '\n- [ ] 当前新任务' }, selection: { anchor: length + 12 }, userEvent: 'input.type' });
    current.open();
    await vi.waitFor(() => expect(current.disk.get('old.md')).toContain('普通段落 📝'));
    expect(current.editor.state.doc.toString()).not.toContain('📝');
  });

  it('settles the old document after same-leaf file-open without a blur or leaf change', async () => {
    const current = fixture();
    current.open();
    await vi.waitFor(() => expect(current.disk.get('old.md')).toMatch(/^- \[ \] 普通段落 📝 \d{8} \d{2}:\d{2}$/u));
    expect(current.process).toHaveBeenCalledTimes(1);
    expect(current.disk.get('new.md')).toBe('- [ ] 新文件旧任务');
    expect(current.editor.state.doc.toString()).toBe('- [ ] 新文件旧任务');
  });

  it('waits for the old editor autosave instead of replacing older on-disk content', async () => {
    const current = fixture('普通段落');
    current.open();
    await vi.waitFor(() => expect(current.read).toHaveBeenCalled());
    expect(current.process).not.toHaveBeenCalled();
    expect(current.disk.get('old.md')).toBe('普通段落');
    current.saved('- [ ] 普通段落');
    await vi.waitFor(() => expect(current.disk.get('old.md')).toContain('普通段落 📝'));
  });

  it('rechecks inside atomic process and preserves text changed after its preliminary read', async () => {
    const current = fixture();
    current.beforeProcess(() => { current.disk.set('old.md', '- [ ] 普通段落\n并发正文'); });
    current.open();
    await vi.waitFor(() => expect(current.process).toHaveBeenCalledTimes(1));
    expect(current.disk.get('old.md')).toBe('- [ ] 普通段落\n并发正文');
    expect(current.disk.get('new.md')).toBe('- [ ] 新文件旧任务');
  });

  it('does not replace an unsaved source editor reopened while the vault operation was waiting', async () => {
    const current = fixture();
    let transaction: ReturnType<typeof vi.fn> | undefined;
    current.beforeProcess(() => { transaction = current.addSourceEditor('- [ ] 普通段落\n未保存的并发正文'); });
    current.open();
    await vi.waitFor(() => expect(current.process).toHaveBeenCalledTimes(1));
    expect(current.disk.get('old.md')).toBe('- [ ] 普通段落');
    expect(transaction).not.toHaveBeenCalled();
  });
});
