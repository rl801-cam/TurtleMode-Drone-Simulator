// Sponza time trial: a flat oval round the open courtyard, in the format of js/tracks.js, flown
// one way (tryfpv-style: a gate counts only along its direction). Heights (`h`) are metres above
// the courtyard floor; `yaw` is the direction of travel (0 = -Z, 90 = +X), as in tracks.js.
//
// Measured by raycasts (?mode=survey&gates=1): the courtyard is open to the sky only for
// x = -8..6.9 (galleries cross its ends above ~3 m, and the end arches are narrow), the side
// arcades stand at |z| ~ 4.5 and the plant pots on the centre line at |z| ~ 1.3-1.9. So the
// straights run in lanes at |z| = 3.1 and the turns are 3.1 m-radius half circles inside the
// courtyard: no tight turns in the end bays and no blind descents. The racing line drawn in
// the map is a closed Catmull-Rom curve through the gate centres; the survey checks it too.
export const SPONZA_TRACK = {
    id: 'sponza-oval',
    name: 'Sponza Courtyard Oval',
    gateRadius: 0.45,
    directional: true,
    gates: [
        { name: 'Start', x: -4.5, h: 1.5, z: 3.1, yaw: 90 },
        { name: 'North', x: 1.0, h: 1.5, z: 3.1, yaw: 90 },
        { name: 'East', x: 6.4, h: 1.5, z: 0, yaw: 0 },
        { name: 'South', x: 2.5, h: 1.5, z: -3.1, yaw: 270 },
        { name: 'South west', x: -4.5, h: 1.5, z: -3.1, yaw: 270 },
        { name: 'West', x: -7.4, h: 1.5, z: 0, yaw: 180 },
    ],
};
// Where the run starts: on the floor a few metres before the start gate, facing it.
export const SPONZA_TRACK_SPAWN = { x: -7.5, z: 3.1, yaw: 90 };

// Extra points between gates that shape the racing line through the turns (not gates).
export const SPONZA_LINE_VIA = {
    1: [{ x: 4.6, h: 1.5, z: 2.6 }],
    2: [{ x: 4.6, h: 1.5, z: -2.6 }],
    4: [{ x: -6.6, h: 1.5, z: -2.6 }],
    5: [{ x: -6.6, h: 1.5, z: 2.6 }],
};
