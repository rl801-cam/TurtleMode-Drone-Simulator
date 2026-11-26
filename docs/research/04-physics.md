# Flight dynamics and physics engine (research, 2026-11-25)

Sub-agent web research, condensed. [S] sourced, [E] estimate - calibrate before relying on it.

## Verdicts

1. **Flight model**: per-motor plant at a fixed 1 kHz step with rotor speed as state. Every gap in
   `handoff.md` (spool-up lag, differential yaw, prop wash, battery sag, idle/airmode, turtle
   mode, centre-of-pressure effects) falls out of four rotor speeds plus a battery voltage.
2. **Physics engine**: none. Keep the custom single-body integrator and contact solver, drop
   cannon-es (346 KB used only to integrate one body), and add heightfield and analytic tree
   colliders to the solver.
3. **Betaflight in wasm**: proven (four public 2026 projects), but GPL-3 for the whole sim. It is
   the team's licensing call. Otherwise, write a behavioural reimplementation from documented
   behaviour, not from translated source.
4. **Web Worker**: not needed. The Gamepad API is `Exposed=Window` only, so a worker adds a hop
   and removes no latency, and 1 kHz of this model is ~1-2% of a core [E].

## Flight model spec

**State**: p, v, q, omega_body; rotor speeds Omega_i (signed, for turtle mode); battery SoC + one
RC polarisation voltage; one Ornstein-Uhlenbeck noise state per rotor.

**Integrator**: symplectic Euler at 1 ms (NeuroBEM, Agilicious use 1 kHz [S]), including the
-omega x J omega term.

**Rotors**: T_i = kT Omega_i^2 and Q_i = kQ Omega_i^2, applied at hub r_i.
Yaw = sum(dir_i Q_i) + J_rotor sum(dir_i dOmega_i/dt), where the second term is the spin-up kick.
Starting values [E]:

- kT = maxThrust / (4 Omega_max^2), about 1.1e-6 for 30 N at Omega_max of about 2600 rad/s;
- kQ/kT about 0.012-0.016 m for 5" props;
- J_rotor about 6-8e-6 kg m^2.

Reference airframes: NeuroBEM 752 g / 33 N; Swift 870 g / 35 N [S].

**Motor**:

- Tier 1: first-order lag, tau 30 ms up / 40 ms down [E]. Measured 33 ms (NeuroBEM) and 39 ms
  (Agilicious); PX4 iris uses 12.5/25 ms [S].
- Tier 2: equivalent DC machine. I = (duty V_bat - Omega/KV)/R and
  J dOmega/dt = Kt (I - I0) - kQ Omega^2, with KV 1800, R 0.06-0.08 ohm [E]. Gives lag, sag
  coupling and braking.

**Battery**: Thevenin, V = OCV(SoC) - I R0 - V1; R0 15-25 mOhm for a 6S 1300 mAh pack [E].
Swift drives its battery model with P = kQ Omega^3 / eta [S].

**Throttle**: the current (1-c)t + c t^2 blend becomes the duty -> Omega steady-state target. A 5"
6S quad hovers at 17-35% throttle [S].

**Inflow**: keep the linear fade to zero at propPitchSpeed (PX4's Gazebo motor model does the same
[S]), but evaluate it per rotor at the hub velocity v + omega x r_i, which adds aerodynamic
damping and centre-of-pressure-like moments.

**Rotor drag (H-force)**: F = -k_d |Omega_i| v_perp at each hub [S]. The current 0.45 N/(m/s)
maps to k_d of about 4.3e-5 per rotor [E].

**Airframe drag**: keep CdA 0.009/0.025/0.008 m^2.

**Wind**: subtract air velocity before every aero term, so wind is moving air.

**Vortex ring state** (NeuroBEM eq. 19 [S]):

- v_h = sqrt(T / (2 rho A)) and x = descent speed / v_h;
- v_i = v_h (1 + 1.125x - 1.372x^2 + 1.718x^3 - 0.655x^4), clamped below at v_h;
- the band is roughly 3-9 m/s of descent at hover throttle for this quad [E].

**Prop wash** (heuristic): inside the VRS band, scale rotor thrust by (1 - loss(x)) and add OU
noise with tau 50-100 ms. Wind-tunnel data shows up to 20% mean loss with amplified
fluctuation [S].

**Ground effect** (gym-pybullet-drones [S]): dT = T k (R / 4h)^2 per rotor, with h clamped,
applied only when tilt is under 90 degrees.

**Controller behaviours** (Swift documents these Betaflight quirks [S]):

- D on measurement;
- I reset at throttle cut;
- proportional motor scale-down on saturation;
- airmode;
- idle floor of ~5%;
- turtle: `applyCrashFlipModeToMotors` in `mixer.c`, 15% stick deadband; reversed props at
  ~40-60% efficiency [E].

## Betaflight in wasm

| Project | Notes |
| --- | --- |
| https://github.com/cheesejaguar/fpv-sim | BF 4.5.5, 8 kHz lock-step, SAB worker; ~120x real time; `-ffp-contract=off` |
| https://github.com/mfleming0101/fpv-rook-web-betaflight | cleanest standalone build (Zig, one patch) |
| https://github.com/fdflabs/fdfpv | BF 4.5.1 at 1 kHz on GitHub Pages; `sim.wasm` 319 KB / 109 KB gzip |
| https://github.com/ryanroths/quadmath-sim-core | reproducible build |

All GPL-3 and weeks old; their claims are self-reported. Upstream SITL speaks UDP, so every
project replaces the platform layer. A line-by-line translation of `pid.c`/`rc.c` is also
derivative work. Not legal advice. **The repo has no LICENSE file today** - worth fixing
whichever way this goes.

## Physics engines (sizes measured from npm)

| Engine | Raw | Gzip |
| --- | --- | --- |
| cannon-es 0.20.0 | 346 KB | 75 KB |
| box3d-wasm 0.2.0 | 0.52 MB | 0.21 MB |
| Havok 1.3.14 | 2.09 MB | 0.66 MB |
| Jolt 1.1.2 | 2.03 MB | 0.75 MB |
| Rapier3d-compat 0.21.0 | 3.08 MB | 1.17 MB |
| PhysX 2.9.1 | 5.41 MB | 1.61 MB |

With one dynamic body, an engine's solver, broadphase and islands buy nothing, and Jolt
documents the CCD and ghost-edge weaknesses we would inherit. Revisit Jolt or Rapier only if
there are many dynamic bodies.

**Heightfield vs triangle BVH**: 2-4 B per sample against ~50-60 B per grid cell as triangles
plus BVH, a 13-27x saving; a 1025^2 terrain is 2-4 MB against ~57 MB. Heightfields can't do
overhangs, so bando and the quarry arch keep their BVH. Sphere-vs-heightfield tests the two
triangles of each cell under the sphere using the existing sphere-triangle routine, keeping the
diagonal rule (invariant 24). Trees are analytic capsules in a uniform grid.

**Determinism**: ghosts need only recorded poses. Validating a leaderboard by replaying inputs
needs bit-exact stepping, which a custom JS integrator can achieve if the step path uses only
+ - * / and sqrt. Offenders in `js/physics.js` today:

- `Math.pow(rc, 3)`;
- `Math.random` wind;
- `Math.atan2`;
- `Math.exp` at init.

## Commercial sims

Nothing public on physics rates or motor models. Liftoff's dev blog: thrust from a lab-test
database; drag from projected area sampled at 42 angles; Physics 5.0 replaced most of Unity's
physics. fpv-sim is the only detailed open crash model: ~70 Hunt-Crossley spheres, prop-disc
colliders that carry blade-tip velocity, energy-based damage.

## Input loop

Poll the gamepad at the top of each animation frame, run a fixed-step accumulator, and
interpolate stick values across the substeps (as RC smoothing does). GitHub Pages can't send
COOP/COEP; `coi-serviceworker` works around it (reload on first visit, HTTPS), but no
`SharedArrayBuffer` is needed.

## References

- RotorPy `rotorpy/vehicles/multirotor.py`; gym-pybullet-drones `envs/BaseAviary.py`; PX4
  `gazebo_motor_model.cpp`
- NeuroBEM https://arxiv.org/abs/2106.08015 ; Agilicious https://arxiv.org/abs/2307.06100 ;
  Swift https://rpg.ifi.uzh.ch/docs/Nature23_Kaufmann.pdf
- Rapier determinism https://rapier.rs/docs/user_guides/javascript/determinism/ ; Jolt
  https://jrouwe.github.io/JoltPhysics/
