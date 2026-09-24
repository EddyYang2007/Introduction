"""Continue S5/S6 model development; writes model data/QA, never a paper.
Run with the workspace .venv-cumcm Python. Baseline XLSX/source are preserved.
"""
from dataclasses import asdict, replace
from datetime import datetime
from pathlib import Path
import argparse, csv, gc, json, sys, time
import numpy as np
import scipy
from scipy.integrate import fixed_quad
from refined_model import (RefinedConfig, RefinedModel, integrate_refined,
                           sample_fields, ROOT, dump, sha, grid_times)

OUT = ROOT/'results'/'refined'
QA = ROOT/'qa'/'refined'


def chunks(values, size=512):
    for i in range(0, len(values), size):
        yield values[i:i+size]


def compare_runs(lo, hi, q):
    dt = 1. if q in [1, 23] else 60.
    end = min(lo.end, hi.end)
    times = grid_times(end, dt)
    maxerr = {'T_C': 0., 'C_kg_kg': 0., 'surface_T_C': 0., 'surface_C_kg_kg': 0.}
    locations = {}
    counts = {'T_C': 0, 'C_kg_kg': 0}
    mismatches = {'T_C': 0, 'C_kg_kg': 0}
    for tt in chunks(times):
        a, b = sample_fields(lo, tt), sample_fields(hi, tt)
        for key in maxerr:
            diff = np.abs(a[key]-b[key])
            peak = float(np.nanmax(diff))
            if peak > maxerr[key]:
                maxerr[key] = peak
                loc = np.unravel_index(np.nanargmax(diff), diff.shape)
                locations[key] = {'time_s': float(tt[loc[0]]),
                                  'distance_cm': float(a['distance_cm'][loc[1]]) if len(loc)>1 else 'surface'}
        for key in counts:
            valid = np.isfinite(a[key]) & np.isfinite(b[key])
            counts[key] += int(valid.sum())
            mismatches[key] += int(np.sum((np.round(a[key], 4) != np.round(b[key], 4)) & valid))
    return {'coarse_n': lo.model.cfg.intervals, 'fine_n': hi.model.cfg.intervals,
            'comparison_rows': len(times), 'every_required_output_row_checked': True,
            'max_abs_difference': maxerr, 'locations': locations,
            'threshold_difference_s': None if lo.crossing is None else lo.crossing-hi.crossing,
            'four_decimal_rounding_mismatches': mismatches, 'compared_cells': counts,
            'all_differences_below_5e-5': all(v < 5e-5 for v in maxerr.values()),
            'meaning': 'grid-pair differences are not certified absolute error or guaranteed identical rounding'}


def conservation_report(run):
    m = run.model
    tt = np.unique(np.r_[0., grid_times(run.end, 60.), 1., 2., 5., 10.])
    max_res, Cmin, Cmax, Tmax, Tmin, mono = 0., np.inf, -np.inf, -np.inf, np.inf, 0.
    snapshots = []
    for ts in chunks(tt):
        raw = run.evaluate_raw(ts)
        T, C, loss = raw[:, :m.n], raw[:, m.n:2*m.n], raw[:, -1]
        if not np.isfinite(raw).all():
            raise RuntimeError('Nonfinite state')
        avg = 2*C @ m.vol
        residual = avg+loss-2.55
        max_res = max(max_res, float(np.max(abs(residual))))
        Cmin, Cmax = min(Cmin, float(C.min())), max(Cmax, float(C.max()))
        Tmin, Tmax = min(Tmin, float(T.min())), max(Tmax, float(T.max()))
        mono = max(mono, float(np.max(np.diff(C, axis=1))))
        snapshots.append(np.c_[ts, avg, loss, residual])
    # Independently quadrature the boundary functional of dense output; no
    # augmented-state values enter this integral. Compare 8/16 point rules.
    losses = {}
    for order in [8, 16]:
        total = 0.
        for part in run.parts:
            m0 = float(m.env[-1, 0])
            for left, right in zip(part.t[:-1], part.t[1:]):
                def flux(t):
                    yy = part.sol(t)
                    ca = np.array([m.ambient(float(s))[1] for s in t])
                    return 2*m.cfg.hm*(yy[2*m.n-1]-ca)/m.radius(t)
                total += fixed_quad(flux, left, right, n=order)[0]
        losses[str(order)] = float(total)
    endraw = run.evaluate_raw([run.end])[0]
    quad_err = abs(losses['16']-float(endraw[-1]))
    if max_res > 1e-7 or quad_err > 1e-6 or Cmin < -.000001:
        raise RuntimeError(f'Conservation/positivity gate failed: {max_res}, {quad_err}, {Cmin}')
    return {'augmented_water_balance_max_abs_kg_kg': max_res,
            'independent_boundary_quadrature': losses,
            'independent_quadrature_vs_ode_loss': quad_err,
            'quadrature_8_vs_16': abs(losses['8']-losses['16']),
            'temperature_range_C': [Tmin, Tmax], 'moisture_range_kg_kg': [Cmin, Cmax],
            'max_radial_moisture_increase': mono,
            'sampled_times': len(tt),
            'scope': 'conditional uniform-dry-density material model; not total thermal enthalpy conservation'}, np.vstack(snapshots)


def save_solution(run, q):
    """Chunk dense evaluation to avoid a time-by-all-nodes memory allocation."""
    dt = 1. if q < 3 else 60.
    times = grid_times(run.end, dt)
    T, C = np.empty((len(times), 21)), np.empty((len(times), 21))
    radius, Ts, Cs = np.empty(len(times)), np.empty(len(times)), np.empty(len(times))
    for i in range(0, len(times), 512):
        stop = min(i+512, len(times))
        item = sample_fields(run, times[i:stop])
        T[i:stop], C[i:stop] = item['T_C'], item['C_kg_kg']
        radius[i:stop], Ts[i:stop], Cs[i:stop] = item['radius_cm'], item['surface_T_C'], item['surface_C_kg_kg']
    path = OUT/f'q{q}_fields.npz'
    np.savez_compressed(path, time_s=times, distance_cm=np.arange(21)/10,
                        T_C=T, C_kg_kg=C, inside=np.isfinite(C), radius_cm=radius,
                        surface_T_C=Ts, surface_C_kg_kg=Cs)
    if q == 1:
        summary_times = np.array([100., 300., 600., 900., 1200., 1500., 1800.])
    elif q == 2:
        summary_times = np.arange(1800., 10801., 1800.)
    else:
        summary_times = grid_times(run.end, 21600.)
    data = sample_fields(run, summary_times)
    with (OUT/f'q{q}_summary.csv').open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['time_s', 'time_h', 'radius_cm']+[f'T_r{r:.1f}cm_C' for r in [0,.5,1,1.5,2]]+
                   [f'C_r{r:.1f}cm_kg_kg' for r in [0,.5,1,1.5,2]]+['surface_T_C','surface_C_kg_kg'])
        for i, t in enumerate(summary_times):
            values = [t, t/3600, data['radius_cm'][i]]+data['T_C'][i, ::5].tolist()+data['C_kg_kg'][i, ::5].tolist()+[data['surface_T_C'][i], data['surface_C_kg_kg'][i]]
            w.writerow([float(v) if np.isfinite(v) else '' for v in values])
    # Reopen real saved artifact and enforce schema, endpoints and support mask.
    with np.load(path) as saved:
        assert saved['C_kg_kg'].shape == (len(times), 21)
        assert np.array_equal(saved['time_s'], times)
        assert np.array_equal(saved['C_kg_kg'], C, equal_nan=True)
        assert np.array_equal(saved['T_C'], T, equal_nan=True)
        assert np.array_equal(saved['inside'], np.arange(21)[None, :]/10 <= radius[:, None]+1e-10)
        assert np.isfinite(saved['C_kg_kg'][saved['inside']]).all()
    summary = run.summary()
    summary.update(file=str(path.relative_to(ROOT)), output_rows=len(times), output_dt_s=dt,
                   fixed_radius_columns=21, moving_surface_stored_separately=True,
                   artifact_sha256=sha(path), artifact_readback='PASS')
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--intervals', type=int, default=640)
    ap.add_argument('--skip-sensitivity', action='store_true')
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    QA.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    report = {'created': datetime.now().astimezone().isoformat(),
              'stage': 'S5_SOLVE_S6_VERIFY', 'status': 'RUNNING',
              'model_status': 'CONDITIONAL_EFFECTIVE_MODEL', 'paper_written': False,
              'command': [sys.executable, '-X', 'utf8', *sys.argv],
              'settings': asdict(RefinedConfig(intervals=args.intervals)),
              'versions': {'python': sys.version, 'numpy': np.__version__, 'scipy': scipy.__version__},
              'source_hashes': {str(p.relative_to(ROOT)): sha(p) for p in (ROOT/'code').glob('*.py')},
              'input_hashes': {str(p.relative_to(ROOT)): sha(p) for p in (ROOT/'problem_files').rglob('*') if p.is_file()},
              'convergence': {}, 'conservation': {}, 'results': {}, 'sensitivity': {}}
    cfg = RefinedConfig(intervals=args.intervals)
    summaries = {}
    for q, kind, end, shr in [(1,1,1800.,False),(23,3,259200.,False),(4,4,259200.,True)]:
        label = f'q{q}'
        before = time.perf_counter()
        coarse = integrate_refined(RefinedModel(kind, replace(cfg, intervals=args.intervals//2), shr), end, q!=1)
        nominal = integrate_refined(RefinedModel(kind, cfg, shr), end, q!=1)
        lowpair = compare_runs(coarse, nominal, q)
        del coarse
        gc.collect()
        fine = integrate_refined(RefinedModel(kind, replace(cfg, intervals=args.intervals*2), shr), end, q!=1)
        highpair = compare_runs(nominal, fine, q)
        report['convergence'][label] = {'coarse_vs_nominal': lowpair, 'nominal_vs_fine': highpair}
        # Fine solution is the current candidate; nominal remains a convergence reference.
        del nominal
        gc.collect()
        checks, budget = conservation_report(fine)
        report['conservation'][label] = checks
        np.savetxt(OUT/f'{label}_water_budget.csv', budget, delimiter=',',
                   header='time_s,mean_C_kg_kg,cumulative_loss_kg_kg,residual_kg_kg', comments='')
        if q == 23:
            report['results']['q2'] = save_solution(fine, 2)
            report['results']['q3'] = save_solution(fine, 3)
        else:
            report['results'][label] = save_solution(fine, q)
        summaries[label] = fine.summary()
        # Independent method + halved steps/tighter tolerance on same fine mesh for short Q1;
        # long equations are tested below at nominal mesh to bound integration effects.
        report['convergence'][label]['elapsed_s'] = time.perf_counter()-before
        print(label, 'candidate', fine.summary(), 'mesh differences', highpair['max_abs_difference'], flush=True)
        dump(QA/'verification.json', report)
        del fine
        gc.collect()

    # Temporal refinement with full output-grid comparison, separate from spatial refinement.
    for label, kind, end, shr in [('q23',3,259200.,False),('q4',4,259200.,True)]:
        nominal = integrate_refined(RefinedModel(kind, cfg, shr), end, True)
        tighter = replace(cfg, rtol=2e-10, atol=2e-12, early_step=7.5, late_step=75.)
        refined = integrate_refined(RefinedModel(kind, tighter, shr), end, True)
        comp = compare_runs(nominal, refined, 23 if kind==3 else 4)
        report['convergence'][label]['temporal_refinement'] = comp
        print(label, 'temporal', comp['max_abs_difference'], comp['threshold_difference_s'], flush=True)
        del nominal, refined
        gc.collect()
    # Independent time integrator for a stiff variable-coefficient early transient.
    a = integrate_refined(RefinedModel(3, replace(cfg, intervals=160)), 1800.)
    b = integrate_refined(RefinedModel(3, replace(cfg, intervals=160, method='Radau')), 1800.)
    report['independent_Radau_vs_BDF'] = compare_runs(a,b,1)
    del a,b
    gc.collect()

    if not args.skip_sensitivity:
        small = replace(cfg, intervals=320, rtol=2e-9, atol=2e-11)
        branch_summaries = {}
        branches = [('appendix3_fixed',3,False,small,604800.),
                    ('appendix3_shrinking',3,True,small,259200.),
                    ('appendix4_fixed',4,False,small,604800.),
                    ('appendix4_shrinking',4,True,small,259200.),
                    ('q3_last_ambient',3,False,replace(small,ambient_extension='last'),259200.),
                    ('q4_last_ambient',4,True,replace(small,ambient_extension='last'),259200.),
                    ('q3_nominal_ambient',3,False,replace(small,ambient_extension='nominal'),259200.),
                    ('q4_nominal_ambient',4,True,replace(small,ambient_extension='nominal'),259200.),
                    ('q4_pchip_radius',4,True,replace(small,radius_method='pchip'),259200.)]
        for name,kind,shr,c,horizon in branches:
            rr = integrate_refined(RefinedModel(kind,c,shr),horizon,True)
            branch_summaries[name] = rr.summary()
            print('branch',name,rr.crossing/3600,flush=True)
            del rr
            gc.collect()
        report['sensitivity'] = branch_summaries
        report['shrinkage_counterfactual'] = {
            str(k): {'fixed_h':branch_summaries[f'appendix{k}_fixed']['crossing_h'],
                     'shrinking_h':branch_summaries[f'appendix{k}_shrinking']['crossing_h'],
                     'difference_h':branch_summaries[f'appendix{k}_shrinking']['crossing_h']-branch_summaries[f'appendix{k}_fixed']['crossing_h']}
            for k in [3,4]}
        report['shrinkage_counterfactual']['scope'] = 'Prescribed-radius model counterfactual; same coefficients in each pair; not experimental causality'
    report['numerical_pair_precision_gate'] = all(v['nominal_vs_fine']['all_differences_below_5e-5'] for v in report['convergence'].values())
    report['status'] = 'PASS_COMPLETED_CHECKS_CONDITIONAL_MODEL'
    report['elapsed_s'] = time.perf_counter()-start
    report['limitations'] = ['No absolute-error certification or identical-four-decimal-rounding guarantee',
                            'Air/material moisture boundary is an effective closure, not measured sorption equilibrium',
                            'Ambient data end at 4 h; long-time boundary requires extension',
                            'Empirical heat capacity is not a conservative latent-heat enthalpy model',
                            'One-dimensional midsection; axial/end effects remain unvalidated',
                            'Startup result*.xlsx are historical baseline; refined NPZ/CSV are current model outputs']
    report['output_hashes'] = {str(p.relative_to(ROOT)):sha(p) for p in OUT.glob('*') if p.is_file()}
    dump(QA/'verification.json',report)
    manifest = json.loads((ROOT/'results_manifest.json').read_text(encoding='utf-8'))
    manifest['continuation'] = {'stage':'S6_VERIFY','status':report['status'],
                                'created':report['created'],'report':'qa/refined/verification.json',
                                'report_sha256':sha(QA/'verification.json'),
                                'current_model_results':report['results'],
                                'original_top_level_results':'historical startup baseline',
                                'submission_ready':False,'paper_written':False}
    manifest['current_model_generation']='refined'
    dump(ROOT/'results_manifest.json',manifest)
    print('DONE',report['elapsed_s'],report['numerical_pair_precision_gate'],flush=True)


if __name__ == '__main__':
    main()

