import { describe, expect, it } from 'vitest';
import { CATCH_BOBBLE, CATCH_GRACE_MS, DIST_MAX, MITT_MIN, MITT_START, SPEED_MAX, SPEED_STEP, WILD_MAX, EYE_HEIGHT, LEAP_HEIGHT, MAX_PLAYERS, RECOVER_DELAY_MS, THROW_SPEED_LIMIT } from '../../src/shared/constants';
import { positionAt, simulateFlight, solveArc, solveElevation, solveThrowTo, throwElevation, velocityAt } from '../../src/shared/physics';
import { type Pose, bodyToWorld, clampReach, eyePosition, gloveReady, gloveWorld, interceptPlan, lookAngles, maxSteps, reachNorm, ringSpread, seatLayout } from '../../src/shared/pose';
import { Arm, DEFAULT_TRAITS, type ServerMsg, TRAIT_KEYS, type Traits, catchGrade, catchStyle, classifyCatch, gloveSize, groupKeyFor, isGreatCatch, speedFactor, toTraits, traitBits, wildOffset } from '../../src/shared/protocol';
import { type Vec3, dist, len } from '../../src/shared/vec';
import { DEFAULT_WINDUP, HOUSE_WINDUP, RELEASE_TIME, WINDUP_IDS, getWindup, releasePointFor } from '../../src/shared/windups';
import { type Conn, MemoryRecords, Room } from '../../src/server/room';

/** Where a right-hander with the house delivery lets go of the ball. */
const releasePoint = (feet: Vec3, yaw: number, hand: 'R' | 'L') => releasePointFor(HOUSE_WINDUP, feet, yaw, hand);

class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  closed = false;
  send(m: ServerMsg) { this.msgs.push(JSON.parse(JSON.stringify(m))); }
  close() { this.closed = true; }
  last<T extends ServerMsg['t']>(t: T) { return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined; }
  events() { return this.msgs.filter((m) => m.t === 'ball' && m.ev).map((m) => (m as Extract<ServerMsg, { t: 'ball' }>).ev!); }
}

function setup(n: number, practiceBot = false) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const room = new Room('ABCD', clock.now, new MemoryRecords(), { practiceBot });
  const conns: FakeConn[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = new FakeConn();
    const m = room.join(c, { t: 'hello', room: 'ABCD', guest: `g${i}`, name: `P${i}`, hand: 'R', v: 1, w: HOUSE_WINDUP });
    conns.push(c);
    ids.push(m!.id);
  }
  return { room, conns, ids, clock };
}

type Wire = [number, number, number, number, number, number];
const wire = (p: Pose): Wire => [p.x, p.z, p.yaw, p.g[0], p.g[1], p.g[2]];

/** Stream a pose for a member (as the client does at 20 Hz). */
function stream(room: Room, id: string, p: Pose) {
  room.handle(id, { t: 'st', p: [p.x, p.z, p.yaw, p.g[0], p.g[1], p.g[2], 0, 0, 0, 0, 0.5] });
}

/**
 * Throw from `from` straight at `to`'s glove. The receiver stands at their
 * spot (or `at`, if they moved), facing the thrower, glove in the ready spot.
 */
function throwAt(room: Room, fromId: string, toId: string, t: number, pace = 15, offset: Vec3 = [0, 0, 0], at?: Vec3) {
  const from = room.members.get(fromId)!;
  const to = room.members.get(toId)!;
  const feet: Vec3 = at ?? to.pos;
  const yawTo = lookAngles(feet, from.pos).yaw;
  const pose: Pose = { x: feet[0], z: feet[2], yaw: yawTo, g: gloveReady(yawTo, to.hand) };
  const glove = gloveWorld(pose);
  const target: Vec3 = [glove[0] + offset[0], glove[1] + offset[1], glove[2] + offset[2]];
  const yaw = lookAngles(from.pos, target).yaw;
  const p = releasePoint(from.pos, yaw, 'R');
  // Across the road: a throw at a set pace. A long way off: as hard as the distance takes.
  const long = dist(p, target) > 40 ? solveArc(p, target, throwElevation(dist(p, target))) : null;
  const T = long ? long.T : dist(p, target) / pace;
  const v = long ? long.v0 : solveThrowTo(p, target, T);
  room.handle(fromId, { t: 'throw', rt: t, p, v, tid: room.ball.tid + 1 });
  return { pose, T, glove };
}

describe('physics', () => {
  it('follows a visible arc and lands', () => {
    const tr = simulateFlight([0, 1.7, 0], [0, 6, -14]);
    let apex = 0;
    for (let t = 0; t < tr.groundT; t += 0.05) apex = Math.max(apex, positionAt(tr, t)[1]);
    expect(apex).toBeGreaterThan(2.9);
    expect(tr.groundT).toBeGreaterThan(1);
    expect(tr.impacts.length).toBeGreaterThan(0);
    expect(tr.restT).toBeGreaterThan(tr.groundT);
  });
  it('drag slows a hard throw', () => {
    const tr = simulateFlight([0, 1.7, 0], [0, 2, -30]);
    expect(len(velocityAt(tr, 0.5))).toBeLessThan(28.5);
  });
  it('is deterministic', () => {
    const a = simulateFlight([1, 1.7, 2], [3, 5, -12]);
    const b = simulateFlight([1, 1.7, 2], [3, 5, -12]);
    expect(Array.from(a.samples.slice(0, a.count * 3))).toEqual(Array.from(b.samples.slice(0, b.count * 3)));
  });
  it('solves throws to a target', () => {
    const p: Vec3 = [0, 1.7, 7];
    const target: Vec3 = [0.3, 1.3, -7];
    const v = solveThrowTo(p, target, 0.9);
    const tr = simulateFlight(p, v);
    expect(dist(positionAt(tr, 0.9), target)).toBeLessThan(0.02);
    const el = solveElevation(16, 14, 1.7, 1.3)!;
    expect(el).toBeGreaterThan(0);
    expect(solveElevation(6, 40, 1.7, 1.3)).toBeNull();
  });
  it('classifies catches by distance', () => {
    expect(classifyCatch(0.02, 20)).toBe('perfect');
    expect(classifyCatch(0.07, 20)).toBe('pocket');
    expect(classifyCatch(0.13, 20)).toBe('web');
    expect(classifyCatch(0.19, 10)).toBe('bobble');
    expect(classifyCatch(0.19, 38)).toBe('deflect');
    expect(classifyCatch(0.4, 10)).toBeNull();
  });
  it('grades catches from dead centre (1) to the edge of the glove (0)', () => {
    expect(catchGrade(0)).toBe(1);
    expect(catchGrade(0.1)).toBeGreaterThan(catchGrade(0.15));
    expect(catchGrade(0.3)).toBe(0);
  });
  it('lays out players around a ring facing the centre', () => {
    for (let n = 1; n <= 5; n++) {
      const seats = seatLayout(n);
      for (const s of seats) {
        const l = lookAngles(eyePosition(s.pos), [0, EYE_HEIGHT, 0]);
        expect(Math.abs(Math.atan2(Math.sin(l.yaw - s.yaw), Math.cos(l.yaw - s.yaw)))).toBeLessThan(1e-6);
      }
    }
    const two = seatLayout(2);
    expect(dist(two[0].pos, two[1].pos)).toBeGreaterThan(10);
  });
  it('the reach envelope: a crouch, a stretch, a step to the side — not further', () => {
    expect(reachNorm([0, 1.2, 0.4])).toBeLessThan(0.5);
    expect(reachNorm([0, 0.2, 0.3])).toBeLessThan(1);
    expect(reachNorm([0, 2.25, 0.2])).toBeLessThan(1);
    expect(reachNorm([0.95, 1.2, 0])).toBeLessThan(1);
    expect(reachNorm([1.6, 1.2, 0])).toBeGreaterThan(1);
    expect(reachNorm([0, 2.6, 0])).toBeGreaterThan(1);
    const c = clampReach([3, 1.2, 0]);
    expect(reachNorm(c)).toBeCloseTo(1, 6);
    const r = bodyToWorld(0, [1, 0, 0]);
    expect(r[0]).toBeCloseTo(1); expect(r[2]).toBeCloseTo(0);
  });
  it('plans the best moment to intercept a throw', () => {
    const p: Vec3 = [0, 1.7, 6];
    const target: Vec3 = [0.5, 1.3, -6];
    const tr = simulateFlight(p, solveThrowTo(p, target, 1.0));
    const ip = interceptPlan(tr, 0, 0, -6);
    expect(ip.norm).toBeLessThan(0.7);
    expect(Math.abs(ip.t - 1.0)).toBeLessThan(0.1);
    // Standing far off to the side, the ball is out of reach.
    expect(interceptPlan(tr, 0, 3, -6).norm).toBeGreaterThan(1);
  });
});

describe('room', () => {
  it('lets two and five players join; a sixth is refused', () => {
    const { room, conns } = setup(MAX_PLAYERS);
    expect(room.humans().length).toBe(5);
    expect(conns[0].last('roster')!.players.length).toBe(5);
    const extra = new FakeConn();
    expect(room.join(extra, { t: 'hello', room: 'ABCD', guest: 'g9', name: 'X', hand: 'R', v: 1 })).toBeNull();
    expect(extra.last('full')).toBeTruthy();
    expect(room.humans().length).toBe(5);
  });

  it('gives the ball to exactly one player', () => {
    const { room, ids, conns } = setup(3);
    expect(room.ball.phase).toBe('held');
    expect(ids).toContain(room.ball.holder);
    for (const c of conns) {
      const w = c.last('welcome')!;
      expect(w.ball.holder).toBe(ids[0]);
    }
  });

  it('a catch increments the streak exactly once; duplicates are ignored', () => {
    const { room, ids, conns, clock } = setup(2);
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0);
    expect(room.ball.phase).toBe('flight');
    const tid = room.ball.tid;
    clock.advance(T * 1000 + 30);
    const claim = { t: 'catch' as const, tid, at: t0 + T * 1000, pose: wire(pose) };
    room.handle(ids[1], claim);
    room.handle(ids[1], claim);
    room.handle(ids[0], claim);
    expect(room.streak).toBe(1);
    expect(room.ball.holder).toBe(ids[1]);
    expect(room.members.get(ids[1])!.catches).toBe(1);
    const catches = conns[0].events().filter((e) => e.k === 'catch');
    expect(catches.length).toBe(1);
    expect(catches[0].k === 'catch' && catches[0].q).toBe('perfect');
    expect(catches[0].k === 'catch' && catches[0].g).toBeGreaterThan(0.9);
    // Both clients agree on the streak.
    expect(conns[0].last('ball')!.score.streak).toBe(1);
    expect(conns[1].last('ball')!.score.streak).toBe(1);
  });

  it('any player can throw to any other player', () => {
    const { room, ids, clock } = setup(4);
    let holder = ids[0];
    for (const to of [ids[2], ids[1], ids[3], ids[0]]) {
      const t0 = clock.now();
      const { pose, T } = throwAt(room, holder, to, t0);
      clock.advance(T * 1000 + 20);
      room.handle(to, { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
      expect(room.ball.holder).toBe(to);
      holder = to;
      clock.advance(500);
    }
    expect(room.streak).toBe(4);
  });

  it('rejects a catch where the glove was not on the ball', () => {
    const { room, ids, clock } = setup(2);
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0, 15, [0.6, 0, 0]);
    clock.advance(T * 1000 + 20);
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
    expect(room.ball.phase).toBe('flight');
    expect(room.streak).toBe(0);
  });

  it('a player who moved to get under a throw can catch it there', () => {
    const { room, ids, clock } = setup(2);
    const to = room.members.get(ids[1])!;
    const at: Vec3 = [to.pos[0] + 2.4, 0, to.pos[2] + 0.5];
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0, 14, [0, 0, 0], at);
    stream(room, ids[1], pose);
    clock.advance(T * 1000 + 20);
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
    expect(room.ball.holder).toBe(ids[1]);
    expect(room.streak).toBe(1);
  });

  it('rejects a glove beyond reach, a body teleported far from its spot, or one far from its streamed position', () => {
    const { room, ids, clock } = setup(2);
    const to = room.members.get(ids[1])!;
    // Glove out of the reach envelope (arm two metres long).
    let t0 = clock.now();
    let r = throwAt(room, ids[0], ids[1], t0);
    const far: Pose = { ...r.pose, g: [r.pose.g[0] * 4, r.pose.g[1], r.pose.g[2] * 4] };
    clock.advance(r.T * 1000);
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + r.T * 1000, pose: wire(far) });
    expect(room.streak).toBe(0);
    for (let i = 0; i < 200 && room.ball.phase !== 'held'; i++) { clock.advance(50); room.tick(); }
    // Body 7 m from home.
    const holder = room.ball.holder!;
    const recv = holder === ids[0] ? ids[1] : ids[0];
    const rm = room.members.get(recv)!;
    t0 = clock.now();
    r = throwAt(room, holder, recv, t0, 14, [0, 0, 0], [rm.pos[0] + 7, 0, rm.pos[2]]);
    clock.advance(r.T * 1000);
    room.handle(recv, { t: 'catch', tid: room.ball.tid, at: t0 + r.T * 1000, pose: wire(r.pose) });
    expect(room.streak).toBe(0);
    // Claimed 3 m from where the player was just streaming.
    for (let i = 0; i < 200 && room.ball.phase !== 'held'; i++) { clock.advance(50); room.tick(); }
    const h2 = room.ball.holder!;
    const r2 = h2 === ids[0] ? ids[1] : ids[0];
    const rm2 = room.members.get(r2)!;
    t0 = clock.now();
    r = throwAt(room, h2, r2, t0, 14, [0, 0, 0], [rm2.pos[0] + 3, 0, rm2.pos[2]]);
    clock.advance(r.T * 1000);
    stream(room, r2, { x: rm2.pos[0], z: rm2.pos[2], yaw: rm2.facing, g: gloveReady(rm2.facing, 'R') });
    room.handle(r2, { t: 'catch', tid: room.ball.tid, at: t0 + r.T * 1000, pose: wire(r.pose) });
    expect(room.streak).toBe(0);
    void to;
  });

  it('keeps streamed bodies near their spot', () => {
    const { room, ids } = setup(2);
    const m = room.members.get(ids[1])!;
    stream(room, ids[1], { x: m.pos[0] + 20, z: m.pos[2], yaw: 0, g: [0, 1.2, -0.4] });
    expect(Math.hypot(m.pose.x - m.pos[0], m.pose.z - m.pos[2])).toBeLessThanOrEqual(4.5 + 1e-9);
  });

  it('a miss resets the streak exactly once and the ball is recovered', () => {
    const { room, ids, conns, clock } = setup(2);
    // Build a streak of 2.
    let holder = ids[0], other = ids[1];
    for (let i = 0; i < 2; i++) {
      const t0 = clock.now();
      const { pose, T } = throwAt(room, holder, other, t0);
      clock.advance(T * 1000);
      room.handle(other, { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
      [holder, other] = [other, holder];
    }
    expect(room.streak).toBe(2);
    throwAt(room, holder, other, clock.now());
    const traj = room.traj!;
    // Nobody claims a catch: advance to ground + grace.
    for (let i = 0; i < 200 && room.ball.phase === 'flight'; i++) { clock.advance(50); room.tick(); }
    expect(room.ball.phase).toBe('loose');
    expect(room.streak).toBe(0);
    expect(room.members.get(other)!.drops).toBe(1);
    const drops = conns[0].events().filter((e) => e.k === 'drop');
    expect(drops.length).toBe(1);
    expect(room.sessionBest).toBe(2);
    // Ball comes to rest and is recovered by someone.
    clock.advance(traj.restT * 1000 + RECOVER_DELAY_MS + 100);
    room.tick();
    expect(room.ball.phase).toBe('held');
    expect(ids).toContain(room.ball.holder);
    expect(conns[1].events().filter((e) => e.k === 'drop').length).toBe(1);
  });

  it('a late catch claim after the drop is resolved does nothing', () => {
    const { room, ids, clock } = setup(2);
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0);
    const tid = room.ball.tid;
    const groundT = room.traj!.groundT;
    clock.advance(groundT * 1000 + CATCH_GRACE_MS + 60);
    room.tick();
    expect(room.ball.live).toBe(false);
    room.handle(ids[1], { t: 'catch', tid, at: t0 + T * 1000, pose: wire(pose) });
    expect(room.streak).toBe(0);
  });

  it('only the holder can throw, and a throw cannot be replayed', () => {
    const { room, ids, clock } = setup(2);
    const p = releasePoint(room.members.get(ids[1])!.pos, 0, 'R');
    room.handle(ids[1], { t: 'throw', rt: clock.now(), p, v: [0, 3, -10], tid: 1 });
    expect(room.ball.phase).toBe('held');
    const msg = throwAt(room, ids[0], ids[1], clock.now());
    expect(room.ball.tid).toBe(1);
    room.handle(ids[0], { t: 'throw', rt: clock.now(), p, v: [0, 3, -10], tid: 1 });
    expect(room.ball.tid).toBe(1);
    void msg;
  });

  it('a reconnecting player receives the current state and keeps their identity', () => {
    const { room, ids, conns, clock } = setup(2);
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0);
    clock.advance(T * 1000);
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
    room.disconnect(ids[1], conns[1]);
    expect(conns[0].last('roster')!.players.find((p) => p.id === ids[1])!.connected).toBe(false);
    const again = new FakeConn();
    const m = room.join(again, { t: 'hello', room: 'ABCD', guest: 'g1', name: 'P1', hand: 'R', v: 1, w: HOUSE_WINDUP });
    expect(m!.id).toBe(ids[1]);
    const w = again.last('welcome')!;
    expect(w.ball.holder).toBe(ids[1]);
    expect(w.score.streak).toBe(1);
    expect(room.humans().length).toBe(2);
  });

  it('a disconnect during a throw does not wipe the streak', () => {
    const { room, ids, conns, clock } = setup(2);
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0);
    clock.advance(T * 1000);
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
    expect(room.streak).toBe(1);
    throwAt(room, ids[1], ids[0], clock.now());
    room.disconnect(ids[0], conns[0]);
    for (let i = 0; i < 200 && room.ball.phase === 'flight'; i++) { clock.advance(50); room.tick(); }
    expect(room.streak).toBe(1);
    const drop = conns[1].events().find((e) => e.k === 'drop');
    expect(drop && drop.k === 'drop' && drop.void).toBe(true);
  });

  it('a disconnected player does not corrupt the room and is removed after the grace period', () => {
    const { room, ids, conns, clock } = setup(3);
    room.disconnect(ids[0], conns[0]); // the holder
    clock.advance(100_000);
    room.tick();
    expect(room.members.has(ids[0])).toBe(false);
    expect([ids[1], ids[2]]).toContain(room.ball.holder);
    expect(room.humans().length).toBe(2);
  });

  it('a disconnected holder hands the ball on so the game does not stall', () => {
    const { room, ids, conns, clock } = setup(2);
    expect(room.ball.holder).toBe(ids[0]);
    room.disconnect(ids[0], conns[0]);
    clock.advance(3000); room.tick();
    expect(room.ball.holder).toBe(ids[0]);
    clock.advance(4000); room.tick();
    expect(room.ball.holder).toBe(ids[1]);
    expect(room.members.has(ids[0])).toBe(true);
  });

  it('self-catches neither score nor reset', () => {
    const { room, ids, clock } = setup(2);
    const me = room.members.get(ids[0])!;
    const pose: Pose = { x: me.pos[0], z: me.pos[2], yaw: me.facing, g: [0, 2.1, 0] };
    const glove = gloveWorld(pose);
    const p = releasePoint(me.pos, me.facing, 'R');
    const t0 = clock.now();
    const v = solveThrowTo(p, glove, 1.2);
    room.handle(ids[0], { t: 'throw', rt: t0, p, v, tid: 1 });
    clock.advance(1200);
    room.handle(ids[0], { t: 'catch', tid: 1, at: t0 + 1200, pose: wire(pose) });
    expect(room.ball.holder).toBe(ids[0]);
    expect(room.streak).toBe(0);
  });

  it('group records follow the set of people', () => {
    expect(groupKeyFor(['a', 'b'])).toBe(groupKeyFor(['b', 'a']));
    expect(groupKeyFor(['a', 'b'])).not.toBe(groupKeyFor(['a', 'c']));
    const { room, ids, conns } = setup(2);
    room.handle(ids[0], { t: 'rec', key: room.groupKey(), best: 42 });
    expect(conns[1].last('roster')!.score.groupBest).toBe(42);
    room.handle(ids[0], { t: 'rec', key: 'nope', best: 99 });
    expect(room.score().groupBest).toBe(42);
  });

  it('Coach keeps a lone player company and leaves when a friend joins', () => {
    const { room, ids, clock } = setup(1, true);
    expect(room.members.has('coach')).toBe(true);
    const c = new FakeConn();
    room.join(c, { t: 'hello', room: 'ABCD', guest: 'friend', name: 'F', hand: 'L', v: 1 });
    expect(room.members.has('coach')).toBe(false);
    expect(room.ball.holder).toBe(ids[0]);
    void clock;
  });

  it('Coach catches a good throw and throws back', () => {
    const { room, ids, clock } = setup(1, true);
    const t0 = clock.now();
    throwAt(room, ids[0], 'coach', t0);
    for (let i = 0; i < 80 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
    expect(room.ball.holder).toBe('coach');
    expect(room.streak).toBe(1);
    for (let i = 0; i < 120 && room.ball.phase === 'held'; i++) { clock.advance(33); room.tick(); }
    expect(room.ball.phase).toBe('flight');
    expect(room.ball.thrower).toBe('coach');
    // Coach's throw arrives near the player.
    const me = room.members.get(ids[0])!;
    const traj = room.traj!;
    let best = Infinity;
    for (let t = 0; t < traj.groundT; t += 0.01) best = Math.min(best, dist(positionAt(traj, t), [me.pos[0], EYE_HEIGHT - 0.3, me.pos[2]]));
    expect(best).toBeLessThan(0.75);
  });

  it('Coach runs to get under a wide throw', () => {
    const { room, ids, clock } = setup(1, true);
    const coach = room.members.get('coach')!;
    const t0 = clock.now();
    // 2.3 m to Coach's side: out of reach from the spot, catchable on the move.
    throwAt(room, ids[0], 'coach', t0, 11, [2.3 * Math.cos(coach.facing), 0, -2.3 * Math.sin(coach.facing)]);
    let moved = 0;
    for (let i = 0; i < 90 && room.ball.phase === 'flight'; i++) {
      clock.advance(33); room.tick();
      moved = Math.max(moved, Math.hypot(coach.pose.x - coach.pos[0], coach.pose.z - coach.pos[2]));
    }
    expect(moved).toBeGreaterThan(1);
    expect(room.ball.holder).toBe('coach');
  });

  it("Coach holds its glove as your target, and its POP grades your throw", () => {
    const run = (off: number) => {
      const { room, ids, conns, clock } = setup(1, true);
      for (let i = 0; i < 10; i++) { clock.advance(33); room.tick(); }
      const coach = room.members.get('coach')!;
      const glove = gloveWorld(coach.pose);
      const me = room.members.get(ids[0])!;
      const yaw = lookAngles(me.pos, glove).yaw;
      const p = releasePoint(me.pos, yaw, 'R');
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const target: Vec3 = [glove[0] + rx * off, glove[1], glove[2] + rz * off];
      const t0 = clock.now();
      room.handle(ids[0], { t: 'throw', rt: t0, p, v: solveThrowTo(p, target, dist(p, target) / 14), tid: 1 });
      for (let i = 0; i < 80 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
      const ev = conns[0].events().find((e) => e.k === 'catch');
      return ev && ev.k === 'catch' ? ev : null;
    };
    const dead = run(0);
    expect(dead?.by).toBe('coach');
    expect(dead?.q).toBe('perfect');
    expect(dead!.g).toBeGreaterThan(0.8);
    const off = run(0.3);
    expect(off?.by).toBe('coach');
    expect(off!.g).toBeLessThan(0.55);
  });

  it('Coach aims at your glove (wherever you hold it)', () => {
    const { room, ids, clock } = setup(1, true);
    const me = room.members.get(ids[0])!;
    const high: Pose = { x: me.pos[0], z: me.pos[2], yaw: me.facing, g: bodyToWorld(me.facing, [0.3, 1.9, 0.35]) };
    // Give Coach the ball: throw it over, Coach catches.
    throwAt(room, ids[0], 'coach', clock.now());
    for (let i = 0; i < 80 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
    expect(room.ball.holder).toBe('coach');
    for (let i = 0; i < 150 && room.ball.phase === 'held'; i++) { stream(room, ids[0], high); clock.advance(33); room.tick(); }
    expect(room.ball.thrower).toBe('coach');
    const g = gloveWorld(high);
    let best = Infinity;
    for (let t = 0; t < room.traj!.groundT; t += 0.005) best = Math.min(best, dist(positionAt(room.traj!, t), g));
    expect(best).toBeLessThan(0.15);
  });

  // ---------------------------------------------------------------- windups

  it('players carry their windup; everyone is told, and a change is broadcast', () => {
    const { room, conns, ids } = setup(1);
    const c = new FakeConn();
    const b = room.join(c, { t: 'hello', room: 'ABCD', guest: 'b', name: 'B', hand: 'L', v: 1, w: 51 })!;
    const seen = conns[0].last('roster')!.players;
    expect(seen.find((p) => p.id === b.id)!.windup).toBe(51);
    expect(seen.find((p) => p.id === ids[0])!.windup).toBe(HOUSE_WINDUP);
    room.handle(ids[0], { t: 'prof', name: 'P0', hand: 'R', w: 16 });
    expect(c.last('roster')!.players.find((p) => p.id === ids[0])!.windup).toBe(16);
    // A name change alone keeps the windup; nonsense is ignored.
    room.handle(ids[0], { t: 'prof', name: 'P0', hand: 'R' });
    room.handle(ids[0], { t: 'prof', name: 'P0', hand: 'R', w: 12345 });
    expect(room.members.get(ids[0])!.windup).toBe(16);
  });

  it('an unknown or missing windup becomes the default', () => {
    const { room } = setup(0);
    const a = room.join(new FakeConn(), { t: 'hello', room: 'ABCD', guest: 'a', name: 'A', hand: 'R', v: 1, w: 7 })!;
    const b = room.join(new FakeConn(), { t: 'hello', room: 'ABCD', guest: 'b', name: 'B', hand: 'R', v: 1 })!;
    expect(a.windup).toBe(DEFAULT_WINDUP);
    expect(b.windup).toBe(DEFAULT_WINDUP);
  });

  it('a throw is accepted from the release point of every windup', () => {
    for (const id of WINDUP_IDS) {
      const { room, ids, clock } = setup(2);
      const from = room.members.get(ids[0])!, to = room.members.get(ids[1])!;
      const yaw = lookAngles(from.pos, to.pos).yaw;
      const p = releasePointFor(id, from.pos, yaw, 'R');
      const target: Vec3 = [to.pos[0], 1.2, to.pos[2]];
      room.handle(ids[0], { t: 'throw', rt: clock.now(), p, v: solveThrowTo(p, target, 0.9), tid: 1 });
      expect(room.ball.phase, `#${id}`).toBe('flight');
    }
  });

  it('Coach has a windup from the library, winds all the way up, and the ball leaves a beat after the arm starts', () => {
    const { room, ids, clock } = setup(1, true);
    const coach = room.members.get('coach')!;
    expect(WINDUP_IDS).toContain(coach.windup);
    expect(coach.windup).not.toBe(HOUSE_WINDUP);
    throwAt(room, ids[0], 'coach', clock.now());
    for (let i = 0; i < 80 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
    expect(room.ball.holder).toBe('coach');
    let top = 0, armAt = 0, thrownAt = 0;
    for (let i = 0; i < 2000 && !thrownAt; i++) {
      clock.advance(5); room.tick();
      if (coach.arm === Arm.Windup) top = Math.max(top, coach.charge);
      if (coach.arm === Arm.Release && !armAt) armAt = clock.now();
      if (room.ball.phase === 'flight') thrownAt = clock.now();
    }
    expect(top).toBe(1);
    expect(armAt).toBeGreaterThan(0);
    expect(thrownAt - armAt).toBeGreaterThanOrEqual(RELEASE_TIME * 1000);
    expect(thrownAt - armAt).toBeLessThan(RELEASE_TIME * 1000 + 40);
    // ...from where that windup's arm slot puts the hand.
    const want = releasePointFor(coach.windup, [coach.pose.x, 0, coach.pose.z], lookAngles([coach.pose.x, 0, coach.pose.z], room.ball.p0).yaw, coach.hand);
    expect(Math.abs(room.ball.p0[1] - want[1])).toBeLessThan(0.02);
    expect(getWindup(coach.windup).release[1]).toBeCloseTo(room.ball.p0[1], 6);
  });

  // ---------------------------------------------------------------- great catches

  it('names a catch from what the receiver had to do', () => {
    expect(catchStyle([-0.2, 1.2, 0.5], 'R', 0, 0, 0)).toBe(null);
    expect(catchStyle([-0.2, 2.1, 0.4], 'R', 0, 0, 0)).toBe('high');
    expect(catchStyle([-0.2, 0.4, 0.6], 'R', 0, 0, 0)).toBe('scoop');
    expect(catchStyle([0.5, 1.2, 0.5], 'R', 0, 0, 0)).toBe('backhand');
    expect(catchStyle([-0.5, 1.2, 0.5], 'L', 0, 0, 0)).toBe('backhand');
    expect(catchStyle([-0.75, 1.2, 0.5], 'R', 0, 0, 0)).toBe('reach');
    expect(catchStyle([-0.2, 1.2, 0.5], 'R', 0, 0, 3.5)).toBe('run');
    expect(catchStyle([-0.2, 2.3, 0.4], 'R', 0.35, 0, 0)).toBe('leap');
    expect(catchStyle([-0.7, 0.8, 0.5], 'R', 0, -0.9, 4)).toBe('dive');
    expect(isGreatCatch('dive') && isGreatCatch('leap') && isGreatCatch('run')).toBe(true);
    expect(isGreatCatch('high') || isGreatCatch('scoop') || isGreatCatch(null)).toBe(false);
  });

  it('a throw over your head can only be caught by getting off the ground', () => {
    const run = (lift: number) => {
      const { room, ids, conns, clock } = setup(2);
      const to = room.members.get(ids[1])!;
      const from = room.members.get(ids[0])!;
      const yawTo = lookAngles(to.pos, from.pos).yaw;
      // 2.7 m up: over the top of a standing reach, inside a leap's.
      const g = bodyToWorld(yawTo, [0, 2.7, 0.3]);
      const pose: Pose = { x: to.pos[0], z: to.pos[2], yaw: yawTo, g };
      expect(reachNorm(g)).toBeGreaterThan(1.06);
      expect(reachNorm(g, LEAP_HEIGHT)).toBeLessThan(1);
      const target = gloveWorld(pose);
      const p = releasePoint(from.pos, lookAngles(from.pos, target).yaw, 'R');
      const t0 = clock.now();
      const T = 0.9;
      room.handle(ids[0], { t: 'throw', rt: t0, p, v: solveThrowTo(p, target, T), tid: 1 });
      clock.advance(T * 1000);
      room.handle(ids[1], { t: 'catch', tid: 1, at: t0 + T * 1000, pose: [...wire(pose), lift, 0] });
      const ev = conns[0].events().find((e) => e.k === 'catch');
      return { held: room.ball.holder === ids[1], ev: ev && ev.k === 'catch' ? ev : null, saves: room.members.get(ids[1])!.saves };
    };
    expect(run(0).held).toBe(false);
    const up = run(LEAP_HEIGHT - 0.05);
    expect(up.held).toBe(true);
    expect(up.ev!.st).toBe('leap');
    expect(up.saves).toBe(1);
    // You can't claim more air than a leap has.
    expect(run(5).held).toBe(true);
    const far = (() => {
      const { room, ids, clock } = setup(2);
      const to = room.members.get(ids[1])!, from = room.members.get(ids[0])!;
      const yawTo = lookAngles(to.pos, from.pos).yaw;
      const pose: Pose = { x: to.pos[0], z: to.pos[2], yaw: yawTo, g: bodyToWorld(yawTo, [0, 3.15, 0.3]) };
      const target = gloveWorld(pose);
      const p = releasePoint(from.pos, lookAngles(from.pos, target).yaw, 'R');
      const t0 = clock.now();
      room.handle(ids[0], { t: 'throw', rt: t0, p, v: solveThrowTo(p, target, 0.9), tid: 1 });
      clock.advance(900);
      room.handle(ids[1], { t: 'catch', tid: 1, at: t0 + 900, pose: [...wire(pose), 5, 0] });
      return room.ball.holder === ids[1];
    })();
    expect(far).toBe(false);
  });

  it('a diving catch is a catch like any other, and it is counted as a great one for everyone to see', () => {
    const { room, ids, conns, clock } = setup(2);
    const t0 = clock.now();
    const to = room.members.get(ids[1])!;
    const side: Vec3 = [1.6 * Math.cos(to.facing), 0, -1.6 * Math.sin(to.facing)];
    // The receiver ends up 1.6 m to the side, laid out.
    const at: Vec3 = [to.pos[0] + side[0], 0, to.pos[2] + side[2]];
    const { pose, T } = throwAt(room, ids[0], ids[1], t0, 14, [0, 0, 0], at);
    for (let k = 1; k <= 8; k++) {
      clock.advance((T * 1000) / 8);
      stream(room, ids[1], { ...pose, x: to.pos[0] + (side[0] * k) / 8, z: to.pos[2] + (side[2] * k) / 8 });
    }
    room.handle(ids[1], { t: 'catch', tid: 1, at: t0 + T * 1000, pose: [...wire(pose), 0, 0.9] });
    const ev = conns[0].events().find((e) => e.k === 'catch');
    expect(ev && ev.k === 'catch' && ev.st).toBe('dive');
    expect(room.streak).toBe(1);
    expect(room.members.get(ids[1])!.saves).toBe(1);
    expect(conns[0].last('ball')!.players!.find((p) => p.id === ids[1])!.saves).toBe(1);
  });

  it('a routine catch is not a great one, and a catch made on the run is', () => {
    const { room, ids, conns, clock } = setup(2);
    const t0 = clock.now();
    const { pose, T } = throwAt(room, ids[0], ids[1], t0);
    clock.advance(T * 1000);
    room.handle(ids[1], { t: 'catch', tid: 1, at: t0 + T * 1000, pose: wire(pose) });
    const ev = conns[0].events().find((e) => e.k === 'catch');
    expect(ev && ev.k === 'catch' && ev.st).toBeUndefined();
    expect(room.members.get(ids[1])!.saves).toBe(0);
    // Now the other way, with the receiver running under it (the server sees the feet move).
    const t1 = clock.now();
    const back = room.members.get(ids[0])!;
    const side: Vec3 = [3.6 * Math.cos(back.facing), 0, -3.6 * Math.sin(back.facing)];
    const at: Vec3 = [back.pos[0] + side[0], 0, back.pos[2] + side[2]];
    const r = throwAt(room, ids[1], ids[0], t1, 12, [0, 0, 0], at);
    for (let k = 1; k <= 20; k++) {
      clock.advance((r.T * 1000) / 20);
      stream(room, ids[0], { ...r.pose, x: back.pos[0] + (side[0] * k) / 20, z: back.pos[2] + (side[2] * k) / 20 });
    }
    room.handle(ids[0], { t: 'catch', tid: 2, at: t1 + r.T * 1000, pose: wire(r.pose) });
    const ev2 = conns[1].events().filter((e) => e.k === 'catch')[1];
    expect(ev2 && ev2.k === 'catch' && ev2.st).toBe('run');
    expect(room.members.get(ids[0])!.saves).toBe(1);
  });

  it('streams a leap and a dive to everyone, clamped to what a body can do', () => {
    const { room, ids, conns } = setup(2);
    const m = room.members.get(ids[0])!;
    room.handle(ids[0], { t: 'st', p: [m.pos[0], m.pos[2], m.facing, 0, 9, 0, 0, 0, 9, -9, 0.5] });
    room.snapshot();
    const e = conns[1].last('snap')!.e.find((x) => x[0] === ids[0])!;
    expect(e[9]).toBeLessThanOrEqual(LEAP_HEIGHT + 0.05);
    expect(e[10]).toBe(-1);
    // The glove is pulled back inside the (lifted) reach.
    expect(reachNorm([e[4], e[5], e[6]], e[9])).toBeLessThanOrEqual(1.03);
  });

  it('"here it comes": the holder starting a delivery is relayed at once, so everyone animates in step', () => {
    const { room, ids, conns, clock } = setup(2);
    room.handle(ids[1], { t: 'go' });
    expect(conns[0].last('go')).toBeUndefined();
    clock.advance(40);
    room.handle(ids[0], { t: 'go' });
    expect(conns[1].last('go')).toEqual({ t: 'go', by: ids[0], at: clock.now() });
    // The thrower already knows.
    expect(conns[0].last('go')).toBeUndefined();
  });

  it('Coach announces its delivery too, exactly a release-time before the ball leaves', () => {
    const { room, ids, conns, clock } = setup(1, true);
    throwAt(room, ids[0], 'coach', clock.now());
    for (let i = 0; i < 80 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
    for (let i = 0; i < 2000 && room.ball.phase === 'held'; i++) { clock.advance(5); room.tick(); }
    const go = conns[0].last('go')!;
    expect(go.by).toBe('coach');
    expect(room.ball.t0 - go.at).toBeGreaterThanOrEqual(RELEASE_TIME * 1000);
    expect(room.ball.t0 - go.at).toBeLessThan(RELEASE_TIME * 1000 + 40);
  });

  // ---------------------------------------------------------------- long-distance catch

  /** One clean exchange: the holder throws to the other player's glove and they catch it. */
  function exchange(room: Room, clock: { now: () => number; advance: (ms: number) => void }, ids: string[]) {
    const from = room.ball.holder!, to = ids.find((x) => x !== from)!;
    const t0 = clock.now();
    const { pose, T } = throwAt(room, from, to, t0);
    clock.advance(T * 1000);
    room.handle(to, { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: wire(pose) });
    expect(room.ball.holder).toBe(to);
  }
  /** The holder throws it away; nobody catches it; it is recovered. */
  function miss(room: Room, clock: { now: () => number; advance: (ms: number) => void }, ids: string[]) {
    const from = room.ball.holder!, to = ids.find((x) => x !== from)!;
    throwAt(room, from, to, clock.now(), 14, [0, 6, 0]);
    for (let i = 0; i < 600 && room.ball.phase !== 'held'; i++) { clock.advance(33); room.tick(); }
    expect(room.ball.phase).toBe('held');
  }
  const apart = (room: Room, ids: string[]) => dist(room.members.get(ids[0])!.pos, room.members.get(ids[1])!.pos);

  it('every catch takes both players a step further apart', () => {
    const { room, ids, clock, conns } = setup(2);
    expect(apart(room, ids)).toBeCloseTo(14, 6);
    expect(room.score().dist).toBe(14);
    for (let i = 1; i <= 5; i++) {
      exchange(room, clock, ids);
      expect(apart(room, ids)).toBeCloseTo(14 + i, 6);
    }
    // Everyone is told the distance and where their spot now is, with the catch.
    const last = conns[0].last('ball')!;
    expect(last.score.dist).toBe(19);
    expect(dist(last.players![0].pos, last.players![1].pos)).toBeCloseTo(19, 6);
    // They still face each other down the same line.
    const [a, b] = ids.map((id) => room.members.get(id)!);
    expect(lookAngles(a.pos, b.pos).yaw).toBeCloseTo(a.facing, 6);
  });

  it('a miss is a step back in, and a catch after it steps out again (the miss still counts)', () => {
    const { room, ids, clock } = setup(2);
    for (let i = 0; i < 4; i++) exchange(room, clock, ids);
    expect(room.score().dist).toBe(18);
    miss(room, clock, ids);
    expect(room.score().dist).toBe(17);
    expect(room.score().misses).toBe(1);
    expect(apart(room, ids)).toBeCloseTo(17, 6);
    exchange(room, clock, ids);
    expect(room.score().dist).toBe(18);
    expect(room.score().misses).toBe(1);
  });

  it('misses are counted in total: the third starts the distance again, however many catches came between', () => {
    const { room, ids, clock } = setup(2);
    for (let i = 0; i < 10; i++) exchange(room, clock, ids);
    expect(room.score().dist).toBe(24);
    miss(room, clock, ids);
    for (let i = 0; i < 5; i++) exchange(room, clock, ids);
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 27, misses: 2 });
    for (let i = 0; i < 8; i++) exchange(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 35, misses: 2 });
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 14, misses: 0 });
    expect(apart(room, ids)).toBeCloseTo(14, 6);
    // And the count starts again with the distance.
    exchange(room, clock, ids);
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 14, misses: 1 });
  });

  it('a miss at the starting distance does not bring you closer than the start', () => {
    const { room, ids, clock } = setup(2);
    miss(room, clock, ids);
    expect(room.score().dist).toBe(14);
  });

  it('a throw voided by a disconnect costs no distance', () => {
    const { room, ids, conns, clock } = setup(2);
    for (let i = 0; i < 3; i++) exchange(room, clock, ids);
    const from = room.ball.holder!, to = ids.find((x) => x !== from)!;
    throwAt(room, from, to, clock.now(), 14, [0, 6, 0]);
    room.disconnect(to, conns[ids.indexOf(to)]);
    for (let i = 0; i < 300 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
    expect(room.score()).toMatchObject({ dist: 17, misses: 0, streak: 3 });
  });

  it('the distance stops at the longest throw there is, and catches there still count', () => {
    const { room, ids, clock } = setup(2);
    room.steps = maxSteps(2) - 1;
    exchange(room, clock, ids);
    expect(room.score().dist).toBe(DIST_MAX);
    exchange(room, clock, ids);
    expect(room.score().dist).toBe(DIST_MAX);
    expect(room.streak).toBe(2);
    expect(ringSpread(2, 1e6)).toBe(DIST_MAX);
    expect(ringSpread(5, 1e6)).toBeLessThanOrEqual(DIST_MAX);
  });

  it('a ring of five widens together', () => {
    const { room, ids, clock } = setup(5);
    const r0 = Math.hypot(...room.members.get(ids[0])!.pos);
    exchange(room, clock, [ids.find((x) => x === room.ball.holder)!, ids.find((x) => x !== room.ball.holder)!]);
    for (const id of ids) expect(Math.hypot(...room.members.get(id)!.pos) - r0).toBeGreaterThan(0.1);
    expect(room.score().dist).toBeGreaterThan(17);
  });

  it('a throw is as hard as the distance takes: the arc reaches the glove from 14 m to 120 m', () => {
    let last = 0;
    for (const d of [8, 14, 30, 60, 90, DIST_MAX]) {
      const p0: Vec3 = [0.3, 1.8, 0], target: Vec3 = [0.4, 1.2, -d];
      const a = solveArc(p0, target, throwElevation(d));
      const tr = simulateFlight(p0, a.v0);
      expect(dist(positionAt(tr, a.T), target), `${d} m`).toBeLessThan(0.03);
      expect(tr.groundT).toBeGreaterThan(a.T);
      expect(a.speed).toBeGreaterThan(last);
      expect(a.speed).toBeLessThan(THROW_SPEED_LIMIT - 8);
      last = a.speed;
    }
    // A hard, flat pull at the longest distance is still inside what the server accepts.
    expect(solveArc([0, 1.8, 0], [0, 2.7, -DIST_MAX], throwElevation(DIST_MAX) * 0.75).speed).toBeLessThan(THROW_SPEED_LIMIT);
    // Further is steeper and hangs longer.
    expect(throwElevation(100)).toBeGreaterThan(throwElevation(14) * 2);
    expect(solveArc([0, 1.8, 0], [0, 1.2, -100], throwElevation(100)).T).toBeGreaterThan(4);
  });

  it('accepts the longest throw, and Coach makes it', () => {
    const { room, ids, clock } = setup(1, true);
    room.steps = maxSteps(2);
    exchange(room, clock, [ids[0], 'coach']);
    const coach = room.members.get('coach')!, me = room.members.get(ids[0])!;
    expect(dist(coach.pos, me.pos)).toBeCloseTo(DIST_MAX, 6);
    for (let i = 0; i < 4000 && room.ball.phase === 'held'; i++) { clock.advance(10); room.tick(); stream(room, ids[0], { x: me.pos[0], z: me.pos[2], yaw: me.facing, g: gloveReady(me.facing, 'R') }); }
    expect(room.ball.thrower).toBe('coach');
    const tr = room.traj!;
    let best = Infinity;
    for (let t = 0; t < tr.groundT; t += 0.01) best = Math.min(best, dist(positionAt(tr, t), [me.pos[0], 1.2, me.pos[2]]));
    // From 120 m: within a few steps of you.
    expect(best).toBeLessThan(6);
    expect(len(room.ball.v0)).toBeGreaterThan(40);
  });

  it('a ball that comes off Coach\'s glove is one miss, not two', () => {
    const { room, ids, conns, clock } = setup(1, true);
    room.steps = 30;
    exchange(room, clock, [ids[0], 'coach']);
    // Get the ball back to the player and let everyone settle on their spots.
    for (let i = 0; i < 4000 && room.ball.holder !== ids[0]; i++) {
      clock.advance(10); room.tick();
      if (room.ball.phase === 'flight' && room.ball.thrower === 'coach') {
        const me = room.members.get(ids[0])!;
        const tr = room.traj!;
        const g = gloveWorld({ x: me.pos[0], z: me.pos[2], yaw: me.facing, g: gloveReady(me.facing, 'R') });
        let bt = 0, bd = Infinity;
        for (let q = 0; q < tr.groundT; q += 0.004) { const d = dist(positionAt(tr, q), g); if (d < bd) { bd = d; bt = q; } }
        if ((clock.now() - room.ball.t0) / 1000 >= bt) {
          const at = positionAt(tr, bt);
          room.handle(ids[0], { t: 'catch', tid: room.ball.tid, at: room.ball.t0 + bt * 1000, pose: [me.pos[0], me.pos[2], me.facing, at[0] - me.pos[0], at[1], at[2] - me.pos[2]] });
        }
      }
    }
    expect(room.ball.holder).toBe(ids[0]);
    const before = { steps: room.steps, misses: room.misses };
    const n0 = conns[0].events().length;
    const t0 = clock.now();
    const { T } = throwAt(room, ids[0], 'coach', t0);
    // Coach gets a glove on it and it bounces out.
    const brain = (room as unknown as { bot: { update: (...a: unknown[]) => unknown } }).bot;
    const real = brain.update.bind(brain);
    let done = false;
    brain.update = (...a: unknown[]) => {
      real(...a);
      if (!done && clock.now() >= t0 + T * 1000 - 20 && room.ball.phase === 'flight') { done = true; return { kind: 'catch', tid: room.ball.tid, tSec: T, q: 'deflect', g: 0 }; }
      return null;
    };
    for (let i = 0; i < 900 && room.ball.phase !== 'held'; i++) { clock.advance(33); room.tick(); }
    const evs = conns[0].events().slice(n0).map((e) => e.k);
    expect(evs).toContain('deflect');
    expect(evs).not.toContain('drop');
    expect(room.misses).toBe(before.misses + 1);
    expect(room.steps).toBe(before.steps - 1);
  });

  it('a long throw arrives fast, and a catch off the edge of the glove still holds', () => {
    // From 100 m the ball comes in around 28 m/s. That is not a peg; it is just far.
    const p0: Vec3 = [0, 1.8, 0], target: Vec3 = [0, 1.2, -100];
    const a = solveArc(p0, target, throwElevation(100));
    const arrive = len(velocityAt(simulateFlight(p0, a.v0), a.T));
    expect(arrive).toBeGreaterThan(22);
    expect(classifyCatch(0.18, arrive)).toBe('bobble');
    expect(classifyCatch(0.18, 40)).toBe('deflect');
  });

  // ---------------------------------------------------------------- traits

  const T = (t: Partial<Traits> = {}): Traits => ({ back: false, speed: false, wild: false, mitt: false, ...t });
  function traitRoom(traits: Traits | undefined, n = 2) {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
    const room = new Room('ABCD', clock.now, new MemoryRecords(), { practiceBot: false });
    const conns: FakeConn[] = [], ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = new FakeConn();
      // Only whoever opens the room chooses; a joiner's choice is ignored.
      ids.push(room.join(c, { t: 'hello', room: 'ABCD', guest: `g${i}`, name: `P${i}`, hand: 'R', v: 8, w: HOUSE_WINDUP, tr: i === 0 ? (traits ? traitBits(traits) : undefined) : traitBits(T({ wild: true, speed: true })) })!.id);
      conns.push(c);
    }
    return { room, conns, ids, clock };
  }

  it('traits go on the wire as one small number and come back as they went', () => {
    for (let b = 0; b < 1 << TRAIT_KEYS.length; b++) expect(traitBits(toTraits(b))).toBe(b);
    expect(toTraits('nonsense')).toEqual(DEFAULT_TRAITS);
    expect(toTraits(999)).toEqual(DEFAULT_TRAITS);
    expect(toTraits({ back: true, speed: 'yes' })).toEqual(T({ back: true }));
  });

  it('whoever opens the room chooses its traits, and everyone in it is told the same', () => {
    for (const traits of [T(), T({ back: true }), T({ speed: true, wild: true }), T({ back: true, speed: true, wild: true, mitt: true })]) {
      const { room, conns } = traitRoom(traits);
      expect(room.traits).toEqual(traits);
      for (const c of conns) expect(c.last('welcome')!.score.traits).toEqual(traits);
    }
    // A room opened by a link (or an old phone): long toss, as it always was.
    expect(traitRoom(undefined).room.traits).toEqual(DEFAULT_TRAITS);
    expect(DEFAULT_TRAITS).toEqual(T({ back: true }));
  });

  it('no traits: plain catch. Nobody moves, the glove is a glove, the ball is never faster, and misses cost nothing', () => {
    const { room, ids, clock } = traitRoom(T());
    for (let i = 0; i < 8; i++) exchange(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 14, glove: 1, speed: 1, streak: 8 });
    for (let i = 0; i < 4; i++) miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 14, glove: 1, speed: 1, misses: 0, streak: 0 });
    expect(apart(room, ids)).toBeCloseTo(14, 6);
  });

  it('step back on its own: further apart with every catch, and nothing else changes', () => {
    const { room, ids, clock } = traitRoom(T({ back: true }));
    for (let i = 0; i < 5; i++) exchange(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 19, glove: 1, speed: 1 });
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 18, misses: 1 });
  });

  it('big mitt: the glove starts giant and shrinks with every catch, past regular, to small', () => {
    expect(gloveSize(true, 0)).toBe(MITT_START);
    expect(gloveSize(false, 30)).toBe(1);
    let last = Infinity;
    for (let n = 0; n < 40; n++) { const g = gloveSize(true, n); expect(g).toBeLessThanOrEqual(last); last = g; }
    expect(gloveSize(true, 13)).toBeLessThan(1.05);
    expect(gloveSize(true, 100)).toBe(MITT_MIN);
    const { room, ids, clock } = traitRoom(T({ mitt: true }));
    expect(room.score()).toMatchObject({ glove: MITT_START, dist: 14 });
    for (let i = 0; i < 5; i++) exchange(room, clock, ids);
    expect(room.score().glove).toBe(gloveSize(true, 5));
    expect(room.score().dist).toBe(14);
    // A miss: a size bigger. The third miss: the giant glove is back.
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ glove: gloveSize(true, 4), misses: 1 });
    miss(room, clock, ids); miss(room, clock, ids);
    expect(room.score()).toMatchObject({ glove: MITT_START, misses: 0 });
  });

  it('big mitt: the catch is as big as the glove (and no bigger)', () => {
    const off = (glove: number, traits: Traits) => {
      const { room, ids, clock } = traitRoom(traits);
      const t0 = clock.now();
      const { pose, T: tt } = throwAt(room, ids[0], ids[1], t0);
      // The ball passes 40 cm above where the glove is held.
      const claim = { ...pose, g: [pose.g[0], pose.g[1] - 0.4, pose.g[2]] as Vec3 };
      clock.advance(tt * 1000);
      expect(room.glove()).toBe(glove);
      room.handle(ids[1], { t: 'catch', tid: 1, at: t0 + tt * 1000, pose: wire(claim) });
      return room.ball.holder === ids[1];
    };
    expect(0.4).toBeGreaterThan(CATCH_BOBBLE);
    expect(off(1, T({ back: true }))).toBe(false);
    expect(off(MITT_START, T({ mitt: true }))).toBe(true);
    // The zones scale with the glove: dead centre of a giant glove is still a perfect catch, its edge still a bobble.
    expect(classifyCatch(0.1, 10, 3)).toBe('perfect');
    expect(classifyCatch(0.55, 10, 3)).toBe('bobble');
    expect(classifyCatch(0.65, 10, 3)).toBe(null);
    expect(classifyCatch(0.1, 10, 0.6)).toBe('bobble');
    expect(catchGrade(0.3, 3)).toBeGreaterThan(catchGrade(0.3, 1));
  });

  it('speed up: every catch in a row adds 3% to every throw, up to half as fast again', () => {
    expect(speedFactor(false, 40)).toBe(1);
    expect(speedFactor(true, 0)).toBe(1);
    expect(speedFactor(true, 1)).toBeCloseTo(1 + SPEED_STEP, 9);
    expect(speedFactor(true, 10)).toBeCloseTo(1 + 10 * SPEED_STEP, 9);
    let last = 0;
    for (let n = 0; n < 60; n++) { const f = speedFactor(true, n); expect(f).toBeGreaterThanOrEqual(last); expect(f).toBeLessThanOrEqual(SPEED_MAX); last = f; }
    expect(speedFactor(true, 17)).toBe(SPEED_MAX);
    expect(speedFactor(true, 500)).toBe(SPEED_MAX);
  });

  it('speed up in a room: it builds with the rally, and a drop starts it over', () => {
    const { room, ids, clock } = traitRoom(T({ speed: true }));
    expect(room.score().speed).toBe(1);
    for (let i = 0; i < 6; i++) exchange(room, clock, ids);
    expect(room.score().speed).toBeCloseTo(1 + 6 * SPEED_STEP, 9);
    for (let i = 0; i < 20; i++) exchange(room, clock, ids);
    expect(room.score().speed).toBe(SPEED_MAX);
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ speed: 1, streak: 0, dist: 14, misses: 0 });
    exchange(room, clock, ids);
    expect(room.score().speed).toBeCloseTo(1 + SPEED_STEP, 9);
  });

  it('every trait together: further apart, a smaller glove and a faster ball with every catch; a miss costs a step of each; the third, all of it', () => {
    const { room, ids, clock } = traitRoom(T({ back: true, speed: true, wild: true, mitt: true }));
    for (let i = 0; i < 8; i++) exchange(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 22, glove: gloveSize(true, 8), streak: 8 });
    expect(room.score().speed).toBeCloseTo(1 + 8 * SPEED_STEP, 9);
    miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 21, glove: gloveSize(true, 7), speed: 1, misses: 1 });
    miss(room, clock, ids); miss(room, clock, ids);
    expect(room.score()).toMatchObject({ dist: 14, glove: MITT_START, speed: 1, misses: 0 });
  });

  it('both phones are told the same numbers after every catch', () => {
    const { room, conns, ids, clock } = traitRoom(T({ back: true, speed: true, mitt: true }));
    for (let i = 0; i < 5; i++) {
      exchange(room, clock, ids);
      const [a, b] = conns.map((c) => c.last('ball')!.score);
      expect(a).toEqual(b);
      expect(a).toMatchObject({ traits: T({ back: true, speed: true, mitt: true }), streak: i + 1 });
    }
  });

  it('wild throws: knocked off line the same way for everyone who works it out, never past a dive, and not always the same way', () => {
    expect(wildOffset('ABCD', 7)).toEqual(wildOffset('ABCD', 7));
    expect(wildOffset('ABCD', 7)).not.toEqual(wildOffset('ABCD', 8));
    let far = 0, near = 0, left = 0, sum = 0;
    for (let tid = 1; tid <= 2000; tid++) {
      const [x, y] = wildOffset('WXYZ', tid);
      expect(Math.abs(x)).toBeLessThanOrEqual(WILD_MAX + 1e-9);
      expect(Math.abs(y)).toBeLessThan(0.5);
      sum += Math.abs(x);
      if (Math.abs(x) > 1) far++;
      if (Math.abs(x) < 0.5) near++;
      if (x < 0) left++;
    }
    expect(far / 2000).toBeGreaterThan(0.1);
    expect(near / 2000).toBeGreaterThan(0.25);
    expect(left / 2000).toBeGreaterThan(0.4);
    expect(left / 2000).toBeLessThan(0.6);
    expect(sum / 2000).toBeGreaterThan(0.45);
    expect(sum / 2000).toBeLessThan(0.9);
  });

  it('Coach plays every mix of traits', () => {
    for (const traits of [T(), T({ mitt: true }), T({ speed: true, wild: true }), T({ back: true, speed: true, wild: true, mitt: true })]) {
      let t = 1e6;
      const room = new Room('ABCD', () => t, new MemoryRecords(), { practiceBot: true });
      const m = room.join(new FakeConn(), { t: 'hello', room: 'ABCD', guest: 'g', name: 'P', hand: 'R', v: 8, w: HOUSE_WINDUP, tr: traitBits(traits) })!;
      const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
      throwAt(room, m.id, 'coach', t);
      for (let i = 0; i < 90 && room.ball.phase === 'flight'; i++) { clock.advance(33); room.tick(); }
      expect(room.ball.holder, JSON.stringify(traits)).toBe('coach');
      expect(room.score().traits).toEqual(traits);
      expect(room.score().streak).toBe(1);
    }
  });

  it("Coach's throws get faster with speed up, and wild throws knock them off line, the way the room says", () => {
    const coachThrow = (traits: Traits, streak: number) => {
      let t = 1e6;
      const room = new Room('ABCD', () => t, new MemoryRecords(), { practiceBot: true });
      const m = room.join(new FakeConn(), { t: 'hello', room: 'ABCD', guest: 'g', name: 'P', hand: 'R', v: 8, w: HOUSE_WINDUP, tr: traitBits(traits) })!;
      throwAt(room, m.id, 'coach', t);
      for (let i = 0; i < 90 && room.ball.phase === 'flight'; i++) { t += 33; room.tick(); }
      room.streak = streak;
      for (let i = 0; i < 600 && !(room.ball.phase === 'flight' && room.ball.thrower === 'coach'); i++) { t += 33; room.tick(); }
      expect(room.ball.thrower).toBe('coach');
      return { speed: len(room.ball.v0), v: room.ball.v0 };
    };
    const plain = coachThrow(T(), 17), fast = coachThrow(T({ speed: true }), 17);
    expect(fast.speed / plain.speed).toBeGreaterThan(1.35);
    expect(fast.speed).toBeLessThanOrEqual(THROW_SPEED_LIMIT);
    const wild = coachThrow(T({ wild: true }), 17);
    expect(wild.v).not.toEqual(plain.v);
  });
});
