// physics.js - Handles Cannon-es physics environment and drone simulation

import * as CANNON from 'cannon-es';

export class PhysicsEngine {
    constructor() {
        // Core physics world
        this.world = new CANNON.World({
            gravity: new CANNON.Vec3(0, -9.81, 0), // Standard Earth gravity
            allowSleep: false // Ensure physics never stop calculating for the drone
        });

        // Configurable Drone Parameters
        this.params = {
            mass: 0.5, // kg
            maxThrust: 25, // Newtons (TWR of ~5:1 at the default mass)
            drag: 0.5, // Linear & Angular dampening
            restitution: 0.2, // How much energy a frame/prop strike gives back
            friction: 0.2, // Coulomb friction coefficient at contact points
            wind: {
                // Gentle random torque per body axis, on by default on all three
                roll: true,
                pitch: true,
                yaw: true,
                strength: 0.1 // 0..1, scaled by windMaxTorque below
            },
            rates: {
                roll: { center: 200, max: 600, expo: 0.5 },
                pitch: { center: 200, max: 600, expo: 0.5 },
                yaw: { center: 200, max: 400, expo: 0.5 }
            }
        };

        // Where reset() puts the drone. Practice starts at the map origin; a race moves this to
        // the start grid so the airframe faces down the run to the first gate.
        this.spawn = {
            position: new CANNON.Vec3(0, 1, 0),
            quaternion: new CANNON.Quaternion(0, 0, 0, 1)
        };

        // Create the drone body (Simplified Cuboid)
        const size = new CANNON.Vec3(0.15, 0.05, 0.15); // W, H, D
        this.droneShape = new CANNON.Box(size);
        this.droneBody = new CANNON.Body({
            mass: this.params.mass,
            shape: this.droneShape,
            position: this.spawn.position.clone(), // Start slightly above ground
            linearDamping: this.params.drag,
            angularDamping: this.params.drag
        });
        this.world.addBody(this.droneBody);

        // No CANNON floor body: the ground is part of the map mesh, so it is handled by the
        // BVH contact solver below like every other surface. An extra infinite plane here would
        // catch the drone before the contact points reached the floor, and ground crashes would
        // silently bypass the bounce/friction model.

        // Collision contact points, in body-local space: one per motor plus the centre of the
        // airframe. Resolving an impulse at each point separately is what makes a corner strike
        // spin the drone - a single point at the centre of mass can only ever push it straight back.
        //
        // They must stay coplanar with the centre of mass (y = 0), like the arms of a real quad.
        // Offsetting them vertically gives every head-on wall strike a lever arm about the CoM,
        // which makes the drone tumble backwards off flat walls it should bounce squarely off.
        this.contactPoints = [
            { offset: new CANNON.Vec3(-0.09, 0, -0.09), radius: 0.05 },
            { offset: new CANNON.Vec3(0.09, 0, -0.09), radius: 0.05 },
            { offset: new CANNON.Vec3(-0.09, 0, 0.09), radius: 0.05 },
            { offset: new CANNON.Vec3(0.09, 0, 0.09), radius: 0.05 },
            { offset: new CANNON.Vec3(0, 0, 0), radius: 0.05 }
        ];
        // One cheap query around the whole airframe; skips the per-point work when nothing is close
        this.broadPhaseRadius = 0.25;

        // Below this closing speed a contact stops bouncing, so a landed drone settles
        // instead of buzzing against the floor.
        this.restitutionThreshold = 0.6; // m/s
        // Leave a sliver of penetration unresolved - stops contacts flickering on/off
        this.penetrationSlop = 0.005; // m
        this.penetrationCorrection = 0.8;
        this.solverIterations = 3;

        // Fixed internal sub-step. Every per-sub-step calculation below assumes this rate.
        this.fixedTimeStep = 1 / 120;

        // Contact points that hit the same flat surface are merged into one manifold when their
        // normals agree to within this tolerance
        this.manifoldNormalTolerance = 0.9;

        // Preallocated per-contact slots, reused every sub-step
        this._contacts = this.contactPoints.map(() => ({
            r: new CANNON.Vec3(),
            normal: new CANNON.Vec3(),
            normalImpulse: 0
        }));

        // Preallocated manifold slots (at most one per contact point), reused every sub-step
        this._manifolds = this.contactPoints.map(() => ({
            refNormal: new CANNON.Vec3(), // normal of the first contact, used for grouping
            normal: new CANNON.Vec3(),
            sumN: new CANNON.Vec3(),
            sumR: new CANNON.Vec3(),
            r: new CANNON.Vec3(),
            sumR2: 0, // sum of |r|^2, for the patch radius
            count: 0,
            maxDepth: 0,
            closingSpeed: 0,
            normalImpulse: 0,
            patchRadius: 0
        }));

        this.currentAxes = null;
        this.isArmed = false;

        // Apply continuous forces per physics sub-step using World events
        // This is guaranteed to run before every single internal integration step.
        this.world.addEventListener('preStep', () => {
            if (this.isArmed) {
                if (this.currentAxes) this.applyInputsInternal(this.currentAxes);
                this.applyWind();
            }
        });

        // Wind. Torque at full strength, per kg of airframe - scaling by mass keeps the same
        // slider setting feeling the same on a light and a heavy drone.
        this.windMaxTorque = 0.02; // N.m per kg
        this.windGustTau = 0.8; // seconds for a gust to shift; larger = slower, lazier air
        this._windState = { roll: 0, pitch: 0, yaw: 0 };

        // Wind is white noise run through a first-order low-pass, so it wanders instead of
        // buzzing. Filtering shrinks the amplitude, so windGain restores it: without this the
        // strength slider would barely do anything.
        this._windBlend = 1 - Math.exp(-this.fixedTimeStep / this.windGustTau);
        this._windGain = Math.sqrt((2 - this._windBlend) / this._windBlend);

        this.collisionCallback = null;
        this.sweepCallback = null;

        // Continuous collision detection. The sphere checks only see a surface within a contact
        // radius of where the sub-step *ended*, so anything moving further than this in one
        // sub-step could step straight over a wall. Above it, the travelled path is swept instead.
        //
        // It must never exceed the smallest contact radius. A contact sphere sitting further
        // than its radius from a surface is invisible to the sphere check, so a sub-step longer
        // than that radius can start outside the check and land on the far side of the surface -
        // where the closest-point normal points the wrong way and the solver pushes the drone
        // further through. Capping travel at the radius makes crossing geometrically impossible.
        this.ccdThreshold = Math.min(...this.contactPoints.map((cp) => cp.radius));
        // Seeded from the spawn position and kept valid from then on, so even the very first
        // sub-step has a path to sweep
        this._prevPosition = this.droneBody.position.clone();

        // Whether the drone is resting on something. Contact is held for a short grace period
        // after the last touch: on real map geometry a settled drone can drop and regain contact
        // for a sub-step at a time, and without this the wind would flicker back on in the gaps.
        this.contactGraceSteps = Math.round(0.2 / this.fixedTimeStep);
        this._contactCooldown = 0;
        this._inContact = false;

        // Perform collision check and resolution immediately after every internal physics sub-step
        this.world.addEventListener('postStep', () => {
            if (this.resolveCollisions()) {
                this._contactCooldown = this.contactGraceSteps;
            } else if (this._contactCooldown > 0) {
                this._contactCooldown--;
            }
            this._inContact = this._contactCooldown > 0;
            // Recorded after resolution so the next sub-step sweeps from where the drone
            // actually ended up, not from a position it was pushed out of
            this._prevPosition.copy(this.droneBody.position);
        });

        // Scratch vectors, reused every contact to keep the solver allocation-free
        this._scratch = {
            r: new CANNON.Vec3(),
            worldPoint: new CANNON.Vec3(),
            pointVel: new CANNON.Vec3(),
            tangent: new CANNON.Vec3(),
            impulse: new CANNON.Vec3(),
            correction: new CANNON.Vec3(),
            tmpA: new CANNON.Vec3(),
            tmpB: new CANNON.Vec3()
        };

        this.lastTime = performance.now();
    }

    // Denominator of the impulse equation: the mass the contact "feels" along `dir`
    // when pushed at world offset `r` from the centre of mass.
    // K = 1/m + dir . ( (Iinv (r x dir)) x r )
    effectiveMass(r, dir) {
        const s = this._scratch;
        r.cross(dir, s.tmpA);
        this.droneBody.invInertiaWorld.vmult(s.tmpA, s.tmpB);
        s.tmpB.cross(r, s.tmpA);
        return this.droneBody.invMass + dir.dot(s.tmpA);
    }

    // Velocity of a contact point in world space, including the contribution from spin.
    // Written into scratch.pointVel.
    contactPointVelocity(r) {
        const s = this._scratch;
        this.droneBody.angularVelocity.cross(r, s.tmpA);
        this.droneBody.velocity.vadd(s.tmpA, s.pointVel);
        return s.pointVel;
    }

    // Catches a sub-step that jumped clean through a surface and pulls the drone back to the
    // point of impact, where the normal contact solver can then bounce it properly.
    applyContinuousCollision() {
        const body = this.droneBody;
        const s = this._scratch;

        const prev = this._prevPosition;
        if (!this.sweepCallback) return;

        s.tmpA.set(body.position.x - prev.x, body.position.y - prev.y, body.position.z - prev.z);
        if (s.tmpA.length() <= this.ccdThreshold) return;

        const hit = this.sweepCallback(prev, body.position);
        if (!hit) return;

        // Drop the drone just inside contact range of the surface it hit, so the manifold pass
        // below registers it as a normal collision and applies the usual bounce and friction.
        const standoff = this.contactPoints[0].radius * 0.9;
        body.position.set(
            hit.point.x + hit.normal.x * standoff,
            hit.point.y + hit.normal.y * standoff,
            hit.point.z + hit.normal.z * standoff
        );
    }

    // Returns true when the drone is touching a surface this sub-step.
    resolveCollisions() {
        if (!this.collisionCallback) return false;

        const body = this.droneBody;
        const s = this._scratch;

        this.applyContinuousCollision();

        // Broad phase: one sphere around the whole airframe. Most sub-steps end here.
        if (!this.collisionCallback(body.position, this.broadPhaseRadius)) return false;

        // The impulse maths needs the inertia tensor in world space for the current attitude
        body.updateInertiaWorld(true);

        // --- Pass 1: find contacts, and group them into manifolds by the surface they hit ---
        let cCount = 0;
        let mCount = 0;

        for (const cp of this.contactPoints) {
            // World offset of this contact point from the centre of mass
            body.quaternion.vmult(cp.offset, s.r);
            body.position.vadd(s.r, s.worldPoint);

            const hit = this.collisionCallback(s.worldPoint, cp.radius);
            if (!hit) continue;

            // NOTE: `hit` is scratch state owned by the renderer and is invalidated by the
            // next collisionCallback call, so everything we need is copied out here.
            const nx = hit.normal.x;
            const ny = hit.normal.y;
            const nz = hit.normal.z;
            const depth = hit.depth;

            const contact = this._contacts[cCount++];
            contact.r.copy(s.r);
            contact.normal.set(nx, ny, nz);
            contact.normalImpulse = 0;

            let m = null;
            for (let i = 0; i < mCount; i++) {
                const candidate = this._manifolds[i];
                const alignment = candidate.refNormal.x * nx + candidate.refNormal.y * ny + candidate.refNormal.z * nz;
                if (alignment > this.manifoldNormalTolerance) {
                    m = candidate;
                    break;
                }
            }

            if (!m) {
                m = this._manifolds[mCount++];
                m.refNormal.set(nx, ny, nz);
                m.sumN.set(0, 0, 0);
                m.sumR.set(0, 0, 0);
                m.sumR2 = 0;
                m.count = 0;
                m.maxDepth = 0;
                m.normalImpulse = 0;
            }

            m.sumN.x += nx;
            m.sumN.y += ny;
            m.sumN.z += nz;
            m.sumR.vadd(s.r, m.sumR);
            m.sumR2 += s.r.lengthSquared();
            m.count++;
            if (depth > m.maxDepth) m.maxDepth = depth;
        }

        if (mCount === 0) return false; // close to geometry, but nothing actually touching

        // Manifolds exist only to place the bounce and the push-out. Each is reduced to one
        // equivalent contact at the centroid of its points, because that is what keeps a square-on
        // impact from tumbling: a symmetric contact patch has its centroid on the centre line and
        // so no lever arm, while a lopsided patch - one motor catching a corner - does.
        s.correction.set(0, 0, 0);

        for (let i = 0; i < mCount; i++) {
            const m = this._manifolds[i];
            m.sumN.scale(1 / m.sumN.length(), m.normal);
            m.sumR.scale(1 / m.count, m.r);
            m.normalImpulse = 0;

            // How far the contact points are spread around their centroid (RMS). A wide patch
            // can resist tipping; a single point cannot, and gets a radius of zero.
            const variance = m.sumR2 / m.count - m.r.lengthSquared();
            m.patchRadius = Math.sqrt(Math.max(0, variance));

            // Accumulated push-out. Tracking what a normal has already been given stops a drone
            // wedged against two surfaces from being shoved out twice as far as it needs.
            const alreadyCorrected = s.correction.dot(m.normal);
            const needed = (m.maxDepth - this.penetrationSlop) * this.penetrationCorrection - alreadyCorrected;
            if (needed > 0) {
                s.correction.x += m.normal.x * needed;
                s.correction.y += m.normal.y * needed;
                s.correction.z += m.normal.z * needed;
            }

            // Measured before anything is solved, so the passes below cannot pump energy back in.
            // Slow contacts do not bounce at all, which lets a landed drone settle.
            const vn0 = this.contactPointVelocity(m.r).dot(m.normal);
            m.closingSpeed = -vn0 > this.restitutionThreshold ? -vn0 : 0;
        }

        body.position.vadd(s.correction, body.position);

        // --- Pass 2: non-penetration and friction, one solve per surface ---
        // Per manifold rather than per contact point: solving points individually over-constrains
        // three degrees of freedom with five contacts, which Gauss-Seidel cannot settle between
        // sub-steps, and the asymmetric friction order tumbles a square-on impact.
        for (let iter = 0; iter < this.solverIterations; iter++) {
            for (let i = 0; i < mCount; i++) {
                const contact = this._manifolds[i];
                const n = contact.normal;
                const r = contact.r;

                const vn = this.contactPointVelocity(r).dot(n);
                if (vn < 0) {
                    const kn = this.effectiveMass(r, n);
                    if (kn > 1e-9) {
                        const jn = -vn / kn;
                        contact.normalImpulse += jn;
                        s.impulse.set(n.x * jn, n.y * jn, n.z * jn);
                        // Applying at an offset is what produces the angular kick on a corner hit
                        body.applyImpulse(s.impulse, r);
                    }
                }

                if (contact.normalImpulse <= 0) continue;

                // --- Coulomb friction along the contact plane ---
                // This scrubs speed off a scraped wall, and on a corner strike it is what
                // converts the drone's forward momentum into a tumble.
                const pointVel = this.contactPointVelocity(r);
                const vnNow = pointVel.dot(n);
                s.tangent.set(
                    pointVel.x - n.x * vnNow,
                    pointVel.y - n.y * vnNow,
                    pointVel.z - n.z * vnNow
                );

                const vtLen = s.tangent.length();
                if (vtLen <= 1e-4) continue;

                s.tangent.scale(1 / vtLen, s.tangent);
                const kt = this.effectiveMass(r, s.tangent);
                if (kt <= 1e-9) continue;

                // Impulse that would stop the slide outright, clamped to the friction cone
                const jt = Math.max(-vtLen / kt, -this.params.friction * contact.normalImpulse);
                s.impulse.set(s.tangent.x * jt, s.tangent.y * jt, s.tangent.z * jt);
                body.applyImpulse(s.impulse, r);
            }
        }

        // --- Pass 3: rolling resistance, the width of the contact patch ---
        // A manifold is solved as one point, which cannot oppose rotation about an axis running
        // through it - so a drone resting tilted would rock on its edge indefinitely, with nothing
        // absorbing the energy. A real patch of contact resists tipping across its own width, so
        // damp the rocking component of spin, bounded by how hard the surface is being pressed and
        // how far the contact points actually spread. A single-point contact spreads zero and so
        // resists nothing, and a hard crash is barely touched because the bound stays small.
        for (let i = 0; i < mCount; i++) {
            const m = this._manifolds[i];
            if (m.normalImpulse <= 0 || m.patchRadius <= 1e-6) continue;

            // Rocking = the part of the spin that is not about the surface normal
            const w = body.angularVelocity;
            const wn = w.dot(m.normal);
            s.tangent.set(w.x - m.normal.x * wn, w.y - m.normal.y * wn, w.z - m.normal.z * wn);

            const rockRate = s.tangent.length();
            if (rockRate <= 1e-6) continue;

            s.tangent.scale(1 / rockRate, s.tangent); // rocking axis

            // Angular impulse that would stop the rocking outright
            this.droneBody.invInertiaWorld.vmult(s.tangent, s.tmpA);
            const kRock = s.tangent.dot(s.tmpA);
            if (kRock <= 1e-9) continue;

            const stopRock = rockRate / kRock;
            const maxRock = this.params.friction * m.normalImpulse * m.patchRadius;
            const jRock = -Math.min(stopRock, maxRock);

            // Apply as a pure angular impulse: w += Iinv * (axis * jRock)
            s.impulse.set(s.tangent.x * jRock, s.tangent.y * jRock, s.tangent.z * jRock);
            this.droneBody.invInertiaWorld.vmult(s.impulse, s.tmpA);
            body.angularVelocity.vadd(s.tmpA, body.angularVelocity);
        }

        // --- Pass 4: the bounce, once per surface, at the manifold centroid ---
        // Applied after the approach has been stopped, so nothing cancels it, and placed at the
        // centroid so a square-on hit rebounds straight while a corner hit spins.
        for (let i = 0; i < mCount; i++) {
            const m = this._manifolds[i];
            if (m.closingSpeed <= 0) continue;

            const k = this.effectiveMass(m.r, m.normal);
            if (k <= 1e-9) continue;

            const j = (m.closingSpeed * this.params.restitution) / k;
            s.impulse.set(m.normal.x * j, m.normal.y * j, m.normal.z * j);
            body.applyImpulse(s.impulse, m.r);
        }

        return true;
    }

    updateConfig(config) {
        if (config.mass !== undefined) {
            this.params.mass = config.mass;
            this.droneBody.mass = config.mass;
            this.droneBody.updateMassProperties();
        }
        if (config.thrust !== undefined) this.params.maxThrust = config.thrust;
        if (config.drag !== undefined) {
            this.params.drag = config.drag;
            this.droneBody.linearDamping = config.drag;
            this.droneBody.angularDamping = config.drag;
        }
        if (config.restitution !== undefined) this.params.restitution = config.restitution;
        if (config.friction !== undefined) this.params.friction = config.friction;
        if (config.wind !== undefined) {
            this.params.wind = { ...this.params.wind, ...config.wind };
        }
        if (config.rates !== undefined) {
            for (let axis in config.rates) {
                if (this.params.rates[axis]) {
                    this.params.rates[axis] = { ...this.params.rates[axis], ...config.rates[axis] };
                }
            }
        }
    }

    // yawDegrees follows the same convention as the gates: 0 faces -Z, the way the airframe
    // points with an identity quaternion.
    setSpawn(x, y, z, yawDegrees = 0) {
        this.spawn.position.set(x, y, z);
        this.spawn.quaternion.setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0),
            -yawDegrees * Math.PI / 180
        );
    }

    reset() {
        // Reset position and velocity
        this.droneBody.position.copy(this.spawn.position);
        this.droneBody.quaternion.copy(this.spawn.quaternion);
        this.droneBody.velocity.set(0, 0, 0);
        this.droneBody.angularVelocity.set(0, 0, 0);
        // Re-seed the sweep origin, or the next sub-step would sweep from the pre-reset position
        this._prevPosition.copy(this.droneBody.position);
        this._inContact = false;
        this._contactCooldown = 0;
        // Start calm rather than mid-gust
        this._windState.roll = 0;
        this._windState.pitch = 0;
        this._windState.yaw = 0;
    }

    setInputs(axes, armed) {
        this.currentAxes = axes;
        this.isArmed = armed;
    }

    // A light, slowly shifting breeze. Each enabled body axis gets its own drifting torque,
    // small enough that the flight controller mostly holds it but you feel the drone wander.
    applyWind() {
        // A drone sitting on the ground or propped against a wall is held there by the surface.
        // Turbulence should only push it around once it is actually flying.
        if (this._inContact) return;

        const wind = this.params.wind;
        if (wind.strength <= 0) return;
        if (!wind.roll && !wind.pitch && !wind.yaw) return;

        const maxTorque = wind.strength * this.windMaxTorque * this.params.mass;

        // Advance one axis of the low-pass filtered noise and return its torque
        const gust = (axis, enabled) => {
            if (!enabled) {
                this._windState[axis] = 0;
                return 0;
            }
            const noise = (Math.random() * 2 - 1) * this._windGain;
            this._windState[axis] += this._windBlend * (noise - this._windState[axis]);
            // The filtered signal occasionally overshoots, so hold it inside the slider's range
            return Math.max(-1, Math.min(1, this._windState[axis])) * maxTorque;
        };

        // Local axes match applyInputsInternal: x = pitch, y = yaw, z = roll
        const localTorque = new CANNON.Vec3(
            gust('pitch', wind.pitch),
            gust('yaw', wind.yaw),
            gust('roll', wind.roll)
        );

        this.droneBody.applyTorque(this.droneBody.quaternion.vmult(localTorque));
    }

    applyInputsInternal(axes) {
        // Calculate thrust vector and apply locally at center of mass
        const thrustAmount = axes.throttle * this.params.maxThrust;
        const localThrust = new CANNON.Vec3(0, thrustAmount, 0);

        // Apply force exactly at the center of mass (0,0,0 local) to avoid unintended lever arm torque
        this.droneBody.applyLocalForce(localThrust, new CANNON.Vec3(0, 0, 0));

        // FPV Actual Rates (Betaflight style)
        // Interpolates between Center sensitivity and Max rate using Expo curve
        const degToRad = Math.PI / 180;

        const applyRate = (rcCommand, rateParams) => {
            const rcAbs = Math.abs(rcCommand);
            // 1. Exponential curve
            const expoValue = rcCommand * (1 - rateParams.expo) + Math.pow(rcCommand, 3) * rateParams.expo;
            // 2. Interpolation factor using SuperRate logic (SuperRate = 1 - Center/Max)
            const superRate = 1.0 - (rateParams.center / rateParams.max);
            const interpolationFactor = 1.0 - (rcAbs * superRate);
            // 3. Final rate in deg/s, converted to rad/s
            return ((rateParams.center * expoValue) / interpolationFactor) * degToRad;
        };

        const targetAngularVelocityLocal = new CANNON.Vec3(
            applyRate(axes.pitch, this.params.rates.pitch),
            applyRate(-axes.yaw, this.params.rates.yaw),
            applyRate(-axes.roll, this.params.rates.roll)
        );

        // Convert target angular velocity to world space
        const targetAngularVelocityWorld = this.droneBody.quaternion.vmult(targetAngularVelocityLocal);

        // Calculate angular velocity error
        const angularVelocityError = new CANNON.Vec3(
            targetAngularVelocityWorld.x - this.droneBody.angularVelocity.x,
            targetAngularVelocityWorld.y - this.droneBody.angularVelocity.y,
            targetAngularVelocityWorld.z - this.droneBody.angularVelocity.z
        );

        // Apply corrective torque (P-controller for gyro)
        // Tune pGain to control how snappy the drone stops and starts rotating.
        const pGain = 0.05;
        const correctiveTorque = new CANNON.Vec3(
            angularVelocityError.x * pGain,
            angularVelocityError.y * pGain,
            angularVelocityError.z * pGain
        );

        this.droneBody.applyTorque(correctiveTorque);
    }

    step(dt) {
        this.world.step(this.fixedTimeStep, dt, 20);
    }

    getDroneState() {
        return {
            position: this.droneBody.position,
            quaternion: this.droneBody.quaternion
        };
    }
}
