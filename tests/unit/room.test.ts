import { describe, expect, it } from 'vitest';
import { CATCH_GRACE_MS, EYE_HEIGHT, MAX_PLAYERS, RECOVER_DELAY_MS } from '../../src/shared/constants';
import { positionAt, simulateFlight, solveElevation, solveThrowTo, velocityAt } from '../../src/shared/physics';
import { type Pose, eyePosition, gloveWorld, lookAngles, releasePoint, seatLayout } from '../../src/shared/pose';
import { type ServerMsg, catchGrade, classifyCatch, groupKeyFor } from '../../src/shared/protocol';
import { type Vec3, dist, len } from '../../src/shared/vec';
import { type Conn, MemoryRecords, Room } from '../../src/server/room';

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
    const m = room.join(c, { t: 'hello', room: 'ABCD', guest: `g${i}`, name: `P${i}`, hand: 'R', v: 1 });
    conns.push(c);
    ids.push(m!.id);
  }
  return { room, conns, ids, clock };
}

/** Throw from `from` straight at `to`'s glove held at a given pose. */
function throwAt(room: Room, fromId: string, toId: string, t: number, pace = 15, offset: Vec3 = [0, 0, 0]) {
  const from = room.members.get(fromId)!;
  const to = room.members.get(toId)!;
  const toEye = eyePosition(to.pos);
  const look = lookAngles(toEye, eyePosition(from.pos));
  const pose: Pose = { yaw: look.yaw, pitch: look.pitch - 0.25, gu: 0, gv: 0 };
  const glove = gloveWorld(to.pos, pose);
  const target: Vec3 = [glove[0] + offset[0], glove[1] + offset[1], glove[2] + offset[2]];
  const yaw = lookAngles(eyePosition(from.pos), target).yaw;
  const p = releasePoint(from.pos, yaw, 'R');
  const T = dist(p, target) / pace;
  const v = solveThrowTo(p, target, T);
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
    expect(classifyCatch(0.19, 28)).toBe('deflect');
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
    expect(dist(two[0].pos, two[1].pos)).toBeGreaterThan(12);
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
    const claim = { t: 'catch' as const, tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] as [number, number, number, number] };
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
      room.handle(to, { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
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
    void catchGrade;
    clock.advance(T * 1000 + 20);
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
    expect(room.ball.phase).toBe('flight');
    expect(room.streak).toBe(0);
  });

  it('a miss resets the streak exactly once and the ball is recovered', () => {
    const { room, ids, conns, clock } = setup(2);
    // Build a streak of 2.
    let holder = ids[0], other = ids[1];
    for (let i = 0; i < 2; i++) {
      const t0 = clock.now();
      const { pose, T } = throwAt(room, holder, other, t0);
      clock.advance(T * 1000);
      room.handle(other, { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
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
    room.handle(ids[1], { t: 'catch', tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
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
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
    room.disconnect(ids[1], conns[1]);
    expect(conns[0].last('roster')!.players.find((p) => p.id === ids[1])!.connected).toBe(false);
    const again = new FakeConn();
    const m = room.join(again, { t: 'hello', room: 'ABCD', guest: 'g1', name: 'P1', hand: 'R', v: 1 });
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
    room.handle(ids[1], { t: 'catch', tid: room.ball.tid, at: t0 + T * 1000, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
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
    const pose: Pose = { yaw: me.facing, pitch: 0.9, gu: 0, gv: 0 };
    const glove = gloveWorld(me.pos, pose);
    const p = releasePoint(me.pos, me.facing, 'R');
    const t0 = clock.now();
    const v = solveThrowTo(p, glove, 1.2);
    room.handle(ids[0], { t: 'throw', rt: t0, p, v, tid: 1 });
    clock.advance(1200);
    room.handle(ids[0], { t: 'catch', tid: 1, at: t0 + 1200, pose: [pose.yaw, pose.pitch, pose.gu, pose.gv] });
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
});
