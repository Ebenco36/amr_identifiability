"""Missingness graphs for antimicrobial resistance surveillance.

Main entry points:

    MGraph                    an m-DAG with node roles and conditional-independence queries
    build_model(name, n)      the M1, M2 and M3 models, built from one shared edge list
    load_dagitty(path)        read a DAGitty file into an MGraph
    ordered_factorisation     check a recovery formula step by step (Mohan & Pearl 2021)
    find_recovery             search for orderings and covariate sets that recover a target
    ConditionCatalogue        every minimal conditional independence, by node and by pair
    viz.Explorer              interactive explorer (offline HTML) and figure export
"""

from amr_identifiability.mgraph import Independence, MGraph, PathReport
from amr_identifiability.dagitty import load_dagitty, parse_dagitty, to_dagitty
from amr_identifiability.models import MODEL_NAMES, NODE_DESCRIPTIONS, build_model
from amr_identifiability.catalogue import ConditionCatalogue, PairConditions
from amr_identifiability.recovery import (
    Recovery,
    Step,
    find_recovery,
    ordered_factorisation,
    r_factorisation_problems,
)

__all__ = [
    "Independence",
    "MGraph",
    "PathReport",
    "load_dagitty",
    "parse_dagitty",
    "to_dagitty",
    "MODEL_NAMES",
    "NODE_DESCRIPTIONS",
    "build_model",
    "Recovery",
    "Step",
    "find_recovery",
    "ordered_factorisation",
    "r_factorisation_problems",
    "ConditionCatalogue",
    "PairConditions",
]

__version__ = "0.1.0"
