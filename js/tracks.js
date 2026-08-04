// tracks.js - Race course definitions.
//
// Gate positions were laid out against the actual bando.glb collision mesh: every ring and
// every straight line between consecutive gates was checked for clearance before being
// committed here. Moving a gate more than a metre or so is likely to bury it in a pillar,
// a solar panel or the first-floor slab, so re-check before editing.
//
// `yaw` is the direction of travel through the gate, in degrees, measured the same way the
// drone's heading is: 0 looks down -Z (the way the airframe faces at spawn), +90 looks down
// +X. The gate ring is built perpendicular to that, so the normal is
// (sin(yaw), 0, -cos(yaw)) and a crossing only counts when the drone passes along it.

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
    'bando-circuit': {
        id: 'bando-circuit',
        name: 'Bando Circuit',
        map: 'bando',
        // Measured along the straight lines between gate centres; the flown line is longer
        lapLength: 449,
        gateRadius: 1.8,
        description:
            'Out of the grid, through the deck, down the pillar hall, round the west end and ' +
            'back over the solar field.',
        // Sits 14 m back from the start gate, lined up with it
        spawn: { x: 8.31, y: 1.0, z: 1.27, yaw: -36.4 },
        gates: [
            { name: 'START / FINISH', x:   0.0, y: 3.0, z: -10.0, yaw:  -36.4 },
            { name: 'BANDO ENTRY',    x:  -6.0, y: 2.6, z: -26.0, yaw:   -6.8 },
            { name: 'DECK CORRIDOR',  x:  -3.0, y: 2.6, z: -50.0, yaw:   -2.6 },
            { name: 'SOUTH TURN',     x:  -8.0, y: 2.6, z: -73.0, yaw:  -54.9 },
            { name: 'PILLARS I',      x: -33.3, y: 2.6, z: -69.7, yaw: -105.9 },
            { name: 'PILLARS II',     x: -57.9, y: 2.6, z: -58.6, yaw: -113.9 },
            { name: 'PILLARS III',    x: -83.2, y: 2.6, z: -47.6, yaw: -105.3 },
            { name: 'WEST HAIRPIN',   x: -96.0, y: 3.5, z: -46.0, yaw: -140.3 },
            { name: 'WEST STRAIGHT',  x: -93.0, y: 4.0, z:   4.0, yaw:  151.2 },
            { name: 'SOLAR SKIM',     x: -68.0, y: 6.0, z:  22.0, yaw:  116.7 },
            { name: 'BACK STRAIGHT',  x: -24.0, y: 3.0, z:  36.0, yaw:   98.1 },
            { name: 'EAST SWEEP',     x:  52.0, y: 3.0, z:  34.0, yaw:   51.3 },
            { name: 'EAST HAIRPIN',   x:  58.0, y: 3.5, z:  10.0, yaw:  -33.8 },
            { name: 'RUN-IN',         x:  18.0, y: 3.0, z:   4.0, yaw:  -66.8 }
        ]
    }
};

export const DEFAULT_TRACK = 'bando-circuit';

// m:ss.mmm, the format lap times are usually quoted in
export function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '--:--.---';
    const total = Math.round(ms);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
