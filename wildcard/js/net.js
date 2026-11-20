// WILDCARD // 2077 client: connection layer over the vendored @colyseus/sdk (0.17, see ../vendor/).
// - create / join by 5-letter code,
// - the reconnection token is kept in sessionStorage and a dropped socket goes through the server's
//   allowReconnection (30 s hold, a bot plays the seat meanwhile),
// - everything the UI needs arrives through callbacks; nothing here touches the DOM.
//
// `loadSdk` is injected so tests (and a missing vendor file) never need the real library.

import {
  RECONNECT_WINDOW_MS, clearReconnect, loadReconnect, reconnectDelay, saveReconnect,
} from './logic.js';

/** Default loader: the vendored single-file ESM build of @colyseus/sdk. Throws when it has not been vendored yet. */
export const loadVendoredSdk = () => import('../vendor/colyseus-sdk.mjs?v=20261120b');

const CONSENTED_CLOSE = 4000;

export class WildcardNet {
  /**
   * @param {object} o
   * @param {() => Promise<{Client: new (url: string) => any}>} o.loadSdk
   * @param {string} o.endpoint        http(s):// or ws(s):// URL of the game server (see resolveEndpoint)
   * @param {Storage} o.storage        sessionStorage in the browser
   * @param {object} o.on              callbacks: state(room), welcome(msg), event(msg), rejected(msg), status(s)
   * @param {() => number} [o.now]
   * @param {(fn: () => void, ms: number) => any} [o.setTimer]
   */
  constructor({ loadSdk, endpoint, storage, on, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
    this.loadSdk = loadSdk;
    this.endpoint = endpoint;
    this.storage = storage;
    this.on = on;
    this.now = now;
    this.setTimer = setTimer;
    this.client = null;
    this.room = null;
    this.name = '';
    this.leaving = false;
    this.reconnecting = false;
  }

  async ensureClient() {
    if (this.client) return this.client;
    let sdk;
    try { sdk = await this.loadSdk(); } catch (e) {
      const err = new Error('sdk_missing');
      err.code = 'sdk_missing';
      throw err;
    }
    this.client = new sdk.Client(this.endpoint);
    return this.client;
  }

  /** Create a private room. options: { seats, stacking, turnSeconds }. */
  async create(name, options) {
    this.name = name;
    this.on.status({ state: 'connecting' });
    const client = await this.ensureClient();
    const room = await client.create('wildcard', { name, ...options });
    this.attach(room);
    return room;
  }

  /** Join by the 5-letter room code (= Colyseus roomId). */
  async join(name, code) {
    this.name = name;
    this.on.status({ state: 'connecting' });
    const client = await this.ensureClient();
    const room = await client.joinById(code, { name });
    this.attach(room);
    return room;
  }

  /** After a page reload: take the seat back with the token from sessionStorage, if it is still inside the hold. */
  async resumeFromStorage() {
    const saved = loadReconnect(this.storage, this.now());
    if (!saved) return false;
    this.name = saved.name;
    this.leaving = false;
    this.reconnectFrom(saved.token, saved.at);
    return true;
  }

  attach(room) {
    this.room = room;
    this.leaving = false;
    this.remember();
    room.onMessage('welcome', (m) => this.on.welcome(m));
    room.onMessage('event', (m) => this.on.event(m));
    room.onMessage('rejected', (m) => this.on.rejected(m));
    room.onStateChange(() => this.on.state(room));
    room.onLeave((code) => this.handleLeave(code));
    this.on.status({ state: 'connected' });
    this.on.state(room);
  }

  remember() {
    const room = this.room;
    if (!room || !room.reconnectionToken) return;
    saveReconnect(this.storage, { token: room.reconnectionToken, roomCode: room.roomId, name: this.name }, this.now());
  }

  handleLeave(code) {
    this.room = null;
    if (this.leaving || code === CONSENTED_CLOSE) {
      clearReconnect(this.storage);
      this.on.status({ state: 'left' });
      return;
    }
    const saved = loadReconnect(this.storage, this.now());
    if (!saved) { this.on.status({ state: 'failed' }); return; }
    this.reconnectFrom(saved.token, saved.at);
  }

  /** Retry client.reconnect(token) with a growing delay until the server's hold would have run out. */
  reconnectFrom(token, since) {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const deadline = since + RECONNECT_WINDOW_MS;
    let attempt = 0;
    const tryOnce = async () => {
      if (this.leaving) { this.reconnecting = false; return; }
      attempt += 1;
      this.on.status({ state: 'reconnecting', attempt, secondsLeft: Math.max(0, Math.ceil((deadline - this.now()) / 1000)) });
      try {
        const client = await this.ensureClient();
        const room = await client.reconnect(token);
        this.reconnecting = false;
        this.attach(room);
        this.on.status({ state: 'reconnected' });
      } catch (e) {
        if (this.now() >= deadline) {
          this.reconnecting = false;
          clearReconnect(this.storage);
          this.on.status({ state: 'failed' });
          return;
        }
        this.setTimer(tryOnce, reconnectDelay(attempt));
      }
    };
    tryOnce();
  }

  send(type, payload = {}) {
    if (this.room) this.room.send(type, payload);
  }

  /** Leave on purpose: the seat becomes a bot seat at once and the token is dropped. */
  async leave() {
    this.leaving = true;
    clearReconnect(this.storage);
    const room = this.room;
    this.room = null;
    if (room) { try { await room.leave(true); } catch { /* already closed */ } }
    this.on.status({ state: 'left' });
  }
}
