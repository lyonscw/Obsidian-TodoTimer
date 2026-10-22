import { MarkdownView, Plugin, TFile, editorInfoField, editorLivePreviewField } from 'obsidian';
import { createTodoTimerExtension, discardTodoTimerDrafts, documentFlushChanges, flushTodoTimerEditors, type TodoTimerDocumentFlush } from './editor';
import { registerTodoTimerReading } from './reading';

export default class TodoTimerPlugin extends Plugin {
  private readonly pendingDocuments = new Map<string, TodoTimerDocumentFlush>();
  private readonly writingDocuments = new Set<string>();
  private readonly retryDocuments = new Set<string>();
  private stopped = false;
  private activeDocument: { view: MarkdownView; path: string; mode: string } | null = null;

  private currentDocument(): { view: MarkdownView; path: string; mode: string } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file ? { view, path: view.file.path, mode: view.getMode() } : null;
  }

  onload(): void {
    this.activeDocument = this.currentDocument();
    const confirmBoundary = (): void => {
      if (this.stopped) return;
      const next = this.currentDocument();
      const previous = this.activeDocument;
      const previousStillSource = previous && this.app.workspace.getLeavesOfType('markdown').some(leaf =>
        leaf.view === previous.view && previous.view.file?.path === previous.path && previous.view.getMode() === 'source');
      if (previous?.mode === 'source' &&
        ((next && (next.path !== previous.path || next.mode !== 'source')) || !previousStillSource)) {
        flushTodoTimerEditors(previous.path);
      }
      if (next || !previousStillSource) this.activeDocument = next;
      for (const path of this.pendingDocuments.keys()) void this.persistDocument(path);
    };
    this.registerEditorExtension(createTodoTimerExtension({
      isLivePreview: state => state.field(editorLivePreviewField, false) ?? false,
      documentId: state => state.field(editorInfoField, false)?.file?.path ?? null,
      isEnabled: () => !this.stopped,
      onDocumentLeave: document => {
        if (this.stopped) return;
        this.pendingDocuments.set(document.documentId, document);
        queueMicrotask(() => { if (!this.stopped) void this.persistDocument(document.documentId); });
      },
      onDocumentDetach: () => { queueMicrotask(confirmBoundary); },
    }));
    registerTodoTimerReading(this);
    const scheduleBoundary = (): void => { queueMicrotask(confirmBoundary); };
    this.registerEvent(this.app.workspace.on('active-leaf-change', scheduleBoundary));
    this.registerEvent(this.app.workspace.on('file-open', scheduleBoundary));
    this.registerEvent(this.app.workspace.on('layout-change', scheduleBoundary));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (this.pendingDocuments.has(file.path)) void this.persistDocument(file.path);
    }));
  }

  onunload(): void {
    this.stopped = true;
    discardTodoTimerDrafts();
    this.pendingDocuments.clear();
  }

  private async persistDocument(path: string): Promise<void> {
    if (this.stopped) return;
    if (this.writingDocuments.has(path)) {
      this.retryDocuments.add(path);
      return;
    }
    const pending = this.pendingDocuments.get(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!pending || !(file instanceof TFile)) return;
    this.writingDocuments.add(path);
    try {
      // Other panes can still have this file open. Keep their editor state and undo history.
      const views = this.app.workspace.getLeavesOfType('markdown')
        .map(leaf => leaf.view)
        .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source');
      if (views.length) {
        const current = views[0].editor.getValue();
        const changes = documentFlushChanges(current, pending);
        if (!changes || views.some(view => view.editor.getValue() !== current)) return;
        views[0].editor.transaction({ changes: changes.map(change => ({
          from: views[0].editor.offsetToPos(change.from), to: views[0].editor.offsetToPos(change.to), text: change.insert,
        })) }, 'todotimer-file-leave');
        if (this.pendingDocuments.get(path) === pending) this.pendingDocuments.delete(path);
        return;
      }
      // The old file's final autosave can arrive after file-open. A matching modify
      // event retries this exact snapshot; unrelated or concurrent text is never replaced.
      const current = await this.app.vault.read(file);
      if (this.stopped || !documentFlushChanges(current, pending) || this.pendingDocuments.get(path) !== pending) return;
      let applied = false;
      await this.app.vault.process(file, latest => {
        if (this.stopped || this.pendingDocuments.get(path) !== pending) return latest;
        // A pane may have reopened the file while the asynchronous read/process
        // was waiting. Re-enter through its editor rather than replacing its buffer.
        if (this.app.workspace.getLeavesOfType('markdown').some(leaf =>
          leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.getMode() === 'source')) {
          this.retryDocuments.add(path);
          return latest;
        }
        const changes = documentFlushChanges(latest, pending);
        if (!changes) return latest;
        applied = true;
        return [...changes].reverse().reduce((text, change) =>
          text.slice(0, change.from) + change.insert + text.slice(change.to), latest);
      });
      if (applied && this.pendingDocuments.get(path) === pending) this.pendingDocuments.delete(path);
    } catch {
      // Keep the snapshot for a later file-open/modify event if saving is temporarily unavailable.
    } finally {
      this.writingDocuments.delete(path);
      if (this.retryDocuments.delete(path) && !this.stopped && this.pendingDocuments.has(path)) void this.persistDocument(path);
    }
  }
}
