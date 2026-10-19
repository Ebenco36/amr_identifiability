#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from build_armd_ecoli_episodes import (
    ARMDEcoliEpisodeBuilder,
    BuildConfig,
)


LOGGER = logging.getLogger("armd_preprocessing")


@dataclass
class PreprocessConfig(BuildConfig):
    exposure_days: int = 90
    relative_days: str = "unverified"
    include_culture_day: bool = False
    alias_file: Path | None = None
    upstream: tuple[str, ...] = ()
    downstream: str | None = None


class ARMDPreprocessor(ARMDEcoliEpisodeBuilder):
    """
    Extend the integration layer with traceable preprocessing.

    Does not certify isolate identity, absence of self-masking,
    historical observation completeness, or true calendar period.
    """

    EXPOSURE_FIELDS = {
        "abx_class": "time_to_culturetime",
        "abx_subtype": "medication_time_to_culturetime",
    }

    HISTORY_FIELDS = {
        "comorbidity": "comorbidity_component_start_days_culture",
        "organism_history": "prior_infecting_organism_days_to_culture",
        "nursing_visits": "nursing_home_visit_culture",
        "resistance_history": "resistant_time_to_culturetime",
    }

    def __init__(self, config: PreprocessConfig) -> None:
        super().__init__(config)
        self.config = config
        self.preprocessing = {
            "version": "1.0",
            "exposure_window_days": config.exposure_days,
            "relative_days_convention": config.relative_days,
            "include_culture_day": config.include_culture_day,
            "alias_file": (
                str(config.alias_file)
                if config.alias_file is not None
                else None
            ),
            "drug_mapping": [],
            "unresolved": [],
            "analysis_ready": False,
        }
        self.flat_tables: dict[str, str] = {}

    def validate_configuration(self) -> None:
        super().validate_configuration()

        if self.config.exposure_days != 90:
            raise ValueError(
                "This study specification requires a 90-day "
                "antibiotic-exposure window."
            )

        if self.config.alias_file is not None:
            self.config.alias_file = (
                self.config.alias_file.expanduser().resolve()
            )
            if not self.config.alias_file.is_file():
                raise FileNotFoundError(self.config.alias_file)

        if self.config.downstream is None and self.config.upstream:
            raise ValueError(
                "--upstream requires --downstream."
            )

        if self.config.downstream is not None:
            self.config.downstream = (
                self.config.downstream.strip().lower()
            )

        self.config.upstream = tuple(
            value.strip().lower()
            for value in self.config.upstream
        )

        if any(not value for value in self.config.upstream):
            raise ValueError("Empty upstream drug label.")

        if self.config.downstream == "":
            raise ValueError("Empty downstream drug label.")

    def columns_of(self, relation: str) -> set[str]:
        return {
            row[0]
            for row in self.db.execute(
                f"DESCRIBE {self.quote_identifier(relation)}"
            ).fetchall()
        }

    def save_table(
        self,
        name: str,
        query: str,
        filename: str | None = None,
    ) -> None:
        self.db.execute(
            f"CREATE OR REPLACE TABLE "
            f"{self.quote_identifier(name)} AS {query}"
        )
        self.export_query(
            f"SELECT * FROM {self.quote_identifier(name)}",
            filename or f"{name}.parquet",
        )

    def episode_keys(self, alias: str) -> str:
        return ", ".join(
            f"{alias}.{self.quote_identifier(column)}"
            for column in self.KEY_COLUMNS
        )

    def days_before_expression(self, expression: str) -> str:
        numeric = (
            f"try_cast(trim(cast({expression} AS VARCHAR)) "
            f"AS DOUBLE)"
        )

        if self.config.relative_days == "positive-before":
            return numeric

        if self.config.relative_days == "negative-before":
            return f"-({numeric})"

        return "CAST(NULL AS DOUBLE)"

    def window_expression(self, days_expression: str) -> str:
        lower = ">=" if self.config.include_culture_day else ">"

        return (
            f"({days_expression}) {lower} 0 "
            f"AND ({days_expression}) <= "
            f"{self.config.exposure_days}"
        )

    def aggregate_source(self, name: str) -> None:
        super().aggregate_source(name)

        # This export preserves all matching rows, not only DISTINCT
        # JSON records. Raw inputs remain unchanged.
        relation = f"source_rows_{name}"

        self.save_table(
            relation,
            (
                f"SELECT s.* "
                f"FROM {self.quote_identifier(name)} s "
                f"INNER JOIN base b "
                f"ON {self.join_condition('b', 's')}"
            ),
            f"{name}_source_rows.parquet",
        )

        self.flat_tables[name] = relation

        payload_columns = [
            column
            for column in self.sources[name]["columns"]
            if column not in self.KEY_COLUMNS
        ]

        if not payload_columns:
            return

        packed = ", ".join(
            (
                f"{self.quote_identifier(column)} := "
                f"{self.quote_identifier(column)}"
            )
            for column in payload_columns
        )

        self.save_table(
            f"multiplicity_{name}",
            (
                f"SELECT {self.key_sql}, "
                f"to_json(struct_pack({packed})) AS record_json, "
                f"count(*) AS repetition_count "
                f"FROM {self.quote_identifier(relation)} "
                f"GROUP BY {self.key_sql}, record_json"
            ),
            f"{name}_record_multiplicities.parquet",
        )

    def prepare_aliases(self) -> None:
        self.db.execute(
            """
            CREATE OR REPLACE TABLE drug_aliases (
                alias VARCHAR,
                canonical VARCHAR
            )
            """
        )

        if self.config.alias_file is None:
            return

        path = self.quote_literal(self.config.alias_file)

        self.db.execute(
            f"""
            CREATE OR REPLACE TABLE alias_input AS
            SELECT *
            FROM read_csv(
                {path},
                header=true,
                delim=',',
                quote='"',
                escape='"',
                strict_mode=true,
                ignore_errors=false,
                all_varchar=true
            )
            """
        )

        if not {"alias", "canonical"}.issubset(
            self.columns_of("alias_input")
        ):
            raise ValueError(
                "Alias CSV requires columns alias and canonical."
            )

        self.db.execute(
            """
            INSERT INTO drug_aliases
            SELECT
                lower(trim(alias)),
                lower(trim(canonical))
            FROM alias_input
            """
        )

        invalid = self.scalar(
            """
            SELECT count(*)
            FROM drug_aliases
            WHERE
                alias IS NULL OR alias=''
                OR canonical IS NULL OR canonical=''
            """
        )

        if invalid:
            raise ValueError("Alias map contains empty values.")

        ambiguous = self.scalar(
            """
            SELECT count(*)
            FROM (
                SELECT alias
                FROM drug_aliases
                GROUP BY alias
                HAVING count(DISTINCT canonical)>1
            )
            """
        )

        if ambiguous:
            raise ValueError(
                "An alias maps to multiple canonical drugs."
            )

        self.db.execute(
            """
            CREATE OR REPLACE TABLE drug_aliases AS
            SELECT DISTINCT alias, canonical
            FROM drug_aliases
            """
        )

        chained = self.scalar(
            """
            SELECT count(*)
            FROM drug_aliases a
            JOIN drug_aliases b ON a.canonical=b.alias
            WHERE b.canonical<>a.canonical
            """
        )

        if chained:
            raise ValueError(
                "Alias chains are not supported. Map every alias "
                "directly to its final canonical drug."
            )

        self.export_query(
            "SELECT * FROM drug_aliases ORDER BY alias",
            "applied_drug_aliases.csv",
            csv=True,
        )

    def canonical_drug(self, value: str) -> str:
        normalized = value.strip().lower()

        result = self.db.execute(
            "SELECT canonical FROM drug_aliases WHERE alias=?",
            [normalized],
        ).fetchone()

        return result[0] if result else normalized

    def build_harmonized_ast(self) -> None:
        self.save_table(
            "ast_harmonized_rows",
            """
            SELECT
                r.*,
                coalesce(a.canonical, r.__antibiotic_key)
                    AS canonical_antibiotic,
                CASE
                    WHEN r.__susceptibility_key IS NULL
                        OR r.__susceptibility_key=''
                        THEN 'missing'
                    WHEN r.__susceptibility_key IN (
                        'susceptible',
                        'intermediate',
                        'resistant',
                        'synergism',
                        'inconclusive'
                    )
                        THEN r.__susceptibility_key
                    ELSE 'unrecognized'
                END AS result_category
            FROM ec_ast_rows r
            LEFT JOIN drug_aliases a
                ON r.__antibiotic_key=a.alias
            """,
            "ast_harmonized_source_rows.parquet",
        )

        self.save_table(
            "ast_clean_long",
            f"""
            SELECT
                {self.key_sql},
                canonical_antibiotic,
                count(*) AS source_row_count,
                count(DISTINCT __antibiotic_key)
                    AS original_label_count,
                to_json(
                    list(DISTINCT __antibiotic_key
                         ORDER BY __antibiotic_key)
                ) AS original_labels_json,
                count(DISTINCT __susceptibility_key)
                    FILTER (
                        WHERE __susceptibility_key IS NOT NULL
                        AND __susceptibility_key<>''
                    ) AS nonmissing_category_count,
                CASE
                    WHEN count(DISTINCT __susceptibility_key)
                        FILTER (
                            WHERE __susceptibility_key IS NOT NULL
                            AND __susceptibility_key<>''
                        ) = 1
                    THEN min(__susceptibility_key)
                        FILTER (
                            WHERE __susceptibility_key IS NOT NULL
                            AND __susceptibility_key<>''
                        )
                END AS resolved_category,
                count(DISTINCT __susceptibility_key)
                    FILTER (
                        WHERE __susceptibility_key IS NOT NULL
                        AND __susceptibility_key<>''
                    ) > 1 AS result_conflict
            FROM ast_harmonized_rows
            WHERE
                canonical_antibiotic IS NOT NULL
                AND canonical_antibiotic<>''
            GROUP BY {self.key_sql}, canonical_antibiotic
            """,
        )

        self.export_query(
            "SELECT * FROM ast_clean_long WHERE result_conflict",
            "ast_harmonized_conflicts.parquet",
        )

        self.export_query(
            """
            SELECT
                canonical_antibiotic,
                count(*) AS episodes_with_drug_row,
                sum(CASE
                    WHEN resolved_category IS NOT NULL
                    THEN 1 ELSE 0 END
                ) AS episodes_with_resolved_category,
                sum(CASE
                    WHEN result_conflict
                    THEN 1 ELSE 0 END
                ) AS conflicting_episodes
            FROM ast_clean_long
            GROUP BY canonical_antibiotic
            ORDER BY episodes_with_drug_row DESC
            """,
            "canonical_antibiotic_inventory.csv",
            csv=True,
        )

    def build_timing_audit(self) -> None:
        rows = []

        for source, relation in self.flat_tables.items():
            for column in sorted(self.columns_of(relation)):
                lower = column.lower()

                is_timing = (
                    "days" in lower
                    or "time_to" in lower
                    or lower == "period_day"
                    or column == "nursing_home_visit_culture"
                )

                if not is_timing:
                    continue

                quoted = self.quote_identifier(column)
                numeric = (
                    f"try_cast(trim(cast({quoted} AS VARCHAR)) "
                    f"AS DOUBLE)"
                )

                result = self.db.execute(
                    f"""
                    SELECT
                        count(*) AS source_rows,
                        count({quoted}) AS nonnull_values,
                        count({numeric}) AS numeric_values,
                        min({numeric}) AS minimum,
                        max({numeric}) AS maximum,
                        count(*) FILTER (
                            WHERE ({numeric})<0
                        ) AS negative_values,
                        count(*) FILTER (
                            WHERE ({numeric})=0
                        ) AS zero_values,
                        count(*) FILTER (
                            WHERE ({numeric})>0
                            AND ({numeric})<=90
                        ) AS positive_1_to_90_values
                    FROM {self.quote_identifier(relation)}
                    """
                ).fetchone()

                rows.append(
                    {
                        "source": source,
                        "field": column,
                        "source_rows": result[0],
                        "nonnull_values": result[1],
                        "numeric_values": result[2],
                        "minimum": result[3],
                        "maximum": result[4],
                        "negative_values": result[5],
                        "zero_values": result[6],
                        "positive_1_to_90_values": result[7],
                    }
                )

        (self.config.output_dir / "timing_audit.json").write_text(
            json.dumps(rows, indent=2),
            encoding="utf-8",
        )

    def build_exposure_profile(self) -> None:
        parts = []

        for source, timing_field in self.EXPOSURE_FIELDS.items():
            if source not in self.flat_tables:
                continue

            relation = self.flat_tables[source]
            columns = self.columns_of(relation)

            required = {
                "medication_name",
                "medication_category",
                timing_field,
            }

            if not required.issubset(columns):
                self.preprocessing["unresolved"].append(
                    f"{source}: required exposure fields missing."
                )
                continue

            timing = self.quote_identifier(timing_field)

            parts.append(
                f"""
                SELECT
                    {self.key_sql},
                    {self.quote_literal(source)} AS exposure_source,
                    medication_name AS medication_name_original,
                    lower(trim(medication_name)) AS medication_key,
                    medication_category,
                    cast({timing} AS VARCHAR) AS relative_days_raw,
                    try_cast(
                        trim(cast({timing} AS VARCHAR))
                        AS DOUBLE
                    ) AS relative_days_numeric
                FROM {self.quote_identifier(relation)}
                WHERE medication_name IS NOT NULL
                """
            )

        if not parts:
            self.preprocessing["unresolved"].append(
                "No exposure sources could be constructed."
            )
            self.db.execute(
                """
                CREATE OR REPLACE TABLE exposure_features AS
                SELECT
                    episode_id,
                    CAST(NULL AS BOOLEAN) AS A90_recorded_any,
                    CAST(NULL AS BIGINT)
                        AS A90_distinct_drug_day_patterns
                FROM episodes
                """
            )
            return

        self.db.execute(
            "CREATE OR REPLACE TABLE exposure_rows AS "
            + " UNION ALL ".join(parts)
        )

        days = self.days_before_expression(
            "r.relative_days_numeric"
        )
        window = self.window_expression(days)

        if self.config.relative_days == "unverified":
            window_label = (
                "'unverified_relative_days_convention'"
            )
        else:
            window_label = f"""
                CASE
                    WHEN r.relative_days_numeric IS NULL
                        THEN 'missing_or_invalid_timing'
                    WHEN ({days})=0
                        THEN 'culture_day'
                    WHEN ({days})<0
                        THEN 'after_culture'
                    WHEN ({window})
                        THEN 'within_90_days'
                    ELSE 'before_90_day_window'
                END
            """

        self.save_table(
            "exposure_timed_rows",
            f"""
            SELECT
                r.*,
                coalesce(a.canonical, r.medication_key)
                    AS canonical_medication,
                {days} AS days_before_culture,
                {window_label} AS temporal_group,
                CASE
                    WHEN {self.quote_literal(
                        self.config.relative_days
                    )}='unverified'
                        THEN NULL
                    ELSE ({window})
                END AS qualifies_90_days
            FROM exposure_rows r
            LEFT JOIN drug_aliases a
                ON r.medication_key=a.alias
            """,
        )

        # This reconciles duplicate representations across class and
        # subtype tables. It counts drug/day patterns, not administrations.
        self.save_table(
            "exposure_reconciled",
            f"""
            SELECT
                {self.key_sql},
                canonical_medication,
                days_before_culture,
                relative_days_numeric,
                to_json(
                    list(DISTINCT exposure_source
                         ORDER BY exposure_source)
                ) AS source_tables_json,
                to_json(
                    list(DISTINCT medication_category
                         ORDER BY medication_category)
                ) AS medication_categories_json,
                count(*) AS represented_source_rows,
                bool_or(qualifies_90_days) AS qualifies_90_days
            FROM exposure_timed_rows
            GROUP BY
                {self.key_sql},
                canonical_medication,
                days_before_culture,
                relative_days_numeric
            """,
        )

        self.save_table(
            "exposure_by_order",
            f"""
            SELECT
                {self.key_sql},
                count(*) AS reconciled_drug_day_patterns,
                count(*) FILTER (
                    WHERE qualifies_90_days=true
                ) AS qualifying_90_day_patterns,
                count(*) FILTER (
                    WHERE relative_days_numeric IS NULL
                ) AS missing_timing_patterns
            FROM exposure_reconciled
            GROUP BY {self.key_sql}
            """,
        )

        verified = self.config.relative_days != "unverified"
        complete_sources = (
            len(parts) == len(self.EXPOSURE_FIELDS)
        )
        can_classify = verified and complete_sources

        if can_classify:
            any_expression = """
                CASE
                    WHEN coalesce(x.qualifying_90_day_patterns,0)>0
                        THEN true
                    WHEN coalesce(x.missing_timing_patterns,0)>0
                        THEN NULL
                    ELSE false
                END
            """
            count_expression = (
                "coalesce(x.qualifying_90_day_patterns,0)"
            )
        else:
            any_expression = "CAST(NULL AS BOOLEAN)"
            count_expression = "CAST(NULL AS BIGINT)"

        self.save_table(
            "exposure_features",
            f"""
            SELECT
                e.episode_id,
                {any_expression} AS A90_recorded_any,
                {count_expression}
                    AS A90_distinct_drug_day_patterns,
                coalesce(x.missing_timing_patterns,0)
                    AS A90_missing_timing_patterns,
                coalesce(x.reconciled_drug_day_patterns,0)
                    AS exposure_recorded_patterns_all_time,
                {self.quote_literal(
                    "recorded_exposure_not_complete_treatment_history"
                )} AS A90_interpretation
            FROM episodes e
            LEFT JOIN exposure_by_order x
                ON {self.join_condition('e', 'x')}
            """,
        )

        if not verified:
            self.preprocessing["unresolved"].append(
                "90-day exposure not classified: relative-day "
                "convention is unverified."
            )

        if not complete_sources:
            self.preprocessing["unresolved"].append(
                "90-day exposure classification requires both "
                "class and subtype exposure sources."
            )

    def classify_histories(self) -> None:
        for source, timing_field in self.HISTORY_FIELDS.items():
            if source not in self.flat_tables:
                continue

            relation = self.flat_tables[source]
            columns = self.columns_of(relation)

            if timing_field not in columns:
                self.preprocessing["unresolved"].append(
                    f"{source}: baseline timing field not found."
                )
                continue

            quoted = self.quote_identifier(timing_field)
            days = self.days_before_expression(quoted)

            if self.config.relative_days == "unverified":
                label = "'unverified_relative_days_convention'"
            else:
                label = f"""
                    CASE
                        WHEN ({days}) IS NULL
                            THEN 'missing_or_invalid_timing'
                        WHEN ({days})<0
                            THEN 'after_culture'
                        WHEN ({days})=0
                            THEN 'culture_day'
                        WHEN ({days})<=90
                            THEN 'within_exposure_window'
                        ELSE 'before_exposure_window'
                    END
                """

            self.save_table(
                f"{source}_temporal_records",
                f"""
                SELECT
                    *,
                    {days} AS derived_days_before_culture,
                    {label} AS derived_temporal_group
                FROM {self.quote_identifier(relation)}
                """,
            )

        self.preprocessing["unresolved"].append(
            "Historical timing groups do not establish active "
            "comorbidity at baseline; end-date interpretation "
            "and historical lookback remain unresolved."
        )

    def scalar_feature(
        self,
        source: str,
        field: str,
        output_name: str,
        filter_sql: str | None = None,
    ) -> None:
        table = f"feature_{output_name}"

        if (
            source not in self.flat_tables
            or field not in self.columns_of(
                self.flat_tables[source]
            )
        ):
            self.db.execute(
                f"""
                CREATE OR REPLACE TABLE
                    {self.quote_identifier(table)} AS
                SELECT
                    episode_id,
                    CAST(NULL AS VARCHAR)
                        AS {self.quote_identifier(output_name)},
                    CAST(NULL AS BOOLEAN)
                        AS {self.quote_identifier(
                            output_name + "__conflict"
                        )}
                FROM episodes
                """
            )
            self.preprocessing["unresolved"].append(
                f"{output_name}: source or field unavailable."
            )
            return

        relation = self.flat_tables[source]
        value = (
            f"nullif(trim(cast("
            f"{self.quote_identifier(field)} AS VARCHAR)), '')"
        )
        where = f"WHERE {filter_sql}" if filter_sql else ""

        self.db.execute(
            f"""
            CREATE OR REPLACE TABLE
                {self.quote_identifier(table + "_values")} AS
            SELECT
                {self.key_sql},
                CASE
                    WHEN count(DISTINCT {value})=1
                    THEN min({value})
                END AS value,
                count(DISTINCT {value})>1 AS conflict
            FROM {self.quote_identifier(relation)}
            {where}
            GROUP BY {self.key_sql}
            """
        )

        self.db.execute(
            f"""
            CREATE OR REPLACE TABLE
                {self.quote_identifier(table)} AS
            SELECT
                e.episode_id,
                v.value AS {self.quote_identifier(output_name)},
                coalesce(v.conflict,false)
                    AS {self.quote_identifier(
                        output_name + "__conflict"
                    )}
            FROM episodes e
            LEFT JOIN
                {self.quote_identifier(table + "_values")} v
                ON {self.join_condition('e', 'v')}
            """
        )

    def build_scalar_features(self) -> list[str]:
        specifications = [
            ("demographics", "age", "G_star", None),
            ("demographics", "gender", "B_star", None),
            ("adi", "adi_score", "D_national_recorded", None),
            ("adi", "adi_state_rank", "D_state_recorded", None),
            (
                "cohort",
                "culture_description",
                "S",
                self.ecoli_condition,
            ),
            ("ward", "hosp_ward_IP", "W_IP", None),
            ("ward", "hosp_ward_OP", "W_OP", None),
            ("ward", "hosp_ward_ER", "W_ER", None),
            ("ward", "hosp_ward_ICU", "W_ICU", None),
        ]

        names = []

        for source, field, output_name, condition in specifications:
            self.scalar_feature(
                source,
                field,
                output_name,
                condition,
            )
            names.append(output_name)

        return names

    def build_drug_matrix(self) -> None:
        available = [
            row[0]
            for row in self.db.execute(
                """
                SELECT DISTINCT canonical_antibiotic
                FROM ast_clean_long
                ORDER BY canonical_antibiotic
                """
            ).fetchall()
        ]

        requested = []

        if self.config.downstream is not None:
            requested = [
                *self.config.upstream,
                self.config.downstream,
            ]
        elif self.config.antibiotics:
            requested = list(self.config.antibiotics)

        drugs = (
            [self.canonical_drug(value) for value in requested]
            if requested
            else available
        )

        if len(drugs) != len(set(drugs)):
            raise ValueError(
                "Selected drugs become duplicates after harmonization."
            )

        unknown = set(drugs) - set(available)

        if unknown:
            raise ValueError(
                f"Unknown canonical drugs: {sorted(unknown)}"
            )

        selections = ["e.episode_id"]
        joins = []

        for index, drug in enumerate(drugs, start=1):
            alias = f"d{index}"
            prefix = f"ast_{index:03d}"

            joins.append(
                f"LEFT JOIN ast_clean_long {alias} "
                f"ON {self.join_condition('e', alias)} "
                f"AND {alias}.canonical_antibiotic="
                f"{self.quote_literal(drug)}"
            )

            category = f"{alias}.resolved_category"
            binary = self.binary_result_expression(category)

            status = f"""
                CASE
                    WHEN {alias}.canonical_antibiotic IS NULL
                        THEN 'no_drug_row'
                    WHEN {alias}.result_conflict
                        THEN 'conflicting_results'
                    WHEN {category} IS NULL
                        THEN 'no_nonmissing_result'
                    WHEN {category} IN (
                        'susceptible','intermediate','resistant'
                    )
                        THEN 'resolved_SIR'
                    WHEN {category} IN (
                        'synergism','inconclusive'
                    )
                        THEN 'other_reported_category'
                    ELSE 'unrecognized_category'
                END
            """

            selections.extend(
                [
                    f"{category} AS {prefix}__category_star",
                    f"{binary} AS {prefix}__Y_star",
                    (
                        f"CASE WHEN {category} IN "
                        "('susceptible','intermediate','resistant') "
                        f"THEN 0 ELSE 1 END AS {prefix}__R_SIR"
                    ),
                    (
                        f"CASE WHEN ({binary}) IS NULL "
                        f"THEN 1 ELSE 0 END AS {prefix}__R_binary"
                    ),
                    (
                        f"{alias}.canonical_antibiotic IS NOT NULL "
                        f"AS {prefix}__has_drug_row"
                    ),
                    (
                        f"coalesce({alias}.result_conflict,false) "
                        f"AS {prefix}__conflict"
                    ),
                    f"{status} AS {prefix}__status",
                ]
            )

            role = "unassigned"

            if self.config.downstream is not None:
                role = (
                    "downstream"
                    if index == len(drugs)
                    else "upstream"
                )

            self.preprocessing["drug_mapping"].append(
                {
                    "prefix": prefix,
                    "canonical_antibiotic": drug,
                    "role": role,
                }
            )

        self.save_table(
            "ast_episode_matrix",
            "SELECT "
            + ", ".join(selections)
            + " FROM episodes e "
            + " ".join(joins),
        )

    def build_analysis_candidate(self, names: list[str]) -> None:
        selections = ["e.*", "a.* EXCLUDE (episode_id)"]
        joins = [
            "LEFT JOIN ast_episode_matrix a USING (episode_id)"
        ]

        joins.append(
            "LEFT JOIN exposure_features x USING (episode_id)"
        )
        selections.append("x.* EXCLUDE (episode_id)")

        for index, name in enumerate(names):
            alias = f"f{index}"
            table = self.quote_identifier(f"feature_{name}")

            joins.append(
                f"LEFT JOIN {table} {alias} USING (episode_id)"
            )
            selections.append(
                f"{alias}.* EXCLUDE (episode_id)"
            )

        selections.extend(
            [
                (
                    "CASE WHEN f0.G_star IS NULL "
                    "THEN 1 ELSE 0 END AS R_G"
                ),
                (
                    "CASE WHEN f1.B_star IS NULL "
                    "THEN 1 ELSE 0 END AS R_B"
                ),
                "recorded_jittered_year AS T_star_year",
                "'not_validated' AS T_measurement_status",
                "false AS analysis_ready",
            ]
        )

        self.save_table(
            "analysis_candidate",
            "SELECT "
            + ", ".join(selections)
            + " FROM episodes e "
            + " ".join(joins),
            "ecoli_analysis_candidate.parquet",
        )

        count, unique = self.db.execute(
            """
            SELECT count(*),count(DISTINCT episode_id)
            FROM analysis_candidate
            """
        ).fetchone()

        if (count, unique) != (
            self.episode_count,
            self.episode_count,
        ):
            raise AssertionError(
                "Analytical candidate has invalid episode cardinality."
            )

        self.export_query(
            """
            SELECT
                S,
                W_IP,
                W_OP,
                W_ER,
                W_ICU,
                T_star_year,
                count(*) AS episodes
            FROM analysis_candidate
            GROUP BY
                S,W_IP,W_OP,W_ER,W_ICU,T_star_year
            ORDER BY episodes DESC
            """,
            "context_coverage.csv",
            csv=True,
        )

    def export_patterns(self) -> None:
        mapping = self.preprocessing["drug_mapping"]

        if not mapping:
            return

        for definition in ("R_SIR", "R_binary"):
            expressions = [
                f"cast({item['prefix']}__{definition} AS VARCHAR)"
                for item in mapping
            ]

            expression = (
                "concat(" + ", ".join(expressions) + ")"
            )

            self.export_query(
                f"""
                SELECT
                    {expression} AS missingness_pattern,
                    count(*) AS episodes
                FROM ast_episode_matrix
                GROUP BY missingness_pattern
                ORDER BY episodes DESC
                """,
                f"ast_patterns_{definition}.csv",
                csv=True,
            )

        if self.config.downstream is None:
            return

        upstream = [
            item for item in mapping
            if item["role"] == "upstream"
        ]
        downstream = next(
            item for item in mapping
            if item["role"] == "downstream"
        )

        fields = [
            "S", "W_IP", "W_OP", "W_ER", "W_ICU", "T_star_year"
        ]

        for item in upstream:
            fields.extend(
                [
                    f"{item['prefix']}__category_star",
                    f"{item['prefix']}__R_binary",
                ]
            )

        fields.append(
            f"{downstream['prefix']}__R_binary"
        )

        group = ", ".join(fields)

        self.export_query(
            f"""
            SELECT {group}, count(*) AS episodes
            FROM analysis_candidate
            GROUP BY {group}
            ORDER BY episodes DESC
            """,
            "selected_drug_support_audit.csv",
            csv=True,
        )

    def preprocess(self) -> None:
        LOGGER.info("Starting analytical preprocessing")

        self.prepare_aliases()
        self.build_harmonized_ast()
        self.build_timing_audit()
        self.build_exposure_profile()
        self.classify_histories()

        names = self.build_scalar_features()

        self.build_drug_matrix()
        self.build_analysis_candidate(names)
        self.export_patterns()

        self.preprocessing["unresolved"].extend(
            [
                "Culture order is not a verified unique isolate.",
                "No additional clinical repeat-isolate rule applied.",
                "Actual cascade-trigger mechanism requires verification.",
                "No-self-masking is not validated by preprocessing.",
                "T_star_year is not validated true calendar period T.",
                "Labs/vitals retained but not classified as baseline.",
                "No recorded history is not confirmed absence of history.",
                "Resistance outcome and intermediate handling require "
                "a finalized study definition.",
                "Binary endpoint exclusions must not automatically be "
                "interpreted as laboratory result suppression.",
            ]
        )

        self.preprocessing["unresolved"] = sorted(
            set(self.preprocessing["unresolved"])
        )

        self.preprocessing["finished_at_utc"] = (
            datetime.now(timezone.utc).isoformat()
        )

        (self.config.output_dir / "preprocessing_report.json").write_text(
            json.dumps(self.preprocessing, indent=2),
            encoding="utf-8",
        )

        LOGGER.info(
            "Preprocessing completed; analysis-ready status remains "
            "false pending scientific validation."
        )

    def export_selected_drug_audits(self) -> None:
        # The base run invokes this after its master exports and before
        # writing the completed build manifest.
        super().export_selected_drug_audits()
        self.preprocess()

    def write_manifest(
        self,
        status: str,
        error: str | None = None,
    ) -> None:
        super().write_manifest(status, error)

        filename = (
            "build_manifest.json"
            if status == "completed"
            else "build_failure_manifest.json"
        )

        path = self.config.output_dir / filename

        if path.exists():
            manifest = json.loads(path.read_text(encoding="utf-8"))
            manifest["preprocessing"] = self.preprocessing
            path.write_text(
                json.dumps(manifest, indent=2),
                encoding="utf-8",
            )


def parse_arguments() -> PreprocessConfig:
    parser = argparse.ArgumentParser(
        description=(
            "ARMD-ECUH integration plus auditable preprocessing. "
            "Requires build_armd_ecoli_episodes.py beside this file."
        )
    )

    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--memory", default="4GB")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--allow-missing-files", action="store_true")
    parser.add_argument("--csv", action="store_true")
    parser.add_argument("--antibiotics", nargs="*", default=[])

    parser.add_argument(
        "--intermediate",
        choices=["exclude", "nonresistant", "resistant"],
        default="exclude",
    )

    parser.add_argument(
        "--relative-days",
        choices=[
            "unverified",
            "positive-before",
            "negative-before",
        ],
        default="unverified",
    )

    parser.add_argument(
        "--include-culture-day",
        action="store_true",
        help=(
            "Include day 0 in recorded antibiotic exposure. "
            "Use only after resolving within-day timing."
        ),
    )

    parser.add_argument("--aliases", type=Path)
    parser.add_argument("--upstream", nargs="*", default=[])
    parser.add_argument("--downstream")

    args = parser.parse_args()

    return PreprocessConfig(
        input_dir=args.input,
        output_dir=args.output,
        memory_limit=args.memory,
        threads=args.threads,
        allow_missing_files=args.allow_missing_files,
        export_csv=args.csv,
        antibiotics=args.antibiotics,
        intermediate_policy=args.intermediate,
        relative_days=args.relative_days,
        include_culture_day=args.include_culture_day,
        alias_file=args.aliases,
        upstream=tuple(args.upstream),
        downstream=args.downstream,
        exposure_days=90,
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    try:
        ARMDPreprocessor(parse_arguments()).run()
    except Exception:
        LOGGER.exception("Integration/preprocessing failed")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())