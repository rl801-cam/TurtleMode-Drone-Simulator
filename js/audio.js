// audio.js - Motor tone synthesis
//
// A single sine oscillator whose pitch and loudness both track the drone's thrust. Real motor
// noise is a stack of harmonics, but a clean sine is enough to fly by ear: the pitch tells you
// where the throttle is without looking at the OSD.

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.osc = null;
        this.gain = null;
        this.enabled = true;

        // Roughly the span a real quad's whine covers between idle and full throttle
        this.minFrequency = 80; // Hz at zero thrust
        this.maxFrequency = 450; // Hz at full thrust

        // A pure sine turns harsh long before it gets loud, so leave plenty of headroom
        this.maxGain = 0.12;

        // Exponential smoothing time constant. Stick input arrives in discrete frames, and
        // stepping the parameters straight to their new values clicks audibly.
        this.smoothing = 0.05; // seconds
    }

    // Must be called from a user gesture (the Start button). Browsers create the context in a
    // suspended state otherwise, and nothing is ever heard.
    start() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return; // no Web Audio support: the sim just stays silent
            this.ctx = new Ctx();

            this.gain = this.ctx.createGain();
            this.gain.gain.value = 0;
            this.gain.connect(this.ctx.destination);

            this.osc = this.ctx.createOscillator();
            this.osc.type = 'sine';
            this.osc.frequency.value = this.minFrequency;
            this.osc.connect(this.gain);

            // The oscillator runs for the lifetime of the page; gain alone decides audibility.
            // Oscillators cannot be restarted once stopped, so it is never stopped.
            this.osc.start();
        }

        if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) this.silence();
    }

    // Normalised thrust, 0..1. Thrust is throttle * maxThrust, so the normalised value is just
    // the throttle command. Disarmed motors are not turning, so they make no sound.
    level(thrust, armed) {
        if (!armed) return 0;
        if (!Number.isFinite(thrust)) return 0;
        return Math.max(0, Math.min(1, thrust));
    }

    frequencyFor(level) {
        return this.minFrequency + (this.maxFrequency - this.minFrequency) * level;
    }

    gainFor(level) {
        return this.maxGain * level;
    }

    update(thrust, armed) {
        if (!this.ctx || !this.enabled) return;

        const level = this.level(thrust, armed);
        const now = this.ctx.currentTime;

        this.osc.frequency.setTargetAtTime(this.frequencyFor(level), now, this.smoothing);
        this.gain.gain.setTargetAtTime(this.gainFor(level), now, this.smoothing);
    }

    // Fade out without touching the oscillator, so it can come straight back on resume
    silence() {
        if (!this.ctx) return;
        this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, this.smoothing);
    }
}
