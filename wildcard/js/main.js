// WILDCARD // 2077 phone client: UI wiring. Pure logic lives in logic.js, art in cards.js, networking in net.js.
import { initGameChrome, setLang as setHubLang, API_BASE } from '../../shared/hub-sdk.js?v=20261120b';
import { t as tr } from './i18n.js';
import { cardSVG, cardBackSVG, colorSwatchSVG, cardName } from './cards.js';
import {
  COLORS, SEAT_OPTIONS, TIMER_OPTIONS, NAME_KEY, WS_OVERRIDE_KEY,
  sortHand, topOf, canPlay, isMyTurn, playableIds, mustDraw, drawAction, secondsLeft, timerFraction,
  playersInSeatOrder, opponentsInPlayOrder, seatBadge, normalizeRoomCode, isRoomCode, cleanName,
  joinErrorKey, rejectKey, resolveEndpoint, loadReconnect,
} from './logic.js';
import { WildcardNet, loadVendoredSdk } from './net.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let lang = 'en';
const T = (k, ...a) => tr(lang, k, ...a);

let auth = { kind: 'guest', handle: null, name: '' };
let net = null;
let view = null;       // plain snapshot of the room state
let mySeat = -1;
let myHand = [];
let welcome = null;
let screen = 'connect';
let pendingWild = null; // card id waiting for a colour
let lastEndKey = '';
let toastTimer = 0;
let bannerTimer = 0;
let createOpts = { seats: 4, stacking: false, turnSeconds: 30 };

// ---------- Hub chrome (theme, language), same as the other cabinets ----------
try {
  const chrome = initGameChrome({
    gameId: 'wildcard',
    onLangChange: (l) => { lang = l === 'he' ? 'he' : 'en'; applyLang(); },
  });
  if (chrome && (chrome.lang === 'he' || chrome.lang === 'en')) lang = chrome.lang;
} catch (e) { console.warn('hub-sdk initGameChrome failed:', e); }

// ---------- Language ----------
function applyLang() {
  root.setAttribute('lang', lang);
  root.setAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  document.title = T('title');
  $('wcTitle').textContent = T('title');
  $('hubLink').textContent = T('hub');
  $('bLang').textContent = T('langBtn');
  $('tagline').textContent = T('tagline');
  $('nameLabel').textContent = T('yourName');
  $('nameInput').placeholder = T('namePlaceholder');
  $('createTitle').textContent = T('createRoom');
  $('seatsLabel').textContent = T('seats');
  $('stackLabel').textContent = T('stacking');
  $('timerLabel').textContent = T('timer');
  $('createBtn').textContent = T('createBtn');
  $('joinTitle').textContent = T('joinRoom');
  $('codeInput').placeholder = T('codePlaceholder');
  $('joinBtn').textContent = T('joinBtn');
  $('codeHint').textContent = T('codeHint');
  $('pickTitle').textContent = T('pickColor');
  renderCreateOptions();
  renderAuth();
  renderColorPicker();
  render();
}

function renderAuth() {
  const badge = $('acctBadge');
  badge.hidden = false;
  badge.className = `acct-badge ${auth.kind}`;
  badge.textContent = auth.kind === 'user' ? T('userShort') : T('guestShort');
  const note = $('guestNotice');
  if (auth.kind === 'guest') {
    note.hidden = false;
    note.innerHTML = `${esc(T('guestNotice'))} <a href="../">${esc(T('signInLink'))}</a>`;
  } else {
    note.hidden = true;
  }
}

async function loadAuth() {
  try {
    const r = await fetch(`${API_BASE}/me`, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (r.ok) {
      const b = await r.json();
      const u = b && (b.user || b);
      if (b && b.ok !== false && u && typeof u.handle === 'string' && u.handle) {
        auth = { kind: 'user', handle: u.handle, name: u.display_name || u.displayName || u.handle };
        const input = $('nameInput');
        if (!input.value) input.value = cleanName(auth.name);
      }
    }
  } catch { /* offline or no dashboard: stay a guest */ }
  renderAuth();
}

// ---------- Screens ----------
function showScreen(name) {
  screen = name;
  $('screenConnect').hidden = name !== 'connect';
  $('screenLobby').hidden = name !== 'lobby';
  $('screenTable').hidden = name !== 'table';
}

function setBanner(text, ok = false, ms = 0) {
  const b = $('banner');
  clearTimeout(bannerTimer);
  if (!text) { b.hidden = true; return; }
  b.textContent = text;
  b.className = `banner${ok ? ' ok' : ''}`;
  b.hidden = false;
  if (ms) bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
}

function toast(text) {
  const el = $('toast');
  clearTimeout(toastTimer);
  el.innerHTML = `<span>${esc(text)}</span><button type="button" aria-label="${esc(T('toastClose'))}">×</button>`;
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}
$('toast').addEventListener('click', (e) => { if (e.target.closest('button')) $('toast').hidden = true; });

function announce(text) { $('srLive').textContent = text; }

function showConnectError(key) {
  const el = $('connectError');
  if (!key) { el.hidden = true; return; }
  el.textContent = T(key);
  el.hidden = false;
}

// ---------- Connect screen ----------
function seg(el, values, current, label, onPick) {
  el.innerHTML = values.map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === current}">${esc(label(v))}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (b && !b.disabled) onPick(Number(b.dataset.v));
  };
}

function renderCreateOptions() {
  seg($('seatsSeg'), SEAT_OPTIONS, createOpts.seats, (v) => String(v), (v) => { createOpts.seats = v; renderCreateOptions(); });
  seg($('timerSeg'), TIMER_OPTIONS, createOpts.turnSeconds, (v) => (v === 0 ? T('timerOff') : T('timerN', v)), (v) => { createOpts.turnSeconds = v; renderCreateOptions(); });
  $('stackToggle').setAttribute('aria-checked', String(createOpts.stacking));
}
$('stackToggle').addEventListener('click', () => { createOpts.stacking = !createOpts.stacking; renderCreateOptions(); });

function currentName() {
  const typed = cleanName($('nameInput').value, '');
  const name = typed || cleanName(auth.name, '') || T('namePlaceholder');
  try { localStorage.setItem(NAME_KEY, name); } catch { /* storage unavailable */ }
  return name;
}

function makeNet() {
  net = new WildcardNet({
    loadSdk: loadVendoredSdk,
    endpoint: resolveEndpoint({
      search: location.search,
      stored: (() => { try { return localStorage.getItem(WS_OVERRIDE_KEY); } catch { return null; } })(),
      location,
    }),
    storage: sessionStorage,
    on: { state: onState, welcome: (m) => { welcome = m; }, event: onEvent, rejected: onRejected, status: onStatus },
  });
  return net;
}

let busy = false;
async function connect(action) {
  if (busy) return;
  busy = true;
  showConnectError(null);
  setBanner(T('connecting'));
  try {
    if (!net) makeNet();
    await action(net);
    setBanner('');
  } catch (e) {
    setBanner('');
    showConnectError(e && e.code === 'sdk_missing' ? 'noSdk' : joinErrorKey(e));
    if (e && e.code !== 'sdk_missing') console.warn('wildcard connect failed:', e);
  } finally { busy = false; }
}

$('createBtn').addEventListener('click', () => connect((n) => n.create(currentName(), createOpts)));
$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeRoomCode($('codeInput').value);
  if (!isRoomCode(code)) { showConnectError('err_code'); return; }
  connect((n) => n.join(currentName(), code));
});
$('codeInput').addEventListener('input', (e) => {
  const v = normalizeRoomCode(e.target.value);
  if (v !== e.target.value) e.target.value = v;
});

// ---------- Net callbacks ----------
function onStatus(s) {
  if (s.state === 'reconnecting') setBanner(T('reconnecting', s.secondsLeft));
  else if (s.state === 'reconnected') { setBanner(T('reconnected'), true, 2500); }
  else if (s.state === 'failed') { setBanner(T('reconnectFailed'), false, 6000); backToConnect(); }
  else if (s.state === 'left') backToConnect();
  else if (s.state === 'connected') setBanner('');
}

function backToConnect() {
  view = null; mySeat = -1; myHand = []; welcome = null; pendingWild = null; lastEndKey = '';
  $('overlayColor').hidden = true;
  $('overlayEnd').hidden = true;
  showScreen('connect');
}

function cardOf(c) { return { id: c.id, kind: c.kind, color: c.color, value: c.value, chosenColor: c.chosenColor || '' }; }

function snapshot(room) {
  const s = room.state;
  const players = [];
  s.players.forEach((p) => {
    players.push({
      seatIndex: p.seatIndex, sessionId: p.sessionId, name: p.name, isBot: p.isBot, occupied: p.occupied,
      connected: p.connected, autopilot: p.autopilot, autopilotReason: p.autopilotReason, kind: p.kind,
      handle: p.handle, isHost: p.isHost, timeouts: p.timeouts, handCount: p.handCount,
      hand: p.hand ? Array.from(p.hand, cardOf) : [],
    });
  });
  return {
    roomCode: s.roomCode, phase: s.phase, players: playersInSeatOrder({ forEach: (f) => players.forEach(f) }),
    discardPile: Array.from(s.discardPile, cardOf), discardCount: s.discardCount, drawPileCount: s.drawPileCount,
    currentPlayer: s.currentPlayer, direction: s.direction, activeColor: s.activeColor, pendingDraw: s.pendingDraw,
    pendingKind: s.pendingKind, winner: s.winner, hostSeat: s.hostSeat, seatCount: s.seatCount, stacking: s.stacking,
    turnSeconds: s.turnSeconds, turnDeadline: s.turnDeadline, matchNumber: s.matchNumber,
  };
}

function onState(room) {
  try {
    view = snapshot(room);
  } catch (e) { console.warn('bad state', e); return; }
  const me = view.players.find((p) => p.sessionId === room.sessionId) || (welcome ? view.players.find((p) => p.seatIndex === welcome.seat) : null);
  mySeat = me ? me.seatIndex : -1;
  myHand = me ? sortHand(me.hand) : [];
  render();
}

function onEvent(m) {
  if (!view) return;
  const nameOf = (seat) => (view.players.find((p) => p.seatIndex === seat) || { name: `#${seat + 1}` }).name;
  if (m.type === 'play') announce(T('ev_play', nameOf(m.seat), cardName(m.card, T)));
  else if (m.type === 'draw') announce(T('ev_draw', nameOf(m.seat), m.count));
  else if (m.type === 'skip') announce(T('ev_skip', nameOf(m.seat)));
  else if (m.type === 'reverse') announce(T('ev_reverse'));
}

function onRejected(m) {
  pendingWild = null;
  $('overlayColor').hidden = true;
  toast(T(rejectKey(m && m.reason)));
}

// ---------- Rendering ----------
function render() {
  if (!view) { showScreen('connect'); return; }
  if (view.phase === 'lobby') { renderLobby(); showScreen('lobby'); $('overlayEnd').hidden = true; lastEndKey = ''; }
  else { renderTable(); showScreen('table'); renderEnd(); }
}

const iAmHost = () => view && mySeat >= 0 && view.hostSeat === mySeat;

function badgesHtml(p) {
  const out = [];
  if (p.isHost) out.push(`<span class="badge host">${esc(T('host'))}</span>`);
  const b = seatBadge(p, mySeat);
  if (b) out.push(`<span class="badge ${b}">${esc(T(b))}</span>`);
  return `<span class="badges">${out.join('')}</span>`;
}

function renderLobby() {
  const host = iAmHost();
  const rows = [];
  for (let i = 0; i < view.seatCount; i++) {
    const p = view.players.find((x) => x.seatIndex === i);
    const human = p && p.occupied;
    const name = human ? p.name : T('empty');
    rows.push(`<li class="${p && p.seatIndex === mySeat ? 'me' : ''}"><span class="nm ${human ? '' : 'empty'}">${esc(name)}</span>${p ? badgesHtml(p) : ''}</li>`);
  }
  $('screenLobby').innerHTML = `
    <div class="panel">
      <h2 class="panel-title">${esc(T('roomCode'))}</h2>
      <div class="code-chip"><span class="code" id="roomCodeText" aria-label="${esc(view.roomCode.split('').join(' '))}">${esc(view.roomCode)}</span>
        <button type="button" class="cyber-btn ghost" data-act="copy">${esc(T('copyCode'))}</button></div>
      <small class="hint">${esc(T('shareHint'))}</small>
    </div>
    <div class="panel"><ul class="seat-list">${rows.join('')}</ul></div>
    <div class="panel">
      <h2 class="panel-title">${esc(T('options'))}</h2>
      <div class="opt-row"><span class="opt-label">${esc(T('seats'))}</span><b>${view.seatCount}</b></div>
      <div class="opt-row"><span class="opt-label" id="lobStackLabel">${esc(T('stacking'))}</span>
        <button type="button" class="toggle" id="lobStack" role="switch" aria-checked="${view.stacking}" aria-labelledby="lobStackLabel" data-act="stack" ${host ? '' : 'disabled'}><i></i></button></div>
      <div class="opt-row"><span class="opt-label">${esc(T('timer'))}</span>
        <div class="seg" id="lobTimer">${TIMER_OPTIONS.map((v) => `<button type="button" data-act="timer" data-v="${v}" aria-pressed="${view.turnSeconds === v}" ${host ? '' : 'disabled'}>${esc(v === 0 ? T('timerOff') : T('timerN', v))}</button>`).join('')}</div></div>
    </div>
    <div class="row-actions">
      ${host ? `<button type="button" class="cyber-btn" data-act="start">${esc(T('start'))}</button>` : `<p class="hint" role="status">${esc(T('waitingHost'))}</p>`}
      <button type="button" class="cyber-btn ghost" data-act="leave">${esc(T('leave'))}</button>
    </div>`;
}

function oppHtml(p) {
  const turn = view.phase === 'playing' && p.seatIndex === view.currentPlayer;
  const count = p.handCount;
  return `<div class="opp${turn ? ' turn' : ''}${count === 1 ? ' uno' : ''}" data-seat="${p.seatIndex}">
    <span class="nm">${esc(p.occupied ? p.name : p.name || T('bot'))}</span>
    <span class="cnt" aria-label="${esc(count === 1 ? T('oneCard') : T('cardsN', count))}">${count}<small aria-hidden="true">▮</small></span>
    ${badgesHtml(p)}
  </div>`;
}

function renderTable() {
  const v = view;
  const me = v.players.find((p) => p.seatIndex === mySeat);
  const mine = isMyTurn(v, mySeat);
  const playable = playableIds(v, myHand, mySeat);
  const stuck = mustDraw(v, myHand, mySeat);
  const draw = drawAction(v, mySeat);
  const top = topOf(v.discardPile);
  const current = v.players.find((p) => p.seatIndex === v.currentPlayer);
  const opponents = opponentsInPlayOrder(v.players, mySeat, v.direction);

  const turnText = v.phase === 'finished' ? '' : mine ? T('yourTurn') : T('turnOf', current ? current.name : '…');
  const timerHtml = v.turnDeadline > 0 && v.phase === 'playing'
    ? `<span class="timer" id="timer"><b id="timerSecs">--</b><span class="bar" aria-hidden="true"><u id="timerBar"></u></span></span>` : '<span class="timer"></span>';
  const drawLabel = draw.count > 1 ? T('drawN', draw.count) : T('draw');
  const chosen = top && top.kind === 'wild' ? v.activeColor : '';
  const dirGlyph = v.direction === 1 ? '↻' : '↺';

  const handHtml = myHand.map((c) => {
    const ok = playable.has(c.id);
    return `<button type="button" class="wc-card${ok ? ' playable' : ''}" data-card="${esc(c.id)}" data-color="${c.kind === 'wild' ? 'wild' : c.color}"
      aria-label="${esc(cardName(c, T))}${ok ? `, ${esc(T('playable'))}` : ''}">${cardSVG(c)}</button>`;
  }).join('');

  $('screenTable').innerHTML = `
    <div class="opp-row">${opponents.map(oppHtml).join('')}</div>
    <div class="status-row"><span class="turn-label${mine ? ' mine' : ''}">${esc(turnText)}</span>${timerHtml}</div>
    <div class="center">
      <div class="pile"><span class="lbl">${esc(T('drawPile'))} · ${v.drawPileCount}</span>
        <button type="button" class="draw-btn${draw.enabled && stuck ? ' go' : ''}" data-act="draw" ${draw.enabled ? '' : 'disabled'} aria-label="${esc(drawLabel)}">${cardBackSVG()}<span class="tag">${esc(drawLabel)}</span></button></div>
      <div class="pile discard-wrap"><span class="lbl">${esc(T('discardPile'))}</span>
        <div class="wc-card" data-color="${top ? (top.kind === 'wild' ? 'wild' : top.color) : ''}">${top ? cardSVG(top, { chosen, label: cardName(top, T) }) : ''}</div>
        <div class="chips">
          <span class="chip" aria-label="${esc(T('activeColor'))}: ${esc(T(`col_${v.activeColor}`))}">${colorSwatchSVG(v.activeColor)}${esc(T(`col_${v.activeColor}`))}</span>
          <span class="chip dir" role="img" aria-label="${esc(T('direction'))}: ${esc(v.direction === 1 ? T('dirCw') : T('dirCcw'))}">${dirGlyph}</span>
          ${v.pendingDraw > 0 ? `<span class="chip pending" role="status">${esc(T('pending', v.pendingDraw))}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="auto-slot">${me && me.autopilot ? `<div class="auto-banner"><span>${esc(T('autopilotOn'))}</span><button type="button" class="cyber-btn" data-act="resume">${esc(T('resume'))}</button></div>` : ''}</div>
    <div class="hand-wrap"><div class="hand${mine ? ' mine-turn' : ''}" role="group" aria-label="${esc(T('cardsN', myHand.length))}">${handHtml}</div></div>`;
  tickTimer();
}

function renderEnd() {
  const el = $('overlayEnd');
  if (view.phase !== 'finished') { el.hidden = true; lastEndKey = ''; return; }
  const key = `${view.matchNumber}:${view.winner}`;
  if (key === lastEndKey && !el.hidden) { return; }
  lastEndKey = key;
  const winner = view.players.find((p) => p.seatIndex === view.winner);
  const iWon = view.winner === mySeat;
  const ranked = [...view.players].sort((a, b) => (a.seatIndex === view.winner ? -1 : b.seatIndex === view.winner ? 1 : a.handCount - b.handCount));
  const host = iAmHost();
  el.innerHTML = `<div class="modal-panel">
    <h2 class="end-title" id="endTitle">${esc(iWon ? T('youWin') : T('youLose', winner ? winner.name : '?'))}</h2>
    <h3 class="panel-title">${esc(T('standings'))}</h3>
    <ol class="standings">${ranked.map((p, i) => `<li class="${p.seatIndex === view.winner ? 'win' : ''}"><span class="rk">${i + 1}</span><span class="nm">${esc(p.name)}</span><span>${esc(p.handCount === 1 ? T('oneCard') : T('cardsN', p.handCount))}</span></li>`).join('')}</ol>
    <p class="small-note">${esc(auth.kind === 'user' ? T('xpNote') : T('noXpNote'))}</p>
    <div class="row-actions">
      ${host ? `<button type="button" class="cyber-btn" data-act="restart">${esc(T('restart'))}</button>` : `<p class="hint" role="status">${esc(T('waitingHost'))}</p>`}
      <button type="button" class="cyber-btn ghost" data-act="leave">${esc(T('leave'))}</button>
    </div></div>`;
  el.hidden = false;
  const first = el.querySelector('button');
  if (first) first.focus();
}

function renderColorPicker() {
  $('colorGrid').innerHTML = COLORS.map((c) => `<button type="button" class="color-btn" data-pick="${c}">${colorSwatchSVG(c)}<span>${esc(T(`col_${c}`))}</span></button>`).join('');
}

// ---------- Timer ----------
function tickTimer() {
  if (!view || view.phase !== 'playing' || !(view.turnDeadline > 0)) return;
  const secs = $('timerSecs');
  if (!secs) return;
  const now = Date.now();
  const left = secondsLeft(view.turnDeadline, now);
  secs.textContent = left === null ? '--' : String(left);
  const frac = timerFraction(view.turnDeadline, view.turnSeconds, now);
  const bar = $('timerBar');
  if (bar && frac !== null) bar.style.width = `${Math.round(frac * 100)}%`;
  const timer = $('timer');
  if (timer) timer.classList.toggle('low', left !== null && left <= 5);
}
setInterval(tickTimer, 250);

// ---------- Actions ----------
document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  if (actBtn && !actBtn.disabled) {
    const act = actBtn.dataset.act;
    if (act === 'start') net.send('start');
    else if (act === 'restart') net.send('restart');
    else if (act === 'draw') net.send('draw_card');
    else if (act === 'resume') net.send('resume');
    else if (act === 'leave') { await net.leave(); }
    else if (act === 'stack') net.send('set_options', { stacking: !view.stacking });
    else if (act === 'timer') net.send('set_options', { turnSeconds: Number(actBtn.dataset.v) });
    else if (act === 'copy') copyCode(actBtn);
    return;
  }
  const cardBtn = e.target.closest('[data-card]');
  if (cardBtn) { playCard(cardBtn.dataset.card); return; }
  const pick = e.target.closest('[data-pick]');
  if (pick && pendingWild) {
    net.send('play_card', { cardId: pendingWild, chosenColor: pick.dataset.pick });
    pendingWild = null;
    $('overlayColor').hidden = true;
  }
});

function playCard(id) {
  if (!view) return;
  const card = myHand.find((c) => c.id === id);
  if (!card) return;
  if (!isMyTurn(view, mySeat)) { toast(T('rej_not_your_turn')); return; }
  if (!canPlay(view, card)) { toast(T(mustDraw(view, myHand, mySeat) ? 'rej_must_draw' : 'rej_not_playable')); return; }
  if (card.kind === 'wild') {
    pendingWild = id;
    $('overlayColor').hidden = false;
    const first = $('colorGrid').querySelector('button');
    if (first) first.focus();
    return;
  }
  net.send('play_card', { cardId: id });
}

async function copyCode(btn) {
  try {
    await navigator.clipboard.writeText(view.roomCode);
    btn.textContent = T('copied');
    setTimeout(() => { btn.textContent = T('copyCode'); }, 1500);
  } catch { /* clipboard not available: the code is on screen */ }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('overlayColor').hidden) { pendingWild = null; $('overlayColor').hidden = true; }
});

$('bLang').addEventListener('click', () => {
  lang = lang === 'he' ? 'en' : 'he';
  try { setHubLang(lang); } catch { /* storage unavailable */ }
  applyLang();
});

// ---------- Boot ----------
(async function boot() {
  try { const stored = localStorage.getItem(NAME_KEY); if (stored) $('nameInput').value = cleanName(stored); } catch { /* no storage */ }
  const q = new URLSearchParams(location.search).get('code');
  if (q) $('codeInput').value = normalizeRoomCode(q);
  applyLang();
  showScreen('connect');
  await loadAuth();
  // A reload inside the 30 s hold: take the seat back with the token from sessionStorage.
  if (loadReconnect(sessionStorage)) {
    if (!net) makeNet();
    try { await net.resumeFromStorage(); } catch (e) { console.warn('resume failed', e); }
  }
})();
