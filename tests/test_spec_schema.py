"""Every network spec in validate/ conforms to engine/spec.schema.json, and the schema rejects broken specs."""
import copy
import json
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")
ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "engine" / "spec.schema.json").read_text())
SPECS = sorted(p for p in (ROOT / "validate").glob("*/*.json")
               if "nodes" in json.loads(p.read_text()) if isinstance(json.loads(p.read_text()), dict))
V = jsonschema.Draft202012Validator(SCHEMA)


def test_schema_is_valid():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    assert len(SPECS) >= 8


@pytest.mark.parametrize("path", SPECS, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_repo_specs_conform(path):
    errors = [f"{list(e.absolute_path)}: {e.message}" for e in V.iter_errors(json.loads(path.read_text()))]
    assert not errors, errors


@pytest.mark.parametrize("mutate", [
    lambda s: s.update(version=2),
    lambda s: s["nodes"][0].update(kind="firewall"),
    lambda s: s["links"].append(["A:eth0"]),
    lambda s: s["nodes"].append({"name": "X", "kind": "host", "ifaces": {"eth0": "10.0.0.300/24"}}),
    lambda s: s["links"].append(["A:eth0", "B:eth0", 1, {"shape": {"rate": "fast", "burst": 1, "limit": 1}}]),
])
def test_schema_rejects(mutate):
    s = copy.deepcopy(json.loads((ROOT / "validate" / "dhcp" / "dhcp-lan.json").read_text()))
    mutate(s)
    assert list(V.iter_errors(s))
