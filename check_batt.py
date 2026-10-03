from pymavlink import mavutil

FILES = [
    ("00000001.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000001.BIN"),
    ("00000002.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000002.BIN"),
]

KEYS = ["FWD_BAT_IDX", "FWD_BAT_VOLT_MAX", "FWD_BAT_VOLT_MIN",
        "BATT_MONITOR", "BATT_VOLT_MULT", "BATT_CAPACITY", "THR_MAX",
        "TKOFF_THR_MAX", "TKOFF_THR_MIN", "TKOFF_LVL_ALT", "TECS_THR_ERATE",
        "THR_SLEWRATE", "TRIM_THROTTLE", "BATT_WATT_MAX"]

WIN_A, WIN_B = 20.0, 34.0

for name, path in FILES:
    mlog = mavutil.mavlink_connection(path)
    params = {}
    t0 = None
    bat = []
    ctun = []
    while True:
        m = mlog.recv_match(type=["PARM", "BAT", "CTUN", "MODE"])
        if m is None:
            break
        ty = m.get_type()
        if ty == "MODE":
            if t0 is None:
                t0 = m.TimeUS
        elif ty == "CTUN":
            if t0 is not None:
                ctun.append(((m.TimeUS - t0) / 1e6, m.ThO, m.ThD))
        elif ty == "BAT":
            if t0 is not None:
                bat.append(((m.TimeUS - t0) / 1e6, m.Volt, m.Curr))
        elif ty == "PARM":
            if m.Name in KEYS:
                params[m.Name] = m.Value

    print("===== %s =====" % name)
    for k in KEYS:
        print("  %-18s = %s" % (k, params.get(k, "<absent>")))

    print("  %-6s %-8s %-8s | %-6s %-8s %-8s" % ("t", "Volt", "Curr", "t", "ThO", "ThD"))
    step = 0.5
    t = WIN_A
    while t <= WIN_B:
        b = min(bat, key=lambda r: abs(r[0] - t)) if bat else None
        c = min(ctun, key=lambda r: abs(r[0] - t)) if ctun else None
        print("  %-6.1f %-8.2f %-8.1f | %-6.1f %-8.1f %-8.1f" % (
            t, b[1] if b else 0, b[2] if b else 0,
            t, c[1] if c else 0, c[2] if c else 0))
        t += step
    print()