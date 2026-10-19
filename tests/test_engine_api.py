import shutil

import pytest

from amr_identifiability import build_model
from amr_identifiability.engine import classify, effect, recover

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")


def test_recover_on_the_amr_models():
    r = recover(build_model("M1", 1), ["Yk"], given=["S", "W", "T"])
    assert r["recoverable"] is True and r["method"] == "Theorem 1"
    assert r["text"] == "Σ_{Yj} P(Yk* | S, T, W, Yj*, R_Yj = 0, R_Yk = 0) P(Yj* | S, T, W, R_Yj = 0)"
    assert r["latex"].startswith("\\sum_{yj}")
    assert recover(build_model("M2", 1), ["Yk"])["method"] == "Theorem 3"
    assert recover(build_model("M3", 1), ["Yk"])["recoverable"] is False


def test_classify_and_effect_from_text():
    assert classify(build_model("M1"))["mechanism"] == "MNAR"
    e = effect("dag { Z -> X  Z -> Y  X -> Y }", ["X"], ["Y"])
    assert e["identifiable"] and e["adjustment"]["minimal"] == [["Z"]]
    with pytest.raises(ValueError):
        recover(build_model("M1", 1), ["nope"])
