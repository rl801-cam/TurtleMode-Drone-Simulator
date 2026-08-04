// ui.js - Handles DOM interactions and Menus

import { TRACKS, DEFAULT_TRACK, formatTime } from './tracks.js?v=22';

export class UIHandler {
    constructor(physicsEngine, inputHandler, renderer, race, startCallback, resumeCallback, resetCallback, exitCallback) {
        this.physics = physicsEngine;
        this.inputHandler = inputHandler;
        this.renderer = renderer;
        this.race = race;
        this.startCallback = startCallback;
        this.resumeCallback = resumeCallback;
        this.resetCallback = resetCallback;
        this.exitCallback = exitCallback;

        // 'practice' is the original free-flight mode; 'race' locks the airframe to a spec and
        // times laps round a gated course.
        this.mode = localStorage.getItem('gameMode') === 'race' ? 'race' : 'practice';
        this.trackId = localStorage.getItem('trackId') && TRACKS[localStorage.getItem('trackId')]
            ? localStorage.getItem('trackId')
            : DEFAULT_TRACK;
        this.speedReadoutEnabled = localStorage.getItem('speedReadoutEnabled') === 'true';
        this.cameraMode = localStorage.getItem('cameraMode') === 'los' ? 'los' : 'fpv';
        this.losFov = parseFloat(localStorage.getItem('losFov')) || 50;
        // Not `|| 10` - 0 degrees is a legitimate setting and would be silently overwritten
        const storedUptilt = parseFloat(localStorage.getItem('fpvUptilt'));
        this.fpvUptilt = Number.isFinite(storedUptilt) ? storedUptilt : 10;
        // Adjusting uptilt in flight happens with the menu closed, so the OSD shows the new angle
        // briefly. Without it the arrow keys give no feedback at all on a featureless wall.
        this.uptiltFlashUntil = 0;

        this.elements = {
            launchMenu: document.getElementById('launch-menu'),
            pauseMenu: document.getElementById('pause-menu'),
            osd: document.getElementById('osd'),
            
            btnStart: document.getElementById('btn-start'),
            btnResume: document.getElementById('btn-resume'),
            btnReset: document.getElementById('btn-reset'),
            btnExit: document.getElementById('btn-exit'),
            btnFullscreenMain: document.getElementById('btn-fullscreen-main'),
            btnFullscreenPause: document.getElementById('btn-fullscreen-pause'),
            
            gpStatus: document.getElementById('gamepad-status'),
            stickLeft: document.getElementById('stick-left'),
            stickRight: document.getElementById('stick-right'),
            
            bars: {
                t: document.getElementById('bar-t'),
                y: document.getElementById('bar-y'),
                p: document.getElementById('bar-p'),
                r: document.getElementById('bar-r')
            },
            
            osdArm: document.getElementById('osd-arm'),
            osdThrottle: document.getElementById('osd-throttle'),
            speedToggle: document.getElementById('speed-readout-toggle'),

            viewMode: document.getElementById('view-mode'),
            losOptions: document.getElementById('los-options'),
            fpvOptions: document.getElementById('fpv-options'),
            losFovSlider: document.getElementById('cfg-los-fov'),
            losFovValue: document.getElementById('val-los-fov'),
            uptiltSlider: document.getElementById('cfg-uptilt'),
            uptiltValue: document.getElementById('val-uptilt'),

            osdInstructions: document.getElementById('osd-instructions'),

            modeSwitch: document.getElementById('mode-switch'),
            modeBlurb: document.getElementById('mode-blurb'),
            trackSelect: document.getElementById('race-track'),
            trackDesc: document.getElementById('race-track-desc'),
            pilotName: document.getElementById('pilot-name'),
            leaderboardBody: document.getElementById('leaderboard-body'),
            btnClearBoard: document.getElementById('btn-clear-board'),

            pauseTrack: document.getElementById('pause-track'),
            pauseLaps: document.getElementById('pause-laps'),
            pauseBest: document.getElementById('pause-best'),
            pauseRecord: document.getElementById('pause-record'),
            pauseLeaderboard: document.getElementById('pause-leaderboard'),

            raceHud: document.getElementById('race-hud'),
            raceTimer: document.getElementById('race-timer'),
            raceSub: document.getElementById('race-sub'),
            raceGate: document.getElementById('race-gate'),
            racePointer: document.getElementById('race-pointer'),
            raceToast: document.getElementById('race-toast'),
            raceLaps: document.getElementById('race-laps')
        };

        this.initEventListeners();
        this.bindSliders();
        this.initCameraMode();
        this.initRaceControls();
        this.applyMode(this.mode);
    }

    get isRacing() {
        return this.mode === 'race';
    }

    get currentTrack() {
        return TRACKS[this.trackId] || TRACKS[DEFAULT_TRACK];
    }

    // --- Game mode ---------------------------------------------------------

    initRaceControls() {
        const { trackSelect, pilotName, btnClearBoard, modeSwitch } = this.elements;

        if (modeSwitch) {
            modeSwitch.querySelectorAll('.mode-btn').forEach((btn) => {
                btn.addEventListener('click', () => this.applyMode(btn.dataset.mode));
            });
        }

        if (trackSelect) {
            for (const track of Object.values(TRACKS)) {
                const option = document.createElement('option');
                option.value = track.id;
                option.textContent = track.name;
                trackSelect.appendChild(option);
            }
            trackSelect.value = this.trackId;
            trackSelect.addEventListener('change', (e) => {
                this.trackId = e.target.value;
                localStorage.setItem('trackId', this.trackId);
                this.describeTrack();
                this.renderLeaderboard();
            });
        }

        if (pilotName) {
            pilotName.value = this.race.pilotName;
            pilotName.addEventListener('input', (e) => this.race.setPilotName(e.target.value));
            // Whatever is in the box when focus leaves is what the leaderboard will record,
            // so show the cleaned-up version rather than leaving the raw text sitting there.
            pilotName.addEventListener('blur', () => { pilotName.value = this.race.pilotName; });
        }

        if (btnClearBoard) {
            btnClearBoard.addEventListener('click', () => {
                const track = this.currentTrack;
                if (!confirm(`Delete every recorded time for ${track.name}? This cannot be undone.`)) return;
                this.race.leaderboardFor(this.trackId).clear();
                this.renderLeaderboard();
            });
        }

        this.describeTrack();
    }

    applyMode(mode) {
        this.mode = mode === 'race' ? 'race' : 'practice';
        localStorage.setItem('gameMode', this.mode);

        document.body.classList.toggle('mode-race', this.isRacing);
        if (this.elements.modeSwitch) {
            this.elements.modeSwitch.querySelectorAll('.mode-btn').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.mode === this.mode);
            });
        }
        if (this.elements.modeBlurb) {
            this.elements.modeBlurb.textContent = this.isRacing
                ? 'Timed laps on a fixed spec. Fly the gates in order; every lap goes on the board.'
                : 'Free flight. Every setting is yours to change.';
        }
        if (this.elements.btnStart) {
            this.elements.btnStart.textContent = this.isRacing ? 'Start Race' : 'Start Simulation';
        }
        if (this.elements.osdInstructions) {
            this.elements.osdInstructions.textContent = this.isRacing
                ? "'Escape' Pause | 'C' View | 'R' Back to Grid | ↑↓ Uptilt"
                : "Press 'Escape' to Pause | 'C' to Switch View | ↑↓ Camera Uptilt | Toggle Arm Switch to Fly";
        }
        // Both menus reset to the same place; in a race that also throws the lap away, so the
        // button should say what it actually does.
        if (this.elements.btnReset) {
            this.elements.btnReset.textContent = this.isRacing ? 'Back to Grid' : 'Reset Drone';
        }
        if (this.elements.raceHud) {
            this.elements.raceHud.classList.toggle('hidden', !this.isRacing);
        }

        this.renderLeaderboard();
    }

    describeTrack() {
        const track = this.currentTrack;
        if (this.elements.trackDesc) {
            this.elements.trackDesc.textContent =
                `${track.description} ${track.gates.length} gates, about ${track.lapLength} m a lap.`;
        }
    }

    // --- Leaderboard -------------------------------------------------------

    // `highlightMs` marks the row the pilot just put up, so they can find themselves on a
    // board that may have scrolled past them
    renderLeaderboard(highlightMs) {
        const board = this.race.leaderboardFor(this.trackId);
        const entries = board.top();
        const html = entries.length
            ? entries.map((entry, i) => {
                const classes = ['board-row'];
                if (i < 3) classes.push('podium');
                if (i === 0) classes.push('leader');
                if (highlightMs !== undefined && entry.ms === highlightMs) classes.push('you');
                return `<div class="${classes.join(' ')}">` +
                    `<span class="rank">${i + 1}</span>` +
                    `<span class="pilot">${this.escape(entry.name)}</span>` +
                    `<span class="time">${formatTime(entry.ms)}</span>` +
                    `</div>`;
            }).join('')
            : '<div class="board-empty">No times yet. Fly a clean lap and put one up.</div>';

        if (this.elements.leaderboardBody) this.elements.leaderboardBody.innerHTML = html;
        if (this.elements.pauseLeaderboard) this.elements.pauseLeaderboard.innerHTML = html;
    }

    // Pilot names come from a free-text box and get written straight into innerHTML
    escape(text) {
        return String(text).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    initCameraMode() {
        if (this.elements.losFovSlider) {
            this.elements.losFovSlider.value = this.losFov;
            this.elements.losFovValue.textContent = this.losFov;
            this.elements.losFovSlider.addEventListener('input', (e) => {
                this.losFov = parseFloat(e.target.value);
                this.elements.losFovValue.textContent = this.losFov;
                localStorage.setItem('losFov', this.losFov);
                this.renderer.setLosFov(this.losFov);
            });
        }

        if (this.elements.uptiltSlider) {
            this.elements.uptiltSlider.addEventListener('input', (e) => {
                this.setFpvUptilt(parseFloat(e.target.value), false);
            });
        }

        if (this.elements.viewMode) {
            this.elements.viewMode.addEventListener('change', (e) => this.applyCameraMode(e.target.value));
        }

        this.renderer.setLosFov(this.losFov);
        this.setFpvUptilt(this.fpvUptilt, false);
        this.applyCameraMode(this.cameraMode);
    }

    // The renderer owns the usable range and hands back what it actually applied, so the slider
    // and the stored value can never drift past it.
    setFpvUptilt(degrees, flash) {
        this.fpvUptilt = this.renderer.setFpvUptilt(degrees);
        localStorage.setItem('fpvUptilt', this.fpvUptilt);

        if (this.elements.uptiltSlider) this.elements.uptiltSlider.value = this.fpvUptilt;
        if (this.elements.uptiltValue) this.elements.uptiltValue.textContent = this.fpvUptilt;
        if (flash) this.uptiltFlashUntil = performance.now() + 1500;
    }

    // Arrow keys in flight. Meaningless in Line of Sight - there is no onboard camera to tilt -
    // so it is ignored there rather than changing something the pilot cannot see.
    adjustFpvUptilt(delta) {
        if (this.cameraMode !== 'fpv') return;
        this.setFpvUptilt(this.fpvUptilt + delta, true);
    }

    applyCameraMode(mode) {
        this.cameraMode = mode === 'los' ? 'los' : 'fpv';
        localStorage.setItem('cameraMode', this.cameraMode);

        if (this.elements.viewMode) this.elements.viewMode.value = this.cameraMode;
        if (this.elements.losOptions) {
            this.elements.losOptions.style.display = this.cameraMode === 'los' ? 'block' : 'none';
        }
        // Video latency is a property of the feed, and in Line of Sight there is no feed - the
        // pilot is watching the drone itself. Hide it rather than leave a control that does nothing.
        if (this.elements.fpvOptions) {
            this.elements.fpvOptions.style.display = this.cameraMode === 'los' ? 'none' : 'block';
        }
        // The FPV crosshair is meaningless when watching from the ground
        this.elements.osd.classList.toggle('los-view', this.cameraMode === 'los');

        this.renderer.setCameraMode(this.cameraMode);
    }

    toggleCameraMode() {
        this.applyCameraMode(this.cameraMode === 'los' ? 'fpv' : 'los');
    }

    initEventListeners() {
        this.elements.btnStart.addEventListener('click', async () => {
            // A race always runs on its track's own map - the gates were placed against that
            // geometry and mean nothing anywhere else.
            const track = this.isRacing ? this.currentTrack : null;
            const mapChoice = track ? track.map : document.getElementById('map-choice').value;
            const originalText = this.elements.btnStart.textContent;
            this.elements.btnStart.textContent = "Loading Map...";
            this.elements.btnStart.disabled = true;

            try {
                await this.startCallback(mapChoice, this.mode, track);

                this.hideMenu(this.elements.launchMenu);
                this.elements.osd.classList.remove('hidden');
            } catch (err) {
                console.error("Failed to start:", err);
                alert("Failed to load the selected map. Please check the console for details.");
            } finally {
                this.elements.btnStart.textContent = originalText;
                this.elements.btnStart.disabled = false;
            }
        });

        this.elements.btnResume.addEventListener('click', () => {
            this.hideMenu(this.elements.pauseMenu);
            this.elements.osd.classList.remove('hidden');
            this.resumeCallback();
        });

        this.elements.btnReset.addEventListener('click', () => {
            this.hideMenu(this.elements.pauseMenu);
            this.elements.osd.classList.remove('hidden');
            this.resetCallback();
        });

        this.elements.btnExit.addEventListener('click', () => {
            this.hideMenu(this.elements.pauseMenu);
            // Don't show OSD.
            this.elements.launchMenu.classList.remove('hidden');
            // Slight delay before active to trigger transition
            setTimeout(() => {
                this.elements.launchMenu.classList.add('active');
            }, 10);
            this.exitCallback();
        });

        window.addEventListener('fpv-controller-connected', (e) => {
            if (e.detail.connected) {
                this.elements.gpStatus.textContent = "Gamepad Connected";
                this.elements.gpStatus.className = "status-indicator connected";
            } else {
                this.elements.gpStatus.textContent = "No Gamepad Detected";
                this.elements.gpStatus.className = "status-indicator disconnected";
            }
        });

        const btnAddMap = document.getElementById('btn-add-map');
        const fileAddMap = document.getElementById('file-add-map');
        const mapChoice = document.getElementById('map-choice');

        btnAddMap.addEventListener('click', () => {
            fileAddMap.click();
        });

        fileAddMap.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const objectUrl = URL.createObjectURL(file);
            const option = document.createElement('option');
            option.value = objectUrl;
            option.textContent = `Custom: ${file.name}`;
            mapChoice.appendChild(option);
            mapChoice.value = objectUrl;

            // Clear input so same file can be uploaded again if needed
            e.target.value = '';
        });

        // Speed Readout Toggle
        if (this.elements.speedToggle) {
            this.elements.speedToggle.checked = this.speedReadoutEnabled;
            this.elements.speedToggle.addEventListener('change', (e) => {
                this.speedReadoutEnabled = e.target.checked;
                localStorage.setItem('speedReadoutEnabled', this.speedReadoutEnabled);
            });
        }

        // Fullscreen Toggle Buttons
        const toggleFullscreen = () => {
            console.log("toggleFullscreen called.");
            const doc = document;
            const docEl = doc.documentElement;
            
            // Check cross-browser fullscreen state
            const isFS = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;
            
            if (!isFS) {
                console.log("Requesting fullscreen...");
                const requestFS = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
                if (requestFS) {
                    requestFS.call(docEl).catch(err => {
                        console.error(`Fullscreen request failed: ${err.message}`, err);
                    });
                } else {
                    console.error("Fullscreen API not supported on this browser.");
                }
            } else {
                console.log("Exiting fullscreen...");
                const exitFS = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
                if (exitFS) {
                    exitFS.call(doc);
                } else {
                    console.error("Exit fullscreen API not supported on this browser.");
                }
            }
        };

        if (this.elements.btnFullscreenMain) {
            this.elements.btnFullscreenMain.addEventListener('click', toggleFullscreen);
        }
        if (this.elements.btnFullscreenPause) {
            this.elements.btnFullscreenPause.addEventListener('click', toggleFullscreen);
        }

        const handleFullscreenChange = () => {
            const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
            console.log("Fullscreen state changed. Active:", isFullscreen);
            if (this.elements.btnFullscreenMain) {
                this.elements.btnFullscreenMain.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
            }
            if (this.elements.btnFullscreenPause) {
                this.elements.btnFullscreenPause.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
            }
        };

        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    }

    bindSliders() {
        const bindSlider = (id, valId, callback, decimals) => {
            const slider = document.getElementById(id);
            const valSpan = document.getElementById(valId);
            const places = decimals !== undefined ? decimals : (id.includes('drag') ? 2 : 1);
            slider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                valSpan.textContent = val.toFixed(places);
                callback(val);
            });
        };

        // Launch Menu
        bindSlider('cfg-mass', 'val-mass', (val) => this.physics.updateConfig({ mass: val }));
        bindSlider('cfg-thrust', 'val-thrust', (val) => this.physics.updateConfig({ thrust: val }));
        bindSlider('cfg-drag', 'val-drag', (val) => this.physics.updateConfig({ drag: val }));
        bindSlider('cfg-restitution', 'val-restitution', (val) => this.physics.updateConfig({ restitution: val }), 2);
        bindSlider('cfg-friction', 'val-friction', (val) => this.physics.updateConfig({ friction: val }), 2);
        bindSlider('cfg-wind', 'val-wind', (val) => this.physics.updateConfig({ wind: { strength: val } }), 2);

        // Wind axis toggles
        const bindWindAxis = (id, axis) => {
            const checkbox = document.getElementById(id);
            if (!checkbox) return;
            checkbox.addEventListener('change', (e) => {
                this.physics.updateConfig({ wind: { [axis]: e.target.checked } });
            });
        };
        bindWindAxis('wind-roll', 'roll');
        bindWindAxis('wind-pitch', 'pitch');
        bindWindAxis('wind-yaw', 'yaw');

        // Pause Menu (Rates)
        // Roll
        bindSlider('tune-r-c', 'val-r-c', (val) => this.physics.updateConfig({ rates: { roll: { center: val } } }));
        bindSlider('tune-r-m', 'val-r-m', (val) => this.physics.updateConfig({ rates: { roll: { max: val } } }));
        bindSlider('tune-r-e', 'val-r-e', (val) => this.physics.updateConfig({ rates: { roll: { expo: val } } }));
        // Pitch
        bindSlider('tune-p-c', 'val-p-c', (val) => this.physics.updateConfig({ rates: { pitch: { center: val } } }));
        bindSlider('tune-p-m', 'val-p-m', (val) => this.physics.updateConfig({ rates: { pitch: { max: val } } }));
        bindSlider('tune-p-e', 'val-p-e', (val) => this.physics.updateConfig({ rates: { pitch: { expo: val } } }));
        // Yaw
        bindSlider('tune-y-c', 'val-y-c', (val) => this.physics.updateConfig({ rates: { yaw: { center: val } } }));
        bindSlider('tune-y-m', 'val-y-m', (val) => this.physics.updateConfig({ rates: { yaw: { max: val } } }));
        bindSlider('tune-y-e', 'val-y-e', (val) => this.physics.updateConfig({ rates: { yaw: { expo: val } } }));

        const updateBarLabels = () => {
            const throttleIdx = document.getElementById('map-t-idx')?.value ?? '2';
            const yawIdx = document.getElementById('map-y-idx')?.value ?? '3';
            const pitchIdx = document.getElementById('map-p-idx')?.value ?? '1';
            const rollIdx = document.getElementById('map-r-idx')?.value ?? '0';

            const lblT = document.getElementById('lbl-bar-t');
            const lblY = document.getElementById('lbl-bar-y');
            const lblP = document.getElementById('lbl-bar-p');
            const lblR = document.getElementById('lbl-bar-r');

            if (lblT) lblT.textContent = `T (${throttleIdx})`;
            if (lblY) lblY.textContent = `Y (${yawIdx})`;
            if (lblP) lblP.textContent = `P (${pitchIdx})`;
            if (lblR) lblR.textContent = `R (${rollIdx})`;
        };

        // Mapping Inputs
        const bindMapping = (id, key) => {
            const input = document.getElementById(id);
            if (input) {
                input.addEventListener('change', (e) => {
                    this.inputHandler.updateMapping('axis', key, e.target.value);
                    updateBarLabels();
                });
            }
        };
        const bindReverse = (id, key) => {
            const checkbox = document.getElementById(id);
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    this.inputHandler.updateMapping('reverse', key, e.target.checked);
                });
            }
        };

        bindMapping('map-t-idx', 'throttle');
        bindMapping('map-y-idx', 'yaw');
        bindMapping('map-p-idx', 'pitch');
        bindMapping('map-r-idx', 'roll');
        bindMapping('map-arm-idx', 'armButton');

        bindReverse('map-t-rev', 'throttle');
        bindReverse('map-y-rev', 'yaw');
        bindReverse('map-p-rev', 'pitch');
        bindReverse('map-r-rev', 'roll');

        // Force an initial update of the input handler mapping from the DOM values on load.
        // This synchronizes the input handler with whatever the DOM elements contain (including browser autofill or defaults).
        const syncMappingFromDOM = () => {
            const inputs = [
                { id: 'map-t-idx', key: 'throttle', type: 'axis' },
                { id: 'map-y-idx', key: 'yaw', type: 'axis' },
                { id: 'map-p-idx', key: 'pitch', type: 'axis' },
                { id: 'map-r-idx', key: 'roll', type: 'axis' },
                { id: 'map-arm-idx', key: 'armButton', type: 'axis' }
            ];
            const checkboxes = [
                { id: 'map-t-rev', key: 'throttle', type: 'reverse' },
                { id: 'map-y-rev', key: 'yaw', type: 'reverse' },
                { id: 'map-p-rev', key: 'pitch', type: 'reverse' },
                { id: 'map-r-rev', key: 'roll', type: 'reverse' }
            ];

            inputs.forEach(item => {
                const el = document.getElementById(item.id);
                if (el) {
                    this.inputHandler.updateMapping(item.type, item.key, el.value);
                }
            });
            checkboxes.forEach(item => {
                const el = document.getElementById(item.id);
                if (el) {
                    this.inputHandler.updateMapping(item.type, item.key, el.checked);
                }
            });
            updateBarLabels();
        };

        syncMappingFromDOM();
    }

    // Pushes every practice control's current value into the physics engine. Racing overwrites
    // the whole config with a fixed spec, so returning to practice has to put the pilot's own
    // numbers back rather than leaving them stranded on the sliders.
    applyPracticeConfig() {
        const num = (id) => parseFloat(document.getElementById(id).value);
        const checked = (id) => document.getElementById(id).checked;

        this.physics.updateConfig({
            mass: num('cfg-mass'),
            thrust: num('cfg-thrust'),
            drag: num('cfg-drag'),
            restitution: num('cfg-restitution'),
            friction: num('cfg-friction'),
            wind: {
                strength: num('cfg-wind'),
                roll: checked('wind-roll'),
                pitch: checked('wind-pitch'),
                yaw: checked('wind-yaw')
            },
            rates: {
                roll: { center: num('tune-r-c'), max: num('tune-r-m'), expo: num('tune-r-e') },
                pitch: { center: num('tune-p-c'), max: num('tune-p-m'), expo: num('tune-p-e') },
                yaw: { center: num('tune-y-c'), max: num('tune-y-m'), expo: num('tune-y-e') }
            }
        });
    }

    showPauseMenu() {
        this.elements.osd.classList.add('hidden');
        this.elements.pauseMenu.classList.remove('hidden');
        this.elements.pauseMenu.classList.add('active');
        if (this.isRacing) this.updatePauseRace();
    }

    updatePauseRace() {
        const status = this.race.status();
        const track = this.currentTrack;
        if (this.elements.pauseTrack) this.elements.pauseTrack.textContent = track.name;
        if (this.elements.pauseLaps) this.elements.pauseLaps.textContent = String(status.lap - 1);
        if (this.elements.pauseBest) this.elements.pauseBest.textContent = formatTime(status.bestMs);
        if (this.elements.pauseRecord) this.elements.pauseRecord.textContent = formatTime(status.recordMs);
        this.renderLeaderboard(status.bestMs ?? undefined);
    }

    // --- Race HUD ----------------------------------------------------------

    updateRaceHud(distance, pointerAngle) {
        const status = this.race.status();
        const { raceTimer, raceSub, raceGate, racePointer, raceLaps } = this.elements;

        if (raceTimer) raceTimer.textContent = formatTime(status.currentMs);

        if (raceSub) {
            raceSub.textContent = status.state === 'ARMED'
                ? 'ARMED — cross the start gate to begin'
                : `LAP ${status.lap}`;
        }

        if (raceGate) {
            const gate = this.race.gates[this.race.nextGate];
            const label = gate ? gate.name : '';
            raceGate.textContent =
                `GATE ${status.nextGate}/${status.gateCount} · ${label} · ${distance.toFixed(0)} m`;
        }

        if (raceLaps) {
            const lines = [];
            if (status.lastMs !== null) lines.push(`LAST ${formatTime(status.lastMs)}`);
            if (status.bestMs !== null) lines.push(`<span class="lap-best">BEST ${formatTime(status.bestMs)}</span>`);
            if (status.recordMs !== null) lines.push(`REC&nbsp; ${formatTime(status.recordMs)}`);
            raceLaps.innerHTML = lines.join('<br>');
        }

        if (racePointer) {
            if (pointerAngle === null) {
                racePointer.classList.remove('visible');
            } else {
                racePointer.classList.add('visible');
                racePointer.style.transform = `rotate(${pointerAngle}rad)`;
            }
        }
    }

    showRaceToast(text, isRecord) {
        const toast = this.elements.raceToast;
        if (!toast) return;
        toast.textContent = text;
        toast.classList.toggle('record', !!isRecord);
        // Restarting a CSS animation needs the class off and a reflow forced in between
        toast.classList.remove('show');
        void toast.offsetWidth;
        toast.classList.add('show');
    }

    hideMenu(menuElement) {
        menuElement.classList.remove('active');
        setTimeout(() => {
            menuElement.classList.add('hidden');
        }, 300); // Wait for transition
    }

    updateDashboard(axes, armed) {
        // Update input visualizer in launch menu (if active)
        if (this.elements.launchMenu.classList.contains('active')) {
            // Map axes to visual dots (assuming mode 2: Left=Yaw/Thr, Right=Roll/Pitch)
            // axes.throttle [0, 1] -> Y axis of left stick (invert for CSS top)
            // axes.yaw [-1, 1] -> X axis of left stick
            const ly = (1 - axes.throttle) * 100; 
            const lx = ((axes.yaw + 1) / 2) * 100;
            this.elements.stickLeft.style.top = `${ly}%`;
            this.elements.stickLeft.style.left = `${lx}%`;

            // axes.pitch [-1, 1] -> Y axis of right stick (pitch down is negative raw, so top)
            const ry = ((axes.pitch + 1) / 2) * 100;
            const rx = ((axes.roll + 1) / 2) * 100;
            this.elements.stickRight.style.top = `${ry}%`;
            this.elements.stickRight.style.left = `${rx}%`;

            // Bars
            this.elements.bars.t.innerHTML = `<div class="bar-value" style="width: ${axes.throttle * 100}%; background: ${axes.throttle > 0 ? 'var(--accent-color)' : 'transparent'};"></div>`;
            this.elements.bars.y.innerHTML = `<div class="bar-value" style="width: ${Math.abs(axes.yaw) * 50}%; margin-left: ${axes.yaw < 0 ? 50 - Math.abs(axes.yaw)*50 : 50}%;"></div>`;
            this.elements.bars.p.innerHTML = `<div class="bar-value" style="width: ${Math.abs(axes.pitch) * 50}%; margin-left: ${axes.pitch < 0 ? 50 - Math.abs(axes.pitch)*50 : 50}%;"></div>`;
            this.elements.bars.r.innerHTML = `<div class="bar-value" style="width: ${Math.abs(axes.roll) * 50}%; margin-left: ${axes.roll < 0 ? 50 - Math.abs(axes.roll)*50 : 50}%;"></div>`;
        }

        // Update OSD
        if (!this.elements.osd.classList.contains('hidden')) {
            if (armed) {
                this.elements.osdArm.textContent = "ARMED";
                this.elements.osdArm.classList.add('armed');
            } else {
                this.elements.osdArm.textContent = "DISARMED";
                this.elements.osdArm.classList.remove('armed');
            }
            
            let throttleText = `THR: ${Math.round(axes.throttle * 100)}%`;
            if (this.cameraMode === 'los') {
                throttleText += ` | DIST: ${this.renderer.getLosDistance().toFixed(0)} m`;
            }
            if (this.cameraMode === 'fpv' && performance.now() < this.uptiltFlashUntil) {
                throttleText += ` | TILT: ${this.fpvUptilt}°`;
            }
            if (this.speedReadoutEnabled) {
                const velocity = this.physics.droneBody.velocity;
                const speedMs = velocity.length();
                const speedKph = speedMs * 3.6;
                throttleText += ` | SPD: ${speedKph.toFixed(1)} km/h`;
            }
            this.elements.osdThrottle.textContent = throttleText;
        }
    }
}
