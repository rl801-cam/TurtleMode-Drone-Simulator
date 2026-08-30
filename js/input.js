// input.js - Handles Gamepad API and normalizes inputs for the physics engine

// True while the user is typing into a form control, so the keyboard fallback below can stay out
// of the way. Without it, entering a pilot name was flying the drone: the W, A, S and D in a name
// drove throttle and yaw, and the space bar toggled the arm switch. main.js guards its own key
// handling the same way.
function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export class InputHandler {
    constructor() {
        this.gamepadIndex = null;
        
        // Normalized inputs [-1, 1] for Pitch, Roll, Yaw. [0, 1] for Throttle.
        this.axes = {
            throttle: 0,
            yaw: 0,
            pitch: 0,
            roll: 0
        };
        
        this.armed = false;
        
        // Typical FPV Radio axis mapping (can be adjusted via UI later)
        // Adjust these indices based on the controller.
        this.mapping = {
            throttle: 2,
            yaw: 3,
            pitch: 1,
            roll: 0,
            armButton: 0
        };

        this.reverse = {
            throttle: true,
            yaw: false,
            pitch: true,
            roll: false
        };

        this.initListeners();
    }

    updateMapping(type, key, value) {
        if (type === 'axis') {
            this.mapping[key] = parseInt(value, 10);
        } else if (type === 'reverse') {
            this.reverse[key] = value;
        }
    }

    initListeners() {
        window.addEventListener("gamepadconnected", (e) => {
            console.log("Gamepad connected at index %d: %s. %d buttons, %d axes.",
                e.gamepad.index, e.gamepad.id,
                e.gamepad.buttons.length, e.gamepad.axes.length);
            this.gamepadIndex = e.gamepad.index;
            
            // Dispatch a custom event to notify UI
            window.dispatchEvent(new CustomEvent('fpv-controller-connected', { detail: { connected: true }}));
        });

        window.addEventListener("gamepaddisconnected", (e) => {
            console.log("Gamepad disconnected from index %d: %s",
                e.gamepad.index, e.gamepad.id);
            if (this.gamepadIndex === e.gamepad.index) {
                this.gamepadIndex = null;
                window.dispatchEvent(new CustomEvent('fpv-controller-connected', { detail: { connected: false }}));
            }
        });
        
        // Keyboard fallback for testing without a radio: W/S throttle, A/D yaw, I/K pitch,
        // J/L roll, space to arm. Throttle deliberately does not self-centre, matching a real
        // transmitter's ratcheted stick.
        //
        // Pitch and roll sat on the arrow keys until they were moved here. The arrows are the
        // documented in-flight camera uptilt control - the launch menu and the OSD both say so -
        // and main.js binds them for exactly that, so pressing one used to pitch the drone and
        // sweep the camera at the same time. IJKL keeps the fallback usable while the camera is
        // being adjusted, and sits under the right hand where the pitch/roll stick would be.
        //
        // Keys are lowercased so the bindings still work with caps lock or shift held.
        window.addEventListener("keydown", (e) => {
            if (isTyping()) return;
            switch (e.key.toLowerCase()) {
                case 'w': this.axes.throttle = 1; break;
                case 's': this.axes.throttle = 0; break;
                case 'a': this.axes.yaw = -1; break;
                case 'd': this.axes.yaw = 1; break;
                case 'i': this.axes.pitch = -1; break;
                case 'k': this.axes.pitch = 1; break;
                case 'j': this.axes.roll = -1; break;
                case 'l': this.axes.roll = 1; break;
                case ' ':
                    this.armed = !this.armed;
                    window.dispatchEvent(new CustomEvent('fpv-arm-toggle', { detail: { armed: this.armed }}));
                    break;
            }
        });

        window.addEventListener("keyup", (e) => {
            if (isTyping()) return;
            switch (e.key.toLowerCase()) {
                case 'a': case 'd': this.axes.yaw = 0; break;
                case 'i': case 'k': this.axes.pitch = 0; break;
                case 'j': case 'l': this.axes.roll = 0; break;
            }
        });
    }

    update() {
        if (this.gamepadIndex !== null) {
            const gamepad = navigator.getGamepads()[this.gamepadIndex];
            if (gamepad) {
                // Read raw axes
                // FPV controllers usually have 4 axes. Throttle is typically not self-centering.
                // Depending on the OS and browser, axis indices can vary. We use mapping.
                
                let rawThrottle = gamepad.axes[this.mapping.throttle] || 0;
                let rawYaw = gamepad.axes[this.mapping.yaw] || 0;
                let rawPitch = gamepad.axes[this.mapping.pitch] || 0;
                let rawRoll = gamepad.axes[this.mapping.roll] || 0;

                let t = (-rawThrottle + 1) / 2; 
                this.axes.throttle = this.reverse.throttle ? 1 - t : t;
                
                let y = this.reverse.yaw ? -rawYaw : rawYaw;
                let p = this.reverse.pitch ? -rawPitch : rawPitch;
                let r = this.reverse.roll ? -rawRoll : rawRoll;

                const applyDeadband = (val, db = 0.05) => {
                    if (Math.abs(val) < db) return 0;
                    return Math.sign(val) * ((Math.abs(val) - db) / (1 - db));
                };

                this.axes.yaw = applyDeadband(y);
                this.axes.pitch = applyDeadband(p);
                this.axes.roll = applyDeadband(r);

                // Handle arm switch
                if (gamepad.buttons[this.mapping.armButton]) {
                    const btnPressed = gamepad.buttons[this.mapping.armButton].pressed;
                    if (btnPressed && !this.prevArmBtnState) {
                        this.armed = !this.armed;
                        window.dispatchEvent(new CustomEvent('fpv-arm-toggle', { detail: { armed: this.armed }}));
                    }
                    this.prevArmBtnState = btnPressed;
                }
            }
        }
    }

    getAxes() {
        return this.axes;
    }

    isArmed() {
        return this.armed;
    }
}
