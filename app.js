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
  voice: 'sp_voice',
  rate:  'sp_rate',
};
const store = {
  get apiKey() { return localStorage.getItem(LS.key) || ''; },
  set apiKey(v){ localStorage.setItem(LS.key, v); },
  // No hard-coded default that can be retired out from under us — an alias
  // that always points at a current model, until discovery replaces it.
  get model()  { return localStorage.getItem(LS.model) || 'gemini-flash-latest'; },
  set model(v) { localStorage.setItem(LS.model, v); },
  get tts()    { return localStorage.getItem(LS.tts) !== 'off'; },
  set tts(v)   { localStorage.setItem(LS.tts, v ? 'on' : 'off'); },
  get voice()  { return localStorage.getItem(LS.voice) || ''; },
  set voice(v) { localStorage.setItem(LS.voice, v || ''); },
  get rate()   { const r = parseFloat(localStorage.getItem(LS.rate)); return r >= 0.5 && r <= 1.5 ? r : 0.95; },
  set rate(v)  { localStorage.setItem(LS.rate, String(v)); },
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

/* ---------- Practice stages (document-based sessions) ---------- */
const STAGES = [
  { id: 'opening',    zh: '開場白',     en: 'Opening',
    goal: 'The learner opens the meeting: greet, introduce themselves and their purpose, set an agenda, and hand over.' },
  { id: 'questions',  zh: '提問',       en: 'Asking Questions',
    goal: 'The learner probes and asks questions about the material — clarifying, digging into risks, numbers, technology and business model.' },
  { id: 'discussion', zh: '討論與建議', en: 'Discussion & Suggestions',
    goal: 'The learner states views, agrees/pushes back, and offers concrete suggestions or next steps.' },
  { id: 'summary',    zh: '總結',       en: 'Wrap-up & Summary',
    goal: 'The learner summarises what was covered, confirms decisions and action items, and closes the meeting.' },
];

/* ---------- App state ---------- */
const state = {
  mode: 'classic',    // 'classic' | 'doc'
  category: null,
  module: 'ask',
  domain: null,
  difficulty: 'medium',
  customContext: '',
  scenarioBrief: '',
  turns: [],          // { role:'user'|'ai', kind:'en'|'zh'|'coach'|'ai', text, stage }
  screenStack: [],
  // document-based practice
  source: null,       // { kind:'file'|'url'|'text', name, mime, b64|fileUri|url|text }
  article: null,      // AI-generated scenario package
  stageIndex: 0,
};

/* ---------- Element helpers ---------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hasCJK = (s) => /[㐀-龿]/.test(s);

/* ---------- Screen navigation ---------- */
const SCREENS = ['home','scenario','source','article','review','chat','feedback','history','settings'];
function show(name, push = true) {
  SCREENS.forEach(s => $('screen-' + s).classList.toggle('active', s === name));
  if (push && state.screenStack[state.screenStack.length - 1] !== name) state.screenStack.push(name);
  const onHome = name === 'home';
  $('btn-back').hidden = onHome;
  $('btn-settings').hidden = name === 'settings' || name === 'chat';
  window.scrollTo(0, 0);
}
function currentScreen() {
  const active = SCREENS.find(s => $('screen-' + s).classList.contains('active'));
  return active || 'home';
}

/* Reloading for an update drops you back on the home screen, which is
   disorienting when you triggered it from Settings. Remember where you were
   (per-tab, so it never leaks into a later visit) and return there. */
const RETURN_KEY = 'sp_return_screen';
function rememberScreen() {
  try { sessionStorage.setItem(RETURN_KEY, currentScreen()); } catch {}
}
function restoreScreen() {
  let name = null;
  try { name = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); } catch {}
  if (!name || name === 'home' || !SCREENS.includes(name)) return false;
  // Chat/feedback state does not survive a reload — only restore static screens.
  if (['chat','feedback','article'].includes(name)) return false;
  show(name, false);
  state.screenStack = ['home', name];
  return true;
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
  state.mode = 'classic';
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
  if (state.mode === 'doc') return docSystemPrompt();
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- Model discovery ----------
   Hard-coding a model name goes stale: Google retires models, and a newly
   issued key may simply not be entitled to one that used to work
   ("no longer available to new users"). Ask the key what it can actually
   run, and keep the answer. */
const MODEL_LIST_KEY = 'sp_models';
const LAST_RESORT_MODEL = 'gemini-flash-latest';

const BAD_MODEL_KEY = 'sp_bad_models';

function cachedModels() {
  try { const v = JSON.parse(localStorage.getItem(MODEL_LIST_KEY)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function setCachedModels(list) {
  try { localStorage.setItem(MODEL_LIST_KEY, JSON.stringify(list)); } catch {}
}

/* ListModels advertises models this key cannot actually call — it happily
   lists gemini-2.5-flash and then answers "no longer available to new users".
   Remember what really failed so we stop offering it. */
function badModels() {
  try { const v = JSON.parse(localStorage.getItem(BAD_MODEL_KEY)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function markBadModel(name) {
  if (!name) return;
  const b = badModels();
  if (b.includes(name)) return;
  b.push(name);
  try { localStorage.setItem(BAD_MODEL_KEY, JSON.stringify(b)); } catch {}
}
const isBadModel = (n) => badModels().includes(n);
const usableModels = (list) => (list || []).filter(m => !isBadModel(m));

async function fetchModels(key) {
  const res = await fetch(`${GEN_BASE}/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    let msg = ''; const body = await res.text().catch(() => '');
    try { msg = JSON.parse(body)?.error?.message || ''; } catch { msg = body.slice(0, 200); }
    throw new Error(`無法取得模型清單 (${res.status})${msg ? '：' + msg : ''}`);
  }
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
}

// Favour a current, general-purpose flash model: fast and cheap enough for
// back-and-forth practice, while still handling PDFs and audio.
function rankModel(name) {
  let s = 0;
  if (/flash/.test(name)) s += 100;
  if (/lite/.test(name)) s -= 25;
  if (/preview|exp|thinking|tts|image|embedding|vision/.test(name)) s -= 60;
  if (/latest/.test(name)) s += 5;
  const v = parseFloat((name.match(/gemini-([0-9]+(?:\.[0-9]+)?)/) || [])[1] || 0);
  s += v * 10;
  return s;
}
const bestModel = (list) =>
  [...usableModels(list)].sort((a, b) => rankModel(b) - rankModel(a))[0] || '';

function fallbackModel() {
  return bestModel(cachedModels()) || LAST_RESORT_MODEL;
}

function populateModelSelect(list, selected) {
  const sel = $('model-select');
  if (!sel || !list?.length) return;
  sel.innerHTML = '';
  const best = bestModel(list);
  list.sort((a, b) => rankModel(b) - rankModel(a)).forEach(m => {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m + (m === best ? '（推薦）' : '');
    sel.appendChild(o);
  });
  sel.value = list.includes(selected) ? selected : best;
}

// Refresh the list from Google; returns the models it can actually run.
async function refreshModels(key) {
  const list = await fetchModels(key || store.apiKey);
  setCachedModels(list);
  // Being listed is not the same as being callable, so a model we have seen
  // fail is never kept just because it still shows up here.
  const good = usableModels(list);
  const keep = (good.includes(store.model) && !isBadModel(store.model)) ? store.model : bestModel(list);
  if (keep && keep !== store.model) store.model = keep;
  populateModelSelect(good.length ? good : list, store.model);
  return list;
}

async function geminiOnce(model, contents, opts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(store.apiKey)}`;
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.85,
      // The scenario package and the review are long; the default ceiling
      // truncates them mid-JSON.
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (opts.system) body.system_instruction = { parts: [{ text: opts.system }] };
  if (opts.tools) body.tools = opts.tools;

  // Without a deadline a stalled request just spins forever with no way to
  // tell a slow answer from a dead one.
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 120000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const e = new Error(`等待超過 ${Math.round(timeoutMs / 1000)} 秒仍沒有回應，已中止。文件很長時可試著縮短內容再來一次。`);
      e.fatal = true;
      throw e;
    }
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error('http');
    e.status = res.status;
    e.body = errText;
    e.model = model;
    // Google explains itself in the body — surface it instead of a bare code.
    try { e.detail = JSON.parse(errText)?.error?.message || ''; } catch { e.detail = errText.slice(0, 300); }
    throw e;
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  // Thinking models return their reasoning as extra parts flagged thought:true.
  // Concatenating those corrupts the answer — take only the real output.
  const text = (cand?.content?.parts || [])
    .filter(p => p && p.thought !== true && typeof p.text === 'string')
    .map(p => p.text).join('') || '';

  const finish = cand?.finishReason;
  if (finish === 'MAX_TOKENS') {
    const e = new Error('AI 的回覆太長被截斷了。請把文件或貼上的文字縮短一些再試。');
    e.fatal = true; throw e;
  }
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') {
    const e = new Error('內容被 Gemini 的安全機制擋下，請換一份材料試試。');
    e.fatal = true; throw e;
  }
  if (!text) throw new Error('AI 沒有回覆，請再試一次。');
  return text.trim();
}

// Retries transient errors (503/500/429/network) with backoff, then falls back
// to a lighter model if the chosen one stays overloaded.
async function callGemini(contents, opts = {}) {
  const primary = store.model || fallbackModel();
  // Line up several alternatives: when a model is simply overloaded, moving
  // to the next-best one beats hammering the busy one and giving up.
  const ranked = [...usableModels(cachedModels())].sort((a, b) => rankModel(b) - rankModel(a));
  const models = [...new Set([primary, ...ranked, LAST_RESORT_MODEL])]
    .filter(m => m && !isBadModel(m))
    .slice(0, 4);
  let lastErr;
  let rediscovered = false;
  const queue = [...models];

  while (queue.length) {
    const model = queue.shift();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const reply = await geminiOnce(model, contents, opts);
        // Persist a switch only when the previous choice is genuinely dead —
        // a model that was merely busy should not be demoted permanently.
        if (model !== store.model && isBadModel(store.model)) {
          store.model = model;
          populateModelSelect(cachedModels(), model);
        }
        return reply;
      } catch (e) {
        lastErr = e;
        const st = e.status;
        if (st === 400 && /API key|API_KEY/i.test(e.body || '')) throw new Error('金鑰無效，請到設定檢查。');
        if (st === 403) throw new Error('金鑰權限不足，或此金鑰未啟用 Gemini API。');
        if (e.fatal) throw e;   // timeout / truncated / blocked: retrying won't help
        // transient → back off, then retry the same model before moving on
        if (st === 503 || st === 500 || st === 429 || st === undefined) {
          await sleep((st === 429 ? 2000 : 1200) * (attempt + 1));
          continue;
        }
        break; // other error → try next model
      }
    }
    // A 404 means this model is gone or was never available to this key.
    // Record it so it is never chosen again, then try the best of what is left.
    if (lastErr?.status === 404) {
      markBadModel(model);
      if (!rediscovered) {
        rediscovered = true;
        try {
          const list = await refreshModels();
          const next = bestModel(list);
          if (next && !models.includes(next)) queue.push(next);
        } catch {}
      } else {
        const next = bestModel(cachedModels());
        if (next && next !== model && !models.includes(next)) queue.push(next);
      }
    }
  }

  const st = lastErr && lastErr.status;
  const detail = (lastErr && lastErr.detail) ? '：' + lastErr.detail : '';
  if (st === 429) throw new Error('已達免費額度上限，請稍後再試。' + detail);
  if (st === 404) {
    throw new Error(
      `找不到可用的模型（試過：${models.join('、')}）。` +
      `請到 ⚙ 設定按「測試金鑰與模型」查看你的金鑰支援哪些模型${detail}`);
  }
  if (st === 400) throw new Error('請求被拒絕' + (detail || '：請確認檔案格式與大小。'));
  if (st === 503) {
    throw new Error(
      `Google 目前很忙（已依序試過 ${models.length} 個模型都塞車）。` +
      `這是暫時性的，過幾分鐘再試通常就好了${detail}`);
  }
  throw new Error('伺服器忙碌中，已自動重試仍失敗，請稍後再試' + (st ? ' (' + st + ')' : '') + detail);
}

function startSession() {
  state.mode = 'classic';
  state.turns = [];
  $('messages').innerHTML = '';
  renderStageBar();
  updateStageButton();
  const c = CATEGORIES[state.category];
  const m = MODULES[state.module];
  state.scenarioBrief = `${c.emoji} ${m.title} · ${state.domain}`;
  $('chat-context').textContent = `${state.scenarioBrief}　|　${DIFFICULTIES.find(d => d.id === state.difficulty).label}`;
  show('chat');
  // kick off with AI opening line
  sendToAI('__START__', true);
}

function addMessage(kind, text) {
  if (kind === 'stage') {
    const d = el('div', 'stage-divider', text);
    $('messages').appendChild(d);
    d.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return;
  }
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

  const stage = state.mode === 'doc' ? state.stageIndex : null;

  if (!isStart) {
    addMessage('user', text);
    state.turns.push({ role: 'user', kind: isChinese ? 'zh' : 'en', text, stage });
  } else {
    // hidden trigger turn
    const trigger = state.mode === 'doc'
      ? `Begin the "${STAGES[state.stageIndex].en}" stage now.`
      : 'Please begin the session now.';
    state.turns.push({ role: 'user', kind: 'en', text: trigger, stage, hidden: true });
  }

  busy = true; setStatus('AI thinking');
  try {
    const reply = await callGemini(buildContents(), { system: systemPrompt() });
    setStatus('');
    const kind = isChinese ? 'coach' : 'ai';
    addMessage(kind, reply);
    state.turns.push({ role: 'ai', kind, text: reply, stage });
    if (store.tts && kind === 'ai') speak(reply);
  } catch (e) {
    setStatus('');
    addMessage('ai', '⚠️ ' + e.message);
  } finally { busy = false; }
}

/* ============================================================
   FILES → GEMINI
   Small files ride along inline (base64). Anything bigger — meeting
   recordings especially — goes through the resumable Files API, which
   also gives Gemini time to transcode audio before we ask about it.
   ============================================================ */
const INLINE_LIMIT = 15 * 1024 * 1024;   // stay well under the ~20MB request cap
const GEN_BASE = 'https://generativelanguage.googleapis.com';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('讀取檔案失敗'));
    r.readAsDataURL(file);
  });
}

// Guess a mime type Gemini accepts when the browser gives us nothing useful.
function mimeFor(file) {
  if (file.type) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/csv',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
    ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4',
  }[ext] || 'application/octet-stream';
}

async function uploadViaFilesAPI(file, onProgress) {
  const key = encodeURIComponent(store.apiKey);
  const mime = mimeFor(file);
  onProgress && onProgress('上傳中… 0%');

  const start = await fetch(`${GEN_BASE}/upload/v1beta/files?key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!start.ok) throw new Error('上傳初始化失敗 (' + start.status + ')');
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error(
      `這個檔案有 ${MB(file.size)}，需要走大檔上傳，但瀏覽器讀不到 Google 的上傳網址。` +
      '請改用小於 15 MB 的檔案，或先把錄音轉成逐字稿再貼上。');
  }

  onProgress && onProgress('上傳中… 檔案傳輸');
  // Content-Length is a forbidden header in fetch — the browser sets it.
  const put = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
    body: file,
  });
  if (!put.ok) throw new Error('上傳失敗 (' + put.status + ')');
  const info = await put.json();
  let f = info.file;
  if (!f || !f.uri) throw new Error('上傳失敗：伺服器沒有回傳檔案位置');

  // Audio/video needs server-side processing before it can be referenced.
  for (let i = 0; i < 60 && f.state === 'PROCESSING'; i++) {
    onProgress && onProgress('Gemini 處理錄音中… (' + (i * 3) + 's)');
    await sleep(3000);
    const r = await fetch(`${GEN_BASE}/v1beta/${f.name}?key=${key}`);
    if (!r.ok) break;
    f = await r.json();
  }
  if (f.state === 'FAILED') throw new Error('Gemini 無法處理這個檔案，請換一種格式試試。');
  return { fileUri: f.uri, mime };
}

// Turn a picked file into a Gemini `parts` entry, choosing inline vs Files API.
async function filePartFor(file, onProgress) {
  const mime = mimeFor(file);
  if (file.size <= INLINE_LIMIT) {
    onProgress && onProgress('讀取檔案中…');
    return { inline_data: { mime_type: mime, data: await fileToBase64(file) } };
  }
  const { fileUri } = await uploadViaFilesAPI(file, onProgress);
  return { file_data: { mime_type: mime, file_uri: fileUri } };
}

const MB = (n) => (n / 1048576).toFixed(1) + ' MB';

/* A silent status line is indistinguishable from a hung one. Count the
   seconds so waiting always looks alive. */
function startTicker(setText, label) {
  const t0 = Date.now();
  const tick = () => setText(`${label}（已等待 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

// Gemini can't always be pinned to responseMimeType=json (notably when a tool
// like url_context is enabled), so accept fenced or chatty replies too.
function parseJson(raw) {
  const s = String(raw).trim();
  try { return JSON.parse(s); } catch {}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  // Show what actually came back — "unparseable" alone is undebuggable.
  const peek = s.slice(0, 160).replace(/\s+/g, ' ');
  throw new Error(`AI 回覆的格式無法解析，請再試一次。（AI 開頭回了：${peek || '（空白）'}）`);
}

/* ============================================================
   FEATURE A — PRACTISE FROM A DOCUMENT / URL
   ============================================================ */
let sourceKind = 'file';
let pickedSourceFile = null;

function initSourceScreen() {
  state.source = null;
  pickedSourceFile = null;
  sourceKind = 'file';
  $('source-file').value = '';
  $('source-url').value = '';
  $('source-text').value = '';
  $('source-goal').value = '';
  $('source-picked').textContent = '';
  $('source-status').textContent = '';

  const tabs = [
    { id: 'file', label: '📎 上傳檔案' },
    { id: 'url',  label: '🔗 網址' },
    { id: 'text', label: '📝 貼上文字' },
  ];
  const row = $('source-tabs'); row.innerHTML = '';
  tabs.forEach(t => {
    const p = el('button', 'pill' + (t.id === 'file' ? ' active' : ''), t.label);
    p.onclick = () => {
      sourceKind = t.id;
      [...row.children].forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      ['file','url','text'].forEach(k => { $('source-pane-' + k).hidden = k !== t.id; });
      // A leftover "已選擇：foo.pdf" under the text tab reads as if that file
      // is still being used.
      if (t.id !== 'file') $('source-picked').textContent = '';
      else if (pickedSourceFile) $('source-picked').textContent = `已選擇：${pickedSourceFile.name}（${MB(pickedSourceFile.size)}）`;
      $('source-status').textContent = '';
    };
    row.appendChild(p);
  });

  const fr = $('source-difficulty-row'); fr.innerHTML = '';
  state.difficulty = 'medium';
  DIFFICULTIES.forEach(d => {
    const p = el('button', 'pill' + (d.id === 'medium' ? ' active' : ''), d.label);
    p.onclick = () => { state.difficulty = d.id; [...fr.children].forEach(x => x.classList.remove('active')); p.classList.add('active'); };
    fr.appendChild(p);
  });

  show('source');
}

$('source-file').onchange = function () {
  pickedSourceFile = this.files[0] || null;
  $('source-picked').textContent = pickedSourceFile
    ? `已選擇：${pickedSourceFile.name}（${MB(pickedSourceFile.size)}）`
    : '';
};

const SCENARIO_SHAPE = `{
  "title": "<short English title of the scenario>",
  "titleZh": "<same title in Traditional Chinese>",
  "summaryZh": "<3-4 sentences in Traditional Chinese explaining what this document is about, so the learner grasps it fast>",
  "article": "<a 250-400 word English briefing article written for the learner to read aloud-ready: the situation, the company/topic, the key facts and numbers, and what is at stake>",
  "keyPoints": ["<key fact or number worth referencing in the meeting>"],
  "glossary": [ { "term": "<English term from the material>", "zh": "<short Traditional Chinese gloss>" } ],
  "yourRole": "<one sentence: who the learner is in this meeting and what they want>",
  "counterpartRole": "<one sentence: who the AI will play>",
  "openingHints": ["<English phrase useful for opening this specific meeting>"],
  "questionIdeas": ["<a sharp question worth asking about THIS material>"]
}`;

async function generateScenario() {
  if (!store.apiKey) { alert('請先到「設定」貼上 Gemini API 金鑰。'); show('settings'); return; }

  const goal = $('source-goal').value.trim();
  const status = (t) => { $('source-status').textContent = t; };
  const parts = [];
  let sourceMeta = null;
  let tools;
  let stopTick = null;

  try {
    if (sourceKind === 'file') {
      if (!pickedSourceFile) { status('⚠️ 請先選擇一個檔案。'); return; }
      $('btn-generate').disabled = true;
      parts.push(await filePartFor(pickedSourceFile, status));
      sourceMeta = { kind: 'file', name: pickedSourceFile.name, size: pickedSourceFile.size };
    } else if (sourceKind === 'url') {
      const u = $('source-url').value.trim();
      if (!u) { status('⚠️ 請先貼上網址。'); return; }
      $('btn-generate').disabled = true;
      tools = [{ url_context: {} }];
      parts.push({ text: `Read this page and use it as the source material: ${u}` });
      sourceMeta = { kind: 'url', name: u };
    } else {
      const t = $('source-text').value.trim();
      if (t.length < 40) { status('⚠️ 貼上的文字太短，請至少貼一段完整內容。'); return; }
      $('btn-generate').disabled = true;
      parts.push({ text: 'Source material:\n\n' + t });
      sourceMeta = { kind: 'text', name: '貼上的文字', chars: t.length };
    }

    parts.push({ text:
`You are preparing an English speaking-practice session built on the source material above.

The learner is a non-native English speaker who works in corporate strategy/investment and needs to run real meetings in English.
${goal ? 'Their stated role and goal for this meeting: ' + goal : 'Assume they are meeting the organisation or people described in the material for the first time.'}
Difficulty: ${state.difficulty}.

Write the briefing article in clear professional English at a level the learner can read comfortably. Keep summaryZh, titleZh and the glossary Chinese in TRADITIONAL Chinese (繁體中文).
Base every fact on the source material — do not invent numbers.

Return ONLY JSON with this exact shape:
${SCENARIO_SHAPE}` });

    stopTick = startTicker(status, 'AI 閱讀中，正在生成情境…');
    // url_context and forced JSON output don't reliably coexist — when a tool
    // is in play, ask for JSON in the prompt and parse leniently instead.
    const raw = await callGemini([{ role: 'user', parts }], { json: !tools, temperature: 0.5, tools });
    stopTick(); stopTick = null;
    const pkg = parseJson(raw);

    state.mode = 'doc';
    state.source = sourceMeta;
    state.article = pkg;
    state.stageIndex = 0;
    state.customContext = goal;
    status('');
    renderArticle();
    show('article');
  } catch (e) {
    status('⚠️ ' + e.message);
  } finally {
    if (stopTick) stopTick();
    $('btn-generate').disabled = false;
  }
}

function renderArticle() {
  const a = state.article, c = $('article-content');
  c.innerHTML = '';

  const head = el('div', 'fb-block');
  head.appendChild(el('h3', null, a.titleZh || a.title || '情境'));
  if (a.title && a.titleZh) head.appendChild(p(a.title));
  if (a.summaryZh) head.appendChild(p(a.summaryZh));
  c.appendChild(head);

  const roles = el('div');
  if (a.yourRole) roles.appendChild(p(`<b>你的角色：</b>${esc(a.yourRole)}`, true));
  if (a.counterpartRole) roles.appendChild(p(`<b>AI 扮演：</b>${esc(a.counterpartRole)}`, true));
  c.appendChild(block('角色設定 · Roles', roles));

  if (a.article) {
    const art = el('div', 'article-body');
    String(a.article).split(/\n{2,}/).forEach(para => art.appendChild(p(para)));
    const sp = el('button', 'speak-again', '🔊 朗讀全文');
    sp.style.position = 'static';
    sp.onclick = () => speak(a.article);
    art.appendChild(sp);
    c.appendChild(block('Briefing', art));
  }

  if (a.keyPoints?.length) c.appendChild(block('Key Points', list(a.keyPoints)));
  if (a.glossary?.length) {
    const d = el('div');
    a.glossary.forEach(g => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="now">${esc(g.term)}</span><span class="why">${esc(g.zh || '')}</span>`;
      d.appendChild(row);
    });
    c.appendChild(block('Glossary 詞彙', d));
  }
  if (a.openingHints?.length) c.appendChild(block('Opening Phrases 開場可用句', list(a.openingHints)));
  if (a.questionIdeas?.length) c.appendChild(block('Questions Worth Asking 值得問的問題', list(a.questionIdeas)));

  const note = el('div', 'fb-block');
  note.appendChild(el('h3', null, '接下來 · What happens next'));
  note.appendChild(p('讀完後按下方按鈕，會依序練習四個關卡：開場白 → 提問 → 討論與建議 → 總結。每一關結束按「下一關」，最後給總回饋。'));
  c.appendChild(note);
}

function docSystemPrompt() {
  const a = state.article || {};
  const st = STAGES[state.stageIndex] || STAGES[0];
  const diff = { easy: 'Keep language simple and be patient.', medium: 'Use natural professional English.', hard: 'Be demanding, ask sharp follow-ups, use fast idiomatic English.' }[state.difficulty];

  return `You are role-playing a business meeting with an English learner, based on material they have just read.

MATERIAL (the learner has read this):
${a.article || ''}
Key points: ${(a.keyPoints || []).join(' | ')}

YOUR CHARACTER: ${a.counterpartRole || 'the learner\'s counterpart in this meeting'}
THE LEARNER: ${a.yourRole || 'a strategy/investment professional'}
${state.customContext ? 'Their stated goal: ' + state.customContext : ''}
Difficulty: ${diff}

CURRENT STAGE — "${st.en}" (${st.zh}):
${st.goal}

RULES:
- Stay in character and speak ONLY in English while role-playing.
- Keep each reply short: 2-4 sentences, and end most replies in a way that invites the learner to speak again.
- Stay inside the CURRENT STAGE. Do not race ahead to later parts of the meeting; the learner advances stages themselves.
- Draw on the material: reference real details from it so the learner must engage with the content.
- If the learner's contribution for this stage is thin, nudge them once with a concrete prompt rather than moving on.
- RESCUE MODE: If the learner writes in Chinese (they are stuck), stop role-playing for that turn and coach: give 1-2 natural English ways to say what they meant with a short note on nuance, invite them to try it aloud, then resume the role-play in English on the next line. Rescue turns are help, not performance.
- Begin the CURRENT STAGE now with one short line that hands the floor to the learner.`;
}

function renderStageBar() {
  const bar = $('stage-bar');
  if (state.mode !== 'doc') { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  STAGES.forEach((s, i) => {
    const cls = i < state.stageIndex ? 'done' : i === state.stageIndex ? 'current' : '';
    bar.appendChild(el('span', 'stage-chip ' + cls, `${i + 1}. ${s.zh}`));
  });
}

function startStagedSession() {
  state.mode = 'doc';
  state.turns = [];
  state.stageIndex = 0;
  $('messages').innerHTML = '';
  const a = state.article || {};
  state.scenarioBrief = `📄 ${a.titleZh || a.title || '文件情境'}`;
  $('chat-context').textContent = `${state.scenarioBrief}　|　${DIFFICULTIES.find(d => d.id === state.difficulty).label}`;
  renderStageBar();
  updateStageButton();
  show('chat');
  sendToAI('__START__', true);
}

function updateStageButton() {
  const btn = $('btn-next-stage');
  if (!btn) return;
  if (state.mode !== 'doc') { btn.hidden = true; return; }
  btn.hidden = false;
  const last = state.stageIndex >= STAGES.length - 1;
  btn.textContent = last ? '完成 · Finish' : `下一關：${STAGES[state.stageIndex + 1].zh} ▶`;
}

function nextStage() {
  if (busy) return;
  if (state.stageIndex >= STAGES.length - 1) { endSession(); return; }
  const spoke = state.turns.some(t => t.role === 'user' && t.kind === 'en' && !t.hidden && t.stage === state.stageIndex);
  if (!spoke && !confirm(`這一關（${STAGES[state.stageIndex].zh}）還沒有任何英文發言，確定要跳過嗎？`)) return;
  state.stageIndex++;
  renderStageBar();
  updateStageButton();
  const st = STAGES[state.stageIndex];
  addMessage('stage', `── ${state.stageIndex + 1}. ${st.zh} · ${st.en} ──`);
  sendToAI('__START__', true);
}

/* ============================================================
   FEATURE B — REVIEW A REAL MEETING (recording or transcript)
   ============================================================ */
let reviewKind = 'file';
let pickedReviewFile = null;

function initReviewScreen() {
  reviewKind = 'file';
  pickedReviewFile = null;
  $('review-file').value = '';
  $('review-text').value = '';
  $('review-context').value = '';
  $('review-picked').textContent = '';
  $('review-status').textContent = '';

  const tabs = [{ id: 'file', label: '🎙 錄音／檔案' }, { id: 'text', label: '📝 貼上逐字稿' }];
  const row = $('review-tabs'); row.innerHTML = '';
  tabs.forEach(t => {
    const p = el('button', 'pill' + (t.id === 'file' ? ' active' : ''), t.label);
    p.onclick = () => {
      reviewKind = t.id;
      [...row.children].forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      ['file','text'].forEach(k => { $('review-pane-' + k).hidden = k !== t.id; });
    };
    row.appendChild(p);
  });

  show('review');
}

$('review-file').onchange = function () {
  pickedReviewFile = this.files[0] || null;
  if (!pickedReviewFile) { $('review-picked').textContent = ''; return; }
  const big = pickedReviewFile.size > INLINE_LIMIT;
  $('review-picked').textContent =
    `已選擇：${pickedReviewFile.name}（${MB(pickedReviewFile.size)}）` +
    (big ? ' — 檔案較大，會自動分段上傳並等 Gemini 處理，請耐心等候。' : '');
};

const REVIEW_SHAPE = `{
  "overallScore": <integer 0-100>,
  "summaryZh": "<3-4 sentences in Traditional Chinese: what this meeting was, how the learner did overall, and the single most valuable thing to fix>",
  "meetingSummary": "<3-5 sentence English summary of what was actually discussed>",
  "english": {
    "score": <integer 0-100>,
    "notes": "<2-3 sentences on fluency, pace, hesitation, filler words>",
    "fillerWords": <integer, -1 if it cannot be judged from a transcript>,
    "corrections": [ { "original": "<what the learner said>", "improved": "<corrected>", "why": "<short reason>" } ],
    "naturalPhrasing": [ { "original": "<understandable but awkward>", "better": "<how a native professional would say it>" } ]
  },
  "questioning": {
    "score": <integer 0-100>,
    "notes": "<2-3 sentences judging the DEPTH of their questions: surface-level vs probing, did they follow up, did they test claims, did they chase numbers and evidence>",
    "missedOpportunities": [ { "moment": "<what the counterpart said that deserved a follow-up>", "shouldHaveAsked": "<the follow-up question they should have asked>", "why": "<what it would have revealed>" } ],
    "betterQuestions": [ { "instead": "<a shallow question they asked>", "ask": "<a sharper version>" } ]
  },
  "structure": {
    "score": <integer 0-100>,
    "notes": "<2-3 sentences on their thinking and questioning ARCHITECTURE: did they have a logical progression, did they cover the ground systematically, did they control the meeting>",
    "coverage": [ { "area": "<area a professional should have covered, e.g. technology moat / unit economics / team / go-to-market>", "covered": <true|false>, "comment": "<short>" } ],
    "suggestedFramework": ["<ordered step of a questioning framework they should use next time>"]
  },
  "actionPlan": ["<concrete thing to practise before the next real meeting>"]
}`;

async function runReview() {
  if (!store.apiKey) { alert('請先到「設定」貼上 Gemini API 金鑰。'); show('settings'); return; }

  const status = (t) => { $('review-status').textContent = t; };
  const ctx = $('review-context').value.trim();
  const parts = [];
  let meta = null;
  let stopTick = null;

  try {
    if (reviewKind === 'file') {
      if (!pickedReviewFile) { status('⚠️ 請先選擇錄音檔或逐字稿。'); return; }
      $('btn-review-start').disabled = true;
      parts.push(await filePartFor(pickedReviewFile, status));
      meta = { kind: 'file', name: pickedReviewFile.name, size: pickedReviewFile.size };
    } else {
      const t = $('review-text').value.trim();
      if (t.length < 80) { status('⚠️ 逐字稿太短，請貼上完整一點的內容。'); return; }
      $('btn-review-start').disabled = true;
      parts.push({ text: 'MEETING TRANSCRIPT:\n\n' + t });
      meta = { kind: 'text', name: '貼上的逐字稿', chars: t.length };
    }

    parts.push({ text:
`Above is a real business meeting the learner took part in — either an audio recording or a transcript.

The learner is a non-native English speaker working in corporate strategy and investment. They source targets, open partnership conversations, and interview potential companies and partners. They want to improve on TWO fronts:
  1. their English, and
  2. far more importantly, the DEPTH of their questions and the STRUCTURE of their thinking — whether they probed properly, tested claims, chased evidence and numbers, followed up instead of moving on, and worked through the meeting in a logical order.
${ctx ? 'Context they gave: ' + ctx : ''}

If this is audio, identify which speaker is the learner (the non-native speaker doing the interviewing/probing; the context above may help) and evaluate only that person's contributions.
Be genuinely critical — they want to get better, not be flattered. Ground every point in something specific that was actually said. If the recording is unclear or too short to judge an area, say so in that section's notes rather than inventing findings.

Write summaryZh in TRADITIONAL Chinese (繁體中文). Everything else in English.

Return ONLY JSON with this exact shape:
${REVIEW_SHAPE}` });

    stopTick = startTicker(status, 'AI 分析中…（錄音較長時需要數分鐘）');
    const raw = await callGemini([{ role: 'user', parts }], { json: true, temperature: 0.35, timeoutMs: 300000 });
    stopTick(); stopTick = null;
    const rv = parseJson(raw);
    status('');
    renderReview(rv);
    saveReviewHistory(rv, meta);
    show('feedback');
  } catch (e) {
    status('⚠️ ' + e.message);
  } finally {
    if (stopTick) stopTick();
    $('btn-review-start').disabled = false;
  }
}

function scoreRow(label, value) {
  const d = el('div', 'sub-score');
  d.innerHTML = `<span class="lbl">${esc(label)}</span><span class="val">${value ?? '–'}</span>`;
  return d;
}

function renderReview(rv) {
  const c = $('feedback-content');
  c.innerHTML = '';
  $('btn-practice-again').style.display = 'none';

  const score = el('div', 'fb-score');
  score.innerHTML = `<div class="num">${rv.overallScore ?? '–'}</div><div class="label">Overall</div>`;
  c.appendChild(score);

  const subs = el('div', 'sub-scores');
  subs.appendChild(scoreRow('英文 English', rv.english?.score));
  subs.appendChild(scoreRow('提問深度 Questioning', rv.questioning?.score));
  subs.appendChild(scoreRow('思考架構 Structure', rv.structure?.score));
  c.appendChild(subs);

  if (rv.summaryZh) c.appendChild(block('總評 · Summary', p(rv.summaryZh)));
  if (rv.meetingSummary) c.appendChild(block('這場會議談了什麼', p(rv.meetingSummary)));

  // --- English ---
  const en = rv.english || {};
  if (en.notes || en.corrections?.length || en.naturalPhrasing?.length) {
    const d = el('div');
    if (en.notes) d.appendChild(p(en.notes));
    if (typeof en.fillerWords === 'number' && en.fillerWords >= 0) d.appendChild(p(`Filler words: <b>${en.fillerWords}</b>`, true));
    (en.corrections || []).forEach(x => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="was">${esc(x.original)}</span> → <span class="now">${esc(x.improved)}</span><span class="why">${esc(x.why || '')}</span>`;
      d.appendChild(row);
    });
    (en.naturalPhrasing || []).forEach(x => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="was">${esc(x.original)}</span> → <span class="now">${esc(x.better)}</span>`;
      d.appendChild(row);
    });
    c.appendChild(block('English 英文表達', d));
  }

  // --- Questioning depth ---
  const q = rv.questioning || {};
  if (q.notes || q.missedOpportunities?.length || q.betterQuestions?.length) {
    const d = el('div');
    if (q.notes) d.appendChild(p(q.notes));
    if (q.missedOpportunities?.length) {
      d.appendChild(el('h4', 'sub-h', '錯過的追問點 · Missed follow-ups'));
      q.missedOpportunities.forEach(m => {
        const row = el('div', 'miss-item');
        row.innerHTML =
          `<div class="moment">「${esc(m.moment)}」</div>` +
          `<div class="ask">→ ${esc(m.shouldHaveAsked)}</div>` +
          (m.why ? `<div class="why">${esc(m.why)}</div>` : '');
        d.appendChild(row);
      });
    }
    if (q.betterQuestions?.length) {
      d.appendChild(el('h4', 'sub-h', '同樣的問題，問得更利 · Sharper versions'));
      q.betterQuestions.forEach(b => {
        const row = el('div', 'fb-correction');
        row.innerHTML = `<span class="was">${esc(b.instead)}</span> → <span class="now">${esc(b.ask)}</span>`;
        d.appendChild(row);
      });
    }
    c.appendChild(block('提問深度 · Questioning Depth', d));
  }

  // --- Thinking structure ---
  const s = rv.structure || {};
  if (s.notes || s.coverage?.length || s.suggestedFramework?.length) {
    const d = el('div');
    if (s.notes) d.appendChild(p(s.notes));
    if (s.coverage?.length) {
      d.appendChild(el('h4', 'sub-h', '涵蓋面 · Coverage'));
      s.coverage.forEach(x => {
        const row = el('div', 'cover-item' + (x.covered ? ' yes' : ' no'));
        row.innerHTML = `<span class="mark">${x.covered ? '✓' : '✗'}</span><span class="area">${esc(x.area)}</span>` +
                        (x.comment ? `<span class="why">${esc(x.comment)}</span>` : '');
        d.appendChild(row);
      });
    }
    if (s.suggestedFramework?.length) {
      d.appendChild(el('h4', 'sub-h', '下次可用的提問架構 · Framework'));
      const ol = el('ol');
      s.suggestedFramework.forEach(x => ol.appendChild(el('li', null, x)));
      d.appendChild(ol);
    }
    c.appendChild(block('思考與提問架構 · Structure', d));
  }

  if (rv.actionPlan?.length) c.appendChild(block('下次會議前要練的 · Action Plan', list(rv.actionPlan)));
}

function saveReviewHistory(rv, meta) {
  const now = Date.now();
  const h = store.history;
  h.unshift({
    id: 'r_' + now + '_' + Math.random().toString(36).slice(2, 7),
    ts: now,
    updatedAt: now,
    type: 'review',
    brief: `🎧 會議檢討 · ${meta?.name || ''}`,
    score: rv.overallScore,
    source: meta,
    review: rv,
  });
  store.history = h.slice(0, 500);
  if (syncEnabled()) syncNow(true);
}

/* ---------- Wiring for the new screens ---------- */
$('card-doc').onclick = () => initSourceScreen();
$('card-review').onclick = () => initReviewScreen();
$('btn-generate').onclick = () => generateScenario();
$('btn-start-stages').onclick = () => startStagedSession();
$('btn-article-back').onclick = () => initSourceScreen();
$('btn-review-start').onclick = () => runReview();

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
$('btn-next-stage').onclick = nextStage;

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
/* ---------- Voice selection ----------
   A machine usually carries several English voices of wildly different
   quality, and the default is often the oldest one. Prefer the neural
   voices when they exist. */
function englishVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang || ''));
}
function rankVoice(v) {
  const n = (v.name || '');
  let s = 0;
  if (/natural|neural/i.test(n)) s += 100;   // Microsoft/Edge neural voices
  if (/google/i.test(n)) s += 60;            // Chrome's bundled Google voices
  if (/online/i.test(n)) s += 20;
  if (/david|zira|mark|hazel/i.test(n)) s -= 40;  // legacy SAPI voices
  if (/^en[-_]US/i.test(v.lang)) s += 15;
  if (v.localService) s += 3;                // no network hiccup mid-sentence
  return s;
}
function bestVoice() {
  const list = englishVoices();
  if (!list.length) return null;
  const saved = store.voice;
  return list.find(v => v.name === saved) ||
         [...list].sort((a, b) => rankVoice(b) - rankVoice(a))[0];
}

function populateVoiceSelect() {
  const sel = $('voice-select');
  if (!sel) return;
  const list = englishVoices();
  if (!list.length) return;
  const best = bestVoice();
  sel.innerHTML = '';
  [...list].sort((a, b) => rankVoice(b) - rankVoice(a)).forEach(v => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name}（${v.lang}）` + (best && v.name === best.name ? ' ⭐' : '');
    sel.appendChild(o);
  });
  sel.value = (store.voice && list.some(v => v.name === store.voice)) ? store.voice : (best ? best.name : '');
}

if ('speechSynthesis' in window) {
  // The list is populated asynchronously, and may arrive after first paint.
  speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);
  setTimeout(populateVoiceSelect, 300);
}

/* Splitting on every "." put breaks inside decimals ("gemini-3.5") and after
   abbreviations ("e.g.", "Inc."), and each false break became an audible pause
   in the middle of a phrase. Only break where a sentence genuinely ends. */
const ABBREV = /(?:^|[\s("'])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|approx|inc|ltd|corp|co|dept|fig|no|vol|est|al|e\.g|i\.e|u\.s|u\.k)\.$/i;

function splitSentences(text) {
  const out = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (!/[.!?…]/.test(ch)) continue;
    const prev = text[i - 1] || '';
    const next = text[i + 1] || '';
    if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue;  // 3.5
    if (ABBREV.test(cur)) continue;                                   // e.g.
    if (/[.!?…"')\]]/.test(next)) continue;                           // ?!  ."
    if (next && !/\s/.test(next)) continue;                           // mid-token
    out.push(cur.trim());
    cur = '';
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const voice = bestVoice();

  // Paragraph breaks are real pauses; keep them, and group sentences into
  // large chunks so the gaps between utterances land only where a speaker
  // would actually breathe.
  const queue = [];
  String(text).split(/\n{2,}/).forEach(para => {
    const clean = para.replace(/[ \t]+/g, ' ').trim();
    if (!clean) return;
    let buf = '';
    splitSentences(clean).forEach(s => {
      if (buf && (buf + ' ' + s).length > 320) { queue.push(buf); buf = s; }
      else buf = buf ? buf + ' ' + s : s;
    });
    if (buf) queue.push(buf);
  });

  const rate = store.rate;
  for (const q of (queue.length ? queue : [String(text).trim()])) {
    const u = new SpeechSynthesisUtterance(q);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-US'; }
    u.rate = rate; u.pitch = 1.0;
    speechSynthesis.speak(u);
  }
}

/* ============================================================
   FEEDBACK
   ============================================================ */
async function endSession() {
  const englishTurns = state.turns.filter(t => t.role === 'user' && t.kind === 'en' && !t.hidden);
  if (englishTurns.length === 0) {
    if (!confirm('這次還沒有任何英文發言，確定要結束嗎？')) return;
    show('home'); return;
  }
  if (recActive && recog) recog.stop();
  speechSynthesis && speechSynthesis.cancel();

  show('feedback');
  $('feedback-content').innerHTML = '<div class="chat-status" style="padding:40px 0"><span class="dots">Analysing your English</span></div>';

  const transcript = state.turns
    .filter(t => !t.hidden && t.text !== 'Please begin the session now.')
    .map(t => {
      const who = t.role === 'user' ? (t.kind === 'zh' ? 'LEARNER (Chinese rescue — IGNORE for scoring)' : 'LEARNER (English)') : 'PARTNER';
      const tag = (state.mode === 'doc' && t.stage != null) ? `[${STAGES[t.stage].en}] ` : '';
      return `${tag}${who}: ${t.text}`;
    }).join('\n');

  if (state.mode === 'doc') { await endDocSession(transcript); return; }

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
    const fb = parseJson(raw);
    renderFeedback(fb);
    saveHistory(fb);
  } catch (e) {
    $('feedback-content').innerHTML = `<div class="fb-block"><h3>Could not generate feedback</h3><p>${e.message}</p></div>`;
  }
}

/* Document-based sessions get the same English feedback plus per-stage scores
   and a read on how deeply they questioned the material. */
async function endDocSession(transcript) {
  const a = state.article || {};
  const prompt = `You are a strict but encouraging coach for business English AND for interviewing/questioning skill.

Below is a transcript of a role-played meeting. It is split into stages: ${STAGES.map(s => s.en).join(' → ')}.
Evaluate ONLY the lines marked "LEARNER (English)". Ignore "Chinese rescue" lines and PARTNER lines.

The learner had read this material beforehand:
${a.article || ''}
Key points: ${(a.keyPoints || []).join(' | ')}

Judge not just their English but whether they actually engaged with the material — did they use its facts and numbers, probe the claims in it, and follow up rather than move on?
Give ALL feedback in English except summaryZh.

Return ONLY JSON with this exact shape:
{
  "overallScore": <integer 0-100>,
  "summary": "<2-3 sentence overall summary in English>",
  "summaryZh": "<2-3 sentences in Traditional Chinese: how they did and the one thing to fix first>",
  "stages": [ { "stage": "<one of: ${STAGES.map(s => s.en).join(' | ')}>", "score": <0-100>, "notes": "<1-2 sentences>", "betterVersion": "<a stronger way they could have delivered this stage, in English>" } ],
  "fluency": { "fillerWords": <integer>, "notes": "<1-2 sentences on pace, hesitation, sentence length>" },
  "corrections": [ { "original": "<learner's phrase>", "improved": "<corrected>", "why": "<short reason>" } ],
  "naturalPhrasing": [ { "original": "<awkward>", "better": "<how a native pro would say it>" } ],
  "questioning": { "score": <0-100>, "notes": "<2-3 sentences on the DEPTH of their questions>", "betterQuestions": [ { "instead": "<a shallow question they asked>", "ask": "<a sharper version grounded in the material>" } ] },
  "vocabulary": [ "<useful word/phrase from this material they should own>" ],
  "patterns": [ "<a reusable sentence pattern for this kind of meeting>" ],
  "tips": [ "<actionable tip>" ]
}
Include one entry in "stages" for every stage the learner actually reached. If they said very little in a stage, score it low and say so.

TRANSCRIPT:
${transcript}`;

  try {
    const raw = await callGemini([{ role: 'user', parts: [{ text: prompt }] }], { json: true, temperature: 0.4 });
    const fb = parseJson(raw);
    renderFeedback(fb);
    saveHistory(fb);
  } catch (e) {
    $('feedback-content').innerHTML = `<div class="fb-block"><h3>Could not generate feedback</h3><p>${esc(e.message)}</p></div>`;
  }
}

function renderFeedback(fb) {
  const c = $('feedback-content');
  c.innerHTML = '';
  $('btn-practice-again').style.display = '';

  const score = el('div', 'fb-score');
  score.innerHTML = `<div class="num">${fb.overallScore ?? '–'}</div><div class="label">Overall Score</div>`;
  c.appendChild(score);

  if (fb.summary || fb.summaryZh) {
    const d = el('div');
    if (fb.summaryZh) d.appendChild(p(fb.summaryZh));
    if (fb.summary) d.appendChild(p(fb.summary));
    c.appendChild(block('Summary', d));
  }

  if (fb.stages?.length) {
    const d = el('div');
    fb.stages.forEach((s, i) => {
      const row = el('div', 'stage-result');
      row.innerHTML =
        `<div class="head"><span class="name">${i + 1}. ${esc(s.stage)}</span><span class="val">${s.score ?? '–'}</span></div>` +
        (s.notes ? `<div class="notes">${esc(s.notes)}</div>` : '') +
        (s.betterVersion ? `<div class="better"><b>Stronger:</b> ${esc(s.betterVersion)}</div>` : '');
      d.appendChild(row);
    });
    c.appendChild(block('每一關 · Stage by Stage', d));
  }

  if (fb.questioning) {
    const d = el('div');
    if (fb.questioning.score != null) d.appendChild(p(`Questioning depth: <b>${fb.questioning.score}</b>/100`, true));
    if (fb.questioning.notes) d.appendChild(p(fb.questioning.notes));
    (fb.questioning.betterQuestions || []).forEach(b => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="was">${esc(b.instead)}</span> → <span class="now">${esc(b.ask)}</span>`;
      d.appendChild(row);
    });
    c.appendChild(block('提問深度 · Questioning Depth', d));
  }

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

$('btn-practice-again').onclick = () =>
  (state.mode === 'doc' && state.article) ? startStagedSession() : startSession();
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
    type: state.mode === 'doc' ? 'doc' : 'classic',
    brief: state.scenarioBrief,
    difficulty: state.difficulty,
    score: fb.overallScore,
    // The learner asked for uploaded material to be kept, so the generated
    // scenario travels with the session (and syncs to their PRIVATE repo).
    source: state.mode === 'doc' ? state.source : null,
    article: state.mode === 'doc' ? state.article : null,
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
    const src = item.source?.name ? `<div class="meta">📎 ${esc(item.source.name)}</div>` : '';
    d.innerHTML = `<div class="top"><span class="title">${esc(item.brief)}</span><span class="score">${item.score ?? '–'}</span></div><div class="meta">${date}</div>${src}`;
    d.onclick = () => {
      state.scenarioBrief = item.brief;
      if (item.type === 'review' && item.review) {
        renderReview(item.review);
      } else if (item.fb) {
        renderFeedback(item.fb);
        $('btn-practice-again').style.display = 'none';
      }
      show('feedback');
    };
    list.appendChild(d);
  });
}

/* ============================================================
   SETTINGS
   ============================================================ */
function loadSettings() {
  $('apikey-input').value = store.apiKey;

  const known = cachedModels();
  if (known.length) populateModelSelect(known, store.model);
  else if (store.model) {
    // Keep whatever was saved selectable even before discovery has run.
    const sel = $('model-select');
    if (![...sel.options].some(o => o.value === store.model)) {
      const o = document.createElement('option');
      o.value = store.model; o.textContent = store.model;
      sel.insertBefore(o, sel.firstChild);
    }
  }
  $('model-select').value = store.model;

  // First run with a key: find out what it can actually run, quietly.
  if (store.apiKey && !known.length) refreshModels().catch(() => {});
  $('tts-toggle').checked = store.tts;
  populateVoiceSelect();
  $('rate-range').value = store.rate;
  $('rate-label').textContent = store.rate.toFixed(2) + '×';
  const c = getSync();
  $('sync-repo').value = c ? `${c.owner}/${c.repo}` : '';
  $('sync-token').value = c ? c.token : '';
}
$('btn-save-settings').onclick = () => {
  const keyChanged = $('apikey-input').value.trim() !== store.apiKey;
  store.apiKey = $('apikey-input').value.trim();
  // A different key may be entitled to a different set of models.
  if (keyChanged && store.apiKey) { setCachedModels([]); refreshModels().catch(() => {}); }
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
/* Voice tuning applies immediately — you judge a voice by hearing it, not by
   saving a form and starting a session. */
$('rate-range').oninput = function () {
  store.rate = parseFloat(this.value);
  $('rate-label').textContent = store.rate.toFixed(2) + '×';
};
$('voice-select').onchange = function () {
  store.voice = this.value;
  speak('Thanks for walking me through the roadmap. Before we go further, could you say more about the 3.5 gigawatt figure, e.g. how much of that is already contracted?');
};
$('btn-voice-test').onclick = () =>
  speak('Thanks for walking me through the roadmap. Before we go further, could you say more about the 3.5 gigawatt figure, e.g. how much of that is already contracted?');

/* Probes each configured model directly so a failure names its own cause
   instead of surfacing as a bare status code somewhere downstream. */
$('btn-test-api').onclick = async () => {
  const out = $('api-test-status');
  const key = $('apikey-input').value.trim() || store.apiKey;
  if (!key) { out.textContent = '⚠️ 尚未填入金鑰。'; return; }

  out.textContent = '測試中…';
  const lines = [];

  // Ask the key what it is entitled to before testing anything.
  let available = [];
  try {
    available = await refreshModels(key);
    lines.push(`這把金鑰列出 ${available.length} 個模型，實際逐一測試：`);
  } catch (e) {
    lines.push('⚠️ ' + e.message);
  }

  const chosen = $('model-select').value || store.model;
  const models = [...new Set([chosen, bestModel(available)].filter(Boolean))];
  let working = '';

  for (const m of models) {
    try {
      const res = await fetch(
        `${GEN_BASE}/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }] }) });
      if (res.ok) { lines.push(`✅ ${m}：可用`); working = working || m; continue; }
      const body = await res.text().catch(() => '');
      let msg = ''; try { msg = JSON.parse(body)?.error?.message || ''; } catch { msg = body.slice(0, 200); }
      // Listed but not callable — never offer it again.
      if (res.status === 404) markBadModel(m);
      lines.push(`❌ ${m}：HTTP ${res.status}${msg ? ' — ' + msg : ''}`);
    } catch (e) {
      lines.push(`❌ ${m}：無法連線 — ${e.message}`);
    }
  }

  if (working) {
    store.model = working;
    populateModelSelect(usableModels(available), working);
    lines.push(`👉 已設定為使用：${working}`);
  } else {
    lines.push('⚠️ 沒有任何模型可用，請確認金鑰是否正確。');
  }
  out.innerHTML = lines.map(esc).join('<br>');
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
restoreScreen();
if (syncEnabled()) syncNow(true);

/* ---------- About / force-update (like DD meeting-notes) ---------- */
const APP_VERSION = 'v16';

(function initAbout() {
  const ver = document.getElementById('app-version');
  if (ver) ver.textContent = APP_VERSION;

  const btn = document.getElementById('btn-force-update');
  const status = document.getElementById('update-status');
  if (!btn) return;

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '更新中…';
    rememberScreen();
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
      // Clearing the SW cache is not enough: index.html would reload fresh but
      // still pull app.js/styles.css out of the browser's own HTTP cache, so the
      // page comes back on the old version. Force-revalidate each asset first.
      if (status) status.textContent = '正在重新下載程式檔…';
      await Promise.all(
        ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest']
          .map((f) => fetch(f + '?v=' + Date.now(), { cache: 'reload' }).catch(() => {}))
      );
    } catch (e) {}
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
      rememberScreen();
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
  // A new worker now claims control as soon as it installs, so this fires on
  // its own — no hard reload needed to escape a stale bundle. Apply it
  // silently, unless doing so would throw away a conversation in progress.
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    const midSession = currentScreen() === 'chat' &&
      state.turns.some(t => t.role === 'user' && !t.hidden);
    if (midSession) {
      // Let them finish; the banner hands them the update when they're ready.
      navigator.serviceWorker.getRegistration().then(reg => reg && showUpdateBar(reg)).catch(() => {});
      return;
    }
    refreshing = true;
    rememberScreen();
    location.reload();
  });
}
