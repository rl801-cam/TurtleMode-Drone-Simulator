// Pilot interface for the fly/ pages: the menu (Esc or M: controller, rates, flight, bindings), the
// on-screen sticks, the camera-angle indicator and the status line. Saved in localStorage.
//
// How the sims do it (manuals, wikis, forum threads; Liftoff, Velocidrone, Uncrashed, DRL Sim and
// Betaflight Configurator; tryfpv has no public docs): sticks go through a wizard or a calibration
// pass (Liftoff Options > Controls > Calibrate, Velocidrone "setup sticks"), and everything else is
// bound per action: click the action's button, then flip the switch or press the button, and the
// binding is saved at once (Velocidrone manual). Players bind Reset to a spare switch (Uncrashed
// threads), radios expose switches as axes (OpenTX/EdgeTX channels 1 to 8) or buttons (9 to 16), and
// Betaflight's Receiver tab shows every channel as a live 1000..2000 bar. Hence: a Bind button on
// every Receiver row, an optional "Map all" wizard, invert for sticks, and one Bindings table for
// keyboard and controller. Esc cancels a pending bind and otherwise opens or closes the menu.
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
  position: fixed; right: 12px; top: 12px; width: 580px; height: min(540px, calc(100vh - 24px)); display: none; flex-direction: column;
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
#pilot-panel .ch { display: grid; grid-template-columns: 84px 1fr 84px auto; gap: 8px; align-items: center; margin: 4px 0; min-height: 22px; }
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
#pilot-panel button.s { height: 20px; padding: 0 7px; font-size: 11.5px; }
#pilot-panel button.s.on { background: #5a4a10; border-color: var(--acc); color: #fff; }
#pilot-panel .bt { display: flex; gap: 4px; justify-content: flex-end; min-width: 94px; }
#pilot-panel .bind { width: 100%; } #pilot-panel .bind th { height: 26px; font-weight: 600; background: var(--hd); text-align: left; padding-left: 8px; }
#pilot-panel .bind td { height: 30px; text-align: left; padding: 0 0 0 8px; } #pilot-panel .bind td.an { font-weight: 700; width: 120px; }
#pilot-panel .bind td.kk { width: 150px; white-space: nowrap; } #pilot-panel .bind .pc { white-space: nowrap; }
#pilot-panel .bind .pt { display: inline-flex; gap: 4px; align-items: center; margin-right: 10px; } #pilot-panel .bind .pt i { font-style: normal; color: var(--dim); font-size: 11.5px; }
#pilot-panel .bind .dimt { color: var(--dim); font-size: 11.5px; }
#pilot-panel button.kc { min-width: 40px; height: 22px; padding: 0 7px; margin-right: 4px; border-radius: 2px; border: 1px solid #1c1c1c; border-bottom: 2px solid #1c1c1c; background: #3a3a3a; color: #fff; font: 700 11.5px ui-monospace, Menlo, Consolas, monospace; cursor: pointer; }
#pilot-panel button.kc:hover:not(:disabled) { background: #4c4c4c; } #pilot-panel button.kc:disabled { color: #999; cursor: default; }
#pilot-panel button.kc.wait { background: var(--acc); color: #1a1400; border-color: var(--acc); }
#pilot-panel tr.sel td.lab { box-shadow: inset 4px 0 0 #fff; } #pilot-panel td.lab { cursor: pointer; }
#pilot-cam { position: fixed; left: calc(50% + 144px); bottom: 20px; width: 88px; height: 100px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; pointer-events: none;
  border: 1px solid rgba(255,255,255,.55); border-radius: 3px; background: rgba(8,10,14,.3); color: #fff; font: 700 13px/1 system-ui, sans-serif; transform-origin: left bottom; transition: transform .15s, border-color .15s, background .15s; }
#pilot-cam svg { width: 64px; height: 44px; } #pilot-cam .hz { stroke: rgba(255,255,255,.35); } #pilot-cam .cm { fill: #fff; stroke: none; } #pilot-cam small { font-weight: 400; font-size: 10px; color: rgba(255,255,255,.7); }
#pilot-cam.hit { transform: scale(1.3); border-color: #ffbb00; background: rgba(40,30,0,.65); } #pilot-cam.hit .cm { fill: #ffbb00; } #pilot-cam.hit b { color: #ffbb00; }
#pilot-sticks { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; gap: 30px; pointer-events: none; }
#pilot-sticks .gimbal { width: 100px; height: 100px; border: 1px solid rgba(255,255,255,.55); border-radius: 3px; position: relative; background: rgba(8,10,14,.3); }
#pilot-sticks .gimbal::before, #pilot-sticks .gimbal::after { content: ''; position: absolute; background: rgba(255,255,255,.2); }
#pilot-sticks .gimbal::before { left: 50%; top: 8px; bottom: 8px; width: 1px; }
#pilot-sticks .gimbal::after { top: 50%; left: 8px; right: 8px; height: 1px; }
#pilot-sticks .dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff; border: 2px solid rgba(0,0,0,.6); }
#pilot-status { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); font: 700 18px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; letter-spacing: .08em; text-shadow: 0 1px 4px #000; pointer-events: none; }
#pilot-status .armed { color: #2fbf6a; } #pilot-status .disarmed { color: #ff5a4a; } #pilot-status .warn { color: #ffb000; }`;

const KB_KEY = 'tm.keymap.v1';
// Keyboard bindings by physical key (KeyboardEvent.code). Rows with two slots: menu (Esc fixed, M),
// tilt (up, down), throttle (up, down), yaw/pitch/roll (negative, positive).
const KB_DEFAULT = { menu: ['Escape', 'KeyM'], reset: ['Space'], recover: ['KeyR'], arm: ['Enter'], look: ['KeyG'], camera: ['KeyC'], tilt: ['ArrowUp', 'ArrowDown'],
    throttle: ['KeyW', 'KeyS'], yaw: ['KeyA', 'KeyD'], pitch: ['KeyI', 'KeyK'], roll: ['KeyJ', 'KeyL'] };
const LEGACY = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyI', 'KeyK', 'KeyJ', 'KeyL', 'Space']); // InputHandler's own fixed keys: swallowed so rebinding really moves them
// id, label, keyboard slot tips, controller targets (keys of the controller map)
const BIND_ROWS = [
    ['menu', 'Menu', ['Menu (fixed)', 'Menu'], ['menu']], ['reset', 'Reset', ['Reset to spawn'], ['reset']], ['recover', 'Recover', ['Recover to the nearest floor'], ['recover']],
    ['arm', 'Arm', ['Arm / disarm (toggle)'], ['arm']], ['look', 'Lighting look', ['Cycle the lighting look'], ['look']], ['camera', 'Camera view', ['FPV / chase'], ['camera']],
    ['tilt', 'Camera tilt', ['Tilt up', 'Tilt down'], ['tiltUp', 'tiltDown']],
    ['throttle', 'Throttle', ['Up', 'Down'], []], ['yaw', 'Yaw', ['Left', 'Right'], []], ['pitch', 'Pitch', ['Forward', 'Back'], []], ['roll', 'Roll', ['Left', 'Right'], []],
];
const TABS = [['controller', 'Controller'], ['rates', 'Rates'], ['flight', 'Flight'], ['bindings', 'Bindings']];
const STICKS = ['roll', 'pitch', 'yaw', 'throttle'];
const EDGE = ['reset', 'recover', 'look', 'camera', 'menu'];
const RX = [['roll', 'Roll [A]', '#df4760'], ['pitch', 'Pitch [E]', '#97da01'], ['yaw', 'Yaw [R]', '#21b1f0'], ['throttle', 'Throttle [T]', '#26b8a8'],
    ['arm', 'Arm', '#3cb371'], ['reset', 'Reset', '#e0a020'], ['recover', 'Recover', '#3f8fe0'], ['look', 'Look', '#8a93a3'], ['camera', 'Camera', '#8a93a3'],
    ['menu', 'Menu', '#8a93a3'], ['tiltUp', 'Tilt up', '#8a93a3'], ['tiltDown', 'Tilt down', '#8a93a3']];
const PROMPT = { roll: 'Move the ROLL stick fully right.', pitch: 'Push the PITCH stick fully forward.', yaw: 'Move the YAW stick fully right.', throttle: 'Move the THROTTLE stick fully up.' };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const keyName = (c) => ({ Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backspace: 'Bksp' })[c] || c.replace(/^Key|^Digit/, '');
const srcText = (s) => (!s ? '' : s.button !== undefined ? `Button ${s.button}` : s.value === undefined ? `Axis ${s.axis}` : `Axis ${s.axis} ${s.value > 0.5 ? 'high' : s.value < -0.5 ? 'low' : 'mid'}`);
function loadKeysDefault() { const kb = {}; for (const [id, d] of Object.entries(KB_DEFAULT)) kb[id] = [...d]; return kb; }
function loadKeys() {
    let sv = {}; try { sv = JSON.parse(localStorage.getItem(KB_KEY) || '{}') || {}; } catch { /* defaults */ }
    const kb = {};
    for (const [id, d] of Object.entries(KB_DEFAULT)) kb[id] = d.map((c, i) => (typeof sv[id]?.[i] === 'string' || sv[id]?.[i] === null ? sv[id][i] : c));
    kb.menu[0] = 'Escape';
    return kb;
}
// Solve f(p) = target for p in [lo, hi] where f is monotonic (either way).
function solve(f, lo, hi, target) {
    const up = f(hi) >= f(lo);
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if ((f(mid) < target) === up) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
}
const HX = { center: 0.25, expo: 0.65 }; // stick positions of the draggable Center and Expo handles

// ?fakepad=1: a synthetic radio (sticks sweeping, ARM switch on) so the Controller tab can be shown
// without hardware. Goes through the same code path as a real gamepad; the mapping is not saved.
const QS = new URLSearchParams(location.search);
const FAKE = QS.get('fakepad') === '1';
const FAKE_MAP = { throttle: { axis: 0, sign: 1 }, yaw: { axis: 1, sign: 1 }, pitch: { axis: 2, sign: 1 }, roll: { axis: 3, sign: 1 }, arm: { axis: 4, value: 1, rest: -1 }, look: { button: 5 } };
function fakePad() {
    const t = performance.now() / 1000;
    return { id: 'Fake Radio (fakepad)', axes: [0.35 + 0.3 * Math.sin(t * 0.7), 0.5 * Math.sin(t * 0.9), 0.8 * Math.sin(t * 0.6 + 1), 0.6 * Math.sin(t * 0.8 + 2), 1, -1, -1, -1], buttons: Array.from({ length: 8 }, () => ({ value: 0, pressed: false })) };
}

export class PilotUI {
    // onCamera (optional): camera view toggle, from the C key or a bound switch.
    constructor({ input, onReset, onRecover, onLook, onCamera, onSettings }) {
        this.onLook = onLook; this.onCamera = onCamera; this.input = input; this.onReset = onReset; this.onRecover = onRecover; this.onSettings = onSettings;
        this.map = JSON.parse(localStorage.getItem(MAP_KEY) || 'null') || migrateV1() || (FAKE ? { ...FAKE_MAP } : null);
        this.set = loadSettings(); this.kb = loadKeys();
        this.wiz = null; this.bind = null; this.cap = null; this.armed = false; this.resetActive = false; this.recoverActive = false;
        this.live = {}; this._was = {}; this._tiltNext = {}; this.selAxis = 'roll';
        this.axes = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
        this.tab = 'controller';
        this._build();
        this._keys();
        const want = QS.get('panel') === 'keys' ? 'bindings' : QS.get('panel'); // ?panel=rates opens the menu on that tab
        if (want && TABS.some(([t]) => t === want)) { this._tab(want); this.panel.classList.add('on'); }
        if (QS.get('autobind')) setTimeout(() => this.startBind(QS.get('autobind')), 300); // debug: start a bind
        if (QS.get('autocap')) setTimeout(() => this._startCap(QS.get('autocap'), 0), 300); // debug: start a key capture
    }

    pad() { return FAKE ? fakePad() : [...(navigator.getGamepads?.() || [])].find((g) => g && g.axes.length >= 4) || null; }

    _build() {
        const css = document.createElement('style'); css.textContent = CSS; document.head.append(css);
        const p = document.createElement('div'); p.id = 'pilot-panel';
        const heads = ['Center sensitivity', 'Max rate', 'Expo'];
        const rows = AXES.map(([axis, name, c]) => `<tr data-ax="${axis}" style="--c:${c}"><td class="lab" title="Select to edit on the graph">${name.toUpperCase()}</td>${RATE_FIELDS.map(([f, , lo, hi, st]) => `<td><input type="number" data-k="${rk(axis, f)}" min="${lo}" max="${hi}" step="${st}"></td>`).join('')}<td class="n" data-m="${axis}"></td></tr>`).join('');
        p.innerHTML = `
        <header><nav class="tabs">${TABS.map(([t, l]) => `<button data-t="${t}">${l}</button>`).join('')}</nav><button class="b x" data-a="close" title="Close (Esc or M)">Close (Esc)</button></header>
        <div class="body">
          <section class="pg" data-p="controller">
            <div class="box"><div class="hd"><span>Radio</span><span class="st"><i class="dot"></i><span class="pd">No controller</span></span></div>
              <div class="in"><div class="stepline"><span class="txt"></span><span class="cnt"></span></div><div class="prog"><i></i></div>
              <div class="row"><button class="b" data-a="map" title="Walk through sticks and switches one after another">Map all</button><button class="b" data-a="skip" hidden>Skip</button><button class="b" data-a="cancel" hidden>Cancel</button></div></div></div>
            <div class="box"><div class="hd">Receiver</div><div class="in chans"></div></div>
            <div class="box"><details class="raw"><summary>Raw axes</summary><div class="in axes"></div></details></div>
          </section>
          <section class="pg" data-p="rates">
            <div class="box"><table><thead><tr><th></th>${heads.map((h) => `<th>${h}</th>`).join('')}<th>Max vel<br>[deg/s]</th></tr></thead><tbody>${rows}</tbody></table></div>
            <div class="box"><div class="hd"><span>Rates preview (drag the handles)</span><button class="b" data-a="ratedef" style="height:18px;line-height:14px;padding:0 8px">Reset rates</button></div><canvas></canvas></div>
          </section>
          <section class="pg" data-p="flight">
            <div class="box"><div class="hd">Airframe</div><div class="in sets"></div></div>
            <div class="box"><div class="hd">Derived</div><div class="in"><div class="set"><span>Climb accel</span><span></span><span class="num" data-d="acc"></span><span class="u">m/s²</span></div></div></div>
            <div class="row r"><button class="b" data-a="defaults">Defaults</button></div>
          </section>
          <section class="pg" data-p="bindings"><div class="box"><table class="bind"><thead><tr><th>Action</th><th>Keyboard</th><th>Controller</th></tr></thead><tbody></tbody></table></div>
            <div class="row r"><button class="b" data-a="keydef">Reset keys</button></div></section>
        </div>`;
        document.body.append(p);
        this.panel = p; this.stepEl = p.querySelector('.stepline'); this.txtEl = p.querySelector('.txt'); this.cntEl = p.querySelector('.cnt'); this.progEl = p.querySelector('.prog i');
        this.axesEl = p.querySelector('.axes'); this.canvas = p.querySelector('canvas'); this.chansEl = p.querySelector('.chans'); this.bindBody = p.querySelector('.bind tbody');
        this.padDot = p.querySelector('.hd .dot'); this.padTxt = p.querySelector('.hd .pd');
        const act = (a, f) => { p.querySelector(`[data-a=${a}]`).onclick = f; };
        act('map', () => this.startWizard()); act('skip', () => this._wizSkip());
        act('cancel', () => { this.wiz = null; this._step(this.map ? 'Cancelled, mapping kept.' : 'Cancelled.', ''); this._wizUI(false); });
        act('close', () => this._close());
        act('defaults', () => { SETTINGS.forEach(([k, , , , , d]) => { this.set[k] = d; }); this._saveSet(); this._drawSets(); });
        act('ratedef', () => { Object.assign(this.set, RATE_DEFAULTS); this._saveSet(); this._syncRates(); });
        act('keydef', () => { this.kb = loadKeysDefault(); this._saveKeys(); this._drawBindings(); });
        p.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => this._tab(b.dataset.t); });
        // Delegated clicks: Bind / clear / invert on controller rows, key slots.
        p.addEventListener('click', (e) => {
            const t = e.target.closest('button'); if (!t) return;
            if (t.dataset.bind) this.startBind(t.dataset.bind);
            else if (t.dataset.clr) this._clearBind(t.dataset.clr);
            else if (t.dataset.inv) this._invert(t.dataset.inv);
            else if (t.dataset.ks) this._startCap(t.dataset.ks, Number(t.dataset.i));
        });
        p.querySelectorAll('tr[data-ax] td.lab').forEach((td) => { td.onclick = () => this._select(td.parentElement.dataset.ax); });
        // Fields: edit freely, the sim sees valid values as you type; normalised on change.
        p.querySelectorAll('input[data-k]').forEach((inp) => {
            const k = inp.dataset.k, axis = AXES.find(([a]) => k.startsWith(a))[0], f = k.slice(axis.length), spec = RATE_FIELDS.find(([n]) => n === f);
            inp.oninput = () => { const v = parseFloat(inp.value); if (!Number.isFinite(v)) return; this.set[k] = clamp(v, spec[2], spec[3]); this._fixMax(axis); this._saveSet(); this._rateView(); };
            inp.onchange = () => this._syncRates();
            inp.onfocus = () => this._select(axis);
        });
        // Keys typed into the menu stay in the menu (the sim's own key handler is on window).
        p.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.code === 'Escape' || (this.kb.menu.includes(e.code) && e.target.type !== 'number')) this._close();
        });
        this._graphEvents();
        this._drawSets(); this._syncRates(); this._refreshBinds(); this._select(this.selAxis);
        this._step(this.map ? 'Controller mapped.' : 'No controller mapping.', '');
        this._wizUI(false);
        this._tab(this.tab);

        const s = document.createElement('div'); s.id = 'pilot-sticks';
        s.innerHTML = '<div class="gimbal"><div class="dot"></div></div><div class="gimbal"><div class="dot"></div></div>';
        document.body.append(s);
        this.dots = s.querySelectorAll('.dot');
        const cam = document.createElement('div'); cam.id = 'pilot-cam';
        cam.innerHTML = '<svg viewBox="0 0 64 44"><line class="hz" x1="2" y1="22" x2="62" y2="22"/><g class="g"><rect class="cm" x="14" y="14" width="26" height="16" rx="2"/><path class="cm" d="M40 18 L54 11 V33 L40 26Z"/></g></svg><b>CAM 0°</b><small>uptilt</small>';
        document.body.append(cam); this.camEl = cam; this._camUpdate(false);
        this.status = document.createElement('div'); this.status.id = 'pilot-status'; document.body.append(this.status);
    }

    // Camera angle: a small camera glyph tilted by the uptilt, enlarged for a moment when it changes.
    _camUpdate(flash) {
        const t = this.set.uptilt; this._camShown = t;
        this.camEl.querySelector('.g').setAttribute('transform', `rotate(${-t} 27 22)`);
        this.camEl.querySelector('b').textContent = `CAM ${Math.round(t)}°`;
        if (flash) { this.camEl.classList.add('hit'); clearTimeout(this._camT); this._camT = setTimeout(() => this.camEl.classList.remove('hit'), 1200); }
    }
    _tilt(d) {
        const v = clamp(this.set.uptilt + d, 0, 50); if (v === this.set.uptilt) return;
        this.set.uptilt = v; this._saveSet(); this._camUpdate(true);
        if (this.tab === 'flight' && this.panel.classList.contains('on')) this._drawSets();
    }

    _toggle() { if (this.panel.classList.contains('on')) this._close(); else { this.panel.classList.add('on'); if (this.tab === 'rates') this._rateView(); } }
    _close() { this._endBind(); this.cap = null; this._drawBindings(); this.panel.classList.remove('on'); if (this.panel.contains(document.activeElement)) document.activeElement.blur(); }
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
        this.panel.querySelector('[data-a=map]').textContent = this.wiz ? 'Restart' : 'Map all';
        return n;
    }

    // --- Per-action controller binding (any time, saved at once) ---
    _saveMap() { if (!FAKE) localStorage.setItem(MAP_KEY, JSON.stringify(this.map)); }
    startBind(k) {
        const g = this.pad(); this.wiz = null; this._wizUI(false);
        if (!g) { this._tab('controller'); this._step('No controller detected. Move a stick first.', 'warn'); return; }
        this.bind = { k, base: [...g.axes], bbase: g.buttons.map((b) => b.value), hold: null };
        const label = (RX.find((r) => r[0] === k) || [])[1] || k;
        this._step(STICKS.includes(k) ? `${PROMPT[k]} Esc cancels.` : `Flip the switch or press the button for ${label.replace(/ \[.\]/, '').toUpperCase()}. Esc cancels.`, 'run');
        this._refreshBinds();
    }
    _endBind(msg) { if (!this.bind) return; this.bind = null; this._step(msg || 'Cancelled.', ''); this._refreshBinds(); }
    _setBind(k, v) {
        this.map = { ...(this.map || {}), [k]: v }; this._saveMap(); this.bind = null; this._quiet = true;
        this._step(`${(RX.find((r) => r[0] === k) || [])[1] || k} bound to ${srcText(v)}.`, 'ok'); this._wizUI(false); this._refreshBinds();
    }
    _clearBind(k) { if (!this.map?.[k]) return; const m = { ...this.map }; delete m[k]; this.map = m; this._saveMap(); this._refreshBinds(); }
    _invert(k) { const s = this.map?.[k]; if (!s || s.sign === undefined) return; this.map = { ...this.map, [k]: { ...s, sign: -s.sign } }; this._saveMap(); this._refreshBinds(); }
    _bindTick(g) {
        const b = this.bind, m = this.map || {};
        const stickAxes = new Set(STICKS.filter((k) => k !== b.k && m[k]).map((k) => m[k].axis));
        if (STICKS.includes(b.k)) {
            const used = new Set([...stickAxes, ...Object.entries(m).filter(([k, v]) => k !== b.k && v.axis !== undefined).map(([, v]) => v.axis)]);
            let best = -1, bd = 0;
            g.axes.forEach((v, i) => { if (used.has(i)) return; const d = v - b.base[i]; if (Math.abs(d) > Math.abs(bd)) { bd = d; best = i; } });
            if (Math.abs(bd) > 0.6) this._setBind(b.k, { axis: best, sign: Math.sign(bd) });
            return;
        }
        let src = null;
        g.buttons.forEach((bt, i) => { if (!src && Math.abs(bt.value - b.bbase[i]) > 0.5) src = { button: i }; });
        if (!src) g.axes.forEach((v, i) => { if (!src && !stickAxes.has(i) && Math.abs(v - b.base[i]) > 0.4) src = { axis: i, value: v }; });
        if (!src) { b.hold = null; return; }
        const now = performance.now(), h = b.hold;
        const same = h && h.src.button === src.button && h.src.axis === src.axis && (src.axis === undefined || Math.abs(src.value - h.src.value) < 0.1);
        if (!same) { b.hold = { src, t: now }; return; }
        if (now - h.t > 350) this._setBind(b.k, src.button !== undefined ? { button: src.button } : { axis: src.axis, value: src.value, rest: b.base[src.axis] });
    }
    _refreshBinds() { this._drawRx(); this._drawBindings(); }
    _drawRx() {
        const m = this.map || {}, sticks = new Set(STICKS);
        this.chansEl.innerHTML = RX.map(([k, l, c]) => {
            const s = m[k], wait = this.bind?.k === k;
            return `<div class="ch" data-c="${k}" style="--c:${c}"><b>${l}</b><div class="track"><i></i><span></span></div><em>${wait ? 'waiting' : srcText(s) || 'unbound'}</em><div class="bt">`
                + (sticks.has(k) && s ? `<button class="b s${s.sign < 0 ? ' on' : ''}" data-inv="${k}" title="Invert">Inv</button>` : '')
                + `<button class="b s${wait ? ' pri' : ''}" data-bind="${k}" title="Click, then move the stick or flip the switch">Bind</button>`
                + (s ? `<button class="b s" data-clr="${k}" title="Clear">×</button>` : '') + '</div></div>';
        }).join('');
        this.chRows = Object.fromEntries([...this.chansEl.children].map((r) => [r.dataset.c, r]));
    }

    // --- Keyboard bindings ---
    _saveKeys() { localStorage.setItem(KB_KEY, JSON.stringify(this.kb)); }
    _findKey(code) { for (const [id, a] of Object.entries(this.kb)) { const i = a.indexOf(code); if (i >= 0) return [id, i]; } return null; }
    _startCap(id, i) { this.bind = null; this.cap = { id, i }; this._refreshBinds(); }
    _capKey(e) {
        const { id, i } = this.cap; this.cap = null;
        if (e.code === 'Delete' || e.code === 'Backspace') this.kb[id][i] = null;
        else if (e.code !== 'Escape') {
            for (const [id2, a] of Object.entries(this.kb)) a.forEach((c, j) => { if (c === e.code && !(id2 === 'menu' && j === 0)) a[j] = null; });
            this.kb[id][i] = e.code;
        }
        this.kb.menu[0] = 'Escape'; this._saveKeys(); this._drawBindings();
    }
    _drawBindings() {
        const m = this.map || {};
        this.bindBody.innerHTML = BIND_ROWS.map(([id, label, tips, targets]) => {
            const ks = this.kb[id].map((c, i) => {
                const wait = this.cap && this.cap.id === id && this.cap.i === i, fixed = id === 'menu' && i === 0;
                return `<button class="kc${wait ? ' wait' : ''}" data-ks="${id}" data-i="${i}" ${fixed ? 'disabled' : ''} title="${tips[i]}${fixed ? '' : ' (click, press a key; Delete clears)'}">${wait ? 'Press key' : c ? keyName(c) : '-'}</button>`;
            }).join('');
            const pc = targets.length ? targets.map((t, i) => {
                const s = m[t], wait = this.bind?.k === t;
                return `<span class="pt">${targets.length > 1 ? `<i>${i ? 'Down' : 'Up'}</i>` : ''}<button class="b s${wait ? ' pri' : ''}" data-bind="${t}">${wait ? 'Waiting' : srcText(s) || 'Bind'}</button>${s ? `<button class="b s" data-clr="${t}" title="Clear">×</button>` : ''}</span>`;
            }).join('') : '<span class="dimt">Sticks (Controller tab)</span>';
            return `<tr><td class="an">${label}</td><td class="kk">${ks}</td><td class="pc">${pc}</td></tr>`;
        }).join('');
    }

    // Max can't sit below centre (the curve would invert).
    _fixMax(axis) { const c = this.set[rk(axis, 'Center')], m = rk(axis, 'Max'); if (this.set[m] <= c) this.set[m] = c + 5; }
    _syncRates() { this.panel.querySelectorAll('input[data-k]').forEach((i) => { i.value = this.set[i.dataset.k]; }); this._rateView(); }
    _select(axis) { this.selAxis = axis; this.panel.querySelectorAll('tr[data-ax]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.ax === axis)); if (this.tab === 'rates') this._graph(); }
    _rateView() {
        const r = rates(this.set);
        AXES.forEach(([axis]) => { this.panel.querySelector(`[data-m=${axis}]`).textContent = Math.round(rateAt(1, r[axis])); });
        if (this.tab === 'rates' && this.panel.classList.contains('on')) this._graph();
    }
    // Stick -100..+100 percent across, deg/s up (mirrored below), scale rounded up to 200s. The
    // selected axis shows three handles: curve end (Max), x=0.25 (Center), x=0.65 (Expo).
    _graph() {
        const cv = this.canvas, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
        if (!W) return;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
        const r = rates(this.set), peaks = AXES.map(([a]) => rateAt(1, r[a])), top = this._dragTop || Math.max(200, Math.ceil(Math.max(...peaks) / 200) * 200);
        const X = (x) => W / 2 + x * (W / 2 - 6), Y = (v) => H / 2 - (v / top) * (H / 2 - 8);
        this._gm = { W, H, top, X, Y };
        c.strokeStyle = '#8a8a8a'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, Math.round(H / 2) + .5); c.lineTo(W, Math.round(H / 2) + .5); c.moveTo(Math.round(W / 2) + .5, 0); c.lineTo(Math.round(W / 2) + .5, H); c.stroke();
        c.font = '11px system-ui, sans-serif'; c.fillStyle = '#8a8a8a'; c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(`${top} deg/s`, W / 2, 3);
        c.textBaseline = 'bottom'; c.fillText(`-${top} deg/s`, W / 2, H - 3);
        c.lineJoin = 'round';
        const sel = this.selAxis, order = [...AXES].reverse().sort((a, b) => (a[0] === sel) - (b[0] === sel));
        for (const [axis, , col] of order) {
            c.globalAlpha = axis === sel ? 1 : 0.6; c.strokeStyle = col; c.lineWidth = axis === sel ? 4 : 2.5; c.beginPath();
            for (let i = -60; i <= 60; i++) { const x = i / 60, y = Y(rateAt(x, r[axis])); i > -60 ? c.lineTo(X(x), y) : c.moveTo(X(x), y); }
            c.stroke();
        }
        c.globalAlpha = 1;
        // Chips: curve ends on the right, live stick values on the left.
        const chip = (txt, col, x, y, align) => {
            c.font = '600 11px system-ui, sans-serif'; const w = c.measureText(txt).width + 12;
            const x0 = align === 'right' ? x - w : x; c.fillStyle = col; c.fillRect(x0, y, w, 16);
            c.fillStyle = '#111'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(txt, x0 + 6, y + 8.5);
        };
        let ly = 22;
        for (const [axis, , col] of AXES) { chip(`${Math.round(rateAt(1, r[axis]))} deg/s`, col, W - 16, Math.max(Y(rateAt(1, r[axis])) + 4, ly), 'right'); ly = Math.max(Y(rateAt(1, r[axis])) + 4, ly) + 18; }
        ly = 10;
        for (const [axis, , col] of AXES) {
            const x = clamp(this.axes[axis], -1, 1), v = rateAt(x, r[axis]);
            chip(`${Math.round(v)} deg/s`, col, 8, ly, 'left'); ly += 18;
            c.fillStyle = col; c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(X(x), Y(v), 4.5, 0, 7); c.fill(); c.stroke();
        }
        // Handles of the selected axis.
        const col = AXES.find(([a]) => a === sel)[2];
        this._hp = this._handles();
        c.font = '10.5px system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
        for (const [h, [px, py]] of Object.entries(this._hp)) {
            c.fillStyle = col; c.strokeStyle = '#fff'; c.lineWidth = 2; c.fillRect(px - 5, py - 5, 10, 10); c.strokeRect(px - 5, py - 5, 10, 10);
            c.fillStyle = '#d0d0d0'; c.fillText(h === 'max' ? 'Max' : h === 'center' ? 'Center' : 'Expo', h === 'max' ? px - 28 : px + 9, h === 'max' ? Math.max(8, py - 12) : py - 8);
        }
    }
    _handles() {
        const { X, Y } = this._gm, r = rates(this.set)[this.selAxis], at = (x) => [X(x), Y(rateAt(x, r))];
        return { max: at(1), center: at(HX.center), expo: at(HX.expo) };
    }
    _graphEvents() {
        const cv = this.canvas; cv.style.touchAction = 'none';
        const pos = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
        const hitHandle = (px, py) => Object.entries(this._hp || {}).find(([, [x, y]]) => Math.hypot(px - x, py - y) < 11)?.[0];
        const hitCurve = (px, py) => {
            const { X, Y } = this._gm, r = rates(this.set); let best = null, bd = 1e9;
            const sel = this.selAxis;
            for (const [axis] of AXES) {
                let d = 1e9;
                for (let i = -50; i <= 50; i++) { const x = i / 50; d = Math.min(d, Math.hypot(px - X(x), py - Y(rateAt(x, r[axis])))); }
                if (d < bd - (axis === sel ? 0 : 0.5) || (axis === sel && d <= bd + 0.5)) { bd = d; best = axis; }
            }
            return bd < 12 ? best : null;
        };
        cv.onpointerdown = (e) => {
            if (!this._gm) return; const [px, py] = pos(e), h = hitHandle(px, py);
            if (h) { this._drag = h; this._dragTop = h === 'max' ? Math.min(1200, this._gm.top + 200) : this._gm.top; cv.setPointerCapture(e.pointerId); this._dragTo(py); }
            else { const a = hitCurve(px, py); if (a) this._select(a); }
        };
        cv.onpointermove = (e) => {
            const [px, py] = pos(e);
            if (this._drag) { this._dragTo(py); return; }
            if (this._gm) cv.style.cursor = hitHandle(px, py) ? 'ns-resize' : hitCurve(px, py) ? 'pointer' : 'default';
        };
        const end = () => { if (!this._drag) return; this._drag = null; this._dragTop = 0; this._syncRates(); };
        cv.onpointerup = end; cv.onpointercancel = end;
    }
    // Pointer y to deg/s on the positive side, then the field that handle owns (inverting rateAt numerically).
    _dragTo(py) {
        const { H, top } = this._gm, v = Math.max(1, (H / 2 - py) / (H / 2 - 8) * top), ax = this.selAxis;
        const get = (f) => this.set[rk(ax, f)], put = (f, x) => { this.set[rk(ax, f)] = x; };
        const p = () => ({ center: get('Center'), max: get('Max'), expo: get('Expo') });
        if (this._drag === 'max') put('Max', clamp(Math.round(v / 10) * 10, Math.max(100, get('Center') + 5), 1200));
        else if (this._drag === 'center') {
            const hi = Math.min(400, get('Max') - 5);
            put('Center', clamp(Math.round(solve((c) => rateAt(HX.center, { ...p(), center: c }), 10, hi, v) / 5) * 5, 10, hi));
        } else put('Expo', clamp(Math.round(solve((e) => rateAt(HX.expo, { ...p(), expo: e }), 0, 1, v) * 100) / 100, 0, 1));
        this._saveSet(); this._syncRates();
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
        // Capture phase on window runs before InputHandler's own listeners, so bound keys are taken
        // from it (Space would toggle arm there) and the arrows don't scroll.
        const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
        addEventListener('keydown', (e) => {
            if (this.cap) { e.preventDefault(); e.stopImmediatePropagation(); this._capKey(e); return; }
            if (this.bind && e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this._endBind(); return; }
            if (e.target.closest?.('#pilot-panel') || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
            const hit = this._findKey(e.code);
            if (!hit) { if (LEGACY.has(e.code)) e.stopImmediatePropagation(); return; }
            const [id, i] = hit, rep = e.repeat;
            if (id === 'camera' && !this.onCamera) return;
            e.preventDefault(); e.stopImmediatePropagation();
            if (id === 'menu') { if (!rep) this._toggle(); }
            else if (id === 'reset') { if (!rep) this.onReset?.('key'); }
            else if (id === 'recover') { if (!rep) this.onRecover?.('key'); }
            else if (id === 'arm') { if (!rep) this.input.armed = !this.input.armed; }
            else if (id === 'look') { if (!rep) this.onLook?.(); }
            else if (id === 'camera') { if (!rep) this.onCamera('key'); }
            else if (id === 'tilt') this._tilt(i === 0 ? 2 : -2);
            else if (id === 'throttle') this.input.axes.throttle = i === 0 ? 1 : 0;
            else this.input.axes[id] = i === 0 ? -1 : 1; // yaw, pitch, roll
        }, true);
        addEventListener('keyup', (e) => {
            if (e.target.closest?.('#pilot-panel') || typing(e)) return;
            const hit = this._findKey(e.code);
            if (!hit) { if (LEGACY.has(e.code)) e.stopImmediatePropagation(); return; }
            const [id] = hit;
            if (id === 'throttle') { if (this.input.throttleCentred) this.input.axes.throttle = 0.5; e.stopImmediatePropagation(); }
            else if (id === 'yaw' || id === 'pitch' || id === 'roll') { this.input.axes[id] = 0; e.stopImmediatePropagation(); }
        }, true);
    }

    // --- Mapping wizard ---
    startWizard() {
        const g = this.pad();
        if (!g) { this._tab('controller'); this.panel.classList.add('on'); this._step('No controller seen. Move a stick first.', 'warn'); return; }
        this.bind = null; this.cap = null;
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
        const keep = Object.fromEntries(['look', 'camera', 'menu', 'tiltUp', 'tiltDown'].filter((k) => this.map?.[k]).map((k) => [k, this.map[k]]));
        this.map = { ...keep, ...this.wiz.map }; this.wiz = null; this._quiet = true;
        this._saveMap();
        this._step('Saved. Rebind any single row with its Bind button.', 'ok');
        this._wizUI(false); this._refreshBinds();
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
        if (m.value === undefined) return false;
        return Math.abs(g.axes[m.axis] - m.value) < Math.max(0.2, Math.abs(m.value - m.rest) * 0.4);
    }

    // Per frame: returns { axes, armed }. Bound switches fire on their rising edge, tilt repeats while held.
    update() {
        this.input.update();
        let axes = this.input.getAxes(), armed = this.input.isArmed();
        const g = this.pad(), m = this.map || {};
        if (g && !this.map && !this._autoOpened) { this.panel.classList.add('on'); this._tab('controller'); this._autoOpened = true; }
        if (g && this.wiz) this._wizTick(g);
        else if (g) {
            if (this.bind) this._bindTick(g);
            const ax = (s) => g.axes[s.axis] * s.sign, db = (v) => (Math.abs(v) < 0.02 ? 0 : v);
            axes = { ...axes };
            if (m.throttle) axes.throttle = clamp((ax(m.throttle) + 1) / 2, 0, 1);
            if (m.yaw) axes.yaw = db(ax(m.yaw));
            if (m.pitch) axes.pitch = -db(ax(m.pitch));
            if (m.roll) axes.roll = db(ax(m.roll));
            if (m.arm) armed = this._active(m.arm, g);
            const fire = !this.bind && !this._quiet, now = performance.now();
            this._quiet = false;
            for (const k of [...EDGE, 'tiltUp', 'tiltDown']) {
                const on = this._active(m[k], g), was = this._was[k];
                this.live[k] = on; this._was[k] = on;
                if (!fire) continue;
                if (k === 'tiltUp' || k === 'tiltDown') { if (on && (!was || now >= (this._tiltNext[k] || 0))) { this._tilt(k === 'tiltUp' ? 2 : -2); this._tiltNext[k] = now + (was ? 70 : 300); } }
                else if (on && !was) {
                    if (k === 'reset') this.onReset?.('switch'); else if (k === 'recover') this.onRecover?.('switch');
                    else if (k === 'look') this.onLook?.(); else if (k === 'camera') this.onCamera?.('switch'); else this._toggle();
                }
            }
            this.resetActive = !!this.live.reset; this.recoverActive = !!this.live.recover;
        }
        if (this.set.uptilt !== this._camShown) this._camUpdate(true);
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
        const setCh = (k, us, frac) => {
            const row = this.chRows[k]; if (!row) return;
            const t = row.children[1]; t.firstChild.style.width = `${clamp(frac, 0, 1) * 100}%`; t.lastChild.textContent = Math.round(us);
        };
        const stick = (k, v) => setCh(k, 1500 + 500 * clamp(v, -1, 1), (v + 1) / 2);
        stick('roll', a.roll); stick('pitch', -a.pitch); stick('yaw', a.yaw);
        setCh('throttle', 1000 + 1000 * a.throttle, a.throttle);
        const on = { arm: this.armed, ...this.live };
        for (const k of ['arm', ...EDGE, 'tiltUp', 'tiltDown']) setCh(k, on[k] ? 2000 : 1000, on[k] ? 1 : 0);
        const pad = g ? g.id.slice(0, 48) : 'No controller';
        if (pad !== this._padTxt) { this.padTxt.textContent = pad; this.padDot.classList.toggle('on', !!g); this._padTxt = pad; }
        if (!g) { if (this.axesEl.children.length) this.axesEl.innerHTML = ''; return; }
        if (this.axesEl.children.length !== g.axes.length) {
            this.axesEl.innerHTML = g.axes.map((_, k) => `<div class="ch" style="--c:#8a8a8a"><b>Axis ${k}</b><div class="track"><i></i><span></span></div><em></em><span></span></div>`).join('');
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
