// ui.js - Handles DOM interactions and Menus

export class UIHandler {
    constructor(physicsEngine, inputHandler, renderer, startCallback, resumeCallback, resetCallback, exitCallback) {
        this.physics = physicsEngine;
        this.inputHandler = inputHandler;
        this.renderer = renderer;
        this.startCallback = startCallback;
        this.resumeCallback = resumeCallback;
        this.resetCallback = resetCallback;
        this.exitCallback = exitCallback;
        this.speedReadoutEnabled = localStorage.getItem('speedReadoutEnabled') === 'true';
        this.cameraMode = localStorage.getItem('cameraMode') === 'los' ? 'los' : 'fpv';
        this.losFov = parseFloat(localStorage.getItem('losFov')) || 50;

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
            losFovValue: document.getElementById('val-los-fov')
        };

        this.initEventListeners();
        this.bindSliders();
        this.initCameraMode();
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

        if (this.elements.viewMode) {
            this.elements.viewMode.addEventListener('change', (e) => this.applyCameraMode(e.target.value));
        }

        this.renderer.setLosFov(this.losFov);
        this.applyCameraMode(this.cameraMode);
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
            const mapChoice = document.getElementById('map-choice').value;
            const originalText = this.elements.btnStart.textContent;
            this.elements.btnStart.textContent = "Loading Map...";
            this.elements.btnStart.disabled = true;
            
            try {
                await this.startCallback(mapChoice);
                
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

    showPauseMenu() {
        this.elements.osd.classList.add('hidden');
        this.elements.pauseMenu.classList.remove('hidden');
        this.elements.pauseMenu.classList.add('active');
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
