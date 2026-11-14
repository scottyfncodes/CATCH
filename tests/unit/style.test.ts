import { describe, expect, it } from 'vitest';
import {
  BUILDS, COACH_STYLE, GLOVES, HAIRS, HATS, MILESTONES, PANTS, S, SKINS, type Style, TOPS,
  defaultStyle, nextMilestone, owns, rewardAt, sanitizeStyle, wearable,
} from '../../src/shared/style';
import type { ServerMsg } from '../../src/shared/protocol';
import { type Conn, MemoryRecords, Room } from '../../src/server/room';

describe('looks and rewards', () => {
  it('rewards come at 10, 25, 50, 100, 250, 500, 750, 1000, 1500 and on', () => {
    expect(MILESTONES.slice(0, 9)).toEqual([10, 25, 50, 100, 250, 500, 750, 1000, 1500]);
    expect([...MILESTONES].sort((a, b) => a - b)).toEqual(MILESTONES);
  });

  it('every milestone gives exactly one thing to wear, and nothing is earned anywhere else', () => {
    const all = [...HATS.map((x) => ['hat', x] as const), ...GLOVES.map((x) => ['glove', x] as const), ...TOPS.map((x) => ['top', x] as const)];
    for (const m of MILESTONES) {
      const hits = all.filter(([, x]) => x.at === m);
      expect(hits.length, `milestone ${m}`).toBe(1);
      expect(rewardAt(m)!.name).toBe(hits[0][1].name);
    }
    for (const [, x] of all) expect(x.at === 0 || MILESTONES.includes(x.at)).toBe(true);
    expect(rewardAt(11)).toBe(null);
    // Hats, gloves and clothing all come round.
    expect(new Set(MILESTONES.map((m) => rewardAt(m)!.kind))).toEqual(new Set(['hat', 'glove', 'top']));
  });

  it('there is a real choice from the start, across a range of people', () => {
    expect(SKINS.length).toBeGreaterThanOrEqual(6);
    expect(BUILDS.length).toBeGreaterThanOrEqual(3);
    expect(HAIRS.length).toBeGreaterThanOrEqual(5);
    for (const list of [HATS, GLOVES, TOPS]) expect(list.filter((x) => x.at === 0).length).toBeGreaterThanOrEqual(2);
    expect(PANTS.length).toBeGreaterThanOrEqual(4);
  });

  it('a new player gets a look made only of free things, and different people get different looks', () => {
    const looks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const st = defaultStyle(`guest-${i}`);
      expect(sanitizeStyle(st, COACH_STYLE)).toEqual(st);
      expect(owns('hat', st[S.hat], []) && owns('glove', st[S.glove], []) && owns('top', st[S.top], [])).toBe(true);
      looks.add(st.join());
    }
    expect(looks.size).toBeGreaterThan(20);
    expect(defaultStyle('same')).toEqual(defaultStyle('same'));
  });

  it('what you have earned is what you can wear', () => {
    const bucket = HATS.findIndex((h) => h.at === 25);
    expect(owns('hat', bucket, [])).toBe(false);
    expect(owns('hat', bucket, [10])).toBe(false);
    expect(owns('hat', bucket, [10, 25])).toBe(true);
    const st: Style = [0, 1, 1, 0, bucket, GLOVES.findIndex((g) => g.at === 10), 0, 0];
    expect(wearable(st, [10])[S.hat]).toBe(0);
    expect(wearable(st, [10])[S.glove]).toBe(st[S.glove]);
    expect(wearable(st, [10, 25])).toEqual(st);
  });

  it('nonsense from the wire becomes something drawable', () => {
    const base = defaultStyle('x');
    expect(sanitizeStyle(undefined, base)).toEqual(base);
    expect(sanitizeStyle('hat', base)).toEqual(base);
    expect(sanitizeStyle([99, -1, 1.5, 'a', null, 2, 3], base)).toEqual([base[0], base[1], base[2], base[3], base[4], 2, 3, base[7]]);
    expect(sanitizeStyle([1, 2, 3, 4, 5, 3, 7, 2], base)).toEqual([1, 2, 3, 4, 5, 3, 7, 2]);
  });

  it('knows what comes next', () => {
    expect(nextMilestone(0)).toBe(10);
    expect(nextMilestone(10)).toBe(25);
    expect(nextMilestone(749)).toBe(750);
    expect(nextMilestone(1e6)).toBe(null);
  });
});

describe('looks in a room', () => {
  class C implements Conn {
    msgs: ServerMsg[] = [];
    send(m: ServerMsg) { this.msgs.push(JSON.parse(JSON.stringify(m))); }
    close() {}
    roster() { return ([...this.msgs].reverse().find((m) => m.t === 'roster' || m.t === 'welcome') as Extract<ServerMsg, { t: 'roster' }>).players; }
  }

  it('everyone is told what everyone looks like, and a change is passed on', () => {
    const room = new Room('ABCD', () => 1e6, new MemoryRecords(), { practiceBot: false });
    const a = new C(), b = new C();
    const mine: Style = [5, 2, 4, 3, 3, 1, 2, 4];
    const A = room.join(a, { t: 'hello', room: 'ABCD', guest: 'a', name: 'A', hand: 'R', v: 5, s: mine })!;
    const B = room.join(b, { t: 'hello', room: 'ABCD', guest: 'b', name: 'B', hand: 'L', v: 5 })!;
    expect(b.roster().find((p) => p.id === A.id)!.style).toEqual(mine);
    // No look sent: the server gives a stable one of its own.
    expect(a.roster().find((p) => p.id === B.id)!.style).toEqual(defaultStyle('b'));
    const next: Style = [0, 0, 0, 0, 4, 0, 5, 0];
    room.handle(A.id, { t: 'prof', name: 'A', hand: 'R', s: next });
    expect(b.roster().find((p) => p.id === A.id)!.style).toEqual(next);
    // Changing your name alone keeps your look; a malformed look changes nothing it can't read.
    room.handle(A.id, { t: 'prof', name: 'A2', hand: 'R' });
    room.handle(A.id, { t: 'prof', name: 'A2', hand: 'R', s: [999, 0, 0, 0, 999, 0, 5, 0] });
    expect(room.members.get(A.id)!.style).toEqual(next);
  });

  it('Coach has a look of its own', () => {
    const room = new Room('ABCD', () => 1e6, new MemoryRecords());
    room.join(new C(), { t: 'hello', room: 'ABCD', guest: 'a', name: 'A', hand: 'R', v: 5 });
    expect(room.members.get('coach')!.style).toEqual(COACH_STYLE);
  });
});

describe('every look can be drawn', () => {
  it('builds a player for every hat, hair, top, glove and build, and runs them', async () => {
    const { Avatar } = await import('../../src/client/scene/avatar');
    const n = Math.max(HATS.length, HAIRS.length, TOPS.length, GLOVES.length);
    for (let i = 0; i < n * 2; i++) {
      const st: Style = [i % SKINS.length, i % BUILDS.length, i % HAIRS.length, i % 6, (i * 2 + (i >= n ? 1 : 0)) % HATS.length, i % GLOVES.length, i % TOPS.length, i % PANTS.length];
      const av = new Avatar([0, 0, 0], 0, i % 2 ? 'L' : 'R', st, 34);
      for (let k = 0; k < 5; k++) av.update(1 / 60, { pose: { x: 0, z: 0, yaw: 0, g: [0.2, 1.2, -0.5] }, arm: 0, charge: 0, look: [0, 1.5, -10], ready: k > 2, gloved: k === 4 });
      av.catchImpact([0, 0, 1], 20);
      av.update(1 / 60, { pose: { x: 0, z: 0, yaw: 0, g: [0.2, 1.2, -0.5] }, arm: 0, charge: 0, look: null });
      expect(Number.isFinite(av.gloveWorldPos.x)).toBe(true);
      av.dispose();
    }
  });
});

describe('what you earn', () => {
  it('is ridiculous, and the further the streak the more so: everything you start with is ordinary, nothing you earn is', () => {
    for (const h of HATS) expect(h.at === 0 ? ['cap', 'back', 'none'] : ['propeller', 'duck', 'cowboy', 'crown'], h.name).toContain(h.shape);
    for (const g of GLOVES) expect(!!g.extra, g.name).toBe(g.at > 0);
    for (const t of TOPS) expect(t.pattern === 'plain', t.name).toBe(t.at === 0);
    // The biggest streaks earn the biggest things.
    expect(rewardAt(3000)!.name).toBe('Crown');
    expect(rewardAt(5000)!.name).toBe('Royal robe');
  });

  it('every earned thing has a swatch for the look editor that is more than one colour', () => {
    for (const it of [...HATS, ...GLOVES, ...TOPS].filter((x) => x.at > 0)) expect(it.swatch, it.name).toMatch(/gradient/);
  });
});
