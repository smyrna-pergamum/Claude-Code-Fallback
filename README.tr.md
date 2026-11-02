# Claude Code - Fallback

Claude kullanım limitin dolduğunda **Claude Code** ile çalışmaya devam et.

cc-fallback iki parçadan oluşur:

- **Proxy** (bağımlılık yok, Node 18+): Claude Code onunla konuşur. Proxy her isteği normal şekilde Claude'a gönderir; Claude limit hatası verince listendeki bir sonraki sağlayıcıya geçer: ücretsiz bulut API'leri (Gemini, Z AI, NVIDIA, Cerebras, Mistral, Groq, OpenRouter, Cloudflare ve anahtarsız Kilo, LLM7), kendi eklediğin API'ler ya da bilgisayarında çalışan açık kaynak modeller (Ollama, LM Studio, llama.cpp). Limit sıfırlanınca kendiliğinden Claude'a döner. Durum ve kontrol için bir Claude Code eklentisiyle gelir.
- **CC Desk** ([`desk/`](desk/)): Claude Code için her zaman proxy üzerinden çalışan bir masaüstü uygulaması. API anahtarı, kendi API'ni ve yerel yapay zekâ eklemek için bir ekranı var.

[English README](README.md)

```
Claude Code (terminal) ─┐
CC Desk (masaüstü) ─────┴─► cc-fallback (127.0.0.1:3456) ──► Claude (senin girişin)
                                          │  429 / limit doldu
                                          ├──► Gemini / GLM / NVIDIA / Groq / OpenRouter / senin API'lerin … / Kilo
                                          └──► Ollama / LM Studio / llama.cpp  (yerel, limitsiz)
```

> **Claude masaüstü uygulaması cc-fallback'i kullanamaz.** Oturumlarına kendi API adresini verir ve bu, `ANTHROPIC_BASE_URL` ayarını geçersiz kılar. Terminalde Claude Code'u ya da CC Desk'i kullan.

## Özellikler

- 429/529, "usage limit" ve kota hatalarında **otomatik geçiş**; bekleme süresi `retry-after` ve Claude'un sıfırlanma zamanına göre ayarlanır, bitince **otomatik olarak Claude'a dönülür**.
- Anthropic Messages API ile OpenAI uyumlu API'ler arasında **tam çeviri**: streaming, araç çağrıları (Read, Edit, Bash…), görseller, sistem istemi.
- **Akıllı yönlendirme**: resim, uzun bağlam, düşünme ve arka plan istekleri için tercih edilen sağlayıcılar; anahtar havuzu; seviyeye göre model; eşzamanlılık sınırı; modeli kendin seçmek için `/model sağlayıcı,model`.
- **Hemen çalışır**: Kilo ve LLM7 anahtar istemez, yani hiçbir şey ayarlamadan bir yedek vardır.
- **Donanım taraması** (`cc-fallback scan`): RAM/GPU'na sığan açık kaynak modeli önerir, kurulu yerel sunucuları ve modelleri gösterir; `model: "auto"` kurulu en uygun modeli seçer.
- Geçişleri sohbette **duyurur** (`⚡ cc-fallback: gemini / gemini-2.5-flash`).
- **Claude Code eklentisi**: `/fallback-status`, `/fallback-use`, `/fallback-reset`, `/fallback-scan`.
- **CC Desk masaüstü uygulaması**: Claude Code görünümü, onaylar, eski oturumların (masaüstü uygulaması ve terminal dahil), model seçici, canlı durum ve **Models & API keys** ekranı.
- Claude oturum anahtarın yalnızca Anthropic'e iletilir, başka sağlayıcıya asla gönderilmez.

## Gerekenler

- Node 18+
- Bir kez giriş yapılmış Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude
```

Tarayıcıda giriş yap, sonra `/exit` yaz. (npm 11+ paketin kurulum betiğini engelleyebilir: kurulum komutuna `--allow-scripts=@anthropic-ai/claude-code` ekle.)

## Kurulum

```bash
npm install -g github:smyrna-pergamum/Claude-Code-Fallback
```

Bu, proxy'yi ve `cc-fallback` komutunu kurar (masaüstü uygulamasını değil, Electron indirmez). İstersen Claude Code içinde eklentiyi de ekle:

```
/plugin marketplace add smyrna-pergamum/Claude-Code-Fallback
/plugin install cc-fallback@cc-fallback
```

Masaüstü uygulaması için repoyu klonla ve [Masaüstü uygulaması](#masaüstü-uygulaması-cc-desk) bölümüne bak.

## Kullanım

```bash
cc-fallback scan     # bu bilgisayar ne çalıştırabilir? hangi anahtarlar eksik?
cc-fallback run      # proxy'yi başlatır ve Claude Code'u onun üzerinden açar
```

`run` sonrasındaki argümanlar `claude`'a gider: `cc-fallback run --continue` son oturuma devam eder, `cc-fallback run --resume` bulunduğun klasörün eski oturumlarından birini seçtirir.

| Komut | Ne yapar |
|---|---|
| `start` | yalnızca proxy'yi çalıştırır (ön planda) |
| `status` | sağlayıcılar, beklemeler, başarılı/başarısız sayıları |
| `use <sağlayıcı \| sağlayıcı,model \| auto>` | bir sağlayıcıyı veya modeli zorlar ya da otomatiğe döner |
| `reset` | tüm beklemeleri temizler (Claude'u hemen yeniden dener) |
| `reload` | ayar dosyasını yeniden başlatmadan tekrar okur |
| `init` | düzenleyebileceğin bir ayar dosyası yazar |
| `env` | Claude Code'u proxy'ye elle nasıl yönlendireceğini gösterir |

Proxy'yi ayrı çalıştırmak için:

```bash
cc-fallback start
```

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

> `ANTHROPIC_BASE_URL`'yi (ör. `~/.claude/settings.json` → `env` içinde) kalıcı olarak yalnızca proxy her zaman çalışıyorsa ayarla; yoksa Claude Code bağlanamaz.

### Windows notları

- PowerShell'in varsayılan ayarı npm'in `.ps1` başlatıcılarını engeller. `cc-fallback.cmd` ve `claude.cmd` yaz ya da yerel betiklere bir kez izin ver: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- `setx` ile tanımlanan ortam değişkenleri yalnızca yeni açılan terminallere ve yeniden başlatılan proxy'ye ulaşır.
- Proxy'yi oturum açılışında gizli başlatmak için şunu Başlangıç klasörüne (`Win+R` → `shell:startup`) `cc-fallback.vbs` olarak kaydet; proxy kapanırsa yeniden açar.

```vb
Set sh = CreateObject("WScript.Shell")
Do
  sh.Run "cmd /c cc-fallback.cmd start", 0, True
  WScript.Sleep 10000
Loop
```

## Ücretsiz API anahtarları

Anahtarları CC Desk'te (**Models & API keys**) ya da ortam değişkeni olarak ekle; anahtarı olmayan sağlayıcılar atlanır.

| Sağlayıcı | Değişken | Anahtar | Varsayılan model |
|---|---|---|---|
| Google Gemini | `GEMINI_API_KEY` | aistudio.google.com/app/apikey | gemini-2.5-flash |
| Z AI (GLM) | `ZAI_API_KEY` | z.ai (api.z.ai) | glm-4.7-flash |
| NVIDIA NIM | `NVIDIA_API_KEY` | build.nvidia.com | nvidia/nemotron-3-ultra-550b-a55b |
| Cerebras | `CEREBRAS_API_KEY` | cloud.cerebras.ai | gpt-oss-120b |
| Mistral | `MISTRAL_API_KEY` | console.mistral.ai/api-keys | mistral-medium-latest |
| Groq | `GROQ_API_KEY` | console.groq.com/keys | openai/gpt-oss-120b |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai/keys | nvidia/nemotron-3-ultra-550b-a55b:free |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com/profile/api-tokens | @cf/openai/gpt-oss-120b |
| Kilo Code | gerekmez | – | kilo-auto/free |
| LLM7.io | gerekmez (isteğe bağlı `LLM7_API_KEY`, token.llm7.io) | – | DeepSeek-V4-Flash-0731 |

Kilo ve LLM7 ortak ücretsiz havuzlardır: daha yavaştır, sınırlıdır (LLM7'nin günlük kotası var) ve istemleri kaydedebilirler. Liste [awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis) temel alınarak hazırlandı.

Ücretsiz katmanlar, model adları ve limitler sık değişir. Claude Code her istekte ~20k token gönderir; dakikalık token limiti düşük sağlayıcılar isteği reddedebilir, bu durumda bir sonrakine geçilir. Her sağlayıcının güncel koşullarına bak.

## Yerel modeller

```bash
ollama pull qwen3-coder:30b      # ya da cc-fallback scan'in önerdiği
```

Hazır gelenler: Ollama (11434 portu), LM Studio (1234) ve llama.cpp sunucusu (8080), hepsi `model: "auto"` ile. OpenAI uyumlu başka bir yerel sunucuyu CC Desk'ten (**Add local AI**) ya da ayar dosyasından ekleyebilirsin.

Claude Code geniş bağlam ister: Ollama'yı `OLLAMA_CONTEXT_LENGTH=32768` (veya fazlası) ile başlat; LM Studio'da modeli en az 32k bağlamla yükleyip sunucuyu aç.

| Model için bellek | Öneri |
|---|---|
| 24 GB+ VRAM / 32 GB+ Mac | `qwen3-coder:30b`, `devstral:24b`, `gpt-oss:20b` |
| 12–16 GB | `qwen3:14b`, `qwen2.5-coder:14b` |
| 8 GB | `qwen3:8b`, `qwen2.5-coder:7b` |
| Yalnızca CPU | küçük modeller çalışır ama yavaştır; ücretsiz bulut API'leri daha iyi |

Yerel açık kaynak modeller uzun görevlerde Claude'dan belirgin şekilde zayıftır; limit sıfırlanana kadar basit işleri sürdürmek için uygundur.

## Masaüstü uygulaması (CC Desk)

[`desk/`](desk/) gerçek Claude Code'u (Claude Agent SDK ile) çalıştırır ve onu her zaman proxy'ye yönlendirir; proxy kapalıysa kendisi başlatır.

- Açık ve koyu temada Claude Code görünümü: mesaj baloncukları, çıktısıyla birlikte açılan araç satırları, onay kartları (Allow once / Always allow / Deny), izin modları
- Klasöre göre oturumların, Claude masaüstü uygulamasında ya da terminalde başlattıkların dahil: birini açıp devam et
- Model seçici: Claude modelleri ya da herhangi bir ücretsiz sağlayıcının modeli
- Durum çubuğu: hangi sağlayıcının cevap verdiği, Claude limitinin ne zaman açılacağı, sağlayıcı zorlama, Claude'u hemen yeniden deneme
- **Models & API keys**: hazır sağlayıcılara anahtar ekle, OpenAI veya Anthropic uyumlu herhangi bir API ekle, yerel yapay zekâ ekle (Ollama, LM Studio, llama.cpp ya da herhangi bir yerel adres), bağlantıyı test edip modelleri listele, sağlayıcıları sırala ve aç/kapat; değişiklikler yeniden başlatmadan uygulanır

Repo kökünden:

```bash
npm run desk
```

Masaüstü ve Başlat menüsü kısayolları (Windows, ilk `npm run desk`'ten sonra):

```bash
cscript desk\scripts\create-shortcut.vbs
```

Ayrıntılar: [desk/README.md](desk/README.md).

## Ayarlar

`cc-fallback init` ile `~/.cc-fallback/config.json` oluşturulur (CC Desk de aynı dosyaya yazar). Sağlayıcı sırası, yedeğe geçiş sırasıdır. Dosyayı elle düzenledikten sonra `cc-fallback reload` çalıştır. Alanların tam listesi [İngilizce README'de](README.md#configuration).

Dosyada `providers` listesi olduğunda hazır listenin yerine geçer: sonraki sürümlerde eklenen sağlayıcılar, sen ekleyene kadar görünmez.

Öne çıkan alanlar:

- **Anahtar havuzu:** `"apiKey": ["env:GEMINI_API_KEY", "env:GEMINI_API_KEY_2"]`. Limite takılan anahtar beklemeye alınır, sıradaki kullanılır.
- **Seviyeye göre model:** `"models": { "opus": "…", "sonnet": "…", "haiku": "…" }`.
- **Bağlam sınırı:** `contextWindow`'dan büyük istekler o sağlayıcıyı atlar.
- **Eşzamanlılık:** `maxConcurrent` dolunca paralel istek bir sonraki sağlayıcıya gider (Z AI için 1).

### Yönlendirme

[claude-code-router](https://github.com/musistudio/claude-code-router) ve [free-claude-code](https://github.com/alishahryar1/free-claude-code) fikirlerinden, burada sıfırdan yazıldı.

`routes`, istek türüne göre tercih edilen hedefleri (`"sağlayıcı"` ya da `"sağlayıcı,model"`) listeler. Claude yine önce denenir; yönlendirme bir sonraki ücretsiz sağlayıcıyı belirler.

| Yönlendirme | Ne zaman |
|---|---|
| `background` | Claude Code'un haiku seviyesindeki istekleri (başlıklar, özetler, komut kontrolleri). **Bu hedefler Claude'dan önce denenir** ve Claude kotasını korur. Bu isteklerin bir kısmı güvenlik kontrolü olduğu için varsayılan olarak kapalı; yetenekli bir model seç. |
| `image` | son kullanıcı mesajında resim var |
| `longContext` | istek `longContextThreshold` token'dan büyük |
| `think` | Claude Code genişletilmiş düşünme istedi |

**Modeli kendin seç**

- Claude Code içinde: `/model gemini,gemini-2.5-pro` tüm istekleri o sağlayıcı ve modele gönderir (Claude atlanır, diğer ücretsiz sağlayıcılar yedek kalır). Bir Claude modeli seçmek normale döndürür.
- Alt ajan için: isteminin başına `<CCF-MODEL>sağlayıcı,model</CCF-MODEL>` koy; etiket gönderilmeden önce silinir.
- CC Desk'te: mesaj kutusunun altındaki model seçici.
- Terminalden: `cc-fallback use nvidia,openai/gpt-oss-20b` (ya da `auto`).

Her yanıtta `x-cc-fallback-provider` başlığı bulunur.

### Kontrol adresleri

Betikler ve uygulamalar için, proxy'nin adresinde: `GET /_fallback/status` ve `POST /_fallback/use` (`{"provider": "…"}`), `/_fallback/reset`, `/_fallback/reload`.

## Gizlilik

- Yedek bir sağlayıcı cevap verdiğinde konuşman (Claude Code'un okuduğu kodlar dahil) o sağlayıcıya, onun koşullarıyla gönderilir. Önemliyse yerel model kullan.
- `cc-fallback run` ve CC Desk `CLAUDE_CODE_ATTRIBUTION_HEADER=0` ayarlar, proxy de Claude Code'un faturalama satırını siler; böylece bunlar diğer sağlayıcılara gitmez.
- CC Desk'te kaydettiğin anahtarlar bilgisayarında `~/.cc-fallback/config.json` içinde düz metin olarak saklanır. Ortam değişkeni tercih edersen `env:DEGISKEN_ADI` kullan.
- Proxy ve CC Desk yalnızca 127.0.0.1'i dinler; CC Desk ayrıca her açılışta değişen bir anahtar ister.

## Sınırlamalar

- Claude masaüstü uygulaması proxy'den geçmez (yukarıya bak).
- Yedek model cevap verirken yalnızca Claude'a özgü özellikler (genişletilmiş düşünme, web arama aracı, istem önbelleği) kullanılamaz.
- Akış yarıda kesilirse o yanıt başka sağlayıcıda tekrar denenemez; mesajını yeniden gönder.
- Claude beklemedeyken `/v1/messages/count_tokens` tahminidir.
- CC Desk kendi Claude girişinle kişisel kullanım içindir; diff görünümü, tarayıcı paneli ve paralel oturumları yoktur.

## Proje yapısı

| Yol | İçerik |
|---|---|
| `bin/`, `src/` | proxy ve `cc-fallback` komutu |
| `commands/`, `.claude-plugin/` | Claude Code eklentisi |
| `desk/` | CC Desk masaüstü uygulaması (kendi `package.json`'u var) |
| `test/` | proxy testleri |

## Geliştirme

```bash
npm test
```

```bash
npm --prefix desk test
```

## Lisans

MIT
