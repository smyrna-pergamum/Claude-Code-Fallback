# CC Desk

The desktop app of [cc-fallback](../README.md), for **Claude Code**. It sends every request through the cc-fallback proxy: your Claude subscription is used first, and when its limit is reached free models (Gemini, Kilo, LLM7, NVIDIA, local models…) take over automatically.

The Claude desktop app sets its own API address for its sessions, so it can't use cc-fallback. CC Desk runs the real Claude Code (via the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)) and points it at the proxy.

[Türkçe](#türkçe)

## Features

- Chat with streaming answers, tool cards (Bash, Read, Edit, …) with their results
- Approval cards for actions (Allow / Always allow / Deny) and permission modes (ask, auto-accept edits, plan, auto, bypass)
- Sessions per folder, **including those from the Claude desktop app and the terminal**: open any of them and continue
- Model picker: Claude models, or a free model directly (`provider,model` from cc-fallback)
- cc-fallback status bar: which provider answered, Claude's limit countdown, force a provider, retry Claude now; starts the proxy if it isn't running
- Local only: the server listens on 127.0.0.1 with a per-launch token

## Install

Needs Node 18+ and a logged-in Claude Code (`claude` → log in once). The proxy is the parent folder of this one; the app starts it when needed. From the repository root:

```bash
cd desk
```

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

- For personal use with your own Claude login. Distributing an app that signs other people in with their Claude subscription may conflict with Anthropic's terms.
- Not a replacement for the official app: no diff viewer, browser pane, parallel sessions or plugins UI.

## Türkçe

CC Desk, Claude Code için küçük bir masaüstü uygulaması. Tüm istekleri cc-fallback üzerinden gönderir: önce Claude aboneliğin kullanılır, limit dolunca ücretsiz modeller otomatik devreye girer. Claude masaüstü uygulaması oturumlarına kendi adresini verdiği için cc-fallback'i kullanamıyor; CC Desk gerçek Claude Code'u çalıştırıp proxy'ye yönlendirir.

- Eski oturumların (masaüstü uygulaması ve terminal dahil) klasöre göre listelenir; birini açıp devam edebilirsin.
- İşlem onayları, izin modları, model seçici (Claude veya doğrudan ücretsiz model) ve cc-fallback durum çubuğu var.
- Kurulum: `npm install`, sonra `npm start`. Masaüstü kısayolu için: `cscript scripts\create-shortcut.vbs`.
