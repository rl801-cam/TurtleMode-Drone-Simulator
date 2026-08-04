// race.js - Race timing, gate detection and the persistent leaderboard.

import * as THREE from 'three';

// Gate colours by state. Emissive rather than lit, so a gate reads the same from any angle
// and at any distance - you are meant to be able to pick the next one out of the clutter.
const GATE_COLORS = {
    next: 0x00ffcc,
    upcoming: 0x1d5f6b,
    passed: 0x30303a,
    start: 0xff3366
};

const MAX_STORED = 25;
const LEADERBOARD_SHOWN = 10;

// A torus is built with its hole along +Z, so a gate is oriented by rotating this onto the
// direction of travel. Shared and never mutated.
const TORUS_AXIS = new THREE.Vector3(0, 0, 1);

export class Leaderboard {
    constructor(trackId) {
        this.key = `turtlemode.leaderboard.${trackId}`;
    }

    entries() {
        try {
            const raw = JSON.parse(localStorage.getItem(this.key) || '[]');
            if (!Array.isArray(raw)) return [];
            // Guard against a hand-edited or half-written store rather than trusting it
            return raw
                .filter((e) => e && typeof e.ms === 'number' && Number.isFinite(e.ms) && e.ms > 0)
                .sort((a, b) => a.ms - b.ms)
                .slice(0, MAX_STORED);
        } catch (err) {
            console.warn('Leaderboard could not be read, starting empty:', err);
            return [];
        }
    }

    // One row per pilot, holding their fastest lap - otherwise a single good session buries
    // everyone else under fourteen near-identical times. Returns the 1-based position the
    // pilot now holds (0 if the lap did not make the table at all) and whether this lap
    // actually improved on what they had.
    submit(pilot, ms) {
        const name = (pilot || 'PILOT').slice(0, 16);
        const key = name.toUpperCase();
        const list = this.entries();
        const existing = list.find((e) => String(e.name).toUpperCase() === key);

        if (existing && existing.ms <= ms) {
            return { rank: list.indexOf(existing) + 1, improved: false };
        }

        const entry = { name, ms, date: Date.now() };
        const merged = list.filter((e) => e !== existing);
        merged.push(entry);
        merged.sort((a, b) => a.ms - b.ms);
        const trimmed = merged.slice(0, MAX_STORED);

        try {
            localStorage.setItem(this.key, JSON.stringify(trimmed));
        } catch (err) {
            console.warn('Leaderboard could not be saved:', err);
        }

        return { rank: trimmed.indexOf(entry) + 1, improved: true };
    }

    clear() {
        localStorage.removeItem(this.key);
    }

    best() {
        const list = this.entries();
        return list.length ? list[0].ms : null;
    }

    top(n = LEADERBOARD_SHOWN) {
        return this.entries().slice(0, n);
    }
}

export class RaceManager {
    constructor(renderer) {
        this.renderer = renderer;
        this.track = null;
        this.leaderboard = null;
        this.pilotName = localStorage.getItem('pilotName') || 'PILOT';

        this.gates = []; // { position, normal, radius, mesh, label }
        this.group = new THREE.Group();
        // Deliberately parented to the scene and not to the renderer's environmentGroup: the
        // collision BVH is built from that group, and a gate you can crash into turns a racing
        // line into a lottery. The rings are markers, nothing more.
        this.renderer.scene.add(this.group);

        this.resetRun();

        // Reused per frame so gate detection allocates nothing
        this._prev = new THREE.Vector3();
        this._d = new THREE.Vector3();
        this._hit = new THREE.Vector3();
        this._radial = new THREE.Vector3();
        this._camLocal = new THREE.Vector3();

        this.events = [];
    }

    // Lets the menus show and clear a board for a track that is not loaded yet
    leaderboardFor(trackId) {
        if (this.leaderboard && this.track && this.track.id === trackId) return this.leaderboard;
        return new Leaderboard(trackId);
    }

    setPilotName(name) {
        this.pilotName = (name || '').trim().slice(0, 16) || 'PILOT';
        localStorage.setItem('pilotName', this.pilotName);
    }

    // --- track setup -------------------------------------------------------

    setTrack(track) {
        this.clearTrack();
        this.track = track;
        this.leaderboard = new Leaderboard(track.id);

        track.gates.forEach((g, i) => {
            // Gates squeezed into a hole in the map carry their own radius; the rest take the
            // track default.
            const radius = Number.isFinite(g.radius) ? g.radius : track.gateRadius;
            const yaw = THREE.MathUtils.degToRad(g.yaw);
            // `pitch` tilts the direction of travel out of the horizontal, so a gate can lie flat
            // in a hatch and be taken on the way up or down. Absent on ordinary gates.
            const pitch = THREE.MathUtils.degToRad(g.pitch || 0);
            const position = new THREE.Vector3(g.x, g.y, g.z);
            const normal = new THREE.Vector3(
                Math.sin(yaw) * Math.cos(pitch),
                Math.sin(pitch),
                -Math.cos(yaw) * Math.cos(pitch)
            );

            const mesh = new THREE.Mesh(
                new THREE.TorusGeometry(radius, 0.12, 8, 40),
                new THREE.MeshBasicMaterial({ color: GATE_COLORS.upcoming, fog: false })
            );
            mesh.position.copy(position);
            // Roll about the normal is free - a torus looks the same either way - so lining the
            // hole up with the normal is the whole of the orientation.
            mesh.quaternion.setFromUnitVectors(TORUS_AXIS, normal);
            this.group.add(mesh);

            const label = this.createLabel(i === 0 ? 'S/F' : String(i + 1));
            // Clear the top of the ring by its actual vertical extent, which collapses to nothing
            // once the gate is lying flat.
            const halfHeight = radius * Math.sqrt(Math.max(0, 1 - normal.y * normal.y));
            label.position.set(position.x, position.y + halfHeight + 0.9, position.z);
            this.group.add(label);

            this.gates.push({ name: g.name, position, normal, radius, mesh, label, index: i });
        });

        this.resetRun();
        this.refreshGateColors();
    }

    createLabel(text) {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 72px Orbitron, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, size / 2, size / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            fog: false
        }));
        sprite.scale.set(1.6, 1.6, 1.6);
        // Drawn after the world so a marker is never lost behind a pillar
        sprite.renderOrder = 10;
        return sprite;
    }

    clearTrack() {
        for (const gate of this.gates) {
            gate.mesh.geometry.dispose();
            gate.mesh.material.dispose();
            gate.label.material.map.dispose();
            gate.label.material.dispose();
        }
        this.group.clear();
        this.gates = [];
        this.track = null;
    }

    setVisible(visible) {
        this.group.visible = visible;
    }

    // --- run state ---------------------------------------------------------

    // ARMED  - waiting for the first crossing of the start gate to begin timing
    // RACING - the clock is running
    resetRun() {
        this.state = 'ARMED';
        this.nextGate = 0;
        this.clock = 0;      // seconds since the timer started
        this.lapStart = 0;   // clock value the current lap began at
        this.laps = [];      // completed lap times, ms
        this.bestMs = null;
        this.lastMs = null;
        this.hasPrev = false;
        this.events = [];
        this.refreshGateColors();
    }

    get storedBest() {
        return this.leaderboard ? this.leaderboard.best() : null;
    }

    // --- per-frame ---------------------------------------------------------

    // `position` must be the live physics position, never the delayed video feed - the clock
    // times the drone, not the picture.
    update(position, dt) {
        if (!this.track || this.gates.length === 0) return;

        if (!this.hasPrev) {
            this._prev.copy(position);
            this.hasPrev = true;
            return;
        }

        const crossing = this.testGate(this.nextGate, this._prev, position);
        if (this.state === 'RACING') this.clock += dt;

        if (crossing !== null) {
            const gate = this.gates[this.nextGate];

            if (this.state === 'ARMED') {
                // The clock starts the instant the drone crosses the start gate, so the part
                // of this frame that happened before the crossing does not count.
                this.state = 'RACING';
                this.clock = dt * (1 - crossing);
                this.lapStart = 0;
                this.events.push({ type: 'start' });
            } else {
                const crossAt = this.clock - dt * (1 - crossing);
                if (this.nextGate === 0) {
                    const lapMs = (crossAt - this.lapStart) * 1000;
                    this.lapStart = crossAt;
                    this.completeLap(lapMs);
                } else {
                    this.events.push({ type: 'gate', index: gate.index, name: gate.name });
                }
            }

            this.nextGate = (this.nextGate + 1) % this.gates.length;
            this.refreshGateColors();
        }

        this._prev.copy(position);
    }

    completeLap(lapMs) {
        this.laps.push(lapMs);
        this.lastMs = lapMs;
        const isBest = this.bestMs === null || lapMs < this.bestMs;
        if (isBest) this.bestMs = lapMs;

        const previousBest = this.storedBest;
        const result = this.leaderboard
            ? this.leaderboard.submit(this.pilotName, lapMs)
            : { rank: 0, improved: false };

        this.events.push({
            type: 'lap',
            lap: this.laps.length,
            ms: lapMs,
            rank: result.rank,
            improved: result.improved,
            record: previousBest === null || lapMs < previousBest,
            personalBest: isBest
        });
    }

    // Returns the fraction along prev->now at which the drone passed through the ring, or null.
    // The crossing has to run along the gate normal, so cutting back through a gate you have
    // already taken never counts as taking it again.
    testGate(index, prev, now) {
        const gate = this.gates[index];
        const n = gate.normal;
        const d0 = (prev.x - gate.position.x) * n.x + (prev.y - gate.position.y) * n.y + (prev.z - gate.position.z) * n.z;
        const d1 = (now.x - gate.position.x) * n.x + (now.y - gate.position.y) * n.y + (now.z - gate.position.z) * n.z;

        if (d0 >= 0 || d1 < 0) return null;

        const t = d0 / (d0 - d1);
        this._hit.set(
            prev.x + (now.x - prev.x) * t,
            prev.y + (now.y - prev.y) * t,
            prev.z + (now.z - prev.z) * t
        );
        this._radial.subVectors(this._hit, gate.position);
        // Strip the normal component; what is left is the offset within the ring's own plane
        const along = this._radial.dot(n);
        this._radial.addScaledVector(n, -along);

        return this._radial.length() <= gate.radius ? t : null;
    }

    refreshGateColors() {
        for (const gate of this.gates) {
            let color;
            if (gate.index === this.nextGate) {
                color = GATE_COLORS.next;
            } else if (gate.index === 0) {
                color = GATE_COLORS.start;
            } else {
                // Gates already taken this lap fade back; the ones still to come stay readable
                const taken = this.state === 'RACING' && gate.index < this.nextGate;
                color = taken ? GATE_COLORS.passed : GATE_COLORS.upcoming;
            }
            gate.mesh.material.color.setHex(color);
            gate.label.material.opacity = gate.index === this.nextGate ? 1 : 0.35;
        }
    }

    // Slow pulse on the gate you are heading for, so it stands out against the map
    animate(now) {
        if (!this.gates.length) return;
        const gate = this.gates[this.nextGate];
        const pulse = 1 + Math.sin(now * 0.005) * 0.04;
        for (const g of this.gates) {
            const s = g === gate ? pulse : 1;
            g.mesh.scale.set(s, s, s);
        }
    }

    // --- readouts ----------------------------------------------------------

    get currentLapMs() {
        return this.state === 'RACING' ? (this.clock - this.lapStart) * 1000 : 0;
    }

    nextGatePosition() {
        return this.gates.length ? this.gates[this.nextGate].position : null;
    }

    distanceToNextGate(position) {
        const target = this.nextGatePosition();
        return target ? target.distanceTo(position) : 0;
    }

    // Where the next gate sits relative to where the camera is looking, as an angle in
    // radians for a screen-space pointer. Returns null when the gate is already comfortably
    // ahead and the pointer would just be clutter.
    pointerAngle(camera) {
        const target = this.nextGatePosition();
        if (!target) return null;

        // In FPV the camera hangs off the drone mesh, and its world matrix is only refreshed
        // during render - without this the pointer would lag the airframe by a frame.
        camera.updateWorldMatrix(true, false);
        this._camLocal.copy(target);
        camera.worldToLocal(this._camLocal);

        const ahead = -this._camLocal.z;
        if (ahead > 0) {
            // Roughly within the middle of the view - no arrow needed
            const spread = Math.max(Math.abs(this._camLocal.x), Math.abs(this._camLocal.y));
            if (spread / ahead < 0.35) return null;
        }

        // Screen up is +y in camera space; measuring from up keeps the CSS rotation trivial
        const x = this._camLocal.x;
        const y = ahead > 0 ? this._camLocal.y : -this._camLocal.y;
        const sx = ahead > 0 ? x : -x;
        return Math.atan2(sx, y);
    }

    status() {
        return {
            state: this.state,
            lap: this.laps.length + 1,
            nextGate: this.nextGate + 1,
            gateCount: this.gates.length,
            currentMs: this.currentLapMs,
            lastMs: this.lastMs,
            bestMs: this.bestMs,
            recordMs: this.storedBest
        };
    }

    consumeEvents() {
        const out = this.events;
        this.events = [];
        return out;
    }
}
