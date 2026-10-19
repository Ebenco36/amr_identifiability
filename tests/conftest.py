from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MDAG = ROOT / "m_DAG"

# DAGitty files in m_DAG/ and the model each one should equal
FILES = {
    "M1_Primary model.txt": ("M1", 1),
    "M2_Unmeasured clinical-selection.txt": ("M2", 1),
    "M3_Downstream self-masking.txt": ("M3", 1),
    "M1_Primary model_multiple_upstream.txt": ("M1", 4),
    "M2_Unmeasured clinical-selection_multiple_upstream.txt": ("M2", 4),
    "M3_Downstream self-masking_multiple_upstreams.txt": ("M3", 4),
}


@pytest.fixture(params=sorted(FILES))
def dagitty_file(request):
    path = MDAG / request.param
    if not path.exists():
        pytest.skip(f"{path.name} not present")
    return path, FILES[request.param]
