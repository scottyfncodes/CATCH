// One play session in a room: networking, prediction, controls, rendering
// and audio, seen in third person. The server is authoritative; this predicts
// the local player's own throws and catches so they feel instant, and smooths
// everyone else.

import * as THREE from 'three';
import {
  BALL_RADIUS, CATCH_PERFECT, CATCH_WEB, CLIENT_STATE_HZ, DIVE_RECOVER, DIVE_SPEED, DIVE_TIME, LEAP_HEIGHT, LEAP_TIME,
  MOVE_RADIUS, RUN_ACCEL, RUN_SPEED, SIM_DT, WALK_SPEED,
  THROW_ZIP,
} from '../shared/constants';
import {
  type Trajectory, closestApproach, positionAt, simulateFlight, solveThrow, sweptMinDistance, throwElevation, velocityAt,
} from '../shared/physics';
import {
  type Hand, type Pose, bodyToWorld, clampReach, gloveReady, gloveWorld, interceptPlan, lookAngles, reachNorm, worldToBody,
} from '../shared/pose';
import {
  Arm, type Traits, DEFAULT_TRAITS, wildOffset, type BallEvent, type BallState, type CatchQuality, type PlayerInfo, type ScoreState, type ServerMsg, type SnapEntry, catchGrade, catchStyle, classifyCatch,
} from '../shared/protocol';
import { PerfOverlay } from './perf';
import { type Vec3, clamp, dist, lerp, wrapAngle } from '../shared/vec';
import { type Style, sameStyle } from '../shared/style';
import { RELEASE_TIME, getWindup, releasePointFor, windupId } from '../shared/windups';
import { audio } from './audio';
import { haptic } from './haptics';
import { type Aim, Controls, DEAD, FULL_PULL } from './input';
import { Net, type NetStatus } from './net';
import { AimArc } from './scene/aim';
import { Avatar } from './scene/avatar';
import { CameraRig, type EyeShot } from './scene/camera';
import { buildBall, contactShadow } from './scene/gear';
import { CatchGuide, type GuideState, TRAIL, Tier, type TierId } from './scene/guide';
import { type World, buildWorld } from './scene/world';
import { prefs, raiseRecord, recordFor, save } from './storage';

interface Snap { t: number; x: number; z: number; yaw: number; g: Vec3; arm: number; charge: number; lift: number; dive: number; pull: number }

interface Remote {
  info: PlayerInfo;
  avatar: Avatar | null;
  snaps: Snap[];
  label: HTMLDivElement | null;
  pose: Pose;
  arm: number;
  charge: number;
  pull: number;
  lift: number;
  dive: number;
}

export interface GameEvents {
  status(s: NetStatus): void;
  roster(players: PlayerInfo[], me: string | null): void;
  score(s: ScoreState, ev?: BallEvent): void;
  /** Gameplay moments the tutorial listens for. */
  moment(kind: 'move' | 'catch' | 'throw' | 'drop' | 'incoming' | 'holding' | 'aim'): void;
  toast(text: string): void;
  /** Your view changed: first person (catching) or third (throwing). */
  view(first: boolean): void;
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
/** The ball leaves the hand this long after you let go of the aim (ms). The same for every windup. */
const RELEASE_MS = RELEASE_TIME * 1000;
/** A flick: this much thumb travel (CSS px) inside this window (ms). */
const FLICK_PX = 40;
const FLICK_MS = 90;
/** How far in front of you the glove is held (m): out where you can see it. */
const GLOVE_OUT = 0.56;
/** Going after a wide one, you run until the ball is this far to your side (m): a comfortable reach. */
const CHASE_REACH = 0.45;
const smooth01 = (k: number) => { const c = clamp(k, 0, 1); return c * c * (3 - 2 * c); };

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
  private guide = new CatchGuide();
  private arrow: HTMLDivElement;
  private labels: HTMLElement;
  private raf = 0;
  private lastFrame = 0;
  private running = false;

  me: string | null = null;
  players = new Map<string, Remote>();
  ball: BallState = { phase: 'held', holder: null, tid: 0, thrower: null, t0: 0, p0: [0, 0, 0], v0: [0, 0, 0], live: false };
  traj: Trajectory | null = null;
  score: ScoreState = { streak: 0, sessionBest: 0, groupBest: 0, groupKey: '', dist: 14, misses: 0, traits: { ...DEFAULT_TRAITS }, glove: 1, speed: 1 };

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
  private gloveSet: Vec3 = [-0.2, 1.18, GLOVE_OUT];
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
  /** The windup you throw with, and how far through it you are (0..1). */
  windup: number;
  private windU = 0;
  /** How far back your thumb is (0..1), kept through the delivery: the size of your windup. */
  private pull = 0.5;
  /** You've let go: the delivery is on its way and the ball leaves the hand at `at`. */
  private pending: { p0: Vec3; v0: Vec3; at: number; power: number; traj: Trajectory; ring: Vec3 } | null = null;
  /** The hand's offset from the true release point at release: eased out over the first frames of flight. */
  private handFix: Vec3 = [0, 0, 0];
  /** A leap (for a high one) or a dive (for a wide one) in progress. */
  private leap: { at: number } | null = null;
  private dive: { at: number; dir: number } | null = null;
  private lift = 0;
  private diveAmt = 0;
  private actReadyAt = 0;
  private flicks: { t: number; dx: number; dy: number }[] = [];
  /** Where the incoming ball crosses your glove plane (this frame). */
  private cross: { at: Vec3; t: number } | null = null;
  private crossTier: TierId = Tier.Easy;
  /** The live throw is meant for you. */
  private forMe = false;
  /** You've gone after this throw (its id): your feet take you under it while you work the glove. */
  private chaseTid = -1;
  private hintTid = -1;
  /** How much the incoming throw is dropping out of the sky (0..1): the most it has been, so it doesn't fade as the ball comes level. */
  private steep = 0;
  private steepTid = -1;
  private driftTid = -1;
  private drift = 0;
  private targetId: string | null = null;
  private eyesUntil = 0;
  private first = false;
  private lastSent = 0;
  private partnerId: string | null = null;
  private home: Vec3 = [0, 0, 6];
  private homeMovedAt = 0;

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
  /** The ball going into a glove: where it struck, relative to the pocket, easing in over a few frames. */
  private seat: { off: THREE.Vector3; perf: number } | null = null;
  private spinAxis = new THREE.Vector3(1, 0, 0);
  private incomingTid = -1;
  private sentRecordFor = '';
  private lastCatchPerf = 0;
  private pixelRatio: number;
  private frameTimes: number[] = [];
  /** The ?fps=1 readout (null unless asked for). */
  private perf: PerfOverlay | null = null;
  private startRatio = 1;
  /** Test hook: run under incoming throws automatically (never set in normal play). */
  autoMove = false;
  /** Test hook: no hand tremor on the aim. */
  steadyAim = false;
  /** Test hook: throw a loftier, slower arc (so a test has time to do something under it). */
  arcScale = 1;
  /** Test hook: skip drawing (software-GL CI is too slow for real-time touch input). */
  renderEnabled = true;
  /** Test hook: hold this frame on screen (for a still), without advancing anything. */
  frozen = false;
  /** How far the hand was from the ball's true release point when your last throw left it (metres). */
  private releaseGap = -1;
  private releaseClip = -1;

  constructor(private root: HTMLElement, renderer: THREE.WebGLRenderer, touchLayer: HTMLElement, readonly room: string, private ev: GameEvents, traits?: Traits) {
    this.hand = prefs().hand;
    this.windup = prefs().windup;
    const lowSpec = (navigator.hardwareConcurrency || 4) <= 2;
    this.renderer = renderer;
    this.pixelRatio = renderer.getPixelRatio();
    this.startRatio = this.pixelRatio;
    this.renderer.shadowMap.enabled = !lowSpec;
    this.world = buildWorld(lowSpec, renderer);
    this.scene = this.world.scene;
    this.scene.add(this.rig.camera, this.aimArc.group, this.guide.group);
    this.rig.instant = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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
    if (PerfOverlay.wanted()) this.perf = new PerfOverlay(root);
    // Points at a throw that's coming in off the edge of your view.
    this.arrow = document.createElement('div');
    this.arrow.className = 'catch-arrow';
    this.labels.appendChild(this.arrow);

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

    this.net = new Net(room, () => ({ guest: prefs().guest, name: prefs().name, hand: prefs().hand, windup: prefs().windup, style: prefs().style, traits }));
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
    this.perf?.dispose();
    this.aimArc.dispose();
    this.guide.dispose();
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
    this.net.send({ t: 'prof', name: prefs().name, hand: h, w: this.windup, s: prefs().style });
  }

  setName(name: string) { this.net.send({ t: 'prof', name, hand: this.hand, w: this.windup, s: prefs().style }); }

  /** Change what you look like and wear (everyone sees it at once). */
  setStyle(style: Style) { this.net.send({ t: 'prof', name: prefs().name, hand: this.hand, w: this.windup, s: style }); }

  /** Change the windup you throw with (everyone sees it from your next throw). */
  setWindup(id: number) {
    this.windup = windupId(id);
    this.myAvatar?.setWindup(this.windup);
    this.net.send({ t: 'prof', name: prefs().name, hand: this.hand, w: this.windup, s: prefs().style });
  }

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
      case 'go': {
        // Someone has started their delivery: start the same one here, in step.
        if (m.by !== this.me) this.avatarOf(m.by)?.startDelivery(clamp((this.net.now() - m.at) / 1000, 0, 0.22));
        break;
      }
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
    if (info.pos[0] !== this.home[0] || info.pos[2] !== this.home[2]) this.homeMovedAt = performance.now();
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
        p = { info, avatar: null, snaps: [], label: null, pose: { x: info.pos[0], z: info.pos[2], yaw: info.facing, g: gloveReady(info.facing, info.hand) }, arm: 0, charge: 0, pull: 0.5, lift: 0, dive: 0 };
        this.players.set(info.id, p);
      }
      const moved = p.info.pos[0] !== info.pos[0] || p.info.pos[2] !== info.pos[2];
      const handChanged = p.info.hand !== info.hand || !sameStyle(p.info.style, info.style);
      p.info = info;
      if (info.id === this.me) {
        if (!this.myAvatar || handChanged) {
          this.myAvatar?.dispose();
          this.hand = info.hand;
          this.myAvatar = new Avatar(this.pos, this.yaw, info.hand, info.style, this.windup);
          this.scene.add(this.myAvatar.root);
        }
        if (moved) this.placeAtHome(info, false);
        continue;
      }
      if (!p.avatar || handChanged) {
        p.avatar?.dispose();
        p.avatar = new Avatar([p.pose.x, 0, p.pose.z], p.pose.yaw, info.hand, info.style, info.windup);
        this.scene.add(p.avatar.root);
      }
      if (p.avatar.windupId !== info.windup) p.avatar.setWindup(info.windup);
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
      p.snaps.push({ t, x: e[1], z: e[2], yaw: e[3], g: [e[4], e[5], e[6]], arm: e[7], charge: e[8], lift: e[9] ?? 0, dive: e[10] ?? 0, pull: e[11] ?? 0.5 });
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
        if (isNewFlight && b.thrower !== mine && b.phase === 'flight') {
          // Remote throw: the ball stays in the thrower's hand until the delivery you
          // are watching reaches its release, then eases into the true timeline.
          const av = this.avatarOf(b.thrower);
          av?.startDelivery();
          const wait = av ? Math.min(RELEASE_MS, av.timeToRelease * 1000) : 0;
          this.flightLag = Math.min(520, Math.max(0, Math.min(400, this.net.now() - b.t0)) + wait);
          this.flightRecvAt = perf + wait;
          this.forMe = this.meantForMe(b.thrower);
        } else if (isNewFlight) {
          this.flightLag = 0;
          this.forMe = false;
        }
      }
    }
    this.ball = b;
    if (b.phase !== 'flight') { this.predThrowAt = 0; this.forMe = false; }
    if (this.pending && !(b.phase === 'held' && b.holder === mine)) { this.pending = null; this.releasedAt = -1; }
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
        this.lastCatchEv = { by: ev.by, q: ev.q, st: ev.st ?? null };
        if (ev.by === mine) {
          const predicted = this.localCatch && this.localCatch.tid === b.tid;
          // Not predicted locally (rare): still give full feedback.
          if (!predicted) this.popLocal(ev.q, ev.speed, ev.g ?? 0.6);
          this.localCatch = null;
          const at = this.lastCatchPerf || perf;
          this.catchShow = { by: mine, perf: at };
          this.holdReadyAt = at + 560;
          // Stay in your own eyes for a beat (there's the ball, in your glove), then step back out to throw.
          this.eyesUntil = at + 480;
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
    return !!this.me && this.ball.phase === 'held' && this.ball.holder === this.me && performance.now() >= this.holdReadyAt && !this.predThrowAt && !this.pending;
  }

  /**
   * The throw a pull-back describes. The pull places a target on your
   * friend's glove plane (sideways pull = left/right, pull length = height),
   * which breathes a little with your hand; the throw is solved to arrive
   * exactly there, so the aim ring is the truth.
   */
  private planThrow(a: Aim, off: [number, number] | null = null): { p0: Vec3; v0: Vec3; speed: number; ring: Vec3; T: number } {
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
      // (And a long throw is harder to hold steady than a short one.)
      const amp = (0.012 + 0.038 * a.power + clamp((held - 1.4) * 0.05, 0, 0.07)) * Math.sqrt(Math.max(1, depth / 14));
      const t = performance.now() / 1000;
      wl = amp * (Math.sin(t * 2.1) + 0.5 * Math.sin(t * 4.7 + 1)) / 1.5;
      h += amp * (Math.sin(t * 1.6 + 2) + 0.5 * Math.sin(t * 3.9)) / 1.5;
    }
    const target: Vec3 = [me[0] + ux * depth + rx * (lat + wl), h, me[2] + uz * depth + rz * (lat + wl)];
    const yawTo = lookAngles(me, target).yaw;
    // The ball leaves from wherever your windup's arm slot puts the hand, and
    // is thrown as hard as the distance takes: a flat peg across the road, a
    // high arc for a long one. Pull harder and it goes flatter and quicker.
    // The arc depends on the distance and your pull, never on the windup.
    const p0 = releasePointFor(this.windup, me, yawTo, this.hand);
    // Wild throws: where it actually goes is knocked off line from where you aimed (the ring stays where you aimed).
    const to: Vec3 = off ? [target[0] + rx * off[0], Math.max(0.25, target[1] + off[1]), target[2] + rz * off[0]] : target;
    // Every throw has the room's zip, and as much more as Speed up says (the server's number, the same for everyone).
    const { v0, T } = solveThrow(p0, to, throwElevation(depth) * lerp(1.2, 0.65, a.power) * this.arcScale, THROW_ZIP * this.score.speed);
    return { p0, v0, speed: Math.hypot(...v0), ring: target, T };
  }

  /**
   * You let go. The aim is locked in and the delivery starts: stride, arm,
   * and RELEASE_MS later the ball leaves the hand.
   */
  private release(a: Aim) {
    this.aim = null;
    if (!this.canThrow() || !this.me) return;
    const { p0, v0, ring } = this.planThrow(a, this.score.traits.wild ? wildOffset(this.room, this.ball.tid + 1) : null);
    const traj = simulateFlight(p0, v0);
    const now = performance.now();
    this.pending = { p0, v0, at: now + RELEASE_MS, power: a.power, traj, ring };
    this.releasedAt = now;
    this.net.send({ t: 'go' });
    const side = this.hand === 'R' ? 1 : -1;
    // (On the audio clock, not a timer: it lands on the release exactly.)
    audio.armSwish(a.power, side, RELEASE_MS / 1000);
  }

  /** The release point of the delivery: the ball is away. */
  private launch(now: number) {
    const pd = this.pending;
    this.pending = null;
    if (!pd || !this.me || this.ball.phase !== 'held' || this.ball.holder !== this.me) return;
    const { p0, v0 } = pd;
    const hb = this.myAvatar?.handBall;
    this.handFix = hb ? [hb.x - p0[0], hb.y - p0[1], hb.z - p0[2]] : [0, 0, 0];
    this.releaseGap = Math.hypot(...this.handFix);
    this.releaseClip = this.myAvatar?.deliveryTime ?? -1;
    if (this.releaseGap > 0.5) this.handFix = [0, 0, 0];
    const t0 = this.net.now();
    const tid = this.ball.tid + 1;
    this.net.send({ t: 'throw', rt: t0, p: p0, v: v0, tid });
    // Predict.
    this.ball = { phase: 'flight', holder: null, tid, thrower: this.me, t0, p0, v0, live: true };
    this.setTraj(this.ball);
    this.flightLag = 0;
    this.forMe = false;
    this.predThrowAt = now;
    // The throw's own moment: the snap of it, a knock through the shot, a ring off the hand.
    const side = this.hand === 'R' ? 1 : -1;
    audio.release(pd.power, side);
    haptic('firm');
    this.rig.kick(0.45 + 0.5 * pd.power);
    this.guide.burst(p0, 0.35 + 0.5 * pd.power);
    this.ev.moment('throw');
  }

  // ------------------------------------------------------------------ frame

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const t0 = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (this.frozen) { if (this.renderEnabled) this.renderer.render(this.scene, this.rig.camera); return; }
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
    // The ball leaves the hand when the delivery you are watching reaches its
    // release (the clock is only a backstop, for a tab that stopped drawing).
    if (this.pending && (this.myAvatar ? this.myAvatar.deliveryTime >= RELEASE_TIME || this.myAvatar.deliveryTime < 0 : now >= this.pending.at)) this.launch(now);
    const ballPos = this.updateBall(dt, now, sNow);
    this.updateCamera(dt, now, ballPos);
    this.updateAim(dt);
    this.updateGuide(dt, sNow);
    this.world.update(dt, now / 1000);
    if (this.renderEnabled) this.renderer.render(this.scene, this.rig.camera);
    this.updateLabels();
    this.sendState(now);
    this.perf?.frame(now, performance.now() - t0, { renderer: this.renderer, startRatio: this.startRatio, shadows: this.renderer.shadowMap.enabled && this.world.sun.castShadow, drawing: this.renderEnabled });
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
    this.cross = incoming ? this.crossing(tNow) : null;

    // ---- a leap (for a high one) or a dive (for a wide one) in progress
    let lift = 0, diveAmt = 0, diving = false, down = false;
    if (this.leap) {
      const k = (now - this.leap.at) / (LEAP_TIME * 1000);
      if (k >= 1) this.leap = null;
      else lift = LEAP_HEIGHT * 4 * k * (1 - k);
    }
    if (this.dive) {
      const t = (now - this.dive.at) / 1000;
      if (t >= DIVE_TIME + DIVE_RECOVER) this.dive = null;
      else {
        diving = t < DIVE_TIME;
        down = !diving;
        diveAmt = this.dive.dir * Math.min(clamp(t / 0.09, 0, 1), clamp((DIVE_TIME + DIVE_RECOVER - t) / 0.3, 0, 1));
      }
    }
    this.lift = lift;
    this.diveAmt = diveAmt;
    // Going for it: the glove tracks the ball while you're in the air or laid out.
    if ((this.leap || diving) && this.cross) {
      const rel = worldToBody(this.yaw, [this.cross.at[0] - this.pos[0], this.cross.at[1], this.cross.at[2] - this.pos[2]]);
      this.gloveSet[0] = clamp(rel[0], -0.72, 0.72);
      this.gloveSet[1] = this.leap ? 2.3 : clamp(rel[1], 0.2, 2.2);
    }
    // A dive is a commitment: once you're down on the grass the glove comes
    // down with you. Go too early and the ball sails over it.
    if (down && this.dive) {
      const since = (now - this.dive.at) / 1000 - DIVE_TIME;
      if (since > 0.14) this.gloveSet[1] += (0.3 - this.gloveSet[1]) * (1 - Math.exp(-dt / 0.12));
    }
    let hustle = false;
    // Going after one: run until the ball is coming down a comfortable glove's
    // reach to that side of you. The glove is still yours to place.
    if (incoming && this.cross && this.chaseTid === b.tid && !this.dive && !this.keys.size) {
      const rel = worldToBody(this.yaw, [this.cross.at[0] - this.pos[0], 0, this.cross.at[2] - this.pos[2]]);
      const go = rel[0] - Math.sign(rel[0]) * Math.min(Math.abs(rel[0]), CHASE_REACH);
      hustle = true;
      const r = bodyToWorld(this.yaw, [go, 0, 0]);
      this.stepTo = Math.abs(go) > 0.05 ? [this.pos[0] + r[0], 0, this.pos[2] + r[2]] : null;
    }
    // The throw has gone by: nothing more to do in your own eyes. Step back out and watch it go.
    if (incoming && this.forMe && !this.cross && tNow > 0.2) this.forMe = false;
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
      else {
        // Going after a throw you break harder than when you're just shuffling over.
        const sp = hustle ? Math.min(RUN_SPEED * 1.2, d * 11) : Math.min(RUN_SPEED, d * 7);
        tvx = (dx / d) * sp; tvz = (dz / d) * sp;
      }
    } else if (!incoming && !this.gloveDragging && (holding || b.phase !== 'held' || this.homeMovedAt > this.lastInputAt) && now - Math.max(this.lastInputAt, this.homeMovedAt - 600) > 900) {
      // Nothing to do: wander back to your spot (a step back after a catch, a step in after a miss).
      const dx = this.home[0] - this.pos[0], dz = this.home[2] - this.pos[2];
      const d = Math.hypot(dx, dz);
      top = WALK_SPEED;
      if (d > 0.12) { tvx = (dx / d) * Math.min(WALK_SPEED, d * 1.5); tvz = (dz / d) * Math.min(WALK_SPEED, d * 1.5); }
    }
    // Planted while you wind up and deliver; down for a moment after a dive.
    if (this.controls.aiming || this.pending || down || (this.releasedAt > 0 && now - this.releasedAt < RELEASE_MS + 450)) { tvx = 0; tvz = 0; }
    if (diving && this.dive) {
      // A dive is a burst along the grass toward the ball; it eases off once the glove can get there.
      const r = bodyToWorld(this.yaw, [this.dive.dir, 0, 0]);
      const t = (now - this.dive.at) / 1000;
      let sp = DIVE_SPEED * (1 - 0.4 * (t / DIVE_TIME));
      if (this.cross) {
        const off = (this.cross.at[0] - this.pos[0]) * r[0] + (this.cross.at[2] - this.pos[2]) * r[2];
        sp *= clamp((off - 0.35) / 0.5, 0, 1);
      }
      this.vel.x = r[0] * sp; this.vel.z = r[2] * sp;
      this.stepTo = null;
    } else {
      const ax = tvx - this.vel.x, az = tvz - this.vel.z;
      const al = Math.hypot(ax, az), amax = RUN_ACCEL * dt * (top === WALK_SPEED ? 0.4 : hustle ? 1.6 : 1);
      const kk = al > amax ? amax / al : 1;
      this.vel.x += ax * kk; this.vel.z += az * kk;
    }
    const prevX = this.pos[0], prevZ = this.pos[2];
    this.pos[0] += this.vel.x * dt; this.pos[2] += this.vel.z * dt;
    const hx = this.pos[0] - this.home[0], hz = this.pos[2] - this.home[2];
    const hd = Math.hypot(hx, hz);
    if (hd > MOVE_RADIUS) {
      this.pos[0] = this.home[0] + (hx / hd) * MOVE_RADIUS; this.pos[2] = this.home[2] + (hz / hd) * MOVE_RADIUS;
      this.vel.x *= 0.5; this.vel.z *= 0.5;
    }

    // ---- facing: square to your friend (so a set glove stays set), or your aim while throwing
    const faceAt = this.pending ? this.pending.ring : this.controls.aiming ? this.aimRing : null;
    const faceYaw = faceAt ? lookAngles(this.pos, faceAt).yaw : this.partnerYaw();
    this.yaw = wrapAngle(this.yaw + wrapAngle(faceYaw - this.yaw) * (1 - Math.exp(-dt / 0.14)));

    // ---- glove: tucked while you hold the ball, otherwise exactly where you hold it
    const showingCatch = this.localCatch || (holding && this.catchShow?.by === this.me && now < this.holdReadyAt);
    let want: Vec3;
    if (holding || showingCatch) {
      want = gloveReady(this.yaw, this.hand);
      // Got it: the glove comes up in front of you with the ball in it (you
      // look at your catch; you don't look down for it).
      if (showingCatch) want = bodyToWorld(this.yaw, [this.hand === 'R' ? -0.1 : 0.1, 1.4, 0.5]);
      // After a catch, the next target starts from a relaxed ready spot.
      this.gloveSet = [this.hand === 'R' ? -0.2 : 0.2, 1.18, GLOVE_OUT];
    } else {
      want = clampReach(bodyToWorld(this.yaw, this.gloveSet), 0.98);
      want[1] += lift;
    }
    // A last-instant reflex: a ball just off the glove gets a lunge (and an ugly POP).
    let lunging = false;
    if (incoming && this.traj && !holding && !down) {
      const gw: Vec3 = [this.pos[0] + want[0], want[1], this.pos[2] + want[2]];
      const ca = closestApproach(this.traj, gw);
      const until = ca.t - tNow;
      const gs = this.score.glove;
      if (until > -0.02 && until < 0.2 && ca.dist > 0.16 * gs && ca.dist < LUNGE_REACH + 0.16 * (gs - 1)) {
        const bp = positionAt(this.traj, ca.t);
        const k = 1 - (0.135 * gs) / ca.dist;
        want = clampReach([want[0] + (bp[0] - gw[0]) * k, want[1] + (bp[1] - gw[1]) * k, want[2] + (bp[2] - gw[2]) * k], 1, lift);
        lunging = true;
        if (this.lungeTid !== b.tid) this.lungeTid = b.tid;
      }
    }
    this.gloveT = want;
    // Smooth in the world, not relative to the body: a hand holding a spot
    // doesn't trail behind when you step.
    const tau = lunging ? 0.045 : this.gloveDragging || lift > 0 || diving ? 0.035 : showingCatch ? 0.1 : holding ? 0.18 : 0.06;
    const gk = 1 - Math.exp(-dt / tau);
    const moved: Vec3 = [this.pos[0] - prevX, 0, this.pos[2] - prevZ];
    const g: Vec3 = [this.glove[0] - moved[0], this.glove[1], this.glove[2] - moved[2]];
    for (let i = 0; i < 3; i++) g[i] += (this.gloveT[i] - g[i]) * gk;
    this.glove = clampReach(g, 1, lift);
  }

  /** Where (and when, seconds after release) the incoming ball crosses the plane you hold your glove in. */
  private crossing(tNow: number): { at: Vec3; t: number } | null {
    const tr = this.traj;
    if (!tr) return null;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const depth = this.gloveSet[2];
    const s = tr.samples;
    const end = Math.min(tr.count - 1, Math.floor(tr.groundT / SIM_DT));
    let i = clamp(Math.floor(tNow / SIM_DT), 0, end);
    let prev = (s[i * 3] - this.pos[0]) * fx + (s[i * 3 + 2] - this.pos[2]) * fz - depth;
    if (prev <= 0) return null;
    for (i++; i <= end; i++) {
      const d = (s[i * 3] - this.pos[0]) * fx + (s[i * 3 + 2] - this.pos[2]) * fz - depth;
      if (d <= 0) {
        const t = (i - 1 + prev / (prev - d)) * SIM_DT;
        return { at: positionAt(tr, t), t };
      }
      prev = d;
    }
    // It comes down just short of you: the place to get the glove is where it lands.
    const t = end * SIM_DT;
    return prev < 1.2 ? { at: positionAt(tr, t), t } : null;
  }

  /**
   * A flick of the thumb at a throw that's out of reach: sideways lays you out
   * after a wide one, upward gets you off the ground for a high one. It only
   * happens when the ball is really out there, so a quick ordinary move of the
   * glove never throws you on the grass.
   */
  private tryAct(now: number): boolean {
    if (!this.incoming() || !this.cross || this.leap || this.dive || now < this.actReadyAt) return false;
    let fx = 0, fy = 0;
    for (const f of this.flicks) { fx += f.dx; fy += f.dy; }
    if (Math.hypot(fx, fy) < FLICK_PX) return false;
    const rel = worldToBody(this.yaw, [this.cross.at[0] - this.pos[0], this.cross.at[1], this.cross.at[2] - this.pos[2]]);
    if (fy > Math.abs(fx) * 1.1 && rel[1] > 2.12) {
      this.leap = { at: now };
      audio.armSwish(0.35, 0);
    } else if (Math.abs(fx) > Math.abs(fy) * 1.1 && rel[0] * Math.sign(fx) > 0.9) {
      this.dive = { at: now, dir: Math.sign(fx) };
      this.stepTo = null;
      audio.armSwish(0.55, Math.sign(fx));
    } else return false;
    this.actReadyAt = now + 900;
    this.flicks.length = 0;
    save({ acts: prefs().acts + 1 });
    haptic('light');
    return true;
  }

  /** Your thumb moves your glove: precise when slow, quick when you flick. */
  private moveGlove(dx: number, dy: number, speed: number) {
    if (this.ball.phase === 'held' && this.ball.holder === this.me) return;
    const now = performance.now();
    this.flicks.push({ t: now, dx, dy });
    while (this.flicks.length && now - this.flicks[0].t > FLICK_MS) this.flicks.shift();
    this.lastInputAt = now;
    if (this.leap || this.dive || this.tryAct(now)) return;
    // A throw that's off to one side: move your thumb that way and you go after it.
    if (this.incoming() && this.cross && this.chaseTid !== this.ball.tid) {
      const rel = worldToBody(this.yaw, [this.cross.at[0] - this.pos[0], this.cross.at[1], this.cross.at[2] - this.pos[2]]);
      // (Thumb travel since this throw left the hand: a slow drag counts as much as a quick one.)
      if (this.driftTid !== this.ball.tid) { this.driftTid = this.ball.tid; this.drift = 0; }
      this.drift += dx;
      const fx = this.drift;
      if (Math.abs(rel[0]) > 0.6 && fx * rel[0] > 0 && Math.abs(fx) > 6) {
        // Off you go, glove out on that side at about the right height; the rest is yours.
        this.chaseTid = this.ball.tid;
        this.gloveSet[0] = Math.sign(rel[0]) * CHASE_REACH;
        this.gloveSet[1] = clamp(rel[1], 0.25, 2.2);
      }
    }
    // While your feet are taking you there, sideways thumb travel trims the glove (it doesn't fight the run).
    const chasing = this.chaseTid === this.ball.tid && this.incoming();
    const gain = 0.0045 + Math.min(0.02, speed * 0.012);
    const gs = this.gloveSet;
    gs[0] += dx * gain;
    gs[1] = clamp(gs[1] + dy * gain, 0.18, 2.3);
    // Past your reach to the side: step over after it.
    const lim = 0.72;
    if (chasing) gs[0] = clamp(gs[0], -lim, lim);
    else if (Math.abs(gs[0]) > lim) {
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
    gs[2] = GLOVE_OUT + clamp((1.0 - gs[1]) * 0.12, -0.14, 0.08);
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
    const f = bodyToWorld(this.yaw, [0, 0, GLOVE_OUT]);
    this.stepTo = [p[0] - r[0] * side - f[0], 0, p[2] - r[2] * side - f[2]];
    this.gloveSet = [side, clamp(p[1], 0.18, 2.3), GLOVE_OUT];
    // Over your head: get off the ground for it, timed to the ball.
    if (p[1] > 2.25 && !this.leap && ip.t - tNow < LEAP_TIME * 0.5 && ip.t - tNow > 0) this.leap = { at: performance.now() };
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
    const lift = this.lift, dive = this.diveAmt;
    const q = classifyCatch(res.dist, speed, this.score.glove);
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
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    this.net.send({ t: 'catch', tid: b.tid, at: b.t0 + res.t * 1000, pose: [at.x, at.z, at.yaw, at.g[0], at.g[1], at.g[2], r3(lift), r3(dive)] });
    const vel = velocityAt(this.traj, res.t);
    if (q === 'deflect') {
      this.popLocal('deflect', speed, 0);
      this.myAvatar?.catchImpact(vel, speed * 0.5);
      return;
    }
    this.localCatch = { tid: b.tid, q, at: res.t };
    this.lastCatchPerf = performance.now();
    // Where the ball actually met the leather, from the middle of the pocket.
    const hit = positionAt(this.traj, res.t), pocket = gloveWorld(at);
    const off: Vec3 = [hit[0] - pocket[0], hit[1] - pocket[1], hit[2] - pocket[2]];
    this.seat = { off: new THREE.Vector3(off[0], off[1], off[2]), perf: this.lastCatchPerf };
    this.myAvatar?.catchImpact(vel, speed, off);
    const grade = catchGrade(res.dist, this.score.glove);
    this.popLocal(q, speed, grade);
    // The knock of the ball through your view, and a ring off the pocket.
    this.rig.kick(clamp(speed / 22, 0.35, 1));
    this.guide.burst(g, grade);
    this.lastStyle = catchStyle(worldToBody(at.yaw, [at.g[0], at.g[1] - lift, at.g[2]]), this.hand, lift, dive, Math.hypot(this.vel.x, this.vel.z));
  }

  /** The last catch anyone made, as the server called it. */
  private lastCatchEv: { by: string; q: CatchQuality; st: string | null } | null = null;
  /** How you made your last catch (the server names it for everyone; this is for tests). */
  private lastStyle: ReturnType<typeof catchStyle> = null;

  /** Is the live throw coming to you (rather than to someone else in the ring)? */
  private meantForMe(thrower: string | null): boolean {
    if (!this.traj || !this.me) return false;
    const others = [...this.players.values()].filter((p) => p.info.id !== thrower);
    if (others.length <= 1) return true;
    let best = Infinity, mine = Infinity;
    for (const o of others) {
      const f = this.feetOf(o.info.id)!;
      const n = interceptPlan(this.traj, 0, f[0], f[2]).norm;
      if (o.info.id === this.me) mine = n;
      best = Math.min(best, n);
    }
    return mine <= best + 0.05;
  }

  /** Who the player holding the ball is squared up to (in a ring of three or more). */
  private targetOf(holder: string): string | null {
    const h = this.players.get(holder);
    const hf = this.feetOf(holder);
    if (!h || !hf) return null;
    const others = [...this.players.values()].filter((p) => p.info.id !== holder);
    if (others.length === 1) return others[0].info.id;
    let best: string | null = null, bd = Infinity;
    for (const o of others) {
      const f = this.feetOf(o.info.id)!;
      let d = Math.abs(wrapAngle(lookAngles(hf, f).yaw - h.pose.yaw));
      // Stick with the current read unless someone else is clearly the target.
      if (o.info.id === this.targetId) d -= 0.12;
      if (d < bd) { bd = d; best = o.info.id; }
    }
    this.targetId = best;
    return best;
  }

  /**
   * Which view you should be in. Catching is first person: someone else has
   * the ball and is squared up to you, or their throw is on its way to you
   * (and for a beat after you catch it). Throwing is third person.
   */
  private wantFirst(now: number): boolean {
    const b = this.ball;
    if (!this.me || !this.myAvatar || this.players.size < 2 || this.net.status !== 'open') return false;
    if (this.localCatch) return true;
    if (b.phase === 'held') {
      if (!b.holder) return false;
      if (b.holder === this.me) return now < this.eyesUntil;
      return this.players.has(b.holder) && this.targetOf(b.holder) === this.me;
    }
    return b.phase === 'flight' && b.live && b.thrower !== this.me && this.forMe;
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
    p.pull = lerp(a.pull, bb.pull, k);
    p.lift = lerp(a.lift, bb.lift, k);
    p.dive = lerp(a.dive, bb.dive, k);
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
      p.avatar.update(dt, { pose: p.pose, arm, charge: p.charge, pull: p.pull, look: this.lookTarget(p.info.id, this.lastBallPos), gloved, ready, lift: p.lift, dive: p.dive, lag: INTERP_MS / 1000 });
    }
  }

  private myArm(now: number): number {
    const holding = this.ball.phase === 'held' && this.ball.holder === this.me;
    if (this.pending || (this.releasedAt > 0 && now - this.releasedAt < RELEASE_MS + 450)) return Arm.Release;
    if (holding && this.controls.aiming) return Arm.Windup;
    if (holding) return Arm.Holding;
    return Arm.Idle;
  }

  private updateMe(dt: number, now: number, _sNow: number) {
    if (!this.myAvatar || !this.me) return;
    // The windup runs at its own tempo while you hold the aim, rests at the top
    // until you let go, and comes back down if you ease off.
    const tempo = getWindup(this.windup).params.tempo;
    if (this.controls.aiming && this.aim) this.pull += (this.aim.power - this.pull) * (1 - Math.exp(-dt / 0.06));
    if (this.controls.aiming && this.aim?.armed && this.canThrow()) this.windU = Math.min(1, this.windU + dt / tempo);
    else if (this.controls.aiming) this.windU = Math.max(0, this.windU - dt * 2.2);
    else if (!this.pending) this.windU = 0;
    const gloved = !!this.localCatch || (this.catchShow?.by === this.me && now < this.holdReadyAt - 200);
    this.myAvatar.update(dt, { pose: this.myPose(), arm: this.myArm(now), charge: this.windU, pull: this.pull, look: this.lookTarget(this.me, this.lastBallPos), gloved, ready: this.incoming(), lift: this.lift, dive: this.diveAmt });
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
      const catchUp = this.flightLag / 1000 * Math.max(0, 1 - Math.max(0, now - this.flightRecvAt) / 380);
      const t = Math.max(0, tTrue - (b.thrower === this.me ? 0 : catchUp));
      const thrower = b.phase === 'flight' && b.thrower !== this.me && now < this.flightRecvAt ? this.avatarOf(b.thrower) : null;
      // Waiting on a remote catch verdict: hold the ball at their glove briefly.
      if (b.phase === 'flight' && b.live) {
        if (!this.pinned) {
          const p = positionAt(this.traj, t);
          for (const r of this.players.values()) {
            if (!r.avatar || r.info.id === this.me || r.info.id === b.thrower) continue;
            const gp = r.avatar.gloveWorldPos;
            if (Math.hypot(p[0] - gp.x, p[1] - gp.y, p[2] - gp.z) < 0.24 * this.score.glove) {
              this.pinned = { id: r.info.id, until: now + 380 };
              this.seat = { off: new THREE.Vector3(p[0] - gp.x, p[1] - gp.y, p[2] - gp.z), perf: now };
              break;
            }
          }
        }
        if (this.pinned && now > this.pinned.until) this.pinned = null;
      }
      if (this.pinned) {
        const av = this.avatarOf(this.pinned.id);
        if (av) pos.copy(av.gloveWorldPos); else this.pinned = null;
      } else if (thrower) {
        // Still in their hand: the delivery you're watching hasn't reached its release.
        pos.copy(thrower.handBall);
      } else {
        const p = positionAt(this.traj, t);
        pos.set(p[0], p[1], p[2]);
        if (b.thrower === this.me && b.phase === 'flight' && t < 0.12) {
          // Out of your actual hand: any last few centimetres ease away in the first frames.
          const k = 1 - smooth01(t / 0.12);
          pos.x += this.handFix[0] * k; pos.y += this.handFix[1] * k; pos.z += this.handFix[2] * k;
        }
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

    // Into a glove: the ball goes from where it struck down into the pocket (quick, but you see it go in).
    if (this.seat && !zip) {
      const k = clamp((now - this.seat.perf) / 90, 0, 1);
      if (k >= 1) this.seat = null; else pos.addScaledVector(this.seat.off, (1 - k) * (1 - k));
    } else if (zip) this.seat = null;
    this.ballMesh.visible = visible;
    this.ballShadow.visible = visible;
    this.ballMesh.position.copy(pos);
    // Spin about the right axis: backspin off the fingers in the air, rolling forward along the grass.
    if (zip) {
      const h = Math.hypot(vel[0], vel[2]);
      if (h > 0.05) this.spinAxis.set(vel[2] / h, 0, -vel[0] / h);
      const sp = Math.hypot(...vel);
      this.ballMesh.rotateOnWorldAxis(this.spinAxis, airborne ? -sp * dt * 2.4 : (h / BALL_RADIUS) * dt);
    }
    // Perceptual size floor so a distant ball stays readable (still a real ball
    // up close). Through your own eyes, with the wide view a catch needs, the
    // floor is set in pixels: a throw you can't see is a throw you can't catch.
    const camD = this.rig.camera.position.distanceTo(pos);
    // A thrown ball gets small as it goes: that shrinking is what speed looks
    // like. It is only kept from vanishing (a couple of pixels). Coming at you
    // in first person it is kept bigger: a throw you can't see is a throw you can't catch.
    const px = (camD * Math.tan((this.rig.camera.fov * Math.PI) / 360)) / ((this.root.clientHeight || 700) / 2) / BALL_RADIUS;
    const s = Math.max(1, px * (zip ? 2.2 + 3.3 * this.rig.blend : 2.2));
    this.ballMesh.scale.setScalar(s);
    // A streak behind a fast ball: about a twentieth of a second of its travel,
    // so a hard throw draws a long line and a soft one barely any.
    const sp = Math.hypot(...vel);
    this.ballBlur.visible = visible && zip && sp > 7;
    if (this.ballBlur.visible) {
      const mineOut = b.thrower === this.me && b.phase === 'flight';
      const dir = tmpV.set(vel[0], vel[1], vel[2]).normalize();
      const len = Math.min(2.6, sp * (mineOut ? 0.06 : 0.035));
      const wide = Math.max(s * 0.8, px * 1.5);
      this.ballBlur.position.copy(pos).addScaledVector(dir, -len / 2);
      this.ballBlur.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.ballBlur.scale.set(wide, (len / (BALL_RADIUS * 2)) + s, wide);
      (this.ballBlur.material as THREE.MeshBasicMaterial).opacity = mineOut ? 0.42 : 0.26;
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

  private updateCamera(dt: number, now: number, ball: Vec3 | null) {
    const pid = this.partner();
    const pf = this.feetOf(pid);
    const av = this.myAvatar;
    const me: Vec3 = av ? [av.position.x, 0, av.position.z] : this.pos;
    const partner: Vec3 = pf ?? [me[0] - Math.sin(this.yaw) * 12, 0, me[2] - Math.cos(this.yaw) * 12];
    // Throwing (third person): the camera stands behind you on your glove side,
    // and cranes up over you while you wind up: all of your delivery, your
    // friend and the aim ring in one shot.
    const winding = this.controls.aiming || !!this.pending || (this.releasedAt > 0 && now - this.releasedAt < RELEASE_MS + 250);

    // Catching (first person): your own eyes, on the ball (or on whoever is about to throw it).
    const first = this.wantFirst(now);
    let eyes: EyeShot | null = null;
    if (av) {
      const g: Vec3 = [av.gloveWorldPos.x, av.gloveWorldPos.y, av.gloveWorldPos.z];
      const pav = this.avatarOf(pid);
      let far: Vec3 = pav ? [pav.chestPos.x, pav.chestPos.y + 0.1, pav.chestPos.z] : [partner[0], 1.3, partner[2]];
      // Waiting: your friend up top, your glove along the bottom of the view.
      let near = g, pitchK = this.rig.aspect < 1 ? 0.3 : 0.22, yawK = 0.25, wide = 0, landing = 0;
      const watch = Math.hypot(partner[0] - me[0], partner[2] - me[2]);
      if (this.localCatch || (this.catchShow?.by === this.me && now < this.eyesUntil)) {
        // Caught it: your eyes stay up, and the glove comes up into them with the ball.
        pitchK = 0.6; yawK = 0.5; wide = 0.3;
      } else if (this.incoming() && this.forMe && this.lastBallPos) {
        // The ball in the upper part of the view, the spot it's coming to in the
        // lower part; they become the same place as it arrives.
        far = this.lastBallPos;
        if (this.cross) near = this.cross.at;
        // A long throw comes down steeply: as it arrives, your eyes go to where it is landing.
        const tta = this.cross ? this.cross.t - (this.net.now() - this.ball.t0) / 1000 : 1;
        // One dropping out of the sky needs a wider look (the ball overhead, the
        // glove below) and, as it lands, eyes on where it's landing. A flat
        // throw needs neither: it comes to you, and you never look at your feet.
        const up = Math.atan2(far[1] - av.eye.y, Math.hypot(far[0] - av.eye.x, far[2] - av.eye.z));
        this.steep = Math.max(this.steep * (this.steepTid === this.ball.tid ? 1 : 0), smooth01((up - 0.25) / 0.4));
        this.steepTid = this.ball.tid;
        landing = smooth01(1 - tta / 0.7) * this.steep;
        // A long throw is watched off the hand down the long lens; the view has opened right up
        // well before it gets to you (and from the start, for a throw that isn't in the air long).
        const opening = smooth01((2.6 - tta) / 1.2);
        pitchK = (0.5 + 0.4 * landing) * opening + pitchK * (1 - opening); yawK = 0.25 + 0.25 * opening; wide = (1 + 0.5 * this.steep) * opening;
      }
      eyes = { eye: [av.eye.x, av.eye.y, av.eye.z], yaw: this.yaw, far, near, pitchK, yawK, wide, landing, lean: av.sideLean, watch };
    }
    // A long throw of yours in the air: the shot lets go of you and goes with the ball.
    const mine = this.ball.phase === 'flight' && this.ball.live && this.ball.thrower === this.me;
    const flight = mine ? smooth01((Math.hypot(partner[0] - me[0], partner[2] - me[2]) - 22) / 20) : 0;
    this.rig.update(dt, { me, partner, ball, side: this.hand === 'R' ? -1 : 1, aim: winding ? this.aimRing : null, windup: winding ? 1 : 0, flight }, eyes, first);
    this.world.focus(me[0], me[2]);
    // In your own eyes your head and chest are out of the way (they still cast
    // your shadow). They fade by how close the camera is, so the move in and
    // out never passes through a solid head.
    if (av) {
      av.setCoreOpacity(this.rig.blend > 0 ? smooth01((this.rig.camera.position.distanceTo(av.eye) - 0.55) / 0.6) : 1);
      av.fadeSleeve(this.rig.blend > 0 ? this.rig.camera.position : null);
    }
    // Big mitt: everyone's glove is the room's size (and solid: the ring and the pocket mark show through it).
    const gsize = this.score.glove;
    av?.setGloveSize(gsize);
    for (const p of this.players.values()) if (p.avatar && p.info.id !== this.me) p.avatar.setGloveSize(gsize);
    if (first !== this.first) { this.first = first; this.ev.view(first); }
    const l = this.rig.listener(me);
    audio.setListener(l.pos, l.fwd, l.up);
  }

  /**
   * The catcher's guide: a ring where the throw will cross your glove, coloured
   * by how hard it is to get to from where you stand, and a mark on your pocket.
   */
  private updateGuide(dt: number, sNow: number) {
    let st: GuideState | null = null;
    let arrow = '';
    const c = this.cross;
    if (c && this.forMe && this.incoming() && this.rig.blend > 0.02) {
      const tNow = (sNow - this.ball.t0) / 1000;
      const tta = c.t - tNow;
      const off: Vec3 = [c.at[0] - this.pos[0], c.at[1], c.at[2] - this.pos[2]];
      const rel = worldToBody(this.yaw, off);
      const side = Math.max(0, Math.abs(rel[0]) - 0.8), high = Math.max(0, rel[1] - 2.3);
      const run = RUN_SPEED * Math.max(0, tta - 0.15) * 0.75;
      const n = reachNorm(off);
      let tier: TierId = Tier.Gone;
      if (n <= 0.8) tier = Tier.Easy;
      else if (n <= 1 || (high === 0 && side <= run * 0.6)) tier = Tier.Reach;
      else if (high <= LEAP_HEIGHT - 0.06 && side <= run + DIVE_SPEED * DIVE_TIME * 0.7) tier = Tier.Great;
      if (this.leap || this.dive) tier = Math.min(tier, Tier.Great) as TierId;
      this.crossTier = tier;
      // Until you have the hang of it: say what a throw like this is asking for.
      if (this.hintTid !== this.ball.tid && prefs().acts < 3 && tta > 0.25 && (high > 0 || side > run * 0.6)) {
        this.hintTid = this.ball.tid;
        this.ev.toast(high > 0 ? 'Over your head: flick up to jump' : 'Out of reach: flick toward it to dive');
      }
      const pocket = gloveWorld(this.myPose());
      const gsz = this.score.glove;
      const on = clamp(1 - (dist(pocket, c.at) / gsz - CATCH_PERFECT) / (CATCH_WEB - CATCH_PERFECT), 0, 1);
      // The trail runs from just ahead of the ball you see to the spot.
      const seen = this.lastBallPos ?? c.at;
      const from = clamp(c.t - Math.hypot(seen[0] - c.at[0], seen[1] - c.at[1], seen[2] - c.at[2]) / Math.max(4, Math.hypot(...velocityAt(this.traj!, tNow))), 0, c.t);
      const path: Vec3[] = [];
      for (let i = 1; i <= TRAIL && c.t - from > 0.08; i++) path.push(positionAt(this.traj!, from + ((c.t - from) * i) / (TRAIL + 1)));
      st = { at: c.at, pocket, k: clamp(tNow / Math.max(0.05, c.t), 0, 1), tier, on, path, size: gsz };
      // Off the edge of your view: point at it.
      tmpV.set(c.at[0], c.at[1], c.at[2]).project(this.rig.camera);
      if (tmpV.z > 1 || Math.abs(tmpV.x) > 0.9 || Math.abs(tmpV.y) > 0.9) {
        const w = this.root.clientWidth, h = this.root.clientHeight;
        const flip = tmpV.z > 1 ? -1 : 1;
        const dx = tmpV.x * flip, dy = tmpV.y * flip;
        const m = Math.max(Math.abs(dx) / 0.84, Math.abs(dy) / 0.8, 1e-3);
        const x = (dx / m * 0.5 + 0.5) * w, y = (-dy / m * 0.5 + 0.5) * h;
        arrow = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${Math.atan2(-dy, dx).toFixed(3)}rad)`;
        this.arrow.dataset.tier = String(tier);
      }
    }
    this.guide.update(st, this.rig.blend, this.rig.camera, dt);
    this.arrow.style.opacity = arrow ? String(this.rig.blend) : '0';
    if (arrow) this.arrow.style.transform = arrow;
  }

  private updateAim(dt: number) {
    const a = this.aim;
    const pd = this.pending;
    if (pd || (a && a.armed && this.controls.aiming && this.canThrow())) {
      if (pd) {
        // Let go: the aim is locked until the ball leaves the hand.
        this.aimTraj = pd.traj;
        this.aimRing = pd.ring;
      } else {
        const { p0, v0, T } = this.planThrow(a!);
        this.aimTraj = simulateFlight(p0, v0);
        // The ring sits where the ball really crosses the glove plane.
        this.aimRing = positionAt(this.aimTraj, T);
      }
      const pav = this.avatarOf(this.aimPartnerId);
      const off = pav ? dist(this.aimRing, [pav.gloveWorldPos.x, pav.gloveWorldPos.y, pav.gloveWorldPos.z]) : 1;
      const glove: Vec3 | null = pav ? [pav.gloveWorldPos.x, pav.gloveWorldPos.y, pav.gloveWorldPos.z] : null;
      this.aimArc.show(this.aimTraj, pd ? pd.power : a!.power, this.rig.camera, dt, { pos: this.aimRing, onTarget: clamp(1 - (off / this.score.glove - CATCH_PERFECT) / (CATCH_WEB - CATCH_PERFECT), 0, 1), glove });
    } else {
      if (!this.controls.aiming) this.aimRing = null;
      this.aimArc.show(null, 0, this.rig.camera, dt, null);
    }
  }

  private hudAt = 0;
  private hudY = 0;
  /** The bottom edge of whatever is written across the top of the screen (measured a few times a second, not every frame). */
  private hudBottom(): number {
    const now = performance.now();
    if (now - this.hudAt > 250) {
      this.hudAt = now;
      let y = 0;
      for (const el of document.querySelectorAll<HTMLElement>('.streak, .coach')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && getComputedStyle(el).opacity !== '0') y = Math.max(y, r.bottom);
      }
      this.hudY = y;
    }
    return this.hudY;
  }

  private updateLabels() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    for (const p of this.players.values()) {
      if (!p.label || !p.avatar) continue;
      tmpV.copy(p.avatar.headTop).project(this.rig.camera);
      // A name never sits on top of the scoreboard or a tip: up there it steps aside.
      const y = (-tmpV.y * 0.5 + 0.5) * h;
      const on = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1 && y - 22 > this.hudBottom();
      p.label.style.opacity = on ? '' : '0';
      if (on) p.label.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }

  private sendState(now: number) {
    if (now - this.lastSent < 1000 / CLIENT_STATE_HZ || !this.me) return;
    this.lastSent = now;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    this.net.send({ t: 'st', p: [r(this.pos[0]), r(this.pos[2]), r(this.yaw), r(this.glove[0]), r(this.glove[1]), r(this.glove[2]), this.myArm(now), r2(this.windU), r2(this.lift), r2(this.diveAmt), r2(this.pull)] });
  }

  /** Snapshot for tests and debugging. */
  debugState() {
    return {
      me: this.me, status: this.net.status, ball: this.ball, score: this.score,
      players: [...this.players.values()].map((p) => ({ id: p.info.id, name: p.info.name, connected: p.info.connected, catches: p.info.catches, drops: p.info.drops, bot: p.info.bot })),
      pos: this.pos, home: this.home, yaw: this.yaw, glove: this.glove, gloveSet: this.gloveSet, partner: this.partnerId, partnerPos: this.feetOf(this.partnerId), controls: this.controls.stats, canThrow: this.canThrow(),
      audio: audio.log.slice(-40), zipPeak: Math.max(audio.zipPeak, audio.lastZipPeak), audioState: audio.ctx?.state ?? 'none', rtt: this.net.rtt, pixelRatio: this.pixelRatio,
      // What the last frame cost to draw (shadow pass included).
      draw: { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles },
      fov: this.rig.camera.fov,
      // Which view you're in (and how far the camera is into it), your windup and your delivery.
      first: this.first, view: this.rig.blend, windup: this.windup, windU: this.windU, pending: !!this.pending,
      delivery: this.myAvatar?.deliveryTime ?? -1, releaseGap: this.releaseGap, releaseClip: this.releaseClip,
      windups: [...this.players.values()].map((p) => ({ id: p.info.id, windup: p.info.windup, saves: p.info.saves })),
      hand: this.myAvatar ? [this.myAvatar.handBall.x, this.myAvatar.handBall.y, this.myAvatar.handBall.z] : null,
      lastCatch: this.lastCatchEv, ballPos: this.lastBallPos, lift: this.lift,
      // Seconds until the incoming ball reaches your glove plane.
      // How far the first-person view has turned from straight ahead (rad).
      turn: this.rig.blend > 0.99 ? wrapAngle(this.rig.camera.rotation.y - this.yaw) : 0,
      tta: this.cross ? this.cross.t - (this.net.now() - this.ball.t0) / 1000 : null, dive: this.diveAmt, lastStyle: this.lastStyle, tier: this.crossTier, cross: this.cross,
      remotes: [...this.players.values()].filter((p) => p.avatar).map((p) => ({ id: p.info.id, arm: p.arm, charge: p.charge, delivery: p.avatar!.deliveryTime, windup: p.avatar!.windupId, hand: [p.avatar!.handBall.x, p.avatar!.handBall.y, p.avatar!.handBall.z] })),
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
