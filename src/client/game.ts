// One play session in a room: networking, prediction, controls, rendering
// and audio. The server is authoritative; this predicts the local player's
// own throws and catches so they feel instant, and smooths everyone else.

import * as THREE from 'three';
import {
  BALL_RADIUS, CHEST_HEIGHT, CLIENT_STATE_HZ, EYE_HEIGHT, GLOVE_REST_U, GLOVE_REST_V,
  THROW_MAX_SPEED, THROW_MIN_SPEED,
} from '../shared/constants';
import {
  type Trajectory, closestApproach, positionAt, simulateFlight, solveElevation, sweptMinDistance, velocityAt,
} from '../shared/physics';
import { type Hand, type Pose, GLOVE_LIMIT, eyePosition, gloveViewOffset, gloveWorld, lookAngles, releasePoint, viewBasis } from '../shared/pose';
import {
  Arm, type BallEvent, type BallState, type CatchQuality, type PlayerInfo, type ScoreState, type ServerMsg, type SnapEntry, catchGrade, classifyCatch,
} from '../shared/protocol';
import { type Vec3, clamp, dist, lerp, wrapAngle } from '../shared/vec';
import { audio } from './audio';
import { haptic } from './haptics';
import { Controls, type ThrowRelease } from './input';
import { Net, type NetStatus } from './net';
import { Avatar, LOOKS } from './scene/avatar';
import { FirstPerson } from './scene/firstperson';
import { buildBall, contactShadow } from './scene/gear';
import { type World, buildWorld } from './scene/world';
import { prefs, raiseRecord, recordFor } from './storage';

interface Snap { t: number; yaw: number; pitch: number; gu: number; gv: number; arm: number; charge: number }

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
  moment(kind: 'look' | 'glove' | 'catch' | 'throw' | 'drop' | 'incoming' | 'holding'): void;
  toast(text: string): void;
}

const tmpV = new THREE.Vector3();
const INTERP_MS = 110;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private world: World;
  private scene: THREE.Scene;
  readonly net: Net;
  private controls: Controls;
  private fp: FirstPerson;
  private ballMesh: THREE.Mesh;
  private ballBlur: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private labels: HTMLElement;
  private raf = 0;
  private lastFrame = 0;
  private running = false;

  me: string | null = null;
  players = new Map<string, Remote>();
  ball: BallState = { phase: 'held', holder: null, tid: 0, thrower: null, t0: 0, p0: [0, 0, 0], v0: [0, 0, 0], live: false };
  traj: Trajectory | null = null;
  score: ScoreState = { streak: 0, sessionBest: 0, groupBest: 0, groupKey: '' };

  // Local player.
  hand: Hand;
  yaw = 0;
  pitch = -0.04;
  private gloveT = { u: GLOVE_REST_U, v: GLOVE_REST_V };
  glove = { u: GLOVE_REST_U, v: GLOVE_REST_V };
  private prevGloveWorld: Vec3 | null = null;
  private prevPose: Pose | null = null;
  private lookActive = false;
  private gloveActive = false;
  private lastLookAt = 0;
  private winding = false;
  private charge = 0;
  /** Arm aim from the sideways slide while winding, -1..1. */
  private armAim = 0;
  private arc!: THREE.InstancedMesh;
  private arcKey = '';
  private releasedAt = -1;
  private lastSent = 0;

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
  private rosterIds = '';
  private pixelRatio: number;
  private frameTimes: number[] = [];
  /** Test hook: move the glove onto the ball automatically (never set in normal play). */
  autoGlove = false;
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
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 500);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    const myLook = LOOKS[0];
    this.fp = new FirstPerson(myLook.skin);
    this.fp.setHand(this.hand);
    this.camera.add(this.fp.group);
    // Soft fill from over your shoulder so your own hands read when you face the sun.
    const fill = new THREE.DirectionalLight('#ffe6c8', 0.9);
    fill.position.set(0.3, 0.6, 1);
    fill.target.position.set(0, -0.2, -1);
    this.camera.add(fill, fill.target);

    this.ballMesh = buildBall();
    this.ballBlur = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#f4efe4', transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.ballShadow = contactShadow(0.22);
    this.scene.add(this.ballMesh, this.ballBlur, this.ballShadow);
    this.arc = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ color: '#fff8ea', transparent: true, opacity: 0.55, depthWrite: false }),
      14,
    );
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.scene.add(this.arc);

    this.labels = document.createElement('div');
    this.labels.className = 'labels';
    root.appendChild(this.labels);

    this.controls = new Controls(touchLayer, {
      canGrip: () => this.canThrow(),
      gripPoint: () => this.gripScreen(),
      onLook: (dx, dy) => this.look(dx, dy),
      onLookActive: (a) => { this.lookActive = a; this.lastLookAt = performance.now(); },
      onGlove: (du, dv) => {
        this.gloveT.u = clamp(this.gloveT.u + du, -GLOVE_LIMIT, GLOVE_LIMIT);
        this.gloveT.v = clamp(this.gloveT.v + dv, -GLOVE_LIMIT, GLOVE_LIMIT);
        if (Math.abs(du) + Math.abs(dv) > 0.02) this.ev.moment('glove');
      },
      onGloveActive: (a) => { this.gloveActive = a; },
      onGrip: () => { this.winding = true; this.charge = 0; this.armAim = 0; },
      onWind: (c, aim) => {
        if (c > this.charge + 0.18 || (c > 0.6 && this.charge <= 0.6)) audio.creak(c);
        if (c >= 0.999 && this.charge < 0.999) haptic('light');
        this.charge = c;
        this.armAim = aim;
      },
      onRelease: (r) => this.release(r),
      onCancel: () => { this.winding = false; this.charge = 0; this.armAim = 0; },
    });
    this.controls.hand = this.hand;
    this.gloveT = this.restGlove();
    this.glove = { ...this.gloveT };

    this.net = new Net(room, () => ({ guest: prefs().guest, name: prefs().name, hand: prefs().hand }));
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onStatus = (s) => this.ev.status(s);

    this.onResize();
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
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
    audio.ball({ active: false, pos: [0, 0, 0], vel: [0, 0, 0], airborne: false, rolling: 0 });
    for (const p of this.players.values()) { p.avatar?.dispose(); p.label?.remove(); }
    this.players.clear();
    this.labels.remove();
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
    this.fp.setHand(h);
    this.controls.hand = h;
    this.gloveT = this.restGlove();
    this.net.send({ t: 'prof', name: prefs().name, hand: h });
  }

  setName(name: string) { this.net.send({ t: 'prof', name, hand: this.hand }); }

  private restGlove() {
    return { u: this.hand === 'R' ? GLOVE_REST_U : -GLOVE_REST_U, v: GLOVE_REST_V };
  }

  // ------------------------------------------------------------------ view

  private onResize = () => {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 1 ? 72 : 56;
    this.camera.updateProjectionMatrix();
    this.fp.setFrustum(this.camera.fov, aspect);
  };

  private onVisibility = () => {
    if (document.visibilityState === 'visible') {
      audio.resume();
      this.net.kick();
      this.lastFrame = performance.now();
    } else {
      this.controls.reset();
      audio.suspend();
    }
  };

  private look(dx: number, dy: number) {
    const w = this.root.clientWidth || 390;
    const k = (1.75 / w) * prefs().lookSensitivity;
    this.yaw = wrapAngle(this.yaw - dx * k);
    this.pitch = clamp(this.pitch - dy * k, -1.0, 1.05);
    this.lastLookAt = performance.now();
    if (Math.abs(dx) + Math.abs(dy) > 2) this.ev.moment('look');
  }

  myInfo(): PlayerInfo | null { return this.me ? this.players.get(this.me)?.info ?? null : null; }
  private mySeat(): Vec3 { return this.myInfo()?.pos ?? [0, 0, 7]; }
  private myPose(): Pose { return { yaw: this.yaw, pitch: this.pitch, gu: this.glove.u, gv: this.glove.v }; }

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
          if (mine) { this.yaw = mine.facing; this.pitch = -0.04; }
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

  private applyPlayers(list: PlayerInfo[]) {
    const seen = new Set<string>();
    for (const info of list) {
      seen.add(info.id);
      let p = this.players.get(info.id);
      if (!p) {
        p = { info, avatar: null, snaps: [], label: null, pose: { yaw: info.facing, pitch: 0, gu: GLOVE_REST_U, gv: GLOVE_REST_V }, arm: 0, charge: 0 };
        this.players.set(info.id, p);
      }
      const moved = p.info.pos[0] !== info.pos[0] || p.info.pos[2] !== info.pos[2];
      const handChanged = p.info.hand !== info.hand;
      p.info = info;
      if (info.id === this.me) continue;
      if (!p.avatar || handChanged) {
        p.avatar?.dispose();
        p.avatar = new Avatar(info.pos, info.facing, info.hand, info.look);
        this.scene.add(p.avatar.root, p.avatar.arms);
      } else if (moved) p.avatar.place(info.pos, info.facing);
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
    const ids = list.map((p) => p.id).join(',');
    if (ids !== this.rosterIds) {
      this.rosterIds = ids;
    }
    this.ev.roster(list, this.me);
  }

  private applySnap(t: number, entries: SnapEntry[]) {
    for (const e of entries) {
      const p = this.players.get(e[0]);
      if (!p || e[0] === this.me) continue;
      p.snaps.push({ t, yaw: e[1], pitch: e[2], gu: e[3], gv: e[4], arm: e[5], charge: e[6] });
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
    if (b.phase === 'flight' && b.thrower !== mine && b.live) {
      if (this.incomingTid !== b.tid) { this.incomingTid = b.tid; this.ev.moment('incoming'); }
    }

    if (!ev) {
      if (b.phase === 'held' && b.holder === mine && prev.holder !== mine) this.holdReadyAt = perf + 150;
      return;
    }
    switch (ev.k) {
      case 'throw': {
        if (ev.by !== mine) {
          const p = this.players.get(ev.by);
          if (p?.avatar) audio.armSwish(Math.min(1, ev.speed / 30), 0);
        }
        break;
      }
      case 'catch': {
        this.pinned = null;
        if (ev.by === mine) {
          const predicted = this.localCatch && this.localCatch.tid === b.tid;
          // Not predicted locally (rare): still give full feedback.
          if (!predicted) this.popLocal(ev.q, ev.speed, ev.g ?? 0.6);
          this.localCatch = null;
          this.catchShow = { by: mine, perf: this.lastCatchPerf || perf };
          this.holdReadyAt = (this.lastCatchPerf || perf) + 380;
          setTimeout(() => { if (this.ball.holder === mine) { this.fp.onTransfer(); audio.transfer(this.hand === 'R' ? 1 : -1); } }, Math.max(0, (this.lastCatchPerf || perf) + 230 - performance.now()));
          if (!ev.self) this.ev.moment('catch');
        } else {
          const p = this.players.get(ev.by);
          const at = p?.avatar ? [p.avatar.gloveWorldPos.x, p.avatar.gloveWorldPos.y, p.avatar.gloveWorldPos.z] as Vec3 : ev.pos;
          audio.pop({ speed: ev.speed, q: ev.q, g: ev.g ?? 0.6, pos: at });
          if (p?.avatar && this.traj) p.avatar.catchImpact(velocityAt(this.traj, (ev.at - prev.t0) / 1000), ev.speed);
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
        if (this.localCatch) {
          // Our predicted catch was not accepted.
          this.localCatch = null;
        }
        if (ev.by === mine && !ev.void) this.ev.moment('drop');
        break;
      }
      case 'recover': {
        this.recoverAnim = { from: ev.from, perf };
        if (ev.by === mine) {
          this.holdReadyAt = perf + 650;
          this.fp.onPickup();
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

  gripScreen(): { x: number; y: number } | null {
    this.camera.updateMatrixWorld();
    const p = this.fp.handBallLocal.clone().applyMatrix4(this.camera.matrixWorld).project(this.camera);
    const w = this.root.clientWidth, h = this.root.clientHeight;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
  }

  /** Max arm aim off your line of sight (radians) — enough for a no-look throw. */
  static readonly ARM_AIM = 0.55;

  /**
   * What the throw is aimed at: the player nearest the arm's direction, else
   * the ground you're looking at, else a default distance.
   */
  private aimTarget(from: Vec3, throwYaw: number): { D: number; h: number; pitchTo: number } {
    const eye = eyePosition(this.mySeat());
    const f = viewBasis(throwYaw, this.pitch).f;
    let best: { D: number; h: number; ang: number; pitchTo: number } | null = null;
    for (const p of this.players.values()) {
      if (p.info.id === this.me) continue;
      const chest: Vec3 = [p.info.pos[0], CHEST_HEIGHT + 0.05, p.info.pos[2]];
      const d = [chest[0] - eye[0], chest[1] - eye[1], chest[2] - eye[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      const ang = Math.acos(clamp((d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / l, -1, 1));
      if (ang < 0.22 && (!best || ang < best.ang)) {
        const D = Math.hypot(chest[0] - from[0], chest[2] - from[2]);
        best = { D, h: chest[1], ang, pitchTo: Math.atan2(chest[1] - eye[1], Math.hypot(chest[0] - eye[0], chest[2] - eye[2])) };
      }
    }
    if (best) return best;
    if (this.pitch < -0.03) {
      const D = clamp(eye[1] / Math.tan(-this.pitch), 2, 30);
      return { D, h: 0.3, pitchTo: this.pitch };
    }
    return { D: 14, h: eye[1] + Math.tan(this.pitch) * 14, pitchTo: this.pitch };
  }

  /** The throw a given windup would make (shared by the arc preview and the release). */
  private computeThrow(charge: number, aim: number, snap: number): { p0: Vec3; v0: Vec3; speed: number } {
    const speed = lerp(THROW_MIN_SPEED, THROW_MAX_SPEED, Math.pow(charge, 1.05)) * (1 + 0.07 * snap);
    // Sliding right aims the arm right (yaw decreases to the right).
    const throwYaw = this.yaw - aim * Game.ARM_AIM;
    const p0 = releasePoint(this.mySeat(), throwYaw, this.hand);
    const tgt = this.aimTarget(p0, throwYaw);
    const solved = solveElevation(speed, tgt.D, p0[1], tgt.h);
    const el = clamp((solved ?? 0.72) + (this.pitch - tgt.pitchTo), -0.35, 1.2);
    const v0: Vec3 = [-Math.sin(throwYaw) * Math.cos(el) * speed, Math.sin(el) * speed, -Math.cos(throwYaw) * Math.cos(el) * speed];
    return { p0, v0, speed };
  }

  private release(r: ThrowRelease) {
    this.winding = false;
    this.charge = 0;
    this.armAim = 0;
    if (!this.canThrow() || !this.me) return;
    const { p0, v0 } = this.computeThrow(r.charge, r.aim, r.snap);
    const t0 = this.net.now();
    const tid = this.ball.tid + 1;
    this.net.send({ t: 'throw', rt: t0, p: p0, v: v0, tid });
    // Predict.
    this.ball = { phase: 'flight', holder: null, tid, thrower: this.me, t0, p0, v0, live: true };
    this.setTraj(this.ball);
    this.flightLag = 0;
    this.predThrowAt = performance.now();
    this.releasedAt = performance.now();
    this.fp.onRelease();
    audio.armSwish(r.charge, this.hand === 'R' ? 1 : -1);
    this.ev.moment('throw');
  }

  /** A faint dotted arc showing the start of the throw you're winding up. */
  private updateArc() {
    const show = this.winding && this.charge >= 0.07 && this.canThrow();
    this.arc.visible = show;
    if (!show) { this.arcKey = ''; return; }
    const key = `${this.charge.toFixed(3)}:${this.armAim.toFixed(3)}:${this.yaw.toFixed(3)}:${this.pitch.toFixed(3)}`;
    if (key === this.arcKey) return;
    this.arcKey = key;
    const { p0, v0 } = this.computeThrow(this.charge, this.armAim, 0);
    const tr = simulateFlight(p0, v0);
    const span = Math.min(tr.groundT, 2.4) * 0.55;
    const m = new THREE.Matrix4();
    const n = this.arc.count;
    for (let i = 0; i < n; i++) {
      const t = 0.06 + (span * (i + 1)) / n;
      const p = positionAt(tr, t);
      const s = 0.028 * (1 - (i / n) * 0.65) * (1 + dist(p, p0) * 0.06);
      m.makeScale(s, s, s).setPosition(p[0], p[1], p[2]);
      this.arc.setMatrixAt(i, m);
    }
    this.arc.instanceMatrix.needsUpdate = true;
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

    this.updateView(dt, now, sNow);
    this.checkCatch(sNow);
    this.updateRemotes(dt, sNow);
    this.updateFirstPerson(dt, now);
    this.updateBall(dt, now, sNow);
    this.updateArc();
    this.world.update(dt, now / 1000);
    if (this.renderEnabled) this.renderer.render(this.scene, this.camera);
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

  private updateView(dt: number, now: number, sNow: number) {
    const me = this.myInfo();
    if (!me) return;
    const eye = eyePosition(me.pos);

    // Glove follows the thumb with a short, physical lag.
    if (this.autoGlove) this.autoGloveTarget(sNow);
    if (!this.gloveActive && this.ball.holder === this.me && this.ball.phase === 'held') {
      const r = this.restGlove();
      this.gloveT.u = lerp(this.gloveT.u, r.u, Math.min(1, dt * 1.5));
      this.gloveT.v = lerp(this.gloveT.v, r.v, Math.min(1, dt * 1.5));
    }
    const k = 1 - Math.exp(-dt / 0.03);
    this.glove.u += (this.gloveT.u - this.glove.u) * k;
    this.glove.v += (this.gloveT.v - this.glove.v) * k;

    // Gentle camera help, never while your thumb is looking.
    const idle = !this.lookActive && now - this.lastLookAt > 350 && !this.winding;
    const b = this.ball;
    const hfov = Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const vfov = (this.camera.fov * Math.PI) / 360;
    if (idle && this.traj && b.phase === 'flight' && b.live && b.thrower !== this.me) {
      // Keep an incoming ball in frame.
      const tS = (sNow - b.t0) / 1000;
      const p = positionAt(this.traj, tS);
      const d = dist(p, eye);
      const ca = closestApproach(this.traj, eye);
      if (ca.dist < 4.5 && d > 1.4 && tS < ca.t) {
        const a = lookAngles(eye, p);
        const dy = wrapAngle(a.yaw - this.yaw), dp = a.pitch - this.pitch;
        const limY = hfov * 0.55, limP = vfov * 0.5;
        if (Math.abs(dy) > limY) this.yaw = wrapAngle(this.yaw + (dy - Math.sign(dy) * limY) * Math.min(1, dt * 7));
        if (Math.abs(dp) > limP) this.pitch = clamp(this.pitch + (dp - Math.sign(dp) * limP) * Math.min(1, dt * 7), -1, 1.05);
      }
    } else if (idle && now - this.lastLookAt > 1600 && b.phase === 'held' && b.holder && b.holder !== this.me) {
      // Turn toward whoever has the ball if they're out of view.
      const h = this.players.get(b.holder);
      if (h) {
        const a = lookAngles(eye, [h.info.pos[0], EYE_HEIGHT - 0.25, h.info.pos[2]]);
        const dy = wrapAngle(a.yaw - this.yaw);
        if (Math.abs(dy) > hfov * 0.75) this.yaw = wrapAngle(this.yaw + dy * Math.min(1, dt * 2.2));
        this.pitch += (clamp(a.pitch, -0.3, 0.3) - this.pitch) * Math.min(1, dt * 0.8);
      }
    }

    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    const vb = viewBasis(this.yaw, this.pitch);
    audio.setListener(eye, vb.f, vb.u);
  }

  /** Test-only helper: put the glove where the incoming ball will cross glove depth. */
  private autoGloveTarget(sNow: number) {
    const b = this.ball;
    if (!this.traj || b.phase !== 'flight' || b.thrower === this.me) return;
    const eye = eyePosition(this.mySeat());
    const vb = viewBasis(this.yaw, this.pitch);
    const tNow = Math.max(0, (sNow - b.t0) / 1000);
    let depth = 0.7;
    for (let pass = 0; pass < 3; pass++) {
      // Find when the ball reaches this depth in front of the eye.
      let hit: Vec3 | null = null;
      for (let t = tNow; t < this.traj.groundT; t += 1 / 240) {
        const p = positionAt(this.traj, t);
        const fz = (p[0] - eye[0]) * vb.f[0] + (p[1] - eye[1]) * vb.f[1] + (p[2] - eye[2]) * vb.f[2];
        if (fz <= depth) { hit = p; break; }
      }
      if (!hit) return;
      const off = [hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]];
      const fz = Math.max(0.2, off[0] * vb.f[0] + off[1] * vb.f[1] + off[2] * vb.f[2]);
      const rx = off[0] * vb.r[0] + off[1] * vb.r[1] + off[2] * vb.r[2];
      const uy = off[0] * vb.u[0] + off[1] * vb.u[1] + off[2] * vb.u[2];
      this.gloveT.u = clamp(rx / fz / 0.42, -GLOVE_LIMIT, GLOVE_LIMIT);
      this.gloveT.v = clamp(uy / fz / 0.62, -GLOVE_LIMIT, GLOVE_LIMIT);
      const o = gloveViewOffset(this.gloveT.u, this.gloveT.v);
      depth = o[2];
    }
  }

  /** Local, predicted catch detection: did the ball actually pass through our glove? */
  private checkCatch(sNow: number) {
    const me = this.myInfo();
    if (!me || !this.me) return;
    const pose = this.myPose();
    const prevPose = this.prevPose ?? pose;
    this.prevPose = pose;
    const g = gloveWorld(me.pos, pose);
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
    if (self && tNow < 0.3) return;
    const res = sweptMinDistance(this.traj, tPrev, tNow, prevG, g);
    const speed = Math.hypot(...velocityAt(this.traj, res.t));
    const q = classifyCatch(res.dist, speed);
    if (!q) return;
    this.claimedTid = b.tid;
    // Report the pose at the moment of contact (between last frame and this one).
    const a = tNow > tPrev ? clamp((res.t - tPrev) / (tNow - tPrev), 0, 1) : 1;
    const at: Pose = {
      yaw: prevPose.yaw + wrapAngle(pose.yaw - prevPose.yaw) * a,
      pitch: lerp(prevPose.pitch, pose.pitch, a),
      gu: lerp(prevPose.gu, pose.gu, a),
      gv: lerp(prevPose.gv, pose.gv, a),
    };
    this.net.send({ t: 'catch', tid: b.tid, at: b.t0 + res.t * 1000, pose: [at.yaw, at.pitch, at.gu, at.gv] });
    const vel = velocityAt(this.traj, res.t);
    const dirCam = new THREE.Vector3(vel[0], vel[1], vel[2]).transformDirection(this.camera.matrixWorldInverse);
    if (q === 'deflect') {
      this.popLocal('deflect', speed, 0);
      this.fp.onCatch(dirCam, speed * 0.5);
      return;
    }
    this.localCatch = { tid: b.tid, q, at: res.t };
    this.lastCatchPerf = performance.now();
    this.fp.onCatch(dirCam, speed);
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
      yaw: a.yaw + wrapAngle(bb.yaw - a.yaw) * k,
      pitch: lerp(a.pitch, bb.pitch, k),
      gu: lerp(a.gu, bb.gu, k),
      gv: lerp(a.gv, bb.gv, k),
    };
    p.arm = k < 0.5 ? a.arm : bb.arm;
    p.charge = lerp(a.charge, bb.charge, k);
    while (s.length > 2 && s[1].t < rt - 200) s.shift();
  }

  private updateRemotes(dt: number, sNow: number) {
    for (const p of this.players.values()) {
      if (p.info.id === this.me || !p.avatar) continue;
      this.interp(p, sNow);
      // The holder visibly holds the ball even between snapshots.
      let arm = p.arm;
      if (this.ball.phase === 'held' && this.ball.holder === p.info.id && arm === Arm.Idle) arm = Arm.Holding;
      p.avatar.update(dt, p.pose, arm, p.charge);
    }
  }

  private updateFirstPerson(dt: number, now: number) {
    const holding = this.ball.phase === 'held' && this.ball.holder === this.me;
    const inGlove = !!this.localCatch || (holding && this.catchShow?.by === this.me && now < this.holdReadyAt - 120);
    const showHolding = holding && !inGlove && !(this.recoverAnim && now - this.recoverAnim.perf < 550 && this.ball.holder === this.me);
    this.fp.update(dt, this.glove.u, this.glove.v, showHolding, this.winding ? this.charge : null, inGlove);
  }

  private updateBall(dt: number, now: number, sNow: number) {
    const b = this.ball;
    const pos = new THREE.Vector3();
    let visible = true;
    let zip = false;
    const vel: Vec3 = [0, 0, 0];
    let airborne = false, rolling = 0;
    const holderAvatar = (id: string | null) => (id ? this.players.get(id)?.avatar ?? null : null);

    if (this.localCatch && b.phase === 'flight') {
      this.fp.pocketLocal(pos);
      pos.applyMatrix4(this.camera.matrixWorld);
    } else if (b.phase === 'held') {
      const recovering = this.recoverAnim && now - this.recoverAnim.perf < 550 ? this.recoverAnim : null;
      let handPos: THREE.Vector3 | null = null;
      if (b.holder === this.me) {
        const showGlove = this.catchShow?.by === this.me && now < this.holdReadyAt - 140;
        if (showGlove) { this.fp.pocketLocal(pos); pos.applyMatrix4(this.camera.matrixWorld); }
        else { handPos = this.fp.handBallLocal.clone().applyMatrix4(this.camera.matrixWorld); }
      } else {
        const av = holderAvatar(b.holder);
        if (av) {
          if (this.catchShow?.by === b.holder && now - this.catchShow.perf < 420) pos.copy(av.gloveWorldPos);
          else handPos = av.handBall.clone();
        } else visible = false;
      }
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
      let t = Math.max(0, tTrue - (b.thrower === this.me ? 0 : catchUp));
      // Waiting on a remote catch verdict: hold the ball at their glove briefly.
      if (b.phase === 'flight' && b.live) {
        if (!this.pinned) {
          const p = positionAt(this.traj, t);
          for (const r of this.players.values()) {
            if (!r.avatar || r.info.id === this.me || r.info.id === b.thrower) continue;
            const gp = r.avatar.gloveWorldPos;
            if (Math.hypot(p[0] - gp.x, p[1] - gp.y, p[2] - gp.z) < 0.28) { this.pinned = { id: r.info.id, until: now + 380 }; break; }
          }
        }
        if (this.pinned && now > this.pinned.until) this.pinned = null;
      }
      if (this.pinned) {
        const av = holderAvatar(this.pinned.id);
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
      // Hide a ball that has rolled far out of play... it is still recovered.
      void dt;
    } else visible = false;

    this.ballMesh.visible = visible;
    this.ballShadow.visible = visible;
    this.ballMesh.position.copy(pos);
    this.ballMesh.rotation.x += zip ? Math.hypot(...vel) * dt * 2.5 : 0;
    // Perceptual size floor so a distant ball stays readable (still a real ball up close).
    const camD = this.camera.position.distanceTo(pos);
    const s = Math.max(1, camD * 0.11);
    this.ballMesh.scale.setScalar(s);
    // Subtle motion blur on fast balls.
    const sp = Math.hypot(...vel);
    this.ballBlur.visible = visible && zip && sp > 9 && camD > 0.8;
    if (this.ballBlur.visible) {
      const dir = tmpV.set(vel[0], vel[1], vel[2]).normalize();
      const len = Math.min(0.9, sp * 0.016);
      this.ballBlur.position.copy(pos).addScaledVector(dir, -len / 2);
      this.ballBlur.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.ballBlur.scale.set(s * 0.85, (len / (BALL_RADIUS * 2)) + s, s * 0.85);
    }
    this.ballShadow.position.set(pos.x, 0.012, pos.z);
    const hgt = Math.max(0, pos.y);
    const sh = Math.max(0.15, 1 - hgt / 6);
    this.ballShadow.scale.setScalar(0.5 + hgt * 0.25);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = sh * (b.phase === 'held' ? 0.35 : 0.9);
    audio.ball({ active: visible && zip, pos: [pos.x, pos.y, pos.z], vel, airborne, rolling });
  }

  private updateLabels() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    for (const p of this.players.values()) {
      if (!p.label || !p.avatar) continue;
      tmpV.copy(p.avatar.headTop).project(this.camera);
      const on = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
      p.label.style.opacity = on ? '' : '0';
      if (on) p.label.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  private sendState(now: number) {
    if (now - this.lastSent < 1000 / CLIENT_STATE_HZ || !this.me) return;
    this.lastSent = now;
    const holding = this.ball.phase === 'held' && this.ball.holder === this.me;
    let arm: number = Arm.Idle;
    if (this.releasedAt > 0 && now - this.releasedAt < 380) arm = Arm.Release;
    else if (holding && this.winding) arm = Arm.Windup;
    else if (holding) arm = Arm.Holding;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    this.net.send({ t: 'st', p: [r(this.yaw), r(this.pitch), r(this.glove.u), r(this.glove.v), arm, Math.round(this.charge * 100) / 100] });
  }

  /** Snapshot for tests and debugging. */
  debugState() {
    return {
      me: this.me, status: this.net.status, ball: this.ball, score: this.score,
      players: [...this.players.values()].map((p) => ({ id: p.info.id, name: p.info.name, connected: p.info.connected, catches: p.info.catches, drops: p.info.drops, bot: p.info.bot })),
      yaw: this.yaw, pitch: this.pitch, glove: this.glove, controls: this.controls.stats, canThrow: this.canThrow(),
      audio: audio.log.slice(-40), zipPeak: Math.max(audio.zipPeak, audio.lastZipPeak), audioState: audio.ctx?.state ?? 'none', rtt: this.net.rtt, pixelRatio: this.pixelRatio,
    };
  }

  /** Point the view at a player (tests / tutorial). */
  lookAtPlayer(id: string) {
    const p = this.players.get(id);
    const me = this.myInfo();
    if (!p || !me) return;
    const a = lookAngles(eyePosition(me.pos), [p.info.pos[0], CHEST_HEIGHT + 0.05, p.info.pos[2]]);
    this.yaw = a.yaw; this.pitch = a.pitch;
  }
}
