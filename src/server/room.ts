// Authoritative room. Owns membership, seats, ball possession, the live
// throw, catch validation, drops, recovery and the shared streak.
// Transport-agnostic: the socket layer hands it messages and a send function,
// and tests drive it with a fake clock.

import {
  CATCH_BOBBLE,
  CATCH_GRACE_MS,
  CATCH_VALIDATION_SLACK,
  EYE_HEIGHT,
  GLOVE_REST_U,
  GLOVE_REST_V,
  MAX_PLAYERS,
  RECONNECT_GRACE_MS,
  RECOVER_DELAY_MS,
  STREAK_MILESTONES,
  THROW_SPEED_LIMIT,
} from '../shared/constants.js';
import {
  type Trajectory,
  closestApproach,
  positionAt,
  simulateFlight,
  sweptMinDistance,
  velocityAt,
} from '../shared/physics.js';
import { type Hand, type Pose, eyePosition, gloveWorld, seatLayout } from '../shared/pose.js';
import {
  Arm,
  type BallEvent,
  type BallState,
  type ClientMsg,
  type PlayerInfo,
  type ScoreState,
  type ServerMsg,
  type SnapEntry,
  classifyCatch,
  groupKeyFor,
  sanitizeName,
} from '../shared/protocol.js';
import { type Vec3, dist, len, wrapAngle } from '../shared/vec.js';
import { BotBrain } from './bot.js';

export interface Conn {
  send(msg: ServerMsg): void;
  close(code?: number, reason?: string): void;
}

export interface RecordStore {
  get(key: string): number;
  /** Raise the stored best for a group; returns the new best. */
  raise(key: string, value: number): number;
}

export class MemoryRecords implements RecordStore {
  map = new Map<string, number>();
  get(key: string) { return this.map.get(key) ?? 0; }
  raise(key: string, value: number) {
    const v = Math.max(this.get(key), Math.floor(value));
    this.map.set(key, v);
    return v;
  }
}

export interface Member {
  id: string;
  guest: string;
  name: string;
  hand: Hand;
  bot: boolean;
  joinOrder: number;
  look: number;
  conn: Conn | null;
  connected: boolean;
  disconnectedAt: number;
  pose: Pose;
  poseAt: number;
  arm: number;
  charge: number;
  catches: number;
  drops: number;
  seat: number;
  pos: Vec3;
  facing: number;
}

/** How long a disconnected holder keeps the ball before it is passed on. */
export const HOLDER_HANDOFF_MS = 6000;

let idCounter = 0;
const newId = () => (++idCounter).toString(36) + Math.random().toString(36).slice(2, 6);

const finite = (x: unknown, lo: number, hi: number, d = 0) => {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : d;
  return n < lo ? lo : n > hi ? hi : n;
};

export class Room {
  readonly code: string;
  members = new Map<string, Member>();
  ball: BallState;
  traj: Trajectory | null = null;
  streak = 0;
  sessionBest = 0;
  lastActive: number;
  /** A disconnect/leave happened during the current flight: a drop will not reset the streak. */
  private flightDisrupted = false;
  private layoutDirty = false;
  private joinCounter = 0;
  private bot: BotBrain | null = null;

  constructor(
    code: string,
    private now: () => number,
    private records: RecordStore,
    private opts: { practiceBot?: boolean } = {},
  ) {
    this.code = code;
    this.lastActive = now();
    this.ball = { phase: 'held', holder: null, tid: 0, thrower: null, t0: 0, p0: [0, 0, 0], v0: [0, 0, 0], live: false };
  }

  // ---------------------------------------------------------------- queries

  humans(): Member[] { return [...this.members.values()].filter((m) => !m.bot); }
  get isEmpty() { return this.humans().length === 0; }
  get connectedHumans() { return this.humans().filter((m) => m.connected).length; }

  groupKey(): string { return groupKeyFor(this.humans().map((m) => m.guest)); }

  score(): ScoreState {
    const key = this.groupKey();
    return { streak: this.streak, sessionBest: this.sessionBest, groupBest: this.records.get(key), groupKey: key };
  }

  playerInfo(m: Member): PlayerInfo {
    return {
      id: m.id, name: m.name, hand: m.hand, seat: m.seat, pos: m.pos, facing: m.facing,
      connected: m.connected, bot: m.bot, catches: m.catches, drops: m.drops, look: m.look,
    };
  }

  players(): PlayerInfo[] {
    return [...this.members.values()].sort((a, b) => a.seat - b.seat).map((m) => this.playerInfo(m));
  }

  snapEntries(): SnapEntry[] {
    const r = (x: number, k = 1000) => Math.round(x * k) / k;
    return [...this.members.values()].map((m) => [
      m.id, r(m.pose.yaw), r(m.pose.pitch), r(m.pose.gu), r(m.pose.gv), m.arm, r(m.charge, 100),
    ]);
  }

  // ---------------------------------------------------------------- membership

  /** Handle a hello. Returns the member or null when the room is full. */
  join(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): Member | null {
    const t = this.now();
    this.lastActive = t;
    const guest = String(msg.guest || '').slice(0, 64) || newId();
    const existing = [...this.members.values()].find((m) => !m.bot && m.guest === guest);
    if (existing) {
      // Reconnect (or a second tab with the same identity: the newer one wins).
      if (existing.conn && existing.conn !== conn) existing.conn.close(4000, 'replaced');
      existing.conn = conn;
      existing.connected = true;
      existing.name = sanitizeName(msg.name);
      existing.hand = msg.hand === 'L' ? 'L' : 'R';
      this.sendWelcome(existing);
      this.broadcastRoster();
      return existing;
    }
    if (this.humans().length >= MAX_PLAYERS) {
      conn.send({ t: 'full', room: this.code, max: MAX_PLAYERS });
      return null;
    }
    const m = this.addMember({ guest, name: sanitizeName(msg.name), hand: msg.hand === 'L' ? 'L' : 'R', bot: false, conn });
    this.syncBot();
    if (!this.ball.holder && this.ball.phase === 'held') this.giveBall(m.id);
    this.relayout();
    this.sendWelcome(m);
    this.broadcastRoster(m.id);
    return m;
  }

  private addMember(o: { guest: string; name: string; hand: Hand; bot: boolean; conn: Conn | null }): Member {
    const used = new Set([...this.members.values()].map((m) => m.look));
    let look = 0;
    while (used.has(look)) look++;
    const m: Member = {
      id: o.bot ? 'coach' : newId(), guest: o.guest, name: o.name, hand: o.hand, bot: o.bot,
      joinOrder: this.joinCounter++, look, conn: o.conn, connected: true, disconnectedAt: 0,
      pose: { yaw: 0, pitch: 0, gu: GLOVE_REST_U, gv: GLOVE_REST_V }, poseAt: this.now(),
      arm: Arm.Idle, charge: 0, catches: 0, drops: 0, seat: 0, pos: [0, 0, 0], facing: 0,
    };
    this.members.set(m.id, m);
    return m;
  }

  disconnect(id: string, conn: Conn) {
    const m = this.members.get(id);
    if (!m || m.conn !== conn) return;
    m.conn = null;
    m.connected = false;
    m.disconnectedAt = this.now();
    if (this.ball.phase === 'flight') this.flightDisrupted = true;
    this.broadcastRoster();
  }

  leave(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (this.ball.phase === 'flight') this.flightDisrupted = true;
    this.syncBot();
    if (this.ball.phase === 'held' && this.ball.holder === id) {
      const next = this.nearestConnected(m.pos);
      this.ball.holder = next?.id ?? null;
      this.relayout();
      this.broadcastBall(next ? { k: 'recover', by: next.id, from: m.pos } : undefined);
    } else {
      this.relayout();
    }
    this.broadcastRoster();
  }

  /** Coach joins a lone player for practice and leaves when a friend arrives. */
  private syncBot() {
    if (this.opts.practiceBot === false) return;
    const humans = this.humans().length;
    const botMember = this.members.get('coach');
    if (humans === 1 && !botMember) {
      this.addMember({ guest: 'coach', name: 'Coach', hand: 'R', bot: true, conn: null });
      this.bot = new BotBrain();
    } else if (humans !== 1 && botMember) {
      this.members.delete('coach');
      this.bot = null;
      if (this.ball.phase === 'held' && this.ball.holder === 'coach') {
        const h = this.humans().find((x) => x.connected) ?? this.humans()[0];
        this.ball.holder = h?.id ?? null;
        if (h) this.broadcastBall({ k: 'recover', by: h.id, from: botMember.pos });
      } else if (this.ball.phase === 'flight') {
        this.flightDisrupted = true;
      }
    }
  }

  private relayout() {
    if (this.ball.phase !== 'held') { this.layoutDirty = true; return; }
    this.layoutDirty = false;
    const list = [...this.members.values()].sort((a, b) => a.joinOrder - b.joinOrder);
    const seats = seatLayout(list.length);
    list.forEach((m, i) => {
      m.seat = i;
      m.pos = seats[i].pos;
      m.facing = seats[i].yaw;
      if (m.bot) m.pose.yaw = m.facing;
    });
  }

  private sendWelcome(m: Member) {
    m.conn?.send({
      t: 'welcome', you: m.id, room: this.code, now: this.now(),
      players: this.players(), ball: this.ball, score: this.score(), poses: this.snapEntries(),
    });
  }

  private broadcast(msg: ServerMsg, except?: string) {
    for (const m of this.members.values()) if (m.conn && m.id !== except) m.conn.send(msg);
  }

  private broadcastRoster(except?: string) {
    this.broadcast({ t: 'roster', players: this.players(), score: this.score() }, except);
  }

  private broadcastBall(ev?: BallEvent, withPlayers = false) {
    const msg: ServerMsg = { t: 'ball', ball: { ...this.ball }, score: this.score(), ev };
    if (withPlayers) msg.players = this.players();
    this.broadcast(msg);
  }

  private nearestConnected(p: Vec3): Member | null {
    let best: Member | null = null;
    let bd = Infinity;
    for (const m of this.members.values()) {
      if (!m.connected) continue;
      // Prefer people over the practice bot when distances are similar.
      const d = dist(m.pos, [p[0], 0, p[2]]) + (m.bot ? 1.5 : 0);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  private giveBall(id: string) {
    this.ball = { phase: 'held', holder: id, tid: this.ball.tid, thrower: null, t0: 0, p0: [0, 0, 0], v0: [0, 0, 0], live: false };
    this.traj = null;
  }

  // ---------------------------------------------------------------- messages

  handle(id: string, msg: ClientMsg) {
    const m = this.members.get(id);
    if (!m) return;
    this.lastActive = this.now();
    switch (msg.t) {
      case 'st': {
        const p = msg.p;
        if (!Array.isArray(p)) return;
        m.pose = {
          yaw: wrapAngle(finite(p[0], -10, 10)),
          pitch: finite(p[1], -1.45, 1.45),
          gu: finite(p[2], -1.2, 1.2, GLOVE_REST_U),
          gv: finite(p[3], -1.2, 1.2, GLOVE_REST_V),
        };
        m.arm = finite(p[4], 0, 3) | 0;
        m.charge = finite(p[5], 0, 1);
        m.poseAt = this.now();
        return;
      }
      case 'throw': return this.onThrow(m, msg);
      case 'catch': return this.onCatch(m, msg);
      case 'prof':
        m.name = sanitizeName(msg.name);
        m.hand = msg.hand === 'L' ? 'L' : 'R';
        this.broadcastRoster();
        return;
      case 'rec': {
        const key = this.groupKey();
        if (msg.key !== key) return;
        const before = this.records.get(key);
        const after = this.records.raise(key, finite(msg.best, 0, 1e6));
        if (after !== before) this.broadcastRoster();
        return;
      }
      case 'leave': return this.leave(id);
    }
  }

  private onThrow(m: Member, msg: Extract<ClientMsg, { t: 'throw' }>) {
    const b = this.ball;
    if (b.phase !== 'held' || b.holder !== m.id) return;
    if (msg.tid !== b.tid + 1) return; // duplicate or stale
    const v: Vec3 = [finite(msg.v?.[0], -50, 50), finite(msg.v?.[1], -50, 50), finite(msg.v?.[2], -50, 50)];
    const p: Vec3 = [finite(msg.p?.[0], -100, 100), finite(msg.p?.[1], 0, 4), finite(msg.p?.[2], -100, 100)];
    const speed = len(v);
    if (speed > THROW_SPEED_LIMIT || speed < 1) return;
    if (dist(p, eyePosition(m.pos)) > 0.95) return;
    const t = this.now();
    const rt = finite(msg.rt, t - 300, t, t);
    this.launch(m.id, p, v, rt, true);
    this.broadcastBall({ k: 'throw', by: m.id, speed });
  }

  /** Start a flight (live throw, or a dead deflection). */
  private launch(thrower: string, p: Vec3, v: Vec3, t0: number, live: boolean) {
    this.traj = simulateFlight(p, v);
    this.ball = {
      phase: live ? 'flight' : 'loose', holder: null, tid: live ? this.ball.tid + 1 : this.ball.tid,
      thrower, t0, p0: p, v0: v, live,
    };
    if (live) this.flightDisrupted = false;
  }

  private onCatch(m: Member, msg: Extract<ClientMsg, { t: 'catch' }>) {
    const b = this.ball;
    if (b.phase !== 'flight' || !b.live || !this.traj || msg.tid !== b.tid) return;
    const at = finite(msg.at, b.t0, b.t0 + 20_000);
    const tr = this.traj;
    const tSec = (at - b.t0) / 1000;
    const self = b.thrower === m.id;
    if (tSec < (self ? 0.25 : 0.05)) return;
    if (tSec > tr.groundT + 0.01) return;
    if (at > this.now() + 150) return;
    const pose: Pose = {
      yaw: finite(msg.pose?.[0], -10, 10), pitch: finite(msg.pose?.[1], -1.45, 1.45),
      gu: finite(msg.pose?.[2], -1.2, 1.2), gv: finite(msg.pose?.[3], -1.2, 1.2),
    };
    // Loose plausibility check against the streamed pose (friends game, not esports).
    if (this.now() - m.poseAt < 600 && Math.abs(wrapAngle(pose.yaw - m.pose.yaw)) > 1.1) return;
    const g = gloveWorld(m.pos, pose);
    const near = sweptMinDistance(tr, Math.max(0, tSec - 0.03), Math.min(tr.groundT, tSec + 0.03), g, g);
    if (near.dist > CATCH_BOBBLE + CATCH_VALIDATION_SLACK) return;
    const vel = velocityAt(tr, near.t);
    const speed = len(vel);
    let q = classifyCatch(near.dist, speed);
    if (q === null) q = 'bobble';
    const pos = positionAt(tr, near.t);
    this.resolveCatch(m, q, speed, b.t0 + near.t * 1000, pos, vel, self);
  }

  private resolveCatch(m: Member, q: ReturnType<typeof classifyCatch>, speed: number, at: number, pos: Vec3, vel: Vec3, self: boolean) {
    if (q === null) return;
    if (q === 'deflect') {
      // Off the heel of the glove and out: the throw is dead.
      const s = 0.22;
      const side = (this.ball.tid % 2 ? 1 : -1) * 1.4;
      const v: Vec3 = [-vel[0] * s + side * Math.cos(m.facing), 2.6, -vel[2] * s - side * Math.sin(m.facing)];
      this.launch(m.id, pos, v, at, false);
      const disrupted = this.flightDisrupted;
      if (!disrupted) { this.streak = 0; m.drops++; }
      this.broadcastBall({ k: 'deflect', by: m.id, speed, at, pos }, true);
      return;
    }
    this.giveBall(m.id);
    let milestone: number | undefined;
    if (!self) {
      this.streak++;
      m.catches++;
      if (STREAK_MILESTONES.includes(this.streak)) milestone = this.streak;
      this.sessionBest = Math.max(this.sessionBest, this.streak);
      this.records.raise(this.groupKey(), this.streak);
    }
    if (this.layoutDirty) this.relayout();
    this.broadcastBall({ k: 'catch', by: m.id, q, speed, at, pos, self, milestone }, true);
    if (m.bot) this.bot?.onGotBall(this.now());
  }

  // ---------------------------------------------------------------- tick

  tick() {
    const t = this.now();
    const b = this.ball;
    if (this.bot) this.botTick(t);

    if (b.phase === 'flight' && b.live && this.traj && t >= b.t0 + this.traj.groundT * 1000 + CATCH_GRACE_MS) {
      this.resolveDrop();
    } else if (b.phase !== 'held' && this.traj && t >= b.t0 + this.traj.restT * 1000 + RECOVER_DELAY_MS) {
      this.recover();
    }

    // Disconnected players eventually give up their spot.
    for (const m of [...this.members.values()]) {
      if (!m.bot && !m.connected && t - m.disconnectedAt > RECONNECT_GRACE_MS) this.leave(m.id);
    }
    // Don't make everyone wait on a dropped connection: after a few seconds the ball
    // goes to the nearest connected player (the absent player keeps their spot).
    if (this.ball.phase === 'held' && this.ball.holder) {
      const h = this.members.get(this.ball.holder);
      if (h && !h.connected && t - h.disconnectedAt > HOLDER_HANDOFF_MS) {
        const next = this.nearestConnected(h.pos);
        if (next) {
          this.ball.holder = next.id;
          this.broadcastBall({ k: 'recover', by: next.id, from: [h.pos[0], 0.04, h.pos[2]] });
          if (next.bot) this.bot?.onGotBall(t);
        }
      }
    }
    // A held ball with a vanished holder goes to someone present.
    if (b.phase === 'held' && b.holder && !this.members.has(b.holder)) {
      const next = this.nearestConnected([0, 0, 0]);
      this.ball.holder = next?.id ?? null;
      this.broadcastBall();
    }
    if (this.ball.phase === 'held' && !this.ball.holder) {
      const next = [...this.members.values()].find((m) => m.connected && !m.bot) ?? null;
      if (next) { this.ball.holder = next.id; this.broadcastBall({ k: 'recover', by: next.id, from: [0, 0, 0] }); }
    }
  }

  snapshot() {
    if (this.connectedHumans === 0) return;
    this.broadcast({ t: 'snap', s: this.now(), e: this.snapEntries() });
  }

  /** Who the throw was meant for: the player the ball came closest to. */
  private intendedReceiver(): { m: Member | null; d: number } {
    const tr = this.traj!;
    let best: Member | null = null;
    let bd = Infinity;
    for (const m of this.members.values()) {
      if (m.id === this.ball.thrower) continue;
      const chest: Vec3 = [m.pos[0], EYE_HEIGHT - 0.35, m.pos[2]];
      const ca = closestApproach(tr, chest);
      if (ca.dist < bd) { bd = ca.dist; best = m; }
    }
    return { m: best, d: bd };
  }

  private resolveDrop() {
    const tr = this.traj!;
    const { m: recv, d } = this.intendedReceiver();
    // Within reach-ish of someone: their drop. Way off: the thrower's errant throw.
    const blame = recv && d <= 2.6 ? recv : this.members.get(this.ball.thrower ?? '') ?? null;
    const isVoid = this.flightDisrupted || (blame !== null && !blame.connected);
    if (!isVoid) {
      this.streak = 0;
      if (blame) blame.drops++;
    }
    const at = this.ball.t0 + tr.groundT * 1000;
    this.ball = { ...this.ball, phase: 'loose', live: false };
    this.broadcastBall({ k: 'drop', by: blame?.id ?? null, void: isVoid, at }, true);
  }

  private recover() {
    const tr = this.traj!;
    const from = tr.restPos;
    const next = this.nearestConnected(from);
    this.giveBall(next?.id ?? '');
    if (!next) this.ball.holder = null;
    this.relayout();
    this.broadcastBall(next ? { k: 'recover', by: next.id, from } : undefined, true);
    if (next?.bot) this.bot?.onGotBall(this.now());
  }

  // ---------------------------------------------------------------- practice bot

  private botTick(t: number) {
    const coach = this.members.get('coach');
    const human = this.humans()[0];
    if (!coach || !this.bot) return;
    const act = this.bot.update(t, coach, human ?? null, this.ball, this.traj, this.streak);
    if (!act) return;
    if (act.kind === 'throw') {
      if (this.ball.phase !== 'held' || this.ball.holder !== coach.id) return;
      this.launch(coach.id, act.p, act.v, t, true);
      this.broadcastBall({ k: 'throw', by: coach.id, speed: len(act.v) });
    } else if (act.kind === 'catch') {
      const b = this.ball;
      if (b.phase !== 'flight' || !b.live || !this.traj || b.tid !== act.tid) return;
      const vel = velocityAt(this.traj, act.tSec);
      const pos = positionAt(this.traj, act.tSec);
      this.resolveCatch(coach, act.q, len(vel), b.t0 + act.tSec * 1000, pos, vel, false);
    }
  }
}
