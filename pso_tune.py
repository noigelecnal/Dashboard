#!/usr/bin/env python3
"""PSO tuner for the BioPod temperature PID.

PSO (Particle Swarm Optimisation) is an OFFLINE optimiser. It does not run on the
ESP32. It searches for the PID gains (Kp, Ti, Td) that give the best simulated
response of the chamber, and prints constants to paste into biopod_pid.ino.

Workflow
    1. fit   : turn a logged open-loop step test into a plant model (K, tau, theta)
    2. tune  : search PID gains on that model, over several disturbance scenarios
               and several "what if my model is 30 % off" plants (robustness)

    python pso_tune.py fit  --csv heater_step.txt --channel heater
    python pso_tune.py tune --kh 18 --kc 9 --tau 420 --theta 20 --ambient 30

Plant model (first order + dead time, exact discretisation at the sample time Ts):
    T_inf = ambient + Kh*heater - Kc*peltier         (heater, peltier in 0..1)
    T[k+1] = T_inf*(1-a) + a*T[k],   a = exp(-Ts/tau),  input delayed by theta

No third-party packages are needed.
"""
import argparse
import math
import random
import sys

TS = 5.0                    # control sample time [s]; must equal SAMPLE_INTERVAL_MS/1000 in the .ino
BAND = 0.5                  # acceptance range, +/- degC (paper)
SP_MIN, SP_MAX = 25.0, 45.0


# ---------------------------------------------------------------- PID (mirror of PidController.h)
class Pid:
    def __init__(self, kp, ki, kd, out_min, out_max, tf):
        self.kp, self.ki, self.kd = kp, ki, kd
        self.out_min, self.out_max, self.tf = out_min, out_max, tf
        self.integral = 0.0
        self.d_filt = 0.0
        self.last = 0.0
        self.have_last = False

    def update(self, sp, meas, dt):
        e = sp - meas
        d_meas = (meas - self.last) / dt if (self.have_last and dt > 0) else 0.0
        self.d_filt += (dt / (self.tf + dt)) * (d_meas - self.d_filt)
        self.last, self.have_last = meas, True
        p = self.kp * e
        d = -self.kd * self.d_filt
        i_cand = self.integral + self.ki * e * dt
        raw = p + i_cand + d
        out = min(max(raw, self.out_min), self.out_max)
        pushing = (raw > self.out_max and e > 0) or (raw < self.out_min and e < 0)
        if not pushing:
            self.integral = min(max(i_cand, self.out_min), self.out_max)
        return out


# ---------------------------------------------------------------- plant + scenarios
class Plant:
    def __init__(self, kh, kc, tau, theta, ambient):
        self.kh, self.kc, self.tau, self.theta, self.ambient = kh, kc, tau, theta, ambient
        self.a = math.exp(-TS / tau)
        self.delay = max(0, int(round(theta / TS)))

    def run(self, gains, scen, noise):
        """Simulate one scenario; returns (times, temps, setpoints, heater%, peltier%)."""
        kp, ti, td = gains
        ki, kd = kp / ti, kp * td
        pid = Pid(kp, ki, kd, -100.0, 100.0, FILTER_S)
        T = scen["t0"]
        queue = [(0.0, 0.0)] * (self.delay + 1)          # (heater, peltier) in flight
        rec = ([], [], [], [], [])
        n = int(scen["duration"] / TS)
        cool_ok = False
        for k in range(n):
            t = k * TS
            sp = scen["sp"](t)
            if scen.get("kick") and abs(t - scen["kick"][0]) < TS / 2:
                T += scen["kick"][1]                       # door opened / warm intrusion
            meas = round(T + noise[k], 1)                  # DHT22: 0.1 degC resolution
            # same cooling gate as the firmware
            if cool_ok and meas < sp + COOL_RELEASE: cool_ok = False
            elif not cool_ok and meas > sp + COOL_ENGAGE: cool_ok = True
            pid.out_min = -100.0 if cool_ok else 0.0
            u = pid.update(sp, meas, TS)
            if abs(u) < DEADBAND: u = 0.0
            heater, peltier = (u, 0.0) if u > 0 else (0.0, -u)
            queue.append((heater / 100.0, peltier / 100.0))
            h, c = queue.pop(0)
            t_inf = self.ambient + self.kh * h - self.kc * c
            T = t_inf * (1 - self.a) + self.a * T
            for lst, v in zip(rec, (t, T, sp, heater, peltier)):
                lst.append(v)
        return rec


def make_scenarios(ambient):
    hold = lambda v: (lambda t: v)
    return [
        # cold start: ambient -> 37 degC
        {"name": "cold start 37C", "t0": ambient, "sp": hold(37.0), "duration": 5400},
        # door open: chamber at setpoint, then a sudden -3.2 degC (same size as the dashboard demo)
        {"name": "door open -3.2C", "t0": 37.0, "sp": hold(37.0), "duration": 3000, "kick": (300, -3.2)},
        # warm intrusion: +1.5 degC, exercises the cooling side
        {"name": "warm kick +1.5C", "t0": 37.0, "sp": hold(37.0), "duration": 3000, "kick": (300, +1.5)},
    ]


def make_noise(seed, n):
    rng = random.Random(seed)
    return [rng.gauss(0.0, 0.08) for _ in range(n)]


def metrics(rec, sp_final):
    t, T, sp, h, c = rec
    err = [abs(a - b) for a, b in zip(T, sp)]
    itae = sum(tt * e * TS for tt, e in zip(t, err))
    out_band = sum(TS for e in err if e > BAND)
    over = max(0.0, max(T) - max(sp))
    effort = sum(abs((h[i] - c[i]) - (h[i - 1] - c[i - 1])) for i in range(1, len(h)))
    return itae, out_band, over, effort


# ---------------------------------------------------------------- cost
W_ITAE, W_BAND, W_OVER, W_EFFORT = 1.0, 2.0, 3000.0, 1.0


def cost(gains, plants, scens, noises):
    total = 0.0
    for plant in plants:
        for scen, noise in zip(scens, noises):
            rec = plant.run(gains, scen, noise)
            itae, band, over, effort = metrics(rec, 37.0)
            if rec[1][-1] != rec[1][-1] or max(rec[1]) > 80 or min(rec[1]) < -10:
                return 1e12                                 # diverged -> reject
            total += (W_ITAE * itae / 1e3 + W_BAND * band + W_OVER * over ** 2 + W_EFFORT * effort / 10.0)
    return total / (len(plants) * len(scens))


# ---------------------------------------------------------------- PSO
def pso(fn, lo, hi, particles=24, iters=60, seed=1, verbose=True):
    rng = random.Random(seed)
    dim = len(lo)
    x = [[rng.uniform(lo[d], hi[d]) for d in range(dim)] for _ in range(particles)]
    v = [[rng.uniform(-(hi[d] - lo[d]), hi[d] - lo[d]) * 0.1 for d in range(dim)] for _ in range(particles)]
    pbest = [p[:] for p in x]
    pcost = [fn(p) for p in x]
    g = min(range(particles), key=lambda i: pcost[i])
    gbest, gcost = pbest[g][:], pcost[g]
    for it in range(iters):
        w = 0.9 - 0.5 * it / max(1, iters - 1)              # inertia 0.9 -> 0.4
        for i in range(particles):
            for d in range(dim):
                r1, r2 = rng.random(), rng.random()
                v[i][d] = w * v[i][d] + 1.8 * r1 * (pbest[i][d] - x[i][d]) + 1.8 * r2 * (gbest[d] - x[i][d])
                vmax = 0.25 * (hi[d] - lo[d])
                v[i][d] = max(-vmax, min(vmax, v[i][d]))
                x[i][d] = max(lo[d], min(hi[d], x[i][d] + v[i][d]))
            c = fn(x[i])
            if c < pcost[i]:
                pbest[i], pcost[i] = x[i][:], c
                if c < gcost:
                    gbest, gcost = x[i][:], c
        if verbose and (it % 10 == 0 or it == iters - 1):
            print("  iter %3d  best cost %.3f" % (it, gcost), file=sys.stderr)
    return gbest, gcost


# ---------------------------------------------------------------- fit subcommand
def load_step_csv(path, channel):
    """Accepts firmware lines 'CSV,<sec>,<tempC>,<heater%>,<peltier%>' or plain 'sec,temp,heater,peltier'."""
    rows = []
    for line in open(path, encoding="utf-8", errors="ignore"):
        parts = [p.strip() for p in line.strip().split(",")]
        if parts and parts[0] == "CSV":
            parts = parts[1:]
        try:
            vals = [float(p) for p in parts[:4]]
        except ValueError:
            continue
        if len(vals) == 4:
            rows.append((vals[0], vals[1], vals[2 if channel == "heater" else 3]))
    return rows


def fit(args):
    rows = load_step_csv(args.csv, args.channel)
    if len(rows) < 20:
        sys.exit("Need at least 20 samples with 4 numeric columns (sec,temp,heater%,peltier%).")
    t0 = next((i for i, r in enumerate(rows) if r[2] > 0.5), None)
    if t0 is None:
        sys.exit("The %s duty is never above 0.5 %% in this file." % args.channel)
    duty = rows[t0][2]
    T_start = sum(r[1] for r in rows[max(0, t0 - 3):t0 + 1]) / len(rows[max(0, t0 - 3):t0 + 1])
    t_step = rows[t0][0]
    ambient = args.ambient if args.ambient is not None else T_start
    data = [(r[0] - t_step, r[1]) for r in rows[t0:]]
    print("step at row %d, duty %.1f %%, start %.2f degC, ambient %.2f degC" % (t0, duty, T_start, ambient))

    def sse(p):
        t_inf, tau, theta = p
        s = 0.0
        for t, T in data:
            m = T_start if t <= theta else t_inf + (T_start - t_inf) * math.exp(-(t - theta) / tau)
            s += (m - T) ** 2
        return s / len(data)

    lo = [T_start - 60, 30.0, 0.0]
    hi = [T_start + 60, 7200.0, 180.0]
    (t_inf, tau, theta), err = pso(sse, lo, hi, particles=30, iters=80, seed=3)
    gain = abs(t_inf - ambient) / (duty / 100.0)
    rmse = math.sqrt(err)
    print("fit: steady-state %.2f degC  tau %.0f s  theta %.0f s   RMSE %.3f degC" % (t_inf, tau, theta, rmse))
    print("=> %s gain = %.2f degC at 100 %% duty" % (args.channel, gain))
    print("Use:  --%s %.2f --tau %.0f --theta %.0f --ambient %.1f"
          % ("kh" if args.channel == "heater" else "kc", gain, tau, theta, ambient))
    if rmse > 0.3:
        print("WARNING: RMSE > 0.3 degC. Was the chamber at rest before the step, and was the test long enough (>= 3 tau)?")


# ---------------------------------------------------------------- tune subcommand
def tune(args):
    global FILTER_S, COOL_ENGAGE, COOL_RELEASE, DEADBAND
    FILTER_S, COOL_ENGAGE, COOL_RELEASE, DEADBAND = args.filter, args.cool_engage, args.cool_release, args.deadband
    base = Plant(args.kh, args.kc, args.tau, args.theta, args.ambient)
    variants = [base]
    if not args.nominal_only:
        for fk, ft, fd in ((0.7, 1.3, 1.5), (1.3, 0.75, 0.7)):   # weaker/slower/laggier, stronger/faster
            variants.append(Plant(args.kh * fk, args.kc * fk, args.tau * ft, args.theta * fd, args.ambient))
    scens = make_scenarios(args.ambient)
    noises = [make_noise(100 + i, int(s["duration"] / TS)) for i, s in enumerate(scens)]

    k_pct = args.kh / 100.0                                  # degC per % duty
    lo = [0.2 / k_pct * 0.05, 0.3 * args.tau, 0.0]
    hi = [8.0 / k_pct, 6.0 * args.tau, 0.6 * args.tau]
    print("Searching Kp in [%.1f, %.1f] %%/degC, Ti in [%.0f, %.0f] s, Td in [%.0f, %.0f] s" % (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]), file=sys.stderr)
    best, c = pso(lambda g: cost(g, variants, scens, noises), lo, hi, particles=args.particles, iters=args.iters, seed=args.seed)
    kp, ti, td = best
    ki, kd = kp / ti, kp * td
    print("\nBest gains (cost %.3f):  Kp = %.3f   Ti = %.1f s   Td = %.1f s" % (c, kp, ti, td))
    print("\nPaste into biopod_pid.ino:")
    print("const float TEMP_KP = %.4ff;   // %% output per degC" % kp)
    print("const float TEMP_KI = %.6ff;   // %% output per (degC*s)   (Kp/Ti)" % ki)
    print("const float TEMP_KD = %.3ff;   // %% output per (degC/s)   (Kp*Td)" % kd)
    print("const float TEMP_D_FILTER_S = %.1ff;" % args.filter)
    print("\nPredicted performance on the NOMINAL plant:")
    for scen, noise in zip(scens, noises):
        rec = base.run(best, scen, noise)
        itae, band, over, effort = metrics(rec, 37.0)
        print("  %-18s time outside +/-%.1f C: %5.0f s   overshoot: %.2f C   final error: %.2f C"
              % (scen["name"], BAND, band, over, abs(rec[1][-1] - rec[2][-1])))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fit", help="identify plant from a logged open-loop step")
    f.add_argument("--csv", required=True)
    f.add_argument("--channel", choices=["heater", "peltier"], default="heater")
    f.add_argument("--ambient", type=float, default=None, help="degC with everything off (needed for --channel peltier)")
    t = sub.add_parser("tune", help="PSO search for PID gains")
    t.add_argument("--kh", type=float, required=True, help="degC rise at 100 %% heater duty")
    t.add_argument("--kc", type=float, default=8.0, help="degC drop at 100 %% Peltier duty")
    t.add_argument("--tau", type=float, required=True, help="time constant [s]")
    t.add_argument("--theta", type=float, default=15.0, help="dead time [s]")
    t.add_argument("--ambient", type=float, default=30.0)
    t.add_argument("--filter", type=float, default=15.0, help="derivative filter [s]")
    t.add_argument("--cool-engage", type=float, default=0.3)
    t.add_argument("--cool-release", type=float, default=0.1)
    t.add_argument("--deadband", type=float, default=1.0, help="output deadband [%%]")
    t.add_argument("--particles", type=int, default=24)
    t.add_argument("--iters", type=int, default=60)
    t.add_argument("--seed", type=int, default=1)
    t.add_argument("--nominal-only", action="store_true", help="skip the robustness variants (faster)")
    args = ap.parse_args()
    fit(args) if args.cmd == "fit" else tune(args)


if __name__ == "__main__":
    main()
