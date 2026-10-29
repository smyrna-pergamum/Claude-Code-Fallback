# cc-fallback

Claude kullanım limitiniz dolduğunda **Claude Code** ile çalışmaya devam edin.

`cc-fallback`, küçük bir yerel proxy (bağımlılık yok, Node 18+) ve bir Claude Code eklentisidir. Claude Code proxy ile konuşur; proxy istekleri normal şekilde Claude'a gönderir. Claude limit hatası verdiğinde listenizdeki bir sonraki sağlayıcıya otomatik geçer: ücretsiz bulut API'leri (Gemini, Cerebras, Mistral, OpenRouter, Groq) ya da kendi bilgisayarınızda çalışan açık kaynak modeller (Ollama, LM Studio). Limit sıfırlanınca kendiliğinden Claude'a döner.

[English README](README.md)

## Özellikler

- 429/529, "usage limit" ve kota hatalarında **otomatik geçiş**; bekleme süresi `retry-after` ve Claude'un sıfırlanma zamanına göre ayarlanır.
- Bekleme bitince **otomatik olarak Claude'a dönüş**.
- Anthropic Messages API ile OpenAI uyumlu API'ler arasında **tam çeviri**: streaming, araç çağrıları (Read, Edit, Bash…), görseller, sistem promptu.
- **Donanım taraması** (`cc-fallback scan`): RAM, GPU/VRAM, Apple Silicon tespit eder; sığan açık kaynak modeli önerir, çalışan yerel sunucuları ve kurulu modelleri listeler.
- **Kurulu modelleri kullanır**: `model: "auto"`, Ollama veya LM Studio'daki en uygun araç destekli modeli seçer.
- Geçişleri sohbette **duyurur** (`⚡ cc-fallback: gemini / gemini-2.5-flash`).
- **Claude Code eklentisi**: `/fallback-status`, `/fallback-use`, `/fallback-reset`, `/fallback-scan`.
- Claude oturum anahtarınız yalnızca Anthropic'e iletilir, başka sağlayıcıya asla gönderilmez.

## Kurulum

```bash
npm install -g github:smyrna-pergamum/cc-fallback
```

Claude Code içinde eklenti (isteğe bağlı, slash komutları için):

```
/plugin marketplace add smyrna-pergamum/cc-fallback
/plugin install cc-fallback@cc-fallback
```

## Kullanım

```bash
cc-fallback scan     # bu bilgisayar ne çalıştırabilir? hangi anahtarlar eksik?
cc-fallback run      # proxy'yi başlatır ve Claude Code'u onun üzerinden açar
```

`run` sonrasındaki argümanlar `claude`'a gider (ör. `cc-fallback run --continue`). Diğer komutlar: `start`, `status`, `use <sağlayıcı|auto>`, `reset`, `init`, `env`.

## Ücretsiz API anahtarları

İstediklerinizi ortam değişkeni olarak tanımlayın; anahtarı olmayan sağlayıcılar atlanır.

| Sağlayıcı | Değişken | Varsayılan model |
|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | gemini-2.5-flash |
| Cerebras | `CEREBRAS_API_KEY` | gpt-oss-120b |
| Mistral | `MISTRAL_API_KEY` | devstral-medium-latest |
| OpenRouter | `OPENROUTER_API_KEY` | qwen/qwen3-coder:free |
| Groq | `GROQ_API_KEY` | openai/gpt-oss-120b |

Windows (PowerShell, kalıcı):

```powershell
setx GEMINI_API_KEY "anahtariniz"
```

Ücretsiz katmanlar, model adları ve limitler sık değişir. Claude Code her istekte ~20k token gönderir; dakikalık token limiti düşük sağlayıcılar isteği reddedebilir, bu durumda bir sonrakine geçilir.

## Yerel modeller

```bash
ollama pull qwen3-coder:30b
```

Claude Code geniş bağlam ister: Ollama'yı `OLLAMA_CONTEXT_LENGTH=32768` (veya fazlası) ile başlatın. LM Studio'da modeli en az 32k bağlamla yükleyip 1234 portunda sunucuyu açın. Yalnızca CPU olan makinelerde küçük modeller çalışır ama yavaştır; ücretsiz bulut API'leri daha iyi seçenektir. Yerel modeller uzun görevlerde Claude'dan belirgin şekilde zayıftır; limit sıfırlanana kadar basit işleri sürdürmek için uygundur.

## Ayarlar

`cc-fallback init` → `~/.cc-fallback/config.json`. Sağlayıcı sırası = geçiş sırası. Alanların açıklaması [README.md](README.md#configuration) içinde.

## Gizlilik

Yedek bir sağlayıcı cevap verdiğinde konuşmanız (Claude Code'un okuduğu kodlar dahil) o sağlayıcıya, onun koşullarıyla gönderilir. Önemliyse yerel model kullanın.

## Lisans

MIT
