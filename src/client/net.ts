// WebSocket connection with clock sync and automatic reconnection.

import type { ClientMsg, ServerMsg } from '../shared/protocol';
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

export class Net {
  ws: WebSocket | null = null;
  status: NetStatus = 'connecting';
  /** serverTime ≈ performance.now() + offset */
  private offset = 0;
  private bestRtt = Infinity;
  private synced = false;
  rtt = 0;
  private pingTimer = 0;
  private retry = 0;
  private retryTimer = 0;
  private stopped = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: NetStatus) => void = () => {};

  constructor(private room: string, private hello: () => { guest: string; name: string; hand: Hand }) {}

  now(): number { return performance.now() + this.offset; }

  connect() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    let ws: WebSocket;
    try { ws = new WebSocket(serverUrl()); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    this.setStatus(this.retry ? 'reconnecting' : 'connecting');
    ws.onopen = () => {
      const h = this.hello();
      this.sendRaw({ t: 'hello', room: this.room, guest: h.guest, name: h.name, hand: h.hand, v: PROTOCOL_VERSION });
      this.bestRtt = Infinity;
      // Burst of pings to converge the clock quickly, then a slow cadence.
      for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { this.onPong(m.c, m.s); return; }
      if (m.t === 'welcome') {
        if (!this.synced) this.offset = m.now - performance.now();
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
    // Prefer low-RTT samples (least queueing); let the estimate age so drift is tracked.
    this.bestRtt = Math.min(this.bestRtt * 1.02 + 1, rtt);
    if (rtt <= this.bestRtt * 1.15 || !this.synced) {
      const off = s + rtt / 2 - t;
      this.offset = this.synced ? this.offset * 0.7 + off * 0.3 : off;
      this.synced = true;
    }
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
