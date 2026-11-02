# cc-fallback

Claude kullanım limitiniz dolduğunda **Claude Code** ile çalışmaya devam edin.

`cc-fallback`, küçük bir yerel proxy (bağımlılık yok, Node 18+) ve bir Claude Code eklentisidir. Claude Code proxy ile konuşur; proxy istekleri normal şekilde Claude'a gönderir. Claude limit hatası verdiğinde listenizdeki bir sonraki sağlayıcıya otomatik geçer: ücretsiz bulut API'leri (Gemini, Z AI, NVIDIA, Cerebras, Mistral, Groq, OpenRouter, Cloudflare ve anahtarsız Kilo, LLM7) ya da kendi bilgisayarınızda çalışan açık kaynak modeller (Ollama, LM Studio). Limit sıfırlanınca kendiliğinden Claude'a döner.

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
npm install -g github:smyrna-pergamum/Claude-Code-Fallback
```

Claude Code içinde eklenti (isteğe bağlı, slash komutları için):

```
/plugin marketplace add smyrna-pergamum/Claude-Code-Fallback
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
| Z AI (GLM) | `ZAI_API_KEY` | glm-4.7-flash |
| NVIDIA NIM | `NVIDIA_API_KEY` | nvidia/nemotron-3-ultra-550b-a55b |
| Cerebras | `CEREBRAS_API_KEY` | gpt-oss-120b |
| Mistral | `MISTRAL_API_KEY` | mistral-medium-latest |
| Groq | `GROQ_API_KEY` | openai/gpt-oss-120b |
| OpenRouter | `OPENROUTER_API_KEY` | nvidia/nemotron-3-ultra-550b-a55b:free |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | @cf/openai/gpt-oss-120b |
| Kilo Code | gerekmez | kilo-auto/free |
| LLM7.io | gerekmez (isteğe bağlı `LLM7_API_KEY`) | DeepSeek-V4-Flash-0731 |

Kilo ve LLM7 anahtarsız çalışır, yani yedek hiç ayar yapmadan devreye girer; ortak ücretsiz havuzlardır, daha yavaştır ve istemleri kaydedebilirler. Liste [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) temel alınarak hazırlandı.

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

`cc-fallback init` ile `~/.cc-fallback/config.json` oluşturulur. Sağlayıcı sırası, yedeğe geçiş sırasıdır. Alanların tam listesi İngilizce README'de.

Yeni özellikler ([claude-code-router](https://github.com/musistudio/claude-code-router) ve [free-claude-code](https://github.com/alishahryar1/free-claude-code) fikirlerinden, sıfırdan yazıldı):

- **Anahtar havuzu:** `"apiKey": ["env:GEMINI_API_KEY", "env:GEMINI_API_KEY_2"]`. Limite takılan anahtar beklemeye alınır, sıradaki kullanılır.
- **Seviyeye göre model:** `"models": { "opus": "…", "sonnet": "…", "haiku": "…" }`.
- **Bağlam sınırı:** `contextWindow`'dan büyük istekler o sağlayıcıyı atlar.
- **Eşzamanlılık:** `maxConcurrent` dolunca paralel istek bir sonraki sağlayıcıya gider (Z AI için 1).
- **Yönlendirme (`routes`):** Claude yine önce denenir; ardından istek türüne göre tercih edilen sağlayıcı gelir. `image` (resim varsa), `longContext` (`longContextThreshold` üstü), `think` (genişletilmiş düşünme). `background` (haiku istekleri) ise **Claude'dan önce** denenir ve Claude kotasını korur; bu istekler arasında güvenlik kontrolleri de olduğu için varsayılan olarak kapalı.
- **Modeli kendin seç:** Claude Code içinde `/model gemini,gemini-2.5-pro`; alt ajan isteminin başına `<CCF-MODEL>sağlayıcı,model</CCF-MODEL>`; terminalden `cc-fallback use nvidia,openai/gpt-oss-20b`.
- `cc-fallback status` sağlayıcı başına başarılı/başarısız sayısını ve bekleyen anahtarları gösterir.

## Gizlilik

Yedek bir sağlayıcı cevap verdiğinde konuşmanız (Claude Code'un okuduğu kodlar dahil) o sağlayıcıya, onun koşullarıyla gönderilir. Önemliyse yerel model kullanın.

## Lisans

MIT
