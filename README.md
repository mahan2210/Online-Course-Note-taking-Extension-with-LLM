# Course Notes Agent

<div align="center">

**Turn online course videos into structured, searchable lecture notes.**

![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-V3-34A853)
![License](https://img.shields.io/badge/License-Free-success)
![Version](https://img.shields.io/badge/Version-0.2.2-blueviolet)

*Free to use. Choose Groq or Gemini for cloud processing, or keep everything local with Ollama.*

</div>

---

## ✨ What it does

Course Notes Agent captures course lectures and converts the transcript into polished study notes.

| Feature | Description |
|---|---|
| 🎥 **Lecture transcription** | Finds transcripts from YouTube, Udemy, Coursera, and timestamp-based players |
| 📝 **Structured notes** | Creates overviews, key concepts, definitions, formulas, examples, and review questions |
| 🗂️ **Course organization** | Stores lecture notes by course and remembers your course names |
| 🧠 **Course summaries** | Combines every lecture into a complete course summary |
| 📤 **Markdown export** | Downloads the summary and all lecture notes in one `.md` file |
| ⏯️ **Auto-note mode** | Processes a video automatically at approximately 95% watched |
| 📎 **Manual transcripts** | Supports pasted text and `.txt`, `.vtt`, or `.srt` uploads |
| 🛑 **Job controls** | Queues work, processes one job at a time, and can stop the current queue |

---

## 🤖 Choose your AI provider

| Provider | Speed | Privacy | Setup |
|---|:---:|---|---|
| **Groq** | ⚡ Very fast | Transcript sent to Groq | Free API key |
| **Google Gemini** | ⚡ Fast | Free-tier prompts may be used by Google | Free API key |
| **Ollama** | Local | Stays on your computer | Install Ollama |

<details>
<summary><strong>Get a provider API key</strong></summary>

- **Groq:** [console.groq.com/keys](https://console.groq.com/keys)
- **Google Gemini:** [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

Open the extension's **Settings**, select a provider, paste your key, and choose **Test connection**.

</details>

---

## 🚀 Quick start

### 1. Install Ollama — or skip this step

Use Groq or Gemini for a fast cloud setup. For fully local processing:

1. Download and install [Ollama](https://ollama.com).
2. Open a terminal and pull a model:

```powershell
ollama pull llama3.1:8b
```

**Other model options**

| Model | Best for |
|---|---|
| `llama3.1:8b` | Balanced quality and performance |
| `qwen2.5:7b` | General-purpose notes |
| `gemma2:9b` | Higher-quality notes on capable hardware |
| `llama3.2:3b` | Lighter machines |

### 2. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project folder.
5. Pin **Course Notes Agent** and open the side panel.

### 3. Configure and test

1. Open **Settings (AI model)**.
2. Select Groq, Gemini, or Ollama.
3. Enter the API key or server URL when required.
4. Confirm the model name.
5. Choose **Test connection**.

> Model names may change as providers retire older models. Testing a connection can show the available model names.

---

## 🎬 Using the extension

1. Enter a course name, such as `CS231n`.
2. Open a lecture video.
3. Select **Note this video**.
4. Review or export the generated notes.

### Other actions

- **Add transcript** — upload a transcript or paste one manually.
- **Course summary** — generate a summary from all saved lecture notes.
- **Export .md** — download the course summary and complete notes.
- **Auto-note** — process each video automatically near the end, while the side panel stays open.
- **Stop** — cancel the active job and clear the queue.

<details>
<summary><strong>Transcript detection order</strong></summary>

The extension tries these sources in order:

1. YouTube captions
2. The video's English subtitle track
3. Caption files already loaded by the player
4. The player's caption track
5. Udemy and Coursera transcript panels
6. Timestamp-and-text transcript layouts

On Udemy or Coursera, open the transcript panel before generating notes to give the extension access to the full text.

</details>

---

## 🔧 Ollama configuration

> The extension version 0.1.1 and later normally handles Ollama CORS automatically. Use the manual settings below only if you receive a `403` response.

### Windows

```powershell
setx OLLAMA_ORIGINS "chrome-extension://*"
```

Then fully quit Ollama from the system tray and start it again.

### macOS

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
```

Restart the Ollama app afterward.

### Linux

Add this environment variable to the Ollama systemd service:

```ini
Environment="OLLAMA_ORIGINS=chrome-extension://*"
```

Restart the Ollama service to apply the change.

---

## 🩺 Troubleshooting

### Ollama refused the request with `403`

1. Open `chrome://extensions`, reload **Course Notes Agent**, and reopen the side panel.
2. If it still fails, set the origin manually using the steps above.
3. Quit Ollama completely and remove any leftover `ollama.exe` or `ollama app.exe` processes.
4. Start Ollama again.
5. Verify it is reachable:

```powershell
curl.exe -H "Origin: chrome-extension://test" http://localhost:11434/api/tags
```

A model list means Ollama is responding correctly.

### Could not reach Ollama

Start Ollama from the Start menu, or run:

```bash
ollama serve
```

### The transcript is incomplete

- Open the site's transcript panel before generating notes.
- Try uploading or pasting the transcript manually.
- Be aware that some players expose captions only in parts.

### The notes are inconsistent

Try a larger model such as `llama3.1:8b`, `qwen2.5:7b`, or `gemma2:9b`. Model quality and available RAM or GPU memory can affect results.

---

## ⚠️ Known limitations

- Videos without captions or a visible transcript require a manual transcript.
- Fragmented player captions may not cover the whole lecture.
- Generated notes depend on the selected model and transcript quality.
- For best local results, use a 7B–9B model where your hardware permits.

---

## 💡 Ideas for the future

- [ ] Audio fallback with `chrome.tabCapture` and a local Faster Whisper server
- [ ] Slide capture using interval screenshots and a local vision model
- [ ] Chat against saved course notes
- [ ] Direct export to Notion or an Obsidian vault

---

<div align="center">

Made for faster, more focused studying.

</div>
