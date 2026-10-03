import bisect
from pymavlink import mavutil

FILES = [
    ("00000001.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000001.BIN"),
    ("00000002.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000002.BIN"),
]

PLANE_MODES = {
    0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO",
    5: "FBWA", 6: "FBWB", 7: "CRUISE", 8: "AUTOTUNE", 9: "AUTO",
    10: "RTL", 11: "LOITER", 12: "TAKEOFF", 13: "AVOID_ADSB",
    14: "GUIDED", 15: "INITIALISING", 16: "QSTABILIZE", 17: "QHOVER",
    18: "QLOITER", 19: "QLAND", 20: "QRTL", 21: "QAUTOTUNE", 22: "QACRO",
    23: "THERMAL", 24: "LOITER_ALT_QLAND",
}

VTOL_MODES = {16, 17, 18, 19, 20, 21, 22, 23, 24}


def series(mlog, msgtype, fields):
    out = {}
    for f in fields:
        out[f] = ([], [])
    times = []
    while True:
        m = mlog.recv_match(type=[msgtype])
        if m is None:
            break
        t = m.TimeUS
        times.append(t)
        for f in fields:
            out[f][0].append(t)
            out[f][1].append(getattr(m, f))
    return times, out


def merge(mlog):
    data = {"t": [], "mode": [], "rcou": {}, "qtun": {}, "ctun": {}, "rcin": {}, "att": {}}
    rcou_f = ["C1", "C2", "C3", "C4", "C5", "C6", "C10", "C11", "C12", "C13"]
    qtun_f = ["ThI", "ThO", "ThH", "Trn", "Ast", "TMix"]
    ctun_f = ["ThO", "ThD", "As", "AsT", "SAs", "Pitch", "NavPitch"]
    rcin_f = ["C3"]
    att_f = ["Pitch", "DesPitch"]
    for f in rcou_f:
        data["rcou"][f] = ([], [])
    for f in qtun_f:
        data["qtun"][f] = ([], [])
    for f in ctun_f:
        data["ctun"][f] = ([], [])
    for f in rcin_f:
        data["rcin"][f] = ([], [])
    for f in att_f:
        data["att"][f] = ([], [])

    while True:
        m = mlog.recv_match(type=["MODE", "RCOU", "QTUN", "CTUN", "RCIN", "ATT"])
        if m is None:
            break
        t = m.TimeUS
        ty = m.get_type()
        if ty == "MODE":
            data["t"].append(t)
            data["mode"].append(m.ModeNum)
        elif ty == "RCOU":
            for f in rcou_f:
                data["rcou"][f][0].append(t)
                data["rcou"][f][1].append(getattr(m, f))
        elif ty == "QTUN":
            for f in qtun_f:
                data["qtun"][f][0].append(t)
                data["qtun"][f][1].append(getattr(m, f))
        elif ty == "CTUN":
            for f in ctun_f:
                data["ctun"][f][0].append(t)
                data["ctun"][f][1].append(getattr(m, f))
        elif ty == "RCIN":
            for f in rcin_f:
                data["rcin"][f][0].append(t)
                data["rcin"][f][1].append(getattr(m, f))
        elif ty == "ATT":
            for f in att_f:
                data["att"][f][0].append(t)
                data["att"][f][1].append(getattr(m, f))
    return data


def nearest(ts, vs, t):
    if not ts:
        return None
    i = bisect.bisect_left(ts, t)
    cands = [j for j in (i - 1, i, i + 1) if 0 <= j < len(ts)]
    j = min(cands, key=lambda k: abs(ts[k] - t))
    return vs[j]


for name, path in FILES:
    mlog = mavutil.mavlink_connection(path)
    d = merge(mlog)
    if not d["t"]:
        print(f"\n===== {name}: no MODE records =====")
        continue
    t0 = min(d["t"][0], d["ctun"]["ThO"][0][0] if d["ctun"]["ThO"][0] else d["t"][0])
    print(f"\n===== {name} =====")
    print("MODE changes:")
    for t, mn in zip(d["t"], d["mode"]):
        print("   t=%8.1fs  mode=%2d %s" % ((t - t0) / 1e6, mn, PLANE_MODES.get(mn, "?")))

    # global maxima of throttle channels
    for label, ts, vs in [
        ("RCOU.C1 (tail thr PWM)", d["rcou"]["C1"][0], d["rcou"]["C1"][1]),
        ("RCOU.C10 (VTOL m1 PWM)", d["rcou"]["C10"][0], d["rcou"]["C10"][1]),
        ("CTUN.ThO (%)", d["ctun"]["ThO"][0], d["ctun"]["ThO"][1]),
        ("CTUN.ThD (%)", d["ctun"]["ThD"][0], d["ctun"]["ThD"][1]),
        ("QTUN.ThO", d["qtun"]["ThO"][0], d["qtun"]["ThO"][1]),
        ("QTUN.ThH", d["qtun"]["ThH"][0], d["qtun"]["ThH"][1]),
    ]:
        if vs:
            mx = max(vs)
            i = vs.index(mx)
            print("   MAX %-24s = %8.1f  at t=%8.1fs  mode=%s" % (
                label, mx, (ts[i] - t0) / 1e6, PLANE_MODES.get(nearest(d["t"], d["mode"], ts[i]), "?")))

    # print windows around each mode change that crosses VTOL <-> FW boundary
    prev = None
    for t, mn in zip(d["t"], d["mode"]):
        if prev is not None and ((prev in VTOL_MODES) != (mn in VTOL_MODES)):
            a, b = t - 4_000_000, t + 12_000_000
            print(f"\n--- transition {PLANE_MODES.get(prev)} -> {PLANE_MODES.get(mn)} at t={(t-t0)/1e6:.1f}s ---")
            print("  t(s)  mode     RCOU.C1  RCOU.C10 CTUN.ThO CTUN.ThD  As  SAs  QTUN.ThI QTUN.ThO QTUN.ThH Trn Ast  RCIN.C3  Pitch")
            step = 250_000
            tt = a
            while tt <= b:
                r1 = nearest(d["rcou"]["C1"][0], d["rcou"]["C1"][1], tt)
                r10 = nearest(d["rcou"]["C10"][0], d["rcou"]["C10"][1], tt)
                tho = nearest(d["ctun"]["ThO"][0], d["ctun"]["ThO"][1], tt)
                thd = nearest(d["ctun"]["ThD"][0], d["ctun"]["ThD"][1], tt)
                a_s = nearest(d["ctun"]["As"][0], d["ctun"]["As"][1], tt)
                sas = nearest(d["ctun"]["SAs"][0], d["ctun"]["SAs"][1], tt)
                qi = nearest(d["qtun"]["ThI"][0], d["qtun"]["ThI"][1], tt)
                qo = nearest(d["qtun"]["ThO"][0], d["qtun"]["ThO"][1], tt)
                qh = nearest(d["qtun"]["ThH"][0], d["qtun"]["ThH"][1], tt)
                trn = nearest(d["qtun"]["Trn"][0], d["qtun"]["Trn"][1], tt)
                ast = nearest(d["qtun"]["Ast"][0], d["qtun"]["Ast"][1], tt)
                rc3 = nearest(d["rcin"]["C3"][0], d["rcin"]["C3"][1], tt)
                pit = nearest(d["att"]["Pitch"][0], d["att"]["Pitch"][1], tt)
                mm = PLANE_MODES.get(nearest(d["t"], d["mode"], tt), "?")
                fmt = lambda v, w=8, p=1: ("%*.*f" % (w, p, v)) if v is not None else " " * w
                print("  %6.1f %-8s %s %s %s %s %s %s %s %s %s %s %s %s %s" % (
                    (tt - t0) / 1e6, mm, fmt(r1, 7, 0), fmt(r10, 8, 0), fmt(tho, 8, 1),
                    fmt(thd, 8, 1), fmt(a_s, 5, 1), fmt(sas, 5, 1), fmt(qi, 8, 1),
                    fmt(qo, 8, 1), fmt(qh, 8, 3), fmt(trn, 4, 0), fmt(ast, 4, 0),
                    fmt(rc3, 7, 0), fmt(pit, 6, 1)))
                tt += step
        prev = mn