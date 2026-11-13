// Agreeing with the server about what time it is: everything about a throw depends on it.
import { describe, expect, it } from 'vitest';
import { newClock, syncClock } from '../../src/client/net';

/** The server's clock runs `SKEW` ms ahead of this device's. */
const SKEW = 5000;
/** A ping sent at `sent`, taking `up` ms to get there and `down` ms to be handled back here. */
const ping = (c: ReturnType<typeof newClock>, sent: number, up: number, down: number) => syncClock(c, sent, sent + up + SKEW, sent + up + down);

describe('clock sync', () => {
  it('a quick, even round trip gives the server clock to within a millisecond or two', () => {
    const c = ping(newClock(), 100, 3, 3);
    expect(Math.abs(c.offset - SKEW)).toBeLessThan(1);
  });

  it('a first ping answered while the page was busy is badly out; one good ping puts it right', () => {
    // The reply sat for 700 ms behind the game starting up.
    let c = ping(newClock(), 0, 4, 700);
    expect(Math.abs(c.offset - SKEW)).toBeGreaterThan(300);
    c = ping(c, 900, 4, 4);
    expect(Math.abs(c.offset - SKEW)).toBeLessThan(2);
  });

  it('ordinary jitter does not throw a good estimate away', () => {
    let c = newClock();
    for (let i = 0; i < 6; i++) c = ping(c, i * 120, 5, 5);
    // A slow, lopsided one.
    c = ping(c, 2000, 5, 180);
    expect(Math.abs(c.offset - SKEW)).toBeLessThan(2);
    // And then a run of slightly slower but honest ones is eased into, not jumped to.
    for (let i = 0; i < 5; i++) c = ping(c, 4000 + i * 2000, 9, 9);
    expect(Math.abs(c.offset - SKEW)).toBeLessThan(3);
  });

  it('if the connection gets slower for good, the estimate still follows the clock', () => {
    let c = newClock();
    for (let i = 0; i < 5; i++) c = ping(c, i * 120, 5, 5);
    // The server's clock drifts 40 ms away while every ping now takes 120 ms.
    for (let i = 0; i < 80; i++) c = syncClock(c, 10000 + i * 2000, 10000 + i * 2000 + 60 + SKEW + 40, 10000 + i * 2000 + 120);
    expect(Math.abs(c.offset - (SKEW + 40))).toBeLessThan(10);
  });
});
