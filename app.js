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
  cards: 'sp_cards',
  keepFull: 'sp_keep_full',
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
  get cards()  { try { const v = JSON.parse(localStorage.getItem(LS.cards)); return Array.isArray(v) ? v : []; } catch { return []; } },
  set cards(v) { localStorage.setItem(LS.cards, JSON.stringify(v)); },
  get keepFull(){ return localStorage.getItem(LS.keepFull) === 'on'; },
  set keepFull(v){ localStorage.setItem(LS.keepFull, v ? 'on' : 'off'); },
};

/* ============================================================
   PHRASE BANK
   A full transcript is dead weight: nobody rereads session 37, and at
   ~9.5KB each they fill localStorage's 5MB inside 500 sessions. What
   compounds is the language itself — harvest that into typed, deduplicated
   cards and keep sessions down to their scores.
   ============================================================ */
const CARD_CATS = {
  intro:    '自我介紹',
  opening:  '開場',
  asking:   '提問',
  probing:  '追問挖深',
  opinion:  '表達意見',
  pushback: '反駁與協商',
  summary:  '總結收尾',
  travel:   '旅遊救命句',
  term:     '專業術語',
  pattern:  '句型與用法',
  other:    '其他',
};

// Leitner-style spacing: a card you remember comes back later each time.
const BOX_DAYS = [0, 1, 3, 7, 21, 60];
const DAY = 86400000;

const cardKey = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

function addCards(items, srcBrief) {
  if (!items?.length) return 0;
  const cards = store.cards;
  const seen = new Set(cards.map(c => cardKey(c.text)));
  const now = Date.now();
  let added = 0;
  items.forEach(it => {
    const text = String(it.text || '').trim();
    if (!text || text.length > 300) return;
    const k = cardKey(text);
    if (!k || seen.has(k)) return;
    seen.add(k);
    cards.push({
      id: 'c_' + now + '_' + Math.random().toString(36).slice(2, 7),
      text, zh: it.zh || '', cat: CARD_CATS[it.cat] ? it.cat : 'other',
      star: !!it.star, ts: now, src: srcBrief || '', box: 1, due: now,
    });
    added++;
  });
  if (added) store.cards = cards.slice(-2000);
  return added;
}

/* Pull the reusable language out of a finished session. */
function harvestCards(s) {
  const out = [];
  const push = (text, cat, zh) => { if (text) out.push({ text: String(text), cat, zh }); };
  const a = s.article || {};
  (a.glossary || []).forEach(g => push(g.term, 'term', g.zh));
  (a.openingHints || []).forEach(t => push(t, 'opening'));
  (a.questionIdeas || []).forEach(t => push(t, 'asking'));
  (a.survivalPhrases || []).forEach(t => push(t, 'travel'));

  const fb = s.fb || {};
  (fb.vocabulary || []).forEach(t => push(t, 'term'));
  (fb.patterns || []).forEach(t => push(t, 'pattern'));
  (fb.naturalPhrasing || []).forEach(x => push(x.better, 'pattern'));
  (fb.corrections || []).forEach(x => push(x.improved, 'pattern'));
  (fb.questioning?.betterQuestions || []).forEach(x => push(x.ask, 'probing'));

  const rv = s.review || {};
  (rv.english?.naturalPhrasing || []).forEach(x => push(x.better, 'pattern'));
  (rv.english?.corrections || []).forEach(x => push(x.improved, 'pattern'));
  (rv.questioning?.betterQuestions || []).forEach(x => push(x.ask, 'probing'));
  (rv.questioning?.missedOpportunities || []).forEach(x => push(x.shouldHaveAsked, 'probing'));

  (s.drills || []).forEach(d => push(d.model, 'probing'));
  return out;
}

/* Keep what the trend needs; drop the prose that will never be reread. */
function slimSession(s) {
  if (store.keepFull) return s;
  const slim = {
    id: s.id, ts: s.ts, updatedAt: s.updatedAt, type: s.type,
    brief: s.brief, score: s.score,
    digest: s.fb?.summaryZh || s.review?.summaryZh || s.article?.summaryZh || '',
  };
  if (s.source?.name) slim.source = { kind: s.source.kind, name: s.source.name };
  if (s.difficulty) slim.difficulty = s.difficulty;
  const ax = {};
  if (s.review?.english?.score != null)     ax.english = s.review.english.score;
  if (s.review?.questioning?.score != null) ax.questioning = s.review.questioning.score;
  if (s.review?.structure?.score != null)   ax.structure = s.review.structure.score;
  if (s.fb?.questioning?.score != null)     ax.questioning = s.fb.questioning.score;
  if (Object.keys(ax).length) slim.axes = ax;
  // Recurring-weakness detection needs the reasons, not the whole correction.
  const why = [
    ...(s.fb?.corrections || []).map(c => c.why),
    ...(s.review?.english?.corrections || []).map(c => c.why),
  ].filter(Boolean).slice(0, 8);
  if (why.length) slim.why = why;
  return slim;
}

// Harvest the language first, then file the slim record.
function fileSession(session) {
  addCards(harvestCards(session), session.brief);
  const h = store.history;
  h.unshift(slimSession(session));
  store.history = h.slice(0, 500);
  if (syncEnabled()) syncNow(true);
}

/* Existing records were stored whole, before any of this existed. */
function migrateHistory() {
  const h = store.history;
  if (!h.length || store.keepFull) return;
  if (!h.some(s => s.article || s.fb || s.review)) return;
  h.forEach(s => addCards(harvestCards(s), s.brief));
  store.history = h.map(slimSession);
}

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
/* A business meeting and buying a train ticket do not have the same shape —
   "wrap up the action items" is meaningless at a restaurant. Each kind of
   session gets stages that match how that conversation actually runs. */
const STAGE_SETS = {
  meeting: [
    { id: 'opening',    zh: '開場白',     en: 'Opening',
      goal: 'The learner opens the meeting: greet, introduce themselves and their purpose, set an agenda, and hand over.' },
    { id: 'questions',  zh: '提問',       en: 'Asking Questions',
      goal: 'The learner probes and asks questions about the material — clarifying, digging into risks, numbers, technology and business model.' },
    { id: 'discussion', zh: '討論與建議', en: 'Discussion & Suggestions',
      goal: 'The learner states views, agrees/pushes back, and offers concrete suggestions or next steps.' },
    { id: 'summary',    zh: '總結',       en: 'Wrap-up & Summary',
      goal: 'The learner summarises what was covered, confirms decisions and action items, and closes the meeting.' },
  ],
  travel: [
    { id: 'request',  zh: '提出需求', en: 'Make your request',
      goal: 'The learner opens politely and states clearly what they need — a room, a table, directions, a ticket.' },
    { id: 'listen',   zh: '聽懂並回應', en: 'Understand and respond',
      goal: 'You give real details fast and naturally (prices, times, options, conditions). The learner must confirm what they heard, ask you to repeat or slow down when unsure, and decide.' },
    { id: 'problem',  zh: '出狀況應變', en: 'Handle a complication',
      goal: 'Introduce a genuine complication — overbooked, sold out, delayed, a surcharge, the wrong order. Do not resolve it for them. Make the learner complain politely, negotiate, or find an alternative.' },
    { id: 'close',    zh: '收尾',     en: 'Close politely',
      goal: 'The learner confirms the final arrangement, checks any remaining detail, thanks you and closes warmly.' },
  ],
};
function stages() { return STAGE_SETS[state.stageSet] || STAGE_SETS.meeting; }

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
  source: null,       // { kind:'file'|'url'|'text'|'work'|'travel', name, ... }
  article: null,      // AI-generated scenario package
  stageIndex: 0,
  stageSet: 'meeting',
  // review → drill loop
  drills: [],
  drillIndex: 0,
  drillResults: [],
};

/* ---------- Element helpers ---------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const hasCJK = (s) => /[㐀-龿]/.test(s);

/* ---------- Screen navigation ---------- */
const SCREENS = ['home','scenario','source','article','live','review','chat','drill','feedback','cards','recall','intro','progress','history','settings'];
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
$('btn-progress').onclick = () => { renderProgress(); show('progress'); };

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

  const isWork = catId === 'work';
  $('custom-context').value = '';
  $('prep-status').textContent = '';
  $('custom-label').textContent = isWork ? '練習對象或主題（選填）· Company or topic' : '想練的具體情況（選填）· The situation';
  $('custom-context').placeholder = isWork
    ? '例：Celestial AI，或「一家做矽光子的美國 A 輪新創，我想評估合作可能」'
    : '例：東京車站要改簽新幹線，或「飯店超賣要換房」';
  $('custom-hint').textContent = isWork
    ? '填了公司名或主題，AI 會據此建構對方與情境；留白則自動生成一個該領域的典型標的。'
    : '填了就照你的情況練；留白則自動挑一個具體場景。';
  // Meeting modules make no sense at a hotel desk.
  $('module-row').parentElement.hidden = !isWork;

  show('scenario');
}

$('btn-start').onclick = () => {
  if (!store.apiKey) { alert('請先到「設定」貼上 Gemini API 金鑰。'); show('settings'); return; }
  state.customContext = $('custom-context').value.trim();
  startSession();
};

/* ---------- Prepared sessions for work / travel ----------
   Being dropped straight into a conversation caps you at the English you
   already have. The document mode works because it hands you the vocabulary,
   the phrases and the questions first — so generate the same package here,
   from a topic or a company name instead of an uploaded file. */
async function generatePreparedScenario() {
  if (!store.apiKey) { alert('請先到「設定」貼上 Gemini API 金鑰。'); show('settings'); return; }

  const isWork = state.category === 'work';
  const target = $('custom-context').value.trim();
  const status = (t) => { $('prep-status').textContent = t; };
  let stopTick = null;

  const workProfile = `The learner works in the Strategic Investment team of a large electronics group. Their job: source targets, open partnership conversations, and interview potential companies and partners across ${state.domain}. In Medical CDMO, key customers include Medtronic and Johnson & Johnson.`;
  const modeLine = state.module === 'ask'
    ? 'The learner will mostly be ASKING questions and doing due diligence.'
    : 'The learner will be taking part in a MEETING DISCUSSION, stating and defending views.';

  const brief = isWork
    ? `Build a realistic business meeting for this learner.
${workProfile}
${modeLine}
Domain: ${state.domain}.
${target ? 'They specifically want to practise this: ' + target + '\nIf that names a real company or technology, use what you know about it and say so accurately; do not invent financials you are unsure of — prefer describing the space and typical figures, and flag anything uncertain.' : 'Invent a plausible, specific counterpart company in this domain — give it a name, a stage, a product and real-sounding numbers.'}`
    : `Build a realistic travel / daily-life situation for this learner.
Situation type: ${state.domain}.
${target ? 'They specifically want to practise this: ' + target : 'Choose a specific, vivid setting — a named city, a real kind of place, a concrete goal.'}
The learner is a Taiwanese professional travelling abroad. Make it practical: things they must actually say and understand.`;

  const shape = isWork ? SCENARIO_SHAPE : TRAVEL_SHAPE;

  try {
    $('btn-prep').disabled = true;
    stopTick = startTicker(status, 'AI 正在準備情境…');
    const raw = await callGemini([{ role: 'user', parts: [{ text:
`${brief}

Difficulty: ${state.difficulty}.
Write the briefing in clear professional English at a level the learner can read comfortably.
Keep summaryZh, titleZh and the Chinese glosses in TRADITIONAL Chinese (繁體中文).

Return ONLY JSON with this exact shape:
${shape}` }] }], { json: true, temperature: 0.75, timeoutMs: 120000 });
    stopTick(); stopTick = null;

    const pkg = parseJson(raw);
    state.mode = 'doc';
    state.stageSet = isWork ? 'meeting' : 'travel';
    state.article = pkg;
    state.stageIndex = 0;
    state.customContext = target;
    state.source = { kind: isWork ? 'work' : 'travel', name: target || state.domain };
    status('');
    renderArticle();
    show('article');
  } catch (e) {
    status('⚠️ ' + e.message);
  } finally {
    if (stopTick) stopTick();
    $('btn-prep').disabled = false;
  }
}
$('btn-prep').onclick = () => generatePreparedScenario();

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
      ? `Begin the "${stages()[state.stageIndex].en}" stage now.`
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
  if (!pickedSourceFile) { $('source-picked').textContent = ''; return; }
  const size = pickedSourceFile.size;
  let note = '';
  if (size > 20 * 1024 * 1024) note = ' — 檔案很大，上傳加閱讀可能要好幾分鐘。若只想練其中一段，抽出需要的頁數會快很多。';
  else if (size > INLINE_LIMIT) note = ' — 檔案較大，會自動分段上傳，請耐心等候。';
  $('source-picked').textContent = `已選擇：${pickedSourceFile.name}（${MB(size)}）${note}`;
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
  "openingHints": ["<English phrase useful for opening this specific meeting — give exactly 5, covering greeting, stating purpose, setting the agenda, handing over, and re-opening after small talk>"],
  "questionIdeas": ["<a sharp question worth asking about THIS material — give exactly 10, ordered from opening probes to harder challenges, and spread across technology, numbers, competition, risks and next steps>"]
}`;

/* Travel needs different scaffolding: not "questions worth asking" but the
   phrases that rescue you when you did not catch what was said. */
const TRAVEL_SHAPE = `{
  "title": "<short English title of the situation>",
  "titleZh": "<same title in Traditional Chinese>",
  "summaryZh": "<3-4 sentences in Traditional Chinese setting the scene: where you are, what you need, what could go wrong>",
  "article": "<a 150-250 word English briefing: the setting, what the learner wants, and the details they will need to handle (times, prices, options)>",
  "keyPoints": ["<a concrete detail the learner must get right, e.g. a time, a price, a condition>"],
  "glossary": [ { "term": "<English word or phrase they will hear here>", "zh": "<short Traditional Chinese gloss>" } ],
  "yourRole": "<one sentence: who the learner is and what they need>",
  "counterpartRole": "<one sentence: who the AI plays — hotel receptionist, station clerk, waiter, local>",
  "openingHints": ["<a natural English phrase for opening this specific situation — give exactly 5>"],
  "survivalPhrases": ["<a phrase for when things go wrong: asking someone to repeat or slow down, confirming you understood, apologising, complaining politely, refusing, asking for an alternative — give exactly 8>"],
  "questionIdeas": ["<a question worth asking in this situation to avoid a nasty surprise — give exactly 6>"]
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
    // A large PDF takes minutes just to read, so the deadline scales with the
    // source rather than cutting off work that is still progressing.
    const big = sourceKind === 'file' && pickedSourceFile && pickedSourceFile.size > 5 * 1024 * 1024;
    const timeoutMs = big ? 600000 : (sourceKind === 'file' ? 300000 : 120000);
    // url_context and forced JSON output don't reliably coexist — when a tool
    // is in play, ask for JSON in the prompt and parse leniently instead.
    const raw = await callGemini([{ role: 'user', parts }], { json: !tools, temperature: 0.5, tools, timeoutMs });
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
  if (a.survivalPhrases?.length) c.appendChild(block('Survival Phrases 救命句', list(a.survivalPhrases)));
  if (a.questionIdeas?.length) c.appendChild(block('Questions Worth Asking 值得問的問題', list(a.questionIdeas)));

  const note = el('div', 'fb-block');
  note.appendChild(el('h3', null, '接下來 · What happens next'));
  note.appendChild(p(`讀完後按下方按鈕，會依序練習四個關卡：${stages().map(s => s.zh).join(' → ')}。` +
    '每一關結束按「下一關」，練習中隨時可按 📄 資料查看這頁內容，最後給總回饋。'));
  c.appendChild(note);
}

/* ---------- Hand the scenario to the Gemini app ----------
   Live voice over the API would burn free-tier quota fast, and the learner
   already pays for Gemini. So export the scenario as a brief they can feed
   to the Gemini app, and take the transcript back afterwards for review. */
function buildLiveBrief() {
  const a = state.article || {};
  const diff = { easy: 'Keep language simple and be patient.', medium: 'Use natural professional English.', hard: 'Be demanding, ask sharp follow-ups, use fast idiomatic English.' }[state.difficulty];

  return `# SpeakPrep — Live Speaking Practice Brief
# ${a.titleZh || a.title || '文件情境練習'}

## 使用方式（給使用者看，Gemini 可略過）
1. 把這份檔案上傳給 Gemini，或整段貼上。
2. 切換到語音 / Live 模式。
3. 說 "Let's start." 開始；說 "Next stage." 進下一關。
4. 卡住時直接講中文，它會給你英文講法再帶回情境。
5. 結束時說 "Give me the full transcript."，把逐字稿貼回 SpeakPrep 的「🎧 檢討真實會議」。

---

## INSTRUCTIONS FOR GEMINI

You are running a spoken English practice session for a non-native speaker who
works in corporate strategy and investment. Follow these instructions exactly and
stay in them for the whole conversation.

YOUR CHARACTER: ${a.counterpartRole || "the learner's counterpart in this meeting"}
THE LEARNER: ${a.yourRole || 'a strategy/investment professional'}
${state.customContext ? 'THEIR GOAL: ' + state.customContext : ''}
DIFFICULTY: ${diff}

### MATERIAL (the learner has already read this)
${a.article || ''}

${(a.keyPoints || []).length ? 'KEY POINTS:\n' + a.keyPoints.map(k => '- ' + k).join('\n') : ''}

${(a.glossary || []).length ? 'GLOSSARY:\n' + a.glossary.map(g => `- ${g.term} — ${g.zh || ''}`).join('\n') : ''}

${(a.survivalPhrases || []).length ? 'SURVIVAL PHRASES the learner has been given:\n' + a.survivalPhrases.map(s => '- ' + s).join('\n') : ''}

### RUN IT IN FOUR STAGES
${stages().map((s, i) => `${i + 1}. ${s.en} — ${s.goal}`).join('\n')}

Stay inside the current stage. Do not advance until the learner says "next stage"
(or clearly wraps that part up). Announce each new stage in one short line.

### RULES
- Speak ONLY English while in character. Keep each turn to 2-4 sentences and end
  in a way that hands the floor back to the learner.
- Draw on the material above: reference its real details and numbers so the
  learner has to engage with the content, and push back when their reasoning is thin.
- If the learner's contribution is shallow, ask one concrete follow-up rather
  than moving on.
- RESCUE MODE: if the learner speaks Chinese, they are stuck. Drop character for
  that turn, give 1-2 natural English ways to say what they meant with a brief note
  on the nuance, invite them to try it aloud, then resume the role-play in English.
  Rescue turns are help, not part of their performance.
- Do not coach or correct mid-conversation otherwise — save it for the transcript.

### WHEN THEY ASK FOR THE TRANSCRIPT
When the learner says "give me the full transcript", output the entire
conversation verbatim, nothing else, one line per turn, in exactly this format:

LEARNER: <what they said>
PARTNER: <what you said>

Mark any Chinese rescue turns as "LEARNER (Chinese):". Do not summarise,
correct or shorten anything — the transcript is fed back into a coaching tool
that scores their English, the depth of their questions, and how well they
structured the meeting.

Begin only when the learner says they are ready.
`;
}

function showLiveBrief() {
  if (!state.article) { alert('請先生成一份情境。'); return; }
  $('live-brief').value = buildLiveBrief();
  $('live-copy-status').textContent = '';

  // Lead with whichever route this device actually supports.
  const canShare = typeof navigator.share === 'function';
  $('btn-live-share').hidden = !canShare;
  $('btn-live-download').className = canShare ? 'ghost-btn' : 'primary-btn';

  show('live');
}

function briefFilename() {
  const a = state.article || {};
  const safe = String(a.titleZh || a.title || 'practice')
    .replace(/[\\/:*?"<>|]/g, '').slice(0, 40).trim() || 'practice';
  return `SpeakPrep 練習指令 - ${safe}.md`;
}

/* On a phone the natural move is the system share sheet — tap once, pick
   Gemini. Desktop browsers mostly lack it, so fall back to downloading. */
async function shareLiveBrief() {
  const text = buildLiveBrief();
  const status = $('live-copy-status');
  try {
    const file = new File([text], briefFilename(), { type: 'text/markdown' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'SpeakPrep 練習指令' });
      status.textContent = '已分享 ✓ 在 Gemini 開啟後，切到語音模式說 "Let\'s start."';
      return;
    }
    if (navigator.share) {
      await navigator.share({ title: 'SpeakPrep 練習指令', text });
      status.textContent = '已分享 ✓ 在 Gemini 貼上後，切到語音模式說 "Let\'s start."';
      return;
    }
    status.textContent = '這個瀏覽器沒有分享功能，已改為下載。';
    downloadLiveBrief();
  } catch (e) {
    if (e && e.name === 'AbortError') return;   // user backed out of the sheet
    status.textContent = '分享失敗，已改為下載：' + (e?.message || '');
    downloadLiveBrief();
  }
}

function downloadLiveBrief() {
  const blob = new Blob([buildLiveBrief()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = briefFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('live-copy-status').textContent = '已下載 ✓ 到 Gemini 上傳這個檔案即可開始。';
}

async function copyLiveBrief() {
  const text = buildLiveBrief();
  try {
    await navigator.clipboard.writeText(text);
    $('live-copy-status').textContent = '已複製 ✓ 到 Gemini 貼上即可開始。';
  } catch {
    // Clipboard permission varies; fall back to selecting the textarea.
    const ta = $('live-brief');
    ta.focus(); ta.select();
    $('live-copy-status').textContent = '請按 Ctrl+C（手機請長按選取）複製下方文字。';
  }
}

function docSystemPrompt() {
  const a = state.article || {};
  const st = stages()[state.stageIndex] || stages()[0];
  const diff = { easy: 'Keep language simple and be patient.', medium: 'Use natural professional English.', hard: 'Be demanding, ask sharp follow-ups, use fast idiomatic English.' }[state.difficulty];

  const kind = state.stageSet === 'travel'
    ? 'a real-life travel/daily-life situation'
    : 'a business meeting';

  return `You are role-playing ${kind} with an English learner, based on material they have just read.

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
- Stay inside the CURRENT STAGE. Do not race ahead; the learner advances stages themselves.
- Draw on the material: reference real details from it so the learner must engage with the content.
${state.stageSet === 'travel'
  ? '- Speak like a real member of staff or local, not a teacher: normal pace, contractions, everyday phrasing. Do not simplify unless they ask you to repeat.\n- Never solve a problem for the learner. If they go quiet, wait or repeat once — make them handle it.'
  : '- Push back when their reasoning is thin, and make them justify a claim rather than accepting it.'}
- If the learner's contribution for this stage is thin, nudge them once with a concrete prompt rather than moving on.
- RESCUE MODE: If the learner writes in Chinese (they are stuck), stop role-playing for that turn and coach: give 1-2 natural English ways to say what they meant with a short note on nuance, invite them to try it aloud, then resume the role-play in English on the next line. Rescue turns are help, not performance.
- Begin the CURRENT STAGE now with one short line that hands the floor to the learner.`;
}

/* Sending the learner into a live conversation with the briefing hidden means
   they lose the phrases and questions exactly when they need them. Keep it all
   one tap away, with the section for the current stage first. */
const STAGE_REF = {
  opening:    ['openingHints', 'keyPoints', 'questionIdeas', 'glossary'],
  questions:  ['questionIdeas', 'keyPoints', 'glossary', 'openingHints'],
  discussion: ['keyPoints', 'questionIdeas', 'glossary', 'openingHints'],
  summary:    ['keyPoints', 'glossary', 'questionIdeas', 'openingHints'],
  // travel
  request:    ['openingHints', 'survivalPhrases', 'glossary', 'keyPoints'],
  listen:     ['survivalPhrases', 'glossary', 'keyPoints', 'questionIdeas'],
  problem:    ['survivalPhrases', 'questionIdeas', 'glossary', 'keyPoints'],
  close:      ['openingHints', 'survivalPhrases', 'glossary', 'keyPoints'],
};
const REF_TITLES = {
  openingHints:    'Opening Phrases 開場可用句',
  questionIdeas:   'Questions Worth Asking 值得問的問題',
  survivalPhrases: 'Survival Phrases 救命句',
  keyPoints:       'Key Points 重點',
  glossary:        'Glossary 詞彙',
};

function renderRefPanel() {
  const a = state.article;
  const body = $('ref-body');
  if (!a || !body) return;
  body.innerHTML = '';

  const stageId = (stages()[state.stageIndex] || stages()[0]).id;
  const order = STAGE_REF[stageId] || STAGE_REF.opening;

  order.forEach((key, i) => {
    const items = a[key];
    if (!items?.length) return;
    const sec = el('div', 'ref-sec' + (i === 0 ? ' now' : ''));
    sec.appendChild(el('h4', null, REF_TITLES[key] + (i === 0 ? '　← 這一關用得到' : '')));
    if (key === 'glossary') {
      items.forEach(g => {
        const r = el('div', 'ref-term');
        r.innerHTML = `<b>${esc(g.term)}</b> — ${esc(g.zh || '')}`;
        sec.appendChild(r);
      });
    } else {
      const ul = el('ul');
      items.forEach(x => ul.appendChild(el('li', null, x)));
      sec.appendChild(ul);
    }
    body.appendChild(sec);
  });

  if (a.article) {
    const sec = el('div', 'ref-sec');
    sec.appendChild(el('h4', null, 'Briefing 原文'));
    String(a.article).split(/\n{2,}/).forEach(t => sec.appendChild(el('p', null, t)));
    body.appendChild(sec);
  }
  body.scrollTop = 0;
}

function toggleRefPanel(open) {
  const panel = $('ref-panel');
  const wantOpen = open ?? panel.hidden;
  if (wantOpen) renderRefPanel();
  panel.hidden = !wantOpen;
  $('btn-ref').classList.toggle('active', wantOpen);
}

function renderStageBar() {
  const bar = $('stage-bar');
  const refBtn = $('btn-ref');
  if (state.mode !== 'doc') {
    bar.hidden = true;
    refBtn.hidden = true;
    $('ref-panel').hidden = true;
    return;
  }
  refBtn.hidden = !state.article;
  bar.hidden = false;
  bar.innerHTML = '';
  stages().forEach((s, i) => {
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
  const icon = { work: '💼', travel: '✈️' }[state.source?.kind] || '📄';
  state.scenarioBrief = `${icon} ${a.titleZh || a.title || '情境練習'}`;
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
  const last = state.stageIndex >= stages().length - 1;
  btn.textContent = last ? '完成 · Finish' : `下一關：${stages()[state.stageIndex + 1].zh} ▶`;
}

function nextStage() {
  if (busy) return;
  if (state.stageIndex >= stages().length - 1) { endSession(); return; }
  const spoke = state.turns.some(t => t.role === 'user' && t.kind === 'en' && !t.hidden && t.stage === state.stageIndex);
  if (!spoke && !confirm(`這一關（${stages()[state.stageIndex].zh}）還沒有任何英文發言，確定要跳過嗎？`)) return;
  state.stageIndex++;
  renderStageBar();
  updateStageButton();
  if (!$('ref-panel').hidden) renderRefPanel();   // resurface what this stage needs
  const st = stages()[state.stageIndex];
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

  // Reading a list of missed follow-ups changes nothing; saying them does.
  const drills = drillsFromReview(rv);
  if (drills.length) {
    const cta = el('div', 'fb-block');
    cta.appendChild(el('h3', null, '🎯 把這些練起來'));
    cta.appendChild(p(`從這場會議挑出 ${drills.length} 個具體片段，讓你當場重講一次，並和更好的版本逐句比對。`));
    const b = el('button', 'primary-btn', `重練這 ${drills.length} 個時刻 ▶`);
    b.onclick = () => startDrills(rv);
    cta.appendChild(b);
    c.appendChild(cta);
  }
}

/* ============================================================
   DRILLS — turn a review's findings back into speaking practice
   A score you cannot act on is a dead end: the missed follow-ups get read
   once and forgotten. Replay each moment and make them say it better.
   ============================================================ */
function drillsFromReview(rv) {
  const out = [];
  (rv?.questioning?.missedOpportunities || []).forEach(m => {
    if (!m?.moment) return;
    out.push({
      kind: 'missed',
      prompt: m.moment,
      target: m.shouldHaveAsked || '',
      why: m.why || '',
      title: '對方這樣說，你當時沒有追問',
    });
  });
  (rv?.questioning?.betterQuestions || []).forEach(b => {
    if (!b?.instead) return;
    out.push({
      kind: 'shallow',
      prompt: b.instead,
      target: b.ask || '',
      why: '',
      title: '這是你問過的問題，把它問得更利',
    });
  });
  (rv?.english?.naturalPhrasing || []).forEach(x => {
    if (!x?.original) return;
    out.push({
      kind: 'phrasing',
      prompt: x.original,
      target: x.better || '',
      why: '',
      title: '這句聽得懂，但不夠道地',
    });
  });
  return out;
}

function startDrills(rv) {
  const drills = drillsFromReview(rv);
  if (!drills.length) { alert('這次檢討沒有可以重練的具體片段。'); return; }
  state.drills = drills;
  state.drillIndex = 0;
  state.drillResults = [];
  renderDrill();
  show('drill');
}

function renderDrill() {
  const d = state.drills[state.drillIndex];
  const body = $('drill-body');
  const bar = $('drill-progress');

  bar.innerHTML = '';
  state.drills.forEach((_, i) => {
    const cls = i < state.drillIndex ? 'done' : i === state.drillIndex ? 'current' : '';
    bar.appendChild(el('span', 'stage-chip ' + cls, String(i + 1)));
  });

  body.innerHTML = '';
  if (!d) { renderDrillSummary(); return; }

  const head = el('div', 'fb-block');
  head.appendChild(el('h3', null, `第 ${state.drillIndex + 1} / ${state.drills.length} 題 — ${d.title}`));

  const q = el('div', 'drill-prompt');
  q.textContent = d.kind === 'missed' ? `「${d.prompt}」` : d.prompt;
  head.appendChild(q);
  if (d.kind === 'missed') head.appendChild(p('現在換你 —— 你會怎麼追問？'));
  else if (d.kind === 'shallow') head.appendChild(p('重問一次，問得更具體、更難迴避。'));
  else head.appendChild(p('用更自然的說法重講一次。'));
  if (d.why) head.appendChild(p('（追問到位能挖出：' + d.why + '）'));
  body.appendChild(head);

  $('drill-input').value = '';
  $('drill-composer').hidden = false;
  $('drill-mic').hidden = false;
  window.scrollTo(0, 0);
}

let drillBusy = false;
async function submitDrill() {
  if (drillBusy) return;
  const d = state.drills[state.drillIndex];
  const said = $('drill-input').value.trim();
  if (!d || !said) return;

  drillBusy = true;
  const body = $('drill-body');
  const wait = el('div', 'chat-status');
  wait.innerHTML = '<span class="dots">Checking</span>';
  body.appendChild(wait);

  const ctx = d.kind === 'missed'
    ? `The counterpart said: "${d.prompt}"\nThe learner's follow-up attempt: "${said}"\nA model follow-up would be: "${d.target}"`
    : `The learner originally said: "${d.prompt}"\nTheir new attempt: "${said}"\nA stronger version would be: "${d.target}"`;

  try {
    const raw = await callGemini([{ role: 'user', parts: [{ text:
`You are coaching a non-native English speaker who works in strategy and investment.

${ctx}

Judge their NEW attempt only. Be specific and honest — say so if it is still weak.
Return ONLY JSON:
{
  "score": <integer 0-100>,
  "verdict": "<one short English sentence on whether this attempt does the job>",
  "goodBits": ["<something concrete they got right, if any>"],
  "fixes": [ { "was": "<their wording>", "better": "<improved wording>", "why": "<short>" } ],
  "modelAnswer": "<the single best version of what they should have said, in natural English>",
  "zh": "<1-2 sentences in Traditional Chinese explaining the key difference>"
}` }] }], { json: true, temperature: 0.35, timeoutMs: 90000 });

    const res = parseJson(raw);
    state.drillResults.push({ drill: d, said, res });
    wait.remove();
    renderDrillFeedback(d, said, res);
  } catch (e) {
    wait.remove();
    body.appendChild(block('無法評分', p(e.message)));
  } finally { drillBusy = false; }
}

function renderDrillFeedback(d, said, res) {
  const body = $('drill-body');
  $('drill-composer').hidden = true;
  $('drill-mic').hidden = true;

  const c = el('div', 'fb-block');
  c.appendChild(el('h3', null, `這次得分 ${res.score ?? '–'}`));
  if (res.verdict) c.appendChild(p(res.verdict));
  if (res.zh) c.appendChild(p(res.zh));

  const cmp = el('div', 'drill-compare');
  cmp.innerHTML =
    `<div class="row"><span class="tag">你說的</span><span class="val was">${esc(said)}</span></div>` +
    `<div class="row"><span class="tag">更好的說法</span><span class="val now">${esc(res.modelAnswer || d.target)}</span></div>`;
  c.appendChild(cmp);

  (res.fixes || []).forEach(f => {
    const row = el('div', 'fb-correction');
    row.innerHTML = `<span class="was">${esc(f.was)}</span> → <span class="now">${esc(f.better)}</span><span class="why">${esc(f.why || '')}</span>`;
    c.appendChild(row);
  });
  if (res.goodBits?.length) c.appendChild(block('做對的地方', list(res.goodBits)));
  body.appendChild(c);

  const next = el('button', 'primary-btn',
    state.drillIndex >= state.drills.length - 1 ? '看總結 · See summary' : '下一題 ▶');
  next.onclick = () => { state.drillIndex++; renderDrill(); };
  body.appendChild(next);

  const retry = el('button', 'ghost-btn', '再講一次這題');
  retry.style.marginTop = '8px';
  retry.onclick = () => renderDrill();
  body.appendChild(retry);
  next.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function renderDrillSummary() {
  const body = $('drill-body');
  $('drill-composer').hidden = true;
  $('drill-mic').hidden = true;
  const done = state.drillResults;
  const avg = done.length ? Math.round(done.reduce((s, r) => s + (r.res.score || 0), 0) / done.length) : 0;

  const score = el('div', 'fb-score');
  score.innerHTML = `<div class="num">${avg}</div><div class="label">重練平均分</div>`;
  body.appendChild(score);

  const d = el('div');
  done.forEach((r, i) => {
    const row = el('div', 'stage-result');
    row.innerHTML =
      `<div class="head"><span class="name">第 ${i + 1} 題</span><span class="val">${r.res.score ?? '–'}</span></div>` +
      `<div class="notes">${esc(r.said)}</div>` +
      `<div class="better"><b>更好：</b>${esc(r.res.modelAnswer || r.drill.target)}</div>`;
    d.appendChild(row);
  });
  body.appendChild(block('逐題回顧', d));

  saveDrillHistory(avg);

  const home = el('button', 'ghost-btn', '回首頁');
  home.onclick = () => show('home');
  body.appendChild(home);
}

function saveDrillHistory(avg) {
  const now = Date.now();
  fileSession({
    id: 'd_' + now + '_' + Math.random().toString(36).slice(2, 7),
    ts: now, updatedAt: now, type: 'drill',
    brief: `🎯 重練 · ${state.drillResults.length} 題`,
    score: avg,
    drills: state.drillResults.map(r => ({ prompt: r.drill.prompt, said: r.said, score: r.res.score, model: r.res.modelAnswer })),
  });
}

$('drill-send').onclick = () => submitDrill();
$('drill-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitDrill(); }
});
$('drill-skip').onclick = () => { state.drillIndex++; renderDrill(); };
$('drill-mic').onclick = function () { startRecognition('en-US', this, $('drill-input'), () => submitDrill()); };

function saveReviewHistory(rv, meta) {
  const now = Date.now();
  fileSession({
    id: 'r_' + now + '_' + Math.random().toString(36).slice(2, 7),
    ts: now,
    updatedAt: now,
    type: 'review',
    brief: `🎧 會議檢討 · ${meta?.name || ''}`,
    score: rv.overallScore,
    source: meta,
    review: rv,
  });
}

/* ---------- Wiring for the new screens ---------- */
$('card-doc').onclick = () => initSourceScreen();
$('card-review').onclick = () => initReviewScreen();
$('btn-generate').onclick = () => generateScenario();
$('btn-start-stages').onclick = () => startStagedSession();
$('btn-live-brief').onclick = () => showLiveBrief();
$('btn-live-share').onclick = () => shareLiveBrief();
$('btn-live-download').onclick = () => downloadLiveBrief();
$('btn-live-copy').onclick = () => copyLiveBrief();
$('btn-live-to-review').onclick = () => { initReviewScreen(); document.querySelectorAll('#review-tabs .pill')[1]?.click(); };
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
$('btn-ref').onclick = () => toggleRefPanel();
$('btn-ref-close').onclick = () => toggleRefPanel(false);

/* ---------- Speech recognition ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recActive = false;
// Dictates into whichever field is asking — the chat composer or a drill.
function startRecognition(lang, btn, target, onDone) {
  if (!SR) { alert('此瀏覽器不支援語音辨識，請直接打字。\n(Android Chrome 支援度最佳)'); return; }
  if (recActive) { recog && recog.stop(); return; }
  const field = target || textInput;
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
    field.value = (finalText + interim).trim();
  };
  recog.onerror = () => {};
  recog.onend = () => {
    recActive = false; btn.classList.remove('listening');
    const t = field.value.trim();
    if (!t) return;
    if (onDone) { onDone(t); return; }
    field.value = ''; field.style.height = 'auto';
    sendToAI(t);
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
      const tag = (state.mode === 'doc' && t.stage != null) ? `[${stages()[t.stage].en}] ` : '';
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

Below is a transcript of a role-played meeting. It is split into stages: ${stages().map(s => s.en).join(' → ')}.
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
  "stages": [ { "stage": "<one of: ${stages().map(s => s.en).join(' | ')}>", "score": <0-100>, "notes": "<1-2 sentences>", "betterVersion": "<a stronger way they could have delivered this stage, in English>" } ],
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
  fileSession({
    id: 's_' + now + '_' + Math.random().toString(36).slice(2, 7),
    ts: now,
    updatedAt: now,
    type: state.mode === 'doc' ? 'doc' : 'classic',
    brief: state.scenarioBrief,
    difficulty: state.difficulty,
    score: fb.overallScore,
    source: state.mode === 'doc' ? state.source : null,
    article: state.mode === 'doc' ? state.article : null,
    fb,
  });
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
      if (item.type === 'drill' && item.drills) {
        const c = $('feedback-content');
        c.innerHTML = '';
        $('btn-practice-again').style.display = 'none';
        const s = el('div', 'fb-score');
        s.innerHTML = `<div class="num">${item.score ?? '–'}</div><div class="label">重練平均分</div>`;
        c.appendChild(s);
        const d = el('div');
        item.drills.forEach((x, i) => {
          const row = el('div', 'stage-result');
          row.innerHTML =
            `<div class="head"><span class="name">第 ${i + 1} 題</span><span class="val">${x.score ?? '–'}</span></div>` +
            `<div class="notes">${esc(x.said)}</div>` +
            `<div class="better"><b>更好：</b>${esc(x.model || '')}</div>`;
          d.appendChild(row);
        });
        c.appendChild(block('逐題回顧', d));
      } else if (item.type === 'review' && item.review) {
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
   PROGRESS — trends, recurring weaknesses, vocabulary bank
   All computed locally from history: no API calls, works offline, and
   costs nothing to open as often as you like.
   ============================================================ */
// Reads both slimmed records (axes) and any full ones kept by choice.
function axisAverages(items) {
  const sum = { english: [0, 0], questioning: [0, 0], structure: [0, 0] };
  const take = (k, v) => { if (v != null) { sum[k][0] += v; sum[k][1]++; } };
  items.forEach(s => {
    if (s.axes) {
      take('english', s.axes.english);
      take('questioning', s.axes.questioning);
      take('structure', s.axes.structure);
      return;
    }
    take('english', s.review?.english?.score);
    take('questioning', s.review?.questioning?.score ?? s.fb?.questioning?.score);
    take('structure', s.review?.structure?.score);
  });
  const avg = (p) => p[1] ? Math.round(p[0] / p[1]) : null;
  return { english: avg(sum.english), questioning: avg(sum.questioning), structure: avg(sum.structure) };
}

function recurringFixes(items) {
  const tally = new Map();
  const bump = (why) => {
    const k = String(why || '').trim().toLowerCase();
    if (!k || k.length < 4) return;
    tally.set(k, (tally.get(k) || 0) + 1);
  };
  items.forEach(s => {
    (s.why || []).forEach(bump);
    (s.fb?.corrections || []).forEach(c => bump(c.why));
    (s.review?.english?.corrections || []).forEach(c => bump(c.why));
  });
  return [...tally.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function recommendation(items, axes) {
  if (!items.length) return '還沒有紀錄。先做一次「📄 文件情境練習」，用你手上真實的資料開始。';
  const weakest = Object.entries(axes).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1])[0];
  const kinds = new Set(items.map(s => s.type));
  if (!kinds.has('review')) return '你還沒檢討過真實會議。那是進步最快的一步 —— 挑一場錄音或逐字稿丟進「🎧 檢討真實會議」。';
  if (!kinds.has('drill')) return '你檢討過但還沒重練。到任何一次檢討結果底部按「重練這些時刻」，把發現變成能力。';
  if (weakest && weakest[1] < 70) {
    const zh = { english: '英文表達', questioning: '提問深度', structure: '思考架構' }[weakest[0]];
    return `你最弱的一軸是「${zh}」（${weakest[1]} 分）。今天挑一份相關文件做一次分關卡練習，特別留意這一項。`;
  }
  return '三軸都在水準之上。試著把難度調到「進階 Hard」，或換一個你不熟悉的領域。';
}

function renderProgress() {
  const c = $('progress-content');
  const h = store.history;
  c.innerHTML = '';

  if (!h.length) {
    c.innerHTML = '<div class="empty">還沒有練習紀錄。做完第一次練習後，這裡會顯示你的進步曲線。</div>';
    return;
  }

  const axes = axisAverages(h);
  const rec = el('div', 'fb-block');
  rec.appendChild(el('h3', null, '💡 今天練什麼'));
  rec.appendChild(p(recommendation(h, axes)));
  c.appendChild(rec);

  // headline numbers
  const scored = h.filter(s => typeof s.score === 'number');
  const recent = scored.slice(0, 5);
  const older = scored.slice(5, 10);
  const mean = (a) => a.length ? Math.round(a.reduce((s, x) => s + x.score, 0) / a.length) : null;
  const now = mean(recent), was = mean(older);

  const stats = el('div', 'sub-scores');
  stats.appendChild(scoreRow('練習次數', h.length));
  stats.appendChild(scoreRow('近 5 次平均', now ?? '–'));
  stats.appendChild(scoreRow('與前 5 次比', was == null ? '–' : (now - was >= 0 ? '+' : '') + (now - was)));
  c.appendChild(stats);

  if (axes.english != null || axes.questioning != null || axes.structure != null) {
    const a = el('div', 'sub-scores');
    a.appendChild(scoreRow('英文 English', axes.english ?? '–'));
    a.appendChild(scoreRow('提問深度', axes.questioning ?? '–'));
    a.appendChild(scoreRow('思考架構', axes.structure ?? '–'));
    c.appendChild(a);
  }

  // trend, oldest → newest so it reads left to right like time
  if (scored.length > 1) {
    const bars = el('div', 'trend');
    scored.slice(0, 20).reverse().forEach(s => {
      const b = el('div', 'bar');
      b.style.height = Math.max(6, (s.score || 0) * 0.9) + 'px';
      b.title = `${s.brief} — ${s.score}`;
      bars.appendChild(b);
    });
    const wrap = el('div');
    wrap.appendChild(bars);
    wrap.appendChild(p('最舊 → 最新（最多 20 次）'));
    c.appendChild(block('分數趨勢 · Trend', wrap));
  }

  const fixes = recurringFixes(h);
  if (fixes.length) {
    const d = el('div');
    fixes.forEach(([why, n]) => {
      const row = el('div', 'fb-correction');
      row.innerHTML = `<span class="now">${esc(why)}</span><span class="why">出現 ${n} 次</span>`;
      d.appendChild(row);
    });
    c.appendChild(block('反覆出現的問題 · Recurring', d));
  }

  const cards = store.cards;
  if (cards.length) {
    const d = el('div');
    const due = cards.filter(x => (x.due || 0) <= Date.now()).length;
    d.appendChild(p(`語料庫已累積 <b>${cards.length}</b> 張，其中 <b>${cards.filter(x => x.star).length}</b> 張標為必備。`, true));
    const b = el('button', 'primary-btn', due ? `🔁 今日複習（${due} 張到期）` : '📇 打開語料庫');
    b.onclick = () => (due ? startRecall() : (renderCards(), show('cards')));
    d.appendChild(b);
    c.appendChild(block('語料庫 · Phrase Bank', d));
  }
}

/* ============================================================
   PHRASE BANK UI · RECALL · SELF-INTRODUCTION
   ============================================================ */
let cardFilter = 'all';

function renderCards() {
  const wrap = $('cards-list');
  const cards = store.cards;
  const q = $('card-search').value.trim().toLowerCase();

  const row = $('card-cats');
  row.innerHTML = '';
  const counts = { all: cards.length, star: cards.filter(c => c.star).length };
  Object.keys(CARD_CATS).forEach(k => { counts[k] = cards.filter(c => c.cat === k).length; });
  const tabs = [['all', '全部'], ['star', '⭐ 必備'],
    ...Object.entries(CARD_CATS).filter(([k]) => counts[k])];
  tabs.forEach(([k, label]) => {
    const p = el('button', 'pill' + (k === cardFilter ? ' active' : ''), `${label} ${counts[k] || 0}`);
    p.onclick = () => { cardFilter = k; renderCards(); };
    row.appendChild(p);
  });

  const shown = cards
    .filter(c => cardFilter === 'all' || (cardFilter === 'star' ? c.star : c.cat === cardFilter))
    .filter(c => !q || c.text.toLowerCase().includes(q) || (c.zh || '').includes(q))
    .sort((a, b) => (b.star - a.star) || (b.ts - a.ts));

  wrap.innerHTML = '';
  if (!shown.length) {
    wrap.innerHTML = '<div class="empty">這個分類還沒有內容。做幾次練習就會自動累積。</div>';
    return;
  }

  shown.slice(0, 300).forEach(c => {
    const d = el('div', 'card-item' + (c.star ? ' starred' : ''));
    const main = el('div', 'card-main');
    main.appendChild(el('div', 'card-text', c.text));
    if (c.zh) main.appendChild(el('div', 'card-zh', c.zh));
    main.appendChild(el('div', 'card-meta', `${CARD_CATS[c.cat] || '其他'}${c.src ? ' · ' + c.src : ''}`));
    d.appendChild(main);

    const acts = el('div', 'card-acts');
    const star = el('button', 'card-btn', c.star ? '⭐' : '☆');
    star.title = '標為必備';
    star.onclick = () => {
      const all = store.cards;
      const t = all.find(x => x.id === c.id);
      if (t) { t.star = !t.star; store.cards = all; renderCards(); }
    };
    const say = el('button', 'card-btn', '🔊');
    say.onclick = () => speak(c.text);
    const del = el('button', 'card-btn', '🗑');
    del.onclick = () => {
      if (!confirm('刪除這張卡？')) return;
      store.cards = store.cards.filter(x => x.id !== c.id);
      renderCards();
    };
    acts.append(star, say, del);
    d.appendChild(acts);
    wrap.appendChild(d);
  });
}

$('card-search').oninput = () => renderCards();
$('btn-cards').onclick = () => { renderCards(); show('cards'); };
$('btn-card-add').onclick = () => {
  const text = prompt('要記住的英文句子或詞彙：');
  if (!text) return;
  const zh = prompt('中文說明（可留白）：') || '';
  addCards([{ text, zh, cat: 'other', star: true }], '手動新增');
  renderCards();
};

/* ---------- Recall ----------
   A phrase bank nobody revisits is a graveyard. Show what is due, make them
   say it aloud, and space the next showing by how well it went. */
let recallQueue = [], recallAt = 0, recallShown = false;

function startRecall() {
  const now = Date.now();
  const due = store.cards.filter(c => (c.due || 0) <= now);
  if (!due.length) {
    alert('目前沒有到期的卡片。\n\n複習是有間隔的：記得的卡片會隔更久才再出現。');
    renderCards(); show('cards'); return;
  }
  // Starred first, then whatever has waited longest.
  recallQueue = due.sort((a, b) => (b.star - a.star) || ((a.due || 0) - (b.due || 0))).slice(0, 20);
  recallAt = 0;
  renderRecall();
  show('recall');
}

function renderRecall() {
  const bar = $('recall-progress');
  const body = $('recall-body');
  bar.innerHTML = '';
  recallQueue.forEach((_, i) => {
    bar.appendChild(el('span', 'stage-chip ' + (i < recallAt ? 'done' : i === recallAt ? 'current' : ''), String(i + 1)));
  });

  body.innerHTML = '';
  const c = recallQueue[recallAt];
  if (!c) {
    const done = el('div', 'fb-block');
    done.appendChild(el('h3', null, '複習完成 🎉'));
    done.appendChild(p(`這輪複習了 ${recallQueue.length} 張。記得的會隔更久再出現，忘記的明天見。`));
    const b = el('button', 'primary-btn', '回語料庫');
    b.onclick = () => { renderCards(); show('cards'); };
    done.appendChild(b);
    body.appendChild(done);
    return;
  }

  recallShown = false;
  const card = el('div', 'fb-block recall-card');
  card.appendChild(el('div', 'card-meta', `${CARD_CATS[c.cat] || ''}${c.star ? ' · ⭐ 必備' : ''}`));
  // Prompt with the Chinese where there is one, so recall is active not passive.
  card.appendChild(el('div', 'recall-prompt', c.zh || '(想想這句英文怎麼說)'));
  const answer = el('div', 'recall-answer', c.text);
  answer.hidden = true;
  card.appendChild(answer);
  body.appendChild(card);

  const reveal = el('button', 'primary-btn', '看答案 · Reveal');
  reveal.onclick = () => {
    answer.hidden = false;
    recallShown = true;
    reveal.hidden = true;
    speak(c.text);
    grade.hidden = false;
  };
  body.appendChild(reveal);

  const grade = el('div', 'live-actions');
  grade.hidden = true;
  grade.style.marginTop = '10px';
  const ok = el('button', 'primary-btn', '✅ 記得');
  ok.onclick = () => gradeCard(c, true);
  const no = el('button', 'ghost-btn', '❌ 忘了');
  no.onclick = () => gradeCard(c, false);
  const say = el('button', 'ghost-btn', '🔊 再聽');
  say.onclick = () => speak(c.text);
  grade.append(ok, no, say);
  body.appendChild(grade);
  window.scrollTo(0, 0);
}

function gradeCard(c, remembered) {
  const all = store.cards;
  const t = all.find(x => x.id === c.id);
  if (t) {
    t.box = remembered ? Math.min((t.box || 1) + 1, BOX_DAYS.length - 1) : 1;
    t.due = Date.now() + BOX_DAYS[t.box] * DAY;
    store.cards = all;
  }
  recallAt++;
  renderRecall();
}

$('btn-recall').onclick = () => startRecall();

/* ---------- Self-introduction ----------
   The one piece of English you will say in every single meeting. Worth
   polishing once and owning outright. */
$('btn-intro').onclick = () => { $('intro-status').textContent = ''; $('intro-result').innerHTML = ''; show('intro'); };

$('btn-intro-make').onclick = async () => {
  const raw = $('intro-input').value.trim();
  if (raw.length < 10) { $('intro-status').textContent = '⚠️ 請先寫幾句你想表達的內容。'; return; }
  if (!store.apiKey) { alert('請先到「設定」貼上 Gemini API 金鑰。'); show('settings'); return; }

  let stop = null;
  const status = (t) => { $('intro-status').textContent = t; };
  try {
    $('btn-intro-make').disabled = true;
    stop = startTicker(status, 'AI 打磨中…');
    const out = await callGemini([{ role: 'user', parts: [{ text:
`A non-native English speaker who works in corporate strategy and investment wrote this rough description of themselves. It may be in Chinese.

"${raw}"

Turn it into a self-introduction they can actually say out loud in a business meeting. Natural spoken English, first person, no jargon they would not use themselves, nothing invented beyond what they wrote.

Return ONLY JSON:
{
  "oneLiner": "<a single sentence for a quick round of introductions>",
  "short": "<about 30 seconds spoken — 3-4 sentences>",
  "long": "<about 60 seconds spoken — who you are, what you look for, why you are in this meeting>",
  "tips": ["<a short note in Traditional Chinese on delivery: what to stress, what to slow down on>"]
}` }] }], { json: true, temperature: 0.6, timeoutMs: 120000 });
    stop(); stop = null;
    const r = parseJson(out);
    status('');
    renderIntro(r);
  } catch (e) {
    status('⚠️ ' + e.message);
  } finally {
    if (stop) stop();
    $('btn-intro-make').disabled = false;
  }
};

function renderIntro(r) {
  const c = $('intro-result');
  c.innerHTML = '';
  const versions = [
    ['一句話版 · One-liner', r.oneLiner],
    ['30 秒版 · Short', r.short],
    ['60 秒版 · Full', r.long],
  ];
  versions.forEach(([title, text]) => {
    if (!text) return;
    const d = el('div');
    d.appendChild(p(text));
    const acts = el('div', 'live-actions');
    const say = el('button', 'ghost-btn', '🔊 聽一次');
    say.onclick = () => speak(text);
    const keep = el('button', 'primary-btn', '⭐ 存成必備');
    keep.onclick = () => {
      addCards([{ text, zh: title, cat: 'intro', star: true }], '自我介紹');
      keep.textContent = '已存入 ✓';
      keep.disabled = true;
    };
    acts.append(keep, say);
    d.appendChild(acts);
    c.appendChild(block(title, d));
  });
  if (r.tips?.length) c.appendChild(block('講的時候注意 · Delivery', list(r.tips)));
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
  $('keepfull-toggle').checked = store.keepFull;
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
  store.keepFull = $('keepfull-toggle').checked;
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
migrateHistory();
renderHome();
loadSettings();
show('home', false);
state.screenStack = ['home'];
restoreScreen();
if (syncEnabled()) syncNow(true);

/* ---------- About / force-update (like DD meeting-notes) ---------- */
const APP_VERSION = 'v22';

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
