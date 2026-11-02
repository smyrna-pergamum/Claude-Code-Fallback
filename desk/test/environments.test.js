import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// environments.js reads CC_DESK_ENVIRONMENTS when it is first imported.
const file = join(mkdtempSync(join(tmpdir(), 'ccd-env-')), 'environments.json');
process.env.CC_DESK_ENVIRONMENTS = file;
const { saveEnvironments, environmentsForUi, environmentVars } = await import('../src/environments.js');

test('secrets are masked for the UI and kept when sent back unchanged', async () => {
  await saveEnvironments([{ name: 'Work', vars: [{ name: 'API_KEY', value: 'sk-secret-123456' }, { name: 'MODE', value: 'dev' }] }]);
  const ui = await environmentsForUi();
  assert.equal(ui[0].id, 'local');
  const work = ui.find((e) => e.name === 'Work');
  assert.deepEqual(work.vars, [{ name: 'API_KEY', value: '••••3456', secret: true }, { name: 'MODE', value: 'dev' }]);
  assert.doesNotMatch(JSON.stringify(ui), /sk-secret/);

  const changed = await saveEnvironments([{ id: work.id, name: 'Work', vars: [{ name: 'API_KEY', keep: true }, { name: 'MODE', value: 'dev' }] }]);
  assert.deepEqual(changed, [], 'nothing changed');
  assert.equal((await environmentVars(work.id)).API_KEY, 'sk-secret-123456');
  assert.match(readFileSync(file, 'utf8'), /sk-secret-123456/);
});

test('invalid names are rejected and Local cannot be replaced', async () => {
  await assert.rejects(saveEnvironments([{ name: 'X', vars: [{ name: '1BAD', value: 'v' }] }]), /not a valid variable name/);
  await assert.rejects(saveEnvironments([{ name: 'local', vars: [] }]), /already an environment/);
});
