// Shared tuning for client and server. Everything that affects the authoritative
// simulation lives here so both sides compute identical results.

export const MAX_PLAYERS = 5;

/** Fixed simulation step for ball flight (seconds). */
export const SIM_DT = 1 / 240;
export const GRAVITY = 9.81;
/** Regulation baseball: 2.9" diameter. */
export const BALL_RADIUS = 0.0366;
/**
 * Quadratic drag coefficient k in a = -k|v|v.
 * 0.5 * rho(1.2) * Cd(0.35) * A(0.0042 m^2) / m(0.145 kg) ≈ 0.0061.
 */
export const BALL_DRAG = 0.0061;
/** Vertical coefficient of restitution on grass, and horizontal retention per bounce. */
export const GROUND_RESTITUTION = 0.42;
export const GROUND_FRICTION_BOUNCE = 0.68;
/** Rolling deceleration on grass, m/s^2. */
export const ROLL_DECEL = 2.6;
/** Ball considered at rest below this speed. */
export const REST_SPEED = 0.08;
/** Hard cap on simulated ball life (seconds). */
export const MAX_SIM_TIME = 12;

/**
 * Server-side sanity cap on throw speed (m/s). The longest catch (DIST_MAX)
 * takes about 48 m/s, 107 mph, on a rising arc; a hard, flat one a little more.
 */
export const THROW_SPEED_LIMIT = 80;

/**
 * How much more zip a throw has than the arc alone would give it: every throw
 * (yours, a friend's, Coach's) is this much faster than the speed its arc
 * implies, on a flatter line to the same place. Kept under THROW_SPEED_CAP.
 */
export const THROW_ZIP = 1.17;
/** The fastest the game ever throws a ball (m/s), whatever is making it faster. */
export const THROW_SPEED_CAP = 74;

/** Speed up: each catch in a row adds this much to every throw's speed (a fraction of normal)... */
export const SPEED_STEP = 0.03;
/** ...up to this (×normal). With SPEED_STEP at 3% that's 17 catches in. */
export const SPEED_MAX = 1.5;

/** Wild throws: the furthest a throw is knocked off line, sideways at the receiver (m). A dive gets there. */
export const WILD_MAX = 1.5;

/**
 * Long toss: the room starts across the road and every catch takes everyone a
 * step further back. A miss brings you a step in; the third miss and you
 * start again from the beginning (misses are counted in total, not in a row).
 */
export const DIST_STEP = 1;
/** As far apart as two people get (m): about as far as anyone can throw a baseball. */
export const DIST_MAX = 120;
export const MISSES_TO_RESET = 3;

/**
 * Big mitt: everyone starts with a giant glove and it shrinks with every
 * catch, down past a regular glove to a small one. The catch zones are the
 * glove's size, so this is the one mode where the glove changes the game.
 */
export const MITT_START = 3;
export const MITT_SHRINK = 0.92;
export const MITT_MIN = 0.6;

export const EYE_HEIGHT = 1.62;
export const CHEST_HEIGHT = 1.3;

/**
 * Third-person body model. A player stands somewhere near their home spot and
 * can move to get under a throw. The glove can be anywhere inside a reach
 * envelope around the body: an ellipsoid centred at REACH_CENTER_Y above the
 * feet, REACH_H wide (arm + lean + a half step) and REACH_V tall (a crouch
 * down to the grass, a stretch up over the head). Client and server share it.
 */
export const MOVE_RADIUS = 4.5;
/** Top speed when hustling after a throw (m/s) and how fast you get there. */
export const RUN_SPEED = 5.2;
export const RUN_ACCEL = 16;
/** Walking pace back to your spot afterwards. */
export const WALK_SPEED = 1.35;
export const REACH_CENTER_Y = 1.22;
export const REACH_H = 1.02;
export const REACH_V = 1.12;
/** A leap for a high throw: how far off the grass it takes you (m) and how long you're up (s). */
export const LEAP_HEIGHT = 0.5;
export const LEAP_TIME = 0.62;
/** A dive for a wide one: a burst along the grass (m/s) that lasts this long (s), then you get up. */
export const DIVE_SPEED = 8.2;
export const DIVE_TIME = 0.34;
export const DIVE_RECOVER = 0.5;
/** Ready position: glove out in front, a bit below the chest. */
export const GLOVE_READY: [number, number, number] = [0, 1.18, 0.42];

/** Catch zones: distance from glove pocket centre to the ball centre (metres). */
export const CATCH_PERFECT = 0.045;
export const CATCH_POCKET = 0.095;
export const CATCH_WEB = 0.155;
export const CATCH_BOBBLE = 0.205;
/**
 * A bobble at this relative speed or above deflects out of the glove. Only a
 * real peg does it: a long throw arrives quick (25-30 m/s from 100 m) simply
 * because it had to be thrown hard, and that must not cost you the catch.
 */
export const BOBBLE_DEFLECT_SPEED = 34;

/** How long the server waits after ground contact for a late catch claim (ms). */
export const CATCH_GRACE_MS = 450;
/** Tolerance the server allows between claimed and recomputed geometry (m). */
export const CATCH_VALIDATION_SLACK = 0.06;
/** After the ball comes to rest, how long before it is recovered (ms). */
export const RECOVER_DELAY_MS = 900;
/** Disconnected players keep their spot this long (ms). */
export const RECONNECT_GRACE_MS = 90_000;

/** (The streaks that are celebrated and rewarded are MILESTONES, in style.ts.) */

/** Network rates. */
export const CLIENT_STATE_HZ = 20;
export const SNAPSHOT_HZ = 20;
export const SERVER_TICK_HZ = 30;
