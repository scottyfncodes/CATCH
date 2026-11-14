// WebSocket connection with clock sync and automatic reconnection.

import { type ClientMsg, type ServerMsg, type Traits, traitBits } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';
import type { Hand } from '../shared/pose';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'full' | 'closed' | 'error';

export function serverUrl(): string {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.hostname}:8787/ws`;
}

/** HTTP origin of the room server (for the warm-up ping). */
export function serverHttpUrl(): string {
  return serverUrl().replace(/^ws/, 'http').replace(/\/ws$/, '');
}

/** What the client knows about the server's clock. */
export interface ClockSync {
  /** serverTime ≈ performance.now() + offset */
  offset: number;
  /** The quickest round trip seen lately (it ages, so drift is tracked). */
  bestRtt: number;
  /** The round trip of the measurement the offset rests on: it can be wrong by up to half of this. */
  trust: number;
  synced: boolean;
}

export const newClock = (): ClockSync => ({ offset: 0, bestRtt: Infinity, trust: Infinity, synced: false });

/**
 * One ping come back: sent at `sent` and received at `recv` (this device's
 * clock), stamped `server` by the server in between.
 *
 * A measurement is only as good as its round trip is short. The first one
 * often arrives while the page is still busy starting the game (so it is slow,
 * and lopsided, and can be out by hundreds of milliseconds): a much tighter
 * one replaces what we had outright rather than being averaged into it.
 */
export function syncClock(c: ClockSync, sent: number, server: number, recv: number): ClockSync {
  const rtt = Math.max(0, recv - sent);
  const off = server + rtt / 2 - recv;
  const bestRtt = Math.min(c.bestRtt * 1.02 + 1, rtt);
  if (!c.synced || rtt < c.trust * 0.6) return { offset: off, bestRtt, trust: rtt, synced: true };
  // Otherwise prefer low-RTT samples (least queueing), and ease toward them.
  if (rtt <= bestRtt * 1.15) return { offset: c.offset * 0.7 + off * 0.3, bestRtt, trust: c.trust * 0.7 + rtt * 0.3, synced: true };
  // (An estimate ages: after a while a slower measurement is allowed to correct it.)
  return { ...c, bestRtt, trust: c.trust * 1.02 + 1 };
}

export class Net {
  ws: WebSocket | null = null;
  status: NetStatus = 'connecting';
  private clock = newClock();
  rtt = 0;
  private pingTimer = 0;
  private retry = 0;
  private retryTimer = 0;
  private stopped = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};

  constructor(private room: string, private hello: () => { guest: string; name: string; hand: Hand; windup: number; style: number[]; traits?: Traits }) {}

  now(): number { return performance.now() + this.clock.offset; }

  connect() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    let ws: WebSocket;
    try { ws = new WebSocket(serverUrl()); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    this.setStatus(this.retry ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      const h = this.hello();
      this.sendRaw({ t: 'hello', room: this.room, guest: h.guest, name: h.name, hand: h.hand, v: PROTOCOL_VERSION, w: h.windup, s: h.style, tr: h.traits ? traitBits(h.traits) : undefined });
      this.clock = { ...this.clock, bestRtt: Infinity, trust: Infinity };
      // A burst of pings to find the clock quickly, a few more while the game is still settling in, then a slow cadence.
      for (const ms of [0, 120, 240, 360, 480, 800, 1200, 1700, 2600, 3600]) setTimeout(() => this.ping(), ms);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { this.onPong(m.c, m.s); return; }
      if (m.t === 'welcome') {
        if (!this.clock.synced) this.clock = { ...this.clock, offset: m.now - performance.now() };
        this.retry = 0;
        this.setStatus('open');
      }
      if (m.t === 'full') { this.stopped = true; this.setStatus('full'); }
      this.onMessage(m);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) { if (this.status !== 'full') this.setStatus('closed'); return; }
      this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleRetry() {
    this.setStatus('reconnecting');
    const delay = Math.min(5000, 300 * Math.pow(1.7, this.retry++));
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  /** Reconnect now (e.g. page became visible again). */
  kick() {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState > 1) { this.retry = Math.min(this.retry, 1); this.connect(); }
    else this.ping();
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private ping() { this.sendRaw({ t: 'ping', c: performance.now() }); }

  private onPong(c: number, s: number) {
    const t = performance.now();
    const rtt = t - c;
    this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
    this.clock = syncClock(this.clock, c, s, t);
  }

  send(m: ClientMsg) {
    if (this.status !== 'open') return;
    this.sendRaw(m);
  }

  private sendRaw(m: ClientMsg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    try { this.sendRaw({ t: 'leave' }); } catch { /* ignore */ }
    this.ws?.close();
    this.ws = null;
    this.setStatus('closed');
  }
}
