// Checks the JavaScript hummingbird against the original flappy/DART simulation.
//
//   node tests/hummingbird.test.mjs [reference.json]
//
// The reference is written by flappy's export_simulator.py --reference: kinematics, mass matrix,
// bias forces and wing forces at random states, every 10 kHz step of the start of a flight, and that
// whole flight (4 s of ppo2new_4M following a moving target) once per control period. The robot and
// policy are the same JSON files the browser loads. Exits non-zero if any check fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Flapper } from '../js/hummingbird/flapper.js';
import { Hummingbird } from '../js/hummingbird/hummingbird.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const robot = load(join(root, 'models/hummingbird/robot.json'));
const policy = load(join(root, 'models/hummingbird/ppo2new_4M.json'));
const ref = load(process.argv[2] || join(root, 'tests/data/hummingbird-reference.json'));

let failures = 0;
function check(name, err, tol) {
    const ok = err <= tol;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${err.toExponential(2)} (tolerance ${tol.toExponential(0)})`);
}

// largest difference relative to the size of the reference values
function relErr(a, b) {
    let num = 0, den = 0;
    const fa = a.flat(Infinity), fb = b.flat(Infinity);
    for (let i = 0; i < fb.length; i++) {
        num = Math.max(num, Math.abs(fa[i] - fb[i]));
        den = Math.max(den, Math.abs(fb[i]));
    }
    return num / Math.max(den, 1e-300);
}

const f = new Flapper(robot);

// ---- 1. state-level quantities at random states ----
{
    let eT = 0, eCom = 0, eV = 0, eM = 0, eC = 0, eAero = 0;
    for (const s of ref.samples) {
        f.setDartState(s.q, s.dq);
        for (let i = 0; i < 5; i++) {
            const R = f.bodyRw[i], p = f.bodyPw[i], T = s.T[i];
            const mine = [[R[0], R[1], R[2], p[0]], [R[3], R[4], R[5], p[1]], [R[6], R[7], R[8], p[2]]];
            eT = Math.max(eT, relErr(mine, T.slice(0, 3)));
        }
        eCom = Math.max(eCom, relErr(Array.from(f.comPosition()), s.com));
        eV = Math.max(eV, relErr(Array.from(f.comVelocity()), s.com_velocity),
            relErr(Array.from(f.comSpatialVelocity()), s.com_spatial_velocity));
        const M = f.massMatrix();
        const mine = [];
        for (let i = 0; i < 10; i++) mine.push(Array.from(M.slice(i * 10, i * 10 + 10)));
        eM = Math.max(eM, relErr(mine, s.M));
        f.Fext.forEach(F => F.fill(0));
        eC = Math.max(eC, relErr(Array.from(f.biasForces(false)), s.c));
        const Vc = f.comSpatialVelocity();
        const aero = f.wings.map((w, k) => {
            const d = k === 0 ? 6 : 8;
            w.update(Vc[0], Vc[1], Vc[2], Vc[3], Vc[4], Vc[5], s.q[d], s.dq[d], s.q[d + 1], s.dq[d + 1]);
            return [w.normalForce, w.spanCoP, w.chordCoP, w.rotationalDamping];
        });
        eAero = Math.max(eAero, relErr(aero, s.aero));
    }
    console.log(`-- ${ref.samples.length} random states`);
    check('body transforms', eT, 1e-9);
    check('torso COM position', eCom, 1e-9);
    check('torso COM velocities', eV, 1e-9);
    check('mass matrix', eM, 1e-8);
    check('Coriolis + gravity forces', eC, 1e-8);
    check('wing aerodynamics', eAero, 1e-8);
}

// ---- 2. single 10 kHz steps, each started from DART's own state ----
{
    const steps = ref.flight.steps;
    let eq = 0, edq = 0, eddq = 0;
    for (let k = 1; k < steps.length; k++) {
        const prev = steps[k - 1], s = steps[k];
        f.setDartState(prev.q, prev.dq);
        f.ddq.set(prev.ddq);
        // latch the voltage DART's driver held for this step
        f.time = s.t;
        f.driverTime = s.t;
        f.step(s.voltage[0], s.voltage[1]);
        const st = f.getDartState();
        eq = Math.max(eq, relErr(st.q, s.q));
        edq = Math.max(edq, relErr(st.dq, s.dq));
        eddq = Math.max(eddq, relErr(Array.from(f.ddq), s.ddq));
    }
    console.log(`-- ${steps.length - 1} single steps`);
    check('positions after one step', eq, 1e-8);
    check('velocities after one step', edq, 1e-7);
    check('accelerations', eddq, 1e-6);
}

// ---- 3. open-loop replay of the recorded drive ----
{
    const steps = ref.flight.steps;
    f.setDartState(ref.flight.initial.q, ref.flight.initial.dq);
    f.ddq.fill(0);
    f.time = 0;
    f.driverTime = 0;
    let worst = 0, worstAt = 0;
    for (let k = 0; k < steps.length; k++) {
        f.driverTime = steps[k].t; // latch exactly what DART latched
        f.time = steps[k].t;
        f.step(steps[k].voltage[0], steps[k].voltage[1]);
        const e = relErr(f.getDartState().q, steps[k].q);
        if (e > worst) { worst = e; worstAt = k; }
    }
    console.log(`-- open-loop replay, ${steps.length} steps (${(steps.length * robot.dt_sim * 1000).toFixed(0)} ms)`);
    check(`position drift (worst at step ${worstAt})`, worst, 1e-6);
}

// ---- 4. closed loop: the policy flying the reference's target schedule ----
{
    const fl = ref.flight;
    const legs = fl.legs;
    const velocityAt = (t) => {
        for (const [tEnd, v] of legs) if (t < tEnd) return v;
        return [0, 0, 0];
    };
    // flappy's ScheduleMission, integrated the same way
    const pos = [0, 0, 0];
    let last = 0;
    const targetFn = (t, target, vel) => {
        const v = velocityAt(last);
        for (let i = 0; i < 3; i++) pos[i] += v[i] * (t - last);
        last = t;
        target.set(pos);
        vel.set(velocityAt(t));
    };

    const bird = new Hummingbird(robot, policy);
    bird.reset([0, 0, 0], 0, true);
    bird.setArmed(true);
    let firstObs = 0, firstAct = 0, maxPos = 0, maxPosAt = 0, endTracking = 0;
    const n = fl.control.length;
    for (let k = 0; k < n; k++) {
        const c = fl.control[k];
        // c.action is what flappy applied during period k, chosen from the previous observation
        if (k < 50) firstAct = Math.max(firstAct, relErr(Array.from(bird.action), c.action));
        bird.controlStep(targetFn);
        if (Math.abs(bird.time - c.t) > 1e-8) throw new Error(`control clock off at ${k}: ${bird.time} vs ${c.t}`);
        if (k < 50) firstObs = Math.max(firstObs, relErr(Array.from(bird.obs), c.obs));
        const p = bird.flapper.getDartState().q;
        const d = Math.hypot(p[3] - c.q[3], p[4] - c.q[4], p[5] - c.q[5]);
        if (d > maxPos) { maxPos = d; maxPosAt = c.t; }
        if (k >= n - 250) {
            const com = bird.flapper.comPosition();
            endTracking = Math.max(endTracking, Math.hypot(com[0] - pos[0], com[1] - pos[1], com[2] - pos[2]));
        }
    }
    console.log(`-- closed loop, ${n} control periods (${(n * robot.dt_control).toFixed(1)} s)`);
    check('observations, first 0.1 s', firstObs, 1e-5);
    check('actions, first 0.1 s', firstAct, 1e-4);
    check(`distance from DART's flight path (worst at ${maxPosAt.toFixed(2)} s), m`, maxPos, 0.03);
    check('distance from the target over the last 0.5 s, m', endTracking, 0.06);
}

// ---- 5. a pilot's session on the sticks, over flat ground ----
{
    const bird = new Hummingbird(robot, policy);
    bird.reset([0, 0, 0], 0);
    bird.setArmed(true);
    const states = [];
    let errSum = 0, errN = 0;
    const fly = (secs, forward, right, up, yaw) => {
        bird.setSticks(forward, right, up, yaw);
        for (let i = 0; i < Math.round(secs / bird.dtControl); i++) {
            bird.controlStep();
            if (bird.state === 'flying') {
                const c = bird.flapper.comPosition();
                errSum += Math.hypot(c[0] - bird.target[0], c[1] - bird.target[1], c[2] - bird.target[2]);
                errN++;
            }
        }
        states.push(bird.state);
    };
    const yawDeg = () => bird.flapper.euler()[2] * 180 / Math.PI;
    fly(0.5, 0, 0, 0, 0); // armed on the ground: stays put
    const parked = states[0] === 'landed';
    fly(2.5, 0, 0, 1, 0); // climb
    const height = bird.flapper.comPosition()[2];
    fly(5, 1, 0, 0, 0); // forward
    const x = bird.flapper.comPosition()[0];
    const yaw0 = yawDeg();
    fly(3, 0, 0, 0, 1); // turn right
    const turned = yaw0 - yawDeg();
    fly(1, 0, 0, 0, 0);
    fly(5, 0, 0, -1, 0); // descend
    console.log(`-- pilot session: ${states.join(' > ')}; ${(height * 100).toFixed(0)} cm up, ` +
        `${(x * 100).toFixed(0)} cm forward, turned ${turned.toFixed(0)} deg`);
    check('stays parked until throttle up (0 = yes)', parked ? 0 : 1, 0);
    check('never crashed (0 = yes)', states.includes('crashed') ? 1 : 0, 0);
    check('climbed to about 50 cm (error, m)', Math.abs(height - 0.5), 0.05);
    check('flew about 1 m forward (error, m)', Math.abs(x - 1), 0.1);
    check('turned right about 100 deg (error, deg)', Math.abs(turned - 100), 30);
    check('landed at the end (0 = yes)', bird.state === 'landed' ? 0 : 1, 0);
    check('mean distance from the target in flight, m', errSum / errN, 0.04);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
