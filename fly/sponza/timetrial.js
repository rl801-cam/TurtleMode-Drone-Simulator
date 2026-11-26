// Time trial on top of js/race.js's RaceManager (gate crossing and lap timing), following what
// race timers and sims do (research notes: MultiGP, RotorHazard, Velocidrone manual):
// - Start: three 440 Hz ticks a second apart, then a random 1-5 s hold, then GO (880 Hz, 0.7 s)
//   - RotorHazard's staging and start tones. The whoop is held until GO. Holeshot = GO to the
//   first start/finish crossing; the lap clock starts there (MultiGP). Runs are 3 laps.
// - Gates: square frames. Next gate bright and pulsing, the one after it dim cyan, passed gates
//   grey and faded, start/finish magenta with a chequered top bar; flying the next gate the
//   wrong way flashes it red and buzzes; an arrow at the screen edge points to an off-screen
//   next gate (Velocidrone's gate navigation).
// - The path ahead: a line from the last gate through the next two only, redrawn as you pass.
// - Sounds: gate tick 1 kHz with a pitch ladder; lap chime 660/990 Hz plus the time spoken;
//   best lap 1200/1800 Hz square (RotorHazard's leader tone) plus speech; finish pattern.
// - Best lap stored in the browser (per track): its split at every gate and its flight path,
//   replayed as a ghost whoop. Each gate flashes the delta to the best lap's split.
import * as THREE from 'three/webgpu';
import { formatTime } from '../../js/tracks.js?v=36';
import { linePoints, LEAD } from './track.js';

const C = { next: 0xff7a00, after: 0x00d5ff, idle: 0x00d5ff, passed: 0x5a5a5a, start: 0xff2fb3, wrong: 0xff2020 };
const secs = (ms) => (ms / 1000).toFixed(1);
const say = (text) => {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.1; speechSynthesis.speak(u); } catch { /* no speech */ }
};

export class TimeTrial {
    constructor({ scene, race, track, camera, getAudio, isFake = false }) {
        this.race = race; this.track = track; this.camera = camera; this.getAudio = getAudio;
        this.laps = track.laps || 3;
        this.group = race.group;
        this.bestKey = `tm.sponza.best.${track.id}`;
        try { this.best = JSON.parse(localStorage.getItem(this.bestKey) || 'null'); } catch { this.best = null; }
        this._buildGates();
        this._buildHud();
        this.ghostMesh = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, 0.075), new THREE.MeshBasicNodeMaterial({ color: 0xff9a3a, transparent: true, opacity: 0.55, depthWrite: false }));
        this.ghostMesh.visible = false; this.group.add(this.ghostMesh);
        this.pathMesh = null; this._pathFor = -2;
        this.reset();
        this.isFake = isFake;
    }

    // --- gates ---------------------------------------------------------------------------
    _buildGates() {
        const half = this.track.gateRadius, bar = 0.045, o = half + bar / 2;
        const frameGeo = () => {
            const parts = [
                new THREE.BoxGeometry(2 * half + 2 * bar, bar, bar).translate(0, o, 0),
                new THREE.BoxGeometry(2 * half + 2 * bar, bar, bar).translate(0, -o, 0),
                new THREE.BoxGeometry(bar, 2 * half, bar).translate(o, 0, 0),
                new THREE.BoxGeometry(bar, 2 * half, bar).translate(-o, 0, 0),
            ];
            const pos = [], idx = []; let base = 0;
            for (const p of parts) { const ni = p.index.array, pa = p.attributes.position.array; pos.push(...pa); for (const k of ni) idx.push(k + base); base += pa.length / 3; p.dispose(); }
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); return g;
        };
        // Chequered top bar for start/finish.
        const cv = document.createElement('canvas'); cv.width = 64; cv.height = 8;
        const cx = cv.getContext('2d');
        for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { cx.fillStyle = (i + j) % 2 ? '#111' : '#fff'; cx.fillRect(i * 4, j * 4, 4, 4); }
        const chk = new THREE.CanvasTexture(cv); chk.colorSpace = THREE.SRGBColorSpace; chk.magFilter = THREE.NearestFilter;
        for (const g of this.race.gates) {
            g.mesh.geometry.dispose();
            g.mesh.geometry = frameGeo();
            g.mesh.material.dispose();
            g.mesh.material = new THREE.MeshBasicNodeMaterial({ color: C.idle, transparent: true, opacity: 1 });
            // RaceManager orients the mesh's +Z onto the gate normal; keep the frame upright.
            const n = g.normal, up = new THREE.Vector3(0, 1, 0), x = new THREE.Vector3().crossVectors(up, n).normalize(), y = new THREE.Vector3().crossVectors(n, x);
            g.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
            g.label.scale.setScalar(0.22);
            g.label.position.copy(g.position).add(y.clone().multiplyScalar(half + 0.2));
            if (g.index === 0) {
                const top = new THREE.Mesh(new THREE.BoxGeometry(2 * half + 2 * bar + 0.002, bar + 0.012, bar + 0.012), new THREE.MeshBasicNodeMaterial({ map: chk }));
                top.position.set(0, o, 0); g.mesh.add(top);
            }
            g.wrongUntil = 0;
        }
    }

    _colour(now) {
        const n = this.race.nextGate, N = this.race.gates.length, racing = this.stage === 'racing';
        const pulse = 0.75 + 0.25 * Math.sin(now * 0.0063); // ~1 Hz
        for (const g of this.race.gates) {
            const m = g.mesh.material; let col, op = 1, s = 1;
            if (now < g.wrongUntil) { col = C.wrong; }
            else if (g.index === n && this.stage !== 'done') { col = g.index === 0 ? C.start : C.next; op = pulse; s = 1 + 0.03 * Math.sin(now * 0.0063); }
            else if (g.index === (n + 1) % N && this.stage !== 'done') { col = C.after; op = 0.45; }
            else if (racing && g.index < n && g.index !== 0) { col = C.passed; op = 0.2; }
            else if (g.index === 0) { col = C.start; op = 0.7; }
            else { col = C.idle; op = 0.25; }
            m.color.setHex(col); m.opacity = op; g.mesh.scale.setScalar(s);
            g.label.material.opacity = g.index === n ? 1 : 0.3;
        }
    }

    // The path ahead: from the last gate (or the drone, before the start) through the next two.
    _path(pos) {
        const n = this.race.nextGate;
        if (this._pathFor === n && this.pathMesh) return;
        this._pathFor = n;
        if (this.pathMesh) { this.group.remove(this.pathMesh); this.pathMesh.geometry.dispose(); }
        const G = this.race.gates, N = G.length;
        const from = this.stage === 'racing' || this.stage === 'done' ? G[(n - 1 + N) % N].position.clone().addScaledVector(G[(n - 1 + N) % N].normal, LEAD) : new THREE.Vector3(pos.x, pos.y, pos.z);
        // The same flown line as the course check: via points (corners), lead-in, gate, lead-out.
        const started = this.stage === 'racing' || this.stage === 'done';
        // Before the start the line runs from the whoop straight to the first gate (its corner
        // via points lie behind the spawn).
        const raw = this.track.gates.map((g, i) => ({ ...g, _i: i, via: !started && i === n ? [] : g.via }));
        const pts = [from, ...linePoints(raw, THREE.Vector3, (g) => G[g._i].normal, n, 2)];
        // Before the start, begin a third of the way to the first gate, not at the camera.
        if (!started) pts[0].lerp(pts[1], 0.35);
        const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
        this.pathMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.009, 5, false),
            new THREE.MeshBasicNodeMaterial({ color: 0xffa040, transparent: true, opacity: 0.4, depthWrite: false }));
        this.group.add(this.pathMesh);
    }

    // --- sound ---------------------------------------------------------------------------
    _tone(f, at, len, { type = 'sine', gain = 0.3, fade = 0.02 } = {}) {
        const ctx = this.getAudio(); if (!ctx) return;
        const t0 = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
        g.gain.setValueAtTime(gain, t0 + Math.max(0.006, len - fade)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
        o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + len + 0.02);
    }
    // The gate and lap sounds: short soft sine blips (each note [Hz, start s, length s]).
    _blip(notes) {
        const ctx = this.getAudio(); if (!ctx) return;
        const t0 = ctx.currentTime;
        for (const [f, at, len] of notes) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
            o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + len + 0.02);
        }
    }
    _buzz() {
        const ctx = this.getAudio(); if (!ctx) return;
        const t0 = ctx.currentTime, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = 180; f.type = 'lowpass'; f.frequency.value = 800;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(f).connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.25);
    }

    // --- HUD -----------------------------------------------------------------------------
    _buildHud() {
        const css = document.createElement('style');
        css.textContent = `
#tt { position: fixed; top: 34px; left: 50%; transform: translateX(-50%); z-index: 5; text-align: center; pointer-events: none;
  font: 13px/1.35 system-ui, sans-serif; color: #e8e8e8; text-shadow: 0 1px 2px #000, 0 0 6px #000; font-variant-numeric: tabular-nums; }
#tt .t { font: 700 30px/1.1 system-ui, sans-serif; letter-spacing: 0.5px; color: #fff; }
#tt .r { color: #cfcfcf; } #tt .r b { color: #fff; font-weight: 600; }
#tt .d { font: 700 22px/1.2 system-ui, sans-serif; } #tt .d.ok { color: #3ad16f; } #tt .d.bad { color: #ff5a4a; }
#tt .big { font: 800 56px/1 system-ui, sans-serif; color: #fff; margin-top: 2vh; }
#tt .res { margin-top: 10px; background: rgba(20,20,20,0.85); border: 1px solid #000; padding: 10px 16px; text-align: left; min-width: 220px; }
#tt .res div { display: flex; justify-content: space-between; gap: 24px; }
#tt-arrow { position: fixed; left: 50%; top: 50%; width: 0; height: 0; z-index: 5; pointer-events: none;
  border-left: 14px solid transparent; border-right: 14px solid transparent; border-bottom: 26px solid #ff7a00; filter: drop-shadow(0 0 3px #000); display: none; }`;
        document.head.appendChild(css);
        this.el = document.createElement('div'); this.el.id = 'tt'; document.body.appendChild(this.el);
        this.arrow = document.createElement('div'); this.arrow.id = 'tt-arrow'; document.body.appendChild(this.arrow);
    }

    _hud(now) {
        const r = this.race, st = r.status(), N = r.gates.length;
        let h = '';
        if (this.stage === 'idle') h = `<div class="t">Arm to start</div><div class="r">${this.track.name}, ${this.laps} laps</div>`;
        else if (this.stage === 'countdown') h = `<div class="big">${this.count > 0 ? this.count : ''}</div>`;
        else {
            const lapNo = Math.min(st.lap, this.laps);
            const t = r.state === 'RACING' && this.stage === 'racing' ? formatTime(st.currentMs) : this.stage === 'done' ? formatTime(this.total) : formatTime(now - this.goAt);
            h = `<div class="t">${t}</div><div class="r">Lap <b>${lapNo}/${this.laps}</b>   Gate <b>${st.nextGate}/${N}</b></div>`
                + `<div class="r">Last <b>${formatTime(st.lastMs)}</b>   Best <b>${formatTime(this.best?.ms ?? NaN)}</b></div>`;
            if (this.holeshot != null) h += `<div class="r">Holeshot <b>${(this.holeshot / 1000).toFixed(2)}</b></div>`;
            if (this.delta && now < this.delta.until) h += `<div class="d ${this.delta.d <= 0 ? 'ok' : 'bad'}">${this.delta.d < 0 ? '-' : '+'}${(Math.abs(this.delta.d) / 1000).toFixed(2)}</div>`;
            if (this.stage === 'go' && now - this.goAt < 800) h += '<div class="big">GO</div>';
            if (this.stage === 'done') {
                h += `<div class="res">${this.lapTimes.map((ms, i) => `<div><span>Lap ${i + 1}</span><b>${formatTime(ms)}</b></div>`).join('')}`
                    + `<div><span>Total</span><b>${formatTime(this.total)}</b></div><div><span>Best lap</span><b>${formatTime(Math.min(...this.lapTimes))}</b></div>`
                    + `<div><span>Space</span><span>restart</span></div></div>`;
            }
        }
        if (h !== this._lastHud) { this.el.innerHTML = h; this._lastHud = h; }
        // Off-screen next gate: arrow at the screen edge.
        const ang = this.stage === 'done' ? null : r.pointerAngle(this.camera);
        if (ang === null) this.arrow.style.display = 'none';
        else {
            const R = Math.min(innerWidth, innerHeight) * 0.3; // clear of the timer at the top
            this.arrow.style.display = 'block';
            this.arrow.style.transform = `translate(${Math.sin(ang) * R - 14}px, ${-Math.cos(ang) * R - 13}px) rotate(${ang}rad)`;
        }
    }

    // --- run -----------------------------------------------------------------------------
    reset() {
        this.race.resetRun();
        this.stage = 'idle'; this.count = 0; this.goAt = 0; this.holeshot = null; this.lapTimes = []; this.total = 0;
        this.delta = null; this.splits = []; this.path = []; this._pathFor = -2; this._hadArm = false;
        try { speechSynthesis.cancel(); } catch { /* */ }
    }

    get holding() { return this.stage === 'countdown'; }

    // Per frame, after physics. Returns nothing; read `holding` to keep the whoop on the ground.
    update(dt, now, pos, armed) {
        const r = this.race;
        if (this.stage === 'idle') {
            // Start on arming (a fresh arm, so a run doesn't start by itself after a reset).
            if (this._hadArm === false && armed) { this.stage = 'countdown'; this.t0 = now; this.ticks = 0; this.hold = 1000 + Math.random() * 4000; }
            this._hadArm = armed;
        }
        if (this.stage === 'countdown') {
            const e = now - this.t0;
            while (this.ticks < 3 && e >= this.ticks * 1000) { this._tone(440, 0, 0.1, { type: 'triangle', gain: 0.35 }); this.ticks++; this.count = 4 - this.ticks; }
            if (e >= 2000 + 400) this.count = 0; // after the third tick: an unpredictable hold
            if (e >= 2000 + this.hold) { this.stage = 'go'; this.goAt = now; this._tone(880, 0, 0.7, { type: 'triangle', gain: 0.4, fade: 0.25 }); }
        }
        if (this.stage === 'go' || this.stage === 'racing') {
            const next = r.gates[r.nextGate], prevD = this._prevD;
            r.update(pos, dt);
            // Wrong way through the next gate: flash it red and buzz.
            const d = (pos.x - next.position.x) * next.normal.x + (pos.y - next.position.y) * next.normal.y + (pos.z - next.position.z) * next.normal.z;
            if (prevD !== undefined && prevD > 0 && d <= 0 && next.position.distanceTo(pos) < this.track.gateRadius * 1.5 && now > next.wrongUntil) { next.wrongUntil = now + 600; this._buzz(); }
            this._prevD = r.gates[r.nextGate] === next ? d : undefined;
            for (const e of r.consumeEvents()) this._event(e, now);
            if (this.stage === 'racing') {
                const ms = r.currentLapMs;
                const l = this.path[this.path.length - 1];
                if (!l || ms - l[3] > 40) this.path.push([+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3), Math.round(ms)]);
                this._ghost(ms);
            }
        }
        this._colour(now);
        this._path(pos);
        this._hud(now);
    }

    _ghost(ms) {
        const p = this.best?.path;
        if (!p || p.length < 2) { this.ghostMesh.visible = false; return; }
        let i = this._gi && p[this._gi]?.[3] <= ms ? this._gi : 0;
        while (i < p.length - 2 && p[i + 1][3] < ms) i++;
        this._gi = i;
        const a = p[i], b = p[i + 1], f = Math.min(1, Math.max(0, (ms - a[3]) / Math.max(1, b[3] - a[3])));
        this.ghostMesh.position.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
        this.ghostMesh.visible = ms <= p[p.length - 1][3];
    }

    _event(e, now) {
        if (e.type === 'start') {
            this.stage = 'racing'; this.holeshot = now - this.goAt; this.splits = []; this.path = []; this._gi = 0;
            this._blip([[1320, 0, 0.07]]);
        } else if (e.type === 'gate') {
            const t = this.race.currentLapMs, b = this.best?.splits?.[this.splits.length];
            this.splits.push(Math.round(t));
            this.delta = b != null ? { d: t - b, until: now + 1500 } : null;
            this._blip([[1320, 0, 0.07]]);
        } else if (e.type === 'lap') {
            this.lapTimes.push(e.ms);
            const prev = this.best?.ms, isBest = prev == null || e.ms < prev;
            this.delta = prev != null ? { d: e.ms - prev, until: now + 2500 } : null;
            if (isBest) {
                this.best = { ms: e.ms, splits: this.splits.slice(), path: this.path.slice() };
                try { localStorage.setItem(this.bestKey, JSON.stringify(this.best)); } catch { /* storage full */ }
            }
            this.splits = []; this.path = []; this._gi = 0;
            if (this.lapTimes.length >= this.laps) {
                this.stage = 'done'; this.total = this.lapTimes.reduce((a, b) => a + b, 0);
                [[1200, 0, 0.05], [1800, 0.05, 0.075], [1200, 0.15, 0.05], [1800, 0.2, 0.075], [1200, 0.3, 0.05], [1800, 0.35, 0.1]].forEach(([f, at, len]) => this._tone(f, at, len, { type: 'square', gain: 0.12 }));
                say(`Race complete. Total ${secs(this.total)}. Best lap ${secs(Math.min(...this.lapTimes))}`);
            } else if (isBest) {
                this._blip([[988, 0, 0.1], [1319, 0.1, 0.1], [1760, 0.2, 0.18]]);
                say(`Best lap, ${secs(e.ms)}`);
            } else {
                this._blip([[1319, 0, 0.08], [1319, 0.12, 0.12]]);
                say(`Lap ${this.lapTimes.length}, ${secs(e.ms)}`);
            }
        }
    }
}
