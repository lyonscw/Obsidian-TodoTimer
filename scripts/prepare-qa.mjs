import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const vault = new URL('.qa-vault/', root);
const profile = new URL('.qa-artifacts/profile/', root);
const plugin = new URL('.obsidian/plugins/todotimer/', vault);
const harness = new URL('.obsidian/plugins/todotimer-qa/', vault);
await Promise.all([plugin, harness, profile].map(path => mkdir(path, { recursive: true })));
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const initialJson = async (path, value) => {
  try { await access(path); } catch { await json(path, value); }
};
for (const name of ['main.js', 'manifest.json', 'styles.css']) await copyFile(new URL(name, root), new URL(name, plugin));
await initialJson(new URL('.obsidian/app.json', vault), { livePreview: true, defaultViewMode: 'source', readableLineLength: false });
await json(new URL('.obsidian/community-plugins.json', vault), ['todotimer', 'todotimer-qa']);
await json(new URL('.obsidian/core-plugins.json', vault), ['file-explorer', 'switcher', 'command-palette']);
await initialJson(new URL('obsidian.json', profile), { vaults: { todotimerqa: { path: fileURLToPath(vault).replace(/[\\/]$/, ''), ts: Date.now(), open: true } } });
await copyFile(new URL('scripts/qa-host.cjs', root), new URL('main.js', harness));
await json(new URL('manifest.json', harness), { id: 'todotimer-qa', name: 'TodoTimer QA harness', version: '0.0.0', minAppVersion: '1.12.7', description: 'Disposable host integration tests.', author: 'TodoTimer', isDesktopOnly: true });
await writeFile(new URL('手动验收.md', vault), '# TodoTimer 手动验收\n\n- [ ] 旧任务，不补创建时间\n  - 等待：旧记录，不补时间\n\n- [ ] 相同任务\n- [ ] 相同任务\n\n');
console.log(`QA vault: ${fileURLToPath(vault)}\nIsolated profile: ${fileURLToPath(profile)}`);
