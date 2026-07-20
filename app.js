/* ============================================================
   SpeakPrep — English Speaking Coach (pure front-end PWA)
   Brain: Google Gemini (free tier).  Voice: Web Speech API.
   All state stored locally in the browser (localStorage).
   ============================================================ */

/* ---------- Storage ---------- */
const LS = {
  key:   'sp_apikey',
  model: 'sp_model',
  tts:   'sp_tts',
  history:'sp_history',
};
const store = {
  get apiKey() { return localStorage.getItem(LS.key) || ''; },
  set apiKey(v){ localStorage.setItem(LS.key, v); },
  get model()  { return localStorage.getItem(LS.model) || 'gemini-2.5-flash'; },
  set model(v) { localStorage.setItem(LS.model, v); },
  get tts()    { return localStorage.getItem(LS.tts) !== 'off'; },
  set tts(v)   { localStorage.setItem(LS.tts, v ? 'on' : 'off'); },
  get history(){ try { return JSON.parse(localStorage.getItem(LS.history)) || []; } catch { return []; } },
  set history(v){ localStorage.setItem(LS.history, JSON.stringify(v)); },
};

/* ---------- Scenario data ---------- */
const CATEGORIES = {
  work: {
    emoji: '💼',
    title: '工作情境',
    en: 'Work',
    desc: '策略投資 · 訪談標的 · 談合作 · 內部討論',
    domains: [
      'Optical Comms 光通訊','Thermal 散熱','Chips 晶片','Packaging 封裝',
      'Advanced Packaging 先進封裝','Semiconductor Materials 半導體材料',
      'AI','Hardware Assembly 硬體組裝','Consumer Electronics 消費性電子',
      'Medical CDMO 醫療 CDMO',
    ],
  },
  travel: {
    emoji: '✈️',
    title: '旅遊生活',
    en: 'Travel & Life',
    desc: '問路 · 訂房 · 餐廳 · 揪團 · 日常閒聊',
    domains: [
      'Airport & Transport 機場交通','Hotel 飯店','Restaurant 餐廳',
      'Shopping 購物','Sightseeing 觀光','Small Talk 閒聊','Trip Planning 揪團',
    ],
  },
};

const MODULES = {
  ask:     { title: '主動提問', en: 'Asking Questions' },
  meeting: { title: '會議討論', en: 'Meeting Discussion' },
};

const DIFFICULTIES = [
  { id: 'easy', label: '簡單 Easy' },
  { id: 'medium', label: '中等 Medium' },
  { id: 'hard', label: '進階 Hard' },
];

/* ---------- App state ---------- */
const state = {
  category: null,
  module: 'ask',
  domain: null,
  difficulty: 'medium',
  customContext: '',
  scenarioBrief: '',
  turns: [],          // { role:'user'|'ai', kind:'en'|'zh'|'coach'|'ai', text }
  screenStack: [],
};

/* ---------- Element helpers ---------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hasCJK = (s) => /[㐀-龿]/.test(s);

/* ---------- Screen navigation ---------- */
const SCREENS = ['home','scenario','chat','feedback','history','settings'];
function show(name, push = true) {
  SCREENS.forEach(s => $('screen-' + s).classList.toggle('active', s === name));
  if (push && state.screenStack[state.screenStack.length - 1] !== name) state.screenStack.push(name);
  const onHome = name === 'home';
  $('btn-back').hidden = onHome;
  $('btn-settings').hidden = name === 'settings' || name === 'chat';
  window.scrollTo(0, 0);
}
$('btn-back').onclick = () => {
  if (state.screenStack.length > 1) {
    state.screenStack.pop();
    show(state.screenStack[state.screenStack.length - 1], false);
  } else show('home', false);
};
$('btn-settings').onclick = () => show('settings');

/* ============================================================
   HOME
   ============================================================ */
function renderHome() {
  const grid = $('category-grid');
  grid.innerHTML = '';
  Object.entries(CATEGORIES).forEach(([id, c]) => {
    const card = el('button', 'cat-card');
    card.innerHTML =
      `<div class="emoji">${c.emoji}</div><h3>${c.title}</h3>` +
      `<p>${c.en}<br>${c.desc}</p>`;
    card.onclick = () => openScenario(id);
    grid.appendChild(card);
  });
  $('apikey-warning').hidden = !!store.apiKey;
}
$('goto-settings-1').onclick = () => show('settings');
$('btn-history').onclick = () => { renderHistory(); show('history'); };

/* ============================================================
   SCENARIO SETUP
   ============================================================ */
function openScenario(catId) {
  state.category = catId;
  const c = CATEGORIES[catId];
  $('scenario-cat-label').textContent = `${c.emoji} ${c.title} · ${c.en}`;
  state.domain = c.domains[0];
  state.module = 'ask';
  state.difficulty = 'medium';

  // modules
  const mr = $('module-row'); mr.innerHTML = '';
  Object.entries(MODULES).forEach(([id, m]) => {
    const p = el('button', 'pill' + (id === state.module ? ' active' : ''), `${m.title} · ${m.en}`);
    p.onclick = () => { state.module = id; [...mr.children].forEach(x => x.classList.remove('active')); p.classList.add('active'); };
    mr.appendChild(p);
  });

  // domains
  const dr = $('domain-row'); dr.innerHTML = '';
  c.domains.forEach((d, i) => {
    const p = el('button', 'pill' + (i === 0 ? ' active' : ''), d);
    p.onclick = () => { state.domain = d; [...dr.children].forEach(x => x.classList.remove('active')); p.classList.add('active'); };
    dr.appendChild(p);
  });

  // difficulty
  const fr = $('difficulty-row'); fr.innerHTML = '';
  DIFFICULTIES.forEach(d => {
    const p = el('button', 'pill' + (d.id === 'medium' ? ' active' : ''), d.label);
    p.onclick = () => { state.difficulty = d.id; [...fr.children].forEach(x => x.classList.remove('active')); p.classList.add('active'); };
    fr.appendChild(p);
  });

  $('custom-context').value = '';
  show('scenario');
}

$('btn-start').onclick = () => {
  if (!store.apiKey) { alert('請先到「設定」貼上 Gemini API 金鑰。'); show('settings'); return; }
  state.customContext = $('custom-context').value.trim();
  startSession();
};

/* ============================================================
   CHAT / CONVERSATION
   ============================================================ */
function systemPrompt() {
  const c = CATEGORIES[state.category];
  const mod = MODULES[state.module];
  const workProfile = state.category === 'work'
    ? `The learner works in the Strategic Investment team of Foxconn's E Group. Their job: source targets, open partnership conversations, and interview potential companies/partners across ${state.domain}. In Medical CDMO, key customers include Medtronic and Johnson & Johnson. Play a realistic, knowledgeable counterpart (e.g. a startup CEO/CTO, a partner's BD lead, or an industry expert) and use correct industry terminology.`
    : `This is a real-life travel/daily-life situation about "${state.domain}". Play a realistic, friendly counterpart (local, staff, or friend).`;

  const modeLine = state.module === 'ask'
    ? `Focus: the LEARNER should be the one ASKING questions — probing, following up, clarifying, doing due diligence. You answer briefly and give them room to ask the next question. Occasionally nudge them if their questions are too shallow.`
    : `Focus: a MEETING DISCUSSION. Raise a topic or position, invite the learner to state their view, agree/push back, and keep the discussion going so they practise expressing opinions, agreeing, disagreeing and responding to challenges.`;

  const diff = { easy: 'Keep language simple and be patient.', medium: 'Use natural professional English.', hard: 'Be demanding, ask sharp follow-ups, use fast idiomatic English.' }[state.difficulty];

  return `You are an English-speaking-practice partner and coach. ${workProfile}
${modeLine}
Difficulty: ${diff}
${state.customContext ? 'Extra context from the learner: ' + state.customContext : ''}

RULES:
- Stay in character and speak ONLY in English while role-playing.
- Keep each reply short: 2–4 sentences. End most replies with something that invites the learner to speak again.
- RESCUE MODE: If the learner writes in Chinese (they are stuck), STOP role-playing for that turn and become a coach: give 1–2 natural English ways to say what they meant (with a very short note on the nuance/difference), invite them to try saying it aloud, then continue the role-play in English on the next line. Rescue turns are help, not part of their performance.
- Never lecture at length. Be warm and encouraging.
- Begin now with a short opening line that sets the scene and gives the learner a reason to speak.`;
}

function buildContents() {
  return state.turns.map(t => ({
    role: t.role === 'user' ? 'user' : 'model',
    parts: [{ text: t.text }],
  }));
}

const FALLBACK_MODEL = 'gemini-2.5-flash';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function geminiOnce(model, contents, opts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(store.apiKey)}`;
  const body = {
    contents,
    generationConfig: { temperature: opts.temperature ?? 0.85, ...(opts.json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (opts.system) body.system_instruction = { parts: [{ text: opts.system }] };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error('http'); e.status = res.status; e.body = errText; throw e;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('AI 沒有回覆，請再試一次。');
  return text.trim();
}

// Retries transient errors (503/500/429/network) with backoff, then falls back
// to a lighter model if the chosen one stays overloaded.
async function callGemini(contents, opts = {}) {
  const primary = store.model || FALLBACK_MODEL;
  const models = primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await geminiOnce(model, contents, opts);
      } catch (e) {
        lastErr = e;
        const st = e.status;
        if (st === 400 && /API key|API_KEY/i.test(e.body || '')) throw new Error('金鑰無效，請到設定檢查。');
        if (st === 403) throw new Error('金鑰權限不足，或此金鑰未啟用 Gemini API。');
        // transient → wait and retry same model
        if (st === 503 || st === 500 || st === 429 || st === undefined) {
          await sleep((st === 429 ? 1500 : 700) * (attempt + 1));
          continue;
        }
        break; // other error → try next model
      }
    }
    // primary exhausted → loop tries FALLBACK_MODEL next
  }
  const st = lastErr && lastErr.status;
  if (st === 429) throw new Error('已達免費額度上限，請稍後再試。');
  throw new Error('伺服器忙碌中，已自動重試仍失敗，請稍後再試' + (st ? ' (' + st + ')' : ''));
}

function startSession() {
  state.turns = [];
  $('messages').innerHTML = '';
  const c = CATEGORIES[state.category];
  const m = MODULES[state.module];
  state.scenarioBrief = `${c.emoji} ${m.title} · ${state.domain}`;
  $('chat-context').textContent = `${state.scenarioBrief}　|　${DIFFICULTIES.find(d => d.id === state.difficulty).label}`;
  show('chat');
  // kick off with AI opening line
  sendToAI('__START__', true);
}

function addMessage(kind, text) {
  const wrap = el('div', 'msg ' + (kind === 'user' ? 'user' : kind === 'coach' ? 'coach' : 'ai'));
  if (kind === 'coach') { const tag = el('span', 'coach-tag', '🆘 COACH'); wrap.appendChild(tag); }
  wrap.appendChild(document.createTextNode(text));
  if (kind === 'ai' || kind === 'coach') {
    const b = el('button', 'speak-again', '🔊'); b.onclick = () => speak(text); wrap.appendChild(b);
  }
  $('messages').appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function setStatus(txt) {
  const s = $('chat-status');
  if (!txt) { s.hidden = true; return; }
  s.hidden = false; s.innerHTML = `<span class="dots">${txt}</span>`;
  s.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

let busy = false;
async function sendToAI(text, isStart = false) {
  if (busy) return;
  const isChinese = !isStart && hasCJK(text);

  if (!isStart) {
    addMessage('user', text);
    state.turns.push({ role: 'user', kind: isChinese ? 'zh' : 'en', text });
  } else {
    // hidden trigger turn
    state.turns.push({ role: 'user', kind: 'en', text: 'Please begin the session now.' });
  }

  busy = true; setStatus('AI thinking');
  try {
    const reply = await callGemini(buildContents(), { system: systemPrompt() });
    setStatus('');
    const kind = isChinese ? 'coach' : 'ai';
    addMessage(kind, reply);
    state.turns.push({ role: 'ai', kind, text: reply });
    if (store.tts && kind === 'ai') speak(reply);
  } catch (e) {
    setStatus('');
    addMessage('ai', '⚠️ ' + e.message);
  } finally { busy = false; }
}

/* ---------- Composer ---------- */
const textInput = $('text-input');
textInput.addEventListener('input', () => { textInput.style.height = 'auto'; textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px'; });
function sendTyped() {
  const t = textInput.value.trim();
  if (!t) return;
  textInput.value = ''; textInput.style.height = 'auto';
  sendToAI(t);
}
$('btn-send').onclick = sendTyped;
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTyped(); } });
$('btn-end').onclick = endSession;

/* ---------- Speech recognition ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recActive = false;
function startRecognition(lang, btn) {
  if (!SR) { alert('此瀏覽器不支援語音辨識，請直接打字。\n(Android Chrome 支援度最佳)'); return; }
  if (recActive) { recog && recog.stop(); return; }
  recog = new SR();
  recog.lang = lang; recog.interimResults = true; recog.continuous = false; recog.maxAlternatives = 1;
  let finalText = '';
  recActive = true; btn.classList.add('listening');
  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const tr = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += tr; else interim += tr;
    }
    textInput.value = (finalText + interim).trim();
  };
  recog.onerror = () => {};
  recog.onend = () => {
    recActive = false; btn.classList.remove('listening');
    const t = textInput.value.trim();
    if (t) { textInput.value = ''; textInput.style.height = 'auto'; sendToAI(t); }
  };
  recog.start();
}
$('btn-mic-en').onclick = function () { startRecognition('en-US', this); };
$('btn-mic-zh').onclick = function () { startRecognition('zh-TW', this); };

/* ---------- Text to speech ---------- */
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 1.0; u.pitch = 1.0;
  speechSynthesis.speak(u);
}

/* ============================================================
   FEEDBACK
   ============================================================ */
async function endSession() {
  const englishTurns = state.turns.filter(t => t.role === 'user' && t.kind === 'en');
  if (englishTurns.length === 0) {
    if (!confirm('這次還沒有任何英文發言，確定要結束嗎？')) return;
    show('home'); return;
  }
  if (recActive && recog) recog.stop();
  speechSynthesis && speechSynthesis.cancel();

  show('feedback');
  $('feedback-content').innerHTML = '<div class="chat-status" style="padding:40px 0"><span class="dots">Analysing your English</span></div>';

  const transcript = state.turns
    .filter(t => !(t.role === 'user' && t.text === 'Please begin the session now.'))
    .map(t => {
      const who = t.role === 'user' ? (t.kind === 'zh' ? 'LEARNER (Chinese rescue — IGNORE for scoring)' : 'LEARNER (English)') : 'PARTNER';
      return `${who}: ${t.text}`;
    }).join('\n');

  const fbPrompt = `You are a strict but encouraging English speaking coach. Below is a transcript of a role-play. Evaluate ONLY the lines marked "LEARNER (English)". Completely ignore lines marked "Chinese rescue" and the PARTNER lines (those are the AI). Give ALL feedback in English.

Scenario: ${state.scenarioBrief}.

Return ONLY JSON with this exact shape:
{
  "overallScore": <integer 0-100>,
  "summary": "<2-3 sentence overall summary>",
  "fluency": { "fillerWords": <integer count of um/uh/like/you know across learner english>, "notes": "<1-2 sentences on pace, hesitation, sentence length>" },
  "corrections": [ { "original": "<learner's phrase>", "improved": "<corrected>", "why": "<short reason>" } ],
  "naturalPhrasing": [ { "original": "<understandable but awkward>", "better": "<how a native pro would say it>" } ],
  "vocabulary": [ "<useful word/phrase they could have used>" ],
  "patterns": [ "<a reusable sentence pattern for this scenario>" ],
  "tips": [ "<actionable tip>" ]
}
Keep corrections to the 3-6 most useful. If the learner spoke very little, say so in the summary and score accordingly.

TRANSCRIPT:
${transcript}`;

  try {
    const raw = await callGemini([{ role: 'user', parts: [{ text: fbPrompt }] }], { json: true, temperature: 0.4 });
    const fb = JSON.parse(raw);
    renderFeedback(fb);
    saveHistory(fb);
  } catch (e) {
    $('feedback-content').innerHTML = `<div class="fb-block"><h3>Could not generate feedback</h3><p>${e.message}</p></div>`;
  }
}

function renderFeedback(fb) {
  const c = $('feedback-content');
  c.innerHTML = '';

  const score = el('div', 'fb-score');
  score.innerHTML = `<div class="num">${fb.overallScore ?? '–'}</div><div class="label">Overall Score</div>`;
  c.appendChild(score);

  if (fb.summary) c.appendChild(block('Summary', p(fb.summary)));

  if (fb.fluency) {
    const f = el('div');
    f.appendChild(p(`Filler words counted: <b>${fb.fluency.fillerWords ?? 0}</b>`, true));
    if (fb.fluency.notes) f.appendChild(p(fb.fluency.notes));
    c.appendChild(block('Fluency', f));
  }

  if (fb.corrections?.length) {
    const d = el('div');
    fb.corrections.forEach(x => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="was">${esc(x.original)}</span> → <span class="now">${esc(x.improved)}</span><span class="why">${esc(x.why || '')}</span>`;
      d.appendChild(row);
    });
    c.appendChild(block('Grammar & Word Choice', d));
  }

  if (fb.naturalPhrasing?.length) {
    const d = el('div');
    fb.naturalPhrasing.forEach(x => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="was">${esc(x.original)}</span> → <span class="now">${esc(x.better)}</span>`;
      d.appendChild(row);
    });
    c.appendChild(block('More Natural Phrasing', d));
  }

  if (fb.vocabulary?.length) c.appendChild(block('Useful Vocabulary', chips(fb.vocabulary)));
  if (fb.patterns?.length) { const ul = list(fb.patterns); c.appendChild(block('Sentence Patterns', ul)); }
  if (fb.tips?.length) c.appendChild(block('Actionable Tips', list(fb.tips)));
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
function block(title, node) { const b = el('div', 'fb-block'); b.appendChild(el('h3', null, title)); b.appendChild(node); return b; }
function p(html, isHtml) { const e = el('p'); e.style.margin = '0 0 6px'; e.style.fontSize = '14px'; e.style.lineHeight = '1.55'; if (isHtml) e.innerHTML = html; else e.textContent = html; return e; }
function list(arr) { const ul = el('ul'); arr.forEach(x => ul.appendChild(el('li', null, x))); return ul; }
function chips(arr) { const d = el('div'); arr.forEach(x => d.appendChild(el('span', 'chip', x))); return d; }

$('btn-practice-again').onclick = () => startSession();
$('btn-home').onclick = () => { show('home'); };

/* ============================================================
   HISTORY
   ============================================================ */
function saveHistory(fb) {
  const now = Date.now();
  const h = store.history;
  h.unshift({
    id: 's_' + now + '_' + Math.random().toString(36).slice(2, 7),
    ts: now,
    updatedAt: now,
    brief: state.scenarioBrief,
    difficulty: state.difficulty,
    score: fb.overallScore,
    fb,
  });
  store.history = h.slice(0, 500);
  if (syncEnabled()) syncNow(true);
}
function renderHistory() {
  const list = $('history-list');
  const h = store.history;
  if (!h.length) { list.innerHTML = '<div class="empty">還沒有練習紀錄，快去開始第一場吧！</div>'; return; }
  list.innerHTML = '';
  h.forEach((item) => {
    const d = el('div', 'hist-item');
    const date = new Date(item.ts).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    d.innerHTML = `<div class="top"><span class="title">${item.brief}</span><span class="score">${item.score ?? '–'}</span></div><div class="meta">${date}</div>`;
    d.onclick = () => { state.scenarioBrief = item.brief; renderFeedback(item.fb); $('btn-practice-again').style.display = 'none'; show('feedback'); setTimeout(() => { $('btn-practice-again').style.display = ''; }, 50); };
    list.appendChild(d);
  });
}

/* ============================================================
   SETTINGS
   ============================================================ */
function loadSettings() {
  $('apikey-input').value = store.apiKey;
  $('model-select').value = store.model;
  $('tts-toggle').checked = store.tts;
  const c = getSync();
  $('sync-repo').value = c ? `${c.owner}/${c.repo}` : '';
  $('sync-token').value = c ? c.token : '';
}
$('btn-save-settings').onclick = () => {
  store.apiKey = $('apikey-input').value.trim();
  store.model = $('model-select').value;
  store.tts = $('tts-toggle').checked;
  // cloud sync config
  const repo = $('sync-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const token = $('sync-token').value.trim();
  if (repo && token && repo.includes('/')) {
    const [owner, name] = repo.split('/');
    setSync({ owner: owner.trim(), repo: name.trim(), path: 'sessions.json', token });
  } else if (!repo && !token) {
    setSync(null);
  }
  $('settings-saved').hidden = false;
  setTimeout(() => { $('settings-saved').hidden = true; }, 1500);
  renderHome();
  if (syncEnabled()) syncNow(false);
};
$('btn-clear-history').onclick = () => {
  if (confirm('確定要清除所有練習紀錄嗎？此動作無法復原。')) {
    const now = Date.now(); const d = getDeleted();
    for (const s of store.history) { if (s.id) { d.ids.push(s.id); d.at[s.id] = now; } }
    setDeleted(d);
    store.history = [];
    renderHistory();
    if (syncEnabled()) syncNow(true);
  }
};

/* ============================================================
   CLOUD SYNC  (GitHub-as-database — same pattern as DD meeting-notes)
   Practice sessions are stored as sessions.json in a PRIVATE repo.
   Any device with the same token reads/writes the same file → sync.
   Tombstones let deletions propagate across devices.
   ============================================================ */
const SYNC_KEY = 'sp_sync';
const DEL_KEY = 'sp_deleted';
function getSync() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch { return null; } }
function setSync(c) { if (c) localStorage.setItem(SYNC_KEY, JSON.stringify(c)); else localStorage.removeItem(SYNC_KEY); }
function syncEnabled() { const c = getSync(); return !!(c && c.token && c.owner && c.repo); }
function getDeleted() { try { return JSON.parse(localStorage.getItem(DEL_KEY)) || { ids: [], at: {} }; } catch { return { ids: [], at: {} }; } }
function setDeleted(d) { localStorage.setItem(DEL_KEY, JSON.stringify(d)); }

// UTF-8 safe base64 (handles Chinese + large files)
function b64e(str) { const b = new TextEncoder().encode(str); let s = ''; const ch = 0x8000; for (let i = 0; i < b.length; i += ch) s += String.fromCharCode.apply(null, b.subarray(i, i + ch)); return btoa(s); }
function b64d(x) { const bin = atob(String(x).replace(/\s/g, '')); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new TextDecoder().decode(b); }
function ghUrl(c) { return `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${c.path || 'sessions.json'}`; }
function ghHead(c) { return { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }; }

async function cloudPull() {
  const c = getSync(); if (!c) throw new Error('尚未設定同步');
  const res = await fetch(ghUrl(c), { headers: ghHead(c) });
  if (res.status === 404) return { doc: { sessions: [], deleted: [], deletedAt: {} }, sha: null };
  if (res.status === 401) throw new Error('GitHub Token 無效或已過期');
  if (res.status === 403) throw new Error('Token 權限不足（需 Contents 讀寫）');
  if (!res.ok) throw new Error('雲端讀取失敗 (' + res.status + ')');
  const data = await res.json();
  let raw;
  if (data.content && data.encoding === 'base64') raw = b64d(data.content);
  else { const r = await fetch(ghUrl(c), { headers: { ...ghHead(c), Accept: 'application/vnd.github.raw+json' } }); if (!r.ok) throw new Error('雲端讀取失敗 (raw ' + r.status + ')'); raw = await r.text(); }
  let doc; try { doc = JSON.parse(raw); } catch { throw new Error('雲端資料解析失敗，為保護資料已中止同步'); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sessions)) throw new Error('雲端資料格式異常，已中止同步');
  doc.sessions = doc.sessions || []; doc.deleted = doc.deleted || []; doc.deletedAt = doc.deletedAt || {};
  return { doc, sha: data.sha };
}
async function cloudPush(doc, sha) {
  const c = getSync(); if (!c) throw new Error('尚未設定同步');
  const body = { message: `update sessions (${new Date().toISOString()})`, content: b64e(JSON.stringify(doc, null, 2)) };
  if (sha) body.sha = sha;
  const res = await fetch(ghUrl(c), { method: 'PUT', headers: ghHead(c), body: JSON.stringify(body) });
  if (res.status === 409) throw new Error('CONFLICT');
  if (res.status === 401) throw new Error('GitHub Token 無效或已過期');
  if (!res.ok) throw new Error('雲端寫入失敗 (' + res.status + ')');
  return res.json();
}

const TOMB_TTL = 180 * 24 * 3600 * 1000;
function mergeTomb(a, b, now) { const t = { ...((a && a.at) || {}), ...((b && b.at) || {}) }; const all = new Set([...((a && a.ids) || []), ...((b && b.ids) || [])]); const ids = []; const at = {}; for (const id of all) { const x = t[id]; if (x && now - x > TOMB_TTL) continue; ids.push(id); if (x) at[id] = x; } return { ids, at }; }
function mergeSessions(A, B, now = Date.now()) {
  A = A || { sessions: [], deleted: [], deletedAt: {} }; B = B || { sessions: [], deleted: [], deletedAt: {} };
  const tomb = mergeTomb({ ids: A.deleted, at: A.deletedAt }, { ids: B.deleted, at: B.deletedAt }, now);
  const del = new Set(tomb.ids); const byId = new Map();
  for (const s of [...(A.sessions || []), ...(B.sessions || [])]) {
    if (!s || !s.id || del.has(s.id)) continue;
    const prev = byId.get(s.id);
    if (!prev || (s.updatedAt || s.ts || 0) >= (prev.updatedAt || prev.ts || 0)) byId.set(s.id, s);
  }
  const sessions = Array.from(byId.values()).sort((x, y) => (y.ts || 0) - (x.ts || 0));
  return { sessions, deleted: tomb.ids, deletedAt: tomb.at };
}

function localDoc() { const d = getDeleted(); return { sessions: store.history, deleted: d.ids, deletedAt: d.at }; }
function applyDoc(doc) { store.history = (doc.sessions || []).slice(0, 500); setDeleted({ ids: doc.deleted || [], at: doc.deletedAt || {} }); }
function setSyncStatus(t) { const e = $('sync-status'); if (e) e.textContent = t; }

let syncing = false;
async function syncNow(silent) {
  if (!syncEnabled()) { if (!silent) setSyncStatus('尚未設定同步'); return; }
  if (syncing) return; syncing = true;
  if (!silent) setSyncStatus('同步中…');
  try {
    const { doc: cloud, sha } = await cloudPull();
    const merged = mergeSessions(localDoc(), cloud);
    applyDoc(merged);
    try { await cloudPush(merged, sha); }
    catch (e) {
      if (e.message === 'CONFLICT') { const again = await cloudPull(); const m2 = mergeSessions(localDoc(), again.doc); applyDoc(m2); await cloudPush(m2, again.sha); }
      else throw e;
    }
    setSyncStatus('已同步 ✓ ' + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
    if ($('screen-history').classList.contains('active')) renderHistory();
  } catch (e) { setSyncStatus('⚠️ ' + e.message); }
  finally { syncing = false; }
}
$('btn-sync-now').onclick = () => syncNow(false);

/* ============================================================
   INIT
   ============================================================ */
renderHome();
loadSettings();
show('home', false);
state.screenStack = ['home'];
if (syncEnabled()) syncNow(true);

/* ---------- About / force-update (like DD meeting-notes) ---------- */
const APP_VERSION = 'v6';

(function initAbout() {
  const ver = document.getElementById('app-version');
  if (ver) ver.textContent = APP_VERSION;

  const btn = document.getElementById('btn-force-update');
  const status = document.getElementById('update-status');
  if (!btn) return;

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '更新中…';
    if (status) status.textContent = '正在清除快取並抓取最新版…';
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {}
    // cache-bust the reload so the browser cannot serve a stale index.html
    location.replace(location.pathname + '?v=' + Date.now());
  };
})();

/* ---------- PWA update banner (like DD meeting-notes) ---------- */
function showUpdateBar(reg) {
  let bar = document.getElementById('update-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.innerHTML = '<span>🎉 有新版本可用</span><button id="update-btn">立即更新</button>';
    document.body.appendChild(bar);
    document.getElementById('update-btn').onclick = () => {
      document.getElementById('update-btn').textContent = '更新中…';
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      else location.reload();
    };
  }
  bar.hidden = false;
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(reg);
        });
      });
      // check for a new version whenever the app regains focus + every 60s
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      setInterval(() => reg.update().catch(() => {}), 60000);
    } catch (e) {}
  });
  // reload once the new SW takes control (after user taps 更新)
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return; refreshing = true; location.reload();
  });
}
