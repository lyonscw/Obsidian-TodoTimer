import {
  EditorState, Facet, MapMode, StateEffect, StateField, Transaction,
  type Extension, type Line,
} from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import {
  Decoration, EditorView, ViewPlugin,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import {
  completionChanges, creationChange, parseEntries, timestampRanges,
  type Entry, type TextChange,
} from './core';

export interface TodoTimerEditorOptions {
  clock?: () => Date;
  isLivePreview?: (state: EditorState) => boolean;
  documentId?: (state: EditorState) => string | null;
  onDocumentLeave?: (document: TodoTimerDocumentFlush) => void;
  onDocumentDetach?: () => void;
  isEnabled?: () => boolean;
}

export interface TodoTimerDocumentFlush {
  documentId: string;
  source: string;
  changes: TextChange[];
}

const optionsFacet = Facet.define<TodoTimerEditorOptions, TodoTimerEditorOptions>({
  combine: values => values[0] ?? {},
});
export const flushTodoTimerEffect = StateEffect.define<null>();
export const compositionTodoTimerEffect = StateEffect.define<boolean>();
const userInteractionEffect = StateEffect.define<null>();
const handledCompletionsEffect = StateEffect.define<null>();
const openViews = new Set<EditorView>();
const detachedDrafts = new Map<TodoTimerEditorOptions, Map<string, EditorState>>();
const resumeCompletionsEffect = StateEffect.define<PendingCompletion[]>();

interface PendingCompletion { from: number; checked: boolean }
interface EntryIndex {
  byFrom: Map<number, Entry>;
  byMarker: Map<number, Entry>;
  markerByFrom: Map<number, number>;
}
interface CandidateSnapshot {
  documentId: string | null;
  anchors: number[];
  dormantAnchors: number[];
}
const restoreCandidatesEffect = StateEffect.define<CandidateSnapshot>({
  map(snapshot, changes) {
    const map = (positions: number[]): number[] => positions.flatMap(position => {
      const mapped = changes.mapPos(position, 1, MapMode.TrackAfter);
      return mapped === null ? [] : [mapped];
    });
    return {
      documentId: snapshot.documentId,
      anchors: map(snapshot.anchors), dormantAnchors: map(snapshot.dormantAnchors),
    };
  },
});
interface ListDraft {
  from: number;
  to: number;
  marker: number;
  hasContent: boolean;
}
export interface TodoTimerEditorState {
  source: string;
  entries: Entry[];
  index: EntryIndex;
  candidates: number[];
  dormantLists: ListDraft[];
  pendingCompletions: PendingCompletion[];
  composing: boolean;
  deferredFlush: boolean;
  documentId: string | null;
  awaitingDocumentLoad: boolean;
}

function ignored(tr: Transaction): boolean {
  return tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop') ||
    tr.isUserEvent('move') || tr.isUserEvent('undo') || tr.isUserEvent('redo') ||
    tr.annotation(Transaction.remote) === true;
}

function markerPosition(entry: Entry): number {
  const marker = /^((?:[ \t]*>[ \t]?)*[ \t]*)(?:[-+*]|\d+[.)])(?=[ \t]|$)/.exec(entry.text);
  return marker ? entry.from + marker[1].length : entry.checkboxFrom ?? entry.contentFrom;
}

function listDraft(line: Line): ListDraft | undefined {
  const match = /^((?:[ \t]*>[ \t]?)*[ \t]*)(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(line.text);
  return match ? {
    from: line.from, to: line.to, marker: line.from + match[1].length,
    hasContent: line.text.slice(match[0].length).trim().length > 0,
  } : undefined;
}

function mapDraft(draft: ListDraft, tr: Transaction): ListDraft | undefined {
  const mapped = tr.changes.mapPos(draft.marker, 1, MapMode.TrackAfter);
  if (mapped !== null) {
    const next = listDraft(tr.newDoc.lineAt(mapped));
    return next?.marker === mapped ? next : undefined;
  }
  let replacement: ListDraft | undefined;
  tr.changes.iterChanges((from, to, newFrom, _newTo, inserted) => {
    if (from <= draft.marker && to > draft.marker && inserted.length && inserted.lines === 1 &&
      !tr.startState.doc.sliceString(from, to).includes('\n')) replacement = listDraft(tr.newDoc.lineAt(newFrom));
  });
  return replacement;
}

function changedDrafts(tr: Transaction): ListDraft[] {
  const result = new Map<number, ListDraft>();
  tr.changes.iterChangedRanges((_from, _to, from, to) => {
    const last = tr.newDoc.lineAt(to).number;
    for (let number = tr.newDoc.lineAt(from).number; number <= last; number++) {
      const draft = listDraft(tr.newDoc.line(number));
      if (draft) result.set(draft.marker, draft);
    }
  });
  return [...result.values()];
}

function freshlyTypedDraft(draft: ListDraft, tr: Transaction): boolean {
  const oldPosition = tr.changes.invertedDesc.mapPos(draft.marker, -1);
  const oldLine = tr.startState.doc.lineAt(oldPosition);
  if (!oldLine.text.trim()) return true;
  const oldDraft = listDraft(oldLine);
  if (oldDraft && !oldDraft.hasContent && draft.hasContent) return true;
  let insertedLine = false;
  tr.changes.iterChanges((oldFrom, oldTo, from, to, inserted) => {
    if (from <= draft.from && to >= draft.to && inserted.lines > 1 &&
      (draft.from > from || oldFrom === oldTo)) insertedLine = true;
  });
  return insertedLine;
}

function indexEntries(entries: Entry[]): EntryIndex {
  const byFrom = new Map<number, Entry>();
  const byMarker = new Map<number, Entry>();
  const markerByFrom = new Map<number, number>();
  for (const entry of entries) {
    const marker = markerPosition(entry);
    byFrom.set(entry.from, entry);
    byMarker.set(marker, entry);
    markerByFrom.set(entry.from, marker);
  }
  return { byFrom, byMarker, markerByFrom };
}

function matchEntry(entry: Entry, index: EntryIndex, tr: Transaction, oldIndex: EntryIndex): Entry | undefined {
  // Anchor to a surviving list-marker character, not a line boundary. An insertion
  // at the beginning belongs before that character; deleting it retires its identity.
  const anchor = oldIndex.markerByFrom.get(entry.from)!;
  const mapped = tr.changes.mapPos(anchor, 1, MapMode.TrackAfter);
  if (mapped !== null) {
    return index.byMarker.get(mapped);
  }

  // Some editor commands replace a whole first line. A replacement confined to
  // one line retains its slot; deleting a complete line (including its newline)
  // must never transfer that slot to its former neighbour.
  let replacement: Entry | undefined;
  tr.changes.iterChanges((from, to, newFrom, _newTo, inserted) => {
    if (from > anchor || to <= anchor || inserted.length === 0 ||
      tr.startState.doc.sliceString(from, to).includes('\n') || inserted.lines !== 1) return;
    const line = tr.newDoc.lineAt(newFrom);
    const item = index.byFrom.get(line.from);
    if (item) replacement = item;
  });
  return replacement;
}

function touched(entry: Entry, tr: Transaction): boolean {
  let result = false;
  tr.changes.iterChangedRanges((from, to) => {
    if (from <= entry.to && to >= entry.from) result = true;
  });
  return result;
}

function changedEntries(entries: Entry[], tr: Transaction): Entry[] {
  const result = new Map<number, Entry>();
  tr.changes.iterChangedRanges((_from, _to, from, to) => {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].to < from) low = middle + 1;
      else high = middle;
    }
    for (let i = low; i < entries.length && entries[i].from <= to; i++) {
      result.set(entries[i].from, entries[i]);
    }
  });
  return [...result.values()];
}

function plainContent(line: string): string {
  return line.replace(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/, '').trim();
}

function explicitTaskConversion(entry: Entry, tr: Transaction): boolean {
  if (entry.kind !== 'task') return false;
  const oldPos = tr.changes.invertedDesc.mapPos(entry.from, -1);
  const oldLine = tr.startState.doc.lineAt(oldPos).text;
  if (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(oldLine)) return false;
  // Unannotated Obsidian checklist commands retain the existing body.
  return plainContent(oldLine) === plainContent(entry.text) &&
    (plainContent(oldLine).length > 0 || !entry.hasContent);
}

function leavesCandidate(entry: Entry, tr: Transaction): boolean {
  return (tr.docChanged || tr.selection !== undefined) &&
    tr.newSelection.ranges.every(range => tr.newDoc.lineAt(range.head).number - 1 !== entry.line);
}

const derivedTransactions = new WeakMap<Transaction, TodoTimerEditorState>();

function derive(previous: TodoTimerEditorState, tr: Transaction): TodoTimerEditorState {
  const cached = derivedTransactions.get(tr);
  if (cached) return cached;
  const result = deriveTransaction(previous, tr);
  derivedTransactions.set(tr, result);
  return result;
}

function deriveTransaction(previous: TodoTimerEditorState, tr: Transaction): TodoTimerEditorState {
  const options = tr.startState.facet(optionsFacet);
  const source = tr.docChanged ? tr.newDoc.toString() : previous.source;
  const entries = tr.docChanged ? parseEntries(source) : previous.entries;
  const index = tr.docChanged ? indexEntries(entries) : previous.index;
  const documentId = options.documentId?.(tr.startState) ?? null;
  const composingEffect = tr.effects.find(effect => effect.is(compositionTodoTimerEffect));
  const composing = composingEffect ? composingEffect.value as boolean : previous.composing;
  const userAction = tr.annotation(Transaction.userEvent) !== undefined || tr.effects.some(effect => effect.is(userInteractionEffect));
  const identityChanged = documentId !== previous.documentId;
  // The host can change file metadata before replacing the old editor document.
  // A later unannotated load establishes a baseline, not a task-status transition.
  const delayedLoad = previous.awaitingDocumentLoad && tr.docChanged && !userAction;
  const reset = identityChanged || delayedLoad || tr.annotation(Transaction.remote) === true;
  if (reset) return {
    source, entries, index, documentId, composing, deferredFlush: false,
    candidates: [], dormantLists: [], pendingCompletions: [],
    awaitingDocumentLoad: (identityChanged || previous.awaitingDocumentLoad) && !tr.docChanged && !userAction,
  };

  const skipNew = ignored(tr);
  const candidates = new Set<number>();
  const dormant = new Map<number, ListDraft>();
  const settledUndoMarkers = new Set<number>();
  const matchedOld = tr.docChanged ? new Map<number, Entry>() : previous.index.byFrom;
  const oldCandidates = new Set(previous.candidates);
  if (tr.docChanged) {
    for (const oldEntry of previous.entries) {
      const entry = matchEntry(oldEntry, index, tr, previous.index);
      if (entry) matchedOld.set(entry.from, oldEntry);
      if (tr.isUserEvent('undo') && oldEntry.hasContent && !creationChange(previous.source, oldEntry, new Date(0))) {
        const oldDraft = listDraft(tr.startState.doc.lineAt(oldEntry.from));
        const mapped = oldDraft && mapDraft(oldDraft, tr);
        if (mapped) settledUndoMarkers.add(mapped.marker);
      }
      if (oldCandidates.has(oldEntry.from)) {
        const pastedOver = (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) && touched(oldEntry, tr);
        if (!pastedOver) {
          if (entry) candidates.add(entry.from);
          else {
            const oldDraft = listDraft(tr.startState.doc.lineAt(oldEntry.from));
            const mapped = oldDraft && mapDraft(oldDraft, tr);
            if (mapped) dormant.set(mapped.marker, mapped);
          }
        }
      }
    }
    for (const oldDraft of previous.dormantLists) {
      const pastedOver = (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) &&
        tr.changes.touchesRange(oldDraft.from, oldDraft.to);
      const draft = !pastedOver && mapDraft(oldDraft, tr);
      if (!draft) continue;
      const entry = index.byMarker.get(draft.marker);
      if (entry) candidates.add(entry.from);
      else dormant.set(draft.marker, draft);
    }
  } else {
    for (const from of previous.candidates) candidates.add(from);
    for (const draft of previous.dormantLists) dormant.set(draft.marker, draft);
  }

  const changed = tr.docChanged && !skipNew ? changedEntries(entries, tr) : [];
  if (tr.docChanged && !skipNew) {
    for (const entry of changed) {
      const oldEntry = matchedOld.get(entry.from);
      const typed = tr.isUserEvent('input') && !tr.isUserEvent('input.indent');
      const converted = entry.kind === 'task' && oldEntry?.kind !== 'task' && explicitTaskConversion(entry, tr);
      const draft = !oldEntry && typed ? listDraft(tr.newDoc.lineAt(entry.from)) : undefined;
      const born = draft && freshlyTypedDraft(draft, tr);
      if ((!oldEntry && typed && born) || converted ||
        (oldEntry && !oldEntry.hasContent && entry.hasContent && typed)) {
        candidates.add(entry.from);
      }
    }
    if (tr.isUserEvent('input') && !tr.isUserEvent('input.indent')) {
      for (const draft of changedDrafts(tr)) {
        if (!index.byMarker.has(draft.marker) && !dormant.has(draft.marker) && freshlyTypedDraft(draft, tr)) {
          dormant.set(draft.marker, draft);
        }
      }
    }
  }

  const snapshots = tr.effects.filter(effect => effect.is(restoreCandidatesEffect));
  const restored = snapshots[snapshots.length - 1]?.value as CandidateSnapshot | undefined;
  if (restored?.documentId === documentId) {
    candidates.clear();
    dormant.clear();
    for (const anchor of [...restored.anchors, ...restored.dormantAnchors]) {
      const entry = index.byMarker.get(anchor);
      if (entry) candidates.add(entry.from);
      else {
        const draft = listDraft(tr.newDoc.lineAt(anchor));
        if (draft?.marker === anchor) dormant.set(anchor, draft);
      }
    }
  }
  for (const marker of settledUndoMarkers) {
    const entry = index.byMarker.get(marker);
    if (entry) candidates.delete(entry.from);
    dormant.delete(marker);
  }

  // A present timestamp is authoritative; only tracked new entries are eligible.
  for (const from of candidates) {
    const entry = index.byFrom.get(from);
    if (!entry || (entry.hasContent && !creationChange(source, entry, new Date(0)))) {
      candidates.delete(from);
    }
    // Undoing a timestamp is an explicit historical restoration. Even when the
    // same history group also restores a candidate snapshot, do not timestamp it anew.
    const oldEntry = matchedOld.get(from);
    if (entry && oldEntry?.hasContent && tr.isUserEvent('undo') &&
      !creationChange(previous.source, oldEntry, new Date(0))) candidates.delete(from);
  }

  const pendingCompletions: PendingCompletion[] = [];
  const completionIndex = new Map<number, number>();
  for (const pending of previous.pendingCompletions) {
    const oldEntry = previous.index.byFrom.get(pending.from);
    const entry = oldEntry && matchEntry(oldEntry, index, tr, previous.index);
    if (entry?.kind === 'task') {
      completionIndex.set(entry.from, pendingCompletions.length);
      pendingCompletions.push({ from: entry.from, checked: !!entry.checked });
    }
  }
  if (tr.docChanged && !skipNew) {
    for (const entry of changed) {
      const oldEntry = matchedOld.get(entry.from);
      if (entry.kind === 'task' && oldEntry?.kind === 'task' && entry.checked !== oldEntry.checked) {
        const position = completionIndex.get(entry.from);
        const pending = { from: entry.from, checked: !!entry.checked };
        if (position !== undefined) pendingCompletions[position] = pending;
        else {
          completionIndex.set(entry.from, pendingCompletions.length);
          pendingCompletions.push(pending);
        }
      }
    }
  }
  if (tr.effects.some(effect => effect.is(handledCompletionsEffect))) pendingCompletions.length = 0;
  const resumed = tr.effects.find(effect => effect.is(resumeCompletionsEffect));
  if (resumed) pendingCompletions.push(...resumed.value);
  const explicitFlush = tr.effects.some(effect => effect.is(flushTodoTimerEffect));
  return {
    source, entries, index, documentId, composing, candidates: [...candidates], dormantLists: [...dormant.values()], pendingCompletions,
    deferredFlush: composing && (previous.deferredFlush || explicitFlush),
    awaitingDocumentLoad: previous.awaitingDocumentLoad && !tr.docChanged && !userAction,
  };
}

export const todoTimerStateField: StateField<TodoTimerEditorState> = StateField.define<TodoTimerEditorState>({
  create(state): TodoTimerEditorState {
    const source = state.doc.toString();
    const entries = parseEntries(source);
    const options = state.facet(optionsFacet);
    const documentId = options.documentId?.(state) ?? null;
    const cache = detachedDrafts.get(options);
    const saved = documentId ? cache?.get(documentId)?.field(todoTimerStateField, false) : undefined;
    if (saved?.source === source && options.isEnabled?.() !== false) {
      cache!.delete(documentId!);
      if (!cache!.size) detachedDrafts.delete(options);
      return { ...saved, entries, index: indexEntries(entries), composing: false, deferredFlush: false, awaitingDocumentLoad: false };
    }
    return {
      source, entries, index: indexEntries(entries), candidates: [], dormantLists: [], pendingCompletions: [],
      composing: false, deferredFlush: false,
      documentId,
      awaitingDocumentLoad: false,
    };
  },
  update(previous, tr) {
    // On extension reattachment the field is initialized from the new configuration;
    // the start state has neither our field nor its options.
    return tr.startState.field(todoTimerStateField, false) ? derive(previous, tr) : previous;
  },
});

const candidateHistory = invertedEffects.of(tr => {
  if (!tr.docChanged || tr.effects.some(effect => effect.is(handledCompletionsEffect))) return [];
  const previous = tr.startState.field(todoTimerStateField);
  const next = derive(previous, tr);
  if (next.documentId !== previous.documentId ||
    (!previous.candidates.length && !next.candidates.length && !previous.dormantLists.length && !next.dormantLists.length)) return [];
  return [restoreCandidatesEffect.of({
    documentId: previous.documentId,
    anchors: previous.candidates.flatMap(from => {
      const entry = previous.index.byFrom.get(from);
      return entry ? [previous.index.markerByFrom.get(from)!] : [];
    }),
    dormantAnchors: previous.dormantLists.map(draft => draft.marker),
  })];
});

function timestampChanges(next: TodoTimerEditorState, now: Date, eligible: (entry: Entry) => boolean): TextChange[] {
  const changes: TextChange[] = [];
  const completed = new Set<number>();
  const candidates = new Set(next.candidates);
  for (const pending of next.pendingCompletions) {
    const entry = next.index.byFrom.get(pending.from);
    if (!entry) continue;
    completed.add(entry.from);
    changes.push(...completionChanges(next.source, entry, pending.checked, now,
      candidates.has(entry.from)));
  }
  for (const from of next.candidates) {
    const entry = next.index.byFrom.get(from);
    if (!entry || completed.has(from) || !entry.hasContent || !eligible(entry)) continue;
    const change = creationChange(next.source, entry, now);
    if (change) changes.push(change);
  }
  changes.sort((a, b) => a.from - b.from || a.to - b.to);
  return changes;
}

function timestampTransaction(tr: Transaction): Transaction | readonly (Transaction | {
  changes: TextChange[]; sequential: boolean; effects: StateEffect<null>[];
})[] {
  const previous = tr.startState.field(todoTimerStateField);
  const next = derive(previous, tr);
  if (ignored(tr) || next.documentId !== previous.documentId || next.composing ||
    tr.isUserEvent('input.type.compose')) return tr;
  const now = tr.startState.facet(optionsFacet).clock?.() ?? new Date();
  const flush = tr.effects.some(effect => effect.is(flushTodoTimerEffect)) || previous.deferredFlush;
  const compositionEnded = previous.composing && !next.composing;
  const changes = timestampChanges(next, now, entry => flush || leavesCandidate(entry, tr) ||
    (compositionEnded && tr.newSelection.ranges.every(range => tr.newDoc.lineAt(range.head).number - 1 !== entry.line)));
  if (!changes.length && !next.pendingCompletions.length) return tr;
  return [tr, {
    changes, sequential: true, effects: [handledCompletionsEffect.of(null)],
  }];
}

function documentLeaving(state: EditorState): void {
  const options = state.facet(optionsFacet);
  const pending = state.field(todoTimerStateField);
  if (!options.onDocumentLeave || !pending.documentId ||
    (!pending.candidates.length && !pending.pendingCompletions.length)) return;
  const changes = timestampChanges(pending, options.clock?.() ?? new Date(), () => true);
  if (changes.length) options.onDocumentLeave({ documentId: pending.documentId, source: pending.source, changes });
}

/** A file may still be awaiting its final editor save. Never patch a different snapshot. */
export function documentFlushChanges(current: string, pending: TodoTimerDocumentFlush): TextChange[] | null {
  if (current.replace(/\r\n/g, '\n') !== pending.source) return null;
  const carriageReturns: number[] = [];
  for (let position = 0; position < current.length - 1; position++) {
    if (current[position] === '\r' && current[position + 1] === '\n') {
      carriageReturns.push(position - carriageReturns.length);
    }
  }
  const offset = (position: number): number => {
    let low = 0;
    let high = carriageReturns.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (carriageReturns[middle] < position) low = middle + 1;
      else high = middle;
    }
    return position + low;
  };
  return pending.changes.map(change => ({ ...change, from: offset(change.from), to: offset(change.to) }));
}

function decorations(view: EditorView): DecorationSet {
  if (!view.state.facet(optionsFacet).isLivePreview?.(view.state)) return Decoration.none;
  const ranges = timestampRanges(view.state.doc.toString()).map(range =>
    Decoration.mark({ class: `todotimer-time todotimer-time-${range.kind}` }).range(range.from, range.to));
  return Decoration.set(ranges, true);
}

const editorPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private lastState: EditorState;
  private compositionTimer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;
  constructor(readonly view: EditorView) {
    openViews.add(view);
    this.lastState = view.state;
    this.decorations = decorations(view);
    const options = view.state.facet(optionsFacet);
    const current = view.state.field(todoTimerStateField);
    const cache = detachedDrafts.get(options);
    const saved = current.documentId ? cache?.get(current.documentId) : undefined;
    if (saved && current.documentId) {
      cache!.delete(current.documentId);
      if (!cache!.size) detachedDrafts.delete(options);
      const draft = saved.field(todoTimerStateField);
      // Construction can run during setState/reconfiguration. Resume only after it finishes.
      queueMicrotask(() => {
        if (!this.alive || options.isEnabled?.() === false) return;
        const next = view.state.field(todoTimerStateField, false);
        if (!next || next.documentId !== draft.documentId || next.source !== draft.source) return;
        view.dispatch({ effects: [restoreCandidatesEffect.of({
          documentId: draft.documentId,
          anchors: draft.candidates.map(from => draft.index.markerByFrom.get(from)!),
          dormantAnchors: draft.dormantLists.map(item => item.marker),
        }), resumeCompletionsEffect.of(draft.pendingCompletions)] });
      });
    }
  }
  update(update: ViewUpdate) {
    if (update.startState.field(todoTimerStateField).documentId !== update.state.field(todoTimerStateField).documentId) {
      documentLeaving(update.startState);
    }
    this.lastState = update.state;
    const options = update.state.facet(optionsFacet);
    const previewChanged = options.isLivePreview?.(update.startState) !== options.isLivePreview?.(update.state);
    if (update.docChanged || previewChanged || update.transactions.some(tr => tr.reconfigured)) {
      this.decorations = decorations(this.view);
    }
  }
  startComposition() {
    if (this.compositionTimer !== undefined) clearTimeout(this.compositionTimer);
    this.view.dispatch({ effects: compositionTodoTimerEffect.of(true) });
  }
  userInteraction() {
    const state = this.view.state;
    const pending = state.field(todoTimerStateField);
    const currentId = state.facet(optionsFacet).documentId?.(state) ?? null;
    if (pending.awaitingDocumentLoad || pending.documentId !== currentId) {
      this.view.dispatch({ effects: userInteractionEffect.of(null) });
    }
  }
  endComposition() {
    // Let CodeMirror commit the final IME DOM change before flushing.
    this.compositionTimer = setTimeout(() => {
      this.compositionTimer = undefined;
      if (openViews.has(this.view)) this.view.dispatch({ effects: compositionTodoTimerEffect.of(false) });
    }, 0);
  }
  destroy() {
    this.alive = false;
    if (this.compositionTimer !== undefined) clearTimeout(this.compositionTimer);
    openViews.delete(this.view);
    const options = this.lastState.facet(optionsFacet);
    const draft = this.lastState.field(todoTimerStateField);
    if (options.isEnabled?.() === false || !draft.documentId) return;
    // A destroyed editor may immediately be rebuilt for the same note. Destruction
    // alone is not an input boundary; keep identity until the workspace confirms leaving.
    let cache = detachedDrafts.get(options);
    if (!draft.candidates.length && !draft.dormantLists.length && !draft.pendingCompletions.length) {
      cache?.delete(draft.documentId);
      if (!cache?.size) detachedDrafts.delete(options);
      options.onDocumentDetach?.();
      return;
    }
    if (!cache) detachedDrafts.set(options, cache = new Map());
    cache.set(draft.documentId, this.lastState);
    options.onDocumentDetach?.();
  }
}, {
  decorations: plugin => plugin.decorations,
  eventHandlers: {
    keydown() { this.userInteraction(); },
    mousedown() { this.userInteraction(); },
    click() { this.userInteraction(); },
    compositionstart() { this.startComposition(); },
    compositionend() { this.endComposition(); },
  },
});

export function flushTodoTimerEditors(documentId?: string): void {
  const live = new Map<TodoTimerEditorOptions, Set<string | null>>();
  for (const view of openViews) {
    const state = view.state.field(todoTimerStateField, false);
    if (!state || (documentId !== undefined && state.documentId !== documentId)) continue;
    const options = view.state.facet(optionsFacet);
    let paths = live.get(options);
    if (!paths) live.set(options, paths = new Set());
    paths.add(state.documentId);
    view.dispatch({ effects: flushTodoTimerEffect.of(null) });
  }
  for (const [options, cache] of detachedDrafts) {
    for (const [path, state] of cache) {
      if (documentId !== undefined && path !== documentId) continue;
      cache.delete(path);
      if (!live.get(options)?.has(path) && options.isEnabled?.() !== false) documentLeaving(state);
    }
    if (!cache.size) detachedDrafts.delete(options);
  }
}

export function discardTodoTimerDrafts(): void { detachedDrafts.clear(); }

export function createTodoTimerExtension(options: TodoTimerEditorOptions = {}): Extension {
  return [optionsFacet.of(options), todoTimerStateField, candidateHistory,
    EditorState.transactionFilter.of(timestampTransaction), editorPlugin];
}
