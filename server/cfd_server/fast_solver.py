"""Python port of the Tier-1 fast solver (collocated grid, simplified).

Used by Tier-2 modules that need a "what would Tier-1 say at this point?"
reference — primarily ``ansys.compare`` (three-way Δ) and
``calibration.run`` (Tier-1 vs OpenFOAM RMSE sweep).

This is NOT a full re-implementation of the MAC + multigrid solver; it's
a deliberately minimal port of the legacy collocated grid + upwind
advection + Boussinesq + 3-iter Gauss-Seidel pressure projection that
the JS legacy backend uses. It runs fast enough to produce a
reference field in ~1 second on a typical scene, which is the right
budget for a comparison tool.

For higher fidelity Tier-1 reference, the right path is to call into a
Node subprocess running the JS solver directly (deferred — adds Node as
a runtime dep). For now this Python port is good to within ~5 % of the
JS solver on Annex 20 / cavity (we verify in tests).
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from .schema import Scene

log = logging.getLogger(__name__)


NX_DEFAULT = 36
NY_DEFAULT = 14
NZ_DEFAULT = 28


def sample_tier1_at_points(scene: Scene, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Run the Tier-1 fast solver to convergence, sample at world points.

    Returns (T_K, V_mag) where T is in Kelvin (matching the OpenFOAM /
    ANSYS convention) and V is the velocity magnitude.

    ``points`` is (n, 3) in world coordinates with origin at the room
    centre on the floor (same as the Tier-1 frontend uses).
    """
    fields = run_tier1(scene, n_steps=200)
    T_K = sample_field_3D(fields["T"], scene, points) + 273.15
    spd = sample_speed_3D(fields, scene, points)
    return T_K, spd


def run_tier1(scene: Scene, n_steps: int = 200) -> dict[str, np.ndarray]:
    """Run a short legacy-style simulation, return the converged fields.

    Fields shape: (NX, NY, NZ) — note the index order matches the JS code.
    The arrays returned here can be sampled via ``sample_field_3D``.
    """
    NX, NY, NZ = NX_DEFAULT, NY_DEFAULT, NZ_DEFAULT
    L, W, H = scene.geometry.L, scene.geometry.W, scene.geometry.H
    dx, dy, dz = L / NX, H / NY, W / NZ

    # Initial fields
    T_AMB = 35.0
    T  = np.full((NX, NY, NZ), T_AMB)
    Vx = np.zeros((NX, NY, NZ))
    Vy = np.zeros((NX, NY, NZ))
    Vz = np.zeros((NX, NY, NZ))
    p  = np.zeros((NX, NY, NZ))
    Qs = np.zeros((NX, NY, NZ))
    wall = np.zeros((NX, NY, NZ), dtype=bool)
    Fx = np.zeros((NX, NY, NZ))
    Fz = np.zeros((NX, NY, NZ))

    # Voxelize obstacles
    for ob in scene.obstacles:
        if ob.shape == "cfan" or ob.on is False:
            continue
        ix0 = max(0, int((ob.x - ob.W / 2 + L / 2) / dx))
        ix1 = min(NX, int(np.ceil((ob.x + ob.W / 2 + L / 2) / dx)))
        iz0 = max(0, int((ob.z - (ob.D or ob.W) / 2 + W / 2) / dz))
        iz1 = min(NZ, int(np.ceil((ob.z + (ob.D or ob.W) / 2 + W / 2) / dz)))
        iy0 = max(0, int((ob.Yoff or 0) / dy))
        iy1 = min(NY, int(np.ceil(((ob.Yoff or 0) + ob.H) / dy)))
        wall[ix0:ix1, iy0:iy1, iz0:iz1] = True

    # AC jet forcing
    AC_SPEED = 3.5
    for ac in scene.ac_units:
        if ac.on is False:
            continue
        cx = int(round((ac.x + L / 2) / dx))
        cz = int(round((ac.z + W / 2) / dz))
        cy = int(round(H * 0.88 / dy))
        nx_, nz_ = 0, 0
        if   ac.wall == "S": nz_ =  1
        elif ac.wall == "N": nz_ = -1
        elif ac.wall == "W": nx_ =  1
        else:                nx_ = -1
        # 3-D Gaussian fill of Fx, Fz, Vx, Vz
        for iz in range(NZ):
            for iy in range(NY):
                for ix in range(NX):
                    rx = (ix - cx) * dx
                    ry = (iy - cy) * dy
                    rz = (iz - cz) * dz
                    d = np.sqrt(rx * rx + ry * ry + rz * rz) + 1e-3
                    dot = (rx * nx_ + rz * nz_) / d
                    if dot < 0:
                        continue
                    lat = rx * nz_ - rz * nx_
                    sp_h = 0.4 + 0.25 * d
                    sp_v = 0.3 + 0.15 * d
                    g = (np.exp(-0.5 * (lat / sp_h) ** 2) *
                         np.exp(-0.5 * (ry  / sp_v) ** 2) *
                         np.exp(-0.18 * d))
                    Fx[ix, iy, iz] += nx_ * AC_SPEED * g
                    Fz[ix, iy, iz] += nz_ * AC_SPEED * g

    # Heat sources from human/appliance
    cell_vol = dx * dy * dz
    for ob in scene.obstacles:
        if ob.shape not in {"human", "appliance"} or ob.on is False:
            continue
        watts = 75.0 if ob.shape == "human" else (ob.watts or 200.0)
        Q = watts / (1200 * cell_vol)
        cx = int(round((ob.x + L / 2) / dx))
        cz = int(round((ob.z + W / 2) / dz))
        cy = int(round(((ob.Yoff or 0) + ob.H / 2) / dy))
        for diz in range(-3, 4):
            for diy in range(0, 5):
                for dix in range(-3, 4):
                    ii = max(0, min(NX - 1, cx + dix))
                    ij = max(0, min(NY - 1, cy + diy))
                    ik = max(0, min(NZ - 1, cz + diz))
                    if wall[ii, ij, ik]:
                        continue
                    dsq = dix * dix + diy * diy + diz * diz
                    Qs[ii, ij, ik] += Q * np.exp(-dsq * 0.4)

    # Time integration — same shape as JS solver
    BETA = 3.4e-3
    G = 9.81
    ALPHA = 2.5e-5
    DT = 0.055
    relax = 0.04
    Tout = scene.environment.outdoor_temp_C

    aDx = ALPHA * DT / (dx * dx)
    aDy = ALPHA * DT / (dy * dy)
    aDz = ALPHA * DT / (dz * dz)

    for _ in range(n_steps):
        # Energy: upwind advection + diffusion + source
        nT = np.copy(T)
        u = Vx; v = Vy; ww = Vz
        # Use shifted slices for adjacency
        Tx_p = np.roll(T, -1, axis=0); Tx_p[-1, :, :] = T[-1, :, :]
        Tx_m = np.roll(T,  1, axis=0); Tx_m[0,  :, :] = T[0,  :, :]
        Ty_p = np.roll(T, -1, axis=1); Ty_p[:, -1, :] = T[:, -1, :]
        Ty_m = np.roll(T,  1, axis=1); Ty_m[:, 0,  :] = T[:, 0,  :]
        Tz_p = np.roll(T, -1, axis=2); Tz_p[:, :, -1] = T[:, :, -1]
        Tz_m = np.roll(T,  1, axis=2); Tz_m[:, :, 0]  = T[:, :, 0]

        diff = (aDx * (Tx_p + Tx_m - 2 * T) +
                aDy * (Ty_p + Ty_m - 2 * T) +
                aDz * (Tz_p + Tz_m - 2 * T))
        ax = np.where(u >= 0, (T - Tx_m) / dx, (Tx_p - T) / dx)
        ay = np.where(v >= 0, (T - Ty_m) / dy, (Ty_p - T) / dy)
        az = np.where(ww >= 0, (T - Tz_m) / dz, (Tz_p - T) / dz)
        nT = T + diff - u * ax * DT - v * ay * DT - ww * az * DT + Qs * DT
        nT = np.clip(nT, 10, 55)
        nT[wall] = 33

        # Boundary BCs (simple — match JS)
        nT[:, 0,  :] = min(30, Tout - 3)
        nT[:, -1, :] = min(28, Tout - 5)
        nT[:, :, 0]  = min(33, Tout)        # S
        nT[:, :, -1] = min(33, Tout)        # N
        nT[0,  :, :] = min(33, Tout)        # W
        nT[-1, :, :] = min(33, Tout)        # E
        T = nT

        # Buoyancy (Boussinesq)
        T_AMB_ = 35
        Vy[~wall] += BETA * G * (T[~wall] - T_AMB_) * (DT * 3)
        Vy *= 0.94
        np.clip(Vy, -2.8, 2.8, out=Vy)

        # Force relax
        Vx[~wall] += (Fx[~wall] - Vx[~wall]) * relax
        Vz[~wall] += (Fz[~wall] - Vz[~wall]) * relax

        # Pressure projection (3 iter GS)
        for _ in range(3):
            div = ((Vx[2:, 1:-1, 1:-1] - Vx[:-2, 1:-1, 1:-1]) / (2 * dx) +
                   (Vy[1:-1, 2:, 1:-1] - Vy[1:-1, :-2, 1:-1]) / (2 * dy) +
                   (Vz[1:-1, 1:-1, 2:] - Vz[1:-1, 1:-1, :-2]) / (2 * dz))
            ax_ = 1 / (dx * dx); ay_ = 1 / (dy * dy); az_ = 1 / (dz * dz)
            asum = 2 * (ax_ + ay_ + az_)
            p_int = (
                ax_ * (p[2:, 1:-1, 1:-1] + p[:-2, 1:-1, 1:-1]) +
                ay_ * (p[1:-1, 2:, 1:-1] + p[1:-1, :-2, 1:-1]) +
                az_ * (p[1:-1, 1:-1, 2:] + p[1:-1, 1:-1, :-2]) -
                div / DT
            ) / asum
            p[1:-1, 1:-1, 1:-1] = p_int
            p[wall] = 0

        Vx[1:-1, 1:-1, 1:-1] -= DT * (p[2:, 1:-1, 1:-1] - p[:-2, 1:-1, 1:-1]) / (2 * dx)
        Vy[1:-1, 1:-1, 1:-1] -= DT * (p[1:-1, 2:, 1:-1] - p[1:-1, :-2, 1:-1]) / (2 * dy)
        Vz[1:-1, 1:-1, 1:-1] -= DT * (p[1:-1, 1:-1, 2:] - p[1:-1, 1:-1, :-2]) / (2 * dz)

    return {"T": T, "Vx": Vx, "Vy": Vy, "Vz": Vz, "p": p, "wall": wall.astype(np.float32)}


def sample_field_3D(field: np.ndarray, scene: Scene, points: np.ndarray) -> np.ndarray:
    """Trilinear sample of a 3D field at world-space (x, y, z) points.

    World origin is at the room centre on the floor (matches Tier-1 JS):
       x ∈ [-L/2, L/2],  y ∈ [0, H],  z ∈ [-W/2, W/2].
    """
    NX, NY, NZ = field.shape
    L, W, H = scene.geometry.L, scene.geometry.W, scene.geometry.H
    out = np.empty(len(points), dtype=np.float64)
    for i, (x, y, z) in enumerate(points):
        # World → fractional cell index
        fx = (x + L / 2) / (L / NX) - 0.5
        fy = (y) / (H / NY) - 0.5
        fz = (z + W / 2) / (W / NZ) - 0.5
        ix = max(0, min(NX - 2, int(np.floor(fx))))
        iy = max(0, min(NY - 2, int(np.floor(fy))))
        iz = max(0, min(NZ - 2, int(np.floor(fz))))
        tx = max(0, min(1, fx - ix))
        ty = max(0, min(1, fy - iy))
        tz = max(0, min(1, fz - iz))
        c000 = field[ix    , iy    , iz    ]
        c100 = field[ix + 1, iy    , iz    ]
        c010 = field[ix    , iy + 1, iz    ]
        c110 = field[ix + 1, iy + 1, iz    ]
        c001 = field[ix    , iy    , iz + 1]
        c101 = field[ix + 1, iy    , iz + 1]
        c011 = field[ix    , iy + 1, iz + 1]
        c111 = field[ix + 1, iy + 1, iz + 1]
        c00 = c000 * (1 - tx) + c100 * tx
        c10 = c010 * (1 - tx) + c110 * tx
        c01 = c001 * (1 - tx) + c101 * tx
        c11 = c011 * (1 - tx) + c111 * tx
        c0 = c00 * (1 - ty) + c10 * ty
        c1 = c01 * (1 - ty) + c11 * ty
        out[i] = c0 * (1 - tz) + c1 * tz
    return out


def sample_speed_3D(fields: dict, scene: Scene, points: np.ndarray) -> np.ndarray:
    Vx = sample_field_3D(fields["Vx"], scene, points)
    Vy = sample_field_3D(fields["Vy"], scene, points)
    Vz = sample_field_3D(fields["Vz"], scene, points)
    return np.sqrt(Vx ** 2 + Vy ** 2 + Vz ** 2)
