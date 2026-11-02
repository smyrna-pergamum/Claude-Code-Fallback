# Cluade Code - Fallback

Keep **Claude Code** working when your Claude usage limit is reached.

`cc-fallback` is a small local proxy (zero dependencies, Node 18+) plus a Claude Code plugin. Claude Code talks to the proxy; the proxy sends each request to Claude as usual, and when Claude answers with a limit error it automatically switches to the next provider in your list: free cloud APIs (Gemini, Z AI, NVIDIA, Cerebras, Mistral, Groq, OpenRouter, Cloudflare, plus keyless Kilo and LLM7) or open-source models running on your own computer (Ollama, LM Studio). When the limit resets, it goes back to Claude by itself.

[Türkçe README](README.tr.md)

```
Claude Code ──► cc-fallback (127.0.0.1:3456) ──► Claude (your login)
                                  │  429 / limit reached
                                  ├──► Gemini / GLM / NVIDIA / Groq / OpenRouter … / Kilo  (free tiers)
                                  └──► Ollama / LM Studio  (local, no limits)
```

## Features

- **Automatic fallback** on HTTP 429/529, "usage limit" and quota errors, with a cooldown that honors `retry-after` and the Claude reset time.
- **Automatic return to Claude** once the cooldown ends.
- **Smart routing**: preferred providers for images, long context, thinking and background requests; key pools; per-tier models; `/model provider,model` to pick a model yourself.
- **Full translation** between the Anthropic Messages API and OpenAI-compatible APIs: streaming, tool calls (Read, Edit, Bash…), images, system prompts.
- **Hardware scan** (`cc-fallback scan`): detects RAM, GPU/VRAM, Apple Silicon and recommends an open-source local model that fits, plus which of your local runtimes are running and which models are installed.
- **Uses the models you already have**: `model: "auto"` picks the best tool-capable model installed in Ollama or LM Studio.
- **Announces switches** inside the chat (`⚡ cc-fallback: gemini / gemini-2.5-flash`) so you always know which model is answering.
- **Claude Code plugin** with `/fallback-status`, `/fallback-use`, `/fallback-reset`, `/fallback-scan`.
- Your Claude login token is only ever forwarded to Anthropic, never to other providers.

## Install

```bash
npm install -g github:smyrna-pergamum/Claude-Code-Fallback
```

Then, inside Claude Code, add the plugin (optional, for the slash commands):

```
/plugin marketplace add smyrna-pergamum/Claude-Code-Fallback
/plugin install cc-fallback@cc-fallback
```

## Use

```bash
cc-fallback scan     # what can this computer run? which keys are missing?
cc-fallback run      # starts the proxy and launches Claude Code through it
```

Arguments after `run` go to `claude` (e.g. `cc-fallback run --continue`).

Other commands: `start` (proxy only), `status`, `use <provider|auto>`, `reset`, `init`, `env`.

To run the proxy separately and point Claude Code at it yourself:

```bash
cc-fallback start
```

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

> Don't set `ANTHROPIC_BASE_URL` permanently unless the proxy always runs, or Claude Code cannot connect.

## Free API keys

Set any you like as environment variables; providers without a key are skipped.

| Provider | Variable | Get a key | Default model |
|---|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | aistudio.google.com/app/apikey | gemini-2.5-flash |
| Z AI (GLM) | `ZAI_API_KEY` | z.ai (api.z.ai) | glm-4.7-flash |
| NVIDIA NIM | `NVIDIA_API_KEY` | build.nvidia.com | nvidia/nemotron-3-ultra-550b-a55b |
| Cerebras | `CEREBRAS_API_KEY` | cloud.cerebras.ai | gpt-oss-120b |
| Mistral | `MISTRAL_API_KEY` | console.mistral.ai/api-keys | mistral-medium-latest |
| Groq | `GROQ_API_KEY` | console.groq.com/keys | openai/gpt-oss-120b |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai/keys | nvidia/nemotron-3-ultra-550b-a55b:free |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com/profile/api-tokens | @cf/openai/gpt-oss-120b |
| Kilo Code | none | – | kilo-auto/free |
| LLM7.io | none (optional `LLM7_API_KEY` from token.llm7.io) | – | DeepSeek-V4-Flash-0731 |

Kilo and LLM7 work without any key, so the fallback works out of the box; they are shared free pools, slower, and may log prompts. Provider list based on [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

Free tiers, model names and limits change often. Claude Code sends ~20k tokens per request, so providers with small per-minute token limits (e.g. some Groq free models) may reject requests; `cc-fallback` then moves on to the next one. Check each provider's current terms.

## Local models

```bash
ollama pull qwen3-coder:30b      # or what `cc-fallback scan` recommends
```

Claude Code needs a large context window. Start Ollama with `OLLAMA_CONTEXT_LENGTH=32768` (or more). In LM Studio, load the model with a context length of at least 32k and start the server on port 1234.

Recommendations by memory (Q4 sizes):

| Memory for the model | Suggestion |
|---|---|
| 24 GB+ VRAM / 32 GB+ Mac | `qwen3-coder:30b`, `devstral:24b`, `gpt-oss:20b` |
| 12–16 GB | `qwen3:14b`, `qwen2.5-coder:14b` |
| 8 GB | `qwen3:8b`, `qwen2.5-coder:7b` |
| CPU only | small models work but are slow; prefer free cloud APIs |

Local open-source models are much weaker than Claude at long agentic tasks. They are good for keeping simple work going until your limit resets.

## Configuration

`cc-fallback init` writes `~/.cc-fallback/config.json`. Provider order is the fallback order.

```json
{
  "port": 3456,
  "cooldownMinutes": 30,
  "announceSwitch": true,
  "providers": [
    { "name": "claude", "type": "anthropic", "baseUrl": "https://api.anthropic.com" },
    { "name": "gemini", "type": "openai", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
      "apiKey": "env:GEMINI_API_KEY", "model": "gemini-2.5-flash", "smallModel": "gemini-2.5-flash-lite", "maxTokens": 32000 },
    { "name": "ollama", "type": "openai", "local": true, "baseUrl": "http://127.0.0.1:11434/v1", "model": "auto" }
  ]
}
```

| Field | Meaning |
|---|---|
| `type` | `anthropic` (pass-through; also works for Anthropic-compatible APIs with `apiKey`) or `openai` (OpenAI-compatible) |
| `apiKey` | `env:VAR_NAME`, the key itself, or a list of them (a key pool: a limited key is paused and the next one is used) |
| `model` / `smallModel` | model for normal requests / for Claude Code's background (haiku) requests; `auto` picks an installed local model |
| `models` | per Claude tier, e.g. `{ "opus": "…", "sonnet": "…", "haiku": "…" }`; wins over `model` / `smallModel` |
| `maxTokens` | cap for output tokens |
| `contextWindow` | skip this provider when a request is bigger (estimated tokens) |
| `maxConcurrent` | max parallel requests; extra ones go to the next provider |
| `cooldownMinutes` | pause after a limit error when the provider sends no `retry-after` |
| `extraBody` | fields merged into every request (e.g. `{ "temperature": 0.6 }`) |
| `reasoningEffort` | sent as `reasoning_effort` when Claude Code asks for extended thinking |
| `local` / `keyless` | no key needed (local runtime / free keyless API) |
| `baseUrl` | may contain `{env:VAR}`, e.g. Cloudflare's account id |
| `strictSchema` | strip JSON-schema keywords strict backends reject (auto for Gemini) |
| `streamUsage` | set `false` if a backend rejects `stream_options` |
| `headers` | extra request headers |
| `enabled` | `false` to disable |

Logs: `~/.cc-fallback/proxy.log`.

### Routing

Ideas borrowed from [claude-code-router](https://github.com/musistudio/claude-code-router) and [free-claude-code](https://github.com/alishahryar1/free-claude-code), written from scratch here.

`routes` lists preferred targets (`"provider"` or `"provider,model"`) per kind of request. Claude is still tried first; the route decides which free provider comes next.

```json
"routes": {
  "background": [],
  "think": ["zai"],
  "image": ["gemini", "openrouter,google/gemma-4-31b-it:free"],
  "longContext": ["gemini", "nvidia"],
  "longContextThreshold": 100000
}
```

| Route | Used when |
|---|---|
| `background` | Claude Code's haiku-tier requests (titles, summaries, command checks). **These targets are tried before Claude**, which saves Claude quota. Off by default: some of these requests are safety checks, so pick a capable model. |
| `image` | the latest user turn contains an image |
| `longContext` | the request is bigger than `longContextThreshold` tokens |
| `think` | Claude Code asked for extended thinking |

**Choosing a model yourself**

- In Claude Code: `/model gemini,gemini-2.5-pro` sends every request to that provider and model (Claude is skipped; other free providers remain as backup). `/model` with a Claude model returns to normal.
- For a subagent: put `<CCF-MODEL>provider,model</CCF-MODEL>` at the start of its prompt; the tag is removed before sending.
- From a terminal: `cc-fallback use nvidia,openai/gpt-oss-20b` (or `auto`).

Every response carries an `x-cc-fallback-provider` header; `cc-fallback status` shows per-provider ok/failed counts and paused keys.

## Desktop app (CC Desk)

The Claude desktop app sets its own API address for its sessions, so it never goes through the proxy. [`desk/`](desk/) is a small desktop app that runs the real Claude Code (via the Claude Agent SDK) through cc-fallback: chat with tool cards and approvals, your sessions per folder (desktop and terminal ones too), a model picker, a live cc-fallback status bar, and a **Models & API keys** screen to add keys, any OpenAI- or Anthropic-compatible API, or local AI (Ollama, LM Studio, llama.cpp).

```bash
npm run desk
```

Details: [desk/README.md](desk/README.md).

## Privacy

When a fallback provider answers, your conversation (including code Claude Code read) is sent to that provider under its terms. Use local models if that matters. `cc-fallback run` sets `CLAUDE_CODE_ATTRIBUTION_HEADER=0` so Claude Code's attribution block isn't sent as prompt text to other providers.

## Limitations

- Claude-only features (extended thinking, web search tool, prompt caching) are unavailable while a fallback model answers.
- If a stream fails half-way, that response cannot be retried on another provider; send your message again.
- `/v1/messages/count_tokens` is estimated while Claude is paused.

## Development

```bash
npm test
```

## License

MIT
