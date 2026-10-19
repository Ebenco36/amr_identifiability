
#!/usr/bin/env python3
"""Deterministic ECUH-shaped SYNTHETIC fixture. Not a validated ECUH data-generating model."""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import platform
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
import numpy as np

FILES = {
    'cohort':'00_microbiology_cultures_cohort.csv',
    'adi':'01_microbiology_cultures_adi_scores.csv',
    'abx_class':'02_microbiology_cultures_antibiotic_class_exposure.csv',
    'abx_subtype':'03_microbiology_cultures_antibiotic_subtype_exposure.csv',
    'comorbidity':'04_microbiology_cultures_comorbidity.csv',
    'demographics':'05_microbiology_cultures_demographics.csv',
    'labs':'06_microbiology_cultures_labs.csv',
    'resistance_history':'07_microbiology_cultures_microbial_resistance.csv',
    'nursing_visits':'08_microbiology_cultures_nursing_home_visits.csv',
    'organism_history':'09_microbiology_cultures_prior_infecting_organism.csv',
    'prior_med':'010_microbiology_cultures_prior_med.csv',
    'procedures':'011_microbiology_cultures_prior_procedures.csv',
    'ward':'012_microbiology_cultures_ward_info.csv',
    'vitals':'013_microbiology_cultures_vitals.csv',
}

KEYS=('anon_id','pat_enc_csn_id_coded','order_proc_id_coded','order_time_jittered')

FIELDS={
    'cohort':('organism','antibiotic','susceptibility','culture_description'),
    'adi':('adi_score','adi_state_rank'),
    'abx_class':('medication_name','medication_category','time_to_culturetime'),
    'abx_subtype':('medication_name','medication_category','medication_time_to_culturetime'),
    'comorbidity':('comorbidity_component_start_days_culture',),
    'demographics':('age','gender'),
    'ward':('hosp_ward_IP','hosp_ward_OP','hosp_ward_ER','hosp_ward_ICU'),
    'nursing_visits':('nursing_home_visit_culture',),
    'organism_history':('prior_infecting_organism_days_to_culture',),
}

DRUGS=('ampicillin','ceftriaxone','ciprofloxacin','trimeth-sulfamethoxazole','meropenem')
VERSION='3.0.0'

def expit(v):
    return float(1/(1+np.exp(-np.clip(v,-30,30))))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def schemas(template):
    out={}
    for source,filename in FILES.items():
        if template is None:
            columns=list(KEYS)+list(FIELDS.get(source,()))
        else:
            path=template/filename
            if not path.is_file():
                raise FileNotFoundError(path)
            with path.open(encoding='utf-8-sig',newline='') as fh:
                columns=next(csv.reader(fh),[])
        if not columns or len(columns)!=len(set(columns)) or any(not c.strip() for c in columns):
            raise ValueError(f'Invalid source header: {filename}')
        required=set(KEYS if source=='cohort' else KEYS[:3]) | set(FIELDS.get(source,()))
        if missing:=required-set(columns):
            raise ValueError(f'{filename}: missing required fields {sorted(missing)}')
        out[source]=columns
    return out

def row_for(columns, keys, **values):
    row={c:'' for c in columns}
    for k,v in {**keys,**values}.items():
        if k not in row:
            if k in KEYS and k=='order_time_jittered':
                continue
            raise ValueError(f'Generated field absent from template: {k}')
        row[k]='' if v is None else str(v)
    return row

def write(path,columns,rows):
    with path.open('w',newline='',encoding='utf-8') as f:
        w=csv.DictWriter(f,fieldnames=columns,extrasaction='raise')
        w.writeheader()
        w.writerows(rows)
    return sha(path)

def build(args):
    template=args.template_dir.resolve() if args.template_dir else None
    output=args.output.resolve()
    truth_file=output.parent/(output.name+'_truth.csv')

    if template and (
        output==template
        or template in output.parents
        or truth_file==template
        or template in truth_file.parents
    ):
        raise ValueError('Outputs must be outside original ECUH template directory')

    if output.exists():
        raise FileExistsError(f'Output directory exists: {output}')

    if truth_file.exists():
        raise FileExistsError(f'Truth file exists: {truth_file}')

    headers=schemas(template)
    rng=np.random.default_rng(args.seed)

    data={name:[] for name in FILES}
    truth=[]

    n_patients=(args.n+args.orders_per_patient-1)//args.orders_per_patient
    patients=[]

    # --------------------------------------------------
    # 1. Patient-level generation
    # --------------------------------------------------

    for p in range(n_patients):
        patients.append(
            dict(
                id=f'SYN_PAT_{p:08d}',
                age0=int(rng.integers(18,85)),
                gender=str(rng.choice(['Female','Male'])),
                clinical=int(rng.binomial(1,.3)),
                frailty=float(rng.normal()),
                adi=float(rng.uniform(0,100)),
                jitter=int(rng.integers(-10,11)),
            )
        )

    base=datetime(2020,1,1,9)

    # --------------------------------------------------
    # 2. Culture-order generation
    # --------------------------------------------------

    for i in range(args.n):

        p=patients[i//args.orders_per_patient]
        visit=i%args.orders_per_patient

        true_date=base+timedelta(
            days=(
                (i//args.orders_per_patient)%330
                +180*visit
                +730*((i//args.orders_per_patient)%2)
            )
        )

        jittered_date=true_date+timedelta(days=p['jitter'])
        age=p['age0']+(true_date.year-2020)
        period=int(true_date.year>=2022)

        keys=dict(
            zip(
                KEYS,
                [
                    p['id'],
                    f'SYN_ENC_{i:09d}',
                    f'SYN_ORDER_{i:09d}',
                    jittered_date.strftime('%Y-%m-%d %H:%M:%S'),
                ],
            )
        )

        specimen=str(
            rng.choice(
                ['Urine','Blood','Respiratory','Other'],
                p=[.65,.17,.12,.06],
            )
        )

        ward=str(
            rng.choice(
                ['IP','OP','ER','ICU'],
                p=[.27,.42,.21,.10],
            )
        )

        clinical=p['clinical']

        # --------------------------------------------------
        # 3. Observed clinical proxy and exposure
        # --------------------------------------------------

        comorbidity=int(
            rng.binomial(
                1,
                expit(-1+.9*clinical+.015*(age-50)),
            )
        )

        exposure=int(
            rng.binomial(
                1,
                expit(-1.4+.45*clinical+.012*(age-50)),
            )
        )

        # --------------------------------------------------
        # 4. Shared resistance-related factor
        # --------------------------------------------------

        resistance_factor=(
            p['frailty']
            +float(rng.normal(0,.65))
            +.35*exposure
            +.35*clinical
        )

        base_logits=np.array([-1.1,-1.5,-1.2,-.9,-2.3])

        resist=rng.binomial(
            1,
            [
                expit(float(x))
                for x in base_logits
                +.65*resistance_factor
                +.2*exposure
            ],
        ).astype(int)

        # --------------------------------------------------
        # 5. Complete susceptibility interpretations
        # --------------------------------------------------

        sir=[
            'Resistant'
            if y
            else (
                'Intermediate'
                if rng.random()<args.intermediate_probability
                else 'Susceptible'
            )
            for y in resist
        ]

        # --------------------------------------------------
        # 6. Laboratory panel assignment
        # --------------------------------------------------

        panel_p=expit(
            1.1
            -.45*period
            -.3*(ward=='OP')
            +.25*(specimen=='Blood')
            +(
                1.05*clinical
                if args.scenario=='clinical_selection'
                else 0
            )
        )

        panel=int(rng.binomial(1,panel_p))

        # --------------------------------------------------
        # 7. Laboratory testing
        # --------------------------------------------------

        tested=[]
        reported=[]
        transferred=[]

        for j in range(len(DRUGS)):
            test_p=expit(
                (1.35 if panel else -.2)
                -(.9 if j==4 else 0)
            )
            tested.append(int(rng.binomial(1,test_p)))

        # --------------------------------------------------
        # 8. Upstream cascade information
        # --------------------------------------------------

        if args.trigger=='internal':
            trigger=int(
                any(
                    tested[j] and resist[j]
                    for j in range(4)
                )
            )
        else:
            trigger=0

        # --------------------------------------------------
        # 9. Upstream reporting and extraction
        # --------------------------------------------------

        for j in range(4):

            release=int(
                tested[j]
                and rng.binomial(
                    1,
                    expit(2.6-.30*period),
                )
            )

            transfer=int(
                release
                and rng.binomial(
                    1,
                    expit(3.2-.25*period),
                )
            )

            reported.append(release)
            transferred.append(transfer)

        if args.trigger=='reported':
            trigger=int(
                any(
                    transferred[j] and resist[j]
                    for j in range(4)
                )
            )

        # --------------------------------------------------
        # 10. Downstream reporting and extraction
        # --------------------------------------------------

        down_release_p=expit(
            -1.0
            +1.6*trigger
            +.3*panel
            +.25*period
            +(
                1.35*resist[4]
                if args.scenario=='self_masking'
                else 0
            )
        )

        down_release=int(
            tested[4]
            and rng.binomial(1,down_release_p)
        )

        down_transfer=int(
            down_release
            and rng.binomial(
                1,
                expit(3.2-.25*period),
            )
        )

        reported.append(down_release)
        transferred.append(down_transfer)

        # R=0 observed, R=1 missing.
        missing=[int(not t) for t in transferred]

        # --------------------------------------------------
        # 11. Complete ground truth
        # --------------------------------------------------

        trow={
            **keys,
            'episode_index':i,
            'true_culture_time':true_date.isoformat(sep=' '),
            'jitter_days':p['jitter'],
            'true_period':period,
            'specimen':specimen,
            'ward':ward,
            'age':age,
            'gender':p['gender'],
            'latent_clinical':clinical,
            'recorded_comorbidity':comorbidity,
            'A90_true':exposure,
            'latent_resistance':resistance_factor,
            'latent_panel':panel,
            'cascade_trigger':trigger,
            'scenario':args.scenario,
        }

        # --------------------------------------------------
        # 12. Surveillance AST records
        # --------------------------------------------------

        for j,drug in enumerate(DRUGS):

            trow.update({
                f'Y_{drug}':int(resist[j]),
                f'SIR_{drug}':sir[j],
                f'tested_{drug}':tested[j],
                f'reported_{drug}':reported[j],
                f'transferred_{drug}':transferred[j],
                f'R_SIR_{drug}':missing[j],
                f'R_binary_{drug}':int(
                    missing[j] or sir[j]=='Intermediate'
                ),
            })

            if missing[j] and args.missing_rows=='omit':
                continue

            data['cohort'].append(
                row_for(
                    headers['cohort'],
                    keys,
                    organism='Escherichia coli',
                    antibiotic=drug,
                    susceptibility=(
                        sir[j] if not missing[j] else ''
                    ),
                    culture_description=specimen,
                )
            )

        # A neutral organism-level anchor retains orders
        # with no observed AST results.
        # This is an explicit synthetic fixture convention.

        if all(missing) and args.missing_rows=='omit':

            data['cohort'].append(
                row_for(
                    headers['cohort'],
                    keys,
                    organism='Escherichia coli',
                    antibiotic='',
                    susceptibility='',
                    culture_description=specimen,
                )
            )

            trow['neutral_anchor']=1

        else:
            trow['neutral_anchor']=0

        truth.append(trow)

        # --------------------------------------------------
        # 13. Other ECUH source tables
        # --------------------------------------------------

        def add(source,**values):
            data[source].append(
                row_for(headers[source],keys,**values)
            )

        add(
            'demographics',
            age=age,
            gender=p['gender'],
        )

        add(
            'adi',
            adi_score=round(p['adi'],2),
            adi_state_rank=min(
                10,
                int(p['adi']//10)+1,
            ),
        )

        add(
            'ward',
            **{
                f'hosp_ward_{w}':int(ward==w)
                for w in ['IP','OP','ER','ICU']
            },
        )

        if exposure:

            day=int(rng.integers(1,91))

            add(
                'abx_class',
                medication_name='ceftriaxone',
                medication_category='cephalosporin',
                time_to_culturetime=day,
            )

            add(
                'abx_subtype',
                medication_name='ceftriaxone',
                medication_category='cephalosporin',
                medication_time_to_culturetime=day,
            )

        if comorbidity:
            add(
                'comorbidity',
                comorbidity_component_start_days_culture=int(
                    rng.integers(91,1500)
                ),
            )

        if rng.random()<.18:
            add(
                'nursing_visits',
                nursing_home_visit_culture=int(
                    rng.integers(91,730)
                ),
            )

        if rng.random()<.25:
            add(
                'organism_history',
                prior_infecting_organism_days_to_culture=int(
                    rng.integers(91,730)
                ),
            )

    # --------------------------------------------------
    # 14. Validate before export
    # --------------------------------------------------

    truth_by_key={
        r['order_proc_id_coded']:r
        for r in truth
    }

    if len(truth_by_key)!=args.n:
        raise AssertionError('Order key duplication')

    seen=set()
    cohort_orders=set()

    for rec in data['cohort']:

        order=rec['order_proc_id_coded']
        drug=rec['antibiotic']

        cohort_orders.add(order)

        tr=truth_by_key[order]

        if not drug:
            if not tr['neutral_anchor']:
                raise AssertionError(
                    'Unexpected neutral row'
                )
            continue

        if (order,drug) in seen:
            raise AssertionError(
                'Duplicate antibiotic row'
            )

        seen.add((order,drug))

        expected=(
            ''
            if tr[f'R_SIR_{drug}']
            else tr[f'SIR_{drug}']
        )

        if rec['susceptibility']!=expected:
            raise AssertionError('Result mismatch')

    if len(cohort_orders)!=args.n:
        raise AssertionError('Lost cultures')

    if not all(
        all(rec.get(k) for k in KEYS[:3])
        for rows in data.values()
        for rec in rows
    ):
        raise AssertionError(
            'Invalid source identifiers'
        )

    # --------------------------------------------------
    # 15. Write ECUH-shaped CSV files
    # --------------------------------------------------

    output.mkdir(parents=True,exist_ok=False)

    hashes={}

    for source,filename in FILES.items():
        hashes[filename]=write(
            output/filename,
            headers[source],
            data[source],
        )

    # Ground truth is outside the source directory.
    truth_hash=write(
        truth_file,
        list(truth[0]),
        truth,
    )

    # --------------------------------------------------
    # 16. Provenance manifest
    # --------------------------------------------------

    manifest={
        'version':VERSION,
        'synthetic':True,
        'n_orders':args.n,
        'n_patients':n_patients,
        'seed':args.seed,
        'scenario':args.scenario,
        'trigger':args.trigger,
        'missing_rows':args.missing_rows,
        'intermediate_probability':(
            args.intermediate_probability
        ),
        'relative_days':'positive-before (synthetic)',
        'jitter':(
            'patient-constant uniform integer '
            '-10..10 days (synthetic)'
        ),
        'upstream_drugs':list(DRUGS[:4]),
        'downstream_drug':DRUGS[4],
        'true_prevalence':{
            drug:float(
                np.mean([
                    r[f'Y_{drug}']
                    for r in truth
                ])
            )
            for drug in DRUGS
        },
        'missing_rate':{
            drug:float(
                np.mean([
                    r[f'R_SIR_{drug}']
                    for r in truth
                ])
            )
            for drug in DRUGS
        },
        'template_mode':template is not None,
        'template_headers_hashes':{
            FILES[s]:hashlib.sha256(
                ','.join(h).encode()
            ).hexdigest()
            for s,h in headers.items()
        },
        'truth_file':str(truth_file),
        'truth_sha256':truth_hash,
        'python':platform.python_version(),
        'numpy':np.__version__,
        'sources':{
            FILES[s]:{
                'rows':len(data[s]),
                'sha256':hashes[FILES[s]],
                'columns':headers[s],
            }
            for s in FILES
        },
        'header_only_sources':[
            s for s in FILES
            if not data[s]
        ],
        'limitations':[
            'Not calibrated to ECUH',
            'Not verified against complete episode builder',
            'Header-only domains deliberately unsupported',
            'Not proof of graphical identifiability',
            'Neutral organism row is synthetic fixture convention',
            'Known true target is all generated culture orders; eligibility restrictions not applied',
        ],
    }

    (
        output/'synthetic_manifest.json'
    ).write_text(
        json.dumps(manifest,indent=2),
        encoding='utf-8',
    )

    print(
        json.dumps(
            {
                'orders':args.n,
                'patients':n_patients,
                'source_dir':str(output),
                'truth':str(truth_file),
                'header_only_sources':(
                    manifest['header_only_sources']
                ),
            },
            indent=2,
        )
    )


def main():
    ap=argparse.ArgumentParser(
        description=__doc__
    )

    ap.add_argument(
        '--template-dir',
        type=Path,
    )

    ap.add_argument(
        '--output',
        required=True,
        type=Path,
    )

    ap.add_argument(
        '--n',
        type=int,
        default=1000,
    )

    ap.add_argument(
        '--seed',
        type=int,
        default=20261014,
    )

    ap.add_argument(
        '--orders-per-patient',
        type=int,
        default=2,
    )

    ap.add_argument(
        '--scenario',
        choices=[
            'primary',
            'clinical_selection',
            'self_masking',
        ],
        default='primary',
    )

    ap.add_argument(
        '--trigger',
        choices=[
            'internal',
            'reported',
        ],
        default='internal',
    )

    ap.add_argument(
        '--missing-rows',
        choices=[
            'omit',
            'blank',
        ],
        default='omit',
    )

    ap.add_argument(
        '--intermediate-probability',
        type=float,
        default=.04,
    )

    args=ap.parse_args()

    if (
        args.n<1
        or args.orders_per_patient<1
        or not 0<=args.intermediate_probability<1
    ):
        ap.error(
            'Invalid n, orders-per-patient, '
            'or Intermediate probability'
        )

    build(args)


if __name__=='__main__':
    main()
