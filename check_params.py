from pymavlink import mavutil

FILES = [
    ("00000001.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000001.BIN"),
    ("00000002.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000002.BIN"),
]

KEYS = [
    "THR_MAX", "THR_MIN", "THR_SLEWRATE", "TRIM_THROTTLE",
    "Q_FWD_THR_GAIN", "Q_FWD_THR_USE", "Q_FWD_MANTHR_MAX",
    "Q_OPTIONS", "Q_TRANSITION_MS", "Q_TRAN_PIT_MAX", "Q_TRANS_DECEL",
    "Q_ASSIST_SPEED", "Q_ASSIST_ANGLE", "Q_VFWD_GAIN", "Q_VFWD_ALT",
    "ARSPD_USE", "ARSPD_TYPE", "TECS_SYNAIRSPEED", "AIRSPEED_MIN",
    "AIRSPEED_CRUISE", "AIRSPEED_MAX",
    "SERVO1_FUNCTION", "SERVO1_MIN", "SERVO1_MAX", "SERVO1_TRIM",
    "Q_M_PWM_MIN", "Q_M_PWM_MAX", "Q_M_SPIN_MIN", "Q_M_SPIN_MAX",
    "Q_M_THST_HOVER", "Q_M_HOVER_LEARN",
    "KFF_THR2PTCH", "PTCH_RATE_D", "PTCH_RATE_P", "PTCH_TRIM_DEG",
    "TECS_THR_DAMP", "TECS_TIME_CONST", "TECS_SPDWEIGHT", "TECS_PITCH_MIN",
    "TECS_PITCH_MAX", "TECS_CLMB_MAX", "TECS_INTEG_GAIN",
    "USE_REV_THRUST", "Q_THROTTLE_EXPO", "RC3_TRIM", "RCMAP_THROTTLE",
    "STALL_PREVENTION", "FLIGHT_OPTIONS", "Q_A_THR_MIX_MAN",
]

for name, path in FILES:
    mlog = mavutil.mavlink_connection(path)
    params = {}
    seen = set()
    first = None
    while True:
        m = mlog.recv_match(type=["PARM"])
        if m is None:
            break
        if first is None:
            first = m.TimeUS
        if m.Name in KEYS:
            params[m.Name] = (m.Value, (m.TimeUS - first) / 1e6)
    print("===== %s =====" % name)
    for k in KEYS:
        if k in params:
            v, t = params[k]
            print("  %-20s = %-14s  (t=%.1fs)" % (k, v, t))
        else:
            print("  %-20s = <not in log>" % k)
    print()