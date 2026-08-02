// audio.js - Motor and prop noise synthesis
//
// A quad is mostly *noise*, and that noise is not steady: each blade passing the airframe fires a
// pulse of air, so the sound is chopped at blade-passage rate. That chopping is what separates
// "blades cutting air" from "a synth pad and some hiss", and it is the core of this engine.
//
// Four layers, all driven by the stick inputs:
//
//   1. Chopped broadband noise. Bandpassed air noise, amplitude-modulated at the blade rate by a
//      pair of slightly detuned modulators. The modulation is deep, which throws ring-mod
//      sidebands either side of the blade tone - the hard, angry edge of a small prop.
//   2. Blade harmonics. Oscillators on a custom periodic wave weighted toward the blade-pass
//      harmonic and its multiples, where a real prop puts its energy.
//   3. Four independent motors. Each runs its own RPM through a quad mixer, so rolling, pitching
//      or yawing spreads the motors apart and the sound audibly works - exactly as a real quad
//      wavers through a manoeuvre. At a steady hover a small fixed spread keeps them beating.
//   4. Brightness tracking RPM, via a lowpass that opens with throttle.
//
// Everything is synthesised, so there are no samples to load.

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.enabled = true;

        this.motors = [];
        this.choppers = [];
        this.toneGain = null;
        this.toneFilter = null;
        this.chopGain = null;
        this.noiseGain = null;
        this.noiseFilter = null;
        this.master = null;

        // Prop *rotation* rate. The audible pitch sits on the blade-pass harmonics above this.
        this.minFrequency = 55; // Hz at zero thrust
        this.maxFrequency = 260; // Hz at full thrust
        this.bladeCount = 3;

        // Fixed per-motor spread, so the motors still beat against each other at a steady hover.
        // Manoeuvres add far more than this on top.
        this.motorDetune = [1, 1.006, 0.994, 1.011];

        // How hard the control mixer pushes the motors apart. Audio only - this mirrors the shape
        // of a real mixer to get the character right, it is not the flight model.
        this.mixerAuthority = 0.35;

        // Noise carries the sound; the tone sits underneath it. Four oscillators sum into the
        // tone gain, so that ceiling is per-motor.
        this.maxToneGain = 0.028;
        this.maxNoiseGain = 0.16;

        // Depth of the blade chop. 0.5 swings the noise between silence and full.
        this.chopDepth = 0.5;

        // Exponential smoothing time constant. Stick input arrives in discrete frames, and
        // stepping the parameters straight to their new values clicks audibly.
        this.smoothing = 0.05; // seconds
    }

    // Relative strength of each harmonic of the rotation rate. Index 0 is DC and must stay zero.
    // The peak at the third harmonic is the blade-pass tone of a three-blade prop; the smaller
    // peaks at 6 and 9 are its multiples. The long tail keeps it buzzy rather than flute-like.
    bladeHarmonics() {
        return [0, 0.2, 0.35, 1.0, 0.5, 0.4, 0.65, 0.3, 0.25, 0.4, 0.22, 0.18, 0.3, 0.15, 0.12, 0.2];
    }

    // Must be called from a user gesture (the Start button). Browsers create the context in a
    // suspended state otherwise, and nothing is ever heard.
    start() {
        if (!this.ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return; // no Web Audio support: the sim just stays silent
            this.ctx = new Ctx();

            this.master = this.ctx.createGain();
            this.master.gain.value = 1;
            this.master.connect(this.ctx.destination);

            this.buildTone();
            this.buildNoise();
        }

        if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    buildTone() {
        // Brightness rises with RPM, so the stack runs through a lowpass that opens with throttle
        this.toneFilter = this.ctx.createBiquadFilter();
        this.toneFilter.type = 'lowpass';
        this.toneFilter.frequency.value = this.brightnessFor(0);
        this.toneFilter.connect(this.master);

        this.toneGain = this.ctx.createGain();
        this.toneGain.gain.value = 0;
        this.toneGain.connect(this.toneFilter);

        const harmonics = this.bladeHarmonics();
        const real = new Float32Array(harmonics.length);
        const imag = new Float32Array(harmonics);
        const wave = this.ctx.createPeriodicWave(real, imag);

        for (let i = 0; i < this.motorDetune.length; i++) {
            const osc = this.ctx.createOscillator();
            osc.setPeriodicWave(wave);
            osc.frequency.value = this.minFrequency * this.motorDetune[i];
            osc.connect(this.toneGain);
            // Oscillators cannot be restarted once stopped, so these run for the lifetime of the
            // page and the gain nodes decide what is audible.
            osc.start();
            this.motors.push(osc);
        }
    }

    buildNoise() {
        // Two seconds of white noise on a loop is far past the point the repeat is audible
        const frames = Math.floor(this.ctx.sampleRate * 2);
        const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

        this.noiseGain = this.ctx.createGain();
        this.noiseGain.gain.value = 0;
        this.noiseGain.connect(this.master);

        // The blade chop. Modulator output is *added* to this gain, so the resting value sits one
        // depth below unity and the modulators swing it up to full and back down.
        this.chopGain = this.ctx.createGain();
        this.chopGain.gain.value = 1 - this.chopDepth;
        this.chopGain.connect(this.noiseGain);

        this.noiseFilter = this.ctx.createBiquadFilter();
        this.noiseFilter.type = 'bandpass';
        this.noiseFilter.frequency.value = this.noiseBandFor(0);
        this.noiseFilter.Q.value = 0.7;
        this.noiseFilter.connect(this.chopGain);

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(this.noiseFilter);
        source.start();
        this.noiseSource = source;

        // Two modulators a hair apart, so the chop itself drifts in and out of phase instead of
        // sitting at one rigid rate
        const bladeRate = this.bladeRateFor(0);
        for (const ratio of [1, 1.008]) {
            const mod = this.ctx.createOscillator();
            mod.type = 'sine';
            mod.frequency.value = bladeRate * ratio;

            const depth = this.ctx.createGain();
            depth.gain.value = this.chopDepth / 2; // the pair sums to one full depth
            mod.connect(depth);
            depth.connect(this.chopGain.gain);
            mod.start();

            this.choppers.push(mod);
        }
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

    // Per-motor throttle for a quad X layout. Used only to shape the sound: what matters is that
    // the motors diverge in the same way a real mixer diverges them, so manoeuvres are audible.
    motorLevels(axes, armed) {
        const clean = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
        const base = this.level(axes ? axes.throttle : 0, armed);
        if (base <= 0) return [0, 0, 0, 0];

        const roll = clean(axes.roll) * this.mixerAuthority;
        const pitch = clean(axes.pitch) * this.mixerAuthority;
        const yaw = clean(axes.yaw) * this.mixerAuthority;

        return [
            base + pitch + roll - yaw, // front left
            base + pitch - roll + yaw, // front right
            base - pitch + roll + yaw, // rear left
            base - pitch - roll - yaw // rear right
        ].map((v) => Math.max(0, Math.min(1, v)));
    }

    frequencyFor(level) {
        return this.minFrequency + (this.maxFrequency - this.minFrequency) * level;
    }

    bladeRateFor(level) {
        return this.frequencyFor(level) * this.bladeCount;
    }

    gainFor(level) {
        return this.maxToneGain * level;
    }

    brightnessFor(level) {
        return 500 + 5000 * level;
    }

    // Slightly compressed rather than squared: a real quad already has a hard edge at part
    // throttle, it does not stay polite until the last of the stick.
    noiseGainFor(level) {
        return this.maxNoiseGain * Math.pow(level, 1.3);
    }

    noiseBandFor(level) {
        return 600 + 2500 * level;
    }

    update(axes, armed) {
        if (!this.ctx || !this.enabled) return;

        const levels = this.motorLevels(axes, armed);
        const mean = (levels[0] + levels[1] + levels[2] + levels[3]) / 4;
        const now = this.ctx.currentTime;

        // Each motor runs its own RPM, so the spread widens through a manoeuvre
        for (let i = 0; i < this.motors.length; i++) {
            const rpm = this.frequencyFor(levels[i]) * this.motorDetune[i];
            this.motors[i].frequency.setTargetAtTime(rpm, now, this.smoothing);
        }

        // The chop follows the blades
        const bladeRate = this.bladeRateFor(mean);
        for (let i = 0; i < this.choppers.length; i++) {
            const ratio = i === 0 ? 1 : 1.008;
            this.choppers[i].frequency.setTargetAtTime(bladeRate * ratio, now, this.smoothing);
        }

        this.toneGain.gain.setTargetAtTime(this.gainFor(mean), now, this.smoothing);
        this.toneFilter.frequency.setTargetAtTime(this.brightnessFor(mean), now, this.smoothing);
        this.noiseGain.gain.setTargetAtTime(this.noiseGainFor(mean), now, this.smoothing);
        this.noiseFilter.frequency.setTargetAtTime(this.noiseBandFor(mean), now, this.smoothing);
    }

    // Fade out without touching the oscillators, so sound can come straight back on resume
    silence() {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        this.toneGain.gain.setTargetAtTime(0, now, this.smoothing);
        this.noiseGain.gain.setTargetAtTime(0, now, this.smoothing);
    }
}
