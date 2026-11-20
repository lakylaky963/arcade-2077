// WILDCARD // 2077 client: pure logic (no DOM, no network, no Colyseus). Unit-tested in ../logic.test.mjs.
// Mirrors the rules in wildcard-server/src/rules/uno.ts only as far as the UI needs: which cards to highlight,
// how to sort a hand, what the turn timer shows, and how to read the room's connection details.

export const COLORS = Object.freeze(['red', 'yellow', 'green', 'blue']);
export const VALUE_ORDER = Object.freeze(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']);
export const SEAT_OPTIONS = Object.freeze([2, 3, 4]);
export const TIMER_OPTIONS = Object.freeze([15, 30, 0]);
export const ROOM_CODE_LENGTH = 5;
/** Colyseus holds a dropped seat for 30 s (server RECONNECT_SECONDS); the client stops trying a little earlier. */
export const RECONNECT_WINDOW_MS = 28_000;
export const RECONNECT_KEY = 'wildcard.reconnect.v1';
export const NAME_KEY = 'wildcard.name.v1';
export const WS_OVERRIDE_KEY = 'wildcard.ws';
export const DEFAULT_WS_PATH = '/game/uno-ws/';

const colorIndex = (c) => { const i = COLORS.indexOf(c); return i === -1 ? COLORS.length : i; };
const valueIndex = (v) => { const i = VALUE_ORDER.indexOf(v); return i === -1 ? VALUE_ORDER.length : i; };

// ---------- Hand ----------

/** Colour cards grouped by colour (red, yellow, green, blue), by value inside a colour; wilds last. Stable by id. Never mutates. */
export function sortHand(cards) {
  return [...cards].sort((a, b) => {
    const aw = a.kind === 'wild' ? 1 : 0;
    const bw = b.kind === 'wild' ? 1 : 0;
    if (aw !== bw) return aw - bw;
    if (!aw) {
      const c = colorIndex(a.color) - colorIndex(b.color);
      if (c) return c;
    }
    const v = valueIndex(a.value) - valueIndex(b.value) || (a.value === 'wild' ? -1 : 0) - (b.value === 'wild' ? -1 : 0);
    if (v) return v;
    return String(a.id).localeCompare(String(b.id));
  });
}

export const isWild = (card) => !!card && card.kind === 'wild';

/** The card on top of the discard pile (the pile arrives with the top as its LAST element). */
export function topOf(discardPile) {
  return discardPile && discardPile.length ? discardPile[discardPile.length - 1] : null;
}

// ---------- Legal moves (same rules as the server's canPlayCard) ----------

/**
 * view = { phase, currentPlayer, pendingDraw, pendingKind, stacking, activeColor, discardPile }.
 * With a penalty pending only a same-kind stacking card is legal; otherwise colour, value or any wild.
 */
export function canPlay(view, card) {
  if (!view || !card || view.phase !== 'playing') return false;
  if (view.pendingDraw > 0) {
    return !!view.stacking && !!view.pendingKind && card.value === view.pendingKind;
  }
  if (card.kind === 'wild') return true;
  if (card.color === view.activeColor) return true;
  const top = topOf(view.discardPile);
  return !!top && top.kind === 'color' && card.value === top.value;
}

export const isMyTurn = (view, mySeat) => !!view && view.phase === 'playing' && mySeat >= 0 && view.currentPlayer === mySeat;

/** Ids of the cards to highlight: only on my turn. */
export function playableIds(view, hand, mySeat) {
  if (!isMyTurn(view, mySeat)) return new Set();
  return new Set(hand.filter((c) => canPlay(view, c)).map((c) => c.id));
}

/** True when it is my turn and nothing in my hand is legal (the only move is to draw). */
export function mustDraw(view, hand, mySeat) {
  return isMyTurn(view, mySeat) && playableIds(view, hand, mySeat).size === 0;
}

/** What the draw button will do right now. */
export function drawAction(view, mySeat) {
  if (!isMyTurn(view, mySeat)) return { enabled: false, count: 0 };
  return { enabled: true, count: view.pendingDraw > 0 ? view.pendingDraw : 1 };
}

// ---------- Turn timer ----------

/** Whole seconds left until `deadline` (epoch ms), clamped at 0. null = no timer. */
export function secondsLeft(deadline, now) {
  if (!deadline || deadline <= 0) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** 0..1 of the turn that is left, for the ring/bar. */
export function timerFraction(deadline, turnSeconds, now) {
  if (!deadline || !turnSeconds) return null;
  return Math.max(0, Math.min(1, (deadline - now) / (turnSeconds * 1000)));
}

// ---------- Seats ----------

export function playersInSeatOrder(players) {
  const list = [];
  if (players && typeof players.forEach === 'function') players.forEach((p) => list.push(p));
  return list.sort((a, b) => a.seatIndex - b.seatIndex);
}

/** Order the OTHER seats starting from the one that plays right after me, so the table reads like it does in real life. */
export function opponentsInPlayOrder(seats, mySeat, direction = 1) {
  const others = seats.filter((p) => p.seatIndex !== mySeat);
  const n = seats.length;
  const dir = direction === -1 ? -1 : 1;
  return others.sort((a, b) => ((((a.seatIndex - mySeat) * dir) % n) + n) % n - ((((b.seatIndex - mySeat) * dir) % n) + n) % n);
}

/** A badge for a seat: 'you' | 'bot' | 'autopilot' | 'away' | null. Mirrors PlayerSchema. */
export function seatBadge(player, mySeat) {
  if (!player) return null;
  if (player.seatIndex === mySeat) return player.autopilot ? 'autopilot' : 'you';
  if (!player.occupied || (player.isBot && !player.autopilot)) return 'bot';
  if (player.autopilot) return player.autopilotReason === 'disconnect' ? 'away' : 'autopilot';
  return null;
}

// ---------- Room code, names, errors ----------

export function normalizeRoomCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);
}
export const isRoomCode = (s) => /^[A-Z]{5}$/.test(String(s ?? ''));

export function cleanName(input, fallback = '') {
  const s = String(input ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || fallback;
}

/** Colyseus/server error code -> i18n key. 4101/4102 are ours; 4212 is Colyseus "room not found"; 4213 "room locked". */
export function joinErrorKey(err) {
  const code = Number(err && (err.code ?? err.statusCode));
  if (code === 4101) return 'err_full';
  if (code === 4102) return 'err_duplicate';
  if (code === 4212) return 'err_not_found';
  if (code === 4213) return 'err_locked';
  const msg = String((err && err.message) || '').toLowerCase();
  if (msg.includes('not found') || msg.includes('invalid room')) return 'err_not_found';
  if (msg.includes('locked')) return 'err_locked';
  if (msg.includes('full')) return 'err_full';
  return 'err_connect';
}

const REJECT_KEYS = Object.freeze({
  not_your_turn: 'rej_not_your_turn',
  not_playable: 'rej_not_playable',
  must_draw: 'rej_must_draw',
  color_required: 'rej_color_required',
  unknown_card: 'rej_unknown_card',
  not_host: 'rej_not_host',
});
/** Server `rejected { action, reason }` -> i18n key (generic fallback for reasons added later). */
export function rejectKey(reason) { return REJECT_KEYS[reason] || 'rej_generic'; }

// ---------- Endpoint ----------

/**
 * Where the game server lives. Order: `?ws=` in the page URL, `localStorage['wildcard.ws']`, then same origin at
 * /game/uno-ws/ (CT 101 proxies it to the game server). `ws://localhost:2567` works for local testing.
 * Returns the http(s)/ws(s) URL the Colyseus client wants, without a trailing slash.
 */
export function resolveEndpoint({ search = '', stored = null, location = { protocol: 'https:', host: 'localhost' } } = {}) {
  const fromQuery = new URLSearchParams(search).get('ws');
  const chosen = (fromQuery || stored || '').trim();
  if (chosen) {
    if (/^(wss?|https?):\/\/[^\s/]+(\/\S*)?$/i.test(chosen)) return chosen.replace(/\/+$/, '');
    // A bare path such as "/game/uno-ws/" is resolved against the page origin.
    if (chosen.startsWith('/') && !chosen.startsWith('//')) return originOf(location) + chosen.replace(/\/+$/, '');
  }
  return originOf(location) + DEFAULT_WS_PATH.replace(/\/+$/, '');
}
const originOf = (loc) => `${loc.protocol === 'http:' ? 'ws:' : 'wss:'}//${loc.host}`;

// ---------- Reconnection token (sessionStorage) ----------

export function saveReconnect(storage, { token, roomCode, name }, now = Date.now()) {
  try { storage.setItem(RECONNECT_KEY, JSON.stringify({ token, roomCode, name, at: now })); return true; } catch { return false; }
}
export function loadReconnect(storage, now = Date.now()) {
  try {
    const raw = JSON.parse(storage.getItem(RECONNECT_KEY) || 'null');
    if (!raw || typeof raw.token !== 'string' || !raw.token || typeof raw.at !== 'number') return null;
    if (now - raw.at > RECONNECT_WINDOW_MS || now < raw.at) return null;
    return { token: raw.token, roomCode: String(raw.roomCode || ''), name: String(raw.name || ''), at: raw.at };
  } catch { return null; }
}
export function clearReconnect(storage) { try { storage.removeItem(RECONNECT_KEY); } catch { /* storage unavailable */ } }

/** Delay before reconnect attempt n (1-based): 0.5 s, 1 s, 2 s, 3 s, then every 3 s, never past the window. */
export function reconnectDelay(attempt) { return Math.min(3000, 500 * 2 ** Math.max(0, attempt - 1)); }
