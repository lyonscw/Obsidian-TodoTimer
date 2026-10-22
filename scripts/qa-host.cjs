// Runs only in the disposable QA vault; never included in the shipped plugin.
const { Plugin, MarkdownView, apiVersion, editorLivePreviewField } = require('obsidian');
const { Transaction } = require('@codemirror/state');
const { undo, redo, isolateHistory } = require('@codemirror/commands');

module.exports = class TodoTimerHostQA extends Plugin {
  onload() {
    this.addCommand({ id: 'run-host-checks', name: 'Run host checks', callback: () => this.run() });
    this.app.workspace.onLayoutReady(() => setTimeout(() => this.run(), 1200));
  }
  async run() {
    const result = { runAt: new Date().toISOString(), version: apiVersion, pluginVersion: this.app.plugins.getPlugin('todotimer')?.manifest.version, checks: [], errors: [] };
    const check = (name, condition, actual) => {
      result.checks.push({ name, passed: Boolean(condition), actual });
      if (!condition) throw new Error(name + ': ' + actual);
    };
    const pause = () => new Promise(resolve => setTimeout(resolve, 100));
    const until = async (predicate, label) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await predicate()) return;
        await pause();
      }
      throw new Error('Timed out: ' + label);
    };
    try {
      check('plugin loaded', Boolean(this.app.plugins.getPlugin('todotimer')));
      let file = this.app.vault.getAbstractFileByPath('Host-smoke.md');
      if (!file) file = await this.app.vault.create('Host-smoke.md', '');
      await this.app.workspace.getLeaf(false).openFile(file, { state: { mode: 'source' } });
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const editor = view.editor;
      // editor.cm is intentionally confined to host tests, not the production plugin.
      const cm = editor.cm;
      check('host CodeMirror view available', Boolean(cm?.dispatch));
      const reset = text => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text }, selection: { anchor: text.length }, annotations: [Transaction.remote.of(true), isolateHistory.of('full')] });
      const type = text => cm.dispatch({ changes: { from: cm.state.selection.main.head, insert: text }, selection: { anchor: cm.state.selection.main.head + text.length }, userEvent: 'input.type' });
      reset('');
      type('- [ ] 保持当前行');
      await view.save();
      await pause();
      check('same line autosave does not timestamp', editor.getValue() === '- [ ] 保持当前行', editor.getValue());
      reset('');
      type('- [ ] 真机新任务');
      type('\n');
      let value = editor.getValue();
      check('new task on Enter', /真机新任务 📝 \d{8} \d{2}:\d{2}\n/.test(value), value);
      reset('- [ ] 旧任务');
      cm.dispatch({ changes: { from: 3, to: 4, insert: 'x' }, userEvent: 'input' });
      value = editor.getValue();
      check('old task completion only', /^- \[x\] 旧任务 ✅ \d{8} \d{2}:\d{2}$/.test(value), value);
      undo(cm);
      check('checkbox + timestamp undo together', editor.getValue() === '- [ ] 旧任务', editor.getValue());
      redo(cm);
      check('redo restores original completion', editor.getValue() === value, editor.getValue());
      cm.dispatch({ changes: { from: 3, to: 4, insert: ' ' }, userEvent: 'input' });
      check('uncheck removes completion', editor.getValue() === '- [ ] 旧任务', editor.getValue());
      reset('- [ ] 父任务\n');
      type('  - 等待：开通网络');
      type('\n');
      value = editor.getValue();
      check('ordinary record bare timestamp', /等待：开通网络 \d{8} \d{2}:\d{2}\n/.test(value) && !value.includes('🆕'), value);

      const removeNewChildCheckbox = () => {
        let body = editor.getValue().indexOf('新进展');
        cm.dispatch({ selection: { anchor: body } });
        for (let i = 0; i < 4; i++) {
          cm.dispatch({ changes: { from: body - 1, to: body, insert: '' }, selection: { anchor: body - 1 }, userEvent: 'delete.backward' });
          body--;
        }
        cm.dispatch({ selection: { anchor: cm.state.doc.length } });
        type('\n\t- ');
      };
      reset('- [ ] 父任务\n');
      type('\t- [ ] 新进展');
      removeNewChildCheckbox();
      value = editor.getValue();
      check('new child task converted to record keeps bare timestamp', /^- \[ \] 父任务\n\t- 新进展 \d{8} \d{2}:\d{2}\n\t- $/.test(value), value);
      reset('- [ ] 父任务\n\t- [ ] 新进展');
      removeNewChildCheckbox();
      value = editor.getValue();
      check('old child task converted to record is not backfilled', value === '- [ ] 父任务\n\t- 新进展\n\t- ', value);

      const indentLastLine = () => {
        cm.dispatch({ changes: { from: cm.state.doc.line(2).from, insert: '\t' }, selection: { anchor: cm.state.doc.length + 1 }, userEvent: 'input.indent' });
        cm.dispatch({ selection: { anchor: 0 } });
      };
      reset('- [ ] 父任务\n');
      type('- 等待审批');
      indentLastLine();
      value = editor.getValue();
      check('new ordinary sibling becomes timed record after indent', /^- \[ \] 父任务\n\t- 等待审批 \d{8} \d{2}:\d{2}$/.test(value), value);
      reset('- [ ] 父任务\n- 等待审批');
      indentLastLine();
      value = editor.getValue();
      check('old ordinary sibling indent is not backfilled', value === '- [ ] 父任务\n\t- 等待审批', value);
      reset('- [ ] 父任务\n');
      cm.dispatch({ changes: { from: cm.state.doc.length, insert: '- 等待审批' }, selection: { anchor: cm.state.doc.length + 6 }, userEvent: 'input.paste' });
      indentLastLine();
      value = editor.getValue();
      check('pasted ordinary sibling indent is not backfilled', value === '- [ ] 父任务\n\t- 等待审批', value);
      for (const pasted of [false, true]) {
        reset(pasted ? '- [ ] 父任务\n' : '- [ ] 父任务\n- 等待审批');
        if (pasted) cm.dispatch({ changes: { from: cm.state.doc.length, insert: '- 等待审批' }, userEvent: 'input.paste' });
        cm.dispatch({ changes: { from: cm.state.doc.line(2).from, insert: '  ' }, selection: { anchor: cm.state.doc.length + 2 }, userEvent: 'input.type' });
        cm.dispatch({ selection: { anchor: 0 } });
        value = editor.getValue();
        check((pasted ? 'pasted' : 'old') + ' ordinary sibling manual space indent is not backfilled', value === '- [ ] 父任务\n  - 等待审批', value);
      }

      reset('');
      const pasted = '- [ ] 粘贴旧记录';
      cm.dispatch({ changes: { from: 0, insert: pasted }, selection: { anchor: pasted.length }, userEvent: 'input.paste' });
      cm.dispatch({ selection: { anchor: 0 } });
      check('paste preserved', editor.getValue() === '- [ ] 粘贴旧记录', editor.getValue());
      reset('普通段落');
      cm.dispatch({ changes: { from: 0, insert: '- [ ] ' }, selection: { anchor: 10 } });
      cm.dispatch({ selection: { anchor: 0 } });
      editor.setCursor({ line: 0, ch: 0 });
      // Switching away is also a flush; the conversion must be stamped once.
      await this.app.workspace.openLinkText('手动验收', '', false);
      let conversion = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        await pause();
        conversion = await this.app.vault.read(file);
        if (conversion.includes('普通段落 📝')) break;
      }
      check('native-style conversion + file switch', conversion.includes('普通段落 📝'), conversion);

      const readingText = '# 阅读验收\n\n- [ ] 相同任务 📝 20260101 17:00\n  - [ ] 相同任务\n- [ ] 相同任务\n- [ ] A &amp; B\n';
      let readingFile = this.app.vault.getAbstractFileByPath('Host-reading.md');
      if (readingFile) await this.app.vault.modify(readingFile, readingText);
      else readingFile = await this.app.vault.create('Host-reading.md', readingText);
      const readingLeaf = this.app.workspace.getLeaf(false);
      await readingLeaf.openFile(readingFile, { state: { mode: 'preview' } });
      const readingView = readingLeaf.view;
      const inputs = () => [...readingView.previewMode.containerEl.querySelectorAll('input.task-list-item-checkbox')];
      const ready = async () => until(() => inputs().length === 4 && readingView.previewMode.containerEl.querySelector('.todotimer-time-created'), 'reading postprocessor');
      await ready();
      inputs()[1].click();
      await until(async () => (await this.app.vault.read(readingFile)).includes('  - [x] 相同任务 ✅'), 'nested checkbox');
      let readingValue = await this.app.vault.read(readingFile);
      check('reading nested duplicate maps exact line', /^# 阅读验收\n\n- \[ \] 相同任务 📝 20260101 17:00\n  - \[x\] 相同任务 ✅ \d{8} \d{2}:\d{2}\n- \[ \] 相同任务\n- \[ \] A &amp; B\n$/.test(readingValue), readingValue);
      await ready();
      inputs()[1].click();
      await until(async () => (await this.app.vault.read(readingFile)) === readingText, 'reading uncheck');
      check('reading uncheck removes only completion', true, await this.app.vault.read(readingFile));
      await ready();
      inputs()[3].click();
      await until(async () => (await this.app.vault.read(readingFile)).includes('- [x] A &amp; B ✅'), 'entity checkbox');
      check('reading HTML entity keeps original Markdown', true, await this.app.vault.read(readingFile));
      await ready();
      inputs()[2].click();
      inputs()[2].click();
      await until(async () => {
        const value = await this.app.vault.read(readingFile);
        return value.split('\n')[4] === '- [ ] 相同任务';
      }, 'rapid double toggle');
      await pause();
      check('reading rapid toggle retains final unchecked state', (await this.app.vault.read(readingFile)).split('\n')[4] === '- [ ] 相同任务', await this.app.vault.read(readingFile));

      const sourceLeaf = this.app.workspace.getLeaf('split');
      await sourceLeaf.openFile(readingFile, { state: { mode: 'source' } });
      await ready();
      inputs()[2].click();
      await until(() => sourceLeaf.view.editor.getValue().split('\n')[4].startsWith('- [x] 相同任务 ✅'), 'split editor sync');
      readingValue = sourceLeaf.view.editor.getValue();
      check('reading and source split synchronize once', (readingValue.split('\n')[4].match(/✅/gu) || []).length === 1, readingValue);
      sourceLeaf.view.editor.undo();
      await until(() => sourceLeaf.view.editor.getValue().split('\n')[4] === '- [ ] 相同任务', 'split editor undo');
      check('reading write undo through source editor', true, sourceLeaf.view.editor.getValue());

      await sourceLeaf.setViewState({ type: 'markdown', state: { file: readingFile.path, mode: 'source', source: true } });
      const sourceCM = sourceLeaf.view.editor.cm;
      await until(() => sourceCM.state.field(editorLivePreviewField, false) === false, 'raw source mode');
      check('raw source preserves full Markdown without decorations', sourceLeaf.view.editor.getValue().includes('📝 20260101 17:00') && !sourceCM.dom.querySelector('.todotimer-time'), sourceLeaf.view.editor.getValue());
      await sourceLeaf.setViewState({ type: 'markdown', state: { file: readingFile.path, mode: 'source', source: false } });
      await until(() => sourceLeaf.view.editor.cm.dom.querySelector('.todotimer-time-created'), 'Live Preview decorations');
      check('Live Preview restores timestamp decorations', true);

      const lifecycleCM = sourceLeaf.view.editor.cm;
      const unchanged = sourceLeaf.view.editor.getValue();
      await this.app.plugins.disablePlugin('todotimer');
      check('plugin disabled without changing existing content', !this.app.plugins.getPlugin('todotimer') && sourceLeaf.view.editor.getValue() === unchanged);
      lifecycleCM.dispatch({ changes: { from: 0, to: lifecycleCM.state.doc.length, insert: '' }, annotations: Transaction.remote.of(true) });
      const offText = '- [ ] disabled task\n';
      lifecycleCM.dispatch({ changes: { from: 0, insert: offText }, selection: { anchor: offText.length }, userEvent: 'input.type' });
      check('disabled plugin does not timestamp input', sourceLeaf.view.editor.getValue() === offText, sourceLeaf.view.editor.getValue());
      await this.app.plugins.enablePlugin('todotimer');
      const enabledCM = sourceLeaf.view.editor.cm;
      enabledCM.dispatch({ changes: { from: 0, to: enabledCM.state.doc.length, insert: '' }, annotations: Transaction.remote.of(true) });
      const onText = '- [ ] enabled task\n';
      enabledCM.dispatch({ changes: { from: 0, insert: onText }, selection: { anchor: onText.length }, userEvent: 'input.type' });
      check('re-enabled plugin timestamps once', /^- \[ \] enabled task 📝 \d{8} \d{2}:\d{2}\n$/.test(sourceLeaf.view.editor.getValue()), sourceLeaf.view.editor.getValue());
      enabledCM.dispatch({ changes: { from: 0, to: enabledCM.state.doc.length, insert: '' }, annotations: Transaction.remote.of(true) });
      const previewText = '- [ ] preview pending';
      enabledCM.dispatch({ changes: { from: 0, insert: previewText }, selection: { anchor: previewText.length }, userEvent: 'input.type' });
      await sourceLeaf.setViewState({ type: 'markdown', state: { file: readingFile.path, mode: 'preview' } });
      await until(async () => (await this.app.vault.read(readingFile)).includes('preview pending 📝'), 'switch to reading settles current input');
      check('entering reading mode settles pending creation', true, await this.app.vault.read(readingFile));
      sourceLeaf.detach();
      await this.app.workspace.openLinkText('手动验收', '', false);
    } catch (error) {
      result.errors.push(String(error?.stack || error));
    }
    await this.app.vault.adapter.write('host-results.json', JSON.stringify(result, null, 2));
    console.log('TodoTimer host QA', result);
  }
};
