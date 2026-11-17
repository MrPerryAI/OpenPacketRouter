"""Proof of concept #2 as a test: the storm math vs real Linux kernel bridges.

Opt-in, because it needs root, `unshare` and iproute2, and timing on shared CI
machines is noisy:   sudo RUN_KERNEL_TESTS=1 python3 -m pytest -q tests/test_kernel.py
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_KERNEL_TESTS") != "1" or os.geteuid() != 0 or not shutil.which("unshare") or not shutil.which("ip"),
    reason="set RUN_KERNEL_TESTS=1 and run as root with unshare and iproute2")


def test_kernel_bridges_match_the_math():
    r = subprocess.run([sys.executable, str(HERE / "run_kernel.py")], capture_output=True, text=True, timeout=600)
    print(r.stdout)
    assert r.returncode == 0, r.stdout + r.stderr
