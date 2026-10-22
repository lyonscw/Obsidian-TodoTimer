import { MarkdownRenderChild, MarkdownView, Notice, TFile, type MarkdownPostProcessorContext, type MarkdownSectionInformation, type Plugin } from 'obsidian';
import { completionChanges, parseEntries, timestampRanges, type Entry, type TimestampRange } from './core';

type Change = { from: number; to: number; insert: string };

// These containers can render task-looking DOM that does not belong to this source section.
const FOREIGN_CONTENT = '.internal-embed, .markdown-embed, .dataview, [class*="block-language-"], pre, code';
const NOTICE = 'TodoTimer：源内容已变化或无法准确定位，本次勾选未执行。请刷新阅读视图后重试。';

function normalized(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function sectionText(source: string, section: MarkdownSectionInformation): string {
  return normalized(source).split('\n').slice(section.lineStart, section.lineEnd + 1).join('\n');
}

function validSection(section: MarkdownSectionInformation, source: string): boolean {
  if (section.lineStart < 0 || section.lineEnd < section.lineStart || section.lineEnd >= normalized(source).split('\n').length) return false;
  const text = normalized(section.text);
  // Obsidian renderers can expose either the source document or the section text.
  return text === normalized(source) || text.replace(/\n$/, '') === sectionText(source, section).replace(/\n$/, '');
}

function nativeCheckboxes(root: HTMLElement): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox[type="checkbox"]')).filter(input => {
    const li = input.closest('li.task-list-item');
    return li !== null && root.contains(li) && !input.closest(FOREIGN_CONTENT) && input.closest('li') === li;
  });
}

function applyChanges(source: string, changes: Change[]): string {
  return [...changes].sort((a, b) => b.from - a.from).reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), source);
}

function visibleEntities(text: string, document: Document): string {
  return text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, entity => {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = entity;
    return decoder.value;
  });
}

function taskMapping(root: HTMLElement, source: string, section: MarkdownSectionInformation): Map<HTMLInputElement, number> | null {
  const tasks = parseEntries(source).filter(entry => entry.kind === 'task' && entry.line >= section.lineStart && entry.line <= section.lineEnd);
  const inputs = nativeCheckboxes(root);
  if (tasks.length !== inputs.length) return null;
  const map = new Map(inputs.map((input, index) => [input, tasks[index].line]));
  const byFrom = new Map(tasks.map((entry, index) => [entry.from, inputs[index]]));
  for (let index = 0; index < tasks.length; index++) {
    const li = inputs[index].closest('li')!;
    const parentLi = li.parentElement?.closest('li.task-list-item');
    const parentInput = parentLi ? inputs.find(input => input.closest('li') === parentLi) : undefined;
    const parentFrom = tasks[index].parentTaskFrom;
    if (parentInput !== (parentFrom === undefined ? undefined : byFrom.get(parentFrom))) return null;
    if (inputs[index].checked !== Boolean(tasks[index].checked)) return null;
    const body = source.slice(tasks[index].contentFrom, tasks[index].to).trim();
    // Plain inline source has an exact visible counterpart. This additionally rejects
    // task-looking DOM injected by an unmarked renderer without restricting Markdown.
    if (!/[`\\*_~<!|$\[\]]/.test(body.replace(/\[(?:🆕|✅)\] \d{8} \d{2}:\d{2}/gu, ''))) {
      const visible = ownTextNodes(li as HTMLElement).map(item => item.node.data).join('').trim();
      const expectedVisible = visibleEntities(body, li.ownerDocument);
      if (visible !== expectedVisible && !visible.startsWith(`${expectedVisible}\n`)) return null;
    }
  }
  return map;
}

function ownTextNodes(li: HTMLElement): { node: Text; from: number; to: number }[] {
  const firstParagraph = Array.from(li.children).find(child => child.tagName === 'P');
  const walker = li.ownerDocument.createTreeWalker(firstParagraph ?? li, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; from: number; to: number }[] = [];
  let length = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.parentElement?.closest('li') ?? li) !== li) continue;
    const value = node.textContent ?? '';
    nodes.push({ node: node as Text, from: length, to: length + value.length });
    length += value.length;
  }
  return nodes;
}

/** Wrap only a verified source suffix in native list text, leaving code and links intact. */
function styleEntry(li: HTMLElement, source: string, entry: Entry, allRanges: TimestampRange[]): void {
  const ranges = allRanges.filter(range => range.from >= entry.from && range.to <= entry.to);
  if (!ranges.length) return;
  const nodes = ownTextNodes(li);
  const visible = nodes.map(item => item.node.data).join('');
  const rawSuffix = source.slice(ranges[0].from, ranges[ranges.length - 1].to);
  const end = visible.trimEnd().length;
  if (!visible.slice(0, end).endsWith(rawSuffix)) return;
  const start = end - rawSuffix.length;
  // Work backwards so offsets inside the remaining text nodes stay valid.
  for (const range of [...ranges].reverse()) {
    const from = start + range.from - ranges[0].from;
    const to = start + range.to - ranges[0].from;
    const match = nodes.find(item => item.from <= from && item.to >= to);
    if (!match || match.node.parentElement?.closest('a, code, pre, .todotimer-time')) continue;
    const text = match.node;
    text.splitText(to - match.from);
    const stamp = text.splitText(from - match.from);
    const span = li.ownerDocument.createElement('span');
    span.className = `todotimer-time todotimer-time-${range.kind}`;
    stamp.replaceWith(span);
    span.append(stamp);
  }
}

function styleSection(root: HTMLElement, source: string, section: MarkdownSectionInformation, mapping: Map<HTMLInputElement, number>): void {
  const entries = parseEntries(source).filter(entry => entry.line >= section.lineStart && entry.line <= section.lineEnd);
  const ranges = timestampRanges(source);
  for (const [input, line] of mapping) {
    const entry = entries.find(item => item.line === line);
    if (entry) styleEntry(input.closest('li') as HTMLElement, source, entry, ranges);
  }
  const records = entries.filter(entry => entry.kind === 'record');
  const recordLis = Array.from(root.querySelectorAll<HTMLElement>('li')).filter(li => !li.classList.contains('task-list-item') && !li.closest(FOREIGN_CONTENT) && li.parentElement?.closest('li.task-list-item'));
  if (records.length === recordLis.length) records.forEach((entry, index) => styleEntry(recordLis[index], source, entry, ranges));
}

class ReadingSection extends MarkdownRenderChild {
  private active = true;
  private failed = false;
  private readonly logical = new Map<HTMLInputElement, boolean>();
  private readonly acceptedContext = new Set<string>();

  constructor(
    root: HTMLElement,
    private readonly plugin: Plugin,
    private readonly context: MarkdownPostProcessorContext,
    private readonly file: TFile,
    private source: string,
    private readonly section: MarkdownSectionInformation | null,
    private readonly mapping: Map<HTMLInputElement, number> | null,
    private readonly queue: (path: string, operation: () => Promise<void>) => void,
    private readonly clock: () => Date,
    dispose: () => void,
  ) {
    super(root);
    for (const input of nativeCheckboxes(root)) this.logical.set(input, input.checked);
    if (section) this.rememberSource(source);
    this.registerDomEvent(root, 'click', event => this.click(event), true);
    this.register(() => {
      this.active = false;
      root.querySelectorAll('.todotimer-time').forEach(span => span.replaceWith(...Array.from(span.childNodes)));
      dispose();
    });
  }

  private rememberSource(source: string): void {
    this.acceptedContext.add(normalized(source));
    if (this.section) this.acceptedContext.add(sectionText(source, this.section));
  }

  private click(event: MouseEvent): void {
    const input = event.target as HTMLInputElement | null;
    if (!input || !this.logical.has(input) || input.closest(FOREIGN_CONTENT)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const checked = !this.logical.get(input);
    // Preventing the native checkbox click restores its old property after dispatch.
    queueMicrotask(() => { if (this.active && !this.failed) input.checked = this.logical.get(input) ?? false; });
    const live = this.context.getSectionInfo(this.containerEl);
    if (this.failed || !this.section || !this.mapping || !live || live.lineStart !== this.section.lineStart || live.lineEnd !== this.section.lineEnd || !this.acceptedContext.has(normalized(live.text))) {
      this.reject();
      return;
    }
    const line = this.mapping.get(input);
    if (line === undefined) { this.reject(); return; }
    this.logical.set(input, checked);
    this.queue(this.file.path, async () => {
      if (!this.active || this.failed) return;
      try {
        const views = this.plugin.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === this.file.path && view.getMode() === 'source');
        let nextSource: string | undefined;
        if (views.length) {
          const current = views[0].editor.getValue();
          if (views.some(view => view.editor.getValue() !== current)) throw new Error('Conflicting editors');
          const changes = this.changes(current, line, checked);
          views[0].editor.transaction({ changes: changes.map(change => ({ from: views[0].editor.offsetToPos(change.from), to: views[0].editor.offsetToPos(change.to), text: change.insert })) }, 'todotimer-reading');
          nextSource = applyChanges(current, changes);
        } else {
          await this.plugin.app.vault.process(this.file, current => {
            const changes = this.changes(current, line, checked);
            nextSource = applyChanges(current, changes);
            return nextSource;
          });
        }
        if (nextSource !== undefined) {
          this.source = nextSource;
          this.rememberSource(nextSource);
        }
      } catch {
        this.reject();
      }
    });
  }

  private changes(current: string, line: number, checked: boolean): Change[] {
    if (!this.active || !this.section || sectionText(current, this.section) !== sectionText(this.source, this.section)) throw new Error('Stale section');
    const expected = parseEntries(this.source).find(entry => entry.kind === 'task' && entry.line === line);
    const entry = parseEntries(current).find(entry => entry.kind === 'task' && entry.line === line);
    if (!entry || !expected || entry.text !== expected.text || entry.checkboxFrom === undefined) throw new Error('Task no longer matches');
    return completionChanges(current, entry, checked, this.clock());
  }

  private reject(): void {
    if (!this.active) return;
    if (!this.failed) new Notice(NOTICE);
    this.failed = true;
    for (const [input, line] of this.mapping ?? []) {
      const checked = Boolean(parseEntries(this.source).find(entry => entry.line === line)?.checked);
      this.logical.set(input, checked);
      input.checked = checked;
    }
    queueMicrotask(() => { if (this.active) for (const [input, checked] of this.logical) input.checked = checked; });
  }
}

/** Install native reading-view handling; renderer and plugin lifecycles both clean up. */
export function registerTodoTimerReading(plugin: Plugin, clock: () => Date = () => new Date()): void {
  let active = true;
  const children = new Set<ReadingSection>();
  const queues = new Map<string, Promise<void>>();
  const queue = (path: string, operation: () => Promise<void>): void => {
    const next = (queues.get(path) ?? Promise.resolve()).then(operation);
    queues.set(path, next);
    void next.finally(() => { if (queues.get(path) === next) queues.delete(path); });
  };
  plugin.register(() => { active = false; for (const child of children) child.unload(); children.clear(); });
  plugin.registerMarkdownPostProcessor(async (root, context) => {
    if (root.closest(FOREIGN_CONTENT)) return;
    const inputs = nativeCheckboxes(root);
    if (!inputs.length) return;
    const file = plugin.app.vault.getAbstractFileByPath(context.sourcePath);
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const source = await plugin.app.vault.cachedRead(file);
    if (!active) return;
    const info = context.getSectionInfo(root);
    const section = info && validSection(info, source) ? info : null;
    const mapping = section ? taskMapping(root, source, section) : null;
    // A structural mismatch indicates generated/modified DOM, which is not ours to own.
    if (section && !mapping) return;
    if (mapping && section) styleSection(root, source, section, mapping);
    const child = new ReadingSection(root, plugin, context, file, source, section, mapping, queue, clock, () => children.delete(child));
    children.add(child);
    context.addChild(child);
  });
}
