// Pilot interface for the fly/ pages: radio mapping (sticks, arm and reset on any switch or
// button), the on-screen sticks, flight settings, and keys. Saved in localStorage.
//
// A radio connected over USB is a joystick: sticks are axes, and switches are axes too (a
// three-position switch reads -1 / 0 / +1) or buttons. Arm and reset are therefore recorded as a
// *position*: the value the axis sits at when you hold the switch there, with a tolerance, so any
// position of a three-way switch can be "armed".
const MAP_KEY = 'tm.padmap.v2', SET_KEY = 'tm.flyset.v1';
const SW = new Set(['arm', 'reset', 'recover']);

// Flight settings with tiny-whoop defaults (1S, 65 mm, ducted, ~32 g).
export const SETTINGS = [
    // key, label, min, max, step, default
    ['twr', 'Thrust/weight', 1.6, 5, 0.1, 2.8],
    ['speed', 'Prop pitch speed (top speed), m/s', 6, 20, 0.5, 10],
    ['rate', 'Roll/pitch max rate, deg/s', 200, 900, 10, 520],
    ['yawRate', 'Yaw max rate, deg/s', 150, 700, 10, 380],
    ['center', 'Centre sensitivity, deg/s', 60, 250, 5, 130],
    ['expo', 'Expo', 0, 0.9, 0.05, 0.45],
    ['uptilt', 'Camera uptilt, deg', 0, 50, 1, 15],
];

// Mappings saved by the first version (tm.padmap.v1): sticks are the same; the arm switch was
// {axis, sign, mid} (armed past the midpoint), now {axis, value, rest}. Assumes a full-throw
// switch (the midpoint sits half a unit from both ends). No reset switch then.
function migrateV1() {
    const old = JSON.parse(localStorage.getItem('tm.padmap.v1') || 'null');
    if (!old) return null;
    const a = old.arm;
    if (a && a.button === undefined && a.mid !== undefined) old.arm = { axis: a.axis, value: a.mid + a.sign * 0.5, rest: a.mid - a.sign * 0.5 };
    localStorage.setItem(MAP_KEY, JSON.stringify(old));
    return old;
}

export class PilotUI {
    constructor({ input, onReset, onRecover, onLook, onSettings }) {
        this.onLook = onLook; this.input = input; this.onReset = onReset; this.onRecover = onRecover; this.onSettings = onSettings;
        this.map = JSON.parse(localStorage.getItem(MAP_KEY) || 'null') || migrateV1();
        this.set = Object.fromEntries(SETTINGS.map(([k, , , , , d]) => [k, d]));
        Object.assign(this.set, JSON.parse(localStorage.getItem(SET_KEY) || '{}'));
        this.wiz = null; this.armed = false; this.resetActive = false; this._resetWas = false; this.recoverActive = false; this._recoverWas = false;
        this.axes = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
        this._build();
        this._keys();
    }

    pad() { return [...(navigator.getGamepads?.() || [])].find((g) => g && g.axes.length >= 4) || null; }

    _build() {
        const css = document.createElement('style');
        css.textContent = `
        #pilot-panel { position: fixed; right: 12px; top: 10px; width: 340px; max-height: calc(100vh - 20px); overflow: auto; background: rgba(10,12,16,.9); border: 1px solid #444; padding: 12px 14px; display: none; font: 12px/1.4 ui-monospace, Menlo, monospace; color: #eee; }
        #pilot-panel.on { display: block; }
        #pilot-panel h3 { margin: 10px 0 6px; font-size: 13px; color: #9cf; }
        #pilot-panel h3:first-child { margin-top: 0; }
        #pilot-panel .step { color: #ffd27a; margin: 4px 0 8px; min-height: 2.8em; }
        #pilot-panel .ax { display: grid; grid-template-columns: 50px 1fr 64px; gap: 6px; align-items: center; margin: 2px 0; }
        #pilot-panel .bar { height: 8px; background: #333; position: relative; }
        #pilot-panel .bar i { position: absolute; top: 0; bottom: 0; background: #6cf; }
        #pilot-panel .tag { padding: 1px 6px; border-radius: 3px; }
        #pilot-panel .tag.live { background: #2fbf6a; color: #000; }
        #pilot-panel .tag.reset.live { background: #ff9f1a; }
        #pilot-panel .tag.recover.live { background: #3fa9ff; }
        #pilot-panel button { font: inherit; margin: 6px 6px 0 0; padding: 3px 9px; }
        #pilot-panel label { display: grid; grid-template-columns: 1fr 52px; gap: 4px 8px; margin: 3px 0; }
        #pilot-panel input[type=range] { grid-column: 1 / -1; width: 100%; }
        #pilot-sticks { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; gap: 26px; pointer-events: none; }
        #pilot-sticks .gimbal { width: 96px; height: 96px; border: 2px solid rgba(255,255,255,.55); border-radius: 10px; position: relative; background: rgba(0,0,0,.25); }
        #pilot-sticks .gimbal::before, #pilot-sticks .gimbal::after { content: ''; position: absolute; background: rgba(255,255,255,.18); }
        #pilot-sticks .gimbal::before { left: 50%; top: 6px; bottom: 6px; width: 1px; }
        #pilot-sticks .gimbal::after { top: 50%; left: 6px; right: 6px; height: 1px; }
        #pilot-sticks .dot { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #fff; box-shadow: 0 0 6px #000; }
        #pilot-status { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); font: 700 18px/1 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-shadow: 0 1px 3px #000; pointer-events: none; }
        #pilot-status .armed { color: #2fbf6a; } #pilot-status .disarmed { color: #ff5a4a; } #pilot-status .warn { color: #ffb000; }`;
        document.head.append(css);
        const p = document.createElement('div'); p.id = 'pilot-panel';
        p.innerHTML = `<h3>Controller</h3><div class="step"></div><div class="axes"></div>
            <button data-a="map">Map sticks + switches</button><button data-a="skip" hidden>Skip</button><button data-a="close">Close (M)</button>
            <h3>Flight</h3><div class="sets"></div><button data-a="defaults">Defaults</button>
            <h3>Keys</h3><div>Space reset, R recover (nearest floor), G lighting look, Enter arm (keyboard), ↑↓ camera tilt, C camera, M this panel<br>Keyboard flying: W/S throttle, A/D yaw, I/K pitch, J/L roll</div>`;
        document.body.append(p);
        this.panel = p; this.stepEl = p.querySelector('.step'); this.axesEl = p.querySelector('.axes');
        p.querySelector('[data-a=map]').onclick = () => this.startWizard();
        p.querySelector('[data-a=skip]').onclick = () => this._wizSkip();
        p.querySelector('[data-a=close]').onclick = () => p.classList.remove('on');
        p.querySelector('[data-a=defaults]').onclick = () => { SETTINGS.forEach(([k, , , , , d]) => { this.set[k] = d; }); this._saveSet(); this._drawSets(); };
        this._drawSets();
        if (!this.map) this.stepEl.textContent = 'Click "Map sticks + switches" and follow the prompts.';
        else this.stepEl.textContent = 'Mapped. Arm with your switch.';

        const s = document.createElement('div'); s.id = 'pilot-sticks';
        s.innerHTML = '<div class="gimbal"><div class="dot"></div></div><div class="gimbal"><div class="dot"></div></div>';
        document.body.append(s);
        this.dots = s.querySelectorAll('.dot');
        this.status = document.createElement('div'); this.status.id = 'pilot-status'; document.body.append(this.status);
    }

    _drawSets() {
        const box = this.panel.querySelector('.sets'); box.innerHTML = '';
        for (const [k, label, min, max, step] of SETTINGS) {
            const l = document.createElement('label');
            l.innerHTML = `<span>${label}</span><b>${this.set[k]}</b><input type="range" min="${min}" max="${max}" step="${step}" value="${this.set[k]}">`;
            const inp = l.querySelector('input'), b = l.querySelector('b');
            inp.oninput = () => { this.set[k] = Number(inp.value); b.textContent = inp.value; this._saveSet(); };
            box.append(l);
        }
    }
    _saveSet() { localStorage.setItem(SET_KEY, JSON.stringify(this.set)); this.onSettings?.(this.set); }

    _keys() {
        // Capture phase on window runs before InputHandler's own listeners, so Space can be taken
        // from it (it would toggle arm) and the arrows don't scroll.
        addEventListener('keydown', (e) => {
            if (e.target.closest?.('#pilot-panel')) return;
            if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) this.onReset?.('key'); }
            else if (e.code === 'KeyG') { e.preventDefault(); if (!e.repeat) this.onLook?.(); }
            else if (e.code === 'KeyR') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) this.onRecover?.('key'); }
            else if (e.code === 'Enter') { e.preventDefault(); if (!e.repeat) this.input.armed = !this.input.armed; }
            else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
                e.preventDefault(); e.stopImmediatePropagation();
                this.set.uptilt = Math.max(0, Math.min(50, this.set.uptilt + (e.code === 'ArrowUp' ? 2 : -2)));
                this._saveSet(); this._drawSets();
            } else if (e.code === 'KeyM') this.panel.classList.toggle('on');
        }, true);
    }

    // --- Mapping wizard ---
    startWizard() {
        const g = this.pad();
        if (!g) { this.stepEl.textContent = 'No controller seen. Move a stick so the browser notices it.'; this.panel.classList.add('on'); return; }
        this.wiz = { i: 0, map: {}, used: new Set(), base: [...g.axes], bbase: g.buttons.map((b) => b.value), ext: g.axes.map(() => 0), hold: null };
        this._wizPrompt();
    }
    static STEPS = [
        ['throttle', 'Move THROTTLE fully up, then back down to the bottom.'],
        ['yaw', 'Move YAW (left stick) fully RIGHT, then let it centre.'],
        ['pitch', 'Push PITCH (right stick) fully FORWARD, then let it centre.'],
        ['roll', 'Move ROLL (right stick) fully RIGHT, then let it centre.'],
        ['arm', 'Put your ARM switch in the ARMED position and hold it there for a second…'],
        ['reset', 'Optional: put a RESET switch/button in its active position and hold a second (or Skip).'],
        ['recover', 'Optional: put a RECOVER switch/button (respawn on the nearest floor) in its active position and hold a second (or Skip).'],
    ];
    _wizPrompt() {
        const [key, text] = PilotUI.STEPS[this.wiz.i];
        this.stepEl.textContent = `${this.wiz.i + 1}/${PilotUI.STEPS.length}  ${text}`;
        this.panel.querySelector('[data-a=skip]').hidden = key !== 'reset' && key !== 'recover';
    }
    _wizNext(g) {
        this.wiz.i++;
        this.wiz.base = [...g.axes]; this.wiz.bbase = g.buttons.map((b) => b.value); this.wiz.ext = g.axes.map(() => 0); this.wiz.hold = null;
        if (this.wiz.i >= PilotUI.STEPS.length) return this._wizDone();
        this._wizPrompt();
    }
    _wizSkip() { const g = this.pad(); if (this.wiz && g) this._wizNext(g); }
    _wizDone() {
        this.map = this.wiz.map; this.wiz = null;
        localStorage.setItem(MAP_KEY, JSON.stringify(this.map));
        this.stepEl.textContent = 'Saved. The ARM, RESET and RECOVER tags below light up when active.';
        this.panel.querySelector('[data-a=skip]').hidden = true;
    }
    _wizTick(g) {
        const w = this.wiz, [key] = PilotUI.STEPS[w.i];
        if (key === 'arm' || key === 'reset' || key === 'recover') {
            // A switch position: an axis (other than the sticks) or a button that moved and stayed.
            const now = performance.now();
            let src = null;
            g.buttons.forEach((b, k) => { if (!src && Math.abs(b.value - w.bbase[k]) > 0.5) src = { button: k }; });
            if (!src) g.axes.forEach((v, k) => { if (!src && !w.used.has(k) && Math.abs(v - w.base[k]) > 0.4) src = { axis: k, value: v }; });
            if (!src) { w.hold = null; return; }
            const same = w.hold && w.hold.src.button === src.button && w.hold.src.axis === src.axis && (src.axis === undefined || Math.abs(src.value - w.hold.src.value) < 0.1);
            if (!same) { w.hold = { src, t: now }; return; }
            if (now - w.hold.t > 700) {
                // `rest`: where it was before, so a momentary button / spring switch also works.
                w.map[key] = src.button !== undefined ? { button: src.button } : { axis: src.axis, value: src.value, rest: w.base[src.axis] };
                if (src.axis !== undefined && key === 'arm') w.used.add(src.axis);
                this._wizNext(g);
            }
            return;
        }
        g.axes.forEach((v, k) => { if (w.used.has(k)) return; const d = v - w.base[k]; if (Math.abs(d) > Math.abs(w.ext[k])) w.ext[k] = d; });
        let best = -1, bv = 0; w.ext.forEach((d, k) => { if (!w.used.has(k) && Math.abs(d) > Math.abs(bv)) { bv = d; best = k; } });
        if (Math.abs(bv) > 0.6 && Math.abs(g.axes[best] - w.base[best]) < 0.15) {
            w.map[key] = { axis: best, sign: Math.sign(bv) };
            w.used.add(best);
            this._wizNext(g);
        }
    }
    _active(m, g) {
        if (!m) return false;
        if (m.button !== undefined) return !!g.buttons[m.button]?.pressed;
        return Math.abs(g.axes[m.axis] - m.value) < Math.max(0.2, Math.abs(m.value - m.rest) * 0.4);
    }

    // Per frame: returns { axes, armed }, and fires onReset on the reset switch's rising edge.
    update() {
        this.input.update();
        let axes = this.input.getAxes(), armed = this.input.isArmed();
        const g = this.pad();
        if (g && !this.map && !this._autoOpened) { this.panel.classList.add('on'); this._autoOpened = true; }
        if (g && this.wiz) this._wizTick(g);
        else if (g && this.map?.throttle) {
            const m = this.map, ax = (s) => g.axes[s.axis] * s.sign, db = (v) => (Math.abs(v) < 0.02 ? 0 : v);
            axes = { throttle: Math.min(1, Math.max(0, (ax(m.throttle) + 1) / 2)), yaw: db(ax(m.yaw)), pitch: -db(ax(m.pitch)), roll: db(ax(m.roll)) };
            armed = m.arm ? this._active(m.arm, g) : armed;
            this.resetActive = this._active(m.reset, g);
            if (this.resetActive && !this._resetWas) this.onReset?.('switch');
            this._resetWas = this.resetActive;
            this.recoverActive = this._active(m.recover, g);
            if (this.recoverActive && !this._recoverWas) this.onRecover?.('switch');
            this._recoverWas = this.recoverActive;
        }
        this.axes = axes; this.armed = armed;
        this._draw(g);
        return { axes, armed };
    }

    _draw(g) {
        // Mode 2: left = yaw (x) / throttle (y), right = roll (x) / pitch (y, forward = up).
        const a = this.axes, put = (el, x, y) => { el.style.left = `${50 + x * 44}%`; el.style.top = `${50 - y * 44}%`; };
        put(this.dots[0], a.yaw, a.throttle * 2 - 1);
        put(this.dots[1], a.roll, -a.pitch);
        if (!this.panel.classList.contains('on')) return;
        if (!g) { this.axesEl.textContent = 'No controller seen yet (move a stick).'; return; }
        const m = this.map || {}, role = (k) => Object.entries(m).filter(([, s]) => s.axis === k).map(([r]) => r);
        const tag = (r) => {
            const live = (r === 'arm' && this.armed) || (r === 'reset' && this.resetActive) || (r === 'recover' && this.recoverActive);
            return `<span class="tag ${r} ${live ? 'live' : ''}">${r}</span>`;
        };
        let html = g.axes.map((v, k) => {
            const roles = role(k), isSwitch = roles.some((r) => SW.has(r));
            const bar = `<div class="bar"><i style="left:${50 + Math.min(0, v) * 50}%;width:${Math.abs(v) * 50}%"></i></div>`;
            return `<div class="ax"><span>axis ${k}</span>${bar}<span>${roles.map((r) => (SW.has(r) ? tag(r) : r)).join(' ')}</span></div>`;
        }).join('');
        const btns = Object.entries(m).filter(([, s]) => s.button !== undefined).map(([r, s]) => `button ${s.button}: ${tag(r)}`);
        if (btns.length) html += `<div>${btns.join(', ')}</div>`;
        this.axesEl.innerHTML = html + `<div style="opacity:.6">${g.id.slice(0, 44)}</div>`;
    }

    setStatus(html) { this.status.innerHTML = html; }
}
