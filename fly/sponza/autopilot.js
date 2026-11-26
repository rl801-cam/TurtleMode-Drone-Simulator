// Autopilot for demo recordings (?mode=autolap): flies the time-trial line through the real
// physics, by stick commands only - the same inputs a pilot gives - so the recording shows what
// the course and the whoop actually do.
// - The line is the course's flown line (via points, lead-in, gate, lead-out) as a closed
//   centripetal Catmull-Rom curve, sampled every 2 cm with a speed profile: capped by a
//   lateral-acceleration limit through bends, then smoothed so braking and speeding up stay
//   within limits.
// - Position and velocity errors against the line give a wanted acceleration; adding gravity
//   gives the thrust vector, which sets the wanted attitude (thrust axis) and the throttle (the
//   inverse of the physics' thrust curve and prop inflow loss). The nose points along the line.
// - Attitude error becomes body rates, and those become stick positions through the inverse of
//   the physics' Betaflight-style rate curve.
import * as THREE from 'three/webgpu';
import { linePoints } from './track.js';

const G = 9.81;

export class Autopilot {
    constructor({ physics, gates, normalOf, vmax = 3.6, alat = 7, along = 4 }) {
        this.physics = physics;
        const pts = linePoints(gates, THREE.Vector3, normalOf);
        const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
        const L = curve.getLength(), N = Math.ceil(L / 0.02);
        this.N = N; this.ds = L / N;
        this.p = []; this.t = [];
        for (let i = 0; i < N; i++) { this.p.push(curve.getPointAt(i / N)); this.t.push(curve.getTangentAt(i / N)); }
        // Curvature from the turn of the tangent over +-10 cm, then the speed it allows.
        const v = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const a = this.t[(i - 5 + N) % N], b = this.t[(i + 5) % N];
            const k = a.angleTo(b) / (10 * this.ds);
            v[i] = Math.min(vmax, Math.sqrt(alat / Math.max(k, 1e-3)));
        }
        // Speed changes within `along` m/s^2 (two passes round the closed loop each way).
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < 2 * N; i++) { const j = i % N, pj = (j - 1 + N) % N; v[j] = Math.min(v[j], Math.sqrt(v[pj] ** 2 + 2 * along * this.ds)); }
            for (let i = 2 * N; i > 0; i--) { const j = i % N, nj = (j + 1) % N; v[j] = Math.min(v[j], Math.sqrt(v[nj] ** 2 + 2 * along * this.ds)); }
        }
        this.v = v;
        this.i = -1;
        this._q = new THREE.Quaternion(); this._qd = new THREE.Quaternion(); this._m = new THREE.Matrix4();
    }

    // Closest sample, searching forward from the last one (the whole loop the first time).
    _track(pos) {
        let best = Infinity, bi = 0;
        const from = this.i < 0 ? 0 : this.i - 20, to = this.i < 0 ? this.N : this.i + 150;
        for (let k = from; k < to; k++) { const j = (k + this.N) % this.N, d = this.p[j].distanceToSquared(pos); if (d < best) { best = d; bi = j; } }
        this.i = bi;
        return bi;
    }

    // Inverse of the physics' rate curve: the stick that commands `rate` rad/s.
    _stick(rate, rp) {
        const f = (rc) => { const e = rc * (1 - rp.expo) + rc ** 3 * rp.expo; return (rp.center * e) / (1 - Math.abs(rc) * (1 - rp.center / rp.max)) * Math.PI / 180; };
        const target = Math.max(-f(1) * 0.98, Math.min(f(1) * 0.98, rate));
        let lo = -1, hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (f(m) < target) lo = m; else hi = m; }
        return (lo + hi) / 2;
    }

    // Stick axes for this frame.
    update(dt) {
        const ph = this.physics, b = ph.droneBody, P = ph.params;
        const pos = new THREE.Vector3(b.position.x, b.position.y, b.position.z), vel = new THREE.Vector3(b.velocity.x, b.velocity.y, b.velocity.z);
        const i = this._track(pos), N = this.N;
        const look = (m) => (i + Math.round(m / this.ds) + N) % N;
        // Reference a little ahead of the closest point (it covers the control lag).
        const ir = look(0.12 + vel.length() * 0.06);
        const pr = this.p[ir], tr = this.t[ir], vr = this.v[ir];
        const ia = look(Math.max(0.15, vr * 0.15));
        const vWant = tr.clone().multiplyScalar(vr), vAhead = this.t[ia].clone().multiplyScalar(this.v[ia]);
        const aff = vAhead.sub(vWant).divideScalar(Math.max(0.05, (Math.max(0.15, vr * 0.15)) / Math.max(vr, 0.5)));
        const ep = pr.clone().sub(pos), ev = vWant.clone().sub(vel);
        const acc = aff.addScaledVector(ep, 9).addScaledVector(ev, 4.5);
        // Air drag, roughly: the props have to push against it too.
        acc.addScaledVector(vel, 0.9);
        if (acc.length() > 14) acc.setLength(14);
        const F = acc.clone().add(new THREE.Vector3(0, G, 0));
        // Lean limit 55 deg.
        const maxLean = 55 * Math.PI / 180, hz = Math.hypot(F.x, F.z);
        if (Math.atan2(hz, F.y) > maxLean) { const s = Math.tan(maxLean) * Math.max(F.y, 2) / hz; F.x *= s; F.z *= s; F.y = Math.max(F.y, 2); }
        const up = F.clone().normalize();
        // Nose along the line, a little ahead.
        const h = this.t[look(0.5)].clone(); h.y = 0; if (h.lengthSq() < 1e-6) h.set(1, 0, 0); h.normalize();
        const fwd = h.addScaledVector(up, -h.dot(up)).normalize();
        const Z = fwd.clone().negate(), X = new THREE.Vector3().crossVectors(up, Z).normalize();
        this._qd.setFromRotationMatrix(this._m.makeBasis(X, up, Z));
        this._q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        // Attitude error in body axes -> wanted body rates.
        const qe = this._q.clone().invert().multiply(this._qd);
        if (qe.w < 0) { qe.x = -qe.x; qe.y = -qe.y; qe.z = -qe.z; qe.w = -qe.w; }
        const K = 14, w = { x: 2 * qe.x * K, y: 2 * qe.y * K * 0.6, z: 2 * qe.z * K };
        // Throttle: thrust along the actual body up axis, allowing for prop inflow.
        const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this._q);
        const need = ph.params.mass * F.dot(bodyUp) / Math.max(0.35, up.dot(bodyUp));
        const inflow = Math.max(0, vel.dot(bodyUp)), c = P.thrustCurve;
        let f = Math.max(0, need / P.maxThrust);
        for (let k = 0; k < 4; k++) { const rpm = Math.sqrt(Math.max(f, 1e-3)); const loss = Math.max(0.2, 1 - inflow / (P.propPitchSpeed * rpm)); f = Math.max(0, need / P.maxThrust / loss); }
        f = Math.min(1, f);
        const throttle = c > 1e-6 ? (-(1 - c) + Math.sqrt((1 - c) ** 2 + 4 * c * f)) / (2 * c) : f;
        const R = P.rates;
        return {
            throttle: Math.min(1, Math.max(0, throttle)),
            pitch: this._stick(w.x, R.pitch),
            yaw: -this._stick(w.y, R.yaw),
            roll: -this._stick(w.z, R.roll),
            err: ep.length(),
        };
    }
}
