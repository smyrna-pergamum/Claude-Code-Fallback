import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// config.js reads CC_FALLBACK_CONFIG when it is first imported, so set it before importing.
const file = join(mkdtempSync(join(tmpdir(), 'ccf-')), 'config.json');
process.env.CC_FALLBACK_CONFIG = file;
const { createProxy } = await import('../src/server.js');

test('reload re-reads the config file and keeps the listening address', async () => {
  const { server } = createProxy({ port: 0, host: '127.0.0.1', providers: [] }, { quiet: true, logPath: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    writeFileSync(file, JSON.stringify({ port: 9999, providers: [{ name: 'only', type: 'openai', keyless: true, baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }] }));
    const st = await fetch(`${base}/_fallback/reload`, { method: 'POST' }).then((r) => r.json());
    assert.deepEqual(st.providers.map((p) => p.name), ['only']);
    writeFileSync(file, '{ broken');
    assert.equal((await fetch(`${base}/_fallback/reload`, { method: 'POST' })).status, 400);
  } finally {
    server.close();
  }
});
