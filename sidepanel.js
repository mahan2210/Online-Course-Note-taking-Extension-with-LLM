// Course Notes Agent: side panel logic.
// Transcripts are read from the page (or uploaded); notes come from Ollama (local) or a free cloud API.

const $ = (id) => document.getElementById(id);

// ---------- Prompts ----------
const NOTE_SYSTEM = `You are a careful study assistant. Write clear study notes in Markdown from a lecture transcript.
Use exactly these sections:
### Overview
(2-3 sentences)
### Key concepts
(bullets; 1-2 sentences each)
### Definitions and formulas
### Examples
### Review questions
(3 short self-test questions; with answers hidden in a collapsible section)
Use only information from the transcript. Be concise; skip filler and small talk.`;

const MERGE_SYSTEM = `You merge partial study notes from consecutive parts of ONE lecture into a single set of notes.
Keep the same sections (Overview, Key concepts, Definitions and formulas, Examples, Review questions).
Remove duplicates, keep timestamps, keep it concise. Output Markdown only.`;

const CONDENSE_SYSTEM = `Condense these lecture notes from one course into a shorter digest.
Keep every lecture title as a heading, its main ideas, key definitions and formulas. Output Markdown only.`;

const SUMMARY_SYSTEM = `You write the final summary of an online course from its lecture notes.
Use these sections in Markdown:
### Big picture
(one paragraph: what the course teaches and how the parts connect)
### Lecture by lecture
(one or two bullets per lecture, in order)
### Key takeaways
(5-10 bullets)
### Glossary
(important terms with one-line definitions)
Use only the notes provided.`;

// ---------- Transcript extraction (runs inside the web page) ----------
// Must be self-contained: it is serialized and injected with chrome.scripting.
async function extractTranscript() {
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  let title = clean(document.title.replace(/\s*-\s*YouTube$/, ''));
  const slug = location.pathname.split('/').filter(Boolean).pop() || '';
  const courseSlug = (location.pathname.match(/\/courses\/([^/]+)/) || [])[1] || '';
  const ACR = /^(ai|ml|llm|llms|ocr|rag|api|apis|ui|gpu|cnn|rnn|nlp|gpt|mcp|sql|ii|iii|iv)$/i;
  const pretty = (x) => decodeURIComponent(x).replace(/[-_]+/g, ' ')
    .replace(/\b\w+/g, (w) => (ACR.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  if (/(^|\.)deeplearning\.ai$/.test(location.hostname) && /\/lesson\//.test(location.pathname)) {
    // DeepLearning.AI: page title is the course name; the lesson name is in the URL (".../lesson/pu5xbv/welcome")
    const courseTitle = clean(title.replace(/\s*[-|]\s*DeepLearning\.AI.*$/i, ''));
    const course = !courseTitle || /learning platform/i.test(courseTitle) ? pretty(courseSlug) : courseTitle;
    title = slug ? `${course}: ${pretty(slug)}` : course;
  } else if (!title || /learning platform/i.test(title)) {
    title = slug ? (courseSlug ? `${pretty(courseSlug)}: ${pretty(slug)}` : pretty(slug)) : (title || 'Untitled video');
  }
  const url = location.href;
  const done = (text, source) => ({ title, url, text, source });

  // 1) YouTube caption track via the player's own data
  if (location.hostname.endsWith('youtube.com')) {
    try {
      const player = document.querySelector('#movie_player');
      const pr = (player && player.getPlayerResponse && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const t = tracks.find((x) => x.languageCode?.startsWith('en') && x.kind !== 'asr')
             || tracks.find((x) => x.languageCode?.startsWith('en')) || tracks[0];
      if (t?.baseUrl) {
        const raw = await (await fetch(t.baseUrl + '&fmt=json3')).text();
        if (raw) {
          const lines = (JSON.parse(raw).events || [])
            .filter((e) => e.segs)
            .map((e) => [e.tStartMs || 0, clean(e.segs.map((s) => s.utf8).join(''))])
            .filter(([, txt]) => txt)
            .map(([ms, txt]) => `[${fmt(ms / 1000)}] ${txt}`);
          if (lines.length) return done(lines.join('\n'), 'YouTube captions');
        }
      }
    } catch (e) { /* fall through */ }

    // 1b) YouTube transcript panel (user clicked "Show transcript")
    const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (segs.length) {
      const lines = [...segs].map((s) => {
        const ts = clean(s.querySelector('.segment-timestamp')?.textContent);
        const txt = clean(s.querySelector('.segment-text')?.textContent || s.textContent);
        return ts ? `[${ts}] ${txt}` : txt;
      }).filter(Boolean);
      if (lines.length) return done(lines.join('\n'), 'YouTube transcript panel');
    }
  }

  // From here on, collect every source that works and keep the one with the most real speech.
  // A source only counts if its lines read like sentences, not image links
  // (video players also load "thumbnail"/"storyboard" .vtt files whose lines are image URLs).
  const JUNK = /#xywh=|\.(jpe?g|png|webp|gif)(\?|#|$)|^https?:\/\/|^data:image/i;
  const wordsIn = (l) => (JUNK.test(l) ? 0 : l.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length);
  const speechWords = (lines) => lines.reduce((n, l) => n + wordsIn(l), 0);
  const looksLikeSpeech = (lines) => lines.length >= 5 &&
    lines.filter((l) => JUNK.test(l)).length / lines.length < 0.2 &&
    speechWords(lines) / lines.length >= 2;
  const candidates = [];
  const offer = (cues, source) => {   // cues: [{ t: seconds | null, ts: 'm:ss' | null, text }]
    const texts = cues.map((c) => c.text);
    if (!looksLikeSpeech(texts)) return;
    const text = cues.map((c) => (c.ts ? `[${c.ts}] ` : c.t != null ? `[${fmt(c.t)}] ` : '') + c.text).join('\n');
    candidates.push({ text, source, words: speechWords(texts) });
  };
  const parseCues = (raw) => {
    const out = [];
    let cur = null;
    for (const l of raw.replace(/\r/g, '').split('\n')) {
      const m = l.match(/^(\d{1,2}:)?(\d{1,2}):(\d{2})[.,]\d{3}\s*-->/);
      if (m) { cur = { t: (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10), parts: [] }; out.push(cur); }
      else if (!l.trim()) cur = null;
      else if (cur) cur.parts.push(l.replace(/<[^>]+>/g, ''));
    }
    return out.map((c) => ({ t: c.t, text: clean(c.parts.join(' ')) })).filter((c) => c.text);
  };

  // 2a) HLS video streams (DeepLearning.AI and many others): the master playlist lists subtitle
  //     tracks per language. Read the whole English track, so nothing depends on playback.
  try {
    const m3u8s = [...new Set(performance.getEntriesByType('resource').map((e) => e.name)
      .filter((u) => /\.m3u8(\?|#|$)/i.test(u)))];
    const attr = (line, k) => (line.match(new RegExp(`${k}="([^"]*)"`)) || [])[1];
    for (const mu of m3u8s.slice(0, 10)) {
      const master = await (await fetch(mu)).text();
      const subs = master.split('\n').filter((l) => /^#EXT-X-MEDIA:.*TYPE=SUBTITLES/.test(l))
        .map((l) => ({ lang: (attr(l, 'LANGUAGE') || '').toLowerCase(), name: attr(l, 'NAME') || '', uri: attr(l, 'URI') }))
        .filter((x) => x.uri);
      if (!subs.length) continue;
      const track = subs.find((x) => x.lang.startsWith('en') || /english/i.test(x.name)) || subs[0];
      const plUrl = new URL(track.uri, mu).href;
      const pl = await (await fetch(plUrl)).text();
      const segUrls = pl.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
        .map((l) => new URL(l, plUrl).href).slice(0, 600);
      const cues = [];
      for (let i = 0; i < segUrls.length; i += 10) {           // fetch segments 10 at a time
        const texts = await Promise.all(segUrls.slice(i, i + 10).map((u) => fetch(u).then((r) => r.text()).catch(() => '')));
        texts.forEach((t) => cues.push(...parseCues(t)));
      }
      const seen = new Set();
      const merged = [];
      for (const c of cues.sort((x, y) => x.t - y.t)) {
        const k = `${c.t}|${c.text}`;
        if (seen.has(k) || c.text === merged[merged.length - 1]?.text) continue;
        seen.add(k);
        merged.push(c);
      }
      offer(merged, `subtitle track (${track.name || track.lang || 'video stream'})`);
      break;
    }
  } catch (e) { /* fall through */ }

  // 2) Caption files (.vtt/.srt) the player downloaded. Thumbnail files are skipped, and
  //    captions delivered in many small segments are joined back together.
  try {
    const capUrls = [...new Set(performance.getEntriesByType('resource').map((e) => e.name)
      .filter((u) => /\.(vtt|srt|webvtt)(\?|#|$)/i.test(u) && !/thumb|storyboard|sprite|preview|poster|chapter/i.test(u)))];
    const files = [];
    for (const u of capUrls.slice(0, 300)) {
      try {
        const cues = parseCues(await (await fetch(u)).text());
        if (!cues.length || cues.filter((c) => JUNK.test(c.text)).length / cues.length >= 0.2) continue;
        const all = cues.map((c) => c.text).join(' ');
        const n = all.split(/\s+/).length || 1;
        const en = (all.match(/\b(the|and|to|of|is|you|that|this|we|it|in|for)\b/gi) || []).length / n;
        files.push({ u, cues, en });
      } catch (e) { /* skip this file */ }
    }
    let pick = files.filter((f) => f.en >= 0.04);                   // English caption files
    if (!pick.length && files.length) {                             // otherwise: the biggest track's folder
      const big = files.reduce((a, b) => (b.cues.length > a.cues.length ? b : a));
      const dir = big.u.split('?')[0].replace(/[^/]*$/, '');
      pick = files.filter((f) => f.u.split('?')[0].startsWith(dir));
    }
    if (pick.length) {
      const seen = new Set();
      const merged = [];
      for (const c of pick.flatMap((f) => f.cues).sort((x, y) => x.t - y.t)) {
        const k = `${c.t}|${c.text}`;
        if (seen.has(k) || c.text === merged[merged.length - 1]?.text) continue;
        seen.add(k);
        merged.push(c);
      }
      offer(merged, pick.length > 1 ? `caption files (${pick.length} parts)` : 'caption file');
    }
  } catch (e) { /* fall through */ }

  // 3) HTML5 text tracks on any <video> (many course players use these)
  const videos = [...document.querySelectorAll('video')];
  const isCap = (tr) => tr.kind === 'subtitles' || tr.kind === 'captions';
  for (const v of videos) for (const tr of v.textTracks) {
    if (isCap(tr) && tr.mode === 'disabled') tr.mode = 'hidden';
  }
  if (videos.length) await new Promise((r) => setTimeout(r, 1500));
  for (const v of videos) for (const tr of v.textTracks) {
    if (isCap(tr) && tr.cues && tr.cues.length > 5) {
      offer([...tr.cues].map((c) => ({ t: c.startTime, text: clean(c.text.replace(/<[^>]+>/g, '')) })).filter((c) => c.text), 'video captions track');
    }
  }

  // 4) Transcript panels on known course sites
  for (const sel of ['[data-purpose="transcript-cue"]', '.rc-Phrase']) {   // Udemy, Coursera
    const els = document.querySelectorAll(sel);
    if (els.length > 5) offer([...els].map((e) => ({ t: null, text: clean(e.textContent) })).filter((c) => c.text), `page transcript (${sel})`);
  }

  // 5) Any transcript panel laid out as "timestamp + text" rows (DeepLearning.AI, many LMSs).
  //    Scrolls the panel so lists that render only visible rows are fully collected.
  const TS = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  const toSec = (ts) => ts.split(':').reduce((a, b) => a * 60 + parseInt(b, 10), 0);
  const collectRows = () => {
    const leaves = [...document.querySelectorAll('body *')]
      .filter((el) => !el.children.length && TS.test((el.textContent || '').trim()));
    const rows = [];
    for (const leaf of leaves) {
      let row = leaf;
      while (row.parentElement && row.parentElement !== document.body &&
             !leaves.some((o) => o !== leaf && row.parentElement.contains(o))) row = row.parentElement;
      const ts = leaf.textContent.trim();
      const text = clean((row.innerText || row.textContent || '').replace(ts, ''));
      if (text && text.length > 2) rows.push({ ts, text, el: row });
    }
    return rows;
  };
  const rows = collectRows();
  if (rows.length >= 5) {
    const all = new Map();
    const add = (rs) => rs.forEach((r) => all.set(`${r.ts}|${r.text}`, r));
    add(rows);
    let sc = rows[0].el.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (sc) {
      const startTop = sc.scrollTop;
      sc.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 200));
      for (let i = 0; i < 400; i++) {
        add(collectRows());
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
        sc.scrollTop += Math.max(100, sc.clientHeight * 0.8);
        await new Promise((r) => setTimeout(r, 150));
      }
      add(collectRows());
      sc.scrollTop = startTop;
    }
    offer([...all.values()].sort((a, b) => toSec(a.ts) - toSec(b.ts)).map((r) => ({ ts: r.ts, text: r.text })), 'page transcript (timestamp rows)');
  }

  // 6) Generic transcript containers (only if nothing better was found)
  if (!candidates.length) {
    for (const sel of ['[class*="transcript"] [class*="cue"]', '[class*="transcript"] p', '[class*="Transcript"] p']) {
      const els = document.querySelectorAll(sel);
      if (els.length > 5) offer([...els].map((e) => ({ t: null, text: clean(e.textContent) })).filter((c) => c.text), `page transcript (${sel})`);
      if (candidates.length) break;
    }
  }

  if (!candidates.length) return done('', 'none');
  const best = candidates.reduce((a, b) => (b.words > a.words ? b : a));
  return done(best.text, best.source);
}

// ---------- Providers ----------
const PROVIDERS = {
  ollama: {
    label: 'Ollama (local, private)', base: 'http://localhost:11434', model: 'llama3.1:8b', needsKey: false, chunk: 12000,
    hint: 'Runs on your computer: free and private, but slow without a GPU.',
  },
  groq: {
    label: 'Groq (free tier, very fast)', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', needsKey: true, chunk: 12000,
    hint: 'Free tier with no card needed. Free limits are per minute and per day, so long courses may pause briefly and retry.',
    keyUrl: 'https://console.groq.com/keys',
  },
  gemini: {
    label: 'Google Gemini (free tier)', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', needsKey: true, chunk: 150000,
    hint: 'Free tier; reads a whole lecture in one request. On the free tier Google may use prompts to improve its products.',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  custom: {
    label: 'Other OpenAI-compatible API', base: '', model: '', needsKey: true, chunk: 12000,
    hint: 'Any OpenAI-compatible endpoint (OpenRouter, LM Studio, etc.). Use the base URL ending in /v1.',
  },
};
const IDLE_MS = 5 * 60 * 1000;

let settings = { provider: 'ollama', p: {} };
let shownProvider = 'ollama';
const cfg = () => ({ ...PROVIDERS[settings.provider], ...(settings.p[settings.provider] || {}) });
const chunkChars = () => PROVIDERS[settings.provider].chunk;

// ---------- Helpers ----------
function status(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

function videoKey(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('youtube.com') && u.searchParams.get('v')) return 'yt:' + u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return 'yt:' + u.pathname.slice(1);
    return u.origin + u.pathname;
  } catch { return url; }
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// .vtt / .srt text -> "[m:ss] line" text
function parseCaptions(raw) {
  const out = [];
  let cur = null;
  for (const l of raw.replace(/\r/g, '').split('\n')) {
    const m = l.match(/^(\d{1,2}:)?(\d{1,2}):(\d{2})[.,]\d{3}\s*-->/);
    if (m) { cur = { t: (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10), text: [] }; out.push(cur); }
    else if (!l.trim()) cur = null;
    else if (cur) cur.text.push(l.replace(/<[^>]+>/g, ''));
  }
  const lines = [];
  for (const c of out) {
    const line = c.text.join(' ').replace(/\s+/g, ' ').trim();
    if (line && line !== lines[lines.length - 1]?.text) lines.push({ t: c.t, text: line });
  }
  return lines.map((x) => `[${fmtTime(x.t)}] ${x.text}`).join('\n');
}

function splitText(text, size = chunkChars()) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) { chunks.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// Repeatedly merge texts in groups until one text is left (map-reduce).
async function reduceTexts(texts, system, label) {
  let round = 1;
  while (texts.length > 1) {
    const groups = [];
    let g = [], len = 0;
    for (const t of texts) {
      if (g.length >= 2 && len + t.length > chunkChars()) { groups.push(g); g = []; len = 0; }
      g.push(t); len += t.length;
    }
    if (g.length) groups.push(g);
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].length === 1) { out.push(groups[i][0]); continue; }
      const rep = progressReporter(`${label}: round ${round}, group ${i + 1}/${groups.length}`);
      try { out.push(await llm(system, groups[i].join('\n\n---\n\n'), rep)); } finally { rep.stop(); }
    }
    texts = out; round++;
  }
  return texts[0];
}

// ---------- Job queue (one model request at a time, Stop cancels everything) ----------
const queue = [];
let running = false;
let jobCtrl = null;

function enqueue(label, fn) {
  queue.push({ label, fn });
  if (running) status(`${$('status').textContent.split('\n')[0]}\nQueued: ${label}`);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  $('stopBtn').classList.remove('hidden');
  while (queue.length) {
    const job = queue.shift();
    jobCtrl = new AbortController();
    try {
      await job.fn();
    } catch (e) {
      status(`${job.label}: ${e.message}`, true);
      if (e.message === 'Stopped.') queue.length = 0;
      else if (queue.length) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  jobCtrl = null;
  running = false;
  $('stopBtn').classList.add('hidden');
}

function stopAll() {
  queue.length = 0;
  if (jobCtrl) { jobCtrl.abort(); status('Stopping...'); }
}

const stopped = () => !!jobCtrl?.signal.aborted;
const sleep = (ms) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  jobCtrl?.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Stopped.')); }, { once: true });
});

// Shows "waiting Ns" until the first words arrive, then "N words so far".
function progressReporter(prefix) {
  const t0 = Date.now();
  let words = 0, note = '';
  const show = () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    let msg = words
      ? `${prefix}\nWriting... ${words} words so far (${sec}s)`
      : `${prefix}\nWaiting for the model (${sec}s)` + (settings.provider === 'ollama' ? '. The first run can take a minute or two while it loads.' : '...');
    if (note) msg += `\n${note}`;
    if (queue.length) msg += `\n${queue.length} more queued`;
    status(msg);
  };
  show();
  const timer = setInterval(show, 1000);
  return {
    onProgress: (text) => { words = text.split(/\s+/).filter(Boolean).length; },
    setNote: (n) => { note = n; show(); },
    stop: () => clearInterval(timer),
  };
}

// ---------- Model calls (streaming) ----------
function makeAbort() {
  const ctrl = new AbortController();
  const job = jobCtrl;
  let t = setTimeout(() => ctrl.abort(), IDLE_MS);
  const onJob = () => ctrl.abort();
  job?.signal.addEventListener('abort', onJob, { once: true });
  return {
    signal: ctrl.signal,
    bump() { clearTimeout(t); t = setTimeout(() => ctrl.abort(), IDLE_MS); },
    done() { clearTimeout(t); job?.signal.removeEventListener('abort', onJob); },
  };
}

async function readLines(body, ab, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (ab.signal.aborted) { reader.cancel().catch(() => {}); throw new DOMException('Aborted', 'AbortError'); }
    if (done) break;
    ab.bump();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && onLine(line) === false) { reader.cancel().catch(() => {}); return; }
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function llm(system, user, rep) {
  const c = cfg();
  if (c.needsKey && !c.key) throw new Error(`Add your ${PROVIDERS[settings.provider].label} API key in Settings first.`);
  for (let attempt = 0; ; attempt++) {
    try {
      return settings.provider === 'ollama'
        ? await ollamaChat(c, system, user, rep)
        : await openaiChat(c, system, user, rep);
    } catch (e) {
      if (stopped()) throw new Error('Stopped.');
      if (!e.retryAfter) throw e;
      if (attempt >= 5) throw new Error('The free-tier limit was reached and retries did not help. Try again later, or switch provider in Settings.');
      for (let s = e.retryAfter; s > 0; s--) {
        const msg = `Free-tier rate limit reached; retrying in ${s}s...`;
        if (rep) rep.setNote(msg); else status(msg);
        await sleep(1000);
      }
      if (rep) rep.setNote('');
    }
  }
}

async function ollamaChat(c, system, user, rep) {
  const SLOW = 'Ollama sent nothing for 5 minutes. Try a smaller model (e.g. llama3.2:3b), check it runs on your GPU ("ollama ps"), or switch to a free cloud provider in Settings.';
  const ab = makeAbort();
  let r;
  try {
    r = await fetch(`${c.base.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      signal: ab.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model, stream: true,
        options: { num_ctx: 8192, temperature: 0.2 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  } catch (e) {
    ab.done();
    if (stopped()) throw new Error('Stopped.');
    if (e.name === 'AbortError') throw new Error(SLOW);
    throw new Error('Could not reach Ollama. Is it running? (ollama serve)');
  }
  if (r.status === 403) { ab.done(); throw new Error('Ollama refused the request (403). Reload the extension in chrome://extensions, or see README > Troubleshooting.'); }
  if (!r.ok) { ab.done(); throw new Error(`Ollama error ${r.status}: ${(await r.text()).slice(0, 300)}`); }
  let out = '';
  try {
    await readLines(r.body, ab, (line) => {
      const j = JSON.parse(line);
      if (j.error) throw new Error('Ollama: ' + j.error);
      out += j.message?.content || '';
      rep?.onProgress(out);
    });
  } catch (e) {
    if (stopped()) throw new Error('Stopped.');
    if (e.name === 'AbortError') throw new Error(SLOW);
    throw e;
  } finally { ab.done(); }
  return out.trim();
}

async function openaiChat(c, system, user, rep) {
  const ab = makeAbort();
  const body = {
    model: c.model, stream: true, temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (/gpt-oss/.test(c.model)) body.reasoning_effort = 'low';
  let r;
  try {
    r = await fetch(`${c.base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ab.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    ab.done();
    if (stopped()) throw new Error('Stopped.');
    if (e.name === 'AbortError') throw new Error('The API sent nothing for 5 minutes.');
    throw new Error(`Could not reach ${c.base}. Check your internet connection and the URL in Settings.`);
  }
  if (r.status === 429) {
    ab.done();
    const ra = parseFloat(r.headers.get('retry-after'));
    const err = new Error('Rate limit reached.');
    err.retryAfter = Math.min(90, Math.max(5, Math.ceil(isFinite(ra) ? ra : 20)));
    throw err;
  }
  if (r.status === 401 || r.status === 403) { ab.done(); throw new Error(`The API key was rejected (HTTP ${r.status}). Check the key in Settings.`); }
  if (!r.ok) { ab.done(); throw new Error(`API error ${r.status}: ${(await r.text()).slice(0, 300)}`); }
  let out = '';
  try {
    await readLines(r.body, ab, (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return false;
      const j = JSON.parse(data);
      if (j.error) throw new Error('API: ' + (j.error.message || JSON.stringify(j.error)));
      out += j.choices?.[0]?.delta?.content || '';
      rep?.onProgress(out);
    });
  } catch (e) {
    if (stopped()) throw new Error('Stopped.');
    if (e.name === 'AbortError') throw new Error('The API sent nothing for 5 minutes.');
    throw e;
  } finally { ab.done(); }
  return out.trim();
}

// ---------- Storage ----------
async function getCourses() {
  const { courses = {} } = await chrome.storage.local.get('courses');
  return courses;
}
async function saveCourses(courses) { await chrome.storage.local.set({ courses }); }
function courseName() { return $('course').value.trim(); }

// ---------- Core actions ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function captureAndNote(tabId, { skipIfExists = false } = {}) {
  const course = courseName();
  if (!course) return status('Type a course name first.', true);
  if (!running) status('Reading transcript from the page...');
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: extractTranscript });
  } catch (e) {
    return status('Cannot read this page (browser pages and the Chrome Web Store are blocked). Use "Add transcript" instead.', true);
  }
  if (skipIfExists) {
    const courses = await getCourses();
    if (courses[course]?.videos?.[videoKey(result.url)]) { if (!running) status(`Already noted: ${result.title}`); return; }
  }
  if (!result.text || result.text.length < 200) {
    return openManual(result.title, result.url, 'No transcript was found automatically on this page. Upload a transcript file or paste the text:');
  }
  enqueue(result.title, () => noteFromText(course, result));
}

function looksLikeImageLinks(text) {
  const lines = text.split('\n').map((l) => l.replace(/^\[[\d:]+\]\s*/, '').trim()).filter(Boolean);
  if (!lines.length) return true;
  const junk = lines.filter((l) => /#xywh=|\.(jpe?g|png|webp|gif)(\?|#|$)|^https?:\/\//i.test(l)).length;
  return junk / lines.length >= 0.2;
}

async function noteFromText(course, { title, url, text, source }, key = videoKey(url)) {
  if (looksLikeImageLinks(text)) {
    throw new Error('This transcript is mostly image links (video thumbnails), not speech. Open the site\'s Transcript panel and click "Note this video" again, or use "Add transcript".');
  }
  const chunks = splitText(text);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const rep = progressReporter(`Notes for "${title}" (${source}), part ${i + 1}/${chunks.length}`);
    try {
      parts.push(await llm(NOTE_SYSTEM, `Lecture title: ${title}\nPart ${i + 1} of ${chunks.length}\n\nTranscript:\n${chunks[i]}`, rep));
    } finally { rep.stop(); }
  }
  const notes = parts.length === 1 ? parts[0] : await reduceTexts(parts, MERGE_SYSTEM, `Merging parts of "${title}"`);

  const courses = await getCourses();
  const c = (courses[course] ??= { videos: {}, summary: null });
  const prev = c.videos[key];
  c.videos[key] = {
    title, url, notes, source,
    date: new Date().toISOString(),
    order: prev?.order ?? Object.keys(c.videos).length,
  };
  await saveCourses(courses);
  status(`Saved notes for "${title}".` + (queue.length ? `\n${queue.length} more queued` : ''));
  await render();
}

async function summarizeCourse(course) {
  const courses = await getCourses();
  const c = courses[course];
  if (!c || !Object.keys(c.videos).length) throw new Error('No lecture notes in this course yet.');
  const vids = Object.values(c.videos).sort((a, b) => a.order - b.order);
  const texts = vids.map((v, i) => `## ${i + 1}. ${v.title}\n${v.notes}`);
  let material = texts.join('\n\n');
  if (material.length > chunkChars() * 1.5) material = await reduceTexts(texts, CONDENSE_SYSTEM, 'Condensing notes');
  const rep = progressReporter(`Course summary for "${course}"`);
  let summary;
  try { summary = await llm(SUMMARY_SYSTEM, `Course: ${course}\n\n${material}`, rep); } finally { rep.stop(); }
  const fresh = await getCourses();   // re-read: notes may have been added meanwhile
  fresh[course].summary = summary;
  fresh[course].summaryDate = new Date().toISOString();
  await saveCourses(fresh);
  status('Course summary ready.');
  await render();
}

async function exportMarkdown() {
  const course = courseName();
  const c = (await getCourses())[course];
  if (!c) return status('Nothing to export for this course.', true);
  const vids = Object.values(c.videos).sort((a, b) => a.order - b.order);
  let md = `# ${course}\n\n_Exported ${new Date().toLocaleString()}_\n\n## Course summary\n\n${c.summary || '_Not generated yet._'}\n\n# Lecture notes\n`;
  vids.forEach((v, i) => {
    md += `\n---\n\n## ${i + 1}. ${v.title}\n` + (/^https?:/.test(v.url || '') ? `<${v.url}>\n` : '') + `\n${v.notes}\n`;
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${course.replace(/[^\w\- ]+/g, '').trim() || 'course'} notes.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Manual transcript (upload or paste) ----------
let manual = { url: '', pageTitle: '' };

async function openManual(title, url, msg) {
  if (!title) {
    const t = await activeTab();
    title = t?.title || '';
    url = t?.url || '';
  }
  manual = { url: url || '', pageTitle: title || '' };
  $('manualTitle').value = title || '';
  $('manualText').value = '';
  $('manualFile').value = '';
  $('manualMsg').textContent = msg || 'Upload a transcript file (.txt, .vtt, .srt) or paste the text, then click "Make notes".';
  if (msg) status('No transcript found automatically.');
  $('manualBox').classList.remove('hidden');
  $('manualBox').scrollIntoView({ behavior: 'smooth' });
}

function closeManual() { $('manualBox').classList.add('hidden'); }

async function manualFileChosen() {
  const f = $('manualFile').files[0];
  if (!f) return;
  const raw = await f.text();
  $('manualText').value = /-->/.test(raw) ? parseCaptions(raw) : raw.trim();
  const base = f.name.replace(/\.[^.]+$/, '');
  if (!$('manualTitle').value.trim() || $('manualTitle').value === manual.pageTitle) $('manualTitle').value = base;
}

function manualGo() {
  const course = courseName();
  if (!course) return status('Type a course name first.', true);
  const text = $('manualText').value.trim();
  const title = $('manualTitle').value.trim() || 'Untitled lecture';
  if (text.length < 50) return status('The transcript is too short. Upload a file or paste more text.', true);
  // Same title as the open page -> treat as that page's video; otherwise a separate lecture.
  const samePage = manual.url && /^https?:/.test(manual.url) && title === manual.pageTitle;
  const key = samePage ? videoKey(manual.url) : 'manual:' + title.toLowerCase();
  const url = samePage ? manual.url : '';
  closeManual();
  enqueue(title, () => noteFromText(course, { title, url, text, source: 'uploaded/pasted' }, key));
}

// ---------- Settings ----------
function fillSettingsUI(prov) {
  const c = { ...PROVIDERS[prov], ...(settings.p[prov] || {}) };
  $('provider').value = prov;
  $('baseUrl').value = c.base;
  $('model').value = c.model;
  $('apiKey').value = c.key || '';
  $('keyRow').classList.toggle('hidden', !PROVIDERS[prov].needsKey);
  const hint = $('providerHint');
  hint.textContent = PROVIDERS[prov].hint + ' ';
  if (PROVIDERS[prov].keyUrl) {
    const a = document.createElement('a');
    a.href = '#'; a.textContent = 'Get a free API key';
    a.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: PROVIDERS[prov].keyUrl }); };
    hint.appendChild(a);
  }
  shownProvider = prov;
}

function readSettingsUI() {
  const prov = shownProvider;
  settings.p[prov] = {
    base: $('baseUrl').value.trim() || PROVIDERS[prov].base,
    model: $('model').value.trim() || PROVIDERS[prov].model,
    key: $('apiKey').value.trim(),
  };
  settings.provider = prov;
}

// Step-by-step check: server reachable -> model available -> model answers.
async function testConnection() {
  readSettingsUI();
  await chrome.storage.local.set({ settings });
  const btn = $('testLLM');
  btn.disabled = true;
  const c = cfg();
  const isOllama = settings.provider === 'ollama';
  const base = c.base.replace(/\/$/, '');
  try {
    if (c.needsKey && !c.key) throw new Error('Paste your API key first (use the "Get a free API key" link).');
    status(`Step 1/3: contacting ${base} ...`);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(isOllama ? `${base}/api/tags` : `${base}/models`, {
        signal: ctrl.signal,
        headers: c.needsKey ? { Authorization: `Bearer ${c.key}` } : {},
      });
    } catch (e) {
      throw new Error(isOllama
        ? `Step 1 failed: no answer from ${base}.\nIs Ollama running? Open http://localhost:11434 in a tab; it should say "Ollama is running".`
        : `Step 1 failed: could not reach ${base}. Check your internet connection and the URL.`);
    } finally { clearTimeout(to); }
    if (isOllama && r.status === 403) throw new Error('Step 1 failed: Ollama refused the request (403). Reload the extension in chrome://extensions, or see README > Troubleshooting.');
    if (!isOllama && (r.status === 401 || r.status === 403 || r.status === 400)) throw new Error(`Step 1 failed: the API key was rejected (HTTP ${r.status}). Copy the key again and click Test connection.`);
    if (!r.ok) throw new Error(`Step 1 failed: HTTP ${r.status}. ${(await r.text()).slice(0, 200)}`);

    status('Step 2/3: checking the model is available...');
    const data = await r.json();
    const names = isOllama
      ? (data.models || []).map((m) => m.name)
      : (data.data || []).map((m) => String(m.id).replace(/^models\//, ''));
    const want = c.model.replace(/^models\//, '');
    const found = isOllama
      ? names.includes(want.includes(':') ? want : want + ':latest') || names.includes(want)
      : names.includes(want);
    if (!found) {
      throw new Error(`Step 2 failed: model "${c.model}" was not found.\nAvailable: ${names.slice(0, 40).join(', ') || '(none)'}\n` +
        (isOllama ? `Run: ollama pull ${c.model}` : 'Type one of the names above in Model and click Test connection again.'));
    }

    const rep = progressReporter(`Step 3/3: asking ${c.model} to reply`);
    const t0 = Date.now();
    let reply;
    try { reply = await llm('Reply with one short sentence.', 'Say hello.', rep); } finally { rep.stop(); }
    status(`✅ Connected in ${Math.round((Date.now() - t0) / 1000)}s using ${PROVIDERS[settings.provider].label}. ${c.model} says: ${reply}`);
  } catch (e) {
    status(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- UI ----------
async function render() {
  const courses = await getCourses();
  $('courseList').innerHTML = Object.keys(courses).map((n) => `<option value="${n.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`).join('');
  const c = courses[courseName()];
  const list = $('notesList');
  list.innerHTML = '';
  if (!c) { $('summaryOut').textContent = 'Not generated yet.'; $('count').textContent = ''; return; }

  if (c.summary) {
    $('summaryOut').innerHTML = '';
    const pre = document.createElement('pre'); pre.textContent = c.summary;
    $('summaryOut').appendChild(pre);
  } else {
    $('summaryOut').textContent = 'Not generated yet.';
  }

  const vids = Object.entries(c.videos).sort((a, b) => a[1].order - b[1].order);
  $('count').textContent = `(${vids.length})`;
  vids.forEach(([key, v], i) => {
    const d = document.createElement('details');
    const s = document.createElement('summary'); s.textContent = `${i + 1}. ${v.title}`;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${new Date(v.date).toLocaleString()} · ${v.source}`;
    const pre = document.createElement('pre'); pre.textContent = v.notes;
    d.append(s, meta, pre);
    if (/^https?:/.test(v.url || '')) {
      const open = document.createElement('button'); open.textContent = 'Open video';
      open.onclick = () => chrome.tabs.create({ url: v.url });
      d.append(open);
    }
    const del = document.createElement('button'); del.textContent = 'Delete';
    del.onclick = async () => {
      const all = await getCourses(); delete all[courseName()].videos[key];
      await saveCourses(all); render();
    };
    d.append(del);
    list.appendChild(d);
  });
}

async function init() {
  const stored = await chrome.storage.local.get(['settings', 'lastCourse', 'auto']);
  const s = stored.settings || {};
  if (s.provider && s.p) settings = { provider: s.provider, p: s.p };
  else if (s.ollamaUrl || s.model) settings = { provider: 'ollama', p: { ollama: { base: s.ollamaUrl || PROVIDERS.ollama.base, model: s.model || PROVIDERS.ollama.model } } };

  $('provider').innerHTML = Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  fillSettingsUI(settings.provider);
  $('provider').onchange = () => { readSettingsUI(); fillSettingsUI($('provider').value); };
  $('saveSettings').onclick = async () => {
    readSettingsUI();
    await chrome.storage.local.set({ settings });
    status(`Settings saved. Using ${PROVIDERS[settings.provider].label}.`);
  };
  $('testLLM').onclick = testConnection;

  $('course').value = stored.lastCourse || '';
  $('course').addEventListener('input', async () => {
    await chrome.storage.local.set({ lastCourse: courseName() });
    render();
  });
  $('auto').checked = !!stored.auto;
  $('auto').onchange = () => chrome.storage.local.set({ auto: $('auto').checked });

  $('noteBtn').onclick = async () => { const t = await activeTab(); if (t) captureAndNote(t.id); };
  $('manualBtn').onclick = () => openManual();
  $('summaryBtn').onclick = () => {
    const course = courseName();
    if (!course) return status('Type a course name first.', true);
    enqueue(`Course summary`, () => summarizeCourse(course));
  };
  $('exportBtn').onclick = exportMarkdown;
  $('stopBtn').onclick = stopAll;
  $('manualFile').onchange = manualFileChosen;
  $('manualGo').onclick = manualGo;
  $('manualCancel').onclick = () => { closeManual(); if (!running) status(''); };

  // Auto mode: content.js reports when a video is ~95% watched.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'videoNearEnd' && $('auto').checked && sender.tab?.id) {
      captureAndNote(sender.tab.id, { skipIfExists: true });
    }
  });

  render();
}

init();
