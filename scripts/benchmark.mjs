import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

// Exercise the actual transaction filter without DOM rendering or disk output.
const require = createRequire(import.meta.url);
const { EditorState } = require('@codemirror/state');
const compiled = await build({ entryPoints: ['src/editor.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['@codemirror/*'], write: false });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const { createTodoTimerExtension } = loaded.exports;
for (const lines of [200, 1000, 5000]) {
  let state = EditorState.create({ doc: '- [ ] task\n  - waiting\n'.repeat(lines / 2), extensions: createTodoTimerExtension() });
  const started = performance.now();
  for (let iteration = 0; iteration < 5; iteration++) {
    state = state.update({ changes: { from: state.doc.length - 1, insert: 'x' }, userEvent: 'input.type' }).state;
  }
  console.log(JSON.stringify({ lines, averageTransactionMs: Number(((performance.now() - started) / 5).toFixed(2)) }));
}
