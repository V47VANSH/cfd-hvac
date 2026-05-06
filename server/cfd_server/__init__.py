"""HVAC CFD Tier-2 backend.

OpenFOAM-backed validation, calibration, mesh independence, ANSYS comparison,
and Bayesian multi-AC optimization. Communicates with the Tier-1 browser
solver over HTTPS using the same JSON scene schema.

Entrypoint: ``cfd_server.app:app`` — a FastAPI ASGI application.
"""

__version__ = "0.1.0"
