import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const files = {};
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  files[`todotimer/${file}`] = new Uint8Array(await readFile(new URL(`../${file}`, import.meta.url)));
}
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const output = new URL(`../dist/todotimer-${manifest.version}.zip`, import.meta.url);
await writeFile(output, zipSync(files, { level: 9 }));
console.log(`Packaged ${output.pathname}`);
