// latency.js - Artificial control-link delay
//
// Holds a short history of stick positions and hands back what the pilot was commanding a set
// time ago, so the drone reacts late the way it does over a real radio link. A typical FPV link
// runs about 20-40 ms end to end; more than that is what a congested or long-range link feels
// like, and flying it is a genuinely different skill.
//
// Only the commands that reach the flight model are delayed. The stick visualiser in the launch
// menu deliberately still shows live input, because it exists to verify the transmitter.

export class ControlDelay {
    constructor() {
        this.latency = 0; // seconds
        this.maxLatency = 0.3; // seconds; also bounds how much history is kept
        this.samples = [];
    }

    setLatency(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) {
            this.latency = 0;
            return;
        }
        this.latency = Math.min(seconds, this.maxLatency);
    }

    // Called on reset, so queued commands from before the teleport cannot still arrive
    clear() {
        this.samples.length = 0;
    }

    // `axes` is reused and mutated by InputHandler, so the values are copied out rather than held
    // by reference - keeping the object would make every stored sample the current one.
    push(axes, armed, time) {
        if (!axes || !Number.isFinite(time)) return;

        this.samples.push({
            time,
            armed: !!armed,
            throttle: axes.throttle,
            yaw: axes.yaw,
            pitch: axes.pitch,
            roll: axes.roll
        });

        // Discard history older than the longest delay that could ever be asked for, but keep one
        // sample from before the window so there is always something to interpolate from.
        const cutoff = time - this.maxLatency;
        let drop = 0;
        while (drop + 1 < this.samples.length && this.samples[drop + 1].time <= cutoff) drop++;
        if (drop > 0) this.samples.splice(0, drop);
    }

    toCommand(sample) {
        return {
            axes: {
                throttle: sample.throttle,
                yaw: sample.yaw,
                pitch: sample.pitch,
                roll: sample.roll
            },
            armed: sample.armed
        };
    }

    // What the pilot was commanding `latency` seconds ago. Null only if nothing has been pushed.
    sample(time) {
        const n = this.samples.length;
        if (n === 0) return null;
        if (this.latency <= 0) return this.toCommand(this.samples[n - 1]);

        const target = time - this.latency;

        // Not enough history yet - just after a reset, or straight after the slider is raised
        if (target <= this.samples[0].time) return this.toCommand(this.samples[0]);

        for (let i = n - 1; i > 0; i--) {
            const after = this.samples[i];
            const before = this.samples[i - 1];
            if (before.time <= target && target <= after.time) {
                const span = after.time - before.time;
                const t = span > 0 ? (target - before.time) / span : 0;
                const lerp = (a, b) => a + (b - a) * t;
                return {
                    // Interpolated, so the delayed sticks stay smooth instead of stepping from
                    // one rendered frame to the next
                    axes: {
                        throttle: lerp(before.throttle, after.throttle),
                        yaw: lerp(before.yaw, after.yaw),
                        pitch: lerp(before.pitch, after.pitch),
                        roll: lerp(before.roll, after.roll)
                    },
                    // A switch is not a continuous signal - it flips at an instant. Blending would
                    // invent a half-armed state, so take whichever position was actually live.
                    armed: before.armed
                };
            }
        }

        return this.toCommand(this.samples[n - 1]);
    }
}
