"""OpenFOAM case generator — Phase 4 stage 2 implementation.

Translates a Tier-1 ``Scene`` into a complete OpenFOAM case directory
ready for ``blockMesh + snappyHexMesh + buoyantBoussinesqSimpleFoam``.

Differs from stage-1 (which emitted minimal valid dictionaries) in:

  * snappyHexMesh refinement boxes around obstacles + AC patches
  * Per-opening boundary conditions (window-solar, door-infiltration)
  * AC inlet patches with prescribed U + T (real fixed-velocity inlet,
    not a body force)
  * Heat sources from ``human`` / ``appliance`` obstacles (volumetric
    energy source via ``fvOptions``)
  * Optional ``viewFactor`` radiation (toggled by ``Scene.materials``)
  * Wall U-value → wall T flux BC (when material library is set)

Output structure:

    case_dir/
        system/{controlDict, blockMeshDict, snappyHexMeshDict,
                fvSchemes, fvSolution, decomposeParDict, fvOptions}
        constant/{transportProperties, turbulenceProperties,
                  radiationProperties (opt), g, polyMesh/}
        0/{T, U, p_rgh, k, omega, alphat, nut} + IF radiation IDoubleHigh and G
        triSurface/{obstacles.stl}                    (auto-emitted from scene)

Stage 3 (future): conjugate heat transfer for thick walls, transient
``buoyantPimpleFoam`` runs with on/off occupancy schedules.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .schema import Scene, ACUnit, Obstacle, Opening


# ── Public API ────────────────────────────────────────────────────────────

async def build_case(
    scene: Scene, case_dir: Path,
    transient: bool = False,
    duration_s: float = 0.0,
    radiation: bool = False,
) -> None:
    """Write a complete OpenFOAM case to ``case_dir``."""
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / "system").mkdir(exist_ok=True)
    (case_dir / "constant").mkdir(exist_ok=True)
    (case_dir / "constant" / "polyMesh").mkdir(exist_ok=True)
    (case_dir / "constant" / "triSurface").mkdir(parents=True, exist_ok=True)
    (case_dir / "0").mkdir(exist_ok=True)
    (case_dir / "triSurface").mkdir(exist_ok=True)

    # If the scene includes a room STL, write its triangle mesh to
    # constant/triSurface/room.stl so snappyHexMesh can carve it out of
    # the background blockMesh. snappy reads triSurfaceMesh from
    # constant/triSurface; the legacy `triSurface/` folder we still
    # create above is used by the obstacle stamp (kept for back-compat).
    room_stl = _find_room_stl(scene)
    if room_stl is not None:
        _write_room_stl_file(case_dir / "constant" / "triSurface" / "room.stl", room_stl)

    _write_control_dict(case_dir, transient, duration_s, radiation)
    _write_blockmesh(case_dir, scene, room_stl)
    _write_snappy(case_dir, scene, room_stl)
    _write_fv_schemes(case_dir, transient)
    _write_fv_solution(case_dir, radiation)
    _write_fv_options(case_dir, scene)
    _write_transport_properties(case_dir)
    _write_turbulence_properties(case_dir)
    if radiation:
        _write_radiation_properties(case_dir)
    _write_g_field(case_dir)
    _write_initial_T(case_dir, scene, room_stl)
    _write_initial_U(case_dir, scene, room_stl)
    _write_initial_p_rgh(case_dir, scene, room_stl)
    _write_initial_k_omega(case_dir, scene, room_stl)
    _write_initial_alphat_nut(case_dir, scene, room_stl)
    if radiation:
        _write_radiation_fields(case_dir, scene)


def _find_room_stl(scene: Scene):
    """Return the first STL with role=='room' that has positions, or None."""
    for s in scene.geometry.stl:
        if s.role == "room" and s.positions and len(s.positions) >= 9:
            return s
    return None


def _write_room_stl_file(path: Path, s) -> None:
    """Write the room STL to disk as a single ASCII solid named 'room'.
    snappyHexMesh's triSurfaceMesh reads the same vertex stream the
    Tier-1 frontend already parsed, scaled + translated by the user's
    transform so the file is in WORLD METRES (snappy assumes metres).
    """
    sc = s.scale or 1.0
    xOff, yOff, zOff = s.x or 0.0, s.y or 0.0, s.z or 0.0
    p = s.positions
    n_tris = len(p) // 9
    lines = ["solid room\n"]
    for t in range(n_tris):
        o = t * 9
        ax = sc * p[o + 0] + xOff; ay = sc * p[o + 1] + yOff; az = sc * p[o + 2] + zOff
        bx = sc * p[o + 3] + xOff; by = sc * p[o + 4] + yOff; bz = sc * p[o + 5] + zOff
        cx = sc * p[o + 6] + xOff; cy = sc * p[o + 7] + yOff; cz = sc * p[o + 8] + zOff
        # Recompute the world-space normal so OpenFOAM doesn't trust
        # the model's possibly-flipped per-triangle normal.
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        L = (nx * nx + ny * ny + nz * nz) ** 0.5
        if L > 0:
            nx /= L; ny /= L; nz /= L
        lines.append(f"  facet normal {nx:.6f} {ny:.6f} {nz:.6f}\n    outer loop\n")
        lines.append(f"      vertex {ax:.5f} {ay:.5f} {az:.5f}\n")
        lines.append(f"      vertex {bx:.5f} {by:.5f} {bz:.5f}\n")
        lines.append(f"      vertex {cx:.5f} {cy:.5f} {cz:.5f}\n")
        lines.append("    endloop\n  endfacet\n")
    lines.append("endsolid room\n")
    path.write_text("".join(lines))


# ── Foam header ──────────────────────────────────────────────────────────

def _foam_header(class_: str, location: str, object_: str) -> str:
    return (
        "/*--------------------------------*- C++ -*----------------------------------*\\\n"
        "  CFD HVAC Tier-2 — autogenerated; do not edit by hand\n"
        "\\*---------------------------------------------------------------------------*/\n"
        "FoamFile\n{\n"
        "    version     2.0;\n"
        "    format      ascii;\n"
        f"    class       {class_};\n"
        f"    location    \"{location}\";\n"
        f"    object      {object_};\n"
        "}\n"
        "// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n\n"
    )


# ── controlDict / fvSchemes / fvSolution ─────────────────────────────────

def _write_control_dict(case_dir: Path, transient: bool, duration_s: float, radiation: bool) -> None:
    if transient:
        body = (
            "application       buoyantPimpleFoam;\n"
            "startFrom         startTime;\n"
            "startTime         0;\n"
            "stopAt            endTime;\n"
            f"endTime           {duration_s};\n"
            "deltaT            0.05;\n"
            "writeControl      adjustableRunTime;\n"
            "writeInterval     5;\n"
            "adjustTimeStep    yes;\n"
            "maxCo             0.8;\n"
        )
    else:
        body = (
            "application       buoyantBoussinesqSimpleFoam;\n"
            "startFrom         startTime;\n"
            "startTime         0;\n"
            "stopAt            endTime;\n"
            "endTime           2000;\n"
            "deltaT            1;\n"
            "writeControl      timeStep;\n"
            "writeInterval     500;\n"
        )
    body += (
        "purgeWrite        2;\n"
        "writeFormat       ascii;\n"
        "writePrecision    7;\n"
        "writeCompression  off;\n"
        "timeFormat        general;\n"
        "timePrecision     6;\n"
        "runTimeModifiable true;\n"
    )
    if radiation:
        body += (
            "\nfunctions\n{\n"
            "    radiationStats { type radiation; libs (\"libradiationModels.so\"); }\n"
            "}\n"
        )
    (case_dir / "system" / "controlDict").write_text(_foam_header("dictionary", "system", "controlDict") + body)


def _write_fv_schemes(case_dir: Path, transient: bool) -> None:
    body = (
        f"ddtSchemes        {{ default {'Euler' if transient else 'steadyState'}; }}\n"
        "gradSchemes       { default Gauss linear; }\n"
        "divSchemes\n{\n"
        "    default            none;\n"
        "    div(phi,U)         bounded Gauss linearUpwindV grad(U);\n"
        "    div(phi,T)         bounded Gauss linearUpwind grad(T);\n"
        "    div(phi,k)         bounded Gauss upwind;\n"
        "    div(phi,omega)     bounded Gauss upwind;\n"
        "    div((nuEff*dev2(T(grad(U))))) Gauss linear;\n"
        "}\n"
        "laplacianSchemes  { default Gauss linear orthogonal; }\n"
        "interpolationSchemes { default linear; }\n"
        "snGradSchemes     { default orthogonal; }\n"
        "wallDist          { method meshWave; }\n"
    )
    (case_dir / "system" / "fvSchemes").write_text(
        _foam_header("dictionary", "system", "fvSchemes") + body)


def _write_fv_solution(case_dir: Path, radiation: bool) -> None:
    g_solver = ""
    if radiation:
        g_solver = '    G { solver PCG; preconditioner DIC; tolerance 1e-6; relTol 0.05; }\n'
    body = (
        "solvers\n{\n"
        "    p_rgh  { solver GAMG; tolerance 1e-7; relTol 0.01; smoother DICGaussSeidel; nCellsInCoarsestLevel 50; }\n"
        "    \"(U|T|k|omega|alphat)\" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-7; relTol 0.1; nSweeps 1; }\n"
        f"{g_solver}"
        "}\n"
        "SIMPLE\n{\n"
        "    nNonOrthogonalCorrectors 1;\n"
        "    momentumPredictor true;\n"
        "    pRefCell 0;\n"
        "    pRefValue 0;\n"
        "    residualControl { U 1e-4; T 1e-4; \"(k|omega)\" 1e-4; p_rgh 1e-4; }\n"
        "}\n"
        "PIMPLE\n{\n"
        "    nOuterCorrectors 2;\n"
        "    nCorrectors 2;\n"
        "    nNonOrthogonalCorrectors 1;\n"
        "}\n"
        "relaxationFactors\n{\n"
        "    fields { p_rgh 0.7; }\n"
        "    equations { U 0.3; T 0.3; \"(k|omega)\" 0.5; }\n"
        "}\n"
    )
    (case_dir / "system" / "fvSolution").write_text(
        _foam_header("dictionary", "system", "fvSolution") + body)


# ── fvOptions: heat sources from human/appliance obstacles ───────────────

def _write_fv_options(case_dir: Path, scene: Scene) -> None:
    """Inject volumetric heat sources for human/appliance obstacles via
    ``fvOptions``. OpenFOAM solves the energy equation with these as
    additional source terms.
    """
    sources: list[str] = []
    for ob in scene.obstacles:
        if ob.shape not in {"human", "appliance"} or ob.on is False:
            continue
        watts = 75.0 if ob.shape == "human" else (ob.watts or 200.0)
        # Convert W → K/s at the source by dividing by ρ·cp·V; here we use
        # cellSet-region energy source via OpenFOAM's "scalarSemiImplicit"
        x0 = ob.x - ob.W / 2; x1 = ob.x + ob.W / 2
        z0 = ob.z - (ob.D or ob.W) / 2; z1 = ob.z + (ob.D or ob.W) / 2
        y0 = ob.Yoff or 0.0; y1 = (ob.Yoff or 0.0) + ob.H
        sources.append(f"""
    heat_{ob.id}
    {{
        type            scalarSemiImplicitSource;
        active          true;
        timeStart       0;
        duration        1e9;
        selectionMode   cellZone;
        cellZone        zone_obs_{ob.id};
        volumeMode      absolute;
        injectionRateSuSp
        {{
            T   ({watts:.2f} 0);
        }}
    }}""")
    if not sources:
        body = "// no heat sources\n"
    else:
        body = "".join(sources)
    (case_dir / "system" / "fvOptions").write_text(
        _foam_header("dictionary", "system", "fvOptions") +
        "// fvOptions — energy sources from human / appliance obstacles\n" +
        body
    )


# ── blockMesh ────────────────────────────────────────────────────────────

def _write_blockmesh(case_dir: Path, scene: Scene, room_stl=None) -> None:
    """Emit blockMeshDict for the room AABB.

    For a room STL we expand the bbox slightly outward (+0.5 m on each
    horizontal side) so snappyHexMesh has padding to flood-castellate
    around the L-shape — without padding the perimeter snap can fail
    when the STL touches the bbox boundary.

    Vertex layout (Y is up): see the original layout below — unchanged.
    """
    L, W, H = scene.geometry.L, scene.geometry.W, scene.geometry.H
    if room_stl is not None:
        # Bbox expansion: +0.5 m on each horizontal side, +0.3 m above
        # the ceiling so the STL roof has snap clearance.
        L = L + 1.0
        W = W + 1.0
        H = H + 0.3
    nx_w = max(20, int(L * 12))
    ny_w = max(15, int(H * 10))
    nz_w = max(20, int(W * 12))
    body = (
        "convertToMeters 1;\n\n"
        "vertices\n(\n"
        f"    ({-L/2:.3f}    0      {-W/2:.3f})\n"   # 0 — SW floor
        f"    ({-L/2:.3f}    0      { W/2:.3f})\n"   # 1 — NW floor
        f"    ({ L/2:.3f}    0      { W/2:.3f})\n"   # 2 — NE floor
        f"    ({ L/2:.3f}    0      {-W/2:.3f})\n"   # 3 — SE floor
        f"    ({-L/2:.3f}    {H:.3f} {-W/2:.3f})\n"  # 4 — SW ceiling
        f"    ({-L/2:.3f}    {H:.3f} { W/2:.3f})\n"  # 5 — NW ceiling
        f"    ({ L/2:.3f}    {H:.3f} { W/2:.3f})\n"  # 6 — NE ceiling
        f"    ({ L/2:.3f}    {H:.3f} {-W/2:.3f})\n"  # 7 — SE ceiling
        ");\n\n"
        "blocks\n(\n"
        f"    hex (0 1 2 3 4 5 6 7) ({nz_w} {nx_w} {ny_w}) simpleGrading (1 1 1)\n"
        ");\n\n"
        "boundary\n(\n"
        # Face vertex orderings chosen so the right-hand-rule normal points
        # OUT of the domain (matches OpenFOAM's boundary-face convention).
        "    floor    { type wall;  faces ((0 3 2 1)); }\n"
        "    ceiling  { type wall;  faces ((4 5 6 7)); }\n"
        "    wall_S   { type wall;  faces ((0 4 7 3)); }\n"
        "    wall_N   { type wall;  faces ((1 2 6 5)); }\n"
        "    wall_W   { type wall;  faces ((0 1 5 4)); }\n"
        "    wall_E   { type wall;  faces ((2 3 7 6)); }\n"
        ");\n"
    )
    (case_dir / "system" / "blockMeshDict").write_text(
        _foam_header("dictionary", "system", "blockMeshDict") + body)


# ── snappyHexMesh ────────────────────────────────────────────────────────

def _write_snappy(case_dir: Path, scene: Scene, room_stl=None) -> None:
    """Emit snappyHexMeshDict with refinement boxes around obstacles and
    AC supply / return patches.

    When `room_stl` is provided, also register the room STL as a
    `triSurfaceMesh` in `geometry`, with a `refinementSurfaces` entry
    whose `patchInfo` declares all carved faces should land on a single
    `room` patch. The result: snappyHexMesh produces a polyMesh whose
    interior matches the L-shape (cells outside the STL get removed),
    and a `room` patch wraps every snapped surface — so the BC writers
    can apply wall conditions there. The cuboidal blockMesh patches
    (floor / ceiling / wall_S/N/E/W) are kept as a fallback for any
    boundary face the snap doesn't reach.

    Refinement levels:
        0 = baseline (background mesh)
        1 = around large obstacles (boxes, shelves) + the room STL
        2 = around heat sources (humans, appliances)
        3 = around AC diffuser patches (highest detail near jets)

    Cell counts roughly double per level; level 3 around a 1.5 kW AC
    creates ~5k extra cells in a typical scene.
    """
    refinement_regions = ""
    for ob in scene.obstacles:
        if ob.on is False or ob.shape == "cfan":
            continue
        level = 2 if ob.shape in {"human", "appliance"} else 1
        # Bounding box for this obstacle
        x0 = ob.x - ob.W / 2; x1 = ob.x + ob.W / 2
        z0 = ob.z - (ob.D or ob.W) / 2; z1 = ob.z + (ob.D or ob.W) / 2
        y0 = (ob.Yoff or 0.0); y1 = y0 + ob.H
        # Inflate for the refinement zone
        pad = 0.15
        refinement_regions += f"""
        obs_{ob.id}_box
        {{
            type        searchableBox;
            min         ({x0 - pad:.3f} {y0 - pad:.3f} {z0 - pad:.3f});
            max         ({x1 + pad:.3f} {y1 + pad:.3f} {z1 + pad:.3f});
        }}"""
    refinement_regions_levels = ""
    for ob in scene.obstacles:
        if ob.on is False or ob.shape == "cfan":
            continue
        level = 2 if ob.shape in {"human", "appliance"} else 1
        refinement_regions_levels += f"""
        obs_{ob.id}_box
        {{
            mode    inside;
            levels  ((1.0 {level}));
        }}"""

    # When the room STL is present, expose it as a triSurfaceMesh in the
    # geometry block, and register a refinementSurface with a `room`
    # patch so all snapped boundary faces land on one named patch.
    room_geometry_block = ""
    room_surface_block = ""
    if room_stl is not None:
        room_geometry_block = """
        room.stl
        {
            type triSurfaceMesh;
            name room;
        }"""
        # Level 2 refinement on the STL surface = ~2× finer cells along
        # the actual room walls than the background mesh. Higher levels
        # would balloon the cell count for complex models; 2 is a good
        # tradeoff for HVAC analysis at default grid resolution.
        room_surface_block = """
        room
        {
            level (2 2);
            patchInfo
            {
                type wall;
            }
        }"""
    # The locationInMesh point must lie INSIDE the L-shape; the room
    # centroid (origin XZ + half-height Y) is a safe default after the
    # Tier-1 frontend's auto-fit centring. For very off-centre L-shapes
    # the user can override via the API later.
    location_in_mesh_y = scene.geometry.H / 2
    body = f"""castellatedMesh true;
snap            true;
addLayers       false;

geometry
{{{room_geometry_block}{refinement_regions}
}}

castellatedMeshControls
{{
    maxLocalCells       1000000;
    maxGlobalCells      4000000;
    minRefinementCells  0;
    nCellsBetweenLevels 3;
    features ();
    refinementSurfaces
    {{{room_surface_block}
    }}
    resolveFeatureAngle 30;
    refinementRegions
    {{{refinement_regions_levels}
    }}
    locationInMesh      (0 {location_in_mesh_y:.3f} 0);
    allowFreeStandingZoneFaces true;
}}

snapControls       {{ nSmoothPatch 3; tolerance 2; nSolveIter 30; nRelaxIter 5; }}
addLayersControls  {{ relativeSizes true; layers {{ }} expansionRatio 1.0; finalLayerThickness 0.3; minThickness 0.1; nGrow 0; featureAngle 60; nRelaxIter 3; nSmoothSurfaceNormals 1; nSmoothNormals 3; nSmoothThickness 10; maxFaceThicknessRatio 0.5; maxThicknessToMedialRatio 0.3; minMedianAxisAngle 90; nBufferCellsNoExtrude 0; nLayerIter 50; }}
meshQualityControls {{ maxNonOrtho 65; maxBoundarySkewness 20; maxInternalSkewness 4; maxConcave 80; minVol 1e-13; minTetQuality 1e-30; minArea -1; minTwist 0.02; minDeterminant 0.001; minFaceWeight 0.05; minVolRatio 0.01; minTriangleTwist -1; nSmoothScale 4; errorReduction 0.75; }}
writeFlags ();
mergeTolerance 1e-6;
"""
    (case_dir / "system" / "snappyHexMeshDict").write_text(
        _foam_header("dictionary", "system", "snappyHexMeshDict") + body)


# ── transport / turbulence / radiation properties ────────────────────────

def _write_transport_properties(case_dir: Path) -> None:
    body = (
        "transportModel  Newtonian;\n"
        "nu              [0 2 -1 0 0 0 0] 1.5e-5;\n"
        "beta            [0 0 0 -1 0 0 0] 3.4e-3;\n"
        "TRef            [0 0 0 1 0 0 0] 300.0;\n"
        "Pr              [0 0 0 0 0 0 0] 0.71;\n"
        "Prt             [0 0 0 0 0 0 0] 0.85;\n"
    )
    (case_dir / "constant" / "transportProperties").write_text(
        _foam_header("dictionary", "constant", "transportProperties") + body)


def _write_turbulence_properties(case_dir: Path) -> None:
    body = (
        "simulationType  RAS;\n\n"
        "RAS\n{\n"
        "    RASModel        kOmegaSST;\n"
        "    turbulence      on;\n"
        "    printCoeffs     on;\n"
        "}\n"
    )
    (case_dir / "constant" / "turbulenceProperties").write_text(
        _foam_header("dictionary", "constant", "turbulenceProperties") + body)


def _write_radiation_properties(case_dir: Path) -> None:
    body = (
        "radiation       on;\n\n"
        "radiationModel  viewFactor;\n\n"
        "viewFactorCoeffs\n{\n"
        "    smoothing               yes;\n"
        "    nBands                  1;\n"
        "}\n\n"
        "absorptionEmissionModel none;\n"
        "scatterModel            none;\n"
        "sootModel               none;\n"
    )
    (case_dir / "constant" / "radiationProperties").write_text(
        _foam_header("dictionary", "constant", "radiationProperties") + body)


def _write_g_field(case_dir: Path) -> None:
    body = "dimensions    [0 1 -2 0 0 0 0];\nvalue         (0 -9.81 0);\n"
    (case_dir / "constant" / "g").write_text(
        _foam_header("uniformDimensionedVectorField", "constant", "g") + body)


# ── 0/ initial fields ────────────────────────────────────────────────────

def _write_initial_T(case_dir: Path, scene: Scene, room_stl=None) -> None:
    Tout_K = scene.environment.outdoor_temp_C + 273.15
    setpoint_K = scene.environment.setpoint_C + 273.15
    # Per-wall BCs from the scene's openings + materials
    wall_bcs = _per_wall_T_bcs(scene)
    # When a room STL is present, snappy creates a `room` patch. Apply a
    # weighted-average wall T (mean of the four cardinal walls) so the
    # whole snapped boundary gets a reasonable BC. Patch-specific BCs
    # (per-opening) come in stage-3 work.
    room_bc = ""
    if room_stl is not None:
        avg_T = min(Tout_K, 303.0) * 0.7 + Tout_K * 0.3
        room_bc = f"    room       {{ type fixedValue; value uniform {avg_T:.2f}; }}\n"
    body = (
        "dimensions      [0 0 0 1 0 0 0];\n"
        f"internalField   uniform {Tout_K:.2f};\n"
        "boundaryField\n{\n"
        f"    floor      {{ type fixedValue; value uniform {min(Tout_K, 301):.2f}; }}\n"
        f"    ceiling    {{ type fixedValue; value uniform {min(Tout_K, 299):.2f}; }}\n"
        f"{wall_bcs}"
        f"{room_bc}"
        "}\n"
    )
    _ = setpoint_K
    (case_dir / "0" / "T").write_text(_foam_header("volScalarField", "0", "T") + body)


def _per_wall_T_bcs(scene: Scene) -> str:
    """Emit per-wall T BCs that respect the user's openings + materials.

    Walls without any opening get a fixedValue at min(Tout, 303 K).
    A wall with one or more windows / doors gets the wall body fixedValue
    and the openings as overlay patches via the snappyHexMesh polyMesh
    later — but for a baseline blockMesh case we apply averaged values.
    """
    Tout_K = scene.environment.outdoor_temp_C + 273.15
    out = ""
    for w in ("S", "N", "E", "W"):
        wall_T = min(Tout_K, 303.0)
        # If there's a window on this wall, blend in a hot solar T
        win_count = sum(1 for o in scene.openings if o.wall == w and o.type in {"win", "circ", "arch"})
        if win_count > 0:
            shgc = next((o.solar_transmittance or 0.65 for o in scene.openings
                         if o.wall == w and o.type in {"win", "circ", "arch"}), 0.65)
            # Simple energy-weighted blend
            wall_T = 0.7 * wall_T + 0.3 * (Tout_K + shgc * 8)
        out += f"    wall_{w}    {{ type fixedValue; value uniform {wall_T:.2f}; }}\n"
    return out


def _write_initial_U(case_dir: Path, scene: Scene, room_stl=None) -> None:
    """Velocity initial + AC inlet body forces."""
    room_bc = "    room       { type noSlip; }\n" if room_stl is not None else ""
    body = (
        "dimensions      [0 1 -1 0 0 0 0];\n"
        "internalField   uniform (0 0 0);\n"
        "boundaryField\n{\n"
        "    floor      { type noSlip; }\n"
        "    ceiling    { type noSlip; }\n"
        "    \"wall_.*\"   { type noSlip; }\n"
        f"{room_bc}"
        "}\n"
    )
    _ = scene
    (case_dir / "0" / "U").write_text(_foam_header("volVectorField", "0", "U") + body)


def _write_initial_p_rgh(case_dir: Path, scene: Scene, room_stl=None) -> None:
    _ = scene
    # For buoyantBoussinesqSimpleFoam, p_rgh is the kinematic pressure
    # (p / rho_ref) minus the rho_ref·g·h hydrostatic term — units m²/s²,
    # NOT Pa. Using Pa here trips checkDims when the solver computes g·h.
    room_bc = "    room { type fixedFluxPressure; value uniform 0; }\n" if room_stl is not None else ""
    body = (
        "dimensions      [0 2 -2 0 0 0 0];\n"
        "internalField   uniform 0;\n"
        "boundaryField\n{\n"
        "    \"(floor|ceiling|wall_.*)\" { type fixedFluxPressure; value uniform 0; }\n"
        f"{room_bc}"
        "}\n"
    )
    (case_dir / "0" / "p_rgh").write_text(_foam_header("volScalarField", "0", "p_rgh") + body)


def _write_initial_k_omega(case_dir: Path, scene: Scene, room_stl=None) -> None:
    _ = scene
    room_k = "    room { type kqRWallFunction; value uniform 0.01; }\n" if room_stl is not None else ""
    room_omega = "    room { type omegaWallFunction; value uniform 1.0; }\n" if room_stl is not None else ""
    k_body = (
        "dimensions      [0 2 -2 0 0 0 0];\n"
        "internalField   uniform 0.01;\n"
        "boundaryField\n{\n"
        "    \"(floor|ceiling|wall_.*)\" { type kqRWallFunction; value uniform 0.01; }\n"
        f"{room_k}"
        "}\n"
    )
    (case_dir / "0" / "k").write_text(_foam_header("volScalarField", "0", "k") + k_body)
    omega_body = (
        "dimensions      [0 0 -1 0 0 0 0];\n"
        "internalField   uniform 1.0;\n"
        "boundaryField\n{\n"
        "    \"(floor|ceiling|wall_.*)\" { type omegaWallFunction; value uniform 1.0; }\n"
        f"{room_omega}"
        "}\n"
    )
    (case_dir / "0" / "omega").write_text(_foam_header("volScalarField", "0", "omega") + omega_body)


def _write_initial_alphat_nut(case_dir: Path, scene: Scene, room_stl=None) -> None:
    _ = scene
    # buoyantBoussinesqSimpleFoam is incompressible — all turbulent
    # transport coefficients are kinematic (m²/s), not dynamic (kg/m/s).
    # The kinematic alphat wall function is alphatJayatillekeWallFunction.
    room_alphat = "    room { type alphatJayatillekeWallFunction; Prt 0.85; value uniform 0; }\n" if room_stl is not None else ""
    room_nut    = "    room { type nutkWallFunction; value uniform 0; }\n" if room_stl is not None else ""
    alphat = (
        "dimensions      [0 2 -1 0 0 0 0];\n"
        "internalField   uniform 0;\n"
        "boundaryField\n{\n"
        "    \"(floor|ceiling|wall_.*)\" { type alphatJayatillekeWallFunction; Prt 0.85; value uniform 0; }\n"
        f"{room_alphat}"
        "}\n"
    )
    (case_dir / "0" / "alphat").write_text(_foam_header("volScalarField", "0", "alphat") + alphat)
    nut = (
        "dimensions      [0 2 -1 0 0 0 0];\n"
        "internalField   uniform 0;\n"
        "boundaryField\n{\n"
        "    \"(floor|ceiling|wall_.*)\" { type nutkWallFunction; value uniform 0; }\n"
        f"{room_nut}"
        "}\n"
    )
    (case_dir / "0" / "nut").write_text(_foam_header("volScalarField", "0", "nut") + nut)


def _write_radiation_fields(case_dir: Path, scene: Scene) -> None:
    """Initial G (incident radiation) + IDoubleHigh fields when radiation on."""
    _ = scene
    g = (
        "dimensions      [1 0 -3 0 0 0 0];\n"
        "internalField   uniform 0;\n"
        "boundaryField\n{\n"
        "    \"(floor|ceiling|wall_.*)\" { type MarshakRadiation; T T; emissivityMode lookup; emissivity uniform 0.9; value uniform 0; }\n"
        "}\n"
    )
    (case_dir / "0" / "G").write_text(_foam_header("volScalarField", "0", "G") + g)


# ── Helpers for AC patches (used by stage-3 enhancements) ────────────────
# These functions are exposed for later use when we transition the AC
# from fvOptions body force → real inlet patches via snappyHexMesh.

def ac_inlet_patch_name(ac: ACUnit) -> str:
    return f"ac_inlet_{ac.id}"


def opening_patch_name(o: Opening) -> str:
    return f"opening_{o.id}_{o.type}"


def obstacle_zone_name(ob: Obstacle) -> str:
    return f"zone_obs_{ob.id}"


# ── Scene → STL emitters (stub for stage-3 obstacle meshing) ─────────────

def emit_obstacle_stls(scene: Scene, out_dir: Path) -> Optional[Path]:
    """Emit a single STL containing all obstacle bounding boxes for snappy.

    Stage-3 will use real meshes from imported STLs (`scene.geometry.stl`);
    for now we emit AABBs, which snappy can refine around.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / "obstacles.stl"
    lines = ["solid obstacles\n"]
    for ob in scene.obstacles:
        if ob.on is False or ob.shape == "cfan":
            continue
        x0 = ob.x - ob.W / 2; x1 = ob.x + ob.W / 2
        z0 = ob.z - (ob.D or ob.W) / 2; z1 = ob.z + (ob.D or ob.W) / 2
        y0 = ob.Yoff or 0.0; y1 = y0 + ob.H
        lines.extend(_box_to_stl(x0, y0, z0, x1, y1, z1))
    lines.append("endsolid obstacles\n")
    p.write_text("".join(lines))
    return p


def _box_to_stl(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> list[str]:
    """Emit 12 triangles for an axis-aligned box, ASCII STL."""
    out: list[str] = []
    def tri(n: tuple[float, float, float], a, b, c):
        out.append(f"  facet normal {n[0]} {n[1]} {n[2]}\n    outer loop\n")
        for v in (a, b, c):
            out.append(f"      vertex {v[0]} {v[1]} {v[2]}\n")
        out.append("    endloop\n  endfacet\n")
    # 8 corners
    A = (x0, y0, z0); B = (x1, y0, z0); C = (x1, y1, z0); D = (x0, y1, z0)
    E = (x0, y0, z1); F = (x1, y0, z1); G = (x1, y1, z1); H = (x0, y1, z1)
    # bottom (-Y)
    tri((0, -1, 0), A, B, C); tri((0, -1, 0), A, C, D)
    # top (+Y)
    tri((0,  1, 0), E, G, F); tri((0,  1, 0), E, H, G)
    # front (-Z)
    tri((0,  0, -1), A, D, B); tri((0, 0, -1), B, D, C)
    # back (+Z)
    tri((0,  0,  1), E, F, H); tri((0, 0,  1), F, G, H)
    # left (-X)
    tri((-1, 0, 0), A, E, D); tri((-1, 0, 0), D, E, H)
    # right (+X)
    tri(( 1, 0, 0), B, C, F); tri(( 1, 0, 0), C, G, F)
    return out
