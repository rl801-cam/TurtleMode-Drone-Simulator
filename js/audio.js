// audio.js - Motor and prop noise synthesis
//
// A quad does not sound like a sine wave. Three things make the difference, and all three are
// driven by thrust:
//
//   1. Harmonics. A blade puts most of its energy into the blade-pass harmonic (rotation rate
//      times blade count) and its multiples, not into the rotation fundamental itself. So the
//      oscillators run on a custom periodic wave shaped for that, rather than a plain tone.
//   2. Four motors, slightly apart. No two motors turn at exactly the same rate, and the beating
//      between them is the warble that makes a quad recognisable. One oscillator per motor,
//      detuned by a fraction of a percent.
//   3. Prop wash. Broadband air noise through a bandpass that follows the blades, weighted to the
//      top of the throttle range where the drone is actually moving air.
//
// Everything is synthesised, so there are no samples to load.

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.enabled = true;

        this.motors = [];
        this.toneGain = null;
        this.toneFilter = null;
        this.noiseGain = null;
        this.noiseFilter = null;
        this.master = null;

        // Prop *rotation* rate. The audible pitch sits on the blade-pass harmonics well above
        // this, so the tone you hear runs roughly three times higher than these numbers.
        this.minFrequency = 55; // Hz at zero thrust
        this.maxFrequency = 260; // Hz at full thrust

        // Per-motor rate spread. Small on purpose: a few Hz of beating reads as a real airframe,
        // more starts to sound like a broken one.
        this.motorDetune = [1, 1.006, 0.994, 1.011];

        // Four oscillators sum into the tone gain, so the ceiling here is per-motor
        this.maxToneGain = 0.035;
        this.maxNoiseGain = 0.05;

        // Exponential smoothing time constant. Stick input arrives in discrete frames, and
        // stepping the parameters straight to their new values clicks audibly.
        this.smoothing = 0.05; // seconds
    }

    // Relative strength of each harmonic of the rotation rate. Index 0 is DC and must stay zero.
    // The peak at the third harmonic is the blade-pass tone of a three-blade prop; the smaller
    // peaks at 6 and 9 are its multiples.
    bladeHarmonics() {
        return [0, 0.25, 0.55, 1.0, 0.45, 0.3, 0.5, 0.18, 0.12, 0.22, 0.1, 0.08, 0.14];
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

        this.noiseFilter = this.ctx.createBiquadFilter();
        this.noiseFilter.type = 'bandpass';
        this.noiseFilter.frequency.value = this.noiseBandFor(0);
        this.noiseFilter.Q.value = 0.7;
        this.noiseFilter.connect(this.master);

        this.noiseGain = this.ctx.createGain();
        this.noiseGain.gain.value = 0;
        this.noiseGain.connect(this.noiseFilter);

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(this.noiseGain);
        source.start();
        this.noiseSource = source;
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
        return this.maxToneGain * level;
    }

    brightnessFor(level) {
        return 500 + 5000 * level;
    }

    // Squared, so prop wash stays out of the way at a hover and builds as the drone works
    noiseGainFor(level) {
        return this.maxNoiseGain * level * level;
    }

    noiseBandFor(level) {
        return 600 + 2500 * level;
    }

    update(thrust, armed) {
        if (!this.ctx || !this.enabled) return;

        const level = this.level(thrust, armed);
        const now = this.ctx.currentTime;
        const rotation = this.frequencyFor(level);

        for (let i = 0; i < this.motors.length; i++) {
            this.motors[i].frequency.setTargetAtTime(
                rotation * this.motorDetune[i], now, this.smoothing);
        }

        this.toneGain.gain.setTargetAtTime(this.gainFor(level), now, this.smoothing);
        this.toneFilter.frequency.setTargetAtTime(this.brightnessFor(level), now, this.smoothing);
        this.noiseGain.gain.setTargetAtTime(this.noiseGainFor(level), now, this.smoothing);
        this.noiseFilter.frequency.setTargetAtTime(this.noiseBandFor(level), now, this.smoothing);
    }

    // Fade out without touching the oscillators, so sound can come straight back on resume
    silence() {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        this.toneGain.gain.setTargetAtTime(0, now, this.smoothing);
        this.noiseGain.gain.setTargetAtTime(0, now, this.smoothing);
    }
}
