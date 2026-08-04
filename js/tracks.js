// tracks.js - Race course definitions.
//
// Gate positions were laid out against the actual bando.glb collision mesh: every ring and
// every flown line between consecutive gates was checked for clearance before being committed
// here. Several gates sit inside openings only a couple of metres across, so a gate moved even
// half a metre is likely to end up buried in a wall, a panel or the first-floor slab. Re-measure
// before editing.
//
// `yaw` is the direction of travel through the gate, in degrees, measured the same way the
// drone's heading is: 0 looks down -Z (the way the airframe faces at spawn), +90 looks down +X.
// `pitch` tilts that direction out of the horizontal, +90 being straight up, so the normal is
// (sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)). The ring is built perpendicular to it
// and a crossing only counts when the drone passes along it, which is what stops a gate lying
// flat in a floor hatch from being taken on the way back down.
//
// `radius` overrides the track default for a single gate. The rings threaded through the wall
// holes have to be smaller than the holes themselves.

// Racing runs to a fixed spec so every lap on the leaderboard was flown on the same machine
// in the same air. These override whatever the practice sliders are set to.
export const RACE_SPEC = {
    mass: 0.5,
    thrust: 25,
    drag: 0.5,
    restitution: 0.2,
    friction: 0.2,
    // Dead calm - a drifting breeze would make two laps incomparable
    wind: { roll: false, pitch: false, yaw: false, strength: 0 },
    rates: {
        roll: { center: 200, max: 600, expo: 0.5 },
        pitch: { center: 200, max: 600, expo: 0.5 },
        yaw: { center: 200, max: 400, expo: 0.5 }
    },
    // Video latency is part of the spec too: a laggy feed only ever costs time, but it would
    // still make a leaderboard meaningless if pilots ran different amounts of it.
    latencyMs: 0
};

export const TRACKS = {
    'bando-gauntlet': {
        id: 'bando-gauntlet',
        name: 'Bando Gauntlet',
        map: 'bando',
        // Measured along the flown line between gate centres; the line you actually take is longer
        lapLength: 304,
        gateRadius: 1.8,
        description:
            'Into the bando, through a hole in the wall, up the service shaft, out through the ' +
            'wall above and down the hatch, then flat out under the solar array.',
        // Sits 14 m back from the start gate, lined up with it
        spawn: { x: 13.0, y: 1.0, z: 11.0, yaw: 0 },
        gates: [
            // --- into the building, ducking under the first-floor deck ---
            { name: 'START / FINISH',  x:  13.00, y: 2.60, z:  -3.00, yaw:    0 },
            { name: 'BANDO ENTRY',     x:   4.00, y: 2.80, z: -19.00, yaw:  -30 },
            // Lines the run-in up square with the wall - a 2 m hole is not something you take
            // at an angle.
            { name: 'WALL LINE-UP',    x:  -3.00, y: 2.65, z: -30.51, yaw:  -70, radius: 1.5 },
            // Threaded through one of the five round holes in the ground-floor wall. The hole
            // measures 1.00 m in radius, so the ring is very nearly a push fit.
            { name: 'WALL HOLE',       x: -11.72, y: 2.65, z: -30.51, yaw:  -90, radius: 0.8 },

            // --- west down the pillar hall to the service shaft ---
            { name: 'PILLAR SLALOM',   x: -33.35, y: 2.60, z: -37.00, yaw:  -70, radius: 1.5 },
            { name: 'DEEP HALL',       x: -46.00, y: 2.70, z: -41.50, yaw:  -70, radius: 1.5 },
            // Lying flat in the opening through the first-floor slab. Run in level underneath,
            // then stand it on its tail: the ring only counts on the way up.
            { name: 'THE SHAFT',       x: -57.76, y: 5.00, z: -46.90, yaw:    0, pitch:  90, radius: 2.0 },
            // Out of the second storey through the matching hole in the upper wall, 7.8 m up.
            { name: 'UPPER WALL HOLE', x: -37.11, y: 7.82, z: -46.91, yaw:   90, radius: 0.8 },
            // Back down through the deck the same way, this time nose first
            { name: 'DECK DIVE',       x:   0.00, y: 5.00, z: -46.40, yaw:    0, pitch: -90, radius: 2.4 },
            { name: 'RUN-OUT',         x:  -6.00, y: 2.60, z: -24.00, yaw:  195 },

            // --- under the solar array: a 1.6 m ceiling and a foundation post every 4.5 m ---
            { name: 'PANEL DUCK I',    x: -15.90, y: 0.85, z:  12.28, yaw:  180, radius: 0.62 },
            { name: 'PANEL DUCK II',   x: -13.82, y: 0.85, z:  16.47, yaw:  180, radius: 0.62 },
            { name: 'PANEL DUCK III',  x: -11.32, y: 0.85, z:  21.41, yaw:  180, radius: 0.62 },
            { name: 'PANEL DUCK IV',   x:  -9.35, y: 0.85, z:  25.59, yaw:  180, radius: 0.62 },
            // Sits clear of the last row, so the climb out does not start under a panel
            { name: 'PANEL EXIT',      x:  -7.00, y: 1.40, z:  28.50, yaw:  165, radius: 1.2 },

            // --- the one place on the lap with room to breathe ---
            { name: 'CORRIDOR TURN',   x:  20.00, y: 5.00, z:  38.00, yaw:  120 },
            { name: 'SOLAR SKIM',      x:  16.00, y: 5.20, z:  18.00, yaw:  -10 }
        ]
    }
};

export const DEFAULT_TRACK = 'bando-gauntlet';

// m:ss.mmm, the format lap times are usually quoted in
export function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '--:--.---';
    const total = Math.round(ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
