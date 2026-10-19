#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb


LOGGER = logging.getLogger("armd_episode_builder")


@dataclass
class BuildConfig:
    input_dir: Path
    output_dir: Path
    memory_limit: str = "4GB"
    threads: int = 4
    allow_missing_files: bool = False
    export_csv: bool = False
    antibiotics: list[str] = field(default_factory=list)
    intermediate_policy: str = "exclude"


class ARMDEcoliEpisodeBuilder:
    """
    Integrate ARMD-ECUH sources into E. coli culture-order records.

    The episode unit is a culture order, not a verified unique isolate
    or clinically deduplicated infection episode.
    """

    SOURCE_FILES = {
        "cohort": "00_microbiology_cultures_cohort.csv",
        "adi": "01_microbiology_cultures_adi_scores.csv",
        "abx_class": (
            "02_microbiology_cultures_antibiotic_class_exposure.csv"
        ),
        "abx_subtype": (
            "03_microbiology_cultures_antibiotic_subtype_exposure.csv"
        ),
        "comorbidity": "04_microbiology_cultures_comorbidity.csv",
        "demographics": "05_microbiology_cultures_demographics.csv",
        "labs": "06_microbiology_cultures_labs.csv",
        "resistance_history": (
            "07_microbiology_cultures_microbial_resistance.csv"
        ),
        "nursing_visits": (
            "08_microbiology_cultures_nursing_home_visits.csv"
        ),
        "organism_history": (
            "09_microbiology_cultures_prior_infecting_organism.csv"
        ),
        "prior_med": "010_microbiology_cultures_prior_med.csv",
        "procedures": "011_microbiology_cultures_prior_procedures.csv",
        "ward": "012_microbiology_cultures_ward_info.csv",
        "vitals": "013_microbiology_cultures_vitals.csv",
    }

    KEY_COLUMNS = (
        "anon_id",
        "pat_enc_csn_id_coded",
        "order_proc_id_coded",
        "order_time_jittered",
    )

    REQUIRED_COHORT_COLUMNS = (
        "organism",
        "antibiotic",
        "susceptibility",
    )

    ECOLI_NORMALIZED_LABELS = (
        "escherichiacoli",
        "ecoli",
    )

    WARNINGS = [
        (
            "Episode unit is culture_order, not a verified unique isolate "
            "or clinically deduplicated infection episode."
        ),
        (
            "Same-order multiple E. coli isolates cannot be separated "
            "using the documented join keys alone."
        ),
        (
            "No repeat-culture exclusion window is imposed by this script."
        ),
        (
            "No relative-day sign convention or baseline lookback window "
            "is inferred."
        ),
        (
            "Absent historical records are not interpreted as confirmed "
            "absence of clinical history."
        ),
        (
            "Laboratory and vital-sign timing fields are preserved; "
            "measurements are not automatically classified as baseline."
        ),
        (
            "recorded_jittered_year is not a validated true calendar "
            "or laboratory-policy period."
        ),
        (
            "Antibiotic class, subtype, and prior-medication overlap is "
            "preserved rather than counted as separate exposure events."
        ),
        (
            "Optional binary R measures availability of the configured "
            "binary endpoint, not whether testing was performed."
        ),
        (
            "Conflicting susceptibility categories remain unresolved; "
            "the script does not choose maximum resistance."
        ),
        (
            "The denominator contains only E. coli orders identifiable "
            "in the released cohort."
        ),
        (
            "No prevalence estimation or missingness-mechanism "
            "verification is performed."
        ),
    ]

    def __init__(self, config: BuildConfig) -> None:
        self.config = config
        self.connection: duckdb.DuckDBPyConnection | None = None

        self.sources: dict[str, dict[str, Any]] = {}
        self.audit: list[dict[str, Any]] = []
        self.aggregates: list[tuple[str, str]] = []
        self.drug_mapping: list[dict[str, str]] = []

        self.episode_count = 0
        self.started_at = datetime.now(timezone.utc).isoformat()

    @staticmethod
    def quote_identifier(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    @staticmethod
    def quote_literal(value: Any) -> str:
        return "'" + str(value).replace("'", "''") + "'"

    @property
    def db(self) -> duckdb.DuckDBPyConnection:
        if self.connection is None:
            raise RuntimeError("Database connection has not been opened.")
        return self.connection

    @property
    def key_sql(self) -> str:
        return ", ".join(
            self.quote_identifier(column)
            for column in self.KEY_COLUMNS
        )

    def join_condition(
        self,
        left_alias: str,
        right_alias: str,
    ) -> str:
        return " AND ".join(
            (
                f"{left_alias}.{self.quote_identifier(column)} = "
                f"{right_alias}.{self.quote_identifier(column)}"
            )
            for column in self.KEY_COLUMNS
        )

    def normalized_organism_expression(
        self,
        column: str = "organism",
    ) -> str:
        identifier = self.quote_identifier(column)

        return (
            f"regexp_replace("
            f"lower(trim({identifier})), "
            f"'[^a-z0-9]+', '', 'g'"
            f")"
        )

    @property
    def ecoli_condition(self) -> str:
        labels = ", ".join(
            self.quote_literal(label)
            for label in self.ECOLI_NORMALIZED_LABELS
        )

        return (
            f"{self.normalized_organism_expression()} "
            f"IN ({labels})"
        )

    def scalar(self, query: str) -> Any:
        row = self.db.execute(query).fetchone()

        if row is None:
            raise RuntimeError("Scalar query returned no rows.")

        return row[0]

    def export_query(
        self,
        query: str,
        filename: str,
        csv: bool = False,
    ) -> Path:
        destination = self.config.output_dir / filename

        options = (
            "FORMAT CSV, HEADER TRUE"
            if csv
            else "FORMAT PARQUET, COMPRESSION ZSTD"
        )

        self.db.execute(
            f"COPY ({query}) "
            f"TO {self.quote_literal(destination)} "
            f"({options})"
        )

        return destination

    def validate_configuration(self) -> None:
        self.config.input_dir = (
            self.config.input_dir.expanduser().resolve()
        )
        self.config.output_dir = (
            self.config.output_dir.expanduser().resolve()
        )

        if not self.config.input_dir.is_dir():
            raise NotADirectoryError(self.config.input_dir)

        if self.config.output_dir == self.config.input_dir:
            raise ValueError(
                "Input and output directories must be different."
            )

        if self.config.threads < 1:
            raise ValueError("--threads must be at least 1.")

        valid_policies = {
            "exclude",
            "nonresistant",
            "resistant",
        }

        if self.config.intermediate_policy not in valid_policies:
            raise ValueError(
                "Invalid intermediate-result policy."
            )

        normalized_drugs = [
            drug.strip().lower()
            for drug in self.config.antibiotics
        ]

        if any(not drug for drug in normalized_drugs):
            raise ValueError(
                "Antibiotic labels cannot be empty."
            )

        if len(normalized_drugs) != len(set(normalized_drugs)):
            raise ValueError(
                "Duplicate antibiotic labels were supplied."
            )

        self.config.antibiotics = normalized_drugs

    def open_database(self) -> None:
        self.config.output_dir.mkdir(
            parents=True,
            exist_ok=True,
        )

        spill_dir = self.config.output_dir / "duckdb_spill"
        spill_dir.mkdir(parents=True, exist_ok=True)

        database_path = (
            self.config.output_dir / "build.duckdb"
        )

        self.connection = duckdb.connect(str(database_path))

        self.db.execute(
            "SET memory_limit = "
            f"{self.quote_literal(self.config.memory_limit)}"
        )

        self.db.execute(
            f"SET threads = {self.config.threads}"
        )

        self.db.execute(
            "SET temp_directory = "
            f"{self.quote_literal(spill_dir)}"
        )

        self.db.execute(
            "SET preserve_insertion_order = false"
        )

    def register_source(
        self,
        name: str,
        filename: str,
    ) -> None:
        path = self.config.input_dir / filename

        if not path.is_file():
            if (
                name == "cohort"
                or not self.config.allow_missing_files
            ):
                raise FileNotFoundError(path)

            LOGGER.warning("Missing optional source: %s", filename)

            self.audit.append(
                {
                    "source": name,
                    "status": "file_absent",
                    "filename": filename,
                }
            )

            return

        LOGGER.info("Registering %s", filename)

        raw_name = f"raw_{name}"

        # Explicit CSV dialect prevents quoted commas from being
        # misinterpreted when automatic quote detection fails.
        csv_query = (
            f"SELECT * FROM read_csv("
            f"{self.quote_literal(path)}, "
            f"header=true, "
            f"delim={self.quote_literal(',')}, "
            f"quote={self.quote_literal(chr(34))}, "
            f"escape={self.quote_literal(chr(34))}, "
            f"strict_mode=true, "
            f"ignore_errors=false, "
            f"all_varchar=true, "
            f"nullstr=['Null','NULL','']"
            f")"
        )

        self.db.execute(
            f"CREATE OR REPLACE VIEW "
            f"{self.quote_identifier(raw_name)} "
            f"AS {csv_query}"
        )

        description = self.db.execute(
            f"DESCRIBE {self.quote_identifier(raw_name)}"
        ).fetchall()

        columns = [row[0] for row in description]

        missing_keys = (
            set(self.KEY_COLUMNS) - set(columns)
        )

        timestamp_column = self.KEY_COLUMNS[3]

        if missing_keys == {timestamp_column} and name != "cohort":
            raw_name = self.attach_missing_order_timestamp(
                name=name,
                raw_name=raw_name,
                columns=columns,
            )

        elif missing_keys:
            raise ValueError(
                f"{filename}: missing join columns "
                f"{sorted(missing_keys)}. "
                "Automatic reconstruction is supported only when "
                "a side table contains all three culture-order "
                "identifiers and lacks only order_time_jittered."
            )

        if name == "cohort":
            missing_fields = (
                set(self.REQUIRED_COHORT_COLUMNS)
                - set(columns)
            )

            if missing_fields:
                raise ValueError(
                    f"{filename}: missing cohort fields "
                    f"{sorted(missing_fields)}"
                )

        reserved_fields = {
            "__organism_normalized",
            "__antibiotic_key",
            "__susceptibility_key",
        }

        if reserved_fields.intersection(columns):
            raise ValueError(
                f"{filename}: reserved derived column names "
                "are already present."
            )

        projection = [
            (
                f"trim({self.quote_identifier(column)}) "
                f"AS {self.quote_identifier(column)}"
            )
            for column in self.KEY_COLUMNS[:3]
        ]

        timestamp_column = self.KEY_COLUMNS[3]
        timestamp_identifier = self.quote_identifier(timestamp_column)

        projection.append(
            (
                f"try_cast("
                f"trim(cast({timestamp_identifier} AS VARCHAR)) "
                f"AS TIMESTAMP"
                f") AS {timestamp_identifier}"
            )
        )

        projection.extend(
            self.quote_identifier(column)
            for column in columns
            if column not in self.KEY_COLUMNS
        )

        self.db.execute(
            f"CREATE OR REPLACE VIEW "
            f"{self.quote_identifier(name)} "
            f"AS SELECT {', '.join(projection)} "
            f"FROM {self.quote_identifier(raw_name)}"
        )

        invalid_condition = " OR ".join(
            (
                f"{self.quote_identifier(column)} IS NULL "
                f"OR cast({self.quote_identifier(column)} "
                f"AS VARCHAR) = ''"
            )
            for column in self.KEY_COLUMNS
        )

        invalid_count = self.scalar(
            f"SELECT count(*) "
            f"FROM {self.quote_identifier(name)} "
            f"WHERE {invalid_condition}"
        )

        if invalid_count:
            self.export_query(
                (
                    f"SELECT * "
                    f"FROM {self.quote_identifier(name)} "
                    f"WHERE {invalid_condition}"
                ),
                f"{name}_invalid_keys.parquet",
            )

            raise ValueError(
                f"{filename}: {invalid_count} rows have missing "
                "IDs or invalid timestamps. Inspect the exported "
                "invalid-key records before proceeding."
            )

        metadata = path.stat()

        self.sources[name] = {
            "filename": filename,
            "path": str(path),
            "bytes": metadata.st_size,
            "modified_time_ns": metadata.st_mtime_ns,
            "columns": columns,
        }

    def register_sources(self) -> None:
        for name, filename in self.SOURCE_FILES.items():
            self.register_source(name, filename)

    def validate_timestamp_consistency(self) -> None:
        LOGGER.info("Checking cross-source timestamp consistency")

        union_query = " UNION ALL ".join(
            (
                f"SELECT {self.key_sql} "
                f"FROM {self.quote_identifier(name)}"
            )
            for name in self.sources
        )

        self.db.execute(
            "CREATE OR REPLACE TABLE all_keys AS "
            f"SELECT DISTINCT * FROM ({union_query})"
        )

        identifiers = ", ".join(
            self.quote_identifier(column)
            for column in self.KEY_COLUMNS[:3]
        )

        timestamp_column = self.quote_identifier(
            self.KEY_COLUMNS[3]
        )

        conflict_query = (
            f"SELECT {identifiers}, "
            f"count(DISTINCT {timestamp_column}) "
            f"AS timestamp_count "
            f"FROM all_keys "
            f"GROUP BY {identifiers} "
            f"HAVING count(DISTINCT {timestamp_column}) > 1"
        )

        conflict_count = self.scalar(
            f"SELECT count(*) FROM ({conflict_query})"
        )

        if conflict_count:
            self.export_query(
                conflict_query,
                "key_timestamp_conflicts.csv",
                csv=True,
            )

            raise ValueError(
                f"{conflict_count} identifier triples map to "
                "multiple timestamps. Inspect "
                "key_timestamp_conflicts.csv; do not weaken "
                "the joins silently."
            )

    def build_episode_backbone(self) -> None:
        LOGGER.info("Building E. coli culture-order backbone")

        self.db.execute(
            "CREATE OR REPLACE TABLE cohort_keys AS "
            f"SELECT DISTINCT {self.key_sql} FROM cohort"
        )

        self.db.execute(
            "CREATE OR REPLACE TABLE base AS "
            f"SELECT DISTINCT {self.key_sql} "
            f"FROM cohort WHERE {self.ecoli_condition}"
        )

        self.episode_count = self.scalar(
            "SELECT count(*) FROM base"
        )

        if self.episode_count == 0:
            self.export_query(
                (
                    "SELECT organism, count(*) AS source_rows "
                    "FROM cohort "
                    "GROUP BY organism "
                    "ORDER BY source_rows DESC"
                ),
                "organism_inventory.csv",
                csv=True,
            )

            raise ValueError(
                "No E. coli records matched the exact normalized "
                "aliases. Inspect organism_inventory.csv before "
                "changing the organism filter."
            )

        LOGGER.info(
            "Identified %s E. coli culture orders",
            f"{self.episode_count:,}",
        )

    def build_ast_tables(self) -> None:
        LOGGER.info("Building susceptibility tables and inventories")

        self.db.execute(
            "CREATE OR REPLACE TABLE ec_ast_rows AS "
            "SELECT *, "
            f"{self.normalized_organism_expression()} "
            "AS __organism_normalized, "
            "lower(trim(antibiotic)) AS __antibiotic_key, "
            "lower(trim(susceptibility)) AS __susceptibility_key "
            f"FROM cohort WHERE {self.ecoli_condition}"
        )

        self.export_query(
            "SELECT * FROM ec_ast_rows",
            "ecoli_ast_source_rows.parquet",
        )

        self.db.execute(
            f"""
            CREATE OR REPLACE TABLE ast_long AS
            SELECT
                {self.key_sql},
                __antibiotic_key AS antibiotic_key,
                count(*) AS source_row_count,
                count(DISTINCT __susceptibility_key)
                    AS distinct_result_count,
                to_json(
                    list(
                        DISTINCT __susceptibility_key
                        ORDER BY __susceptibility_key
                    )
                    FILTER (
                        WHERE __susceptibility_key IS NOT NULL
                    )
                ) AS reported_values_json,
                CASE
                    WHEN count(
                        DISTINCT __susceptibility_key
                    ) = 1
                    THEN min(__susceptibility_key)
                    ELSE NULL
                END AS resolved_susceptibility,
                count(
                    DISTINCT __susceptibility_key
                ) > 1 AS result_conflict
            FROM ec_ast_rows
            WHERE
                __antibiotic_key IS NOT NULL
                AND __antibiotic_key <> ''
            GROUP BY
                {self.key_sql},
                __antibiotic_key
            """
        )

        self.export_query(
            "SELECT * FROM ast_long",
            "ecoli_ast_long.parquet",
        )

        self.export_query(
            "SELECT * FROM ast_long WHERE result_conflict",
            "ast_conflicts.parquet",
        )

        self.export_query(
            """
            SELECT
                antibiotic_key,
                count(*) AS episodes_with_drug_row,
                sum(
                    CASE
                        WHEN resolved_susceptibility IS NOT NULL
                        THEN 1 ELSE 0
                    END
                ) AS episodes_with_resolved_value,
                sum(
                    CASE
                        WHEN result_conflict
                        THEN 1 ELSE 0
                    END
                ) AS conflicting_episodes
            FROM ast_long
            GROUP BY antibiotic_key
            ORDER BY episodes_with_drug_row DESC
            """,
            "antibiotic_inventory.csv",
            csv=True,
        )

        self.export_query(
            """
            SELECT
                __susceptibility_key AS susceptibility_key,
                count(*) AS source_rows
            FROM ec_ast_rows
            GROUP BY __susceptibility_key
            ORDER BY source_rows DESC
            """,
            "susceptibility_inventory.csv",
            csv=True,
        )

        self.export_query(
            """
            SELECT
                organism,
                __organism_normalized,
                count(*) AS source_rows
            FROM ec_ast_rows
            GROUP BY organism, __organism_normalized
            ORDER BY source_rows DESC
            """,
            "ecoli_organism_label_inventory.csv",
            csv=True,
        )

        self.export_query(
            """
            SELECT *
            FROM ec_ast_rows
            WHERE
                __antibiotic_key IS NULL
                OR __antibiotic_key = ''
            """,
            "ast_rows_without_drug_label.parquet",
        )

    def aggregate_source(self, name: str) -> None:
        LOGGER.info("Aggregating %s independently", name)

        columns = self.sources[name]["columns"]

        payload_columns = [
            column
            for column in columns
            if column not in self.KEY_COLUMNS
        ]

        matching_query = (
            f"SELECT s.* "
            f"FROM {self.quote_identifier(name)} s "
            f"INNER JOIN base b "
            f"ON {self.join_condition('b', 's')}"
        )

        total_rows = self.scalar(
            f"SELECT count(*) "
            f"FROM {self.quote_identifier(name)}"
        )

        matching_rows = self.scalar(
            f"SELECT count(*) FROM ({matching_query})"
        )

        orphan_query = (
            f"SELECT s.* "
            f"FROM {self.quote_identifier(name)} s "
            f"ANTI JOIN cohort_keys b "
            f"ON {self.join_condition('b', 's')}"
        )

        orphan_rows = self.scalar(
            f"SELECT count(*) FROM ({orphan_query})"
        )

        if orphan_rows:
            orphan_keys = ", ".join(
                f"s.{self.quote_identifier(column)}"
                for column in self.KEY_COLUMNS
            )

            self.export_query(
                (
                    f"SELECT DISTINCT {orphan_keys} "
                    f"FROM {self.quote_identifier(name)} s "
                    f"ANTI JOIN cohort_keys b "
                    f"ON {self.join_condition('b', 's')}"
                ),
                f"{name}_orphan_keys.parquet",
            )

            LOGGER.warning(
                "%s has %s rows outside the released cohort keys",
                name,
                f"{orphan_rows:,}",
            )

        if payload_columns:
            packed_fields = ", ".join(
                (
                    f"{self.quote_identifier(column)} := "
                    f"{self.quote_identifier(column)}"
                )
                for column in payload_columns
            )

            payload_expression = (
                f"to_json(struct_pack({packed_fields}))"
            )

            meaningful_condition = " OR ".join(
                f"{self.quote_identifier(column)} IS NOT NULL"
                for column in payload_columns
            )
        else:
            payload_expression = self.quote_literal("{}")
            meaningful_condition = "false"

        aggregate_table = f"agg_{name}"

        self.db.execute(
            f"""
            CREATE OR REPLACE TABLE
                {self.quote_identifier(aggregate_table)} AS
            SELECT
                {self.key_sql},
                count(*) AS source_rows,
                count(*) FILTER (
                    WHERE {meaningful_condition}
                ) AS nonempty_rows,
                count(
                    DISTINCT {payload_expression}
                ) FILTER (
                    WHERE {meaningful_condition}
                ) AS unique_records,
                to_json(
                    list(
                        DISTINCT {payload_expression}
                        ORDER BY {payload_expression}
                    )
                    FILTER (
                        WHERE {meaningful_condition}
                    )
                ) AS records_json
            FROM ({matching_query})
            GROUP BY {self.key_sql}
            """
        )

        self.export_query(
            (
                f"SELECT * "
                f"FROM {self.quote_identifier(aggregate_table)}"
            ),
            f"{name}_episode_records.parquet",
        )

        covered_episodes = self.scalar(
            (
                f"SELECT count(*) "
                f"FROM {self.quote_identifier(aggregate_table)}"
            )
        )

        self.aggregates.append((name, aggregate_table))

        self.audit.append(
            {
                "source": name,
                "status": "loaded",
                "source_rows": total_rows,
                "rows_matching_ecoli_orders": matching_rows,
                "rows_outside_cohort_keys": orphan_rows,
                "ecoli_orders_with_source_rows": covered_episodes,
                "ecoli_orders_without_source_rows": (
                    self.episode_count - covered_episodes
                ),
            }
        )

    def aggregate_sources(self) -> None:
        for name in self.sources:
            self.aggregate_source(name)

    def binary_result_expression(
        self,
        result_expression: str,
    ) -> str:
        susceptible_values = ["susceptible"]
        resistant_values = ["resistant"]

        if self.config.intermediate_policy == "nonresistant":
            susceptible_values.append("intermediate")
        elif self.config.intermediate_policy == "resistant":
            resistant_values.append("intermediate")

        zero_values = ", ".join(
            self.quote_literal(value)
            for value in susceptible_values
        )

        one_values = ", ".join(
            self.quote_literal(value)
            for value in resistant_values
        )

        return (
            "CASE "
            f"WHEN {result_expression} IN ({one_values}) THEN 1 "
            f"WHEN {result_expression} IN ({zero_values}) THEN 0 "
            "ELSE NULL END"
        )

    def build_master(self) -> None:
        LOGGER.info("Joining episode-level source aggregates")

        select_columns = [
            "b.*",
            """
            sha256(
                to_json(
                    struct_pack(
                        anon_id := b.anon_id,
                        encounter_id := b.pat_enc_csn_id_coded,
                        order_id := b.order_proc_id_coded,
                        order_time := b.order_time_jittered
                    )
                )
            ) AS episode_id
            """,
            "'culture_order' AS episode_unit",
            "'Escherichia coli' AS target_organism",
            (
                "year(b.order_time_jittered) "
                "AS recorded_jittered_year"
            ),
        ]

        joins: list[str] = []

        for index, (name, table) in enumerate(self.aggregates):
            alias = f"x{index}"

            joins.append(
                f"LEFT JOIN {self.quote_identifier(table)} "
                f"{alias} "
                f"ON {self.join_condition('b', alias)}"
            )

            select_columns.extend(
                [
                    (
                        f"{alias}.source_rows IS NOT NULL AS "
                        f"{self.quote_identifier(
                            name + '__has_source_rows'
                        )}"
                    ),
                    (
                        f"coalesce({alias}.source_rows, 0) AS "
                        f"{self.quote_identifier(
                            name + '__source_rows'
                        )}"
                    ),
                    (
                        f"coalesce({alias}.nonempty_rows, 0) AS "
                        f"{self.quote_identifier(
                            name + '__nonempty_rows'
                        )}"
                    ),
                    (
                        f"coalesce({alias}.unique_records, 0) AS "
                        f"{self.quote_identifier(
                            name + '__unique_records'
                        )}"
                    ),
                    (
                        f"coalesce({alias}.records_json, '[]') AS "
                        f"{self.quote_identifier(
                            name + '__records_json'
                        )}"
                    ),
                ]
            )

        for index, drug in enumerate(
            self.config.antibiotics,
            start=1,
        ):
            available_count = self.db.execute(
                """
                SELECT count(*)
                FROM ast_long
                WHERE antibiotic_key = ?
                """,
                [drug],
            ).fetchone()[0]

            if available_count == 0:
                raise ValueError(
                    f"Antibiotic {drug!r} was not found. Use an "
                    "exact normalized label from "
                    "antibiotic_inventory.csv."
                )

            alias = f"d{index}"
            prefix = f"drug_{index}"

            joins.append(
                (
                    f"LEFT JOIN ast_long {alias} "
                    f"ON {self.join_condition('b', alias)} "
                    f"AND {alias}.antibiotic_key = "
                    f"{self.quote_literal(drug)}"
                )
            )

            result_expression = (
                f"{alias}.resolved_susceptibility"
            )

            binary_expression = self.binary_result_expression(
                result_expression
            )

            select_columns.extend(
                [
                    (
                        f"{result_expression} AS "
                        f"{prefix}__susceptibility"
                    ),
                    (
                        f"coalesce({alias}.result_conflict, false) "
                        f"AS {prefix}__conflict"
                    ),
                    (
                        f"{alias}.antibiotic_key IS NOT NULL "
                        f"AS {prefix}__has_drug_row"
                    ),
                    (
                        f"coalesce({alias}.source_row_count, 0) "
                        f"AS {prefix}__source_rows"
                    ),
                    (
                        f"{alias}.reported_values_json "
                        f"AS {prefix}__reported_values_json"
                    ),
                    (
                        f"{binary_expression} "
                        f"AS {prefix}__Y_star"
                    ),
                    (
                        f"CASE "
                        f"WHEN ({binary_expression}) IS NULL "
                        f"THEN 1 ELSE 0 END "
                        f"AS {prefix}__R"
                    ),
                    (
                        "CASE "
                        f"WHEN {alias}.antibiotic_key IS NULL "
                        "THEN 'no_drug_row' "
                        f"WHEN {alias}.result_conflict "
                        "THEN 'conflicting_results' "
                        f"WHEN {result_expression} IS NULL "
                        "THEN 'no_nonmissing_result' "
                        f"WHEN ({binary_expression}) IS NULL "
                        "THEN 'excluded_or_unrecognized_category' "
                        "ELSE 'observed_binary_result' "
                        f"END AS {prefix}__endpoint_status"
                    ),
                ]
            )

            self.drug_mapping.append(
                {
                    "prefix": prefix,
                    "antibiotic_key": drug,
                }
            )

        query = (
            "CREATE OR REPLACE TABLE episodes AS "
            f"SELECT {', '.join(select_columns)} "
            "FROM base b "
            + " ".join(joins)
        )

        self.db.execute(query)

        row_count, unique_count = self.db.execute(
            """
            SELECT
                count(*),
                count(DISTINCT episode_id)
            FROM episodes
            """
        ).fetchone()

        if (
            row_count != self.episode_count
            or unique_count != self.episode_count
        ):
            raise AssertionError(
                "Final episode cardinality changed or episode "
                "identifiers are not unique."
            )

    def export_master(self) -> None:
        LOGGER.info("Exporting unified E. coli episodes")

        ordered_query = (
            "SELECT * FROM episodes "
            "ORDER BY "
            "anon_id, order_time_jittered, order_proc_id_coded"
        )

        self.export_query(
            ordered_query,
            "ecoli_episodes.parquet",
        )

        if self.config.export_csv:
            self.export_query(
                ordered_query,
                "ecoli_episodes.csv",
                csv=True,
            )

    def export_episode_organism_inventory(self) -> None:
        keys = ", ".join(
            f"s.{self.quote_identifier(column)}"
            for column in self.KEY_COLUMNS
        )

        query = (
            f"SELECT {keys}, "
            "count(DISTINCT organism) "
            "AS distinct_organism_labels, "
            "to_json("
            "list(DISTINCT organism ORDER BY organism)"
            ") AS organism_labels_json "
            "FROM cohort s "
            "INNER JOIN base b "
            f"ON {self.join_condition('b', 's')} "
            f"GROUP BY {keys}"
        )

        self.export_query(
            query,
            "episode_organism_inventory.parquet",
        )

    
    def attach_missing_order_timestamp(
        self,
        name: str,
        raw_name: str,
        columns: list[str],
    ) -> str:
        """
        Attach the cohort timestamp to a side table that contains
        the three culture-order identifiers but lacks the timestamp.

        Stops if the cohort mapping is ambiguous or any source row
        cannot be matched. Does not modify the raw file.
        """

        id_columns = self.KEY_COLUMNS[:3]
        timestamp_column = self.KEY_COLUMNS[3]

        if name == "cohort":
            raise ValueError(
                "The cohort must contain order_time_jittered. "
                "Its timestamp cannot be reconstructed from itself."
            )

        missing_ids = set(id_columns) - set(columns)

        if missing_ids:
            raise ValueError(
                f"{name}: cannot attach a timestamp because these "
                f"identifier columns are missing: {sorted(missing_ids)}"
            )

        id_sql = ", ".join(
            self.quote_identifier(column)
            for column in id_columns
        )

        time_sql = self.quote_identifier(timestamp_column)

        self.db.execute(
            f"""
            CREATE OR REPLACE TABLE cohort_order_time_map AS
            SELECT DISTINCT
                {id_sql},
                {time_sql}
            FROM cohort
            """
        )

        ambiguity_query = f"""
            SELECT
                {id_sql},
                count(*) AS timestamp_count
            FROM cohort_order_time_map
            GROUP BY {id_sql}
            HAVING count(*) > 1
        """

        ambiguity_count = self.scalar(
            f"SELECT count(*) FROM ({ambiguity_query})"
        )

        if ambiguity_count:
            self.export_query(
                ambiguity_query,
                "cohort_order_time_ambiguities.csv",
                csv=True,
            )

            raise ValueError(
                "Cannot attach missing timestamps: "
                f"{ambiguity_count} cohort identifier triples "
                "map to multiple timestamps. Inspect "
                "cohort_order_time_ambiguities.csv."
            )

        join_sql = " AND ".join(
            (
                f"trim(s.{self.quote_identifier(column)}) = "
                f"k.{self.quote_identifier(column)}"
            )
            for column in id_columns
        )

        unmatched_query = (
            f"SELECT s.* "
            f"FROM {self.quote_identifier(raw_name)} s "
            f"ANTI JOIN cohort_order_time_map k "
            f"ON {join_sql}"
        )

        unmatched_count = self.scalar(
            f"SELECT count(*) FROM ({unmatched_query})"
        )

        if unmatched_count:
            self.export_query(
                unmatched_query,
                f"{name}_unmatched_timestamp_rows.parquet",
            )

            raise ValueError(
                f"{name}: {unmatched_count} rows cannot be matched "
                "to a unique cohort culture order. Inspect "
                f"{name}_unmatched_timestamp_rows.parquet. "
                "No rows have been silently discarded."
            )

        enriched_name = f"{raw_name}_with_order_time"

        self.db.execute(
            f"""
            CREATE OR REPLACE VIEW
                {self.quote_identifier(enriched_name)} AS
            SELECT
                s.*,
                k.{time_sql} AS {time_sql}
            FROM {self.quote_identifier(raw_name)} s
            INNER JOIN cohort_order_time_map k
                ON {join_sql}
            """
        )

        original_count = self.scalar(
            f"SELECT count(*) "
            f"FROM {self.quote_identifier(raw_name)}"
        )

        enriched_count = self.scalar(
            f"SELECT count(*) "
            f"FROM {self.quote_identifier(enriched_name)}"
        )

        if original_count != enriched_count:
            raise AssertionError(
                f"{name}: attaching the timestamp changed "
                f"the row count from {original_count} "
                f"to {enriched_count}."
            )

        self.audit.append(
            {
                "source": name,
                "status": "timestamp_attached_from_cohort",
                "matched_rows": original_count,
                "join_columns": list(id_columns),
                "attached_column": timestamp_column,
                "ambiguous_cohort_keys": 0,
                "unmatched_source_rows": 0,
            }
        )

        LOGGER.warning(
            "%s lacks %s; attached it from a verified "
            "one-to-one cohort identifier mapping for %s rows",
            name,
            timestamp_column,
            f"{original_count:,}",
        )

        return enriched_name
    
    
    def export_selected_drug_audits(self) -> None:
        for item in self.drug_mapping:
            prefix = item["prefix"]

            self.export_query(
                (
                    f"SELECT "
                    f"{prefix}__endpoint_status AS endpoint_status, "
                    "count(*) AS episode_count "
                    "FROM episodes "
                    f"GROUP BY {prefix}__endpoint_status "
                    "ORDER BY episode_count DESC"
                ),
                f"{prefix}_endpoint_audit.csv",
                csv=True,
            )

    def write_manifest(
        self,
        status: str,
        error: str | None = None,
    ) -> None:
        if not self.config.output_dir.exists():
            return

        manifest = {
            "status": status,
            "started_at_utc": self.started_at,
            "finished_at_utc": (
                datetime.now(timezone.utc).isoformat()
            ),
            "episode_unit": "culture_order",
            "episode_count": self.episode_count,
            "join_keys": list(self.KEY_COLUMNS),
            "input_dir": str(self.config.input_dir),
            "output_dir": str(self.config.output_dir),
            "ecoli_normalized_labels": list(
                self.ECOLI_NORMALIZED_LABELS
            ),
            "csv_reader": {
                "delimiter": ",",
                "quote": '"',
                "escape": '"',
                "strict_mode": True,
                "ignore_errors": False,
                "all_varchar": True,
                "null_strings": ["Null", "NULL", ""],
            },
            "sources": self.sources,
            "audit": self.audit,
            "selected_antibiotics": self.drug_mapping,
            "intermediate_policy": (
                self.config.intermediate_policy
            ),
            "missingness_convention": {
                "R_0": "configured binary endpoint observed",
                "R_1": "configured binary endpoint unavailable",
            },
            "duckdb_version": duckdb.__version__,
            "memory_limit": self.config.memory_limit,
            "threads": self.config.threads,
            "warnings": self.WARNINGS,
            "error": error,
        }

        filename = (
            "build_manifest.json"
            if status == "completed"
            else "build_failure_manifest.json"
        )

        destination = self.config.output_dir / filename

        destination.write_text(
            json.dumps(manifest, indent=2),
            encoding="utf-8",
        )

    def run(self) -> None:
        self.validate_configuration()

        try:
            self.open_database()
            self.register_sources()
            self.validate_timestamp_consistency()
            self.build_episode_backbone()
            self.build_ast_tables()
            self.aggregate_sources()
            self.build_master()
            self.export_master()
            self.export_episode_organism_inventory()
            self.export_selected_drug_audits()

            self.write_manifest(status="completed")

            stale_failure = (
                self.config.output_dir
                / "build_failure_manifest.json"
            )

            if stale_failure.exists():
                stale_failure.unlink()

            LOGGER.info(
                "Build completed: %s E. coli culture-order episodes",
                f"{self.episode_count:,}",
            )

            LOGGER.info(
                "Master output: %s",
                self.config.output_dir / "ecoli_episodes.parquet",
            )

        except Exception as exc:
            self.write_manifest(
                status="failed",
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

        finally:
            if self.connection is not None:
                self.connection.close()
                self.connection = None


def parse_arguments() -> BuildConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Integrate the 14 ARMD-ECUH release tables into an "
            "E. coli culture-order master with strict CSV parsing "
            "and auditable susceptibility handling."
        )
    )

    parser.add_argument(
        "--input",
        required=True,
        type=Path,
        help="Directory containing the release CSV files.",
    )

    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Separate directory for the database and exports.",
    )

    parser.add_argument(
        "--memory",
        default="4GB",
        help="DuckDB memory limit. Default: 4GB.",
    )

    parser.add_argument(
        "--threads",
        default=4,
        type=int,
        help="DuckDB worker threads. Default: 4.",
    )

    parser.add_argument(
        "--allow-missing-files",
        action="store_true",
        help=(
            "Allow absent side tables and record their absence. "
            "The cohort file remains mandatory."
        ),
    )

    parser.add_argument(
        "--csv",
        action="store_true",
        help="Also export the episode master as CSV.",
    )

    parser.add_argument(
        "--antibiotics",
        nargs="*",
        default=[],
        help=(
            "Exact drug labels from antibiotic_inventory.csv. "
            "Omit for the initial integration and inventory run."
        ),
    )

    parser.add_argument(
        "--intermediate",
        choices=[
            "exclude",
            "nonresistant",
            "resistant",
        ],
        default="exclude",
        help=(
            "Treatment of intermediate results in optional binary "
            "endpoints. Default: exclude."
        ),
    )

    args = parser.parse_args()

    return BuildConfig(
        input_dir=args.input,
        output_dir=args.output,
        memory_limit=args.memory,
        threads=args.threads,
        allow_missing_files=args.allow_missing_files,
        export_csv=args.csv,
        antibiotics=args.antibiotics,
        intermediate_policy=args.intermediate,
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    config = parse_arguments()
    builder = ARMDEcoliEpisodeBuilder(config)

    try:
        builder.run()
    except Exception:
        LOGGER.exception("Episode build failed")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())