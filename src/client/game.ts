// One play session in a room: networking, prediction, controls, rendering
// and audio, seen in third person. The server is authoritative; this predicts
// the local player's own throws and catches so they feel instant, and smooths
// everyone else.

import * as THREE from 'three';
import {
  BALL_RADIUS, CATCH_PERFECT, CATCH_WEB, CLIENT_STATE_HZ, MOVE_RADIUS, RUN_ACCEL, RUN_SPEED, WALK_SPEED,
} from '../shared/constants';
import {
  type Trajectory, closestApproach, positionAt, simulateFlight, solveThrowTo, sweptMinDistance, velocityAt,
} from '../shared/physics';
import {
  type Hand, type Pose, bodyToWorld, clampReach, gloveReady, gloveWorld, interceptPlan, lookAngles, releasePoint,
} from '../shared/pose';
import {
  Arm, type BallEvent, type BallState, type CatchQuality, type PlayerInfo, type ScoreState, type ServerMsg, type SnapEntry, catchGrade, classifyCatch,
} from '../shared/protocol';
import { type Vec3, clamp, dist, lerp, wrapAngle } from '../shared/vec';
import { audio } from './audio';
import { haptic } from './haptics';
import { type Aim, Controls, DEAD, FULL_PULL } from './input';
import { Net, type NetStatus } from './net';
import { AimArc } from './scene/aim';
import { Avatar } from './scene/avatar';
import { CameraRig } from './scene/camera';
import { buildBall, contactShadow } from './scene/gear';
import { type World, buildWorld } from './scene/world';
import { prefs, raiseRecord, recordFor } from './storage';

interface Snap { t: number; x: number; z: number; yaw: number; g: Vec3; arm: number; charge: number }

interface Remote {
  info: PlayerInfo;
  avatar: Avatar | null;
  snaps: Snap[];
  label: HTMLDivElement | null;
  pose: Pose;
  arm: number;
  charge: number;
}

export interface GameEvents {
  status(s: NetStatus): void;
  roster(players: PlayerInfo[], me: string | null): void;
  score(s: ScoreState, ev?: BallEvent): void;
  /** Gameplay moments the tutorial listens for. */
  moment(kind: 'move' | 'catch' | 'throw' | 'drop' | 'incoming' | 'holding' | 'aim'): void;
  toast(text: string): void;
}

const tmpV = new THREE.Vector3();
const INTERP_MS = 110;
/** Aim sensitivity: metres the ring moves sideways per pixel of sideways pull. */
const AIM_X_PER_PX = 0.012;
/** The aim ring's height range on the glove plane: soft pull = low, full pull = overhead. */
const AIM_H_LOW = 0.15;
const AIM_H_SPAN = 2.55;
/** How far off the glove a last-instant reflex can still reach (it costs grade). */
const LUNGE_REACH = 0.42;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly rig = new CameraRig();
  private world: World;
  private scene: THREE.Scene;
  readonly net: Net;
  private controls: Controls;
  private ballMesh: THREE.Mesh;
  private ballBlur: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private aimArc = new AimArc();
  private labels: HTMLElement;
  private raf = 0;
  private lastFrame = 0;
  private running = false;

  me: string | null = null;
  players = new Map<string, Remote>();
  ball: BallState = { phase: 'held', holder: null, tid: 0, thrower: null, t0: 0, p0: [0, 0, 0], v0: [0, 0, 0], live: false };
  traj: Trajectory | null = null;
  score: ScoreState = { streak: 0, sessionBest: 0, groupBest: 0, groupKey: '' };

  // Local player: a body on the grass.
  hand: Hand;
  private myAvatar: Avatar | null = null;
  pos: Vec3 = [0, 0, 6];
  private vel = { x: 0, z: 0 };
  yaw = 0;
  /** Glove offset from the feet (world axes), and where it is reaching for. */
  glove: Vec3 = [0, 1.18, -0.4];
  private gloveT: Vec3 = [0, 1.18, -0.4];
  /** Where you hold your glove (body space: right, up, forward): your friend's target. */
  private gloveSet: Vec3 = [-0.2, 1.18, 0.42];
  private gloveDragging = false;
  /** Where your feet are headed when you push the glove past your reach. */
  private stepTo: Vec3 | null = null;
  private lungeTid = -1;
  private keys = new Set<string>();
  private lastInputAt = 0;
  private prevGloveWorld: Vec3 | null = null;
  private prevPose: Pose | null = null;
  private aim: Aim | null = null;
  private aimStartAt = 0;
  private aimPartnerId: string | null = null;
  private aimTraj: Trajectory | null = null;
  /** Where the ball would cross your friend's glove plane right now (the aim ring). */
  private aimRing: Vec3 | null = null;
  private releasedAt = -1;
  private lastSent = 0;
  private partnerId: string | null = null;
  private home: Vec3 = [0, 0, 6];

  // Prediction / presentation state.
  private predThrowAt = 0;
  private claimedTid = -1;
  private lastCheckT = 0;
  private lastCheckTid = -1;
  private localCatch: { tid: number; q: CatchQuality; at: number } | null = null;
  private catchShow: { by: string; perf: number } | null = null;
  private holdReadyAt = 0;
  private recoverAnim: { from: Vec3; perf: number } | null = null;
  private flightLag = 0;
  private flightRecvAt = 0;
  private trajKey = '';
  private impactIdx = 0;
  private pinned: { id: string; until: number } | null = null;
  private incomingTid = -1;
  private sentRecordFor = '';
  private lastCatchPerf = 0;
  private pixelRatio: number;
  private frameTimes: number[] = [];
  /** Test hook: run under incoming throws automatically (never set in normal play). */
  autoMove = false;
  /** Test hook: no hand tremor on the aim. */
  steadyAim = false;
  /** Test hook: skip drawing (software-GL CI is too slow for real-time touch input). */
  renderEnabled = true;

  constructor(private root: HTMLElement, renderer: THREE.WebGLRenderer, touchLayer: HTMLElement, readonly room: string, private ev: GameEvents) {
    this.hand = prefs().hand;
    const lowSpec = (navigator.hardwareConcurrency || 4) <= 2;
    this.renderer = renderer;
    this.pixelRatio = renderer.getPixelRatio();
    this.renderer.shadowMap.enabled = !lowSpec;
    this.world = buildWorld(lowSpec);
    this.scene = this.world.scene;
    this.scene.add(this.rig.camera, this.aimArc.group);

    this.ballMesh = buildBall();
    this.ballBlur = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#f4efe4', transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.ballShadow = contactShadow(0.3);
    this.scene.add(this.ballMesh, this.ballBlur, this.ballShadow);

    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    root.appendChild(this.labels);

    this.controls = new Controls(touchLayer, {
      canThrow: () => this.canThrow(),
      onAimStart: () => {
        this.aim = { power: 0, side: 0, armed: false };
        this.aimStartAt = performance.now();
        this.aimPartnerId = this.partner();
        this.ev.moment('aim');
      },
      onAim: (a) => {
        if (this.aim && a.power > this.aim.power + 0.15) audio.creak(a.power);
        this.aim = a;
      },
      onThrow: (a) => this.release(a),
      onAimCancel: () => { this.aim = null; },
      onGlove: (dx, dy, speed) => this.moveGlove(dx, dy, speed),
      onGloveActive: (a) => { this.gloveDragging = a; this.lastInputAt = performance.now(); },
    });

    this.net = new Net(room, () => ({ guest: prefs().guest, name: prefs().name, hand: prefs().hand }));
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onStatus = (s) => this.ev.status(s);

    this.onResize();
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  start() {
    this.net.connect();
    this.running = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.net.close();
    this.controls.enabled = false;
    this.controls.reset();
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    audio.ball({ active: false, pos: [0, 0, 0], vel: [0, 0, 0], airborne: false, rolling: 0 });
    for (const p of this.players.values()) { p.avatar?.dispose(); p.label?.remove(); }
    this.players.clear();
    this.myAvatar?.dispose();
    this.labels.remove();
    this.aimArc.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of mats) { (mt as THREE.MeshStandardMaterial).map?.dispose(); mt.dispose(); }
      }
    });
    this.renderer.renderLists.dispose();
  }

  setHand(h: Hand) {
    this.hand = h;
    this.net.send({ t: 'prof', name: prefs().name, hand: h });
  }

  setName(name: string) { this.net.send({ t: 'prof', name, hand: this.hand }); }

  // ------------------------------------------------------------------ view

  private onResize = () => {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.aspect = w / h;
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') {
      audio.resume();
      this.net.kick();
      this.lastFrame = performance.now();
    } else {
      this.controls.reset();
      this.keys.clear();
      audio.suspend();
    }
  };

  /** Desktop: arrow keys / WASD move. */
  private onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.type === 'keydown') this.keys.add(k); else this.keys.delete(k);
    if (this.keys.size) { this.lastInputAt = performance.now(); this.ev.moment('move'); }
  };

  myInfo(): PlayerInfo | null { return this.me ? this.players.get(this.me)?.info ?? null : null; }
  private myPose(): Pose { return { x: this.pos[0], z: this.pos[2], yaw: this.yaw, g: [this.glove[0], this.glove[1], this.glove[2]] }; }

  /** Feet position of any player (you included). */
  private feetOf(id: string | null): Vec3 | null {
    if (!id) return null;
    if (id === this.me) return this.pos;
    const p = this.players.get(id);
    if (!p) return null;
    return p.avatar ? [p.avatar.position.x, 0, p.avatar.position.z] : [p.pose.x, 0, p.pose.z];
  }

  private avatarOf(id: string | null): Avatar | null {
    if (!id) return null;
    if (id === this.me) return this.myAvatar;
    return this.players.get(id)?.avatar ?? null;
  }

  /** Who you're playing with right now (the camera frames you and them). */
  private partner(): string | null {
    const others = [...this.players.values()].filter((p) => p.info.id !== this.me);
    if (!others.length) return null;
    const b = this.ball;
    let want: string | null = null;
    if (b.phase === 'flight' && b.thrower && b.thrower !== this.me) want = b.thrower;
    else if (b.phase === 'held' && b.holder && b.holder !== this.me) want = b.holder;
    else if (b.phase === 'flight' && b.thrower === this.me && this.traj) {
      // Whoever your throw is heading for.
      let best = Infinity;
      for (const o of others) {
        const f = this.feetOf(o.info.id)!;
        const ip = interceptPlan(this.traj, 0, f[0], f[2]);
        if (ip.norm < best) { best = ip.norm; want = o.info.id; }
      }
    }
    if (want && this.players.has(want)) this.partnerId = want;
    if (!this.partnerId || !this.players.has(this.partnerId) || this.partnerId === this.me) {
      // Nearest person to you.
      let bd = Infinity;
      for (const o of others) {
        const f = this.feetOf(o.info.id)!;
        const d = Math.hypot(f[0] - this.pos[0], f[2] - this.pos[2]);
        if (d < bd) { bd = d; this.partnerId = o.info.id; }
      }
    }
    return this.partnerId;
  }

  private partnerYaw(): number {
    const f = this.feetOf(this.partner());
    if (!f) return this.yaw;
    return lookAngles(this.pos, f).yaw;
  }

  // ------------------------------------------------------------------ network

  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'welcome': {
        const first = this.me === null;
        this.me = m.you;
        this.applyPlayers(m.players);
        this.applySnap(m.now, m.poses);
        this.applyBall(m.ball, undefined);
        this.applyScore(m.score);
        if (first) {
          const mine = this.myInfo();
          if (mine) this.placeAtHome(mine, true);
        }
        break;
      }
      case 'roster':
        this.applyPlayers(m.players);
        this.applyScore(m.score);
        break;
      case 'snap': this.applySnap(m.s, m.e); break;
      case 'ball':
        if (m.players) this.applyPlayers(m.players);
        this.applyBall(m.ball, m.ev);
        this.applyScore(m.score, m.ev);
        break;
      case 'full': this.ev.toast('This room is full — 5 players max.'); break;
      case 'error':
        this.ev.toast(m.msg === 'version' ? 'CATCH. was updated. Refresh the page to play.' : m.msg === 'bad-room' ? 'That room code isn’t valid.' : 'The field is busy. Try again in a moment.');
        if (m.msg === 'version') this.net.close();
        break;
    }
  }

  private placeAtHome(info: PlayerInfo, snap: boolean) {
    this.home = [info.pos[0], 0, info.pos[2]];
    const far = Math.hypot(this.pos[0] - this.home[0], this.pos[2] - this.home[2]) > MOVE_RADIUS;
    if (snap || far) {
      this.pos = [this.home[0], 0, this.home[2]];
      this.vel = { x: 0, z: 0 };
      this.yaw = info.facing;
      this.glove = gloveReady(this.yaw, this.hand);
      this.gloveT = [...this.glove] as Vec3;
      this.prevGloveWorld = null;
      this.myAvatar?.teleport(this.pos, this.yaw);
      this.rig.reset();
    }
  }

  private applyPlayers(list: PlayerInfo[]) {
    const seen = new Set<string>();
    for (const info of list) {
      seen.add(info.id);
      let p = this.players.get(info.id);
      if (!p) {
        p = { info, avatar: null, snaps: [], label: null, pose: { x: info.pos[0], z: info.pos[2], yaw: info.facing, g: gloveReady(info.facing, info.hand) }, arm: 0, charge: 0 };
        this.players.set(info.id, p);
      }
      const moved = p.info.pos[0] !== info.pos[0] || p.info.pos[2] !== info.pos[2];
      const handChanged = p.info.hand !== info.hand;
      p.info = info;
      if (info.id === this.me) {
        if (!this.myAvatar || handChanged) {
          this.myAvatar?.dispose();
          this.hand = info.hand;
          this.myAvatar = new Avatar(this.pos, this.yaw, info.hand, info.look);
          this.scene.add(this.myAvatar.root);
        }
        if (moved) this.placeAtHome(info, false);
        continue;
      }
      if (!p.avatar || handChanged) {
        p.avatar?.dispose();
        p.avatar = new Avatar([p.pose.x, 0, p.pose.z], p.pose.yaw, info.hand, info.look);
        this.scene.add(p.avatar.root);
      }
      p.avatar.setConnected(info.connected);
      if (!p.label) {
        p.label = document.createElement('div');
        p.label.className = 'label';
        this.labels.appendChild(p.label);
      }
      p.label.textContent = info.name + (info.connected ? '' : ' · reconnecting');
      p.label.classList.toggle('away', !info.connected);
    }
    for (const [id, p] of this.players) {
      if (!seen.has(id)) { p.avatar?.dispose(); p.label?.remove(); this.players.delete(id); }
    }
    this.ev.roster(list, this.me);
  }

  private applySnap(t: number, entries: SnapEntry[]) {
    for (const e of entries) {
      const p = this.players.get(e[0]);
      if (!p || e[0] === this.me) continue;
      p.snaps.push({ t, x: e[1], z: e[2], yaw: e[3], g: [e[4], e[5], e[6]], arm: e[7], charge: e[8] });
      if (p.snaps.length > 30) p.snaps.shift();
    }
  }

  private applyScore(s: ScoreState, ev?: BallEvent) {
    this.score = s;
    // Local record mirror: keep the best we've seen; re-seed the server after restarts.
    if (s.groupKey) {
      if (s.groupBest > recordFor(s.groupKey)) raiseRecord(s.groupKey, s.groupBest);
      const local = recordFor(s.groupKey);
      if (local > s.groupBest && this.sentRecordFor !== s.groupKey) {
        this.sentRecordFor = s.groupKey;
        this.net.send({ t: 'rec', key: s.groupKey, best: local });
      }
    }
    this.ev.score(s, ev);
  }

  private setTraj(b: BallState) {
    const key = `${b.tid}:${b.t0}:${b.p0.join(',')}`;
    if (key === this.trajKey) return;
    this.trajKey = key;
    this.traj = simulateFlight(b.p0, b.v0);
    this.impactIdx = 0;
  }

  private applyBall(b: BallState, ev?: BallEvent) {
    const perf = performance.now();
    const prev = this.ball;
    const mine = this.me;

    // Our own throw echoing back: keep the predicted flight (same p0/v0/t0).
    const ownThrowEcho = b.phase === 'flight' && b.thrower === mine && prev.phase === 'flight' && prev.tid === b.tid;
    if (b.phase === 'flight' || b.phase === 'loose') {
      if (!ownThrowEcho) {
        const isNewFlight = prev.tid !== b.tid || prev.phase === 'held' || prev.t0 !== b.t0;
        this.setTraj(b);
        if (isNewFlight && b.thrower !== mine) {
          // Remote throw: ease into the authoritative timeline from the thrower's hand.
          this.flightLag = Math.max(0, Math.min(400, this.net.now() - b.t0));
          this.flightRecvAt = perf;
        }
      }
    }
    this.ball = b;
    if (b.phase !== 'flight') this.predThrowAt = 0;
    if (!(b.phase === 'held' && b.holder === mine) && this.controls.aiming) this.controls.reset();
    if (b.phase === 'flight' && b.thrower !== mine && b.live) {
      if (this.incomingTid !== b.tid) { this.incomingTid = b.tid; this.ev.moment('incoming'); }
    }

    if (!ev) {
      if (b.phase === 'held' && b.holder === mine && prev.holder !== mine) this.holdReadyAt = perf + 150;
      return;
    }
    switch (ev.k) {
      case 'throw': {
        if (ev.by !== mine) audio.armSwish(Math.min(1, ev.speed / 30), 0);
        break;
      }
      case 'catch': {
        this.pinned = null;
        if (ev.by === mine) {
          const predicted = this.localCatch && this.localCatch.tid === b.tid;
          // Not predicted locally (rare): still give full feedback.
          if (!predicted) this.popLocal(ev.q, ev.speed, ev.g ?? 0.6);
          this.localCatch = null;
          const at = this.lastCatchPerf || perf;
          this.catchShow = { by: mine, perf: at };
          this.holdReadyAt = at + 520;
          setTimeout(() => { if (this.ball.holder === mine) { this.myAvatar?.transfer(); audio.transfer(this.hand === 'R' ? 1 : -1); } }, Math.max(0, at + 300 - performance.now()));
          if (!ev.self) this.ev.moment('catch');
        } else {
          const av = this.avatarOf(ev.by);
          const at = av ? [av.gloveWorldPos.x, av.gloveWorldPos.y, av.gloveWorldPos.z] as Vec3 : ev.pos;
          audio.pop({ speed: ev.speed, q: ev.q, g: ev.g ?? 0.6, pos: at });
          if (av && this.traj) av.catchImpact(velocityAt(this.traj, (ev.at - prev.t0) / 1000), ev.speed);
          if (av) setTimeout(() => av.transfer(), 320);
          this.catchShow = { by: ev.by, perf };
        }
        if (ev.milestone) audio.milestone();
        this.lastCatchPerf = 0;
        break;
      }
      case 'deflect': {
        this.pinned = null;
        this.localCatch = null;
        if (ev.by !== mine) audio.pop({ speed: ev.speed, q: 'deflect', g: 0, pos: ev.pos });
        if (ev.by === mine) this.ev.moment('drop');
        break;
      }
      case 'drop': {
        this.pinned = null;
        this.localCatch = null;
        if (ev.by === mine && !ev.void) this.ev.moment('drop');
        break;
      }
      case 'recover': {
        this.recoverAnim = { from: ev.from, perf };
        if (ev.by === mine) {
          this.holdReadyAt = perf + 650;
          setTimeout(() => audio.pickup(), 420);
          this.ev.moment('holding');
        }
        break;
      }
    }
  }

  private popLocal(q: CatchQuality | 'deflect', speed: number, g: number) {
    audio.pop({ speed, q, g, pos: null, side: this.hand === 'R' ? -1 : 1 });
    haptic(g >= 0.75 ? 'firm' : 'light');
  }

  // ------------------------------------------------------------------ throwing

  canThrow(): boolean {
    return !!this.me && this.ball.phase === 'held' && this.ball.holder === this.me && performance.now() >= this.holdReadyAt && !this.predThrowAt;
  }

  /**
   * The throw a pull-back describes. The pull places a target on your
   * friend's glove plane (sideways pull = left/right, pull length = height),
   * which breathes a little with your hand; the throw is solved to arrive
   * exactly there, so the aim ring is the truth.
   */
  private planThrow(a: Aim): { p0: Vec3; v0: Vec3; speed: number; ring: Vec3; T: number } {
    const me = this.pos;
    const pid = this.aimPartnerId && this.players.has(this.aimPartnerId) ? this.aimPartnerId : this.partner();
    const pf = this.feetOf(pid);
    const pav = this.avatarOf(pid);
    // Throw axis: you → your friend.
    let ux = 0, uz = -1, depth = 12;
    if (pf) {
      const dx = pf[0] - me[0], dz = pf[2] - me[2], l = Math.hypot(dx, dz) || 1;
      ux = dx / l; uz = dz / l; depth = l;
      if (pav) depth = Math.max(2, (pav.gloveWorldPos.x - me[0]) * ux + (pav.gloveWorldPos.z - me[2]) * uz);
    } else {
      ux = -Math.sin(this.yaw); uz = -Math.cos(this.yaw);
    }
    const rx = -uz, rz = ux;
    const lat = -a.side * AIM_X_PER_PX;
    let h = AIM_H_LOW + AIM_H_SPAN * a.power;
    let wl = 0;
    if (!this.steadyAim) {
      // A breathing hand: steadier for soft throws, shakier for hard ones and long holds.
      const held = (performance.now() - this.aimStartAt) / 1000;
      const amp = 0.012 + 0.038 * a.power + clamp((held - 1.4) * 0.05, 0, 0.07);
      const t = performance.now() / 1000;
      wl = amp * (Math.sin(t * 2.1) + 0.5 * Math.sin(t * 4.7 + 1)) / 1.5;
      h += amp * (Math.sin(t * 1.6 + 2) + 0.5 * Math.sin(t * 3.9)) / 1.5;
    }
    const target: Vec3 = [me[0] + ux * depth + rx * (lat + wl), h, me[2] + uz * depth + rz * (lat + wl)];
    const yawTo = lookAngles(me, target).yaw;
    const p0 = releasePoint(me, yawTo, this.hand);
    // Pace: pull harder, throw harder (and it carries higher).
    const speed = lerp(11.5, 20.5, a.power) * clamp(depth / 11, 0.75, 1.5);
    const T = Math.max(0.35, dist(p0, target) / speed);
    const v0 = solveThrowTo(p0, target, T);
    return { p0, v0, speed: Math.hypot(...v0), ring: target, T };
  }

  private release(a: Aim) {
    this.aim = null;
    if (!this.canThrow() || !this.me) return;
    const { p0, v0 } = this.planThrow(a);
    const t0 = this.net.now();
    const tid = this.ball.tid + 1;
    this.net.send({ t: 'throw', rt: t0, p: p0, v: v0, tid });
    // Predict.
    this.ball = { phase: 'flight', holder: null, tid, thrower: this.me, t0, p0, v0, live: true };
    this.setTraj(this.ball);
    this.flightLag = 0;
    this.predThrowAt = performance.now();
    this.releasedAt = performance.now();
    audio.armSwish(a.power, this.hand === 'R' ? 1 : -1);
    this.ev.moment('throw');
  }

  // ------------------------------------------------------------------ frame

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.adaptQuality(dt);
    const sNow = this.net.now();

    // Predicted throw never confirmed → the server rejected it; give the ball back.
    if (this.predThrowAt && now - this.predThrowAt > 2500 && this.ball.thrower === this.me && this.ball.phase === 'flight') {
      this.predThrowAt = 0;
      this.ball = { ...this.ball, phase: 'held', holder: this.me, live: false };
    }
    if (this.predThrowAt && this.ball.phase === 'flight' && now - this.predThrowAt > 200) this.predThrowAt = 0;

    this.updateBody(dt, now, sNow);
    this.checkCatch(sNow);
    this.updateRemotes(dt, sNow);
    this.updateMe(dt, now, sNow);
    const ballPos = this.updateBall(dt, now, sNow);
    this.updateCamera(dt, ballPos);
    this.updateAim(dt);
    this.world.update(dt, now / 1000);
    if (this.renderEnabled) this.renderer.render(this.scene, this.rig.camera);
    this.updateLabels();
    this.sendState(now);
  };

  private adaptQuality(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (avg > 0.024 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.onResize();
    } else if (avg > 0.024 && this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.world.sun.castShadow = false;
    }
  }

  private incoming(): boolean {
    const b = this.ball;
    return !!this.traj && b.phase === 'flight' && b.live && b.thrower !== this.me && !this.localCatch;
  }

  /** Your body: move where your thumb says; the glove reaches for the ball. */
  private updateBody(dt: number, now: number, sNow: number) {
    if (!this.me || !this.myInfo()) return;
    const b = this.ball;
    const holding = b.phase === 'held' && b.holder === this.me;
    const tNow = Math.max(0, (sNow - b.t0) / 1000);
    const incoming = this.incoming();

    // ---- where do you want to go?
    let sx = 0, sy = 0;
    if (this.keys.size) {
      const k = this.keys;
      sx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      sy = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
      const l = Math.hypot(sx, sy); if (l > 1) { sx /= l; sy /= l; }
    }
    if (this.autoMove && incoming && this.traj) this.autoCatch(tNow);
    let tvx = 0, tvz = 0;
    let top = RUN_SPEED;
    if (sx || sy) {
      // Desktop keys: direction on the grass, as the camera sees it.
      this.stepTo = null;
      const cam = this.rig.camera;
      const fwd = tmpV.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      const fx = fwd.x / fl, fz = fwd.z / fl;
      const rx = -fz, rz = fx;
      tvx = (rx * sx + fx * sy) * RUN_SPEED;
      tvz = (rz * sx + fz * sy) * RUN_SPEED;
    } else if (this.stepTo) {
      // Stepping after a glove you pushed past your reach.
      const dx = this.stepTo[0] - this.pos[0], dz = this.stepTo[2] - this.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 0.04) this.stepTo = null;
      else { tvx = (dx / d) * Math.min(RUN_SPEED, d * 7); tvz = (dz / d) * Math.min(RUN_SPEED, d * 7); }
    } else if (!incoming && !this.gloveDragging && (holding || b.phase !== 'held') && now - this.lastInputAt > 900) {
      // Nothing to do: wander back to your spot.
      const dx = this.home[0] - this.pos[0], dz = this.home[2] - this.pos[2];
      const d = Math.hypot(dx, dz);
      top = WALK_SPEED;
      if (d > 0.12) { tvx = (dx / d) * Math.min(WALK_SPEED, d * 1.5); tvz = (dz / d) * Math.min(WALK_SPEED, d * 1.5); }
    }
    if (this.controls.aiming || (this.releasedAt > 0 && now - this.releasedAt < 450)) { tvx = 0; tvz = 0; }
    const ax = tvx - this.vel.x, az = tvz - this.vel.z;
    const al = Math.hypot(ax, az), amax = RUN_ACCEL * dt * (top === WALK_SPEED ? 0.4 : 1);
    const kk = al > amax ? amax / al : 1;
    this.vel.x += ax * kk; this.vel.z += az * kk;
    const prevX = this.pos[0], prevZ = this.pos[2];
    this.pos[0] += this.vel.x * dt; this.pos[2] += this.vel.z * dt;
    const hx = this.pos[0] - this.home[0], hz = this.pos[2] - this.home[2];
    const hd = Math.hypot(hx, hz);
    if (hd > MOVE_RADIUS) {
      this.pos[0] = this.home[0] + (hx / hd) * MOVE_RADIUS; this.pos[2] = this.home[2] + (hz / hd) * MOVE_RADIUS;
      this.vel.x *= 0.5; this.vel.z *= 0.5;
    }

    // ---- facing: square to your friend (so a set glove stays set), or your aim while throwing
    const faceYaw = this.controls.aiming && this.aimRing ? lookAngles(this.pos, this.aimRing).yaw : this.partnerYaw();
    this.yaw = wrapAngle(this.yaw + wrapAngle(faceYaw - this.yaw) * (1 - Math.exp(-dt / 0.14)));

    // ---- glove: tucked while you hold the ball, otherwise exactly where you hold it
    const showingCatch = this.localCatch || (holding && this.catchShow?.by === this.me && now < this.holdReadyAt);
    let want: Vec3;
    if (holding || showingCatch) {
      want = gloveReady(this.yaw, this.hand);
      if (showingCatch) want[1] += 0.05;
      // After a catch, the next target starts from a relaxed ready spot.
      this.gloveSet = [this.hand === 'R' ? -0.2 : 0.2, 1.18, 0.42];
    } else {
      want = clampReach(bodyToWorld(this.yaw, this.gloveSet), 0.98);
    }
    // A last-instant reflex: a ball just off the glove gets a lunge (and an ugly POP).
    let lunging = false;
    if (incoming && this.traj && !holding) {
      const gw: Vec3 = [this.pos[0] + want[0], want[1], this.pos[2] + want[2]];
      const ca = closestApproach(this.traj, gw);
      const until = ca.t - tNow;
      if (until > -0.02 && until < 0.2 && ca.dist > 0.16 && ca.dist < LUNGE_REACH) {
        const bp = positionAt(this.traj, ca.t);
        const k = 1 - 0.135 / ca.dist;
        want = clampReach([want[0] + (bp[0] - gw[0]) * k, want[1] + (bp[1] - gw[1]) * k, want[2] + (bp[2] - gw[2]) * k]);
        lunging = true;
        if (this.lungeTid !== b.tid) this.lungeTid = b.tid;
      }
    }
    this.gloveT = want;
    // Smooth in the world, not relative to the body: a hand holding a spot
    // doesn't trail behind when you step.
    const tau = lunging ? 0.045 : this.gloveDragging ? 0.035 : holding ? 0.18 : 0.06;
    const gk = 1 - Math.exp(-dt / tau);
    const moved: Vec3 = [this.pos[0] - prevX, 0, this.pos[2] - prevZ];
    const g: Vec3 = [this.glove[0] - moved[0], this.glove[1], this.glove[2] - moved[2]];
    for (let i = 0; i < 3; i++) g[i] += (this.gloveT[i] - g[i]) * gk;
    this.glove = clampReach(g);
  }

  /** Your thumb moves your glove: precise when slow, quick when you flick. */
  private moveGlove(dx: number, dy: number, speed: number) {
    if (this.ball.phase === 'held' && this.ball.holder === this.me) return;
    const gain = 0.0045 + Math.min(0.02, speed * 0.012);
    const gs = this.gloveSet;
    gs[0] += dx * gain;
    gs[1] = clamp(gs[1] + dy * gain, 0.18, 2.3);
    // Past your reach to the side: step over after it.
    const lim = 0.72;
    if (Math.abs(gs[0]) > lim) {
      const over = gs[0] - Math.sign(gs[0]) * lim;
      gs[0] -= over;
      const r = bodyToWorld(this.yaw, [over, 0, 0]);
      const from = this.stepTo ?? this.pos;
      let tx = from[0] + r[0], tz = from[2] + r[2];
      const hx = tx - this.home[0], hz = tz - this.home[2], hd = Math.hypot(hx, hz);
      if (hd > MOVE_RADIUS) { tx = this.home[0] + (hx / hd) * MOVE_RADIUS; tz = this.home[2] + (hz / hd) * MOVE_RADIUS; }
      this.stepTo = [tx, 0, tz];
    }
    // High balls: the glove goes up and a touch back; low: out in front.
    gs[2] = 0.42 + clamp((1.0 - gs[1]) * 0.12, -0.12, 0.1);
    this.lastInputAt = performance.now();
    this.ev.moment('move');
  }

  /** Test hook: put the glove where the ball will come through, and get there. */
  private autoCatch(tNow: number) {
    const ip = interceptPlan(this.traj!, Math.max(0, tNow - 0.05), this.home[0], this.home[2]);
    const p = ip.point;
    const r = bodyToWorld(this.yaw, [1, 0, 0]);
    // Stand so the glove (held a little to the glove side) meets the ball.
    const side = this.hand === 'R' ? -0.2 : 0.2;
    const f = bodyToWorld(this.yaw, [0, 0, 0.42]);
    this.stepTo = [p[0] - r[0] * side - f[0], 0, p[2] - r[2] * side - f[2]];
    this.gloveSet = [side, clamp(p[1], 0.18, 2.3), 0.42];
  }

  /** Local, predicted catch detection: did the ball actually pass through your glove? */
  private checkCatch(sNow: number) {
    if (!this.me || !this.myInfo()) return;
    const pose = this.myPose();
    const prevPose = this.prevPose ?? pose;
    this.prevPose = pose;
    const g = gloveWorld(pose);
    const prevG = this.prevGloveWorld ?? g;
    this.prevGloveWorld = g;
    const b = this.ball;
    if (!this.traj || b.phase !== 'flight' || !b.live || this.claimedTid === b.tid || this.localCatch) return;
    const tNow = Math.min((sNow - b.t0) / 1000, this.traj.groundT);
    if (this.lastCheckTid !== b.tid) { this.lastCheckTid = b.tid; this.lastCheckT = Math.max(0, tNow - 0.05); }
    const tPrev = this.lastCheckT;
    this.lastCheckT = tNow;
    if (tNow <= tPrev) return;
    const self = b.thrower === this.me;
    if (self) return;
    const res = sweptMinDistance(this.traj, tPrev, tNow, prevG, g);
    const speed = Math.hypot(...velocityAt(this.traj, res.t));
    const q = classifyCatch(res.dist, speed);
    if (!q) return;
    // Still closing on the pocket? Wait for the true closest pass (the grade is
    // how close it came, not where it was when it first touched leather).
    const ahead = sweptMinDistance(this.traj, tNow, Math.min(this.traj.groundT, tNow + 0.08), g, g);
    if (ahead.t > tNow + 1e-4 && ahead.dist < res.dist - 0.002) { this.lastCheckT = tPrev; return; }
    this.claimedTid = b.tid;
    // Report the pose at the moment of contact (between last frame and this one).
    const a = tNow > tPrev ? clamp((res.t - tPrev) / (tNow - tPrev), 0, 1) : 1;
    const at: Pose = {
      x: lerp(prevPose.x, pose.x, a),
      z: lerp(prevPose.z, pose.z, a),
      yaw: prevPose.yaw + wrapAngle(pose.yaw - prevPose.yaw) * a,
      g: [lerp(prevPose.g[0], pose.g[0], a), lerp(prevPose.g[1], pose.g[1], a), lerp(prevPose.g[2], pose.g[2], a)],
    };
    this.net.send({ t: 'catch', tid: b.tid, at: b.t0 + res.t * 1000, pose: [at.x, at.z, at.yaw, at.g[0], at.g[1], at.g[2]] });
    const vel = velocityAt(this.traj, res.t);
    if (q === 'deflect') {
      this.popLocal('deflect', speed, 0);
      this.myAvatar?.catchImpact(vel, speed * 0.5);
      return;
    }
    this.localCatch = { tid: b.tid, q, at: res.t };
    this.lastCatchPerf = performance.now();
    this.myAvatar?.catchImpact(vel, speed);
    this.popLocal(q, speed, catchGrade(res.dist));
  }

  private interp(p: Remote, sNow: number) {
    const s = p.snaps;
    if (!s.length) return;
    const rt = sNow - INTERP_MS;
    let a = s[0], bb = s[s.length - 1];
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= rt) { a = s[i - 1]; bb = s[i]; break; }
    }
    const span = bb.t - a.t;
    const k = span > 0 ? clamp((rt - a.t) / span, 0, 1.2) : 1;
    p.pose = {
      x: lerp(a.x, bb.x, k),
      z: lerp(a.z, bb.z, k),
      yaw: a.yaw + wrapAngle(bb.yaw - a.yaw) * k,
      g: [lerp(a.g[0], bb.g[0], k), lerp(a.g[1], bb.g[1], k), lerp(a.g[2], bb.g[2], k)],
    };
    p.arm = k < 0.5 ? a.arm : bb.arm;
    p.charge = lerp(a.charge, bb.charge, k);
    while (s.length > 2 && s[1].t < rt - 200) s.shift();
  }

  /** What a player's head follows: the ball when it's moving, else the person with it. */
  private lookTarget(id: string, ballPos: Vec3 | null): Vec3 | null {
    const b = this.ball;
    if (b.phase !== 'held' && ballPos) return ballPos;
    const other = b.phase === 'held' && b.holder && b.holder !== id ? b.holder : (id === this.me ? this.partner() : this.me);
    const av = this.avatarOf(other);
    return av ? [av.chestPos.x, av.chestPos.y + 0.25, av.chestPos.z] : null;
  }

  private lastBallPos: Vec3 | null = null;

  private updateRemotes(dt: number, sNow: number) {
    for (const p of this.players.values()) {
      if (p.info.id === this.me || !p.avatar) continue;
      this.interp(p, sNow);
      // The holder visibly holds the ball even between snapshots.
      let arm = p.arm;
      if (this.ball.phase === 'held' && this.ball.holder === p.info.id && arm === Arm.Idle) arm = Arm.Holding;
      const gloved = this.catchShow?.by === p.info.id && performance.now() - this.catchShow.perf < 320;
      const ready = this.ball.phase === 'flight' && this.ball.live && this.ball.thrower !== p.info.id;
      p.avatar.update(dt, { pose: p.pose, arm, charge: p.charge, look: this.lookTarget(p.info.id, this.lastBallPos), gloved, ready });
    }
  }

  private myArm(now: number): number {
    const holding = this.ball.phase === 'held' && this.ball.holder === this.me;
    if (this.releasedAt > 0 && now - this.releasedAt < 420) return Arm.Release;
    if (holding && this.controls.aiming) return Arm.Windup;
    if (holding) return Arm.Holding;
    return Arm.Idle;
  }

  private updateMe(dt: number, now: number, _sNow: number) {
    if (!this.myAvatar || !this.me) return;
    const charge = this.controls.aiming && this.aim ? (this.aim.armed ? 0.2 + 0.8 * this.aim.power : 0.1) : 0;
    const gloved = !!this.localCatch || (this.catchShow?.by === this.me && now < this.holdReadyAt - 200);
    this.myAvatar.update(dt, { pose: this.myPose(), arm: this.myArm(now), charge, look: this.lookTarget(this.me, this.lastBallPos), gloved, ready: this.incoming() });
  }

  private updateBall(dt: number, now: number, sNow: number): Vec3 | null {
    const b = this.ball;
    const pos = new THREE.Vector3();
    let visible = true;
    let zip = false;
    const vel: Vec3 = [0, 0, 0];
    let airborne = false, rolling = 0;

    if (this.localCatch && b.phase === 'flight' && this.myAvatar) {
      pos.copy(this.myAvatar.gloveWorldPos);
    } else if (b.phase === 'held') {
      const recovering = this.recoverAnim && now - this.recoverAnim.perf < 550 ? this.recoverAnim : null;
      const av = this.avatarOf(b.holder);
      let handPos: THREE.Vector3 | null = null;
      if (av) {
        const showGlove = this.catchShow?.by === b.holder && now - this.catchShow.perf < 360;
        if (showGlove) pos.copy(av.gloveWorldPos);
        else handPos = av.handBall.clone();
      } else visible = false;
      if (handPos) {
        if (recovering) {
          // The ball is fetched back: a short scoop/toss into the hand.
          const k = clamp((now - recovering.perf) / 550, 0, 1);
          const e = k * k * (3 - 2 * k);
          const f = new THREE.Vector3(...recovering.from);
          pos.lerpVectors(f, handPos, e);
          pos.y += Math.sin(Math.PI * e) * 1.1;
        } else pos.copy(handPos);
      }
    } else if (this.traj) {
      const tTrue = (sNow - b.t0) / 1000;
      // Remote throws: start from the thrower's hand and catch up to the true timeline.
      const catchUp = this.flightLag / 1000 * Math.max(0, 1 - (now - this.flightRecvAt) / 380);
      const t = Math.max(0, tTrue - (b.thrower === this.me ? 0 : catchUp));
      // Waiting on a remote catch verdict: hold the ball at their glove briefly.
      if (b.phase === 'flight' && b.live) {
        if (!this.pinned) {
          const p = positionAt(this.traj, t);
          for (const r of this.players.values()) {
            if (!r.avatar || r.info.id === this.me || r.info.id === b.thrower) continue;
            const gp = r.avatar.gloveWorldPos;
            if (Math.hypot(p[0] - gp.x, p[1] - gp.y, p[2] - gp.z) < 0.24) { this.pinned = { id: r.info.id, until: now + 380 }; break; }
          }
        }
        if (this.pinned && now > this.pinned.until) this.pinned = null;
      }
      if (this.pinned) {
        const av = this.avatarOf(this.pinned.id);
        if (av) pos.copy(av.gloveWorldPos); else this.pinned = null;
      } else {
        const p = positionAt(this.traj, t);
        pos.set(p[0], p[1], p[2]);
        velocityAt(this.traj, t, vel);
        airborne = p[1] > BALL_RADIUS + 0.004;
        rolling = airborne ? 0 : Math.hypot(vel[0], vel[2]);
        zip = true;
        // Bounces and thuds as the ball meets the grass.
        while (this.impactIdx < this.traj.impacts.length && this.traj.impacts[this.impactIdx].t <= t) {
          const im = this.traj.impacts[this.impactIdx++];
          audio.thud(im.speed, im.pos);
        }
      }
    } else visible = false;

    this.ballMesh.visible = visible;
    this.ballShadow.visible = visible;
    this.ballMesh.position.copy(pos);
    this.ballMesh.rotation.x += zip ? Math.hypot(...vel) * dt * 2.5 : 0;
    // Perceptual size floor so a distant ball stays readable (still a real ball up close).
    const camD = this.rig.camera.position.distanceTo(pos);
    const s = Math.max(1, camD * 0.13);
    this.ballMesh.scale.setScalar(s);
    // Subtle motion blur on fast balls.
    const sp = Math.hypot(...vel);
    this.ballBlur.visible = visible && zip && sp > 9;
    if (this.ballBlur.visible) {
      const dir = tmpV.set(vel[0], vel[1], vel[2]).normalize();
      const len = Math.min(0.9, sp * 0.016);
      this.ballBlur.position.copy(pos).addScaledVector(dir, -len / 2);
      this.ballBlur.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.ballBlur.scale.set(s * 0.85, (len / (BALL_RADIUS * 2)) + s, s * 0.85);
    }
    // Ground shadow: the outfielder's depth cue. Sharper and darker as the ball comes down.
    this.ballShadow.position.set(pos.x, 0.012, pos.z);
    const hgt = Math.max(0, pos.y);
    this.ballShadow.scale.setScalar(0.6 + hgt * 0.16);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = (b.phase === 'held' ? 0.25 : 0.95) * Math.max(0.3, 1 - hgt / 7);
    audio.ball({ active: visible && zip, pos: [pos.x, pos.y, pos.z], vel, airborne, rolling });
    const out: Vec3 | null = visible ? [pos.x, pos.y, pos.z] : null;
    this.lastBallPos = out;
    return b.phase !== 'held' && visible ? out : null;
  }

  private updateCamera(dt: number, ball: Vec3 | null) {
    const pf = this.feetOf(this.partner());
    const me: Vec3 = this.myAvatar ? [this.myAvatar.position.x, 0, this.myAvatar.position.z] : this.pos;
    const partner: Vec3 = pf ?? [me[0] - Math.sin(this.yaw) * 12, 0, me[2] - Math.cos(this.yaw) * 12];
    // The camera stands on your glove side, so every catch is in plain view.
    // While you aim, the shot pushes in on your friend so you can see their glove.
    const focus = this.controls.aiming && this.aimRing ? { point: this.aimRing, amount: 1 } : null;
    this.rig.update(dt, { me, partner, ball, side: this.hand === 'R' ? -1 : 1, focus });
    const l = this.rig.listener(me);
    audio.setListener(l.pos, l.fwd, l.up);
  }

  private updateAim(dt: number) {
    const a = this.aim;
    if (a && a.armed && this.controls.aiming && this.canThrow()) {
      const { p0, v0, T } = this.planThrow(a);
      this.aimTraj = simulateFlight(p0, v0);
      // The ring sits where the ball really crosses the glove plane.
      this.aimRing = positionAt(this.aimTraj, T);
      const pav = this.avatarOf(this.aimPartnerId);
      const off = pav ? dist(this.aimRing, [pav.gloveWorldPos.x, pav.gloveWorldPos.y, pav.gloveWorldPos.z]) : 1;
      const glove: Vec3 | null = pav ? [pav.gloveWorldPos.x, pav.gloveWorldPos.y, pav.gloveWorldPos.z] : null;
      this.aimArc.show(this.aimTraj, a.power, this.rig.camera, dt, { pos: this.aimRing, onTarget: clamp(1 - (off - CATCH_PERFECT) / (CATCH_WEB - CATCH_PERFECT), 0, 1), glove });
    } else {
      if (!this.controls.aiming) this.aimRing = null;
      this.aimArc.show(null, 0, this.rig.camera, dt, null);
    }
  }

  private updateLabels() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    for (const p of this.players.values()) {
      if (!p.label || !p.avatar) continue;
      tmpV.copy(p.avatar.headTop).project(this.rig.camera);
      const on = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
      p.label.style.opacity = on ? '' : '0';
      if (on) p.label.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  private sendState(now: number) {
    if (now - this.lastSent < 1000 / CLIENT_STATE_HZ || !this.me) return;
    this.lastSent = now;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    const charge = this.controls.aiming && this.aim ? (this.aim.armed ? 0.2 + 0.8 * this.aim.power : 0.1) : 0;
    this.net.send({ t: 'st', p: [r(this.pos[0]), r(this.pos[2]), r(this.yaw), r(this.glove[0]), r(this.glove[1]), r(this.glove[2]), this.myArm(now), Math.round(charge * 100) / 100] });
  }

  /** Snapshot for tests and debugging. */
  debugState() {
    return {
      me: this.me, status: this.net.status, ball: this.ball, score: this.score,
      players: [...this.players.values()].map((p) => ({ id: p.info.id, name: p.info.name, connected: p.info.connected, catches: p.info.catches, drops: p.info.drops, bot: p.info.bot })),
      pos: this.pos, home: this.home, yaw: this.yaw, glove: this.glove, gloveSet: this.gloveSet, partner: this.partnerId, partnerPos: this.feetOf(this.partnerId), controls: this.controls.stats, canThrow: this.canThrow(),
      audio: audio.log.slice(-40), zipPeak: Math.max(audio.zipPeak, audio.lastZipPeak), audioState: audio.ctx?.state ?? 'none', rtt: this.net.rtt, pixelRatio: this.pixelRatio,
      fov: this.rig.camera.fov,
    };
  }

  /** Screen position of a world point (tests). */
  screenOf(p: Vec3): { x: number; y: number; on: boolean } {
    tmpV.set(p[0], p[1], p[2]).project(this.rig.camera);
    const w = this.root.clientWidth, h = this.root.clientHeight;
    return { x: (tmpV.x * 0.5 + 0.5) * w, y: (-tmpV.y * 0.5 + 0.5) * h, on: tmpV.z < 1 && Math.abs(tmpV.x) <= 1 && Math.abs(tmpV.y) <= 1 };
  }

  /** Make a player the one you're playing with (tests / multi-player rooms). */
  lookAtPlayer(id: string) {
    if (this.players.has(id) && id !== this.me) this.partnerId = id;
  }

  /** The pull (CSS px from the touch point) that puts the aim ring on a partner's glove (tests). */
  pullFor(id: string): { side: number; pull: number } | null {
    const av = this.avatarOf(id);
    if (!av) return null;
    this.aimPartnerId = id;
    const me = this.pos;
    const g = av.gloveWorldPos;
    const pf = this.feetOf(id)!;
    const dx = pf[0] - me[0], dz = pf[2] - me[2], l = Math.hypot(dx, dz) || 1;
    const lat = ((g.x - me[0]) * -dz + (g.z - me[2]) * dx) / l;
    const H = this.root.clientHeight;
    const power = (g.y - AIM_H_LOW) / AIM_H_SPAN;
    return { side: -lat / AIM_X_PER_PX, pull: DEAD + power * FULL_PULL * H };
  }
}
