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
export const MAX_SIM_TIME = 9;

/** Throw speed envelope (m/s). ~17 mph soft toss to ~67 mph strong throw. */
export const THROW_MIN_SPEED = 7.5;
export const THROW_MAX_SPEED = 30;
/** Server-side sanity cap (a little headroom over MAX for flick bonus). */
export const THROW_SPEED_LIMIT = 33;

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
/** Ready position: glove out in front, a bit below the chest. */
export const GLOVE_READY: [number, number, number] = [0, 1.18, 0.42];

/** Catch zones: distance from glove pocket centre to the ball centre (metres). */
export const CATCH_PERFECT = 0.045;
export const CATCH_POCKET = 0.095;
export const CATCH_WEB = 0.155;
export const CATCH_BOBBLE = 0.205;
/** A bobble at this relative speed or above deflects out of the glove. */
export const BOBBLE_DEFLECT_SPEED = 21;

/** How long the server waits after ground contact for a late catch claim (ms). */
export const CATCH_GRACE_MS = 450;
/** Tolerance the server allows between claimed and recomputed geometry (m). */
export const CATCH_VALIDATION_SLACK = 0.06;
/** After the ball comes to rest, how long before it is recovered (ms). */
export const RECOVER_DELAY_MS = 900;
/** Disconnected players keep their spot this long (ms). */
export const RECONNECT_GRACE_MS = 90_000;

export const STREAK_MILESTONES = [10, 25, 50, 100, 250, 500, 1000];

/** Network rates. */
export const CLIENT_STATE_HZ = 20;
export const SNAPSHOT_HZ = 20;
export const SERVER_TICK_HZ = 30;
