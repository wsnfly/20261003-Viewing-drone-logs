import json
import math
from pymavlink import mavutil

PLANE_MODES = {
    0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO",
    5: "FBWA", 6: "FBWB", 7: "CRUISE", 8: "AUTOTUNE", 9: "AUTO",
    10: "RTL", 11: "LOITER", 12: "TAKEOFF", 13: "AVOID_ADSB",
    14: "GUIDED", 15: "INITIALISING", 16: "QSTABILIZE", 17: "QHOVER",
    18: "QLOITER", 19: "QLAND", 20: "QRTL", 21: "QAUTOTUNE", 22: "QACRO",
    23: "THERMAL", 24: "LOITER_ALT_QLAND",
}

FILES = [
    ("00000001.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000001.BIN"),
    ("00000002.BIN", r"e:\azz\20260917-大红翁飞机\ai\APM\LOGS\00000002.BIN"),
]

MAX_POINTS = 7000


def downsample(rows, target):
    n = len(rows)
    if n <= target:
        return rows, 1
    step = int(math.ceil(n / target))
    return rows[::step], step


out = {"logs": []}

for name, path in FILES:
    mlog = mavutil.mavlink_connection(path)
    att = []
    modes = []
    arms = []
    first = None
    while True:
        m = mlog.recv_match(type=['ATT', 'MODE', 'ARM'])
        if m is None:
            break
        t = m.get_type()
        if t == 'ATT':
            if first is None:
                first = m.TimeUS
            att.append(((m.TimeUS - first) / 1e6, m.Pitch, m.DesPitch))
        elif t == 'MODE':
            modes.append(((m.TimeUS - first) / 1e6 if first is not None else 0.0,
                          m.ModeNum, PLANE_MODES.get(m.ModeNum, f"MODE{m.ModeNum}")))
        elif t == 'ARM':
            arms.append(((m.TimeUS - first) / 1e6 if first is not None else 0.0,
                         1 if m.ArmState else 0))

    # modes may have been recorded before the first ATT sample -> clamp to 0
    modes = [(max(0.0, t), n, s) for t, n, s in modes]
    arms = [(max(0.0, t), s) for t, s in arms]

    duration = att[-1][0] if att else 0.0
    # keep the final mode entry covering the tail
    if modes and modes[-1][0] < duration:
        pass
    else:
        modes.append((duration, modes[-1][1] if modes else 0,
                      modes[-1][2] if modes else "UNKNOWN"))

    err = [p - d for _, p, d in att]
    peak = max(att, key=lambda r: abs(r[1])) if att else (0, 0, 0)
    peak_err = max(att, key=lambda r: abs(r[1] - r[2])) if att else (0, 0, 0)
    rms = math.sqrt(sum(e * e for e in err) / len(err)) if err else 0.0
    mae = sum(abs(e) for e in err) / len(err) if err else 0.0

    mode_time = {}
    for i, (t, num, sname) in enumerate(modes):
        t_end = modes[i + 1][0] if i + 1 < len(modes) else duration
        mode_time[sname] = mode_time.get(sname, 0.0) + max(0.0, t_end - t)

    samples, step = downsample(att, MAX_POINTS)
    samples = [[round(t, 2), round(p, 2), round(d, 2)] for t, p, d in samples]

    out["logs"].append({
        "name": name,
        "sample_rate_hz": round(len(att) / duration, 1) if duration else 0,
        "att_count": len(att),
        "duration": round(duration, 1),
        "samples": samples,
        "downsample_step": step,
        "modes": [[round(t, 2), num, sname] for t, num, sname in modes],
        "arms": [[round(t, 2), s] for t, s in arms],
        "stats": {
            "pitch_min": round(min(p for _, p, _ in att), 1) if att else 0,
            "pitch_max": round(max(p for _, p, _ in att), 1) if att else 0,
            "peak_pitch": round(peak[1], 1),
            "peak_pitch_t": round(peak[0], 1),
            "peak_pitch_des": round(peak[2], 1),
            "max_abs_err": round(abs(peak_err[1] - peak_err[2]), 1),
            "max_err_t": round(peak_err[0], 1),
            "rms_err": round(rms, 2),
            "mae": round(mae, 2),
            "mode_time": {k: round(v, 1) for k, v in sorted(mode_time.items(), key=lambda x: -x[1])},
        },
    })

dst = r"e:\azz\20260917-大红翁飞机\ai\log_data.json"
with open(dst, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

print("written", dst)
for lg in out["logs"]:
    print(lg["name"], "dur=%.1fs" % lg["duration"], "att=%d" % lg["att_count"],
          "step=%d" % lg["downsample_step"], "kept=%d" % len(lg["samples"]))
    print("   stats:", lg["stats"])
    print("   modes:", lg["modes"])