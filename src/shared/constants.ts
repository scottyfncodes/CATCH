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
 * Glove placement. The glove pose (gu, gv) in [-1, 1] maps to a direction in
 * view space: x = gu * GLOVE_TAN_X, y = gv * GLOVE_TAN_Y (y down is negative),
 * at a distance from the eye that grows as the glove reaches outward.
 * The mapping is deterministic (independent of screen aspect) so the server
 * can reconstruct exactly where a player's glove was.
 */
export const GLOVE_TAN_X = 0.42;
export const GLOVE_TAN_Y = 0.62;
export const GLOVE_REACH_NEAR = 0.6;
export const GLOVE_REACH_FAR = 0.82;
/** Resting glove pose (slightly low, toward the glove-hand side). */
export const GLOVE_REST_U = -0.45;
export const GLOVE_REST_V = -0.42;

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
