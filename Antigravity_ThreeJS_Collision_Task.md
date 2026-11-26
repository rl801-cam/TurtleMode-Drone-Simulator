# 🛸 Antigravity Task Prompt: Three.js Drone Sim Collision Optimization

**Target Agent:** Google Antigravity (IDE/CLI)  
**Project Context:** A Three.js-based FPV Drone Simulator.  
**Current State:**
- The drone successfully collides with a flat ground plane.
- Maps consist of:
  1. A procedurally generated map (cubes on a plane).
  2. A default map loaded via a `.gltf` file exported from Blender.
  3. Dynamic loading of "modded" `.gltf` maps at runtime.
- **The Problem:** The drone does not currently collide with the procedural cubes or the GLTF map geometry.

## 🎯 Primary Objective
Implement a highly performant collision detection system for both the procedurally generated cubes and the static/dynamic GLTF meshes, minimizing main-thread performance impact.

---

## 🛠️ Step-by-Step Implementation Instructions

### Step 1: Implement `three-mesh-bvh` for Spatial Indexing
To avoid the heavy overhead of a full rigid-body physics engine (like Ammo/Cannon) for static environments, implement **`three-mesh-bvh`** (Bounding Volume Hierarchy). It is the standard for ultra-fast geometry raycasting and sphere-casting in Three.js and is perfect for high-speed drone collision.
1. Install and import `three-mesh-bvh`.
2. Configure the Three.js `BufferGeometry` prototype to support `computeBoundsTree`, `disposeBoundsTree`, and `closestPointToPoint`.

### Step 2: Handle Procedural Cubes
For the procedurally generated cubes, do not use complex triangle meshes for collision.
1. **Mathematical Abstraction:** Create a standard Box collider geometry or calculate mathematical AABBs (Axis-Aligned Bounding Boxes).
2. **Geometry Merging:** If the cubes are static, use `BufferGeometryUtils.mergeGeometries` to combine all cube geometries into a single mesh before generating the BVH.
3. Compute the bounds tree: `mergedCubeGeometry.computeBoundsTree()`.

### Step 3: Handle GLTF Map Collision (Default & Modded Maps)
When a GLTF map is loaded (either the default Blender map or a modded map at runtime):
1. **Traverse the Scene:** Use `gltf.scene.traverse()` to find all mesh nodes (`node.isMesh`).
2. **Filter Collidables:** Ignore purely decorative meshes (e.g., clouds, background elements). Consider adding a custom property in Blender (e.g., `collide: true`) to explicitly flag collision geometry.
3. **Generate BVH on Load:** For each collision-enabled mesh, call `mesh.geometry.computeBoundsTree()`.
4. **Optimization:** If the GLTF contains many separate objects, merge their geometries into a single "collision-only" invisible mesh to drastically reduce BVH overhead.

### Step 4: Web Worker Offloading (Zero Stutter)
Because generating a BVH for a complex modded GLTF map can freeze the main thread, you must ensure the game doesn't stutter during runtime map loading.
1. Utilize the asynchronous Web Worker setup provided by `three-mesh-bvh` (`GenerateMeshBVHWorker`).
2. Generate the collision mesh in the background. While calculating, either pause the simulation or keep the map elements physically non-collidable until the collision data promise resolves.

### Step 5: Drone Collision Logic (Sphere Casting)
Update the drone's physics/update loop to utilize the new BVH structure.
1. Represent the drone's collision volume as a geometric sphere (radius matching the drone's frame).
2. On every frame, use `bvhMesh.collider.closestPointToPoint(dronePosition, targetPoint)` or `bvhMesh.collider.shapecast(...)` to detect intersections between the drone's bounding sphere and the environment.
3. **Resolution:** If an intersection occurs (distance < drone radius), extract the normal vector of the collision surface and apply a reflection vector, velocity dampening, or trigger a "crash state" to prevent clipping through the geometry.

---

## 🚦 Acceptance Criteria
- [ ] Drone collides accurately with procedural cubes.
- [ ] Drone collides accurately with imported Blender GLTFs.
- [ ] Modded maps can be loaded at runtime without crashing or permanently freezing the app.
- [ ] Minimum of 60 FPS maintained during high-speed flight near complex meshes.
- [ ] Implementation relies primarily on native Three.js math and `three-mesh-bvh` to avoid bloated physics overhead.

**Antigravity Agent Action Item:** Please analyze the current workspace, locate the procedural generation logic, map loading functions, and the drone's main update loop. Apply the steps outlined above to build out the collision framework.
