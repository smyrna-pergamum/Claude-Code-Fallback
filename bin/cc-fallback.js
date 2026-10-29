#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig, writeDefaultConfig, isConfigured, CONFIG_PATH, LOG_PATH } from '../src/config.js';
import { createProxy } from '../src/server.js';
import { detectHardware, recommend, pickInstalled } from '../src/hardware.js';

const HELP = `cc-fallback - keep Claude Code working when your Claude limit is reached

Usage:
  cc-fallback run [claude args...]   start the proxy and launch Claude Code through it
  cc-fallback start                  run the proxy in the foreground
  cc-fallback scan                   check hardware, local models, API keys; recommend a model
  cc-fallback status                 show providers and cooldowns of the running proxy
  cc-fallback use <provider|auto>    force a provider (e.g. ollama) or return to automatic
  cc-fallback reset                  clear all cooldowns (retry Claude now)
  cc-fallback init                   write a config file you can edit
  cc-fallback env                    print how to point Claude Code at the proxy manually

Config: ${CONFIG_PATH}
Log:    ${LOG_PATH}`;

const config = loadConfig();
const base = `http://${config.host}:${config.port}`;
const [cmd = 'help', ...args] = process.argv.slice(2);

async function admin(path, body) {
  try {
    const res = await fetch(base + path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
    return await res.json();
  } catch {
    console.error(`Proxy is not running on ${base}. Start it with: cc-fallback run   (or: cc-fallback start)`);
    process.exit(1);
  }
}

function printStatus(s) {
  console.log(`Mode: ${s.forced ? `forced -> ${s.forced}` : 'auto'}   last used: ${s.lastUsed || '-'}   requests: ${s.requests}`);
  for (const p of s.providers) {
    const st = !p.configured ? 'not configured' : p.pausedFor ? `paused ${p.pausedFor} (${p.reason})` : 'ready';
    console.log(`  ${p.name.padEnd(11)} ${p.model.padEnd(28)} ${st}`);
  }
}

async function isRunning() {
  try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

function listen() {
  const { server, log } = createProxy(config, { quiet: cmd === 'run' });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      log(`cc-fallback listening on ${base}`);
      resolve(server);
    });
  });
}

async function localModels(p) {
  try {
    const res = await fetch(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(2000) });
    return ((await res.json()).data || []).map((m) => m.id);
  } catch { return null; }
}

async function scan() {
  const hw = await detectHardware();
  console.log('Hardware');
  console.log(`  CPU: ${hw.cpu} (${hw.cores} threads)   RAM: ${hw.ramGB} GB   OS: ${hw.platform}/${hw.arch}`);
  for (const g of hw.gpus) console.log(`  GPU: ${g.name} (${g.vramGB} GB)`);
  console.log(`  Mode: ${hw.mode.toUpperCase()}   model memory budget: ~${hw.budgetGB} GB\n`);

  const rec = recommend(hw);
  console.log('Recommended local model (Ollama)');
  if (rec.primary) {
    console.log(`  * ${rec.primary.tag}  (~${rec.primary.sizeGB} GB) - ${rec.primary.note}`);
    for (const m of rec.alternatives) console.log(`    ${m.tag}  (~${m.sizeGB} GB) - ${m.note}`);
    console.log(`  Install: ollama pull ${rec.primary.tag}`);
    console.log('  Give it enough context for Claude Code: set OLLAMA_CONTEXT_LENGTH=32768 before starting Ollama.');
  }
  for (const w of rec.warnings) console.log(`  ! ${w}`);

  console.log('\nProviders (in fallback order)');
  for (const p of config.providers) {
    let info;
    if (p.local) {
      const ids = await localModels(p);
      info = ids === null ? 'not running' : ids.length ? `running, will use: ${pickInstalled(ids)} (installed: ${ids.length})` : 'running, no models installed';
    } else if (p.type === 'anthropic' && !p.apiKey) info = 'your Claude Code login (pass-through)';
    else info = isConfigured(p) ? `key found, model ${p.model}` : `no key: set ${String(p.apiKey).replace('env:', '')}`;
    console.log(`  ${p.name.padEnd(11)} ${info}`);
  }
  console.log(`\nEdit order/models in ${CONFIG_PATH} (create it with: cc-fallback init)`);
}

switch (cmd) {
  case 'start':
    await listen();
    break;
  case 'run': {
    if (!(await isRunning())) await listen();
    const env = { ...process.env, ANTHROPIC_BASE_URL: base };
    // Don't leak the Anthropic attribution block into prompts sent to other providers.
    env.CLAUDE_CODE_ATTRIBUTION_HEADER ??= '0';
    const child = spawn('claude', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
    child.on('error', (e) => { console.error(`Could not start claude: ${e.message}`); process.exit(1); });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'scan':
    await scan();
    break;
  case 'status':
    printStatus(await admin('/_fallback/status'));
    break;
  case 'use':
    if (!args[0]) { console.error('Usage: cc-fallback use <provider|auto>'); process.exit(1); }
    printStatus(await admin('/_fallback/use', { provider: args[0] }));
    break;
  case 'reset':
    printStatus(await admin('/_fallback/reset', {}));
    break;
  case 'init':
    console.log(writeDefaultConfig() ? `Created ${CONFIG_PATH}` : `Already exists: ${CONFIG_PATH}`);
    break;
  case 'env':
    console.log(`PowerShell:  $env:ANTHROPIC_BASE_URL = "${base}"`);
    console.log(`bash/zsh:    export ANTHROPIC_BASE_URL=${base}`);
    console.log('The proxy must be running (cc-fallback start) or Claude Code cannot connect.');
    break;
  default:
    console.log(HELP);
}
