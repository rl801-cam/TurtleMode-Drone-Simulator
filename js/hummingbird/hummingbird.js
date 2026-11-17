// hummingbird.js - The flapping-wing hummingbird flown by its learned controller.
//
// Wraps the robot (flapper.js) and the policy (policy.js) in the same loop flappy trained it in
// (fwmav_sim_env.py), and adds what a pilot needs: the sticks move the *target* the controller
// chases, takeoff from and landing on the ground, and crash detection against the map.
//
// Coordinates are flappy's throughout: z up, x forward, y left, metres. physics.js converts to
// and from the renderer's axes. Pure and DOM-free, so the tests drive it headlessly.
//
// Timing, copied from the training environment because the controller depends on it:
// * The robot steps at 10 kHz and the controller at 500 Hz. The drive waveform is sampled once at
//   the start of each 2 ms control period and held for its 20 steps.
// * The controller sees the state from the *start* of the period it is choosing the next action in
//   - in flappy the state estimate is refreshed on the first step of each period and the
//   observation is read at its end - so it always acts on a 2 ms old picture.
// * Clocks advance by repeated addition (t += dt) and are compared as flappy compares them, so the
//   occasional 19- or 21-step period lands exactly where it does in the original.
// The one deliberate difference: flappy fed the controller an estimate from a simulated IMU and
// motion-capture system. Here it gets the true state, which flies as well or better on the standard
// robot (measured in flappy: moving and takeoff 30/30 both ways, errors equal or lower).

import { Flapper } from './flapper.js?v=34';
import { Policy, flappyRotation, actionToVoltages } from './policy.js?v=34';

export const BIRD_STATE = {
    LANDED: 'landed', // sitting on the ground, held there; wings flap while armed
    FLYING: 'flying',
    CRASHED: 'crashed'
};

export class Hummingbird {
    constructor(robot, policyJson, options = {}) {
        this.robot = robot;
        this.flapper = new Flapper(robot);
        this.policy = new Policy(policyJson);
        this.dtControl = robot.dt_control;
        this.dtSensor = robot.dt_control; // flappy's f_sensor equals f_control (500 Hz)

        // Pilot command limits: the controller was trained on targets moving up to 0.15 m/s
        // sideways and climbing at up to 0.3 m/s, and flew 0.2 m/s letters cleanly.
        this.maxSpeed = options.maxSpeed ?? 0.2; // m/s, horizontal, full stick
        this.maxClimb = options.maxClimb ?? 0.2; // m/s, vertical, full stick
        this.maxAccel = options.maxAccel ?? 1.0; // m/s^2, how fast the target's speed follows the stick
        // Heading. The controller was trained to hold yaw at zero; it turns by being shown a world
        // rotated under it, so the heading error it sees has to stay small - training started it
        // within 45 degrees of level and it recovered unreliably from the larger offsets.
        this.maxYawRate = options.maxYawRate ?? 0.6; // rad/s, full stick (about 35 deg/s)
        this.maxHeadingLead = options.maxHeadingLead ?? 0.3; // rad the target heading may lead the bird
        // The target is kept on a leash: the controller was trained within 1 m of it and is only
        // accurate within a few centimetres, so a target that runs away (stick held into a wall, a
        // lag in a fast turn) is held this close to the bird instead.
        this.leash = options.leash ?? 0.25; // m

        // Ground handling. The torso's centre of mass sits restHeight above the surface when landed,
        // and anything within collisionRadius of it once flying is a crash. flappy's rules: it is
        // airborne once 2 cm clear of where it sat, and a takeoff fails if it is still on the ground
        // when the target is 25 cm up.
        this.restHeight = options.restHeight ?? 0.04;
        this.collisionRadius = options.collisionRadius ?? 0.035;
        this.liftOff = 0.02;
        this.failedTakeoffHeight = 0.25;
        // A gentle return to the ground with the target down on it counts as a landing, not a crash.
        // Below flareRate^-1 metres the target's descent slows in proportion to its height, down to
        // touchdownSpeed (flappy's controller has no landing in its training; this is the pilot's
        // part of the job).
        this.landingSpeed = 0.2; // m/s
        this.landingHeight = 0.015; // m above the resting height
        // The controller hovers about 2 cm below its target (a steady offset it was never trained
        // out of), so the bird touches down while the target is still a little way up
        this.landingTargetHeight = 0.05; // m above the resting height
        this.flareRate = 2; // 1/s
        this.touchdownSpeed = 0.03; // m/s

        // Environment queries, supplied by the host (physics.js), in flappy coordinates: the height of
        // the first surface below (x, y, z), or null if there is none, and whether a sphere touches
        // the map. Without a host the ground is the plane z = 0.
        this.groundAt = options.groundAt || ((x, y, z) => 0);
        this.collides = options.collides || ((p, r) => p[2] - r < this.groundAt(p[0], p[1], p[2]));

        this.obs = new Float64Array(18);
        this.voltage = [0, 0];
        this.action = new Float64Array(4);
        this.target = new Float64Array(3);
        this.targetVel = new Float64Array(3);
        this.stick = { forward: 0, right: 0, up: 0, yaw: 0 };
        this.armed = false;
        this._com = new Float64Array(3);
        this._vel = new Float64Array(3);
        this._seen = { com: new Float64Array(3), vel: new Float64Array(3), euler: new Float64Array(3), gyro: new Float64Array(3) };

        this.reset([0, 0, 0], 0);
    }

    // Sit the bird on the ground at `ground` (the surface point under it), facing `yaw`. With
    // inAir it instead starts as flappy's episodes do: torso frame at `ground`, level, at rest,
    // flying (the tests use this to replay flappy's reference flight).
    reset(ground = [0, 0, 0], yaw = 0, inAir = false) {
        const f = this.flapper;
        f.reset(inAir ? ground : [0, 0, 0], yaw);
        this.groundZ = ground[2];
        this.parkedYaw = yaw;
        if (!inAir) this.holdOnGround(ground[0], ground[1], ground[2], yaw);
        this.time = 0;
        this.nextControl = this.dtControl;
        this.nextSensor = 0;
        this.heading = yaw;
        this.state = inAir ? BIRD_STATE.FLYING : BIRD_STATE.LANDED;
        this.released = inAir;
        this.crashReason = '';
        this.simAhead = 0;
        if (inAir) this.target.set(ground);
        else f.comPosition(this.target);
        this.targetVel.fill(0);
        // flappy's estimator starts from the true state with a zero gyro reading
        this.captureState();
        this._seen.gyro.fill(0);
        this.observe();
        this.action.set(this.policy.act(this.obs));
    }

    // flappy's Floor.rest_on: level, still, centre of mass restHeight above the ground, wings
    // left flapping. The heading is pinned to where it was when the bird set down (flappy kept it
    // free, but then the flapping wings slowly twist a parked bird round on the spot).
    holdOnGround(x, y, groundZ, yaw = Math.atan2(this.flapper.R[3], this.flapper.R[0])) {
        const f = this.flapper;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        f.R.set([c, -s, 0, s, c, 0, 0, 0, 1]);
        for (let i = 0; i < 6; i++) f.dq[i] = 0;
        const lc = f.localCom[0];
        f.p[0] = x - (c * lc[0] - s * lc[1]);
        f.p[1] = y - (s * lc[0] + c * lc[1]);
        f.p[2] = groundZ + this.restHeight - lc[2];
        f.updateKinematics();
    }

    setSticks(forward, right, up, yaw) {
        const s = this.stick;
        s.forward = forward; s.right = right; s.up = up; s.yaw = yaw;
    }

    setArmed(armed) {
        this.armed = armed;
    }

    // What the controller is shown: the state at the start of the period, in a world turned so the
    // target heading is its zero yaw
    captureState() {
        const f = this.flapper, seen = this._seen;
        f.comPosition(seen.com);
        f.comVelocity(seen.vel);
        f.euler(seen.euler);
        seen.gyro[0] = f.dq[0]; seen.gyro[1] = f.dq[1]; seen.gyro[2] = f.dq[2];
    }

    observe() {
        const seen = this._seen, o = this.obs;
        let dyaw = seen.euler[2] - this.heading;
        dyaw -= 2 * Math.PI * Math.round(dyaw / (2 * Math.PI));
        flappyRotation(seen.euler[0], seen.euler[1], dyaw, o, 0);
        const c = Math.cos(this.heading), s = Math.sin(this.heading);
        const ex = seen.com[0] - this.target[0], ey = seen.com[1] - this.target[1];
        const vx = seen.vel[0] - this.targetVel[0], vy = seen.vel[1] - this.targetVel[1];
        o[9] = c * ex + s * ey; o[10] = -s * ex + c * ey; o[11] = seen.com[2] - this.target[2];
        o[12] = c * vx + s * vy; o[13] = -s * vx + c * vy; o[14] = seen.vel[2] - this.targetVel[2];
        o[15] = seen.gyro[0]; o[16] = seen.gyro[1]; o[17] = seen.gyro[2];
        return o;
    }

    // One 2 ms control period: hold the drive for the period, then update the target and choose
    // the next action. targetFn, if given, replaces the stick logic (tests and scripted flights).
    controlStep(targetFn = null) {
        const f = this.flapper;
        if (this.armed && this.state !== BIRD_STATE.CRASHED) {
            actionToVoltages(this.robot, this.action, this.time, this.voltage);
        } else {
            this.voltage[0] = 0; this.voltage[1] = 0;
        }
        while (this.time < this.nextControl) {
            if (this.time >= this.nextSensor) {
                this.nextSensor += this.dtSensor;
                this.captureState();
            }
            f.step(this.voltage[0], this.voltage[1]);
            this.time += f.dt;
        }
        this.nextControl += this.dtControl;

        if (targetFn) {
            targetFn(this.time, this.target, this.targetVel);
        } else {
            this.updateGround();
            this.updateTarget();
        }
        this.observe();
        this.action.set(this.policy.act(this.obs));
    }

    // Takeoff, landing and crashes, flappy's Floor rules plus a landing
    updateGround() {
        if (this.state === BIRD_STATE.CRASHED) return;
        const f = this.flapper, com = f.comPosition(this._com);
        const restZ = this.groundZ + this.restHeight;
        if (this.state === BIRD_STATE.LANDED) {
            if (this.released && com[2] > restZ + this.liftOff) {
                this.state = BIRD_STATE.FLYING;
            } else if (this.target[2] > restZ + this.failedTakeoffHeight) {
                this.crash('failed takeoff');
            } else if (!this.released || com[2] < restZ) {
                this.holdOnGround(com[0], com[1], this.groundZ, this.parkedYaw);
            }
            return;
        }
        // flying
        const vel = f.comVelocity(this._vel);
        const speed = Math.hypot(vel[0], vel[1], vel[2]);
        // looked for from just above the bird, so a surface it has sunk into a little still counts
        const ground = this.groundAt(com[0], com[1], com[2] + 0.02);
        if (ground !== null && com[2] < ground + this.restHeight + this.landingHeight &&
            this.target[2] <= ground + this.restHeight + this.landingTargetHeight &&
            this.targetVel[2] <= 0 && speed < this.landingSpeed) {
            this.state = BIRD_STATE.LANDED;
            this.released = false;
            this.groundZ = ground;
            this.parkedYaw = Math.atan2(f.R[3], f.R[0]);
            this.holdOnGround(com[0], com[1], ground, this.parkedYaw);
            f.comPosition(this.target);
            this.targetVel.fill(0);
            return;
        }
        if (this.collides(com, this.collisionRadius)) this.crash('hit the map');
        else if (!this.armed) this.crash('disarmed in flight');
    }

    crash(reason) {
        this.state = BIRD_STATE.CRASHED;
        this.crashReason = reason;
        this.armed = false;
    }

    // The sticks set the target's velocity (and the heading's rate of turn); the target integrates it
    updateTarget() {
        if (this.state === BIRD_STATE.CRASHED) return;
        const dt = this.dtControl, s = this.stick, f = this.flapper;
        const com = f.comPosition(this._com);

        if (this.state === BIRD_STATE.LANDED) {
            // On the ground only climbing does anything; pushing up starts the takeoff
            this.heading = this.parkedYaw;
            const restZ = this.groundZ + this.restHeight;
            if (!this.released) {
                this.target[0] = com[0]; this.target[1] = com[1]; this.target[2] = restZ;
                this.targetVel.fill(0);
                if (this.armed && s.up > 0) this.released = true;
                else return;
            }
            const vz = Math.max(0, s.up) * this.maxClimb;
            this.targetVel[0] = 0; this.targetVel[1] = 0; this.targetVel[2] = vz;
            this.target[2] += vz * dt;
            return;
        }

        // heading: turned by the yaw stick, never more than maxHeadingLead from where the bird points
        const yaw = Math.atan2(f.R[3], f.R[0]);
        this.heading -= s.yaw * this.maxYawRate * dt;
        let lead = this.heading - yaw;
        lead -= 2 * Math.PI * Math.round(lead / (2 * Math.PI));
        if (lead > this.maxHeadingLead) this.heading -= lead - this.maxHeadingLead;
        if (lead < -this.maxHeadingLead) this.heading -= lead + this.maxHeadingLead;

        // stick velocity in the heading frame, rotated into the world, followed at maxAccel
        const c = Math.cos(this.heading), sn = Math.sin(this.heading);
        const fwd = s.forward * this.maxSpeed, left = -s.right * this.maxSpeed;
        const want = [c * fwd - sn * left, sn * fwd + c * left, s.up * this.maxClimb];
        const hs = Math.hypot(want[0], want[1]);
        if (hs > this.maxSpeed) { want[0] *= this.maxSpeed / hs; want[1] *= this.maxSpeed / hs; }
        // The ground under the target, looked for from above both the target and the bird. Coming
        // down, the target eases in over the last few centimetres, so the bird - which trails it by a
        // couple of centimetres - arrives slowly enough to land instead of hitting the ground.
        const below = this.groundAt(this.target[0], this.target[1], Math.max(this.target[2], com[2]) + 0.02);
        if (below !== null && want[2] < 0) {
            const above = this.target[2] - (below + this.restHeight);
            want[2] = Math.max(want[2], -Math.max(this.touchdownSpeed, this.flareRate * above));
        }
        const dv = this.maxAccel * dt;
        for (let i = 0; i < 3; i++) {
            const d = want[i] - this.targetVel[i];
            this.targetVel[i] += Math.max(-dv, Math.min(dv, d));
            this.target[i] += this.targetVel[i] * dt;
        }

        // never below the ground, never further than the leash
        if (below !== null && this.target[2] < below + this.restHeight) {
            this.target[2] = below + this.restHeight;
            if (this.targetVel[2] < 0) this.targetVel[2] = 0;
        }
        const dx = this.target[0] - com[0], dy = this.target[1] - com[1], dz = this.target[2] - com[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist > this.leash) {
            const k = this.leash / dist;
            this.target[0] = com[0] + dx * k; this.target[1] = com[1] + dy * k; this.target[2] = com[2] + dz * k;
        }
    }

    // Run in real time: as many control periods as fit in dt (capped, so a stalled tab does not
    // try to catch up on seconds of flight at once)
    advance(dt, maxStep = 0.05) {
        this.simAhead += Math.min(dt, maxStep);
        let n = 0;
        while (this.simAhead >= this.dtControl) {
            if (this.state === BIRD_STATE.CRASHED) { this.simAhead = 0; break; }
            this.controlStep();
            this.simAhead -= this.dtControl;
            n++;
        }
        return n;
    }
}
