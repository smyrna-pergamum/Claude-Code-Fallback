# CC Desk

The desktop app of [cc-fallback](../README.md), for **Claude Code**. It sends every request through the cc-fallback proxy: your Claude subscription is used first, and when its limit is reached free models (Gemini, Kilo, LLM7, NVIDIA, your own APIs, local models…) take over automatically.

The Claude desktop app gives its sessions its own API address, so it can't use cc-fallback. CC Desk runs the real Claude Code (via the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)) and points it at the proxy.

[Türkçe](#türkçe)

## Features

- Claude Code look, light and dark: chat bubbles, streaming answers, compact tool rows (Bash, Read, Edit, …) that open to show input and output
- Approval cards (Allow once / Always allow / Deny) and permission modes (ask before edits, auto-accept edits, plan, auto, bypass)
- Sessions per folder, **including those from the Claude desktop app and the terminal**: open any of them and continue
- Model picker: Claude models, or a free provider's model directly (`provider,model`)
- Status bar: which provider answered, Claude's limit countdown, force a provider, retry Claude now; starts the proxy if it isn't running
- **Models & API keys** (bottom left):
  - add keys to the built-in providers (Gemini, Z AI, NVIDIA, …)
  - add any API: OpenAI-compatible, Anthropic-compatible, or a template (OpenAI, DeepSeek, Together)
  - add local AI: Ollama, LM Studio, llama.cpp, or any local URL
  - **Test & list models** checks the address and key and fills the model list
  - reorder providers and switch them on and off; **Save** writes `~/.cc-fallback/config.json` and the proxy reloads it at once
- Local only: the server listens on 127.0.0.1 with a per-launch token

## Install

Needs Node 18+ and a logged-in Claude Code (`claude` → log in once). The proxy is the parent folder of this one; the app starts it when needed.

From the repository root:

```bash
npm run desk
```

Or from this folder:

```bash
npm install
npm start
```

Shortcuts on the Desktop and in the Start menu (Windows):

```bash
cscript scripts\create-shortcut.vbs
```

Browser mode (no Electron): `npm run web` prints a local URL.

## Notes

- Keys saved in **Models & API keys** are stored as plain text in `~/.cc-fallback/config.json` on this computer. Providers that use `env:VAR_NAME` keep reading the environment variable.
- Saving writes the whole provider list to that file; from then on it replaces cc-fallback's built-in list.
- For personal use with your own Claude login. Distributing an app that signs other people in with their Claude subscription may conflict with Anthropic's terms.
- Not a replacement for the official app: no diff viewer, browser pane, parallel sessions or plugins UI.

## Türkçe

CC Desk, cc-fallback'in Claude Code için masaüstü uygulaması. Tüm istekleri cc-fallback üzerinden gönderir: önce Claude aboneliğin kullanılır, limit dolunca ücretsiz modeller otomatik devreye girer. Claude masaüstü uygulaması oturumlarına kendi adresini verdiği için cc-fallback'i kullanamıyor; CC Desk gerçek Claude Code'u çalıştırıp proxy'ye yönlendirir.

- Açık ve koyu temada Claude Code görünümü; onay kartları ve izin modları.
- Eski oturumların (masaüstü uygulaması ve terminal dahil) klasöre göre listelenir; birini açıp devam edebilirsin.
- Model seçici (Claude ya da doğrudan ücretsiz model) ve cc-fallback durum çubuğu.
- **Models & API keys** (sol altta): hazır sağlayıcılara anahtar ekle, kendi API'ni ekle (OpenAI veya Anthropic uyumlu), yerel yapay zekâ ekle (Ollama, LM Studio, llama.cpp ya da herhangi bir yerel adres), bağlantıyı test et, sırala ve aç/kapat. Kaydedince proxy hemen yeniden yükler. Anahtarlar bu bilgisayarda `~/.cc-fallback/config.json` içinde düz metin olarak saklanır.
- Kurulum: repo kökünde `npm run desk`. Masaüstü kısayolu için bu klasörde: `cscript scripts\create-shortcut.vbs`.
