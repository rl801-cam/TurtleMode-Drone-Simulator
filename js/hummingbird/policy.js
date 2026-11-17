// policy.js - The learned hummingbird controller: a PPO policy trained in flappy, exported to JSON by
// flappy's export_simulator.py. 18 observations in, 4 drive parameters out, at 500 Hz.
//
// Observation (fwmav_sim_env.py get_observation), all in flappy's world axes (z up):
//   0-8   rotation matrix from roll, pitch, yaw - flappy's euler_2_R, *including* its slip in
//         R[0][1] (C_phi where S_phi belongs). The policy was trained on that matrix, so it must be
//         fed the same nine numbers, not a correct rotation.
//   9-11  position minus target position
//   12-14 velocity minus target velocity
//   15-17 gyro: body angular rates
// It is normalised with the training statistics (VecNormalize), clipped to +-10, and run through
// two 64-unit tanh layers to the action mean, which is used directly (deterministic) and clipped to
// [-1, 1].
//
// Action -> drive (fwmav_sim_env.py step): max voltage, voltage difference between the wings,
// voltage bias and split cycle, each scaled from [-1, 1] to its range, turned into two flapping
// waveforms by controlSignal().

import { controlSignal } from './flapper.js?v=34';

export class Policy {
    constructor(json) {
        this.source = json.source;
        this.mean = Float64Array.from(json.obs_mean);
        this.scale = Float64Array.from(json.obs_var, v => 1 / Math.sqrt(v + json.obs_epsilon));
        this.clip = json.obs_clip;
        this.layers = json.layers.map(l => ({
            nIn: l.w.length,
            nOut: l.b.length,
            w: Float64Array.from(l.w.flat()), // row-major [in][out]
            b: Float64Array.from(l.b),
            tanh: l.activation === 'tanh',
            out: new Float64Array(l.b.length)
        }));
        this.input = new Float64Array(this.mean.length);
        this.action = new Float64Array(this.layers[this.layers.length - 1].nOut);
    }

    act(obs) {
        let x = this.input;
        for (let i = 0; i < x.length; i++) {
            const v = (obs[i] - this.mean[i]) * this.scale[i];
            x[i] = v > this.clip ? this.clip : v < -this.clip ? -this.clip : v;
        }
        for (const l of this.layers) {
            const y = l.out;
            y.set(l.b);
            for (let i = 0; i < l.nIn; i++) {
                const xi = x[i];
                const row = i * l.nOut;
                for (let j = 0; j < l.nOut; j++) y[j] += xi * l.w[row + j];
            }
            if (l.tanh) for (let j = 0; j < l.nOut; j++) y[j] = Math.tanh(y[j]);
            x = y;
        }
        for (let j = 0; j < this.action.length; j++) this.action[j] = Math.max(-1, Math.min(1, x[j]));
        return this.action;
    }
}

// flappy's euler_2_R, slip and all (see the note at the top), into out[0..8]
export function flappyRotation(phi, theta, psi, out, offset = 0) {
    const cf = Math.cos(phi), sf = Math.sin(phi);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const cp = Math.cos(psi), sp = Math.sin(psi);
    out[offset] = cp * ct;
    out[offset + 1] = cp * st * cf - sp * cf;
    out[offset + 2] = cp * st * cf + sp * sf;
    out[offset + 3] = sp * ct;
    out[offset + 4] = sp * st * sf + cp * cf;
    out[offset + 5] = sp * st * cf - cp * sf;
    out[offset + 6] = -st;
    out[offset + 7] = ct * sf;
    out[offset + 8] = ct * cf;
    return out;
}

// The two motor voltages for an action at time t
export function actionToVoltages(robot, action, t, out = [0, 0]) {
    const lb = robot.action_lb, ub = robot.action_ub, lim = robot.voltage_limit;
    const s = new Array(4);
    for (let i = 0; i < 4; i++) {
        const v = (action[i] + 1) * 0.5 * (ub[i] - lb[i]) + lb[i];
        s[i] = Math.max(lb[i], Math.min(ub[i], v));
    }
    const [maxV, diff, bias, split] = s;
    const f = robot.frequency;
    out[0] = Math.max(-lim, Math.min(lim, controlSignal(f, maxV, diff, bias, -split, t)));
    out[1] = Math.max(-lim, Math.min(lim, controlSignal(f, maxV, -diff, bias, split, t)));
    return out;
}
