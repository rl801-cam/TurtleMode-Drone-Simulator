// main.js - Entry point for the application

// The ?v= tags are cache busters, matching the one on style.css. Browsers cache ES modules
// aggressively, so without them an edited module can keep running from cache against fresh
// HTML. Bump every one of these (and the two in index.html) together after changing any file.
import { Renderer } from './renderer.js?v=18';
import { PhysicsEngine } from './physics.js?v=18';
import { InputHandler } from './input.js?v=18';
import { UIHandler } from './ui.js?v=18';
import { AudioEngine } from './audio.js?v=18';
import { VideoDelay } from './latency.js?v=18';

// Shown in the launch menu and logged on boot. index.html itself carries no cache buster, so a
// browser holding a stale copy of it will keep loading the old ?v= modules and none of the tags
// above will help. If this does not match the newest version, the page needs a hard reload.
const BUILD = 'v18';

class Simulator {
    constructor() {
        this.renderer = new Renderer('sim-container');
        this.physics = new PhysicsEngine();
        this.input = new InputHandler();
        this.audio = new AudioEngine();
        this.videoDelay = new VideoDelay();
        
        // Register collision check callback to evaluate inside the physics sub-step.
        // The physics engine drives the radius - it queries several contact spheres per sub-step.
        this.physics.collisionCallback = (pos, radius) => this.renderer.checkCollision(pos, radius);
        // Swept test, used only when the drone moves far enough in one sub-step to skip a surface
        this.physics.sweepCallback = (from, to) => this.renderer.sweep(from, to);
        
        // Setup UI
        this.ui = new UIHandler(
            this.physics,
            this.input,
            this.renderer,
            (mapChoice) => this.start(mapChoice),
            () => this.resume(),
            () => this.reset(),
            () => this.exit()
        );

        this.state = 'MENU'; // MENU, PLAYING, PAUSED
        this.lastTime = performance.now();
        
        // FPS tracking
        this.fpsElement = document.getElementById('fps-counter');
        this.frames = 0;
        this.lastFpsTime = performance.now();

        // FPS Limiter
        this.fpsLimitEnabled = false;
        this.fpsLimit = 60;
        
        const fpsToggle = document.getElementById('fps-limit-toggle');
        const fpsValue = document.getElementById('fps-limit-value');
        
        fpsToggle.addEventListener('change', (e) => {
            this.fpsLimitEnabled = e.target.checked;
            fpsValue.disabled = !this.fpsLimitEnabled;
        });
        
        fpsValue.addEventListener('input', (e) => {
            this.fpsLimit = parseInt(e.target.value, 10) || 60;
        });

        // Motor audio toggle
        const audioToggle = document.getElementById('audio-toggle');
        const audioEnabled = localStorage.getItem('audioEnabled') !== 'false';
        this.audio.setEnabled(audioEnabled);
        if (audioToggle) {
            audioToggle.checked = audioEnabled;
            audioToggle.addEventListener('change', (e) => {
                this.audio.setEnabled(e.target.checked);
                localStorage.setItem('audioEnabled', e.target.checked);
            });
        }

        // Video latency
        const latencySlider = document.getElementById('cfg-latency');
        const latencyValue = document.getElementById('val-latency');
        if (latencySlider) {
            latencySlider.addEventListener('input', (e) => {
                const ms = parseInt(e.target.value, 10) || 0;
                latencyValue.textContent = ms;
                this.videoDelay.setLatency(ms / 1000);
            });
        }

        // Listen for ESC to pause, and R to reset
        window.addEventListener('keydown', (e) => {
            console.log("Key pressed:", e.key, "State:", this.state, "Active Element:", document.activeElement ? document.activeElement.tagName : 'none');
            
            // Ignore keypresses if the user is currently typing in an input/select element
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) {
                return;
            }
            
            if (e.key === 'Escape' && this.state === 'PLAYING') {
                this.pause();
            } else if (e.key === 'c' || e.key === 'C') {
                this.ui.toggleCameraMode();
            } else if (e.key === 'r' || e.key === 'R') {
                if (this.state === 'PLAYING') {
                    this.reset();
                } else if (this.state === 'PAUSED') {
                    this.ui.hideMenu(this.ui.elements.pauseMenu);
                    this.ui.elements.osd.classList.remove('hidden');
                    this.reset();
                }
            }
        });

        // Start animation loop
        this.animate();
    }

    async start(mapChoice) {
        // Runs synchronously inside the Start button's click handler, which is the user gesture
        // the browser requires before it will let an AudioContext produce sound.
        this.audio.start();

        this.state = 'PLAYING';
        this.lastTime = performance.now();
        this.videoDelay.clear();
        this.renderer.resetCamera();
        await this.renderer.loadMap(mapChoice);
    }

    pause() {
        this.state = 'PAUSED';
        this.audio.silence();
        this.ui.showPauseMenu();
    }

    resume() {
        this.state = 'PLAYING';
        this.lastTime = performance.now();
        this.renderer.resetCamera();
    }

    reset() {
        this.physics.reset();
        // Drop the buffered feed, or the view would replay the old flight after the teleport
        this.videoDelay.clear();
        this.state = 'PLAYING';
        this.lastTime = performance.now();
        this.renderer.resetCamera();
    }

    exit() {
        this.physics.reset();
        this.audio.silence();
        this.state = 'MENU';
        // Reset camera lookat for menu
        this.renderer.camera.lookAt(0, 0, 0);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const now = performance.now();
        
        // Enforce FPS Limit
        if (this.fpsLimitEnabled && this.fpsLimit > 0) {
            const minFrameTime = 1000 / this.fpsLimit;
            if (now - this.lastTime < minFrameTime) {
                return; // Skip rendering this frame
            }
        }

        const dt = (now - this.lastTime) / 1000;
        this.lastTime = now;

        // Calculate FPS
        this.frames++;
        if (now - this.lastFpsTime >= 1000) {
            this.fpsElement.textContent = `FPS: ${this.frames}`;
            this.frames = 0;
            this.lastFpsTime = now;
        }

        // 1. Get Inputs
        this.input.update();
        const axes = this.input.getAxes();
        const armed = this.input.isArmed();

        // 2. Update UI Dashboard
        this.ui.updateDashboard(axes, armed);

        if (this.state === 'PLAYING') {
            // 3. Set physics inputs (applied continuously in body.preStep). The sticks are never
            // delayed - they reach the flight controller at once, as they do on a real quad.
            this.physics.setInputs(axes, armed);

            // 4. Step Physics Engine (sub-steps inside this method will fire the 'postStep' listener and handle collisions)
            // Cap dt to prevent huge jumps if tab was inactive
            this.physics.step(Math.min(dt, 0.1));

            // 5. Sync Renderer with Physics, through the video link.
            // In FPV the camera rides the airframe, so showing a past pose is exactly what a
            // laggy feed looks like: the drone is already somewhere else by the time you see it.
            // In Line of Sight the pilot is watching the real drone with their own eyes and there
            // is no video link to lag, so the mesh stays live.
            const droneState = this.physics.getDroneState();
            this.videoDelay.push(droneState, now / 1000);
            const seen = this.renderer.cameraMode === 'fpv'
                ? (this.videoDelay.sample(now / 1000) || droneState)
                : droneState;
            this.renderer.updateDrone(seen);

            // 6. Aim the camera (no-op in FPV, where the camera rides on the drone)
            this.renderer.updateCamera();

            // 7. Motor noise follows the stick inputs; wind noise follows how fast the
            // airframe is actually moving through the air
            // In Line of Sight the pilot is on the ground, so the drone is attenuated by range.
            // Sound is never delayed by the video setting - a quad carries no microphone, you are
            // hearing the real thing through the air while the picture lags behind it.
            this.audio.update(
                axes,
                armed,
                this.physics.droneBody.velocity.length(),
                this.renderer.getListenerDistance()
            );
        } else if (this.state === 'MENU') {
            // In menu, we can still slowly rotate the camera around the drone to look nice
            const time = now * 0.0005;
            this.renderer.camera.position.x = Math.sin(time) * 2;
            this.renderer.camera.position.z = Math.cos(time) * 2 + 1;
            this.renderer.camera.lookAt(0, 0, 0);
        }

        // 8. Render Frame
        this.renderer.render();
    }
}

// Initialize on window load
window.addEventListener('load', () => {
    console.log(`TurtleMode Simulator - build ${BUILD}`);
    const stamp = document.getElementById('build-stamp');
    if (stamp) stamp.textContent = `build ${BUILD}`;
    new Simulator();
});
