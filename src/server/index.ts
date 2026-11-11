// CATCH. multiplayer room server: a single long-lived Node process that holds
// rooms in memory and speaks WebSocket at /ws. Deploy anywhere that runs a
// persistent Node process (Render, Fly, Railway…). Not for serverless.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { SERVER_TICK_HZ, SNAPSHOT_HZ } from '../shared/constants.js';
import { type ClientMsg, type ServerMsg, PROTOCOL_VERSION, isRoomCode } from '../shared/protocol.js';
import { type Conn, MemoryRecords, Room } from './room.js';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || '';
const ROOM_IDLE_MS = 15 * 60_000;
const MAX_ROOMS = 500;

// ---- records: memory, optionally mirrored to a JSON file when DATA_DIR is set.
const records = new MemoryRecords();
const recordsFile = DATA_DIR ? join(DATA_DIR, 'records.json') : '';
if (recordsFile && existsSync(recordsFile)) {
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(recordsFile, 'utf8')) as Record<string, number>)) records.map.set(k, v);
  } catch (e) { console.warn('[catch] could not read records', e); }
}
let recordsDirty = false;
const baseRaise = records.raise.bind(records);
records.raise = (k, v) => { const before = records.get(k); const r = baseRaise(k, v); if (r !== before) recordsDirty = true; return r; };
setInterval(() => {
  if (!recordsDirty || !recordsFile) return;
  recordsDirty = false;
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(recordsFile, JSON.stringify(Object.fromEntries(records.map))); }
  catch (e) { console.warn('[catch] could not write records', e); }
}, 5000).unref();

// ---- rooms
const rooms = new Map<string, Room>();
const now = () => Date.now();

function getRoom(code: string): Room | null {
  let r = rooms.get(code);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = new Room(code, now, records);
    rooms.set(code, r);
  }
  return r;
}

setInterval(() => {
  for (const [code, r] of rooms) {
    r.tick();
    if (r.isEmpty && now() - r.lastActive > 60_000) rooms.delete(code);
    else if (r.connectedHumans === 0 && now() - r.lastActive > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 1000 / SERVER_TICK_HZ);

setInterval(() => { for (const r of rooms.values()) r.snapshot(); }, 1000 / SNAPSHOT_HZ);

// ---- http
const started = new Date().toISOString();
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    let players = 0;
    for (const r of rooms.values()) players += r.connectedHumans;
    res.end(JSON.stringify({ ok: true, service: 'catch-server', protocol: PROTOCOL_VERSION, rooms: rooms.size, players, started }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('CATCH. room server. Connect via WebSocket at /ws\n');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const origin = req.headers.origin || '';
  if (ALLOWED.length && !ALLOWED.some((a) => origin === a || (a.startsWith('*.') && origin.endsWith(a.slice(1))))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let memberId: string | null = null;
  let alive = true;
  const conn: Conn = {
    send(msg: ServerMsg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    close(code, reason) { try { ws.close(code, reason); } catch { /* ignore */ } },
  };
  ws.on('pong', () => { alive = true; });
  const hb = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, 15_000);

  ws.on('message', (data) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ping') { conn.send({ t: 'pong', c: msg.c, s: now() }); return; }
    if (msg.t === 'hello') {
      if (room) return;
      if (msg.v !== PROTOCOL_VERSION) { conn.send({ t: 'error', msg: 'version' }); ws.close(4002, 'version'); return; }
      const code = String(msg.room || '').toUpperCase();
      if (!isRoomCode(code)) { conn.send({ t: 'error', msg: 'bad-room' }); ws.close(); return; }
      const r = getRoom(code);
      if (!r) { conn.send({ t: 'error', msg: 'server-busy' }); ws.close(); return; }
      const m = r.join(conn, msg);
      if (!m) { ws.close(4001, 'full'); return; }
      room = r;
      memberId = m.id;
      return;
    }
    if (room && memberId) room.handle(memberId, msg);
  });

  ws.on('close', () => {
    clearInterval(hb);
    if (room && memberId) room.disconnect(memberId, conn);
  });
  ws.on('error', () => { /* close follows */ });
});

server.listen(PORT, () => console.log(`[catch] room server on :${PORT}`));
