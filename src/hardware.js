// Hardware detection and open-source local model recommendations.
import os from 'node:os';
import { execFile } from 'node:child_process';

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

async function detectGpus() {
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (nv.trim()) {
    return nv.trim().split('\n').map((l) => {
      const [name, mib] = l.split(',').map((s) => s.trim());
      return { name, vramGB: +(Number(mib) / 1024).toFixed(1), kind: 'nvidia' };
    });
  }
  if (process.platform === 'win32') {
    // Win32_VideoController.AdapterRAM is capped at 4 GB; the registry value is not.
    const ps = "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }";
    const out = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [name, bytes] = l.split('|');
      return { name: name.trim(), vramGB: +((Number(bytes) || 0) / 1024 ** 3).toFixed(1), kind: /nvidia|geforce|rtx/i.test(name) ? 'nvidia' : /radeon|amd/i.test(name) ? 'amd' : 'other' };
    }).filter((g) => g.vramGB > 0);
  }
  if (process.platform === 'linux') {
    const amd = await run('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    const m = amd.match(/(\d{8,})/);
    if (m) return [{ name: 'AMD GPU (ROCm)', vramGB: +(Number(m[1]) / 1024 ** 3).toFixed(1), kind: 'amd' }];
  }
  return [];
}

export async function detectHardware() {
  const ramGB = +(os.totalmem() / 1024 ** 3).toFixed(1);
  const cpu = os.cpus()[0]?.model?.trim() || 'unknown';
  const cores = os.cpus().length;
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const gpus = appleSilicon ? [{ name: 'Apple Silicon (unified memory)', vramGB: ramGB, kind: 'apple' }] : await detectGpus();
  // Integrated GPUs with a small carve-out don't help; treat < 4 GB as CPU-only.
  const best = gpus.filter((g) => g.vramGB >= 4).sort((a, b) => b.vramGB - a.vramGB)[0];
  let mode, budgetGB;
  if (appleSilicon) { mode = 'apple'; budgetGB = ramGB * 0.65; }
  else if (best) { mode = 'gpu'; budgetGB = best.vramGB * 0.9; }
  else { mode = 'cpu'; budgetGB = ramGB * 0.5; }
  return { platform: process.platform, arch: process.arch, cpu, cores, ramGB, gpus, mode, budgetGB: +budgetGB.toFixed(1) };
}

// Ollama tags, approximate Q4 download size (GB). All support tool calling, which Claude Code needs.
// Ordered best-first; `moe` models have few active params and stay usable on CPU with enough RAM.
export const CATALOG = [
  { tag: 'qwen3-coder:30b', sizeGB: 19, moe: true, note: 'agentic coding MoE, best overall for Claude Code' },
  { tag: 'devstral:24b', sizeGB: 14, note: 'Mistral agentic coding model, strong tool use' },
  { tag: 'gpt-oss:20b', sizeGB: 14, moe: true, note: 'OpenAI open-weight MoE, good tool use, fast' },
  { tag: 'qwen3:30b', sizeGB: 19, moe: true, note: 'general MoE, fast for its size' },
  { tag: 'qwen3:14b', sizeGB: 9.3, note: 'solid general + coding' },
  { tag: 'qwen2.5-coder:14b', sizeGB: 9, note: 'coding focused' },
  { tag: 'qwen3:8b', sizeGB: 5.2, note: 'good balance for 8-12 GB' },
  { tag: 'qwen2.5-coder:7b', sizeGB: 4.7, note: 'coding focused, small' },
  { tag: 'qwen3:4b', sizeGB: 2.6, note: 'small; simple edits only' },
  { tag: 'llama3.2:3b', sizeGB: 2, note: 'tiny; last resort' },
];
const BIG = [
  { tag: 'gpt-oss:120b', sizeGB: 65, moe: true, note: 'near frontier open model, needs 80 GB+' },
  { tag: 'qwen3:32b', sizeGB: 20, note: 'dense 32B, strong reasoning' },
];

// Headroom for KV cache: Claude Code's system prompt + tools are ~20k tokens.
const CONTEXT_OVERHEAD_GB = 3;

export function recommend(hw) {
  const fits = (m) => {
    // MoE models run acceptably on CPU when they fit in RAM, even beyond the dense budget.
    const budget = hw.mode === 'cpu' && m.moe ? hw.ramGB * 0.7 : hw.budgetGB;
    return m.sizeGB + CONTEXT_OVERHEAD_GB <= budget;
  };
  const list = [...BIG, ...CATALOG].filter(fits).sort((a, b) => b.sizeGB - a.sizeGB);
  const ranked = [...BIG, ...CATALOG].filter((m) => list.includes(m));
  const warnings = [];
  if (hw.mode === 'cpu') {
    warnings.push('No usable GPU found: local models run on CPU. Expect slow prompt processing'
      + ' (Claude Code sends ~20k tokens of instructions per request). Prefer the free cloud providers; use local as last resort.');
  }
  if (!ranked.length) warnings.push('Not enough memory for a useful local model. Use the free cloud providers.');
  return { primary: ranked[0] || null, alternatives: ranked.slice(1, 4), warnings };
}

/** Pick the best installed model id from a list of local model ids. */
export function pickInstalled(ids) {
  const usable = ids.filter((id) => !/embed|whisper|tts|rerank/i.test(id));
  for (const m of [...BIG, ...CATALOG]) {
    const hit = usable.find((id) => id === m.tag || id.startsWith(m.tag) || id.includes(m.tag.replace(':', '-')));
    if (hit) return hit;
  }
  return usable[0] || null;
}
