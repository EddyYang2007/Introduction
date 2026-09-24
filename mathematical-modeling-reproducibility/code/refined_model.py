"""Validated numerical extension of the effective radial drying model.

C is kg water / kg dry solid. Under homogeneous shrinkage at fixed length,
rho_d(t)=rho_d0*(R0/R(t))**2 and Cbar=2*sum(vol*C) is water per dry mass.
The empirical rho*cp remains an effective thermal coefficient, not rho_d.
The startup module is deliberately preserved as a reproducible baseline.
"""
from dataclasses import dataclass
import numpy as np
from scipy.integrate import solve_ivp
from scipy.sparse import bmat, csr_matrix
from solve_all import Config, Model, Run, sample, grid_times, ROOT, dump, sha


@dataclass
class RefinedConfig(Config):
    intervals: int = 640
    rtol: float = 1e-9
    atol: float = 1e-11
    early_step: float = 15.0
    late_step: float = 150.0
    mesh_power: float = 2.0
    method: str = 'BDF'
    align_knots: bool = True


class RefinedModel(Model):
    def __init__(self, kind, cfg=None, shrinking=False):
        super().__init__(kind, cfg or RefinedConfig(), shrinking)
        if self.cfg.intervals < 4 or not 1 <= self.cfg.mesh_power <= 3:
            raise ValueError('Require intervals>=4 and 1<=mesh_power<=3')
        s = np.linspace(0, 1, self.n)
        self.x = 1 - (1-s)**self.cfg.mesh_power
        self.dx = np.diff(self.x)
        self.faces = np.r_[0, (self.x[1:]+self.x[:-1])/2, 1]
        self.vol = np.diff(self.faces**2)/2
        self.field_sparsity = self.sparsity.copy()
        # The extra state integrates outward water loss / initial dry mass.
        bottom = csr_matrix(([1.0], ([0], [2*self.n-1])), shape=(1, 2*self.n))
        self.sparsity = bmat([[self.field_sparsity, csr_matrix((2*self.n, 1))],
                              [bottom, csr_matrix((1, 1))]], format='csr')

    def radius(self, t):
        if self.shrinking:
            a = np.asarray(t, float)
            if np.any(a < self.rad[0, 0]) or np.any(a > self.rad[-1, 0]):
                raise ValueError('Radius requested outside measured domain; no silent extrapolation')
        return super().radius(t)

    def ambient(self, t):
        # Define a right-continuous extension; integrate_refined supplies a left
        # limit at the end of the final measured interval.
        if t >= self.env[-1, 0]:
            if self.cfg.ambient_extension == 'tail_mean':
                return self.tail.copy()
            if self.cfg.ambient_extension == 'nominal':
                return np.array([50., .05])
            if self.cfg.ambient_extension == 'last':
                return self.env[-1, 1:].copy()
            raise ValueError('Unknown ambient extension')
        return super().ambient(t)

    def fluxes(self, t, y):
        return super().fluxes(t, y[:2*self.n])

    def rhs(self, t, y):
        FT, FC, cap, R = self.fluxes(t, y)
        dT = np.diff(FT)/(R*R*self.vol*cap)
        dC = np.diff(FC)/(R*R*self.vol)
        # FC is inward-signed; positive L denotes outward moisture loss.
        dL = -2*FC[-1]/(R*R)
        return np.r_[dT, dC, dL]

    def initial(self):
        return np.r_[super().initial(), 0.]

    def moisture_mean(self, C):
        return 2*np.asarray(C) @ self.vol

    def dry_density_ratio(self, t):
        return (.02/self.radius(t))**2


class RefinedRun(Run):
    def __init__(self, model, parts, crossing=None):
        super().__init__(model, parts, crossing)
        self.part_ends = np.array([p.t[-1] for p in parts])

    def evaluate_raw(self, times):
        times = np.atleast_1d(np.asarray(times, float))
        if not len(times):
            return np.empty((0, 2*self.model.n+1))
        if times.min() < -1e-9 or times.max() > self.end+1e-8:
            raise ValueError('Dense output requested outside solved range')
        indices = np.searchsorted(self.part_ends, times, side='left')
        indices = np.minimum(indices, len(self.parts)-1)
        out = np.empty((len(times), 2*self.model.n+1))
        for i in np.unique(indices):
            take = indices == i
            out[take] = self.parts[i].sol(times[take]).T
        return out

    def evaluate(self, times):
        out = self.evaluate_raw(times)
        return out[:, :self.model.n], out[:, self.model.n:2*self.model.n]

    def summary(self):
        result = super().summary()
        raw = self.evaluate_raw([self.end])[0]
        avg = float(self.model.moisture_mean(raw[self.model.n:2*self.model.n]))
        result.update(mesh_power=self.model.cfg.mesh_power,
                      crossing_h=None if self.crossing is None else self.crossing/3600,
                      mean_moisture_end=avg, cumulative_loss_end=float(raw[-1]),
                      water_balance_residual_end=avg+float(raw[-1])-2.55,
                      ambient_extended=bool(self.end > self.model.env[-1, 0]),
                      radius_extrapolated=False,
                      stopping_convention='threshold infimum plus conservative ceil(crossing)+1 second',
                      interpretation='effective radial model; conditional physical closure')
        return result


def integrate_refined(model, end=259200., drying=False):
    if model.shrinking and end > model.rad[-1, 0]:
        raise ValueError('Moving-domain horizon exceeds measured radius data')
    knots = [0., float(end)]
    if model.cfg.align_knots:
        knots.extend(model.env[:, 0])
        if model.shrinking:
            knots.extend(model.rad[:, 0])
    else:
        knots.append(float(model.env[-1, 0]))
    stops = np.unique([t for t in knots if 0 <= t <= end])[1:]
    cutoff = float(model.env[-1, 0])
    parts, y, t0, crossing = [], model.initial(), 0., None

    def event(t, state):
        return np.max(state[model.n:2*model.n])-.15
    event.terminal = True
    event.direction = -1

    def solve_segment(a, b, state, events):
        def rhs(t, yy):
            if b == cutoff and t >= cutoff:
                t = np.nextafter(cutoff, -np.inf)
            return model.rhs(t, yy)
        sol = solve_ivp(rhs, (a, b), state, method=model.cfg.method,
                        dense_output=True, rtol=model.cfg.rtol, atol=model.cfg.atol,
                        jac_sparsity=model.sparsity,
                        max_step=model.cfg.early_step if a < cutoff else model.cfg.late_step,
                        events=events)
        if not sol.success or not np.isfinite(sol.y).all():
            raise RuntimeError(sol.message)
        return sol

    for stop in stops:
        sol = solve_segment(t0, float(stop), y, event if drying else None)
        parts.append(sol)
        t0, y = float(sol.t[-1]), sol.y[:, -1]
        if drying and len(sol.t_events[0]):
            crossing = float(sol.t_events[0][0])
            strict_end = float(np.ceil(crossing)+1)
            if model.shrinking and strict_end > model.rad[-1, 0]:
                raise RuntimeError('No supported radius interval for strict stopping margin')
            tail_stops = [v for v in stops if crossing < v < strict_end]+[strict_end]
            for tail_end in tail_stops:
                tail = solve_segment(t0, float(tail_end), y, None)
                parts.append(tail)
                t0, y = float(tail.t[-1]), tail.y[:, -1]
            if np.max(y[model.n:2*model.n]) >= .15:
                raise RuntimeError('Strict drying threshold failed at reported stop')
            break
    if drying and crossing is None:
        raise RuntimeError('Threshold was not reached; do not invent drying time')
    return RefinedRun(model, parts, crossing)


def sample_fields(run, times):
    """Full fixed 0..2 cm grid, with moving surface and validity mask separate."""
    times = np.asarray(times, float)
    T, C, radius_cm, surface_T, surface_C = sample(run, times)
    return dict(time_s=times, distance_cm=np.arange(21)/10,
                T_C=T, C_kg_kg=C, inside=np.isfinite(C), radius_cm=radius_cm,
                surface_T_C=surface_T, surface_C_kg_kg=surface_C)

