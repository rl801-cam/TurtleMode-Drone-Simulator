// latency.js - Artificial video-link delay
//
// Holds a short history of drone poses and hands back where the airframe was a set time ago, so
// the picture in the goggles trails reality the way it does over a real video link. Analog runs
// about 20-30 ms glass to glass, HDZero nearer 15, DJI 30-40, and a struggling digital link can
// push past 100 - which is exactly where flying gates stops working.
//
// Only the *view* is delayed. The physics runs live: the drone really is where the solver says it
// is, you just find out late. That is the whole point - you crash into things that were already
// there. Control inputs are not delayed here either; the sticks reach the flight controller at
// once, as they do on a real quad.
//
// In Line of Sight there is no video link at all - the pilot is watching the actual drone with
// their own eyes - so main.js applies this only in FPV.

export class VideoDelay {
    constructor() {
        this.latency = 0; // seconds
        this.maxLatency = 0.3; // seconds; also bounds how much history is kept
        this.frames = [];

        // sample() writes into this rather than allocating a pose every rendered frame. Callers
        // must copy the values out (the renderer does) and never hold on to the object.
        this._out = {
            position: { x: 0, y: 0, z: 0 },
            quaternion: { x: 0, y: 0, z: 0, w: 1 }
        };
    }

    setLatency(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) {
            this.latency = 0;
            return;
        }
        this.latency = Math.min(seconds, this.maxLatency);
    }

    // Called on reset, so the view snaps to the new spawn instead of replaying the flight that
    // was still in the pipe when the drone was teleported
    clear() {
        this.frames.length = 0;
    }

    // `state` is the physics body's own position/quaternion, mutated in place every sub-step, so
    // the components are copied out rather than held by reference - keeping the object would make
    // every stored frame the current one and the delay would silently do nothing.
    push(state, time) {
        if (!state || !state.position || !state.quaternion || !Number.isFinite(time)) return;

        const p = state.position;
        const q = state.quaternion;
        this.frames.push({
            time,
            px: p.x, py: p.y, pz: p.z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w
        });

        // Discard history older than the longest delay that could ever be asked for, but keep one
        // frame from before the window so there is always something to interpolate from.
        const cutoff = time - this.maxLatency;
        let drop = 0;
        while (drop + 1 < this.frames.length && this.frames[drop + 1].time <= cutoff) drop++;
        if (drop > 0) this.frames.splice(0, drop);
    }

    _emit(f) {
        const out = this._out;
        out.position.x = f.px; out.position.y = f.py; out.position.z = f.pz;
        out.quaternion.x = f.qx; out.quaternion.y = f.qy;
        out.quaternion.z = f.qz; out.quaternion.w = f.qw;
        return out;
    }

    // Where the drone was `latency` seconds ago. Null only if nothing has been pushed.
    sample(time) {
        const n = this.frames.length;
        if (n === 0) return null;
        if (this.latency <= 0) return this._emit(this.frames[n - 1]);

        const target = time - this.latency;

        // Not enough history yet - just after a reset, or straight after the slider is raised
        if (target <= this.frames[0].time) return this._emit(this.frames[0]);

        for (let i = n - 1; i > 0; i--) {
            const after = this.frames[i];
            const before = this.frames[i - 1];
            if (before.time <= target && target <= after.time) {
                const span = after.time - before.time;
                const t = span > 0 ? (target - before.time) / span : 0;
                const out = this._out;

                // Straight lerp on position: at frame spacing the path between two poses is
                // indistinguishable from a line, and stepping to the nearest stored frame instead
                // would make the picture stutter at a beat against the render rate.
                out.position.x = before.px + (after.px - before.px) * t;
                out.position.y = before.py + (after.py - before.py) * t;
                out.position.z = before.pz + (after.pz - before.pz) * t;

                this._slerp(before, after, t);
                return out;
            }
        }

        return this._emit(this.frames[n - 1]);
    }

    // Rotations do not lerp: componentwise blending of two quaternions leaves an unnormalised one,
    // which shears the whole picture. Interpolate along the arc instead.
    _slerp(before, after, t) {
        let ax = before.qx, ay = before.qy, az = before.qz, aw = before.qw;
        const bx = after.qx, by = after.qy, bz = after.qz, bw = after.qw;

        let dot = ax * bx + ay * by + az * bz + aw * bw;

        // q and -q are the same rotation. Without this the interpolation takes the long way round
        // and the view whips through a full turn on the wrong side.
        if (dot < 0) {
            ax = -ax; ay = -ay; az = -az; aw = -aw;
            dot = -dot;
        }

        let s0, s1;
        if (dot > 0.9995) {
            // Nearly parallel - the arc is numerically flat, so slerp's sines go to zero over zero
            s0 = 1 - t;
            s1 = t;
        } else {
            const theta = Math.acos(dot);
            const sin = Math.sin(theta);
            s0 = Math.sin((1 - t) * theta) / sin;
            s1 = Math.sin(t * theta) / sin;
        }

        let x = s0 * ax + s1 * bx;
        let y = s0 * ay + s1 * by;
        let z = s0 * az + s1 * bz;
        let w = s0 * aw + s1 * bw;

        const len = Math.hypot(x, y, z, w);
        if (len > 0) {
            x /= len; y /= len; z /= len; w /= len;
        } else {
            x = 0; y = 0; z = 0; w = 1;
        }

        const q = this._out.quaternion;
        q.x = x; q.y = y; q.z = z; q.w = w;
    }
}
