import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView, TFile, type MarkdownPostProcessorContext, type Plugin } from 'obsidian';
import { registerTodoTimerReading } from '../src/reading';

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock('obsidian', () => ({
  Notice: class { constructor(message: string) { notices.push(message); } },
  TFile: class { extension = 'md'; path = ''; },
  MarkdownView: class {},
  MarkdownRenderChild: class {
    callbacks: (() => void)[] = [];
    constructor(public containerEl: HTMLElement) {}
    register(callback: () => void) { this.callbacks.push(callback); }
    registerDomEvent(el: HTMLElement, type: string, listener: EventListener, options?: boolean) {
      el.addEventListener(type, listener, options);
      this.register(() => el.removeEventListener(type, listener, options));
    }
    unload() { this.callbacks.splice(0).reverse().forEach(callback => callback()); }
  },
}));

const now = () => new Date(2026, 0, 3, 14, 20);

async function fixture(initial: string, html: string, bounds?: [number, number], rootTag = 'div') {
  let source = initial;
  let processor!: (root: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void>;
  const cleanups: (() => void)[] = [];
  const leaves: { view: MarkdownView }[] = [];
  const process = vi.fn(async (_file: TFile, transform: (value: string) => string) => { source = transform(source); });
  const file = Object.assign(new TFile(), { path: 'Work.md' });
  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: () => file,
        cachedRead: async () => source,
        process,
      },
      workspace: { getLeavesOfType: () => leaves },
    },
    register: (callback: () => void) => cleanups.push(callback),
    registerMarkdownPostProcessor: (callback: typeof processor) => { processor = callback; },
  } as unknown as Plugin;
  const context = {
    sourcePath: 'Work.md',
    docId: 'test',
    frontmatter: null,
    addChild: vi.fn(),
    getSectionInfo: vi.fn(() => ({ text: initial, lineStart: bounds?.[0] ?? 0, lineEnd: bounds?.[1] ?? initial.split('\n').length - 1 })),
  } as unknown as MarkdownPostProcessorContext;
  const root = document.createElement(rootTag);
  if (rootTag === 'li') root.classList.add('task-list-item');
  root.innerHTML = html;
  document.body.append(root);
  registerTodoTimerReading(plugin, now);
  await processor(root, context);
  return {
    root, context, process, leaves,
    inputs: () => [...root.querySelectorAll<HTMLInputElement>('input')],
    source: () => source,
    setSource: (value: string) => { source = value; },
    unload: () => cleanups.forEach(callback => callback()),
  };
}

const task = (text: string, checked = false) => `<li class="task-list-item" data-task="${checked ? 'x' : ' '}"><input type="checkbox" class="task-list-item-checkbox" ${checked ? 'checked' : ''}> ${text}</li>`;
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

beforeEach(() => { document.body.replaceChildren(); notices.length = 0; });

describe('native reading-view checkboxes', () => {
  it('updates checkbox and completion time atomically without adding creation time to old tasks', async () => {
    const f = await fixture('- [ ] old task', `<ul>${task('old task')}</ul>`);
    const native = vi.fn();
    f.root.addEventListener('click', native);
    f.inputs()[0].click();
    await settle();
    expect(f.source()).toBe('- [x] old task ✅ 20260103 14:20');
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
    f.inputs()[0].click();
    await settle();
    expect(f.source()).toBe('- [ ] old task');
    expect(f.process).toHaveBeenCalledTimes(2);
  });

  it('maps repeated text by source order, retaining nested task independence', async () => {
    const source = '# Work\n\n- [ ] repeated\n  - [ ] repeated\n- [ ] repeated';
    const f = await fixture(source, `<ul><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox"> repeated<ul>${task('repeated')}</ul></li>${task('repeated')}</ul>`, [2, 4]);
    f.inputs()[1].click();
    await settle();
    expect(f.source()).toBe('# Work\n\n- [ ] repeated\n  - [x] repeated ✅ 20260103 14:20\n- [ ] repeated');
    f.inputs()[2].click();
    await settle();
    expect(f.source()).toContain('\n- [x] repeated ✅ 20260103 14:20');
    expect(f.source()).toContain('\n- [ ] repeated\n  - [x]');
  });

  it('serializes rapid clicks against its own latest result', async () => {
    const f = await fixture('- [ ] task 📝 20260101 17:00', `<ul>${task('task 📝 20260101 17:00')}</ul>`);
    f.inputs()[0].click();
    f.inputs()[0].click();
    f.inputs()[0].click();
    await settle();
    expect(f.source()).toBe('- [x] task 📝 20260101 17:00 ✅ 20260103 14:20');
    expect(f.process).toHaveBeenCalledTimes(3);
    expect(notices).toEqual([]);
  });

  it('aborts on a stale target rather than looking for the first matching task', async () => {
    const f = await fixture('- [ ] repeated\n- [ ] repeated', `<ul>${task('repeated')}${task('repeated')}</ul>`);
    f.setSource('- [ ] edited in another pane\n- [ ] repeated');
    f.inputs()[1].click();
    await settle();
    expect(f.source()).toBe('- [ ] edited in another pane\n- [ ] repeated');
    expect(notices).toHaveLength(1);
  });

  it('allows unrelated section changes while checking the exact original line range', async () => {
    const f = await fixture('# Old\n\n- [ ] task', `<ul>${task('task')}</ul>`, [2, 2]);
    f.setSource('# New\n\n- [ ] task');
    f.inputs()[0].click();
    await settle();
    expect(f.source()).toBe('# New\n\n- [x] task ✅ 20260103 14:20');
    expect(notices).toEqual([]);
  });

  it('blocks an unlocatable native click when getSectionInfo becomes null', async () => {
    const f = await fixture('- [ ] task', `<ul>${task('task')}</ul>`);
    vi.mocked(f.context.getSectionInfo).mockReturnValue(null);
    f.inputs()[0].click();
    await settle();
    expect(f.process).not.toHaveBeenCalled();
    expect(f.source()).toBe('- [ ] task');
    expect(notices).toHaveLength(1);
  });

  it('does not take over generated lists or embedded source', async () => {
    const f = await fixture('- [ ] original', `<div class="dataview"><ul>${task('generated')}</ul></div>`);
    f.inputs()[0].click();
    await settle();
    expect(f.process).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
    const embedded = await fixture('- [ ] original', `<div class="internal-embed"><ul>${task('embedded')}</ul></div>`);
    embedded.inputs()[0].click();
    await settle();
    expect(embedded.process).not.toHaveBeenCalled();
  });

  it('does not take over DOM with a mismatched task count or hierarchy', async () => {
    const f = await fixture('- [ ] original', `<ul>${task('original')}${task('generated')}</ul>`);
    f.inputs()[0].click();
    await settle();
    expect(f.process).not.toHaveBeenCalled();
    const nested = await fixture('- [ ] parent\n  - [ ] child', `<ul>${task('parent')}${task('child')}</ul>`);
    nested.inputs()[0].click();
    await settle();
    expect(nested.process).not.toHaveBeenCalled();
    const replaced = await fixture('- [ ] original', `<ul>${task('generated')}</ul>`);
    replaced.inputs()[0].click();
    await settle();
    expect(replaced.process).not.toHaveBeenCalled();
  });

  it('uses one editor transaction when an identical source editor is open', async () => {
    const initial = '- [ ] task';
    const f = await fixture(initial, `<ul>${task('task')}</ul>`);
    let value = initial;
    const transaction = vi.fn((tx: { changes: { from: { ch: number }; to: { ch: number }; text: string }[] }) => {
      for (const change of [...tx.changes].reverse()) value = value.slice(0, change.from.ch) + change.text + value.slice(change.to.ch);
    });
    const view = Object.assign(new MarkdownView({} as never), {
      file: Object.assign(new TFile(), { path: 'Work.md' }), getMode: () => 'source',
      editor: { getValue: () => value, offsetToPos: (offset: number) => ({ line: 0, ch: offset }), transaction },
    });
    f.leaves.push({ view });
    f.inputs()[0].click();
    await settle();
    expect(value).toBe('- [x] task ✅ 20260103 14:20');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0].changes).toHaveLength(2);
    expect(f.process).not.toHaveBeenCalled();
  });

  it('rejects diverging editors and changes to the task position', async () => {
    const f = await fixture('- [ ] task', `<ul>${task('task')}</ul>`);
    for (const value of ['- [ ] task', '- [ ] unsaved elsewhere']) {
      f.leaves.push({ view: Object.assign(new MarkdownView({} as never), { file: Object.assign(new TFile(), { path: 'Work.md' }), getMode: () => 'source', editor: { getValue: () => value } }) });
    }
    f.inputs()[0].click();
    await settle();
    expect(f.process).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1);
    const moved = await fixture('# Header\n- [ ] task', `<ul>${task('task')}</ul>`, [1, 1]);
    moved.setSource('# Header\nother\n- [ ] task');
    moved.inputs()[0].click();
    await settle();
    expect(moved.source()).toBe('# Header\nother\n- [ ] task');
  });
});

describe('reading-view timestamps and lifecycle', () => {
  it('styles only canonical list suffixes while preserving text, code, and links', async () => {
    const source = '- [x] **task** 📝 20260101 17:00 ✅ 20260103 14:20\n  - 等待：审批 20260102 08:00\n  - `20260102 08:00`\n  - [20260102 08:00](https://example.com)';
    const f = await fixture(source, `<ul><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked> <strong>task</strong> 📝 20260101 17:00 ✅ 20260103 14:20<ul><li>等待：审批 20260102 08:00</li><li><code>20260102 08:00</code></li><li><a href="https://example.com">20260102 08:00</a></li></ul></li></ul>`);
    expect([...f.root.querySelectorAll('.todotimer-time')].map(el => el.textContent)).toEqual(['📝 20260101 17:00', '✅ 20260103 14:20', '20260102 08:00']);
    expect(f.root.querySelector('code .todotimer-time')).toBeNull();
    expect(f.root.querySelector('a .todotimer-time')).toBeNull();
    const text = f.root.textContent;
    f.unload();
    expect(f.root.querySelector('.todotimer-time')).toBeNull();
    expect(f.root.textContent).toBe(text);
    f.inputs()[0].click();
    await settle();
    expect(f.process).not.toHaveBeenCalled();
  });

  it('accepts section-only context text and CRLF source', async () => {
    const source = '# Work\r\n\r\n- [ ] task';
    const f = await fixture(source, `<ul>${task('task')}</ul>`, [2, 2]);
    vi.mocked(f.context.getSectionInfo).mockReturnValue({ text: '- [ ] task', lineStart: 2, lineEnd: 2 });
    f.inputs()[0].click();
    await settle();
    expect(f.source()).toBe('# Work\r\n\r\n- [x] task ✅ 20260103 14:20');
  });

  it('accepts native ul and li roots, entity rendering, and other tasks in the same section', async () => {
    const f = await fixture('- [ ] A &amp; B\n- [ ] another', `${task('A &amp; B')}${task('another')}`, undefined, 'ul');
    f.inputs()[0].click();
    await settle();
    f.inputs()[1].click();
    await settle();
    expect(f.source()).toBe('- [x] A &amp; B ✅ 20260103 14:20\n- [x] another ✅ 20260103 14:20');
    const nativeLi = await fixture('- [ ] A &#38; B', '<input type="checkbox" class="task-list-item-checkbox"> A &amp; B', undefined, 'li');
    nativeLi.inputs()[0].click();
    await settle();
    expect(nativeLi.source()).toBe('- [x] A &#38; B ✅ 20260103 14:20');
    expect(notices).toEqual([]);
  });
});
