// flapper.js - The flapping-wing hummingbird robot, ported from flappy (Purdue's FWMAV simulator).
//
// Pure and DOM-free like physics.js, so it runs headlessly under Node against reference data
// recorded from the original DART simulation (tests/hummingbird.test.mjs).
//
// The robot is five rigid bodies: the torso on a free joint, and on each side a leading edge on a
// motor-driven stroke joint carrying a wing on a passive rotate joint. Everything here follows the
// original step for step, because the learned controller only flies the physics it was trained on:
//
// * Coordinates are flappy's, not the renderer's: z up, x forward (the nose), y to the left. The
//   free joint's velocity is a body-frame twist [w; v], as in DART.
// * One step is DART's World::step at 10 kHz: forward dynamics with the stroke springs and joint
//   damping treated implicitly, velocity integration, the joint-limit impulses, then positions.
// * The wing forces are flappy's quasi-steady blade-element model (Wing.cpp), the motors its DC
//   motor model (fwmav.py Actuator), sampled exactly as the originals sample them.
//
// Dynamics are computed with spatial vectors in body frames, angular part first: the mass matrix by
// the composite-rigid-body algorithm and the bias forces (Coriolis, gravity, wing loads) by
// recursive Newton-Euler, then a 10x10 Cholesky solve. Each call allocates nothing.

const NB = 5; // bodies: torso, left leading edge, left wing, right leading edge, right wing
const ND = 10; // dofs: 6 for the torso, then left stroke, left rotate, right stroke, right rotate

// ---- small 3-vector / 3x3 helpers on plain arrays, row-major matrices ----

function cross(a, b, out) {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

function matVec(R, v, out) { // R v
    const x = R[0] * v[0] + R[1] * v[1] + R[2] * v[2];
    const y = R[3] * v[0] + R[4] * v[1] + R[5] * v[2];
    const z = R[6] * v[0] + R[7] * v[1] + R[8] * v[2];
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

function matTVec(R, v, out) { // R^T v
    const x = R[0] * v[0] + R[3] * v[1] + R[6] * v[2];
    const y = R[1] * v[0] + R[4] * v[1] + R[7] * v[2];
    const z = R[2] * v[0] + R[5] * v[1] + R[8] * v[2];
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

function matMul(A, B, out) { // A B, out may not alias A or B
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            out[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
        }
    }
    return out;
}

// Rotation by angle |w| about w (Rodrigues), DART's expMapRot
export function expRot(w, out) {
    const th2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
    const th = Math.sqrt(th2);
    let a, b;
    if (th < 1e-8) {
        a = 1 - th2 / 6;
        b = 0.5 - th2 / 24;
    } else {
        a = Math.sin(th) / th;
        b = (1 - Math.cos(th)) / th2;
    }
    const [x, y, z] = w;
    out[0] = 1 - b * (y * y + z * z); out[1] = -a * z + b * x * y; out[2] = a * y + b * x * z;
    out[3] = a * z + b * x * y; out[4] = 1 - b * (x * x + z * z); out[5] = -a * x + b * y * z;
    out[6] = -a * y + b * x * z; out[7] = a * x + b * y * z; out[8] = 1 - b * (x * x + y * y);
    return out;
}

// Inverse of expRot, for converting to DART's free-joint coordinates (tests only)
export function logRot(R) {
    const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
    const th = Math.acos(c);
    const v = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
    const k = th < 1e-8 ? 0.5 : th / (2 * Math.sin(th));
    return [v[0] * k, v[1] * k, v[2] * k];
}

// Rotation about a unit axis, for the revolute joints
const _axisScratch = [0, 0, 0];
function axisRot(a, q, out) {
    _axisScratch[0] = a[0] * q; _axisScratch[1] = a[1] * q; _axisScratch[2] = a[2] * q;
    return expRot(_axisScratch, out);
}

// ---- 6x6 spatial matrices, row-major Float64Array(36) ----

// Motion transform taking a parent-frame twist [w; v] into the child frame, for a child frame at
// rotation E and position r in the parent: w_c = E^T w_p, v_c = E^T (v_p + w_p x r).
function motionTransform(E, r, X) {
    X.fill(0);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            const et = E[j * 3 + i]; // (E^T)_ij
            X[i * 6 + j] = et;
            X[(i + 3) * 6 + j + 3] = et;
        }
    }
    // lower-left block: -E^T [r]x
    const rx = [0, -r[2], r[1], r[2], 0, -r[0], -r[1], r[0], 0];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += E[k * 3 + i] * rx[k * 3 + j];
            X[(i + 3) * 6 + j] = -s;
        }
    }
    return X;
}

// out += X^T I X
function addCongruence(X, I, out, tmp) {
    for (let i = 0; i < 6; i++) { // tmp = I X
        for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++) s += I[i * 6 + k] * X[k * 6 + j];
            tmp[i * 6 + j] = s;
        }
    }
    for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
            let s = 0;
            for (let k = 0; k < 6; k++) s += X[k * 6 + i] * tmp[k * 6 + j];
            out[i * 6 + j] += s;
        }
    }
}

function mat6Vec(A, v, out) {
    for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += A[i * 6 + k] * v[k];
        out[i] = s;
    }
    return out;
}

function mat6TVec(A, v, out) {
    for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += A[k * 6 + i] * v[k];
        out[i] = s;
    }
    return out;
}

// Spatial inertia about the body origin, from mass m, COM c and inertia Ic about the COM
function spatialInertia(m, c, Ic) {
    const G = new Float64Array(36);
    const cx = [0, -c[2], c[1], c[2], 0, -c[0], -c[1], c[0], 0];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0; // m [c]x [c]x^T
            for (let k = 0; k < 3; k++) s += cx[i * 3 + k] * cx[j * 3 + k];
            G[i * 6 + j] = Ic[i][j] + m * s;
            G[i * 6 + j + 3] = m * cx[i * 3 + j];
            G[(i + 3) * 6 + j] = m * cx[j * 3 + i];
        }
        G[(i + 3) * 6 + i + 3] = m;
    }
    return G;
}

// ---- the flappy wing: quasi-steady blade-element aerodynamics, Wing.cpp line for line ----

export class Wing {
    constructor(index, w, shoulderWidth) {
        this.sign = index === 0 ? 1 : -1; // left wing 0, right wing 1
        this.rho = 1.18009482370369;
        this.R = w.wing_length;
        this.c = w.mean_chord;
        this.r33 = w.r33; this.r22 = w.r22; this.r11 = w.r11; this.r00 = w.r00;
        this.zcp2 = w.z_cp2; this.zcp1 = w.z_cp1; this.zcp0 = w.z_cp0; this.zrd = w.z_rd;
        this.d0 = shoulderWidth;
        this.ds = w.stroke_plane_offset;
        this.rcp = this.R * this.r33 / this.r22;
        this.normalForce = 0;
        this.spanCoP = this.rcp;
        this.chordCoP = 0;
        this.rotationalDamping = 0;
    }

    // Body rates (p, q, r) and COM velocity (u, v, w) in body axes, stroke angle and rate, wing
    // rotation angle and rate. Stroke plane and deviation angles are zero on this robot.
    update(p, q, r, u, v, w, psi, psiDot, theta, thetaDot) {
        const s = this.sign, d0 = this.d0, ds = this.ds, R = this.R;
        const SPhi = 0, CPhi = 1, Sphi = 0, Cphi = 1, PhiDot = 0, phiDot = 0;
        const Spsi = Math.sin(psi), Cpsi = Math.cos(psi);

        const Uo1 = s * (p * Cpsi * CPhi - PhiDot * Spsi) + (q * Spsi + r * Cpsi * SPhi + phiDot);
        const Uo0 = s * (-(u + q * ds) * Cphi * SPhi - r * d0 * Sphi * Spsi * CPhi - (v - p * ds) * Sphi * Cpsi
            + w * Sphi * Spsi * SPhi + p * d0 * Cphi * CPhi)
            + ((u + q * ds) * Sphi * Spsi * CPhi + r * d0 * Cphi * SPhi + w * Cphi * CPhi + p * d0 * Sphi * Spsi * SPhi);
        const Ui1 = s * (p * Sphi * Spsi * CPhi + r * Cphi * CPhi + PhiDot * Sphi * Cpsi)
            + (-p * Cphi * SPhi - q * Sphi * Cpsi + r * Sphi * Spsi * SPhi + psiDot * Cphi);
        const Ui0 = s * (r * d0 * Cpsi * CPhi - (v - p * ds) * Spsi - w * Cpsi * SPhi)
            + (-(u + q * ds) * Cpsi * CPhi - p * d0 * Cpsi * SPhi);

        // angle of attack at the centre of pressure
        const Ui = Ui1 * this.rcp + Ui0;
        const dAlpha = Ui !== 0 ? Math.atan((Uo1 * this.rcp + Uo0) / Ui) : 0;
        const alpha = theta + Math.sign(Ui) * Math.PI / 2 - dAlpha;

        const CN = 1.8 * Math.sin(2 * alpha) * Math.cos(alpha) + 1.95 * Math.sin(alpha) - 1.5 * Math.cos(2 * alpha) * Math.sin(alpha);
        const dcp = 0.46 - 0.332 * Math.cos(alpha) - 0.037 * Math.cos(3 * alpha) - 0.013 * Math.cos(5 * alpha);

        const aU2 = Ui1 * Ui1 + Uo1 * Uo1;
        const aU1 = 2 * Ui1 * Ui0 + 2 * Uo1 * Uo0;
        const aU0 = Ui0 * Ui0 + Uo0 * Uo0;

        const R2 = R * R, R3 = R2 * R;
        this.normalForce = 0.5 * this.rho * this.c * CN * (aU2 * R3 * this.r22 + aU1 * R2 * this.r11 + aU0 * R * this.r00);
        const moment = -0.5 * this.rho * this.c * this.c * CN * dcp * (aU2 * R3 * this.zcp2 + aU1 * R2 * this.zcp1 + aU0 * R * this.zcp0);
        this.chordCoP = this.normalForce !== 0 ? -moment / this.normalForce : 0;
        this.spanCoP = this.rcp;
        this.rotationalDamping = -0.125 * this.rho * Math.abs(thetaDot) * thetaDot * 5.0 * R * this.c ** 4 * this.zrd;
    }
}

// ---- the stroke motor: fwmav.py Actuator ----

class Motor {
    constructor(m) {
        this.config = m;
        this.resistance = m.resistance;
        this.voltage = 0;
        this.torque = 0;
    }

    reset() {
        this.voltage = 0;
        this.torque = 0;
    }

    // Output torque at the stroke joint for a stroke rate and acceleration
    update(strokeVel, strokeAcc) {
        const m = this.config;
        const motorVel = strokeVel * m.gear_ratio;
        const motorAcc = strokeAcc * m.gear_ratio;
        const current = (this.voltage - m.torque_constant * motorVel) / this.resistance;
        const motorTorque = m.torque_constant * current - m.inertia * motorAcc
            - m.damping_coefficient * motorVel - m.friction_coefficient * Math.sign(strokeVel);
        this.torque = motorTorque * m.gear_ratio * m.mechanical_efficiency;
        return this.torque;
    }
}

// The drive waveform for one motor: fwmav_sim_env.py generate_control_signal
export function controlSignal(f, Umax, delta, bias, sc, t) {
    const V = Umax + delta;
    const sigma = 0.5 + sc;
    const T = 1 / f;
    t = t - Math.floor(t / T) * T;
    if (t >= 0 && t < sigma / f) return V * Math.cos(2 * Math.PI * f * t / (2 * sigma)) + bias;
    if (t >= sigma / f && t < 1 / f) return V * Math.cos((2 * Math.PI * f * t - 2 * Math.PI) / (2 * (1 - sigma))) + bias;
    return 0;
}

// ---- the robot ----

export class Flapper {
    constructor(robot) {
        this.robot = robot;
        this.dt = robot.dt_sim;
        this.dtDriver = robot.dt_driver;
        this.gravity = robot.gravity;

        const bodies = robot.bodies;
        if (bodies.length !== NB) throw new Error('expected 5 bodies');
        this.parent = bodies.map(b => b.parent);
        this.mass = bodies.map(b => b.mass);
        this.localCom = bodies.map(b => b.local_com);
        this.G = bodies.map(b => spatialInertia(b.mass, b.local_com, b.inertia));
        // joint frames: rotation and translation of the joint in the parent body (the child body
        // frame sits on the joint in this model; checked, since the dynamics rely on it)
        this.jointE = [];
        this.jointR = [];
        for (const b of bodies) {
            const T = b.parent_to_joint;
            this.jointE.push([T[0][0], T[0][1], T[0][2], T[1][0], T[1][1], T[1][2], T[2][0], T[2][1], T[2][2]]);
            this.jointR.push([T[0][3], T[1][3], T[2][3]]);
            const C = b.child_to_joint;
            for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                if (Math.abs(C[i][j] - (i === j ? 1 : 0)) > 1e-12) throw new Error('child_to_joint must be identity');
            }
        }
        this.axis = bodies.map(b => b.axis || null);
        this.lower = new Float64Array(ND);
        this.upper = new Float64Array(ND);
        this.spring = new Float64Array(ND);
        this.rest = new Float64Array(ND);
        this.damping = new Float64Array(ND);
        this.friction = new Float64Array(ND);
        for (let i = 1; i < NB; i++) {
            const b = bodies[i];
            this.lower[5 + i] = b.lower;
            this.upper[5 + i] = b.upper;
            this.spring[5 + i] = b.spring;
            this.rest[5 + i] = b.rest;
            this.damping[5 + i] = b.damping;
            this.friction[5 + i] = b.friction;
        }

        this.wings = [new Wing(0, robot.wing, robot.shoulder_width[0]), new Wing(1, robot.wing, robot.shoulder_width[1])];
        this.motors = [new Motor(robot.motor[0]), new Motor(robot.motor[1])];

        // ---- state ----
        this.R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); // torso orientation in the world
        this.p = new Float64Array(3); // torso frame origin in the world
        this.q = new Float64Array(ND); // joint angles in slots 6..9 (0..5 unused)
        this.dq = new Float64Array(ND); // torso twist [w; v] in body axes, then joint rates
        this.ddq = new Float64Array(ND); // last step's accelerations, which the motor model reads
        this.time = 0;
        this.driverTime = 0;

        // ---- per-step scratch ----
        this.bodyE = [];
        this.bodyRw = [];
        this.bodyPw = [];
        this.X = [];
        this.Ic = [];
        for (let i = 0; i < NB; i++) {
            this.bodyE.push(new Float64Array(9));
            this.bodyRw.push(new Float64Array(9));
            this.bodyPw.push(new Float64Array(3));
            this.X.push(new Float64Array(36));
            this.Ic.push(new Float64Array(36));
        }
        this.V = Array.from({ length: NB }, () => new Float64Array(6));
        this.A = Array.from({ length: NB }, () => new Float64Array(6));
        this.F = Array.from({ length: NB }, () => new Float64Array(6));
        this.Fext = Array.from({ length: NB }, () => new Float64Array(6));
        this.M = new Float64Array(ND * ND);
        this.Mimp = new Float64Array(ND * ND);
        this.L = new Float64Array(ND * ND);
        this.bias = new Float64Array(ND);
        this.tau = new Float64Array(ND);
        this.rhs = new Float64Array(ND);
        this._6a = new Float64Array(6);
        this._6b = new Float64Array(6);
        this._36 = new Float64Array(36);
        this._3a = new Float64Array(3);
        this._3b = new Float64Array(3);
        this._9a = new Float64Array(9);
        this._9b = new Float64Array(9);
        this.updateKinematics();
    }

    // Puts the robot at rest: torso frame at `position`, level, facing `yaw`, wings at mid stroke
    reset(position = [0, 0, 0], yaw = 0) {
        expRot([0, 0, yaw], this.R);
        this.p.set(position);
        this.q.fill(0);
        this.q[6] = this.rest[6];
        this.q[8] = this.rest[8];
        this.dq.fill(0);
        this.ddq.fill(0);
        this.time = 0;
        this.driverTime = 0;
        for (const m of this.motors) m.reset();
        this.updateKinematics();
    }

    // Sets the state in DART's coordinates: q = [rotation vector, position, 4 joint angles],
    // dq = [body twist w, v, 4 joint rates]
    setDartState(q, dq) {
        expRot([q[0], q[1], q[2]], this.R);
        this.p[0] = q[3]; this.p[1] = q[4]; this.p[2] = q[5];
        for (let i = 6; i < ND; i++) this.q[i] = q[i];
        for (let i = 0; i < ND; i++) this.dq[i] = dq[i];
        this.updateKinematics();
    }

    getDartState() {
        const rv = logRot(this.R);
        return {
            q: [rv[0], rv[1], rv[2], this.p[0], this.p[1], this.p[2], this.q[6], this.q[7], this.q[8], this.q[9]],
            dq: Array.from(this.dq)
        };
    }

    // Relative joint transforms and world poses of all five bodies
    updateKinematics() {
        this.bodyRw[0].set(this.R);
        this.bodyPw[0].set(this.p);
        for (let i = 1; i < NB; i++) {
            const E = this.bodyE[i];
            axisRot(this.axis[i], this.q[5 + i], this._9a);
            matMul(this.jointE[i], this._9a, E);
            motionTransform(E, this.jointR[i], this.X[i]);
            const pa = this.parent[i];
            matMul(this.bodyRw[pa], E, this.bodyRw[i]);
            matVec(this.bodyRw[pa], this.jointR[i], this._3a);
            const pw = this.bodyPw[i], pp = this.bodyPw[pa];
            pw[0] = pp[0] + this._3a[0]; pw[1] = pp[1] + this._3a[1]; pw[2] = pp[2] + this._3a[2];
        }
    }

    // Torso COM: world position, world velocity, and the body-axes twist at the COM that the
    // wing model reads (DART's com_spatial_velocity)
    comPosition(out = new Float64Array(3)) {
        matVec(this.R, this.localCom[0], out);
        out[0] += this.p[0]; out[1] += this.p[1]; out[2] += this.p[2];
        return out;
    }

    comVelocity(out = new Float64Array(3)) {
        const w = this.dq, c = this.localCom[0];
        const v = this._3b;
        v[0] = w[3] + w[1] * c[2] - w[2] * c[1];
        v[1] = w[4] + w[2] * c[0] - w[0] * c[2];
        v[2] = w[5] + w[0] * c[1] - w[1] * c[0];
        return matVec(this.R, v, out);
    }

    comSpatialVelocity(out = new Float64Array(6)) {
        const w = this.dq, c = this.localCom[0];
        out[0] = w[0]; out[1] = w[1]; out[2] = w[2];
        out[3] = w[3] + w[1] * c[2] - w[2] * c[1];
        out[4] = w[4] + w[2] * c[0] - w[0] * c[2];
        out[5] = w[5] + w[0] * c[1] - w[1] * c[0];
        return out;
    }

    // Roll, pitch, yaw (z-y-x) of the torso, as flappy reports body_positions[0:3]
    euler(out = new Float64Array(3)) {
        const R = this.R;
        out[0] = Math.atan2(R[7], R[8]);
        out[1] = Math.asin(Math.max(-1, Math.min(1, -R[6])));
        out[2] = Math.atan2(R[3], R[0]);
        return out;
    }

    // Composite-rigid-body mass matrix into this.M
    massMatrix() {
        const M = this.M;
        M.fill(0);
        for (let i = 0; i < NB; i++) this.Ic[i].set(this.G[i]);
        for (let i = NB - 1; i >= 1; i--) addCongruence(this.X[i], this.Ic[i], this.Ic[this.parent[i]], this._36);
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) M[i * ND + j] = this.Ic[0][i * 6 + j];
        const F = this._6a, Fp = this._6b;
        for (let i = NB - 1; i >= 1; i--) {
            const a = this.axis[i], Ic = this.Ic[i], di = 5 + i;
            for (let k = 0; k < 6; k++) F[k] = Ic[k * 6] * a[0] + Ic[k * 6 + 1] * a[1] + Ic[k * 6 + 2] * a[2];
            M[di * ND + di] = a[0] * F[0] + a[1] * F[1] + a[2] * F[2];
            let j = i;
            while (true) {
                mat6TVec(this.X[j], F, Fp);
                F.set(Fp);
                j = this.parent[j];
                if (j === 0) {
                    for (let k = 0; k < 6; k++) { M[k * ND + di] = F[k]; M[di * ND + k] = F[k]; }
                    break;
                }
                const aj = this.axis[j], dj = 5 + j;
                const v = aj[0] * F[0] + aj[1] * F[1] + aj[2] * F[2];
                M[dj * ND + di] = v; M[di * ND + dj] = v;
            }
        }
        return M;
    }

    // Recursive Newton-Euler with zero joint accelerations: Coriolis, centrifugal and gravity
    // forces minus the external (wing) loads, into this.bias
    biasForces(withExternal = true) {
        const V = this.V, A = this.A, F = this.F, dq = this.dq;
        for (let k = 0; k < 6; k++) V[0][k] = dq[k];
        // gravity as an upward acceleration of the base
        A[0][0] = 0; A[0][1] = 0; A[0][2] = 0;
        const g = this._3a;
        g[0] = -this.gravity[0]; g[1] = -this.gravity[1]; g[2] = -this.gravity[2];
        matTVec(this.R, g, this._3b);
        A[0][3] = this._3b[0]; A[0][4] = this._3b[1]; A[0][5] = this._3b[2];
        for (let i = 1; i < NB; i++) {
            const pa = this.parent[i], a = this.axis[i], qd = dq[5 + i];
            mat6Vec(this.X[i], V[pa], V[i]);
            V[i][0] += a[0] * qd; V[i][1] += a[1] * qd; V[i][2] += a[2] * qd;
            mat6Vec(this.X[i], A[pa], A[i]);
            // V x (S qd), S = [a; 0]
            const sx = a[0] * qd, sy = a[1] * qd, sz = a[2] * qd, Vi = V[i];
            A[i][0] += Vi[1] * sz - Vi[2] * sy;
            A[i][1] += Vi[2] * sx - Vi[0] * sz;
            A[i][2] += Vi[0] * sy - Vi[1] * sx;
            A[i][3] += Vi[4] * sz - Vi[5] * sy;
            A[i][4] += Vi[5] * sx - Vi[3] * sz;
            A[i][5] += Vi[3] * sy - Vi[4] * sx;
        }
        const h = this._6a;
        for (let i = 0; i < NB; i++) {
            const Fi = F[i], Vi = V[i];
            mat6Vec(this.G[i], A[i], Fi);
            mat6Vec(this.G[i], Vi, h);
            // V x* h = [w x h_ang + v x h_lin; w x h_lin]
            Fi[0] += Vi[1] * h[2] - Vi[2] * h[1] + Vi[4] * h[5] - Vi[5] * h[4];
            Fi[1] += Vi[2] * h[0] - Vi[0] * h[2] + Vi[5] * h[3] - Vi[3] * h[5];
            Fi[2] += Vi[0] * h[1] - Vi[1] * h[0] + Vi[3] * h[4] - Vi[4] * h[3];
            Fi[3] += Vi[1] * h[5] - Vi[2] * h[4];
            Fi[4] += Vi[2] * h[3] - Vi[0] * h[5];
            Fi[5] += Vi[0] * h[4] - Vi[1] * h[3];
            if (withExternal) for (let k = 0; k < 6; k++) Fi[k] -= this.Fext[i][k];
        }
        const bias = this.bias, Fp = this._6b;
        for (let i = NB - 1; i >= 1; i--) {
            const a = this.axis[i], Fi = F[i];
            bias[5 + i] = a[0] * Fi[0] + a[1] * Fi[1] + a[2] * Fi[2];
            mat6TVec(this.X[i], Fi, Fp);
            const Fpa = F[this.parent[i]];
            for (let k = 0; k < 6; k++) Fpa[k] += Fp[k];
        }
        for (let k = 0; k < 6; k++) bias[k] = F[0][k];
        return bias;
    }

    // Cholesky factor of a 10x10 SPD matrix into this.L (lower)
    factor(A) {
        const L = this.L;
        for (let i = 0; i < ND; i++) {
            for (let j = 0; j <= i; j++) {
                let s = A[i * ND + j];
                for (let k = 0; k < j; k++) s -= L[i * ND + k] * L[j * ND + k];
                L[i * ND + j] = i === j ? Math.sqrt(s) : s / L[j * ND + j];
            }
        }
    }

    solve(b, x) { // with the factor in this.L
        const L = this.L;
        for (let i = 0; i < ND; i++) {
            let s = b[i];
            for (let k = 0; k < i; k++) s -= L[i * ND + k] * x[k];
            x[i] = s / L[i * ND + i];
        }
        for (let i = ND - 1; i >= 0; i--) {
            let s = x[i];
            for (let k = i + 1; k < ND; k++) s -= L[k * ND + i] * x[k];
            x[i] = s / L[i * ND + i];
        }
        return x;
    }

    // Wing loads for this step, as body-frame wrenches on the two wing bodies
    applyWingLoads() {
        const Vc = this.comSpatialVelocity(this._6a);
        for (let k = 0; k < 2; k++) {
            const wing = this.wings[k];
            const s = k === 0 ? 6 : 8; // stroke dof; the rotate dof follows it
            wing.update(Vc[0], Vc[1], Vc[2], Vc[3], Vc[4], Vc[5], this.q[s], this.dq[s], this.q[s + 1], this.dq[s + 1]);
            // normal force along the wing's x axis, at the centre of pressure; rotational damping about y
            const f = wing.normalForce;
            const oy = k === 0 ? wing.spanCoP : -wing.spanCoP;
            const oz = -wing.chordCoP;
            const Fe = this.Fext[k === 0 ? 2 : 4];
            // offset x force = (0, oy, oz) x (f, 0, 0) = (0, oz f, -oy f)
            Fe[0] = 0;
            Fe[1] = oz * f + wing.rotationalDamping;
            Fe[2] = -oy * f;
            Fe[3] = f; Fe[4] = 0; Fe[5] = 0;
        }
    }

    // One 10 kHz step with the two motor voltages held: FWMAV.step followed by DART's World::step
    step(voltageLeft, voltageRight) {
        const h = this.dt;
        this.applyWingLoads();

        // the drivers latch a new voltage at 1 kHz
        if (this.time >= this.driverTime) {
            this.driverTime += this.dtDriver;
            this.motors[0].voltage = voltageLeft;
            this.motors[1].voltage = voltageRight;
        }
        const tau = this.tau;
        tau.fill(0);
        tau[6] = this.motors[0].update(this.dq[6], this.ddq[6]);
        tau[8] = this.motors[1].update(this.dq[8], this.ddq[8]);

        // forward dynamics, springs and damping implicit as in DART
        const M = this.massMatrix();
        const bias = this.biasForces();
        const Mi = this.Mimp;
        Mi.set(M);
        const rhs = this.rhs;
        for (let d = 0; d < ND; d++) {
            let f = tau[d] - bias[d];
            if (d >= 6) {
                const k = this.spring[d], c = this.damping[d];
                f += -k * (this.q[d] + this.dq[d] * h - this.rest[d]) - c * this.dq[d];
                Mi[d * ND + d] += h * c + h * h * k;
            }
            rhs[d] = f;
        }
        this.factor(Mi);
        this.solve(rhs, this.ddq);
        for (let d = 0; d < ND; d++) this.dq[d] += h * this.ddq[d];

        this.applyJointConstraints(M);

        // positions: DART's FreeJoint moves by T(R) * [exp(w h), v h]
        const step = this._3b;
        step[0] = this.dq[3] * h; step[1] = this.dq[4] * h; step[2] = this.dq[5] * h;
        matVec(this.R, step, this._3a);
        this.p[0] += this._3a[0]; this.p[1] += this._3a[1]; this.p[2] += this._3a[2];
        step[0] = this.dq[0] * h; step[1] = this.dq[1] * h; step[2] = this.dq[2] * h;
        expRot(step, this._9a);
        matMul(this.R, this._9a, this._9b);
        this.R.set(this._9b);
        for (let d = 6; d < ND; d++) this.q[d] += h * this.dq[d];

        this.time += h;
        this.updateKinematics();
    }

    // DART's joint constraints, as velocity impulses after the velocity update:
    // * Coulomb friction in every joint (the URDF's tiny `friction`): an impulse of at most
    //   friction * dt, trying to stop the joint. It is always saturated at flapping speeds, and small,
    //   but it is felt - left out, the wing's acceleration is 1.8 rad/s^2 off on every step.
    // * Joint limits: once a joint is at or past a limit (judged on the position before this step's
    //   move), an impulse that only ever pushes back stops it dead - an inelastic stop with no
    //   push back out. Measured against DART: a push-back of even 1e-3 rad/s puts the wing's
    //   acceleration 10 rad/s^2 off on every hit.
    // Both act on the same four joints and couple through the mass matrix, so they are solved together,
    // one impulse per joint with the combined bounds. The velocity change is added to the
    // accelerations too, as DART does, since the motor model reads them next step.
    applyJointConstraints(M) {
        const h = this.dt;
        const lo = this._lo || (this._lo = new Float64Array(4));
        const hi = this._hi || (this._hi = new Float64Array(4));
        let any = false;
        for (let a = 0; a < 4; a++) {
            const d = 6 + a, q = this.q[d], mu = this.friction[d] * h;
            lo[a] = -mu;
            hi[a] = mu;
            if (q <= this.lower[d]) hi[a] = Infinity;
            else if (q >= this.upper[d]) lo[a] = -Infinity;
            if (lo[a] !== 0 || hi[a] !== 0) any = true;
        }
        if (!any) return;

        // columns of M^-1 for the four joints
        this.factor(M);
        const cols = this._cols || (this._cols = Array.from({ length: 4 }, () => new Float64Array(ND)));
        const e = this._e || (this._e = new Float64Array(ND));
        for (let a = 0; a < 4; a++) {
            e.fill(0);
            e[6 + a] = 1;
            this.solve(e, cols[a]);
        }
        // projected Gauss-Seidel on the 4x4 box LCP, driving each joint's velocity to zero within
        // its impulse bounds
        const lam = this._lam || (this._lam = new Float64Array(4));
        lam.fill(0);
        for (let it = 0; it < 30; it++) {
            for (let a = 0; a < 4; a++) {
                const d = 6 + a;
                let v = this.dq[d];
                for (let b = 0; b < 4; b++) v += cols[b][d] * lam[b];
                const l = lam[a] - v / cols[a][d];
                lam[a] = l < lo[a] ? lo[a] : l > hi[a] ? hi[a] : l;
            }
        }
        for (let a = 0; a < 4; a++) {
            if (lam[a] === 0) continue;
            for (let d = 0; d < ND; d++) {
                const dv = cols[a][d] * lam[a];
                this.dq[d] += dv;
                this.ddq[d] += dv / h;
            }
        }
    }
}
