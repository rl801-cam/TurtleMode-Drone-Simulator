// Pilot interface for the fly/ pages: the M menu (controller mapping, rates, flight, keys), the
// on-screen sticks and the status line. Saved in localStorage.
//
// A radio connected over USB is a joystick: sticks are axes, and switches are axes too (a
// three-position switch reads -1 / 0 / +1) or buttons. Arm and reset are therefore recorded as a
// *position*: the value the axis sits at when you hold the switch there, with a tolerance, so any
// position of a three-way switch can be "armed".
const MAP_KEY = 'tm.padmap.v2', SET_KEY = 'tm.flyset.v1';
const SW = new Set(['arm', 'reset', 'recover']);

// Betaflight "Actual" rates, per axis: centre sensitivity and max rate in deg/s, expo 0..1.
// Same maths as the physics engine, so the graph shows exactly what the sim flies.
export const AXES = [['roll', 'Roll', '#df4760'], ['pitch', 'Pitch', '#97da01'], ['yaw', 'Yaw', '#21b1f0']];
export function rateAt(x, { center, max, expo }) {
    const a = Math.abs(x), e = x * (1 - expo) + x * x * x * expo, sr = 1 - center / max;
    return (center * e) / (1 - a * sr);
}

// Flight settings with tiny-whoop defaults (1S, 65 mm, ducted, ~32 g).
export const SETTINGS = [
    // key, label, min, max, step, default, unit
    ['twr', 'Thrust/weight', 1.6, 5, 0.1, 2.8, ''],
    ['speed', 'Top speed', 6, 20, 0.5, 10, 'm/s'],
    ['uptilt', 'Camera uptilt', 0, 50, 1, 15, 'deg'],
];
// Per-axis rate settings: rollCenter, rollMax, rollExpo, pitchCenter, ..., yawExpo.
export const RATE_FIELDS = [['Center', 'Center', 10, 400, 5, 130], ['Max', 'Max', 100, 1200, 10, 520], ['Expo', 'Expo', 0, 1, 0.05, 0.45]];
const rk = (axis, f) => axis + f; // 'roll' + 'Center'
const RATE_DEFAULTS = {};
for (const [axis] of AXES) for (const [f, , , , , d] of RATE_FIELDS) RATE_DEFAULTS[rk(axis, f)] = axis === 'yaw' && f === 'Max' ? 380 : d;
export const rates = (set) => Object.fromEntries(AXES.map(([axis]) => [axis, { center: set[rk(axis, 'Center')], max: set[rk(axis, 'Max')], expo: set[rk(axis, 'Expo')] }]));

// Settings saved before the per-axis rates: rate (roll and pitch max), yawRate, center, expo.
function loadSettings() {
    const set = Object.fromEntries(SETTINGS.map(([k, , , , , d]) => [k, d]));
    Object.assign(set, RATE_DEFAULTS);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {}; } catch { /* keep defaults */ }
    const old = { Center: saved.center, Expo: saved.expo };
    for (const [axis] of AXES) {
        if (old.Center !== undefined) set[rk(axis, 'Center')] = old.Center;
        if (old.Expo !== undefined) set[rk(axis, 'Expo')] = old.Expo;
    }
    if (saved.rate !== undefined) set.rollMax = set.pitchMax = saved.rate;
    if (saved.yawRate !== undefined) set.yawMax = saved.yawRate;
    for (const k of Object.keys(set)) if (typeof saved[k] === 'number' && Number.isFinite(saved[k])) set[k] = saved[k];
    return set;
}

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

const CSS = `
#pilot-panel { --bg: #212121; --hd: #2b2b2b; --in: #151515; --line: #3a3a3a; --fg: #f0f0f0; --dim: #aaa; --acc: #ffbb00; --ok: #3cb371;
  position: fixed; right: 12px; top: 12px; width: 580px; height: min(500px, calc(100vh - 24px)); display: none; flex-direction: column;
  background: var(--bg); border: 1px solid #0c0c0c; border-radius: 2px; color: var(--fg); font: 12.5px/18px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-variant-numeric: tabular-nums; color-scheme: dark; z-index: 20; }
#pilot-panel.on { display: flex; }
#pilot-panel * { box-sizing: border-box; }
#pilot-panel header { display: flex; align-items: flex-end; gap: 2px; padding: 8px 8px 0; border-bottom: 2px solid var(--acc); flex: none; }
#pilot-panel .tabs { display: flex; gap: 2px; flex: 1; }
#pilot-panel .tabs button { height: 26px; padding: 0 18px; border: 0; border-radius: 0; background: #393b3a; color: var(--fg); font: 600 12.5px system-ui, sans-serif; cursor: pointer; }
#pilot-panel .tabs button:hover { background: #4a4c4b; }
#pilot-panel .tabs button.on { background: var(--acc); color: #1a1400; }
#pilot-panel .x { height: 22px; margin-bottom: 2px; padding: 0 10px; }
#pilot-panel .body { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
#pilot-panel .pg { display: none; flex-direction: column; gap: 8px; } #pilot-panel .pg.on { display: flex; }
#pilot-panel .box { background: #262626; border: 1px solid #1b1b1b; }
#pilot-panel .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 24px; padding: 0 8px; background: var(--hd); border-bottom: 1px solid #1b1b1b; color: var(--fg); font-size: 12px; }
#pilot-panel .hd .st { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#pilot-panel .hd .dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: #666; } #pilot-panel .hd .dot.on { background: var(--ok); }
#pilot-panel .in { padding: 8px; }
#pilot-panel button.b { height: 24px; padding: 0 12px; border-radius: 2px; border: 1px solid #5a5a5a; background: #333; color: var(--fg); font: 12.5px system-ui, sans-serif; cursor: pointer; }
#pilot-panel button.b:hover { background: #444; }
#pilot-panel button.b.pri { background: var(--acc); border-color: var(--acc); color: #1a1400; font-weight: 600; }
#pilot-panel button.b.pri:hover { background: #ffcc33; }
#pilot-panel button[hidden] { display: none; }
#pilot-panel button:focus-visible, #pilot-panel input:focus-visible, #pilot-panel summary:focus-visible { outline: 1px solid var(--acc); outline-offset: 1px; }
#pilot-panel .row { display: flex; gap: 8px; align-items: center; }
#pilot-panel .row.r { justify-content: flex-end; }
#pilot-panel .stepline { min-height: 36px; display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
#pilot-panel .cnt { color: var(--dim); white-space: nowrap; }
#pilot-panel .prog { height: 3px; background: #333; margin: 0 0 8px; } #pilot-panel .prog i { display: block; height: 100%; width: 0; background: var(--acc); }
#pilot-panel .ch { display: grid; grid-template-columns: 84px 1fr 62px; gap: 8px; align-items: center; margin: 4px 0; }
#pilot-panel .ch > b { text-align: right; font-weight: 700; }
#pilot-panel .ch > em { font-style: normal; color: var(--dim); font-size: 11.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#pilot-panel .track { position: relative; height: 18px; border: 1px solid #555; border-radius: 3px; background: #1b1b1b; overflow: hidden; }
#pilot-panel .track i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--c, #666); }
#pilot-panel .track span { position: absolute; inset: 0; text-align: center; line-height: 16px; font-weight: 700; color: #fff; text-shadow: 0 0 3px #000, 0 0 2px #000; }
#pilot-panel details summary { cursor: pointer; padding: 0 8px; height: 24px; line-height: 24px; background: var(--hd); color: var(--fg); }
#pilot-panel details[open] summary { border-bottom: 1px solid #1b1b1b; }
#pilot-panel table { width: 100%; border-collapse: collapse; table-layout: fixed; }
#pilot-panel th { height: 34px; font-weight: 400; text-align: center; color: var(--fg); background: #2b2b2b; border: 1px solid #1b1b1b; line-height: 15px; }
#pilot-panel td { height: 32px; text-align: center; border: 1px solid #1b1b1b; }
#pilot-panel td.lab { color: #101010; font-weight: 700; text-align: left; padding-left: 8px; background: var(--c); }
#pilot-panel td.n { font-weight: 400; }
#pilot-panel th:first-child, #pilot-panel td.lab { width: 90px; }
#pilot-panel input[type=number] { width: 72px; height: 22px; padding: 0 0 0 4px; text-align: center; border-radius: 2px; border: 1px solid #3c3c3c; background: #1b1b1b; color: #fff; font: 12.5px system-ui, sans-serif; font-variant-numeric: tabular-nums; }
#pilot-panel input[type=number]:hover { border-color: #666; }
#pilot-panel input[type=number]::-webkit-inner-spin-button { opacity: 1; height: 18px; }
#pilot-panel canvas { width: 100%; height: 0; flex: 1; min-height: 160px; display: block; background: #1a1a1a; }
#pilot-panel .pg[data-p=rates] { flex: 1; min-height: 0; } #pilot-panel .pg[data-p=rates] .box:last-child { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#pilot-panel .set { display: grid; grid-template-columns: 112px 1fr 72px 36px; gap: 8px; align-items: center; margin: 6px 0; }
#pilot-panel .set > span:first-child { text-align: right; font-weight: 700; } #pilot-panel .set .u { color: var(--dim); }
#pilot-panel input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 4px; margin: 0; border-radius: 2px; cursor: pointer; background: linear-gradient(to right, var(--acc) var(--p, 50%), #444 var(--p, 50%)); }
#pilot-panel input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 8px; height: 16px; border-radius: 2px; background: var(--acc); border: 1px solid #1a1400; }
#pilot-panel .kg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
#pilot-panel .keys { width: 100%; }
#pilot-panel .keys td { height: 28px; border: 0; text-align: left; padding: 0 0 0 8px; } #pilot-panel .keys td.k { width: 96px; text-align: right; padding: 0 0 0 0; white-space: nowrap; }
#pilot-panel .keys tr:nth-child(even) td { background: rgba(255,255,255,.03); }
#pilot-panel kbd { display: inline-block; min-width: 22px; height: 20px; line-height: 20px; padding: 0 6px; margin-left: 4px; text-align: center; font: 700 11.5px ui-monospace, Menlo, Consolas, monospace; border-radius: 2px; background: #3a3a3a; border-bottom: 2px solid #1c1c1c; color: #fff; }
#pilot-sticks { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; gap: 30px; pointer-events: none; }
#pilot-sticks .gimbal { width: 100px; height: 100px; border: 1px solid rgba(255,255,255,.55); border-radius: 3px; position: relative; background: rgba(8,10,14,.3); }
#pilot-sticks .gimbal::before, #pilot-sticks .gimbal::after { content: ''; position: absolute; background: rgba(255,255,255,.2); }
#pilot-sticks .gimbal::before { left: 50%; top: 8px; bottom: 8px; width: 1px; }
#pilot-sticks .gimbal::after { top: 50%; left: 8px; right: 8px; height: 1px; }
#pilot-sticks .dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff; border: 2px solid rgba(0,0,0,.6); }
#pilot-status { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); font: 700 18px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; letter-spacing: .08em; text-shadow: 0 1px 4px #000; pointer-events: none; }
#pilot-status .armed { color: #2fbf6a; } #pilot-status .disarmed { color: #ff5a4a; } #pilot-status .warn { color: #ffb000; }`;

const KEYS = {
    System: [[['M'], 'Menu'], [['Space'], 'Reset to spawn'], [['R'], 'Recover to floor'], [['G'], 'Lighting look'], [['C'], 'Camera: FPV / chase'], [['↑', '↓'], 'Camera uptilt']],
    Fly: [[['Enter'], 'Arm / disarm'], [['W', 'S'], 'Throttle up / down'], [['A', 'D'], 'Yaw left / right'], [['I', 'K'], 'Pitch fwd / back'], [['J', 'L'], 'Roll left / right']],
};
const TABS = [['controller', 'Controller'], ['rates', 'Rates'], ['flight', 'Flight'], ['keys', 'Keys']];
const CHANNELS = [['roll', 'Roll [A]', '#df4760'], ['pitch', 'Pitch [E]', '#97da01'], ['yaw', 'Yaw [R]', '#21b1f0'], ['throttle', 'Throttle [T]', '#26b8a8'],
    ['arm', 'Arm', '#3cb371'], ['reset', 'Reset', '#e0a020'], ['recover', 'Recover', '#3f8fe0']];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ?fakepad=1: a synthetic radio (sticks sweeping, ARM switch on) so the Controller tab can be shown
// without hardware. Goes through the same code path as a real gamepad; the mapping is not saved.
const FAKE = new URLSearchParams(location.search).get('fakepad') === '1';
const FAKE_MAP = { throttle: { axis: 0, sign: 1 }, yaw: { axis: 1, sign: 1 }, pitch: { axis: 2, sign: 1 }, roll: { axis: 3, sign: 1 }, arm: { axis: 4, value: 1, rest: -1 } };
function fakePad() {
    const t = performance.now() / 1000;
    return { id: 'Fake Radio (fakepad)', axes: [0.35 + 0.3 * Math.sin(t * 0.7), 0.5 * Math.sin(t * 0.9), 0.8 * Math.sin(t * 0.6 + 1), 0.6 * Math.sin(t * 0.8 + 2), 1, -1, -1, -1], buttons: [] };
}

export class PilotUI {
    constructor({ input, onReset, onRecover, onLook, onSettings }) {
        this.onLook = onLook; this.input = input; this.onReset = onReset; this.onRecover = onRecover; this.onSettings = onSettings;
        this.map = JSON.parse(localStorage.getItem(MAP_KEY) || 'null') || migrateV1() || (FAKE ? { ...FAKE_MAP } : null);
        this.set = loadSettings();
        this.wiz = null; this.armed = false; this.resetActive = false; this._resetWas = false; this.recoverActive = false; this._recoverWas = false;
        this.axes = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
        this.tab = 'controller';
        this._build();
        this._keys();
        const want = new URLSearchParams(location.search).get('panel'); // ?panel=rates opens the menu on that tab
        if (want && TABS.some(([t]) => t === want)) { this._tab(want); this.panel.classList.add('on'); }
    }

    pad() { return FAKE ? fakePad() : [...(navigator.getGamepads?.() || [])].find((g) => g && g.axes.length >= 4) || null; }

    _build() {
        const css = document.createElement('style'); css.textContent = CSS; document.head.append(css);
        const p = document.createElement('div'); p.id = 'pilot-panel';
        const heads = ['Center sensitivity', 'Max rate', 'Expo'];
        const rows = AXES.map(([axis, name, c]) => `<tr style="--c:${c}"><td class="lab">${name.toUpperCase()}</td>${RATE_FIELDS.map(([f, , lo, hi, st]) => `<td><input type="number" data-k="${rk(axis, f)}" min="${lo}" max="${hi}" step="${st}"></td>`).join('')}<td class="n" data-m="${axis}"></td></tr>`).join('');
        const keyBox = ([name, list]) => `<div class="box"><div class="hd">${name}</div><table class="keys"><tbody>${list.map(([ks, a]) => `<tr><td class="k">${ks.map((k) => `<kbd>${k}</kbd>`).join('')}</td><td>${a}</td></tr>`).join('')}</tbody></table></div>`;
        p.innerHTML = `
        <header><nav class="tabs">${TABS.map(([t, l]) => `<button data-t="${t}">${l}</button>`).join('')}</nav><button class="b x" data-a="close" title="Close (M)">Close (M)</button></header>
        <div class="body">
          <section class="pg" data-p="controller">
            <div class="box"><div class="hd"><span>Radio mapping</span><span class="st"><i class="dot"></i><span class="pd">No controller</span></span></div>
              <div class="in"><div class="stepline"><span class="txt"></span><span class="cnt"></span></div><div class="prog"><i></i></div>
              <div class="row"><button class="b pri" data-a="map">Map sticks and switches</button><button class="b" data-a="skip" hidden>Skip</button><button class="b" data-a="cancel" hidden>Cancel</button></div></div></div>
            <div class="box"><div class="hd">Receiver</div><div class="in chans">${CHANNELS.map(([k, l, c]) => `<div class="ch" data-c="${k}" style="--c:${c}"><b>${l}</b><div class="track"><i></i><span></span></div><em></em></div>`).join('')}</div></div>
            <div class="box"><details class="raw"><summary>Raw axes</summary><div class="in axes"></div></details></div>
          </section>
          <section class="pg" data-p="rates">
            <div class="box"><table><thead><tr><th></th>${heads.map((h) => `<th>${h}</th>`).join('')}<th>Max vel<br>[deg/s]</th></tr></thead><tbody>${rows}</tbody></table></div>
            <div class="box"><div class="hd"><span>Rates preview</span><button class="b" data-a="ratedef" style="height:18px;line-height:14px;padding:0 8px">Reset rates</button></div><canvas></canvas></div>
          </section>
          <section class="pg" data-p="flight">
            <div class="box"><div class="hd">Airframe</div><div class="in sets"></div></div>
            <div class="box"><div class="hd">Derived</div><div class="in"><div class="set"><span>Climb accel</span><span></span><span class="num" data-d="acc"></span><span class="u">m/s²</span></div></div></div>
            <div class="row r"><button class="b" data-a="defaults">Defaults</button></div>
          </section>
          <section class="pg" data-p="keys"><div class="kg">${Object.entries(KEYS).map(keyBox).join('')}</div></section>
        </div>`;
        document.body.append(p);
        this.panel = p; this.stepEl = p.querySelector('.stepline'); this.txtEl = p.querySelector('.txt'); this.cntEl = p.querySelector('.cnt'); this.progEl = p.querySelector('.prog i');
        this.axesEl = p.querySelector('.axes'); this.canvas = p.querySelector('canvas');
        this.chRows = Object.fromEntries([...p.querySelectorAll('.ch')].map((r) => [r.dataset.c, r]));
        this.padDot = p.querySelector('.hd .dot'); this.padTxt = p.querySelector('.hd .pd');
        const act = (a, f) => { p.querySelector(`[data-a=${a}]`).onclick = f; };
        act('map', () => this.startWizard()); act('skip', () => this._wizSkip());
        act('cancel', () => { this.wiz = null; this._step(this.map ? 'Cancelled, mapping kept.' : 'Cancelled.', ''); this._wizUI(false); });
        act('close', () => this._close());
        act('defaults', () => { SETTINGS.forEach(([k, , , , , d]) => { this.set[k] = d; }); this._saveSet(); this._drawSets(); });
        act('ratedef', () => { Object.assign(this.set, RATE_DEFAULTS); this._saveSet(); this._syncRates(); });
        p.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => this._tab(b.dataset.t); });
        // Fields: edit freely, the sim sees valid values as you type; normalised on change.
        p.querySelectorAll('input[data-k]').forEach((inp) => {
            const k = inp.dataset.k, axis = AXES.find(([a]) => k.startsWith(a))[0], f = k.slice(axis.length), spec = RATE_FIELDS.find(([n]) => n === f);
            inp.oninput = () => { const v = parseFloat(inp.value); if (!Number.isFinite(v)) return; this.set[k] = clamp(v, spec[2], spec[3]); this._fixMax(axis); this._saveSet(); this._rateView(); };
            inp.onchange = () => this._syncRates();
        });
        // Keys typed into the menu stay in the menu (the sim's own key handler is on window).
        p.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.code === 'Escape' || (e.code === 'KeyM' && e.target.type !== 'number')) this._close();
        });
        this._drawSets(); this._syncRates();
        this._step(this.map ? 'Controller mapped.' : 'No controller mapping.', '');
        this._wizUI(false);
        this._tab(this.tab);

        const s = document.createElement('div'); s.id = 'pilot-sticks';
        s.innerHTML = '<div class="gimbal"><div class="dot"></div></div><div class="gimbal"><div class="dot"></div></div>';
        document.body.append(s);
        this.dots = s.querySelectorAll('.dot');
        this.status = document.createElement('div'); this.status.id = 'pilot-status'; document.body.append(this.status);
    }

    _close() { this.panel.classList.remove('on'); if (this.panel.contains(document.activeElement)) document.activeElement.blur(); }
    _tab(t) {
        this.tab = t;
        this.panel.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
        this.panel.querySelectorAll('.pg').forEach((s) => s.classList.toggle('on', s.dataset.p === t));
        if (t === 'rates') this._rateView();
    }
    _step(text, kind) { this.txtEl.textContent = text; this.stepEl.dataset.kind = kind || ''; }
    // Wizard progress bar and buttons.
    _wizUI(skipVisible) {
        const n = PilotUI.STEPS.length, i = this.wiz ? this.wiz.i : -1, done = !this.wiz && this.map;
        this.progEl.style.width = `${done ? 100 : Math.max(0, i) / n * 100}%`; this.cntEl.textContent = this.wiz ? `${i + 1} / ${n}` : '';
        this.panel.querySelector('[data-a=skip]').hidden = !skipVisible;
        this.panel.querySelector('[data-a=cancel]').hidden = !this.wiz;
        this.panel.querySelector('[data-a=map]').textContent = this.wiz ? 'Restart mapping' : this.map ? 'Map again' : 'Map sticks and switches';
        return n;
    }

    // Max can't sit below centre (the curve would invert).
    _fixMax(axis) { const c = this.set[rk(axis, 'Center')], m = rk(axis, 'Max'); if (this.set[m] <= c) this.set[m] = c + 5; }
    _syncRates() { this.panel.querySelectorAll('input[data-k]').forEach((i) => { i.value = this.set[i.dataset.k]; }); this._rateView(); }
    _rateView() {
        const r = rates(this.set);
        AXES.forEach(([axis]) => { this.panel.querySelector(`[data-m=${axis}]`).textContent = Math.round(rateAt(1, r[axis])); });
        if (this.tab === 'rates' && this.panel.classList.contains('on')) this._graph();
    }
    // Stick -100..+100 percent across, deg/s up (mirrored below), scale rounded up to 200s.
    _graph() {
        const cv = this.canvas, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
        if (!W) return;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
        const r = rates(this.set), peaks = AXES.map(([a]) => rateAt(1, r[a])), top = Math.max(200, Math.ceil(Math.max(...peaks) / 200) * 200);
        const X = (x) => W / 2 + x * (W / 2 - 6), Y = (v) => H / 2 - (v / top) * (H / 2 - 8);
        c.strokeStyle = '#8a8a8a'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, Math.round(H / 2) + .5); c.lineTo(W, Math.round(H / 2) + .5); c.moveTo(Math.round(W / 2) + .5, 0); c.lineTo(Math.round(W / 2) + .5, H); c.stroke();
        c.font = '11px system-ui, sans-serif'; c.fillStyle = '#8a8a8a'; c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(`${top} deg/s`, W / 2, 3);
        c.textBaseline = 'bottom'; c.fillText(`-${top} deg/s`, W / 2, H - 3);
        c.lineJoin = 'round';
        const order = [AXES[2], AXES[1], AXES[0]]; // roll on top
        for (const [axis, , col] of order) {
            c.strokeStyle = col; c.lineWidth = axis === 'roll' ? 4.5 : axis === 'pitch' ? 3 : 2; c.beginPath();
            for (let i = -60; i <= 60; i++) { const x = i / 60, y = Y(rateAt(x, r[axis])); i > -60 ? c.lineTo(X(x), y) : c.moveTo(X(x), y); }
            c.stroke();
        }
        // Chips: curve ends on the right, live stick values on the left.
        const chip = (txt, col, x, y, align) => {
            c.font = '600 11px system-ui, sans-serif'; const w = c.measureText(txt).width + 12;
            const x0 = align === 'right' ? x - w : x; c.fillStyle = col; c.fillRect(x0, y, w, 16);
            c.fillStyle = '#111'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(txt, x0 + 6, y + 8.5);
        };
        let ly = 22;
        for (const [axis, , col] of AXES) { chip(`${Math.round(rateAt(1, r[axis]))} deg/s`, col, W - 8, Math.max(Y(rateAt(1, r[axis])) + 4, ly), 'right'); ly = Math.max(Y(rateAt(1, r[axis])) + 4, ly) + 18; }
        ly = 10;
        const live = this.axes;
        for (const [axis, , col] of AXES) {
            const x = clamp(live[axis], -1, 1), v = rateAt(x, r[axis]);
            chip(`${Math.round(v)} deg/s`, col, 8, ly, 'left'); ly += 18;
            c.fillStyle = col; c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(X(x), Y(v), 4.5, 0, 7); c.fill(); c.stroke();
        }
    }

    _drawSets() {
        const box = this.panel.querySelector('.sets'); box.innerHTML = '';
        for (const [k, label, min, max, step, , unit] of SETTINGS) {
            const l = document.createElement('div'); l.className = 'set';
            l.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><input type="number" min="${min}" max="${max}" step="${step}"><span class="u">${unit}</span>`;
            const [rng, num] = l.querySelectorAll('input');
            if (k === 'uptilt') l.title = 'Also changes with the up and down arrow keys';
            if (k === 'speed') l.title = 'Prop pitch speed: the airspeed where thrust fades out';
            const show = () => { rng.value = num.value = this.set[k]; rng.style.setProperty('--p', `${(this.set[k] - min) / (max - min) * 100}%`); };
            rng.oninput = () => { this.set[k] = Number(rng.value); show(); this._saveSet(); this._derived(); };
            num.oninput = () => { const v = parseFloat(num.value); if (!Number.isFinite(v)) return; this.set[k] = clamp(v, min, max); rng.value = this.set[k]; rng.style.setProperty('--p', `${(this.set[k] - min) / (max - min) * 100}%`); this._saveSet(); this._derived(); };
            num.onchange = show;
            show(); box.append(l);
        }
        this._derived();
    }
    _derived() { const e = this.panel.querySelector('[data-d=acc]'); if (e) e.textContent = ((this.set.twr - 1) * 9.81).toFixed(1); }
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
            } else if (e.code === 'KeyM') { if (this.panel.classList.contains('on')) this._close(); else { this.panel.classList.add('on'); if (this.tab === 'rates') this._rateView(); } }
        }, true);
    }

    // --- Mapping wizard ---
    startWizard() {
        const g = this.pad();
        if (!g) { this._tab('controller'); this.panel.classList.add('on'); this._step('No controller seen. Move a stick first.', 'warn'); return; }
        this.wiz = { i: 0, map: {}, used: new Set(), base: [...g.axes], bbase: g.buttons.map((b) => b.value), ext: g.axes.map(() => 0), hold: null };
        this._tab('controller');
        this._wizPrompt();
    }
    static STEPS = [
        ['throttle', 'Move THROTTLE fully up, then back down to the bottom.'],
        ['yaw', 'Move YAW (left stick) fully RIGHT, then let it centre.'],
        ['pitch', 'Push PITCH (right stick) fully FORWARD, then let it centre.'],
        ['roll', 'Move ROLL (right stick) fully RIGHT, then let it centre.'],
        ['arm', 'Put your ARM switch in the ARMED position and hold it there for a second.'],
        ['reset', 'Optional: put a RESET switch/button in its active position and hold a second (or Skip).'],
        ['recover', 'Optional: put a RECOVER switch/button (respawn on the nearest floor) in its active position and hold a second (or Skip).'],
    ];
    _wizPrompt() {
        const [key, text] = PilotUI.STEPS[this.wiz.i];
        this._step(text, 'run');
        this._wizUI(key === 'reset' || key === 'recover');
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
        this._step('Saved. The ARM, RESET and RECOVER tags light up when active.', 'ok');
        this._wizUI(false);
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
        if (g && !this.map && !this._autoOpened) { this.panel.classList.add('on'); this._tab('controller'); this._autoOpened = true; }
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
        if (this.tab === 'rates') this._graph();
        if (this.tab !== 'controller') return;
        const m = this.map || {};
        const setCh = (k, us, frac, src) => {
            const row = this.chRows[k], t = row.children[1];
            t.firstChild.style.width = `${clamp(frac, 0, 1) * 100}%`; t.lastChild.textContent = Math.round(us);
            const em = row.children[2]; if (em.textContent !== src) em.textContent = src;
        };
        const src = (s) => (!s ? 'unmapped' : s.button !== undefined ? `Button ${s.button}` : `Axis ${s.axis}`);
        const stick = (k, v) => setCh(k, 1500 + 500 * clamp(v, -1, 1), (v + 1) / 2, g ? src(m[k]) : 'keys');
        stick('roll', a.roll); stick('pitch', -a.pitch); stick('yaw', a.yaw);
        setCh('throttle', 1000 + 1000 * a.throttle, a.throttle, g ? src(m.throttle) : 'keys');
        for (const [k, live] of [['arm', this.armed], ['reset', this.resetActive], ['recover', this.recoverActive]]) setCh(k, live ? 2000 : 1000, live ? 1 : 0, src(m[k]));
        const pad = g ? g.id.slice(0, 48) : 'No controller';
        if (pad !== this._padTxt) { this.padTxt.textContent = pad; this.padDot.classList.toggle('on', !!g); this._padTxt = pad; }
        if (!g) { if (this.axesEl.children.length) this.axesEl.innerHTML = ''; return; }
        if (this.axesEl.children.length !== g.axes.length) {
            this.axesEl.innerHTML = g.axes.map((_, k) => `<div class="ch" style="--c:#8a8a8a"><b>Axis ${k}</b><div class="track"><i></i><span></span></div><em></em></div>`).join('');
        }
        const roles = (k) => Object.entries(m).filter(([, s]) => s.axis === k).map(([r]) => r).join(' ');
        g.axes.forEach((v, k) => {
            const row = this.axesEl.children[k], t = row.children[1];
            t.firstChild.style.width = `${(v + 1) * 50}%`; t.lastChild.textContent = v.toFixed(2);
            row.children[2].textContent = roles(k);
        });
    }

    setStatus(html) { this.status.innerHTML = html; }
}
