"""Independent mathematical acceptance tests, not implementation-mirroring tests."""
import numpy as np
import pytest
from scipy.integrate import solve_ivp
from scipy.special import j0, j1, jn_zeros
from scipy.optimize import brentq
from refined_model import RefinedConfig, RefinedModel, integrate_refined
from solve_all import Model, Config

@pytest.fixture(autouse=True)
def use_synthetic_inputs(monkeypatch):
    monkeypatch.setenv('MODELING_SYNTHETIC', '1')


def test_uniform_mesh_and_zero_shrinkage_degenerate_to_baseline():
    old = Model(3, Config(intervals=40))
    new = RefinedModel(3, RefinedConfig(intervals=40, mesh_power=1), True)
    new.radius = lambda t: np.asarray(t)*0+.02
    state = np.r_[34+10*old.x**2, 2.4-.7*old.x**2]
    np.testing.assert_allclose(new.rhs(1234, np.r_[state, 0])[:-1],
                               old.rhs(1234, state), rtol=1e-11, atol=1e-13)


def test_closed_shrinking_body_keeps_dry_basis_mean_and_equilibrium():
    m = RefinedModel(4, RefinedConfig(intervals=40, h=0, hm=0), True)
    eq = np.r_[np.full(m.n, 28.), np.full(m.n, 2.55), 0.]
    assert np.max(np.abs(m.rhs(20000, eq))) == 0
    initial_dry_measure = (.02**2)*m.vol.sum()
    for t in [0., 10000., 100000.]:
        current = float(m.radius(t))**2*float(m.dry_density_ratio(t))*m.vol.sum()
        assert abs(current-initial_dry_measure) < 1e-18


def test_flux_sign_center_regular_and_coefficient_positivity():
    m = RefinedModel(4, RefinedConfig(intervals=80), True)
    state = np.r_[34+10*m.x*m.x, 2.4-.7*m.x*m.x, 0.]
    ft, fc, cap, R = m.fluxes(20000, state)
    assert ft[0] == fc[0] == 0
    assert ft[-1] > 0 and fc[-1] < 0
    dy = m.rhs(20000, state)
    assert np.isfinite(dy).all() and np.all(cap > 0)
    assert abs(2*np.dot(m.vol, dy[m.n:2*m.n])+dy[-1]) < 1e-15
    assert abs(np.dot(dy[:m.n], R*R*m.vol*cap)-ft[-1]) < 1e-10
    for c in [.01, .05, .15, 1., 2.55]:
        cap, k, b, a = m.properties(np.array([28., 50.]), np.array([c, c]))
        assert np.all(cap > 0) and np.all(k > 0) and np.all(b*np.exp(-a/c) > 0)


def test_moving_neumann_bessel_mode_converges_second_order():
    D, beta, end = 2e-9, 2e-5, 10000.
    lam = jn_zeros(1, 1)[0]
    errs = []
    for n in [40, 80, 160]:
        m = RefinedModel(1, RefinedConfig(intervals=n, h=0, hm=0))
        m.radius = lambda t: .02*np.exp(-beta*np.asarray(t))
        m.properties = lambda T, C: (np.ones_like(C), np.full_like(C, D), np.full_like(C, D), 0.)
        y0 = np.r_[28+.1*j0(lam*m.x), 1+.1*j0(lam*m.x), 0.]
        sol = solve_ivp(m.rhs, (0, end), y0, method='BDF', jac_sparsity=m.sparsity,
                        rtol=1e-10, atol=1e-12)
        assert sol.success
        integral = np.expm1(2*beta*end)/(2*beta*.02**2)
        exact = 1+.1*j0(lam*m.x)*np.exp(-lam**2*D*integral)
        errs.append(np.max(np.abs(sol.y[m.n:2*m.n, -1]-exact)))
        assert abs(2*np.dot(m.vol, sol.y[m.n:2*m.n, -1])-2*np.dot(m.vol, y0[m.n:2*m.n])) < 1e-10
    assert errs[-1] < 4.3e-6
    assert min(errs[0]/errs[1], errs[1]/errs[2]) > 3.8


def test_independent_robin_bessel_heat_solution():
    m = RefinedModel(1, RefinedConfig(intervals=320))
    m.ambient = lambda t: np.array([50., 2.55])
    Bi = 25*.02/.36
    f = lambda z: z*j1(z)-Bi*j0(z)
    grid = np.linspace(1e-8, 180, 12000)
    roots = np.array([brentq(f, a, b) for a, b in zip(grid[:-1], grid[1:]) if f(a)*f(b) < 0])
    A = 2*j1(roots)/(roots*(j0(roots)**2+j1(roots)**2))
    ts = np.array([1., 10., 100., 300., 1800.])
    run = integrate_refined(m, 1800)
    computed, _ = run.evaluate(ts)
    exact = np.array([50-22*np.sum((A*np.exp(-roots**2*.36/(820*2600)*t/.02**2))[:, None]*j0(roots[:, None]*m.x), axis=0) for t in ts])
    assert np.max(abs(computed-exact)) < 3e-4


def test_radius_out_of_domain_and_dense_output_are_rejected():
    m = RefinedModel(4, RefinedConfig(intervals=20), True)
    with pytest.raises(ValueError):
        m.radius(259201.)
    with pytest.raises(ValueError):
        integrate_refined(m, 259201.)
    run = integrate_refined(m, 60.)
    with pytest.raises(ValueError):
        run.evaluate([61.])
    assert run.evaluate([])[0].shape == (0, m.n)


def test_augmented_inventory_and_independent_surface_quadrature():
    from scipy.integrate import quad
    m = RefinedModel(4, RefinedConfig(intervals=80), True)
    run = integrate_refined(m, 3600.)
    times = np.r_[0., np.geomspace(1, 3600, 100)]
    states = run.evaluate_raw(times)
    residual = 2*states[:, m.n:2*m.n] @ m.vol+states[:, -1]-2.55
    assert np.max(abs(residual)) < 2e-9
    loss = 0.
    for part in run.parts:
        def integrand(t):
            state = part.sol(t)
            return 2*m.cfg.hm*(state[2*m.n-1]-m.ambient(t)[1])/float(m.radius(t))
        loss += quad(integrand, part.t[0], part.t[-1], epsabs=1e-11, epsrel=1e-8)[0]
    assert abs(loss-states[-1, -1]) < 2e-7

