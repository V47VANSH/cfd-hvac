Phase 0 done. Quick summary so you know what's there.

What's working

cfd/
├── archive/cfd_room_3d_v6.html       v6 monolith, never edited again
├── PLAN.md, README.md
└── web/
    ├── src/
    │   ├── app/{layout,page,globals.css}
    │   ├── components/{AppShell,Toolbar,Sidebar,Room3D}.tsx
    │   ├── lib/
    │   │   ├── io/schema.ts           JSON v1 + migrations + sceneHash
    │   │   ├── cfd/
    │   │   │   ├── grid.ts            36×14×28 typed-array fields
    │   │   │   ├── constants.ts       physical constants
    │   │   │   ├── voxelize.ts        AABB+OBB rasterization
    │   │   │   ├── sources.ts         heat/AC/fan/infiltration injection
    │   │   │   ├── solver.ts          step() + metrics()
    │   │   │   ├── workerClient.ts    main-thread wrapper
    │   │   │   └── __tests__/cavity.test.ts
    │   │   └── geometry/buildRoom.ts  v6 buildRoom() ported
    │   └── workers/cfd.worker.ts      simulation loop in a Worker
    ├── next.config.ts                 output: 'export'
    ├── vitest.config.ts
    └── package.json                   dev / build / test / typecheck
Verifications
Typecheck: clean (tsc --noEmit)
Tests: 2 passing (cavity stability + solver does work)
Static build: 1.4 MB output (budget: ≤ 2 MB) ✓
Dev server: cold start 451 ms, first page render 1.95 s, HTTP 200
What you'll see at npm run dev
A 3D room (floor, walls, ceiling, grid, N/S/E/W labels), orbit camera (drag to rotate, scroll to zoom), sidebar with L/W/H + outdoor/setpoint sliders, top toolbar with placeholder tool buttons, and a Run CFD button that spins up the worker and streams metrics back.

What's NOT in yet (deliberately deferred)
These are Phase 0b / Phase 1 work — out of scope for the foundation milestone:

Placement tools (Window, Door, Box, etc. — toolbar buttons are stubs)
Property panel
Color overlays on walls/floor (thermal/airflow textures)
Particle tracer + arrow field
Heat-load (ASHRAE) panel
AC optimizer button
Comfort engine (PMV/PPD)
Export modal
Run it now

cd web
npm run dev
Open http://localhost:3000 — you should see the dark room with sliders. Drag to orbit, click Run CFD to fire the worker (you'll see Mean Temp / Std Dev / Hot % / Max Flow numbers tick).

When you're ready, say "Phase 0b" and I'll port the placement tools (windows, doors, obstacles, fans), property panel, and the color overlays so the simulation is visible on the room surfaces.


Phase 0b done. (The "failed exit 1" notification was my own kill — server was healthy: Ready in 511 ms, GET / 200 in 1973 ms.)

What's now in place
Feature	Status
Wall openings — window, door, round, arch	✓ click-to-place, drag-to-move, drag-handles to resize
Obstacles — box, cylinder, shelf	✓ click-to-place, drag-to-move
Heat sources — human, appliance	✓ with watts, auto-Gaussian heat injection in solver
Fans — ceiling (summer/winter), table (directional)	✓ blades spin in animation loop
Selection on click + Delete key + Escape	✓
Property panel	✓ size, position, U-value/SHGC/permeability for openings; Watts/RPM/season/dir for obstacles
Object list with on/off toggles	✓ in sidebar
Color overlays — thermal + airflow on floor / ceiling / 4 walls	✓ updates from worker snapshots
Arrow field — 12×9 lattice × 3 heights	✓ scaled and colored by speed
Particle tracer — 800 particles	✓ stepped in animation loop
View toggle — Both / Airflow / Thermal	✓ controls overlay opacities and arrow visibility
ASHRAE heat-load panel	✓ live; reads per-window U/SHGC if specified
AC optimizer	✓ 20-candidate sweep, constraint-aware, picks best, restarts sim
Export JSON modal	✓ copy + download, includes scene-hash for provenance
New code added (Phase 0b)

web/src/
├── lib/
│   ├── ashrae/heatLoad.ts             ASHRAE cooling-load (per-window U/SHGC aware)
│   ├── cfd/
│   │   ├── colormap.ts                tempRGB / speedRGB
│   │   └── useCFDSim.ts               worker hook + snapshot subscription
│   ├── geometry/
│   │   ├── buildOverlays.ts           wall/floor/ceiling thermal+flow textures
│   │   ├── buildArrows.ts             3D arrow field
│   │   ├── buildParticles.ts          800-particle tracer
│   │   ├── buildOpening.ts            window/door/round/arch meshes
│   │   ├── buildObstacle.ts           box/cyl/shelf/human/appliance/cfan/tfan
│   │   └── walls.ts                   uvToWorld / worldToUV / wallInfo / wallNormal
│   └── optimizer/runOptimizer.ts      single-AC sweep with constraint check
└── components/
    ├── PropertyPanel.tsx
    ├── ObjectList.tsx
    ├── HeatLoadPanel.tsx
    └── ExportModal.tsx
Verifications
Typecheck: clean
Tests: 2 passing (cavity sanity + solver does work)
Static build: 1.5 MB / 1.2 MB JS chunks (budget: 2 MB) ✓
Dev server: cold start 511 ms, first render 1.97 s, HTTP 200
What's not in yet (Phase 1+)
PMV / PPD / Draft Risk overlays — Phase 1
Multi-height comfort sampling — Phase 1
One-click PDF report — Phase 1
Side-by-side comparison view — Phase 1
Energy & cost — Phase 3
Solver upgrades (semi-Lagrangian advection, RH scalar, more Poisson iters) — Phase 2
Tier 2 backend (OpenFOAM, ANSYS, calibration) — Phase 4
STL upload UI + onboarding tour + constraint-zone polygon tool — Phase 5
Try it

cd web
npm run dev
Open http://localhost:3000. You should be able to:

Click 🪟 Window → click any wall to drop a window. Repeat for doors/etc.
Click 🧑 Human → click the floor to add a person. Watch the ASHRAE panel update.
Click any item to select it; the Properties panel appears in the sidebar with size/position/physics fields.
Drag any opening along its wall. Drag yellow handles to resize.
Press Delete to remove the selected item.
Click ▶ Run CFD — the room walls and floor light up with the temperature field; arrows + particles show airflow.
Toggle Both / Airflow / Thermal to switch what's drawn.
Click ★ Optimize AC to sweep 20 positions and re-run from the best one.
Click ⚙ Export to copy/download the full scene JSON with ASHRAE numbers and the SHA-256 scene-hash.
When you're ready, say Phase 1 and I'll add PMV/PPD/Draft Risk + multi-height sampling + the one-click PDF report.




_____________________

Done. AC placement is wired end-to-end.

What's now possible
Top toolbar has a new HVAC group with ❄ AC Unit and a live 0/3 counter
Click any wall while the AC tool is active → an AC unit mounts at the top of that wall, oriented inward
Drag any AC unit horizontally — it slides along its wall and re-snaps to the wall plane
Click an AC to select it → Properties panel exposes:
Wall, position-along-wall
Capacity in kW and TR (linked, edit either)
Type: split / window / cassette
Throw distance (m), airflow angle (°), flow rate (CFM)
On/Running ↔ Off
Object list in the sidebar shows each AC with wallName · kW · TR, an on/off toggle, and a delete ✕
Delete / Backspace removes the selected AC
Cap of 3 AC units enforced in toolbar (button greys out, hint switches to "Max 3 AC units placed")
CFD jet points along the AC's wall normal — the existing solver already supported this; now the user controls where the jet originates instead of being stuck with a default
State unified
scene.ac_units is now the single source of truth. The previous separate acPositions state is gone. The optimizer no longer keeps a parallel list — it writes its result directly into scene.ac_units (creating one if none exists, otherwise repositioning the first to the optimum). The export modal includes the placed ACs verbatim from the scene.

Verifications
Typecheck: clean
Tests: 2/2 passing
Static build: 1.5 MB output (budget: 2 MB) ✓
Try it

cd web
npm run dev
Click ❄ AC Unit in the toolbar, then click anywhere on a wall — a unit mounts at ceiling height. Click ▶ Run CFD to see the cold jet originate from where you placed it.

__________________________

Fixed. The fallback default-AC is gone — now when you click ▶ Run CFD with zero AC units placed, the simulation runs without any cold-air supply or AC jet forcing: only natural convection, infiltration through openings, and any human/appliance heat sources.

The CFD Results panel now tells you which mode you're in:

No AC placed: "Running passive (no AC) — natural convection only"
AC(s) placed: "Running with N AC units"
This gives you a clean baseline to compare against — run passive first, see the room heat up, then place an AC and run again to see the difference.

The optimizer still works the same way (it's the optimizer's job to find a position, so it creates one when none exists).

Typecheck + tests clean.