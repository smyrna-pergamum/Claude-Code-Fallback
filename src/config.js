import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.cc-fallback');
export const CONFIG_PATH = process.env.CC_FALLBACK_CONFIG || join(CONFIG_DIR, 'config.json');
export const LOG_PATH = join(CONFIG_DIR, 'proxy.log');

// Order = priority. Providers without a usable key are skipped automatically.
// Free-tier model names and limits change often: check each provider's page.
export const DEFAULT_CONFIG = {
  port: 3456,
  host: '127.0.0.1',
  cooldownMinutes: 30,
  announceSwitch: true,
  providers: [
    { name: 'claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    {
      name: 'gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'env:GEMINI_API_KEY', model: 'gemini-2.5-flash', smallModel: 'gemini-2.5-flash-lite', maxTokens: 32000,
    },
    {
      name: 'cerebras', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1',
      apiKey: 'env:CEREBRAS_API_KEY', model: 'gpt-oss-120b', maxTokens: 16000,
    },
    {
      name: 'mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'env:MISTRAL_API_KEY', model: 'devstral-medium-latest', smallModel: 'mistral-small-latest', maxTokens: 16000,
    },
    {
      name: 'openrouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'env:OPENROUTER_API_KEY', model: 'qwen/qwen3-coder:free', maxTokens: 16000,
    },
    {
      name: 'groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'env:GROQ_API_KEY', model: 'openai/gpt-oss-120b', smallModel: 'llama-3.1-8b-instant', maxTokens: 8192,
    },
    { name: 'ollama', type: 'openai', local: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'auto', maxTokens: 8192 },
    { name: 'lmstudio', type: 'openai', local: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'auto', maxTokens: 8192 },
  ],
};

/** Resolves "env:NAME" to the environment value; returns '' if unset. */
export function resolveKey(value) {
  if (!value) return '';
  if (typeof value === 'string' && value.startsWith('env:')) return process.env[value.slice(4)] || '';
  return value;
}

/** A provider is usable if it needs no key (claude passthrough, local) or its key resolves. */
export function isConfigured(p) {
  if (p.enabled === false) return false;
  if (p.type === 'anthropic' && !p.apiKey) return true;
  if (p.local) return true;
  return !!resolveKey(p.apiKey);
}

export function loadConfig() {
  let user = {};
  if (existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
      throw new Error(`Cannot parse ${CONFIG_PATH}: ${e.message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...user, providers: user.providers || DEFAULT_CONFIG.providers };
}

export function writeDefaultConfig() {
  if (existsSync(CONFIG_PATH)) return false;
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  return true;
}
