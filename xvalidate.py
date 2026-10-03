import json, os, re, subprocess, sys

BASE = r"e:\azz\20260917-大红翁飞机\ai"
src = open(os.path.join(BASE, "tool_src.html"), encoding="utf-8").read()

# pull the parser function straight out of the tool
m = re.search(r"function DFParse\(buffer, report\) \{.*?\n\}", src, re.S)
if not m:
    print("!! DFParse not found"); sys.exit(1)
parser = m.group(0)

node = """
const fs = require('fs');
%s
const path = process.argv[2], out = process.argv[3];
const b = fs.readFileSync(path);
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const r = DFParse(ab, null);
const att = r.msgs['ATT'];
const mode = r.msgs['MODE'];
const dump = {
  ok: r.ok, duration: r.duration, totalRecords: r.totalRecords,
  names: r.names.length,
  attCount: att ? att.count : 0,
  attTime: att ? Array.from(att.time).map(x => +x.toFixed(4)) : [],
  attPitch: att ? Array.from(att.fields['Pitch']) : [],
  attDes: att ? Array.from(att.fields['DesPitch']) : [],
  modeCount: mode ? mode.count : 0,
  modeT: mode ? Array.from(mode.time).map(x => +x.toFixed(4)) : [],
  modeNum: mode ? Array.from(mode.fields['ModeNum'] || mode.fields['Mode']) : [],
  imuCount: r.msgs['IMU'] ? r.msgs['IMU'].count : 0,
  gpsCount: r.msgs['GPS'] ? r.msgs['GPS'].count : 0,
  baroAlt: r.msgs['BARO'] ? Array.from(r.msgs['BARO'].fields['Alt']).slice(0, 5) : [],
  lat: r.msgs['POS'] ? Array.from(r.msgs['POS'].fields['Lat']).slice(0, 3) : [],
  latType: r.msgs['POS'] ? Object.keys(r.msgs['POS'].fields).join(',') : ''
};
fs.writeFileSync(out, JSON.stringify(dump));
""" % parser

js = os.path.join(BASE, "_xv.js")
open(js, "w", encoding="utf-8").write(node)

from pymavlink import mavutil

for name in ["00000001.BIN", "00000002.BIN"]:
    path = os.path.join(BASE, "APM", "LOGS", name)
    out = os.path.join(BASE, "_xv.json")
    r = subprocess.run(["node", js, path, out], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        print("NODE FAIL", name, r.stderr[-2000:]); continue
    d = json.load(open(out, encoding="utf-8"))

    # --- reference via pymavlink ---
    mlog = mavutil.mavlink_connection(path)
    att = []
    modes = []
    counts = {}
    while True:
        mm = mlog.recv_match()
        if mm is None:
            break
        t = mm.get_type()
        counts[t] = counts.get(t, 0) + 1
        if t == 'ATT':
            att.append((mm.TimeUS, mm.Pitch, mm.DesPitch))
        elif t == 'MODE':
            modes.append((mm.TimeUS, mm.ModeNum))

    print("=" * 72)
    print(name)
    # FMT / FILE 没有 TimeUS 字段，无法作为曲线绘制，解析器按设计跳过
    SKIP = ("FMT", "FILE")
    py_total = sum(v for k, v in counts.items() if k not in SKIP)
    print("  records:  js=%-8d py=%-8d %s" % (d['totalRecords'], py_total,
          "OK" if d['totalRecords'] == py_total else "DIFF"))
    print("  ATT:      js=%-8d py=%-8d %s" % (d['attCount'], counts.get('ATT', 0),
          "OK" if d['attCount'] == counts.get('ATT', 0) else "DIFF"))
    print("  MODE:     js=%-8d py=%-8d %s" % (d['modeCount'], counts.get('MODE', 0),
          "OK" if d['modeCount'] == counts.get('MODE', 0) else "DIFF"))
    print("  IMU:      js=%-8d py=%-8d %s" % (d['imuCount'], counts.get('IMU', 0),
          "OK" if d['imuCount'] == counts.get('IMU', 0) else "DIFF"))
    print("  GPS:      js=%-8d py=%-8d %s" % (d['gpsCount'], counts.get('GPS', 0),
          "OK" if d['gpsCount'] == counts.get('GPS', 0) else "DIFF"))

    # --- field-level comparison ---
    jp, jd, jt = d['attPitch'], d['attDes'], d['attTime']
    pp = [a[1] for a in att]
    pd = [a[2] for a in att]
    print("  pitch  min/max  js=%.4f/%.4f  py=%.4f/%.4f" %
          (min(jp), max(jp), min(pp), max(pp)))
    print("  desp   min/max  js=%.4f/%.4f  py=%.4f/%.4f" %
          (min(jd), max(jd), min(pd), max(pd)))
    emax = max(abs(a - b) for a, b in zip(jp, pp))
    emaxd = max(abs(a - b) for a, b in zip(jd, pd))
    print("  max |js-py| : pitch=%.6f  despitch=%.6f  -> %s" %
          (emax, emaxd, "OK" if emax < 0.011 and emaxd < 0.011 else "DIFF"))

    # time offset must be a constant
    py_t0 = att[0][0]
    js_t0 = jt[0]
    offs = [jt[i] - (att[i][0] - py_t0) / 1e6 for i in range(0, len(jt), 200)]
    print("  time base offset js-first = %.4f s, spread = %.6f s -> %s" %
          (js_t0, max(offs) - min(offs), "CONSTANT" if max(offs) - min(offs) < 1e-3 else "DRIFT"))

    # modes
    print("  mode nums js=%s" % d['modeNum'])
    print("  mode nums py=%s" % [x[1] for x in modes])
    print("  lat sample js=%s  (POS fields: %s)" % (d['lat'], d['latType']))
    print("  BARO.Alt first5 js=%s" % d['baroAlt'])
    print("  duration js=%.1f s" % d['duration'])

os.remove(js)
try: os.remove(os.path.join(BASE, "_xv.json"))
except OSError: pass