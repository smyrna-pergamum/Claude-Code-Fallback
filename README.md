# Cluade Code - Fallback

Keep **Claude Code** working when your Claude usage limit is reached.

cc-fallback has two parts:

- **The proxy** (zero dependencies, Node 18+): Claude Code talks to it; it sends each request to Claude as usual, and when Claude answers with a limit error it switches to the next provider in your list: free cloud APIs (Gemini, Z AI, NVIDIA, Cerebras, Mistral, Groq, OpenRouter, Cloudflare, plus keyless Kilo and LLM7), any API you add, or open-source models on your own computer (Ollama, LM Studio, llama.cpp). When the limit resets, it goes back to Claude by itself. It comes with a Claude Code plugin for status and control.
- **CC Desk** ([`desk/`](desk/)): a desktop app for Claude Code that always runs through the proxy, with a screen to add API keys, your own APIs and local AI.

[Türkçe README](README.tr.md)

```
Claude Code (terminal) ─┐
CC Desk (desktop app) ──┴─► cc-fallback (127.0.0.1:3456) ──► Claude (your login)
                                          │  429 / limit reached
                                          ├──► Gemini / GLM / NVIDIA / Groq / OpenRouter / your APIs … / Kilo
                                          └──► Ollama / LM Studio / llama.cpp  (local, no limits)
```

> **The Claude desktop app can't use cc-fallback.** It gives its sessions its own API address, which overrides `ANTHROPIC_BASE_URL`. Use Claude Code in a terminal, or CC Desk.

## Features

- **Automatic fallback** on HTTP 429/529, "usage limit" and quota errors, with a cooldown that honors `retry-after` and the Claude reset time; **automatic return to Claude** when it ends.
- **Full translation** between the Anthropic Messages API and OpenAI-compatible APIs: streaming, tool calls (Read, Edit, Bash…), images, system prompts.
- **Smart routing**: preferred providers for images, long context, thinking and background requests; key pools; per-tier models; concurrency caps; `/model provider,model` to pick a model yourself.
- **Works out of the box**: Kilo and LLM7 need no key, so there is a fallback before you set anything up.
- **Hardware scan** (`cc-fallback scan`): recommends an open-source local model that fits your RAM/GPU and shows which local runtimes and models you have; `model: "auto"` picks the best installed one.
- **Announces switches** in the chat (`⚡ cc-fallback: gemini / gemini-2.5-flash`).
- **Claude Code plugin**: `/fallback-status`, `/fallback-use`, `/fallback-reset`, `/fallback-scan`.
- **CC Desk desktop app**: Claude Code look, approvals, your old sessions (desktop app and terminal ones too), model picker, live status, and a **Models & API keys** screen.
- Your Claude login token is only ever forwarded to Anthropic, never to other providers.

## Requirements

- Node 18+
- Claude Code CLI, logged in once:

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude
```

Log in in the browser, then type `/exit`. (npm 11+ may block the package's install script: add `--allow-scripts=@anthropic-ai/claude-code` to the install command.)

## Install

```bash
npm install -g github:smyrna-pergamum/Claude-Code-Fallback
```

This installs the proxy and the `cc-fallback` command (not the desktop app, so no Electron download). Optionally add the plugin inside Claude Code:

```
/plugin marketplace add smyrna-pergamum/Claude-Code-Fallback
/plugin install cc-fallback@cc-fallback
```

For the desktop app, clone the repository and see [Desktop app](#desktop-app-cc-desk).

## Use

```bash
cc-fallback scan     # what can this computer run? which keys are missing?
cc-fallback run      # starts the proxy and launches Claude Code through it
```

Arguments after `run` go to `claude`: `cc-fallback run --continue` continues your last session, `cc-fallback run --resume` lets you pick an older one of the current folder.

| Command | What it does |
|---|---|
| `start` | run the proxy only (foreground) |
| `status` | providers, cooldowns, ok/failed counts |
| `use <provider \| provider,model \| auto>` | force a provider or model, or go back to automatic |
| `reset` | clear all cooldowns (retry Claude now) |
| `reload` | re-read the config file without restarting |
| `init` | write a config file you can edit |
| `env` | how to point Claude Code at the proxy yourself |

To run the proxy separately:

```bash
cc-fallback start
```

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

> Only set `ANTHROPIC_BASE_URL` permanently (e.g. in `~/.claude/settings.json` → `env`) if the proxy always runs; otherwise Claude Code cannot connect.

### Windows notes

- PowerShell's default policy blocks npm's `.ps1` launchers. Type `cc-fallback.cmd` and `claude.cmd`, or allow local scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- Environment variables set with `setx` reach only new terminals and a restarted proxy.
- Start the proxy hidden at login: save this as `cc-fallback.vbs` in the Startup folder (`Win+R` → `shell:startup`); it restarts the proxy if it stops.

```vb
Set sh = CreateObject("WScript.Shell")
Do
  sh.Run "cmd /c cc-fallback.cmd start", 0, True
  WScript.Sleep 10000
Loop
```

## Free API keys

Add keys in CC Desk (**Models & API keys**) or as environment variables; providers without a key are skipped.

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

Kilo and LLM7 are shared free pools: slower, rate-limited (LLM7 has a daily quota), and they may log prompts. Provider list based on [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis).

Free tiers, model names and limits change often. Claude Code sends ~20k tokens per request, so providers with small per-minute token limits may reject requests; cc-fallback then moves on to the next one. Check each provider's current terms.

## Local models

```bash
ollama pull qwen3-coder:30b      # or what `cc-fallback scan` recommends
```

Built in: Ollama (port 11434), LM Studio (1234) and llama.cpp server (8080), each with `model: "auto"`. Any other local OpenAI-compatible server can be added in CC Desk (**Add local AI**) or in the config file.

Claude Code needs a large context window: start Ollama with `OLLAMA_CONTEXT_LENGTH=32768` (or more); in LM Studio load the model with at least 32k context and start the server.

| Memory for the model | Suggestion |
|---|---|
| 24 GB+ VRAM / 32 GB+ Mac | `qwen3-coder:30b`, `devstral:24b`, `gpt-oss:20b` |
| 12–16 GB | `qwen3:14b`, `qwen2.5-coder:14b` |
| 8 GB | `qwen3:8b`, `qwen2.5-coder:7b` |
| CPU only | small models work but are slow; prefer free cloud APIs |

Local open-source models are much weaker than Claude at long agentic tasks. They are good for keeping simple work going until your limit resets.

## Desktop app (CC Desk)

[`desk/`](desk/) runs the real Claude Code (through the Claude Agent SDK) and always points it at the proxy, which it starts if needed.

- Claude Code look in light and dark: chat bubbles, compact tool rows with their output, approval cards (Allow once / Always allow / Deny), permission modes
- Your sessions per folder, including those started in the Claude desktop app or a terminal: open one and continue
- Model picker: Claude models, or any free provider's model directly
- Status bar: which provider answered, Claude's limit countdown, force a provider, retry Claude now
- **Models & API keys**: add keys to the built-in providers, add any OpenAI- or Anthropic-compatible API, add local AI (Ollama, LM Studio, llama.cpp or any local URL), test the connection and list models, reorder and switch providers on and off; changes apply without restarting

From the repository root:

```bash
npm run desk
```

Windows shortcuts on the Desktop and in the Start menu (after the first `npm run desk`):

```bash
cscript desk\scripts\create-shortcut.vbs
```

More in [desk/README.md](desk/README.md).

## Configuration

`cc-fallback init` writes `~/.cc-fallback/config.json` (CC Desk writes the same file). Provider order is the fallback order. After editing it by hand, run `cc-fallback reload`.

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

Once the file lists `providers`, it replaces the built-in list: providers added in later versions won't appear until you add them.

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
- In CC Desk: the model picker under the message box.
- From a terminal: `cc-fallback use nvidia,openai/gpt-oss-20b` (or `auto`).

Every response carries an `x-cc-fallback-provider` header.

### Control endpoints

For scripts and apps, on the proxy's address: `GET /_fallback/status`, and `POST /_fallback/use` (`{"provider": "…"}`), `/_fallback/reset`, `/_fallback/reload`.

## Privacy

- When a fallback provider answers, your conversation (including code Claude Code read) is sent to that provider under its terms. Use local models if that matters.
- `cc-fallback run` and CC Desk set `CLAUDE_CODE_ATTRIBUTION_HEADER=0`, and the proxy strips Claude Code's billing line, so they aren't sent to other providers.
- Keys you save in CC Desk are stored as plain text in `~/.cc-fallback/config.json` on your computer. Use `env:VAR_NAME` instead if you prefer environment variables.
- The proxy and CC Desk listen on 127.0.0.1 only; CC Desk also requires a per-launch token.

## Limitations

- The Claude desktop app doesn't go through the proxy (see above).
- Claude-only features (extended thinking, web search tool, prompt caching) are unavailable while a fallback model answers.
- If a stream fails half-way, that response cannot be retried on another provider; send your message again.
- `/v1/messages/count_tokens` is estimated while Claude is paused.
- CC Desk is for personal use with your own Claude login; it has no diff viewer, browser pane or parallel sessions.

## Project layout

| Path | Contents |
|---|---|
| `bin/`, `src/` | the proxy and the `cc-fallback` command |
| `commands/`, `.claude-plugin/` | the Claude Code plugin |
| `desk/` | CC Desk, the desktop app (its own `package.json`) |
| `test/` | proxy tests |

## Development

```bash
npm test
```

```bash
npm --prefix desk test
```

## License

MIT
