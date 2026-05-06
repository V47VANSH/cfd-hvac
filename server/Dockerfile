# syntax=docker/dockerfile:1.6
#
# CFD HVAC Tier-2 backend — OpenFOAM v2312 (OpenCFD) on Ubuntu 22.04.
#
# We use OpenCFD's v2312 release because Foundation v10 dropped the
# legacy solver names our case generator emits — `buoyantBoussinesqSimpleFoam`
# is gone in Foundation v9+ (replaced by the unified `buoyantFoam` with
# `physicalProperties` instead of `transportProperties`). v2312 keeps the
# legacy names AND the `transportProperties` schema cases.py writes.
#
# OpenCFD's `add-debian-repo.sh` is broken (its GPG dearmor fails on the
# CDN's redirect), so we sign the repo manually with the dearmored key
# from `https://dl.openfoam.com/pubkey.gpg` (HTTP 200, 1.6 KB ASCII-armored).
#
# Build:    docker build -t cfd-server:0.2 .
# Run:      docker run --rm -p 8000:8000 cfd-server:0.2
# Healthcheck: curl http://localhost:8000/health
#
# Image size ~3.8 GB; mostly OpenFOAM. Multi-stage trim is a stretch goal.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Base toolchain + Python 3.10 (Ubuntu 22.04 default) + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg software-properties-common \
        python3 python3-pip python3-venv python3-dev \
        ffmpeg \
        build-essential git \
    && rm -rf /var/lib/apt/lists/*

# OpenCFD OpenFOAM v2312 — manual setup with modern apt signing.
# Repo URL: https://dl.openfoam.com/repos/deb (jammy main)
# Key URL:  https://dl.openfoam.com/pubkey.gpg
RUN curl -fsSL https://dl.openfoam.com/pubkey.gpg \
        | gpg --dearmor -o /usr/share/keyrings/openfoam-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openfoam-archive-keyring.gpg] https://dl.openfoam.com/repos/deb jammy main" \
        > /etc/apt/sources.list.d/openfoam.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        openfoam2312-default \
    && rm -rf /var/lib/apt/lists/*

# Auto-source the OpenFOAM environment in every interactive AND
# non-interactive shell. Critical: subprocess shells launched by uvicorn
# need WM_PROJECT_DIR + PATH set so blockMesh / snappyHexMesh resolve.
RUN echo "source /usr/lib/openfoam/openfoam2312/etc/bashrc" >> /etc/bash.bashrc \
 && echo "source /usr/lib/openfoam/openfoam2312/etc/bashrc" > /etc/profile.d/openfoam.sh \
 && chmod +x /etc/profile.d/openfoam.sh

# All RUN commands below use bash with -l so /etc/profile.d/openfoam.sh fires.
SHELL ["/bin/bash", "-lc"]

WORKDIR /app

# Python deps. We split the install into staged groups so pip's resolver
# doesn't backtrack across the whole heavy scientific stack — that
# backtracking can hang for 30+ min with no network or compile activity
# when pythermalcomfort + pymoo + scikit-learn + pyvista all argue about
# numpy/scipy versions. --prefer-binary forces wheels (no source builds).
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
 && python3 -m pip install --no-cache-dir --prefer-binary \
        "numpy>=1.26" "scipy>=1.13" \
 && python3 -m pip install --no-cache-dir --prefer-binary \
        "fastapi>=0.115" "uvicorn[standard]>=0.30" "pydantic>=2.7" \
        "sse-starlette>=2.1" "python-multipart>=0.0.9" \
 && python3 -m pip install --no-cache-dir --prefer-binary \
        "matplotlib>=3.9" "scikit-learn>=1.5" \
 && python3 -m pip install --no-cache-dir --prefer-binary \
        "pythermalcomfort>=2.10.0" \
 && python3 -m pip install --no-cache-dir --prefer-binary \
        "PyVista>=0.43" "ofpp>=0.12.0" \
 && python3 -m pip install --no-cache-dir --prefer-binary \
        "pymoo>=0.6.1"

# Install package itself with --no-deps (deps already installed above)
COPY pyproject.toml ./pyproject.toml

# App code
COPY cfd_server ./cfd_server

# Install package itself; deps already satisfied above so this is just
# `pip install -e . --no-deps` semantics.
RUN python3 -m pip install --no-cache-dir --no-deps -e .

# Cache dir for case_dir/ artefacts (mountable as a volume)
VOLUME /tmp/cfd-cases
ENV CFD_CASE_ROOT=/tmp/cfd-cases

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

# Login shell so OpenFOAM env is sourced before uvicorn starts;
# subprocesses spawned from uvicorn inherit the env.
CMD ["/bin/bash", "-lc", "uvicorn cfd_server.app:app --host 0.0.0.0 --port 8000"]
