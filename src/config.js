import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.cc-fallback');
export const CONFIG_PATH = process.env.CC_FALLBACK_CONFIG || join(CONFIG_DIR, 'config.json');
export const LOG_PATH = join(CONFIG_DIR, 'proxy.log');

// Order = priority. Providers without a usable key are skipped automatically.
// Free-tier model names and limits change often: check each provider's page.
// Per provider: apiKey may be a list (key pool), models maps Claude tiers (fable/opus/sonnet/haiku)
// to provider models, contextWindow skips the provider for bigger requests, maxConcurrent caps
// parallel requests, extraBody is merged into every request.
export const DEFAULT_CONFIG = {
  port: 3456,
  host: '127.0.0.1',
  cooldownMinutes: 30,
  announceSwitch: true,
  // Targets ("provider" or "provider,model") preferred for a kind of request once Claude is
  // unavailable. "background" (haiku-tier requests) is the exception: its targets are tried
  // before Claude, to save Claude quota. Empty = normal order.
  routes: {
    background: [],
    think: [],
    image: ['gemini', 'openrouter,google/gemma-4-31b-it:free'],
    longContext: ['gemini', 'nvidia'],
    longContextThreshold: 100000,
  },
  providers: [
    { name: 'claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    {
      name: 'gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'env:GEMINI_API_KEY', model: 'gemini-2.5-flash', smallModel: 'gemini-2.5-flash-lite', maxTokens: 32000, contextWindow: 1000000,
    },
    {
      // Free GLM models allow one request at a time: extra parallel requests go to the next provider.
      name: 'zai', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4',
      apiKey: 'env:ZAI_API_KEY', model: 'glm-4.7-flash', maxTokens: 32000, contextWindow: 200000, maxConcurrent: 1, cooldownMinutes: 1,
    },
    {
      name: 'nvidia', type: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'env:NVIDIA_API_KEY', model: 'nvidia/nemotron-3-ultra-550b-a55b', smallModel: 'openai/gpt-oss-20b', maxTokens: 16000, contextWindow: 1000000, cooldownMinutes: 2,
    },
    {
      name: 'cerebras', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: 'env:CEREBRAS_API_KEY', model: 'gpt-oss-120b', maxTokens: 16000, contextWindow: 65000,
    },
    {
      name: 'mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'env:MISTRAL_API_KEY', model: 'mistral-medium-latest', smallModel: 'mistral-small-latest', maxTokens: 16000, contextWindow: 128000,
    },
    {
      name: 'groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'env:GROQ_API_KEY', model: 'openai/gpt-oss-120b', smallModel: 'openai/gpt-oss-20b', maxTokens: 8192, contextWindow: 131000,
    },
    {
      name: 'openrouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'env:OPENROUTER_API_KEY', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', maxTokens: 16000, contextWindow: 1000000,
    },
    {
      name: 'cloudflare', type: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{env:CLOUDFLARE_ACCOUNT_ID}/ai/v1',
      apiKey: 'env:CLOUDFLARE_API_TOKEN', model: '@cf/openai/gpt-oss-120b', maxTokens: 8192, contextWindow: 128000,
    },
    // No key needed: free shared pools, slower and may log prompts.
    { name: 'kilo', type: 'openai', keyless: true, baseUrl: 'https://api.kilo.ai/api/gateway', model: 'kilo-auto/free', maxTokens: 16000, contextWindow: 256000, cooldownMinutes: 5 },
    { name: 'llm7', type: 'openai', keyless: true, baseUrl: 'https://api.llm7.io/v1', apiKey: 'env:LLM7_API_KEY', model: 'DeepSeek-V4-Flash-0731', maxTokens: 8192, contextWindow: 400000, maxConcurrent: 1, cooldownMinutes: 2 },
    { name: 'ollama', type: 'openai', local: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'auto', maxTokens: 8192 },
    { name: 'lmstudio', type: 'openai', local: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'auto', maxTokens: 8192 },
    { name: 'llamacpp', type: 'openai', local: true, baseUrl: 'http://127.0.0.1:8080/v1', model: 'auto', maxTokens: 8192 },
  ],
};

/** Resolves "env:NAME" to the environment value; returns '' if unset. */
export function resolveKey(value) {
  if (!value) return '';
  if (typeof value === 'string' && value.startsWith('env:')) return process.env[value.slice(4)] || '';
  return value;
}

/** All usable keys of a provider: apiKey may be one value or a list (a key pool). */
export function resolveKeys(p) {
  return [].concat(p.apiKey || []).map(resolveKey).filter(Boolean);
}

/** Claude tier of a requested model name: fable, opus, sonnet or haiku ('' if unknown). */
export const tierOf = (model) => (/fable|opus|sonnet|haiku/i.exec(model || '')?.[0] || '').toLowerCase();

/** Fills "{env:NAME}" placeholders in a provider's baseUrl (e.g. an account id); '' if one is unset. */
export function resolveUrl(p) {
  let missing = false;
  const url = p.baseUrl.replace(/\{env:(\w+)\}/g, (_, name) => process.env[name] || ((missing = true), ''));
  return missing ? '' : url.replace(/\/$/, '');
}

/** A provider is usable if it needs no key (claude passthrough, local, keyless) or a key resolves. */
export function isConfigured(p) {
  if (p.enabled === false) return false;
  if (!resolveUrl(p)) return false;
  if (p.type === 'anthropic' && !p.apiKey) return true;
  if (p.local || p.keyless) return true;
  return resolveKeys(p).length > 0;
}

export function loadConfig() {
  let user = {};
  if (existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
      throw new Error(`Cannot parse ${CONFIG_PATH}: ${e.message}`);
    }
  }
  return {
    ...DEFAULT_CONFIG, ...user,
    routes: { ...DEFAULT_CONFIG.routes, ...user.routes },
    providers: user.providers || DEFAULT_CONFIG.providers,
  };
}

export function writeDefaultConfig() {
  if (existsSync(CONFIG_PATH)) return false;
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  return true;
}
