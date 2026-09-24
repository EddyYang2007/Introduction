"""Radial drying baseline; all outputs provisional pending model audit.
Run: python -X utf8 code/solve_all.py --intervals 160
Coordinate x=r/R(t); Q4 is a material coordinate under homogeneous shrinkage.
"""
from pathlib import Path
from dataclasses import dataclass
import argparse, hashlib, json, time, sys, datetime, os
import numpy as np
import scipy
from scipy.integrate import solve_ivp
from scipy.sparse import diags, bmat
from scipy.special import expn
from scipy.interpolate import PchipInterpolator
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def dump(p, obj): Path(p).write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
def load_table(name):
    wb=load_workbook(ROOT/'problem_files'/'附件'/name, read_only=True, data_only=True)
    a=np.array(list(wb.active.values)[1:],dtype=float);wb.close();return a

@dataclass
class Config:
    intervals: int = 320
    rtol: float = 2e-7
    atol: float = 2e-9
    early_step: float = 30.
    late_step: float = 300.
    ambient_extension: str = 'tail_mean'
    radius_method: str = 'linear'
    h: float = 25.
    hm: float = 8e-7
    flux_method: str = 'kirchhoff'

def synthetic_inputs():
    """Small deterministic environment/radius trajectories for software tests."""
    env = np.array([[0., 50., .05], [10800., 48., .045], [259200., 45., .04]], float)
    rad = np.array([[0., 2.0], [259200., 1.8]], float)
    return env, rad

class Model:
    def __init__(self, kind, cfg=None, shrinking=False, *, env=None, rad=None):
        self.kind=kind;self.cfg=cfg or Config();self.shrinking=shrinking
        self.x=np.linspace(0,1,self.cfg.intervals+1);self.n=len(self.x);self.dx=1/self.cfg.intervals
        self.faces=np.r_[0,(self.x[1:]+self.x[:-1])/2,1]
        self.vol=np.diff(self.faces**2)/2
        if env is None or rad is None:
            if os.environ.get('MODELING_SYNTHETIC') == '1':
                env, rad = synthetic_inputs()
            else:
                env = env if env is not None else load_table('附件1.xlsx')
                rad = rad if rad is not None else load_table('附件2.xlsx')
        self.env=np.asarray(env,float);self.rad=np.asarray(rad,float)
        self.tail=self.env[self.env[:,0]>=10800,1:].mean(axis=0)
        self.rad_interp=PchipInterpolator(self.rad[:,0],self.rad[:,1]/100,extrapolate=False)
        tri=diags([np.ones(self.n-1),np.ones(self.n),np.ones(self.n-1)],[-1,0,1],format='csr')
        self.sparsity=bmat([[tri,tri],[tri,tri]],format='csr')
    def ambient(self,t):
        if self.cfg.ambient_extension=='tail_mean':end=self.tail
        elif self.cfg.ambient_extension=='nominal':end=np.array([50.,.05])
        else:end=self.env[-1,1:]
        return np.array([np.interp(t,self.env[:,0],self.env[:,j+1],right=end[j]) for j in range(2)])
    def radius(self,t):
        if not self.shrinking:return np.full_like(np.asarray(t,float),.02)
        if self.cfg.radius_method=='pchip':return self.rad_interp(np.clip(t,self.rad[0,0],self.rad[-1,0]))
        return np.interp(t,self.rad[:,0],self.rad[:,1]/100)
    def properties(self,T,C):
        c=np.maximum(C,1e-12)
        if self.kind==1:
            rho=np.full_like(c,820);cp=np.full_like(c,2600);k=np.full_like(c,.36);base=np.full_like(c,7e-9);a=.89
        elif self.kind==3:
            rho=650+128*c;cp=1450+2736*c/(1+c);k=.21+.38*c/(1+c);base=2.4e-3*np.exp(-3850/(T+273.15));a=.45
        else:
            rho=760+90*c;cp=1850+2150*c/(1+c);k=.12+.20*c/(1+c);base=4.2e-4*np.exp(-3850/(T+273.15));a=.30
        return rho*cp,k,base,a
    @staticmethod
    def primitive(C,a):
        c=np.maximum(C,1e-12)
        return c*expn(2,a/c)
    def fluxes(self,t,y):
        T=y[:self.n];C=y[self.n:];cap,k,base,a=self.properties(T,C)
        R=float(self.radius(t));Ta,Ca=self.ambient(t)
        FT=np.zeros(self.n+1);FC=np.zeros(self.n+1)
        kf=2*k[:-1]*k[1:]/(k[:-1]+k[1:])
        FT[1:-1]=self.faces[1:-1]*kf*np.diff(T)/self.dx
        if self.cfg.flux_method=='kirchhoff':
            # Separate concentration integral and smooth temperature prefactor.
            bf=np.sqrt(base[:-1]*base[1:])
            FC[1:-1]=self.faces[1:-1]*bf*np.diff(self.primitive(C,a))/self.dx
        elif self.cfg.flux_method=='arithmetic':
            D=base*np.exp(-a/np.maximum(C,1e-12));Df=(D[:-1]+D[1:])/2
            FC[1:-1]=self.faces[1:-1]*Df*np.diff(C)/self.dx
        else:
            D=base*np.exp(-a/np.maximum(C,1e-12));Df=2*D[:-1]*D[1:]/np.maximum(D[:-1]+D[1:],1e-300)
            FC[1:-1]=self.faces[1:-1]*Df*np.diff(C)/self.dx
        FT[-1]=R*self.cfg.h*(Ta-T[-1]);FC[-1]=R*self.cfg.hm*(Ca-C[-1])
        return FT,FC,cap,R
    def rhs(self,t,y):
        FT,FC,cap,R=self.fluxes(t,y)
        return np.r_[np.diff(FT)/(R*R*self.vol*cap),np.diff(FC)/(R*R*self.vol)]
    def initial(self):return np.r_[np.full(self.n,28.),np.full(self.n,2.55)]

class Run:
    def __init__(self,model,parts,crossing=None):self.model=model;self.parts=parts;self.crossing=crossing;self.end=parts[-1].t[-1]
    def evaluate(self,times):
        times=np.asarray(times,float);out=np.empty((len(times),2*self.model.n));done=np.zeros(len(times),bool)
        if np.min(times)<-1e-8 or np.max(times)>self.end+1e-7:raise ValueError('Dense output outside solved range')
        for part in self.parts:
            take=(times>=part.t[0]-1e-9)&(times<=part.t[-1]+1e-9)&~done
            if take.any(): out[take]=part.sol(times[take]).T;done[take]=True
        assert done.all()
        return out[:,:self.model.n],out[:,self.model.n:]
    def summary(self):
        T,C=self.evaluate([self.end])
        return {'kind':self.model.kind,'shrinking':self.model.shrinking,'intervals':self.model.cfg.intervals,'end_s':float(self.end),'crossing_s':None if self.crossing is None else float(self.crossing),'drying_h':None if self.crossing is None else float(self.end/3600),'center_C_end':float(C[0,0]),'surface_C_end':float(C[0,-1]),'R_end_cm':float(self.model.radius(self.end)*100),'max_C_end':float(C.max()),'nfev':sum(p.nfev for p in self.parts),'nlu':sum(p.nlu for p in self.parts),'steps':sum(len(p.t)-1 for p in self.parts)}

def integrate(model,end=7*86400,drying=False):
    parts=[];t0=0.;y=model.initial();crossing=None
    def event(t,y):return np.max(y[model.n:])-.15
    event.terminal=True;event.direction=-1
    # Resolve the attachment's early time history and allow larger late steps.
    stops=[min(end,14400.)]
    if end>14400:stops.append(float(end))
    for stop in stops:
        sol=solve_ivp(model.rhs,(t0,stop),y,method='BDF',dense_output=True,rtol=model.cfg.rtol,atol=model.cfg.atol,jac_sparsity=model.sparsity,max_step=model.cfg.early_step if t0<14400 else model.cfg.late_step,events=event if drying else None)
        if not sol.success:raise RuntimeError(sol.message)
        parts.append(sol);t0=sol.t[-1];y=sol.y[:,-1]
        if drying and len(sol.t_events[0]):
            crossing=float(sol.t_events[0][0]);strict_end=float(np.ceil(crossing)+1)
            tail=solve_ivp(model.rhs,(t0,strict_end),y,method='BDF',dense_output=True,rtol=model.cfg.rtol,atol=model.cfg.atol,jac_sparsity=model.sparsity,max_step=1.)
            if not tail.success:raise RuntimeError(tail.message)
            parts.append(tail);break
    if drying and crossing is None:raise RuntimeError('Threshold not reached by configured horizon; do not invent drying time')
    return Run(model,parts,crossing)

def sample(run,times,distances=None):
    times=np.asarray(times,float);T,C=run.evaluate(times)
    dist=np.round(np.arange(21)*.1,10) if distances is None else np.array(distances,float)
    R=run.model.radius(times)*100
    Tout=np.full((len(times),len(dist)),np.nan);Cout=Tout.copy()
    for i,rad in enumerate(R):
        valid=dist<=rad+1e-10
        xx=np.minimum(dist[valid]/rad,1)
        Tout[i,valid]=np.interp(xx,run.model.x,T[i]);Cout[i,valid]=np.interp(xx,run.model.x,C[i])
    return Tout,Cout,R,T[:,-1],C[:,-1]

def grid_times(end,dt):
    t=np.arange(dt,np.floor(end/dt)*dt+.1,dt,dtype=float)
    if len(t)==0 or abs(t[-1]-end)>1e-7:t=np.r_[t,end]
    return t

def write_matrix(path,times,values,header):
    with open(path,'w',encoding='utf-8-sig',newline='') as f:
        import csv
        w=csv.writer(f);w.writerow(['time_s']+header)
        for t,row in zip(times,values):w.writerow([float(t)]+[None if not np.isfinite(v) else float(v) for v in row])

def export_payload(run,q,out):
    dt=1 if q<3 else 60;times=grid_times(run.end,dt)
    T,C,R,Ts,Cs=sample(run,times)
    headers=[round(i*.1,1) for i in range(21)]
    sheets={}
    if q<3:sheets={'温度':T,'水分浓度':C}
    else:sheets={'Sheet1':C}
    if q==4:
        # Fixed physical radii keep blanks outside the instantaneous specimen;
        # the final surface column moves with R(t), recorded in a sidecar CSV.
        headers=headers[:20]+['药材表面'];sheets={'Sheet1':np.column_stack([C[:,:20],Cs])}
    payload={'question':q,'status':'PROVISIONAL; unified skill audit deferred','headers':['时间\\到药材中心的距离']+headers,'sheets':{}}
    for name,data in sheets.items():
        clean=[[float(t)]+[None if not np.isfinite(v) else float(np.round(v,4)) for v in row] for t,row in zip(times,data)]
        payload['sheets'][name]=clean
        write_matrix(out/f'q{q}_{name}.csv',times,data,[str(x) for x in headers])
    dump(out/f'q{q}_xlsx_payload.json',payload)
    if q==4:write_matrix(out/'q4_surface.csv',times,np.c_[R,Ts,Cs],['radius_cm','surface_temperature_C','surface_moisture_kg_kg'])
    if q==1:st=np.array([100,300,600,900,1200,1500,1800.])
    elif q==2:st=np.arange(1800,10801,1800.)
    else:st=grid_times(run.end,21600)
    summary_radii=[0,.5,1] if q==4 else [0,.5,1,1.5,2]
    a,b,r,at,bc=sample(run,st,summary_radii)
    if q==4:b=np.c_[b,bc]
    write_matrix(out/f'q{q}_summary_C.csv',st,b,[str(v) for v in summary_radii]+(['surface'] if q==4 else []))
    if q<3:write_matrix(out/f'q{q}_summary_T.csv',st,a,['0','0.5','1','1.5','2'])
    summary=run.summary();summary['output_rows']=len(times);summary['output_dt_s']=dt
    summary['numerical_diagnostics']={'finite':bool(np.isfinite(run.evaluate(times)[1]).all()),'moisture_min':float(np.nanmin(C)),'moisture_max':float(np.nanmax(C)),'temperature_min_C':float(np.nanmin(T)),'temperature_max_C':float(np.nanmax(T)),'radial_C_monotonic_max_increase':float(np.max(np.diff(run.evaluate(times)[1],axis=1))),'radius_extrapolated':bool(q==4 and run.end>259200),'ambient_extrapolated':bool(run.end>14400)}
    # Keep unrounded node snapshots for independent inspection without serializing solver objects.
    checkt=np.unique(np.r_[0,st,run.end]);nt,nc=run.evaluate(checkt)
    np.savez_compressed(out/f'q{q}_snapshots.npz',time_s=checkt,x=run.model.x,T_C=nt,C=nc,radius_m=run.model.radius(checkt))
    return summary

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--intervals',type=int,default=320);args=ap.parse_args()
    start=time.perf_counter();cfg=Config(intervals=args.intervals);out=ROOT/'results';out.mkdir(exist_ok=True)
    summaries={}
    for q,kind,end,shr in [(1,1,1800,False),(2,3,10800,False),(3,3,604800,False),(4,4,604800,True)]:
        before=time.perf_counter();run=integrate(Model(kind,cfg,shr),end,drying=q>=3)
        summaries[f'q{q}']=export_payload(run,q,out);summaries[f'q{q}']['elapsed_s']=time.perf_counter()-before
        print(json.dumps(summaries[f'q{q}'],ensure_ascii=False),flush=True)
    record={'timestamp':datetime.datetime.now().astimezone().isoformat(),'stage':'S5 BASELINE_SOLVE','status':'PROVISIONAL','unified_audit':'DEFERRED_BY_USER','command':sys.executable+' -X utf8 code/solve_all.py --intervals '+str(args.intervals),'exit_code':0,'settings':vars(cfg),'versions':{'python':sys.version,'python_executable':sys.executable,'numpy':np.__version__,'scipy':scipy.__version__},'source_sha256':sha(__file__),'input_hashes':{str(p.relative_to(ROOT)):sha(p) for p in (ROOT/'problem_files').rglob('*') if p.is_file()},'results':summaries,'elapsed_s':time.perf_counter()-start}
    dump(ROOT/'results_manifest.json',record);dump(ROOT/'logs'/'solve_run.json',record)
    print('Total elapsed seconds',record['elapsed_s'],flush=True)
if __name__=='__main__':main()


