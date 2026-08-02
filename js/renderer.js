// renderer.js - Handles Three.js visualization

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

// Extend BufferGeometry and Mesh prototypes with BVH methods
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class Renderer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);

        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        this.scene.fog = new THREE.Fog(0x87CEEB, 20, 100);

        // Camera setup (FPV by default, can be switched to Line of Sight)
        this.fpvFov = 90;
        this.losFov = 50;
        this.cameraMode = 'fpv'; // 'fpv' | 'los'
        this.camera = new THREE.PerspectiveCamera(this.fpvFov, window.innerWidth / window.innerHeight, 0.01, 1000);

        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        // Lighting
        // HemisphereLight provides a natural outdoor ambient gradient (sky color, ground color, intensity)
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1.5);
        this.scene.add(hemiLight);

        // A softer ambient light to ensure the darkest crevices still have visibility
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.0); 
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        dirLight.position.set(50, 100, 50);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 4096;
        dirLight.shadow.mapSize.height = 4096;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 300;
        dirLight.shadow.camera.left = -150;
        dirLight.shadow.camera.right = 150;
        dirLight.shadow.camera.top = 150;
        dirLight.shadow.camera.bottom = -150;
        dirLight.shadow.bias = -0.0005;
        dirLight.shadow.normalBias = 0.02;
        this.scene.add(dirLight);

        // Drone Mesh (Visual rep of the collision box, only shown in Line of Sight mode)
        this.droneMesh = this.createDroneModel();
        this.droneMesh.visible = false; // Make invisible for FPV
        this.scene.add(this.droneMesh);

        // Attach Camera to Drone (slightly forward/up for FPV view)
        this.cameraOffset = new THREE.Vector3(0, 0.05, -0.15); // Local offset
        this.droneMesh.add(this.camera);
        this.camera.position.copy(this.cameraOffset);
        // Look forward with a 20 degree up tilt (typical FPV)
        this.camera.rotation.set(THREE.MathUtils.degToRad(20), 0, 0);

        // Line of Sight pilot position: standing a few metres behind the spawn point.
        // Spawn matches PhysicsEngine.reset() so the pilot always ends up next to the drone.
        // Eye height is measured from the ground rather than offset from the spawn, so it stays
        // put if the drone's spawn altitude ever changes.
        this.spawnPosition = new THREE.Vector3(0, 1, 0);
        this.losEyeHeight = 5; // metres above ground
        this.losStandoff = 3; // metres behind the spawn point
        this.losEye = new THREE.Vector3(
            this.spawnPosition.x,
            this.losEyeHeight,
            this.spawnPosition.z + this.losStandoff
        );

        this.environmentGroup = new THREE.Group();
        this.scene.add(this.environmentGroup);

        this.colliderMesh = null;
        this.collisionReady = false;

        // Reused by checkCollision so the per-sub-step collision queries don't allocate
        this._queryPoint = new THREE.Vector3();
        this._queryTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 };
        this._collisionResult = {
            closestPoint: new THREE.Vector3(),
            normal: new THREE.Vector3(),
            dist: 0,
            depth: 0
        };
        this._sweepRay = new THREE.Ray();
        this._sweepDir = new THREE.Vector3();
        this._sweepResult = {
            point: new THREE.Vector3(),
            normal: new THREE.Vector3(),
            distance: 0
        };

        this.currentMapName = null;
        this.mapLoadPromise = null;
        this.loadMap('placeholder');

        // Handle Resize
        window.addEventListener('resize', this.onWindowResize.bind(this), false);
    }

    createDroneModel() {
        // A small quad sized to roughly match the physics box (0.3m span).
        // Front props are red and rear props white so orientation stays readable from a distance.
        // fog is disabled on the drone so it doesn't fade into the sky when flown far away in LOS.
        const group = new THREE.Group();

        // The airframe hangs 0.02 below the origin so its underside lines up with the bottom of
        // the physics contact spheres (radius 0.05, centred on the CoM plane) and it looks like
        // it is sitting on the ground rather than hovering over it.
        const frame = new THREE.Group();
        frame.position.y = -0.02;
        group.add(frame);

        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6, fog: false });
        const frontMat = new THREE.MeshStandardMaterial({ color: 0xff3322, emissive: 0x551108, roughness: 0.5, fog: false });
        const rearMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.5, fog: false });

        const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.06, 0.2), bodyMat);
        body.castShadow = true;
        frame.add(body);

        const armGeo = new THREE.BoxGeometry(0.022, 0.012, 0.14);
        const propGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.008, 12);

        // Nose points down -Z (the FPV camera looks that way), so -Z corners are the front motors
        const motors = [
            { x: -0.09, z: -0.09, front: true },
            { x: 0.09, z: -0.09, front: true },
            { x: -0.09, z: 0.09, front: false },
            { x: 0.09, z: 0.09, front: false }
        ];

        for (const m of motors) {
            const arm = new THREE.Mesh(armGeo, bodyMat);
            arm.position.set(m.x * 0.5, 0, m.z * 0.5);
            arm.rotation.y = Math.atan2(m.x, m.z); // point the arm's local +Z at the motor
            arm.castShadow = true;
            frame.add(arm);

            const prop = new THREE.Mesh(propGeo, m.front ? frontMat : rearMat);
            prop.position.set(m.x, 0.035, m.z);
            prop.castShadow = true;
            frame.add(prop);
        }

        return group;
    }

    setCameraMode(mode) {
        this.cameraMode = mode === 'los' ? 'los' : 'fpv';

        if (this.cameraMode === 'los') {
            // Detach from the drone so the camera stays anchored in the world
            this.scene.add(this.camera);
            this.camera.fov = this.losFov;
            this.droneMesh.visible = true;
        } else {
            this.droneMesh.add(this.camera);
            this.camera.fov = this.fpvFov;
            this.droneMesh.visible = false;
        }

        this.camera.updateProjectionMatrix();
        this.resetCamera();
    }

    setLosFov(fov) {
        this.losFov = fov;
        if (this.cameraMode === 'los') {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
    }

    // Distance from the pilot's viewpoint to the drone, used by the LOS OSD readout
    getLosDistance() {
        return this.losEye.distanceTo(this.droneMesh.position);
    }

    // Distance from the listener to the drone, for audio attenuation. In FPV the camera rides the
    // airframe, so the listener is effectively on the drone and there is nothing to attenuate.
    getListenerDistance() {
        return this.cameraMode === 'los' ? this.getLosDistance() : 0;
    }

    // Keeps the LOS camera pinned near spawn and always aimed at the drone
    updateCamera() {
        if (this.cameraMode !== 'los') return;
        this.camera.position.copy(this.losEye);
        this.camera.lookAt(this.droneMesh.position);
    }

    // Returns the in-flight load for a map that is already loading/loaded, so callers always
    // await a ready collision tree - the drone has nothing else holding it up.
    loadMap(mapName) {
        if (this.currentMapName !== mapName) {
            this.currentMapName = mapName;
            this.mapLoadPromise = this.buildMap(mapName).catch((err) => {
                this.currentMapName = null; // let a failed map be retried
                throw err;
            });
        }
        return this.mapLoadPromise;
    }

    async buildMap(mapName) {
        // Clear existing map
        while(this.environmentGroup.children.length > 0) { 
            const child = this.environmentGroup.children[0];
            this.environmentGroup.remove(child); 
        }

        if (mapName === 'placeholder') {
            this.createPlaceholderEnvironment();
        } else if (mapName === 'bando') {
            await this.loadEnvironment('bando.glb');
        } else {
            await this.loadEnvironment(mapName);
        }

        // Generate collision BVH for the loaded map
        await this.generateCollisionBVH();
    }

    createPlaceholderEnvironment() {
        // Floor
        const floorGeo = new THREE.PlaneGeometry(100, 100);
        const floorMat = new THREE.MeshStandardMaterial({ 
            color: 0x888888, 
            roughness: 0.8,
            metalness: 0.2
        });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        this.environmentGroup.add(floor);

        // Grid Helper
        const gridHelper = new THREE.GridHelper(100, 100, 0x444444, 0x444444);
        gridHelper.position.y = 0.01;
        this.environmentGroup.add(gridHelper);

        // Colored Cubes
        const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];
        for(let i=0; i<20; i++) {
            const size = Math.random() * 2 + 0.5;
            const cubeGeo = new THREE.BoxGeometry(size, size, size);
            const cubeMat = new THREE.MeshStandardMaterial({ color: colors[i % colors.length] });
            const cube = new THREE.Mesh(cubeGeo, cubeMat);
            
            cube.position.x = (Math.random() - 0.5) * 40;
            cube.position.z = (Math.random() - 0.5) * 40;
            cube.position.y = size / 2;
            
            cube.castShadow = true;
            cube.receiveShadow = true;
            this.environmentGroup.add(cube);
        }
    }

    loadEnvironment(url) {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(url, (gltf) => {
                const model = gltf.scene;
                // Enable shadows
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                this.environmentGroup.add(model);
                resolve();
            }, undefined, (error) => {
                console.error(error);
                reject(error);
            });
        });
    }

    generateCollisionBVH() {
        this.collisionReady = false;
        
        // 1. Gather all collidable geometries
        const geometries = [];
        this.environmentGroup.traverse((child) => {
            if (child.isMesh) {
                // Ignore the drone mesh itself
                if (child === this.droneMesh) return;
                
                child.updateMatrixWorld(true);
                if (child.geometry && child.geometry.attributes.position) {
                    const clonedGeom = child.geometry.clone();
                    clonedGeom.applyMatrix4(child.matrixWorld);
                    geometries.push(clonedGeom);
                }
            }
        });
        
        if (geometries.length === 0) {
            this.colliderMesh = null;
            this.collisionReady = true;
            return Promise.resolve();
        }
        
        // 2. Merge geometries into a single geometry
        const mergedGeom = BufferGeometryUtils.mergeGeometries(geometries);
        
        // Dispose of cloned geometries to free memory
        geometries.forEach(g => g.dispose());
        
        // 3. Build BVH using Web Worker (with synchronous fallback)
        return new Promise((resolve) => {
            const buildSync = () => {
                mergedGeom.computeBoundsTree();
                this.colliderMesh = new THREE.Mesh(mergedGeom);
                this.collisionReady = true;
                console.log("BVH generated successfully on main thread.");
                resolve();
            };

            try {
                console.log("Generating collision BVH tree asynchronously...");
                const worker = new GenerateMeshBVHWorker();
                
                // Set a timeout of 3 seconds. If it doesn't resolve, fall back to sync
                const timeoutId = setTimeout(() => {
                    console.warn("Worker BVH generation timed out. Falling back to main thread.");
                    worker.terminate();
                    buildSync();
                }, 3000);
                
                worker.generate(mergedGeom).then(bvh => {
                    clearTimeout(timeoutId);
                    mergedGeom.boundsTree = bvh;
                    this.colliderMesh = new THREE.Mesh(mergedGeom);
                    this.collisionReady = true;
                    console.log("BVH generated successfully via Web Worker.");
                    worker.terminate();
                    resolve();
                }).catch(err => {
                    clearTimeout(timeoutId);
                    console.warn("Worker BVH generation failed, falling back to main thread:", err);
                    worker.terminate();
                    buildSync();
                });
            } catch (e) {
                console.warn("Failed to initialize GenerateMeshBVHWorker, running on main thread:", e);
                buildSync();
            }
        });
    }

    // Sweeps a ray along the path the drone travelled during one physics sub-step. At racing
    // speeds the drone can move further than a contact sphere's radius between sub-steps and
    // step clean over a surface, so the sphere checks alone would let it through the world.
    sweep(from, to) {
        if (!this.collisionReady || !this.colliderMesh) return null;

        const boundsTree = this.colliderMesh.geometry.boundsTree;
        if (!boundsTree) return null;

        this._sweepRay.origin.set(from.x, from.y, from.z);
        this._sweepDir.set(to.x - from.x, to.y - from.y, to.z - from.z);

        const travel = this._sweepDir.length();
        if (travel < 1e-6) return null;

        this._sweepDir.multiplyScalar(1 / travel);
        this._sweepRay.direction.copy(this._sweepDir);

        // DoubleSide so a surface is caught regardless of which way its triangles are wound
        const hit = boundsTree.raycastFirst(this._sweepRay, THREE.DoubleSide);
        if (!hit || hit.distance > travel) return null;

        const result = this._sweepResult;
        result.point.copy(hit.point);
        result.distance = hit.distance;

        if (hit.face && hit.face.normal) {
            result.normal.copy(hit.face.normal);
            // Winding is not guaranteed, so force the normal to face back along the travel
            if (result.normal.dot(this._sweepDir) > 0) result.normal.negate();
        } else {
            result.normal.copy(this._sweepDir).negate();
        }

        return result;
    }

    // Queries the map BVH for a sphere overlap. The physics solver calls this several times per
    // sub-step, so the result is a single reused object - callers must read it before querying
    // again. Returns null when the sphere is clear of the geometry.
    checkCollision(position, radius) {
        if (!this.collisionReady || !this.colliderMesh) return null;

        const boundsTree = this.colliderMesh.geometry.boundsTree;
        if (!boundsTree) return null;

        const posVec = this._queryPoint.set(position.x, position.y, position.z);

        // Passing radius as maxThreshold lets the BVH discard whole branches instead of
        // walking the tree for the true closest point every time.
        const result = boundsTree.closestPointToPoint(posVec, this._queryTarget, 0, radius);
        if (!result || result.distance >= radius) return null;

        const hit = this._collisionResult;
        hit.closestPoint.copy(result.point);
        hit.dist = result.distance;
        hit.depth = radius - result.distance;

        hit.normal.subVectors(posVec, result.point);
        if (hit.normal.lengthSq() > 1e-8) {
            hit.normal.normalize();
        } else {
            // Sphere centre sits exactly on the surface - no usable direction, push up
            hit.normal.set(0, 1, 0);
        }

        return hit;
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    resetCamera() {
        if (this.cameraMode === 'los') {
            this.camera.position.copy(this.losEye);
            this.camera.lookAt(this.droneMesh.position);
            return;
        }
        this.camera.position.copy(this.cameraOffset);
        this.camera.rotation.set(THREE.MathUtils.degToRad(20), 0, 0);
    }

    updateDrone(state) {
        // State contains position and quaternion from physics engine
        this.droneMesh.position.copy(state.position);
        this.droneMesh.quaternion.copy(state.quaternion);
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }
}
