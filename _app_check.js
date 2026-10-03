
(function(){
'use strict';

/* =========================================================================
   1. ArduPilot DataFlash (.BIN) 解析器
      自包含函数：会被序列化后放进 Web Worker 里执行
   ========================================================================= */
function DFParse(buffer, report) {
  var u8 = new Uint8Array(buffer);
  var dv = new DataView(buffer);
  var N = u8.length;

  // ArduPilot DataFlash 类型尺寸：c/C 为 16 位定点(×100)，n/N/Z 为定长字符串
  var SIZE  = { b:1, B:1, M:1, n:4, N:16, Z:64,
                h:2, H:2, c:2, C:2, i:4, I:4, e:4, E:4, L:4, f:4, d:8, q:8, Q:8 };
  var SCALE = { c:0.01, C:0.01, e:0.01, E:0.01, L:1e-7 };
  var F32   = { b:1, B:1, C:1, M:1, h:1, H:1, c:1, f:1 };
  var STR   = { n:1, N:1, Z:1 };
  var HDR = 3, FMT_TYPE = 128, FMT_TOTAL = 89;   // FMT 记录固定 89 字节（含 3 字节头）

  var formats = {}, byName = {};
  var t0 = 0, haveT0 = false, sessionMax = null, timeOffset = 0, tLast = 0;

  function readStr(off, len) {
    var s = '', k, c;
    for (k = 0; k < len; k++) {
      c = u8[off + k];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function registerFmt(off) {
    var type = u8[off], len = u8[off + 1];
    var name = readStr(off + 2, 4);
    var fmt  = readStr(off + 6, 16);
    var labels = readStr(off + 22, 64);
    // 新版固件用逗号分隔列名，老版用空格；与 pymavlink 保持一致
    var cols = labels.split(',');
    if (cols.length === 1) cols = labels.split(/\s+/).filter(function (s) { return s.length; });
    var fields = [], o = 0, k, ch, sz, ok = true;
    for (k = 0; k < fmt.length; k++) {
      ch = fmt.charAt(k);
      sz = SIZE[ch];
      if (sz === undefined) { ok = false; break; }
      fields.push({ name: cols[k] || ('F' + k), t: ch, off: o, str: !!STR[ch],
                    scale: SCALE[ch] || 1, f32: !!F32[ch] });
      o += sz;
    }
    if (o !== len - HDR) ok = false;
    var tf = null, ts = 1e-6;
    for (k = 0; k < fields.length; k++) {
      if (fields[k].name === 'TimeUS') { tf = fields[k]; ts = 1e-6; break; }
      if (fields[k].name === 'TimeMS') { tf = fields[k]; ts = 1e-3; break; }
    }
    var f = { type: type, len: len, name: name, fields: fields,
              timeField: tf, timeScale: ts, storable: ok && !!tf };
    formats[type] = f;
    if (name) byName[name] = f;
  }

  function num(off, fl) {
    switch (fl.t) {
      case 'b': return dv.getInt8(off);
      case 'B': return dv.getUint8(off);
      case 'C': return dv.getUint16(off, true);   // C = uint16 厘度（yaw 最大 36000 必须按无符号 16 位读）
      case 'M': return dv.getUint8(off);
      case 'h': return dv.getInt16(off, true);
      case 'H': return dv.getUint16(off, true);
      case 'c': return dv.getInt16(off, true);
      case 'i': return dv.getInt32(off, true);
      case 'I': return dv.getUint32(off, true);
      case 'e': return dv.getInt32(off, true);
      case 'E': return dv.getUint32(off, true);
      case 'L': return dv.getInt32(off, true);
      case 'f': return dv.getFloat32(off, true);
      case 'd': return dv.getFloat64(off, true);
      case 'q': return Number(dv.getBigInt64(off, true));
      case 'Q': return Number(dv.getBigUint64(off, true));
    }
    return 0;
  }

  function scan(pass, counts, out) {
    var i = 0, iter = 0, type, f, rec, k, fl, j, base, tus, t;
    while (i + 3 <= N) {
      if (u8[i] !== 0xA3 || u8[i + 1] !== 0x95) { i++; continue; }
      type = u8[i + 2];
      // FMT 记录必须优先处理：它自己也是 89 字节定长，且不能走通用长度分支
      if (type === FMT_TYPE) { if (i + FMT_TOTAL > N) break; registerFmt(i + 3); i += FMT_TOTAL; continue; }
      f = formats[type];
      if (f === undefined) { i++; continue; }
      if (i + f.len > N) break;            // 文件末尾被截断的记录
      if (f.storable) {
        base = i + 3;
        if (pass === 1) {
          counts[f.name] = (counts[f.name] || 0) + 1;
          if (!haveT0) {
            t0 = num(base + f.timeField.off, f.timeField) * f.timeScale * 1e6;
            haveT0 = true;
          }
        } else {
          rec = out[f.name]; k = rec.n;
          for (j = 0; j < f.fields.length; j++) {
            fl = f.fields[j];
            if (fl.str) continue;
            rec.fields[fl.name][k] = num(base + fl.off, fl) * fl.scale;
          }
          tus = num(base + f.timeField.off, f.timeField) * f.timeScale * 1e6;
          if (sessionMax === null) sessionMax = tus;
          else if (tus < sessionMax - 1000000) { timeOffset += sessionMax - tus; sessionMax = tus; }
          else if (tus > sessionMax) sessionMax = tus;
          t = (tus + timeOffset - t0) / 1e6;
          rec.time[k] = t;
          rec.n = k + 1;
          if (t > tLast) tLast = t;
        }
      }
      i += f.len;
      if ((++iter & 0x7FFF) === 0 && report) report(pass === 1 ? i / N * 0.45 : 0.45 + i / N * 0.55);
    }
  }

  var counts = {}, out = {}, name, j, fl, c, f2;
  scan(1, counts, null);

  var totalRecords = 0;
  for (name in counts) {
    c = counts[name];
    if (!c) continue;
    totalRecords += c;
    f2 = byName[name];
    var rec = { n: 0, count: c, time: new Float64Array(c), fields: {} };
    for (j = 0; j < f2.fields.length; j++) {
      fl = f2.fields[j];
      if (fl.str) continue;
      rec.fields[fl.name] = fl.f32 ? new Float32Array(c) : new Float64Array(c);
    }
    out[name] = rec;
  }

  sessionMax = null; timeOffset = 0;
  scan(2, null, out);

  var msgs = {}, list = [];
  for (name in out) {
    var r = out[name];
    if (!r.n) continue;
    var fields = {};
    for (var fn in r.fields) fields[fn] = r.fields[fn].subarray(0, r.n);
    msgs[name] = { name: name, count: r.n, time: r.time.subarray(0, r.n), fields: fields };
    list.push(name);
  }
  list.sort();
  if (report) report(1);

  return {
    ok: list.length > 0,
    t0: t0,
    duration: tLast,
    totalRecords: totalRecords,
    msgs: msgs,
    names: list
  };
}

/* =========================================================================
   2. Web Worker（由上面的解析函数生成，保持单文件）
   ========================================================================= */
// 必须是 var 声明：直接写 "(function DFParse(){})" 只是具名函数表达式，
// 名字只在自身作用域内可见，Worker 顶层拿不到 DFParse
var workerCode = 'var DFParse = ' + DFParse.toString() + ';\n' + [
  'self.onmessage = function(e){',
  '  var d = e.data;',
  '  if (!d || d.cmd !== "parse") return;',
  '  try {',
  '    var r = DFParse(d.buffer, function(p){ self.postMessage({type:"progress", id:d.id, p:p}); });',
  '    self.postMessage({type:"done", id:d.id, result:r});',
  '  } catch (err) {',
  '    self.postMessage({type:"error", id:d.id, message:String((err && err.message) || err)});',
  '  }',
  '};'
].join('\n');

var worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));

/* =========================================================================
   3. 状态与常量
   ========================================================================= */
var PALETTE = ['#f4553d', '#3b8cff', '#3ddc97', '#ffb020', '#c084fc', '#22d3ee',
               '#f472b6', '#a3e635', '#fb923c', '#818cf8', '#2dd4bf', '#e879f9'];
var MODE_NAME = {
  0:'MANUAL', 1:'CIRCLE', 2:'STABILIZE', 3:'TRAINING', 4:'ACRO', 5:'FBWA', 6:'FBWB',
  7:'CRUISE', 8:'AUTOTUNE', 9:'AUTO', 10:'RTL', 11:'LOITER', 12:'TAKEOFF', 13:'AVOID_ADSB',
  14:'GUIDED', 15:'INITIALISING', 16:'QSTABILIZE', 17:'QHOVER', 18:'QLOITER', 19:'QLAND',
  20:'QRTL', 21:'QAUTOTUNE', 22:'QACRO', 23:'THERMAL', 24:'LOITER_ALT_QLAND'
};
var MODE_COLOR = {
  QLAND:'#f59e0b', CRUISE:'#6366f1', QHOVER:'#10b981', QLOITER:'#06b6d4',
  QSTABILIZE:'#a855f7', QRTL:'#ef4444', AUTO:'#8b5cf6', LOITER:'#14b8a6',
  RTL:'#f97316', FBWA:'#84cc16', MANUAL:'#94a3b8'
};

var logs = [];        // {id,name,size,msgs,names,duration,totalRecords,visible,offset,color}
var seriesList = [];  // {id,logId,msg,field,axisKey,visible,color}
var ptsCache = {};    // 降采样结果缓存，拖动 Y 轴滑块时不必重复计算
var seqId = 0;
var busy = false;
var pending = 0;

/* Y 轴注册表：键即 ECharts 的 yAxis 下标顺序来源。
   L / R 是共享轴，始终存在；独立轴以 'S<曲线 id>' 为键，随曲线增删。 */
var AXIS_STEP = 58;                 // 同侧相邻轴的像素间距
var ZOOM_SLIDER = [0.1, 5, 0.05];   // 滑块量程/步长（数字框可超出）
var OFF_SLIDER = [-2, 2, 0.02];
function newAxes() {
  return { L: { key: 'L', side: 'left', shared: true, zoom: 1, off: 0 },
           R: { key: 'R', side: 'right', shared: true, zoom: 1, off: 0 } };
}
var axes = newAxes();

var $ = function (id) { return document.getElementById(id); };
var chart = null;

/* =========================================================================
   4. 工具函数
   ========================================================================= */
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtTime(s) {
  if (!isFinite(s)) return '—';
  var m = Math.floor(s / 60), x = Math.floor(s % 60);
  return m + ':' + (x < 10 ? '0' : '') + x;
}
function fmtVal(v) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  var a = Math.abs(v);
  if (a >= 10000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
function baseName(n) { return n.replace(/\.(bin|BIN|log|LOG)$/, ''); }

/* 分桶极值降采样：保留每段的最大/最小值，避免丢失尖峰 */
function downsample(time, vals, offset, maxPts) {
  var n = time.length, out, i, v;
  if (!maxPts || n <= maxPts) {
    out = new Array(n);
    for (i = 0; i < n; i++) {
      v = vals[i];
      out[i] = [time[i] + offset, isFinite(v) ? v : null];
    }
    return out;
  }
  var buckets = Math.max(1, Math.floor(maxPts / 2));
  var step = n / buckets;
  out = [];
  for (var b = 0; b < buckets; b++) {
    var s = Math.floor(b * step), e = Math.floor((b + 1) * step);
    if (e > n) e = n;
    if (e <= s) continue;
    var mn = s, mx = s;
    for (i = s + 1; i < e; i++) {
      if (vals[i] < vals[mn]) mn = i;
      if (vals[i] > vals[mx]) mx = i;
    }
    if (mn === mx) {
      v = vals[mn];
      out.push([time[mn] + offset, isFinite(v) ? v : null]);
    } else if (mn < mx) {
      out.push([time[mn] + offset, isFinite(vals[mn]) ? vals[mn] : null],
               [time[mx] + offset, isFinite(vals[mx]) ? vals[mx] : null]);
    } else {
      out.push([time[mx] + offset, isFinite(vals[mx]) ? vals[mx] : null],
               [time[mn] + offset, isFinite(vals[mn]) ? vals[mn] : null]);
    }
  }
  return out;
}

/* 降采样结果按「曲线 id + 采样上限 + 时间偏移」缓存，避免拖动 Y 轴滑块时反复重算 */
function cachedPts(s, lg, m, f, maxPts) {
  var key = s.id + '|' + maxPts + '|' + lg.offset;
  var c = ptsCache[key];
  if (!c) {
    if (Object.keys(ptsCache).length > 40) ptsCache = {};
    c = downsample(m.time, f, lg.offset, maxPts);
    ptsCache[key] = c;
  }
  return c;
}
function invalidatePts() { ptsCache = {}; }

/* =========================================================================
   4b. Y 轴管理（共享左/右轴 + 每条曲线的独立轴）
   ========================================================================= */
/* 输出顺序 = ECharts yAxis 下标顺序：共享左轴、共享右轴，然后是各独立轴 */
function axisKeys() {
  return ['L', 'R'].concat(Object.keys(axes).filter(function (k) { return !axes[k].shared; }));
}
function isIndep(s) { return s.axisKey !== 'L' && s.axisKey !== 'R'; }
function indepKey(s) { return 'S' + s.id; }

/* 独立轴左右分配：优先放在数量较少的一侧，避免单侧堆叠过长 */
function pickSide() {
  var L = 0, R = 0;
  Object.keys(axes).forEach(function (k) {
    if (axes[k].shared) return;
    if (axes[k].side === 'left') L++; else R++;
  });
  return L <= R ? 'left' : 'right';
}

function ensureAxis(s) {
  if (!isIndep(s)) return;
  if (!axes[s.axisKey]) {
    axes[s.axisKey] = { key: s.axisKey, side: pickSide(), shared: false, zoom: 1, off: 0 };
  }
}

/* 曲线被删除或切回共享轴后，回收无人使用的独立轴 */
function pruneAxes() {
  var keep = {};
  seriesList.forEach(function (s) { keep[s.axisKey] = 1; });
  Object.keys(axes).forEach(function (k) {
    if (!axes[k].shared && !keep[k]) delete axes[k];
  });
}

function axisColor(k) {
  if (axes[k] && axes[k].shared) return k === 'L' ? '#5b8def' : '#ffb020';
  var s = seriesList.filter(function (x) { return x.axisKey === k; })[0];
  return s ? s.color : '#94a3b8';
}

/* 轴标题取该轴上的字段名，过长则截断，避免挤压绘图区 */
function axisName(k, owners) {
  var n = (owners && owners[k]) || [];
  if (!n.length) return '';
  var t = n.slice(0, 2).join('/') + (n.length > 2 ? ' 等' : '');
  return t.length > 14 ? t.slice(0, 13) + '…' : t;
}

function fmtNum(v) { return String(Math.round(v * 1e4) / 1e4); }

/* 把轴上的 zoom/off 同步到滑块、数字框与数值标签。
   正在输入的数字框不覆写，否则光标会被打断。 */
function syncBoxInputs(box, a, force) {
  [['zoom', ZOOM_SLIDER, '×'], ['off', OFF_SLIDER, '']].forEach(function (d) {
    var prop = d[0], cfg = d[1], pre = d[2], val = a[prop];
    var sl = box.querySelector('[data-role="slider-' + prop + '"]');
    var nm = box.querySelector('[data-role="num-' + prop + '"]');
    var lb = box.querySelector('[data-role="val-' + prop + '"]');
    if (lb) lb.textContent = pre + (prop === 'zoom' ? val.toFixed(2)
                                 : (val > 0 ? '+' : '') + val.toFixed(2));
    if (sl) sl.value = Math.max(cfg[0], Math.min(cfg[1], val));
    if (nm && (force || document.activeElement !== nm)) nm.value = fmtNum(val);
  });
}

/* 一行「滑块 + 数字框」控件 */
function makeAxisCtl(box, k, prop, label) {
  var a = axes[k], isZoom = prop === 'zoom';
  var cfg = isZoom ? ZOOM_SLIDER : OFF_SLIDER;

  var ctl = document.createElement('div');
  ctl.className = 'adjctl';
  var top = document.createElement('div');
  top.className = 'adjctl-top';
  var lb = document.createElement('span');
  lb.textContent = label;
  var val = document.createElement('span');
  val.className = 'adjval';
  val.dataset.role = 'val-' + prop;
  top.appendChild(lb); top.appendChild(val);

  var row = document.createElement('div');
  row.className = 'adjrow';
  var rg = document.createElement('input');
  rg.type = 'range';
  rg.min = cfg[0]; rg.max = cfg[1]; rg.step = cfg[2];
  rg.dataset.role = 'slider-' + prop;
  rg.oninput = function () {
    var v = parseFloat(this.value);
    if (!isFinite(v) || (isZoom && !(v > 0))) return;
    a[prop] = v;
    syncBoxInputs(box, a, false);
    updateChart();
  };
  var nm = document.createElement('input');
  nm.type = 'number';
  nm.className = 'adjnum';
  nm.step = cfg[2];
  nm.dataset.role = 'num-' + prop;
  nm.title = isZoom ? '缩放比例：<1 放大细节，>1 压缩' : '偏移：单位=该轴数据跨度';
  nm.oninput = function () {
    var v = parseFloat(this.value);
    if (!isFinite(v) || (isZoom && !(v > 0))) return;
    a[prop] = v;
    syncBoxInputs(box, a, false);
    updateChart();
  };
  // 失焦时把被拒绝的输入（空值、非正缩放）回写成实际生效的数值
  nm.onchange = function () { syncBoxInputs(box, a, true); };
  row.appendChild(rg); row.appendChild(nm);
  ctl.appendChild(top); ctl.appendChild(row);
  return ctl;
}

function makeAxisBox(k) {
  var a = axes[k];
  var box = document.createElement('div');
  box.className = 'adjbox';
  box.dataset.axis = k;

  var hd = document.createElement('div');
  hd.className = 'adjhd';
  var tag = document.createElement('span');
  tag.className = 'adjtag';
  var dot = document.createElement('i');
  dot.dataset.role = 'dot';
  var ttl = document.createElement('span');
  ttl.dataset.role = 'title';
  ttl.textContent = a.shared ? (a.side === 'left' ? '左轴' : '右轴') : '独立轴';
  var own = document.createElement('span');
  own.className = 'adjowner';
  own.dataset.role = 'owner';
  tag.appendChild(dot); tag.appendChild(ttl); tag.appendChild(own);
  hd.appendChild(tag);

  var acts = document.createElement('span');
  acts.className = 'adjacts';
  if (!a.shared) {
    var side = document.createElement('button');
    side.className = 'axisbtn';
    side.dataset.act = 'side';
    side.title = '把该独立轴换到另一侧';
    side.textContent = a.side === 'left' ? '左' : '右';
    side.onclick = function () {
      a.side = a.side === 'left' ? 'right' : 'left';
      renderAxisBoxes(); updateChart();
    };
    acts.appendChild(side);
  }
  var rst = document.createElement('button');
  rst.className = 'axisbtn';
  rst.dataset.act = 'reset';
  rst.textContent = '重置';
  rst.onclick = function () {
    a.zoom = 1; a.off = 0;
    syncBoxInputs(box, a, true);
    updateChart();
  };
  acts.appendChild(rst);
  hd.appendChild(acts);
  box.appendChild(hd);

  box.appendChild(makeAxisCtl(box, k, 'zoom', '缩放比例'));
  box.appendChild(makeAxisCtl(box, k, 'off', '偏移'));
  var rng = document.createElement('div');
  rng.className = 'adjrange';
  rng.dataset.role = 'range';
  rng.textContent = '—';
  box.appendChild(rng);
  return box;
}

/* 轴集合变化时重建面板（增删独立轴、切换左右） */
function renderAxisBoxes() {
  var panel = $('adjBoxes');
  panel.textContent = '';
  axisKeys().forEach(function (k) { panel.appendChild(makeAxisBox(k)); });
}

/* 每次出图只更新数值、范围读数与可用状态，不重建 DOM */
function updateAxisUI(bnd, used, owners) {
  var panel = $('adjBoxes');
  axisKeys().forEach(function (k) {
    var box = panel.querySelector('[data-axis="' + k + '"]');
    if (!box) return;
    var a = axes[k], dead = !used[k];
    syncBoxInputs(box, a, false);
    box.classList.toggle('off', dead);
    Array.prototype.forEach.call(box.querySelectorAll('input,button'), function (el) {
      el.disabled = dead;
    });
    var dot = box.querySelector('[data-role="dot"]');
    if (dot) dot.style.background = dead ? '#46536e' : axisColor(k);
    var own = box.querySelector('[data-role="owner"]');
    if (own) own.textContent = (owners && owners[k] ? owners[k] : []).join(' · ');
    var line = box.querySelector('[data-role="range"]');
    if (!line) return;
    var b = bnd ? bnd[k] : null;
    if (!b) line.textContent = '该轴暂无曲线';
    else if (b.auto) line.textContent = '自动 ≈ ' + fmtVal(b.bmin) + ' ~ ' + fmtVal(b.bmax);
    else line.textContent = '当前 ' + fmtVal(b.min) + ' ~ ' + fmtVal(b.max) +
                            '  (原始 ' + fmtVal(b.bmin) + ' ~ ' + fmtVal(b.bmax) + ')';
  });
}

/* =========================================================================
   5. 日志导入
   ========================================================================= */
function handleFiles(files) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  list.forEach(function (file) {
    var reader = new FileReader();
    var id = ++seqId;
    pending++;
    showProgress(true, '读取 ' + file.name + ' …', 0);
    reader.onload = function () {
      var buf = reader.result;
      busy = true;
      setStatus('解析 ' + file.name + ' …');
      var onMsg = function (e) {
        var d = e.data;
        if (d.id !== id) return;
        if (d.type === 'progress') {
          showProgress(true, '解析 ' + file.name + ' …', d.p);
        } else if (d.type === 'done') {
          worker.removeEventListener('message', onMsg);
          pending--;
          if (!d.result.ok) {
            setStatus('未在 ' + file.name + ' 中找到 DataFlash 数据（请确认是 ArduPilot .BIN 日志）');
            showProgress(false);
            busy = false;
            return;
          }
          addLog(file, d.result);
          showProgress(false);
          busy = false;
          setStatus('已加载 ' + logs.length + ' 个日志');
        } else if (d.type === 'error') {
          worker.removeEventListener('message', onMsg);
          pending--;
          showProgress(false);
          busy = false;
          setStatus('解析 ' + file.name + ' 失败：' + d.message);
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ cmd: 'parse', id: id, buffer: buf }, [buf]);
    };
    reader.onerror = function () {
      pending--;
      showProgress(false);
      setStatus('读取 ' + file.name + ' 失败');
    };
    reader.readAsArrayBuffer(file);
  });
}

function addLog(file, res) {
  invalidatePts();
  var log = {
    id: ++seqId,
    name: file.name,
    size: file.size,
    msgs: res.msgs,
    names: res.names,
    duration: res.duration,
    totalRecords: res.totalRecords,
    visible: true,
    offset: 0,
    color: PALETTE[logs.length % PALETTE.length]
  };
  logs.push(log);
  renderLogs();
  refreshLogSelect();
  refreshMsgSelect();
  refreshEmpty();
  refresh3DLogSel();
  if (is3DView()) enter3D();
}

function showProgress(on, text, p) {
  $('progress').hidden = !on;
  if (!on) return;
  if (text) $('ptext').textContent = text;
  $('bar').style.width = Math.max(0, Math.min(100, (p || 0) * 100)).toFixed(1) + '%';
}
function setStatus(t) { $('status').textContent = t || ''; }
function refreshEmpty() { $('empty').style.display = logs.length ? 'none' : 'flex'; }

/* =========================================================================
   6. 左侧面板渲染（全部使用 DOM API，避免日志字段名带来的注入风险）
   ========================================================================= */
function renderLogs() {
  var box = $('logList');
  box.textContent = '';
  if (!logs.length) {
    var p = document.createElement('div');
    p.className = 'empty-hint';
    p.textContent = '还没有日志。支持同时导入多个 .BIN 文件。';
    box.appendChild(p);
    return;
  }
  logs.forEach(function (log) {
    var it = document.createElement('div');
    it.className = 'logitem';

    var r1 = document.createElement('div');
    r1.className = 'r1';
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = log.color;
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = log.name;
    nm.title = log.name;
    var eye = document.createElement('button');
    eye.className = 'icon' + (log.visible ? ' on' : '');
    eye.textContent = log.visible ? '◉' : '○';
    eye.title = log.visible ? '隐藏该日志' : '显示该日志';
    eye.onclick = function () { log.visible = !log.visible; renderLogs(); refreshLogSelect(); refreshMsgSelect(); updateChart(); };
    var del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = '移除该日志';
    del.onclick = function () { removeLog(log.id); };
    r1.appendChild(dot); r1.appendChild(nm); r1.appendChild(eye); r1.appendChild(del);

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = fmtBytes(log.size) + ' · ' + fmtTime(log.duration) +
      ' · ' + log.totalRecords.toLocaleString() + ' 条记录 · ' + log.names.length + ' 种消息';

    var r2 = document.createElement('div');
    r2.className = 'r2';
    var lb = document.createElement('label');
    lb.textContent = '时间偏移 (s)';
    var off = document.createElement('input');
    off.type = 'number';
    off.step = '0.1';
    off.value = log.offset;
    off.title = '用于对齐多个架次的曲线';
    off.oninput = function () {
      var v = parseFloat(off.value);
      log.offset = isFinite(v) ? v : 0;
      invalidatePts();
      updateChart();
    };
    r2.appendChild(lb); r2.appendChild(off);

    it.appendChild(r1); it.appendChild(meta); it.appendChild(r2);
    box.appendChild(it);
  });
}

function removeLog(id) {
  invalidatePts();
  logs = logs.filter(function (l) { return l.id !== id; });
  seriesList = seriesList.filter(function (s) { return s.logId !== id; });
  Object.keys(trackCache).forEach(function (k) {
    if (k.indexOf(id + '|') === 0) delete trackCache[k];
  });
  if (track && track.logId === id) track = null;
  pruneAxes();
  renderLogs(); renderSeries(); refreshLogSelect(); refreshMsgSelect(); refreshEmpty();
  renderAxisBoxes();
  refresh3DLogSel();
  if (is3DView()) enter3D();
  updateChart();
}

function visibleLogs() { return logs.filter(function (l) { return l.visible; }); }

function refreshLogSelect() {
  var sel = $('selLog');
  var prev = sel.value;
  sel.textContent = '';
  var o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = '全部可见日志（同一字段叠加对比）';
  sel.appendChild(o0);
  visibleLogs().forEach(function (l) {
    var o = document.createElement('option');
    o.value = String(l.id);
    o.textContent = l.name;
    sel.appendChild(o);
  });
  var keep = false;
  for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === prev) keep = true;
  sel.value = keep ? prev : '';
}

function currentMsgSet() {
  var v = $('selLog').value;
  var set = {};
  if (v) {
    var lg = logs.filter(function (l) { return String(l.id) === v; })[0];
    if (lg) lg.names.forEach(function (n) { set[n] = (set[n] || 0) + lg.msgs[n].count; });
  } else {
    visibleLogs().forEach(function (l) {
      l.names.forEach(function (n) { set[n] = (set[n] || 0) + l.msgs[n].count; });
    });
  }
  return set;
}

function refreshMsgSelect() {
  var sel = $('selMsg');
  var prev = sel.value;
  var q = $('msgSearch').value.trim().toUpperCase();
  var set = currentMsgSet();
  var names = Object.keys(set).sort();
  sel.textContent = '';
  names.forEach(function (n) {
    if (q && n.toUpperCase().indexOf(q) < 0) return;
    var o = document.createElement('option');
    o.value = n;
    o.textContent = n + '  (' + set[n].toLocaleString() + ')';
    sel.appendChild(o);
  });
  var keep = false;
  for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === prev) keep = true;
  if (keep) sel.value = prev;
  else if (sel.options.length) sel.selectedIndex = 0;
  refreshFieldList();
}

function currentMsgName() {
  var sel = $('selMsg');
  return sel.value || '';
}

/* 收集某消息类型在所有可见日志中的数值字段（取并集） */
function fieldsFor(msgName, log) {
  var m = log.msgs[msgName];
  if (!m) return [];
  var out = [];
  for (var fn in m.fields) if (fn !== 'TimeUS' && fn !== 'TimeMS') out.push(fn);
  out.sort();
  return out;
}

function refreshFieldList() {
  var box = $('fieldList');
  var prevChecked = {};
  Array.prototype.forEach.call(box.querySelectorAll('input[type=checkbox]'), function (c) {
    if (c.checked) prevChecked[c.value] = 1;
  });
  box.textContent = '';
  var msg = currentMsgName();
  if (!msg) {
    var p = document.createElement('div');
    p.className = 'empty-hint';
    p.textContent = '请先选择消息类型。';
    box.appendChild(p);
    $('btnAdd').disabled = true;
    return;
  }
  var set = {};
  var v = $('selLog').value;
  var targets = v ? logs.filter(function (l) { return String(l.id) === v; }) : visibleLogs();
  targets.forEach(function (l) {
    fieldsFor(msg, l).forEach(function (f) { set[f] = 1; });
  });
  var q = $('fieldSearch').value.trim().toUpperCase();
  var names = Object.keys(set).sort();
  var shown = 0;
  names.forEach(function (f) {
    if (q && f.toUpperCase().indexOf(q) < 0) return;
    shown++;
    var lab = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = f;
    if (prevChecked[f]) cb.checked = true;
    var sp = document.createElement('span');
    sp.textContent = f;
    lab.appendChild(cb); lab.appendChild(sp);
    box.appendChild(lab);
  });
  if (!shown) {
    var e = document.createElement('div');
    e.className = 'empty-hint';
    e.textContent = '没有匹配的字段。';
    box.appendChild(e);
  }
  $('btnAdd').disabled = shown === 0;
}

/* =========================================================================
   7. 曲线管理
   ========================================================================= */
function addSeries() {
  var msg = currentMsgName();
  if (!msg) return;
  var box = $('fieldList');
  var picked = [];
  Array.prototype.forEach.call(box.querySelectorAll('input[type=checkbox]'), function (c) {
    if (c.checked) picked.push(c.value);
  });
  if (!picked.length) return;
  var v = $('selLog').value;
  var targets = v ? logs.filter(function (l) { return String(l.id) === v; }) : visibleLogs();

  var added = 0;
  targets.forEach(function (l) {
    picked.forEach(function (f) {
      if (!l.msgs[msg] || !l.msgs[msg].fields[f]) return;
      var dup = seriesList.some(function (s) {
        return s.logId === l.id && s.msg === msg && s.field === f;
      });
      if (dup) return;
      seriesList.push({
        id: ++seqId, logId: l.id, msg: msg, field: f, axisKey: 'L', visible: true,
        color: PALETTE[seriesList.length % PALETTE.length]
      });
      added++;
    });
  });
  if (!added) { setStatus('这些参数已经添加过了'); return; }
  setStatus('已添加 ' + added + ' 条曲线');
  renderSeries();
  updateChart();
}

function renderSeries() {
  var box = $('seriesList');
  box.textContent = '';
  if (!seriesList.length) {
    var p = document.createElement('div');
    p.className = 'empty-hint';
    p.textContent = '还没有曲线。在上方选择消息类型与字段后点击「添加为曲线」。';
    box.appendChild(p);
    return;
  }
  seriesList.forEach(function (s) {
    var lg = logs.filter(function (l) { return l.id === s.logId; })[0];
    var it = document.createElement('div');
    it.className = 'seriesitem';

    var r1 = document.createElement('div');
    r1.className = 'r1';
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = s.color;
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.style.flex = '1';
    nm.style.overflow = 'hidden';
    nm.style.textOverflow = 'ellipsis';
    nm.style.whiteSpace = 'nowrap';
    nm.textContent = (lg ? baseName(lg.name) : '?') + ' · ' + s.msg + '.' + s.field;
    nm.title = nm.textContent;

    var ax = document.createElement('select');
    ax.className = 'axsel';
    ax.title = '选择该曲线使用的 Y 轴：左轴 / 右轴 / 独立轴';
    [['L', '左轴'], ['R', '右轴'], [indepKey(s), '独立']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      ax.appendChild(op);
    });
    ax.value = s.axisKey;
    ax.onchange = function () {
      s.axisKey = this.value;
      ensureAxis(s);
      pruneAxes();
      renderAxisBoxes();
      updateChart();
    };

    var eye = document.createElement('button');
    eye.className = 'icon' + (s.visible ? ' on' : '');
    eye.textContent = s.visible ? '◉' : '○';
    eye.title = '显示/隐藏';
    eye.onclick = function () { s.visible = !s.visible; renderSeries(); updateChart(); };

    var del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = '删除该曲线';
    del.onclick = function () {
      seriesList = seriesList.filter(function (x) { return x.id !== s.id; });
      pruneAxes();
      renderAxisBoxes();
      renderSeries(); updateChart();
    };

    r1.appendChild(dot); r1.appendChild(nm); r1.appendChild(ax); r1.appendChild(eye); r1.appendChild(del);
    it.appendChild(r1);
    box.appendChild(it);
  });
}

/* =========================================================================
   8. 飞行模式色带
   ========================================================================= */
function modeSegments(log) {
  var m = log.msgs['MODE'];
  if (!m) return null;
  var fn = m.fields['ModeNum'] ? 'ModeNum' : (m.fields['Mode'] ? 'Mode' : null);
  if (!fn) return null;
  var t = m.time, v = m.fields[fn], segs = [];
  for (var i = 0; i < m.count; i++) {
    var tEnd = (i + 1 < m.count) ? t[i + 1] : log.duration;
    if (tEnd > t[i]) {
      var nm = MODE_NAME[v[i]] || ('MODE' + v[i]);
      segs.push({ start: t[i] + log.offset, end: tEnd + log.offset, name: nm });
    }
  }
  return segs;
}
function modeColor(n) { return MODE_COLOR[n] || '#94a3b8'; }

/* =========================================================================
   9. 图表
   ========================================================================= */
function ensureChart() {
  if (chart) return chart;
  chart = echarts.init($('chart'), null, { renderer: 'canvas' });
  /* 拖动下方的时间缩放滑块 / 滚轮缩放 = 切割时间线，同步到 3D 回放区间 */
  if (chart && typeof chart.on === 'function') {
    chart.on('dataZoom', function () { scheduleRangeSync(); });
  }
  window.addEventListener('resize', function () { if (chart) chart.resize(); });
  return chart;
}

/* 刷新 Y 轴调节面板：数值标签、当前范围、各轴是否可用 —— 见 updateAxisUI */

function updateChart() {
  var vis = seriesList.filter(function (s) {
    if (!s.visible) return false;
    var lg = logs.filter(function (l) { return l.id === s.logId; })[0];
    return lg && lg.visible;
  });
  var el = ensureChart();
  if (!vis.length) {
    el.clear();
    updateAxisUI(null, {}, {});
    scheduleRangeSync();
    return;
  }
  var maxPts = parseInt($('optMax').value, 10) || 0;
  var showModes = $('optMode').checked;

  var prevZoom = null;
  try {
    var o = el.getOption();
    /* 多个 dataZoom（inside + slider）取交集 = 图上实际显示的窗口 */
    if (o && o.dataZoom && o.dataZoom.length) {
      var ps = -Infinity, pe = Infinity;
      for (var zi = 0; zi < o.dataZoom.length; zi++) {
        var d0 = o.dataZoom[zi];
        var za = isFinite(d0.start) ? d0.start : 0, zb = isFinite(d0.end) ? d0.end : 100;
        if (za > ps) ps = za;
        if (zb < pe) pe = zb;
      }
      if (pe > ps) prevZoom = [ps, pe];
    }
  } catch (e) { /* 首次渲染 */ }

  var used = {}, owners = {}, baseRange = {};   // 按轴键索引
  var out = [];
  var modeOwner = null;

  vis.forEach(function (s) {
    var lg = logs.filter(function (l) { return l.id === s.logId; })[0];
    var m = lg.msgs[s.msg];
    var f = m.fields[s.field];
    var pts = cachedPts(s, lg, m, f, maxPts);
    var k = s.axisKey;
    used[k] = true;
    var on = owners[k] || (owners[k] = []);
    if (on.indexOf(s.field) < 0) on.push(s.field);
    // 分桶极值降采样保留了全局最大/最小值，直接取用即可
    var br = baseRange[k] || (baseRange[k] = [null, null]), vv;
    for (var pi = 0; pi < pts.length; pi++) {
      vv = pts[pi][1];
      if (vv === null) continue;
      if (br[0] === null || vv < br[0]) br[0] = vv;
      if (br[1] === null || vv > br[1]) br[1] = vv;
    }
    out.push({
      name: baseName(lg.name) + ' · ' + s.msg + '.' + s.field,
      type: 'line', data: pts, showSymbol: false,
      lineStyle: { width: 1.6, color: s.color }, itemStyle: { color: s.color },
      yAxisIndex: 0, z: 3, emphasis: { focus: 'series' }, connectNulls: false,
      _axisKey: k
    });
    if (modeOwner === null && lg.msgs['MODE']) modeOwner = lg;
  });

  if (showModes && modeOwner) {
    var segs = modeSegments(modeOwner);
    if (segs && segs.length) {
      /* 段太窄时藏掉模式名，避免几十个标签叠成一团 */
      var segT0 = Infinity, segT1 = -Infinity;
      segs.forEach(function (g) {
        if (g.start < segT0) segT0 = g.start;
        if (g.end > segT1) segT1 = g.end;
      });
      var minNameSpan = Math.max(1e-6, (segT1 - segT0) / 40);
      out[0].markArea = {
        silent: true,
        data: segs.map(function (g) {
          return [{ name: g.name, xAxis: g.start,
                    label: { show: (g.end - g.start) >= minNameSpan, color: '#96a7c4', fontSize: 10 },
                    itemStyle: { color: modeColor(g.name), opacity: 0.10 } },
                  { xAxis: g.end }];
        })
      };
      out[0].markLine = {
        silent: true, symbol: 'none',
        label: { show: false },        // 分隔虚线只画线，不标时间（否则顶部全是叠字）
        lineStyle: { color: 'rgba(255,255,255,.20)', type: 'dashed', width: 1 },
        data: segs.slice(1).map(function (g) { return { xAxis: g.start }; })
      };
    }
  }
  /* 曲线 -> ECharts yAxis 下标：顺序与 axisKeys() 一致，下标保持稳定 */
  var keys = axisKeys();
  var keyIndex = {};
  keys.forEach(function (k, i) { keyIndex[k] = i; });
  out.forEach(function (s) { s.yAxisIndex = keyIndex[s._axisKey] || 0; delete s._axisKey; });

  /* 同侧轴按顺序向外堆叠：offset 为正即远离绘图区 */
  var nLeft = 0, nRight = 0, offPx = {};
  keys.forEach(function (k) {
    if (!used[k]) { offPx[k] = 0; return; }
    if (axes[k].side === 'left') offPx[k] = AXIS_STEP * (nLeft++);
    else offPx[k] = AXIS_STEP * (nRight++);
  });

  /* 把「缩放比例 + 偏移」作用到某个轴的原始范围上。
     zoom=1 且 off=0 时不锁定 min/max，交给 ECharts 自动取整刻度。 */
  function boundsFor(k) {
    var b = baseRange[k];
    if (!b || b[0] === null) return null;
    var bmin = b[0], bmax = b[1], a = axes[k];
    var span = bmax - bmin;
    if (!(span > 0)) span = Math.abs(bmax) > 0 ? Math.abs(bmax) : 1;
    if (a.zoom === 1 && a.off === 0) {
      return { auto: true, bmin: bmin, bmax: bmax, min: null, max: null };
    }
    var mid = (bmin + bmax) / 2 + a.off * span;
    var half = span * a.zoom / 2;
    return { auto: false, bmin: bmin, bmax: bmax, min: mid - half, max: mid + half };
  }
  var bnd = {};
  keys.forEach(function (k) { bnd[k] = boundsFor(k); });

  updateAxisUI(bnd, used, owners);

  var firstUsed = null;
  keys.forEach(function (k) { if (firstUsed === null && used[k]) firstUsed = k; });

  var yAxis = keys.map(function (k) {
    var a = axes[k], b = bnd[k], col = axisColor(k);
    return {
      type: 'value',
      show: !!used[k],
      position: a.side,
      offset: offPx[k],
      name: axisName(k, owners),
      nameTextStyle: { color: col, fontSize: 11 },
      axisLabel: { color: col, fontSize: 11 },
      axisLine: { show: !a.shared, lineStyle: { color: col, opacity: 0.6 } },
      splitLine: { show: k === firstUsed, lineStyle: { color: 'rgba(255,255,255,.06)' } },
      min: b ? b.min : null,
      max: b ? b.max : null,
      scale: !b || b.auto
    };
  });

  var dz = [
    { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
    { type: 'slider', xAxisIndex: 0, height: 20, bottom: 14, filterMode: 'none',
      backgroundColor: 'rgba(255,255,255,.03)', borderColor: '#28324a',
      fillerColor: 'rgba(91,141,239,.18)', handleStyle: { color: '#5b8def' },
      textStyle: { color: '#6b7a94', fontSize: 10 } }
  ];
  if (prevZoom) { dz[0].start = prevZoom[0]; dz[0].end = prevZoom[1];
                  dz[1].start = prevZoom[0]; dz[1].end = prevZoom[1]; }

  el.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: nLeft ? 92 + (nLeft - 1) * AXIS_STEP : 26,
            right: nRight ? 96 + (nRight - 1) * AXIS_STEP : 26,
            top: 44, bottom: 62 },
    legend: {
      type: 'scroll', top: 6, left: 8, right: 8, itemWidth: 22, itemHeight: 3, itemGap: 14,
      textStyle: { color: '#9aa8c0', fontSize: 12 },
      pageTextStyle: { color: '#6b7a94' }, pageIconColor: '#6b7a94', pageIconInactiveColor: '#3a4767'
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,.3)' } },
      backgroundColor: 'rgba(14,19,31,.95)', borderColor: '#33405e', borderWidth: 1,
      textStyle: { color: '#e6ebf5', fontSize: 12.5 }, padding: [10, 13],
      confine: true,
      formatter: function (ps) {
        if (!ps || !ps.length) return '';
        var t = ps[0].value[0];
        var h = '<b>' + fmtTime(t) + '</b> <span style="color:#9aa8c0">t=' + t.toFixed(2) + 's</span>';
        if (showModes && modeOwner) {
          var segs = modeSegments(modeOwner);
          if (segs) {
            for (var i = 0; i < segs.length; i++) {
              if (t >= segs[i].start && t <= segs[i].end) {
                h += ' &nbsp;<span style="color:' + modeColor(segs[i].name) + '">●</span> ' + segs[i].name;
                break;
              }
            }
          }
        }
        h += '<br/>';
        ps.forEach(function (p) {
          var v = p.value[1];
          h += '<span style="color:' + p.color + '">●</span> ' + p.seriesName +
               '：<b>' + fmtVal(v) + '</b><br/>';
        });
        return h;
      }
    },
    xAxis: {
      type: 'value', name: '时间 (s)', nameLocation: 'end',
      nameTextStyle: { color: '#6b7a94', fontSize: 11, padding: [22, 0, 0, -12] },
      axisLabel: { color: '#6b7a94', fontSize: 11, formatter: function (v) { return fmtTime(v); } },
      axisLine: { lineStyle: { color: '#28324a' } },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } }, axisTick: { show: false }
    },
    yAxis: yAxis,
    dataZoom: dz,
    series: out
  }, true);
  scheduleRangeSync();
}

/* =========================================================================
   10. 3D 回放 —— 轨迹数据
   ========================================================================= */
var RAD = Math.PI / 180;
var curView = 'chart';
var trackCache = {};      // 'logId|altKey' -> track
var track = null;         // 当前 3D 轨迹
var appliedTk = null;     // 已经摆放到场景里的轨迹（避免重复重建）
var V3 = null;            // three.js 场景状态
var pb = { t: 0, playing: false, speed: 1, loop: false, dragging: false };
var MAXTRACK = 40000;     // 轨迹点上限（超过则抽稀）
var rangeSync = true;     // 是否把折线图的时间缩放当作 3D 回放区间
var selRange = null;      // 折线图当前可视时间窗（图表坐标系，含 log.offset）；null = 全时段
var rng = null;           // 当前 3D 显示/回放区间（含按区间重算的包围盒与航程）
var rngTk = null;         // rng 对应的轨迹对象（换日志/换高度来源时要重算）
var rangeTimer = 0, lastRangeKey = null, camRefR = 0;
function is3DView() { return curView === '3d' || curView === 'split'; }

function numVal(id, def) {
  var v = parseFloat($(id).value);
  return isFinite(v) ? v : def;
}
function exagVal() { return Math.max(0.05, Math.min(50, numVal('s3Exag', 1))); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function showMsg3d(html) {
  var el = $('msg3d');
  el.innerHTML = html || '';
  el.hidden = !html;
  $('hud3d').style.display = html ? 'none' : '';
  document.querySelector('.v3d-hint').style.display = html ? 'none' : '';
  document.querySelector('.v3d-cams').style.display = html ? 'none' : '';
}

/* 位置源：优先 POS（高频、含相对高度），其次 GPS */
function posSource(log) {
  var p = log.msgs['POS'], g = log.msgs['GPS'];
  if (p && p.fields['Lat'] && p.fields['Lng']) return p;
  if (g && g.fields['Lat'] && g.fields['Lng']) return g;
  return null;
}
function altSources(log) {
  var out = [], p = log.msgs['POS'], g = log.msgs['GPS'];
  if (p && p.fields['Lat'] && p.fields['Lng']) {
    if (p.fields['RelHomeAlt']) out.push({ key: 'POS.RelHomeAlt', label: '相对起飞点（POS.RelHomeAlt）', m: p, f: 'RelHomeAlt', rel: true });
    if (p.fields['RelOriginAlt']) out.push({ key: 'POS.RelOriginAlt', label: '相对原点（POS.RelOriginAlt）', m: p, f: 'RelOriginAlt', rel: true });
    if (p.fields['Alt']) out.push({ key: 'POS.Alt', label: '绝对海拔（POS.Alt，已归零到起点）', m: p, f: 'Alt', rel: false });
  }
  if (g && g.fields['Lat'] && g.fields['Alt']) out.push({ key: 'GPS.Alt', label: 'GPS 海拔（GPS.Alt，已归零到起点）', m: g, f: 'Alt', rel: false });
  return out;
}

/* 机头航向来源：EKF 航向、GPS 航迹角等。
   很多没有罗盘的飞机会出现 ATT.Yaw 一直卡在 0° 附近的情况，
   这时用 GPS 航迹角复现机头指向才符合实际飞行。 */
function yawSources(log) {
  var out = [], att = log.msgs['ATT'], ah = log.msgs['AHR2'], g = log.msgs['GPS'];
  if (att && att.fields['Yaw']) out.push({ key: 'ATT.Yaw', label: 'EKF 航向（ATT.Yaw）', m: att, f: 'Yaw', kind: 'abs' });
  else if (ah && ah.fields['Yaw']) out.push({ key: 'AHR2.Yaw', label: 'EKF 航向（AHR2.Yaw）', m: ah, f: 'Yaw', kind: 'abs' });
  if (g && g.fields['GCrs']) out.push({ key: 'GPS.GCrs', label: 'GPS 航迹角（GCrs，低速保持）', m: g, f: 'GCrs', kind: 'crs' });
  if (g && g.fields['Yaw']) out.push({ key: 'GPS.Yaw', label: 'GPS 航向（GPS.Yaw）', m: g, f: 'Yaw', kind: 'abs' });
  return out;
}
/* 解缠绕后的角度跨度 */
function yawSpreadOf(m, f) {
  var a = m.fields[f], prev = null, lo = Infinity, hi = -Infinity;
  for (var i = 0; i < m.count; i++) {
    var v = a[i];
    if (!isFinite(v)) continue;
    if (prev !== null) { var d = v - prev; if (d > 180) v -= 360; else if (d < -180) v += 360; }
    prev = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}
function pickYaw(log, want) {
  var srcs = yawSources(log);
  if (!srcs.length) return null;
  if (want && want !== 'auto') {
    for (var i = 0; i < srcs.length; i++) if (srcs[i].key === want) return srcs[i];
  }
  var abs = null, crs = null;
  srcs.forEach(function (s) {
    if (s.kind === 'crs' && !crs) crs = s;
    else if (s.kind === 'abs' && !abs && yawSpreadOf(s.m, s.f) >= 45) abs = s;
  });
  if (abs) return abs;              // EKF 航向确实在变化，优先用它
  if (crs) return crs;              // 否则退到 GPS 航迹角
  for (var j = 0; j < srcs.length; j++) if (srcs[j].kind === 'abs') return srcs[j];
  return srcs[0];
}

function refresh3DYawSel() {
  var sel = $('s3Yaw'), prev = sel.value || 'auto';
  var lg = current3DLog();
  var srcs = lg ? yawSources(lg) : [];
  sel.textContent = '';
  var auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = '自动（按数据质量选择）';
  sel.appendChild(auto);
  srcs.forEach(function (s) {
    var o = document.createElement('option');
    o.value = s.key; o.textContent = s.label;
    sel.appendChild(o);
  });
  var keep = false;
  for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === prev) keep = true;
  sel.value = keep ? prev : 'auto';
}

/* 线性采样器：按时间取插值（要求按时间正序推进调用） */
function sampler(timeArr, valArr) {
  var k = 0, m = timeArr.length;
  return function (tt) {
    if (!m) return NaN;
    if (tt <= timeArr[0]) return valArr[0];
    if (tt >= timeArr[m - 1]) return valArr[m - 1];
    while (k < m - 1 && timeArr[k + 1] < tt) k++;
    while (k > 0 && timeArr[k] > tt) k--;
    var a = timeArr[k], b = timeArr[k + 1];
    var va = valArr[k], vb = valArr[k + 1];
    if (!isFinite(va)) return vb;
    if (!isFinite(vb)) return va;
    if (!(b > a)) return va;
    return va + (vb - va) * ((tt - a) / (b - a));
  };
}

/* 由日志生成 3D 轨迹：以姿态消息为主时间轴，插值出经纬高与姿态角 */
function buildTrack(log, altKey, yawKey) {
  var ck = log.id + '|' + altKey + '|' + (yawKey || 'auto');
  if (trackCache[ck]) return trackCache[ck];

  var posM = posSource(log);
  if (!posM) return null;
  var srcs = altSources(log);
  var altSrc = null;
  for (var q = 0; q < srcs.length; q++) if (srcs[q].key === altKey) altSrc = srcs[q];
  if (!altSrc) altSrc = srcs[0];
  if (!altSrc) return null;

  var yawSrc = pickYaw(log, yawKey || 'auto');
  var holdCrs = !!(yawSrc && yawSrc.kind === 'crs');

  var attM = (log.msgs['ATT'] && log.msgs['ATT'].fields['Roll'] && log.msgs['ATT'].fields['Yaw']) ? log.msgs['ATT']
           : ((log.msgs['AHR2'] && log.msgs['AHR2'].fields['Roll'] && log.msgs['AHR2'].fields['Yaw']) ? log.msgs['AHR2'] : null);
  var master = attM || posM;
  var n = master.count;
  if (!n) return null;
  var t = master.time;

  // 起点 = 第一个有效经纬度
  var i0 = -1, la, lo;
  for (var i = 0; i < posM.count; i++) {
    la = posM.fields['Lat'][i]; lo = posM.fields['Lng'][i];
    if (isFinite(la) && isFinite(lo) && (la !== 0 || lo !== 0)) { i0 = i; break; }
  }
  if (i0 < 0) return null;
  var lat0 = posM.fields['Lat'][i0], lon0 = posM.fields['Lng'][i0];
  var phi = lat0 * RAD;
  var mLon = 111319.4908 * Math.cos(phi);
  var mLat = 110574.0 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);

  var sLat = sampler(posM.time, posM.fields['Lat']);
  var sLng = sampler(posM.time, posM.fields['Lng']);
  var sAlt = sampler(altSrc.m.time, altSrc.m.fields[altSrc.f]);
  var sRoll = attM ? sampler(attM.time, attM.fields['Roll']) : null;
  var sPitch = attM ? sampler(attM.time, attM.fields['Pitch']) : null;
  var sYaw = yawSrc ? sampler(yawSrc.m.time, yawSrc.m.fields[yawSrc.f]) : null;

  var x = new Float32Array(n), z = new Float32Array(n), alt = new Float32Array(n);
  var latA = new Float32Array(n), lonA = new Float32Array(n);
  var roll = new Float32Array(n), pitch = new Float32Array(n), yaw = new Float32Array(n);
  var spd = new Float32Array(n);
  var prevY = null, y;
  var baseline = altSrc.rel ? 0 : (isFinite(sAlt(t[0])) ? sAlt(t[0]) : 0);

  for (i = 0; i < n; i++) {
    var tt = t[i];
    la = sLat(tt); lo = sLng(tt);
    var al = sAlt(tt);
    latA[i] = la; lonA[i] = lo;
    alt[i] = isFinite(al) ? (al - baseline) : 0;
    x[i] = (lo - lon0) * mLon;
    z[i] = -(la - lat0) * mLat;
    roll[i] = sRoll ? (sRoll(tt) || 0) : 0;
    pitch[i] = sPitch ? (sPitch(tt) || 0) : 0;
    // 当前地速（先算，供航迹角低速保持判断使用）
    var curSpd = 0;
    if (i > 0) {
      var dtt = t[i] - t[i - 1];
      var dx = x[i] - x[i - 1], dz = z[i] - z[i - 1];
      curSpd = dtt > 0 ? Math.sqrt(dx * dx + dz * dz) / dtt : 0;
      spd[i] = curSpd;
    }
    // 航向做去缠绕，回放插值时不会在 0°/360° 处跳变
    y = sYaw ? sYaw(tt) : 0;
    if (!isFinite(y)) y = 0;
    if (holdCrs && i > 0 && curSpd < 1.0) {
      y = yaw[i - 1];               // 悬停/静止时航迹角没有意义，保持上一时刻机头
    } else if (prevY !== null) {
      var d = y - prevY;
      if (d > 180) y -= 360; else if (d < -180) y += 360;
    }
    prevY = y;
    yaw[i] = y;
  }
  // 地速平滑（5 点）
  var sm = new Float32Array(n);
  for (i = 0; i < n; i++) {
    var s = 0, c = 0;
    for (var j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { s += spd[j]; c++; }
    sm[i] = s / c;
  }
  spd = sm;

  // 抽稀
  var step = Math.max(1, Math.ceil(n / MAXTRACK));
  if (step > 1) {
    var m2 = Math.ceil(n / step);
    function pick(src) {
      var o = new Float32Array(m2);
      for (var a = 0, b = 0; a < n; a += step, b++) o[b] = src[a];
      return o;
    }
    var ot = new Float64Array(m2);
    for (i = 0; i < m2; i++) ot[i] = t[i * step];
    t = ot; x = pick(x); z = pick(z); alt = pick(alt); latA = pick(latA);
    lonA = pick(lonA); roll = pick(roll); pitch = pick(pitch); yaw = pick(yaw); spd = pick(spd);
    n = m2;
  }

  // 包围盒与统计
  var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  var minA = Infinity, maxA = -Infinity, dist = 0;
  for (i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
    if (z[i] < minZ) minZ = z[i]; if (z[i] > maxZ) maxZ = z[i];
    if (alt[i] < minA) minA = alt[i]; if (alt[i] > maxA) maxA = alt[i];
    if (i) { var ddx = x[i] - x[i - 1], ddz = z[i] - z[i - 1]; dist += Math.sqrt(ddx * ddx + ddz * ddz); }
  }
  if (!isFinite(minX)) { minX = maxX = minZ = maxZ = 0; }
  if (!isFinite(minA)) { minA = maxA = 0; }

  var tk = {
    n: n, t: t, x: x, z: z, alt: alt, lat: latA, lon: lonA,
    roll: roll, pitch: pitch, yaw: yaw, spd: spd,
    lat0: lat0, lon0: lon0, mLat: mLat, mLon: mLon,
    t0: t[0], tEnd: t[n - 1], dur: t[n - 1] - t[0],
    bounds: { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ },
    extent: Math.max(maxX - minX, maxZ - minZ, 1),
    minAlt: minA, maxAlt: maxA, dist: dist,
    hasAtt: !!attM, altKey: altSrc.key,
    yawKey: yawSrc ? yawSrc.key : '', yawKind: yawSrc ? yawSrc.kind : '',
    logId: log.id, name: log.name, step: step
  };
  trackCache[ck] = tk;
  return tk;
}

function current3DLog() {
  var id = $('s3Log').value;
  var lg = logs.filter(function (l) { return String(l.id) === id; })[0];
  if (lg) return lg;
  for (var i = 0; i < logs.length; i++) if (posSource(logs[i])) return logs[i];
  return null;
}
function ensureTrack(log) {
  if (!log) return null;
  var srcs = altSources(log);
  if (!srcs.length) return null;
  var want = $('s3Alt').value, key = '';
  for (var i = 0; i < srcs.length; i++) if (srcs[i].key === want) key = want;
  if (!key) key = srcs[0].key;
  var yw = $('s3Yaw').value || 'auto';
  return buildTrack(log, key, yw);
}

function refresh3DLogSel() {
  var sel = $('s3Log'), prev = sel.value;
  sel.textContent = '';
  var ok = logs.filter(posSource);
  if (!ok.length) {
    var o = document.createElement('option');
    o.value = ''; o.textContent = '（还没有带位置数据的日志）';
    sel.appendChild(o);
  }
  ok.forEach(function (l) {
    var o = document.createElement('option');
    o.value = String(l.id); o.textContent = l.name;
    sel.appendChild(o);
  });
  var keep = false;
  for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === prev) keep = true;
  sel.value = keep ? prev : (ok.length ? String(ok[0].id) : '');
  refresh3DAltSel();
  refresh3DYawSel();
}
function refresh3DAltSel() {
  var sel = $('s3Alt'), prev = sel.value;
  var lg = current3DLog();
  sel.textContent = '';
  var srcs = lg ? altSources(lg) : [];
  srcs.forEach(function (s) {
    var o = document.createElement('option');
    o.value = s.key; o.textContent = s.label;
    sel.appendChild(o);
  });
  var keep = false;
  for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === prev) keep = true;
  sel.value = keep ? prev : (srcs.length ? srcs[0].key : '');
}

/* =========================================================================
   10b. 3D 场景
   ========================================================================= */
function niceStep(x) {
  if (!(x > 0)) return 10;
  var e = Math.pow(10, Math.floor(Math.log(x) / Math.LN10));
  var f = x / e;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * e;
}
function fmtDist(m) {
  if (Math.abs(m) >= 1000) return (m / 1000).toFixed(2) + ' km';
  return m.toFixed(m < 10 ? 2 : 0) + ' m';
}

/* 画布文字标签（世界坐标里的 Sprite） */
function makeLabel(text, worldH, color) {
  var cv = document.createElement('canvas');
  var fs = 40;
  var c0 = cv.getContext('2d');
  if (!c0) return null;
  c0.font = '600 ' + fs + 'px Consolas, monospace';
  var tw = Math.ceil(c0.measureText(text).width);
  cv.width = tw + 22; cv.height = fs + 18;
  var ctx = cv.getContext('2d');
  ctx.font = '600 ' + fs + 'px Consolas, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(10,14,23,.78)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = color || '#8fa0bd';
  ctx.fillText(text, cv.width / 2, cv.height / 2 + 1);
  var tex = new THREE.CanvasTexture(cv);
  if (THREE.sRGBEncoding && tex.encoding !== undefined) tex.encoding = THREE.sRGBEncoding;
  var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  var sp = new THREE.Sprite(mat);
  var ratio = cv.width / cv.height;
  sp.scale.set(worldH * ratio, worldH, 1);
  sp.renderOrder = 10;
  return sp;
}

function clearGroup(g) {
  if (!g) return;
  while (g.children.length) {
    var c = g.children[g.children.length - 1];
    g.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      var mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(function (mm) {
        if (mm.map) mm.map.dispose();
        mm.dispose();
      });
    }
  }
}

function initScene() {
  if (V3 && V3.ok) return true;
  if (V3 && V3.failed) { showMsg3d(V3.msg); return false; }
  if (!window.THREE) {
    V3 = { ok: false, failed: true, msg: '<b>缺少 three.js</b><br>构建产物没有内联 three.min.js' };
    showMsg3d(V3.msg);
    return false;
  }
  var gl = null;
  try {
    var cv = document.createElement('canvas');
    gl = cv.getContext('webgl2') || cv.getContext('webgl') || cv.getContext('experimental-webgl');
  } catch (e) { gl = null; }
  if (!gl) {
    V3 = { ok: false, failed: true,
           msg: '<b>当前环境不支持 WebGL</b><br>无法渲染 3D 场景，请使用带 GPU 加速的浏览器<br><span class="dim">折线图视图不受影响</span>' };
    showMsg3d(V3.msg);
    return false;
  }

  var host = $('canvas3d');
  var w = host.clientWidth || 900, h = host.clientHeight || 560;
  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e2) {
    V3 = { ok: false, failed: true, msg: '<b>WebGL 初始化失败</b><br>' + esc((e2 && e2.message) || e2) };
    showMsg3d(V3.msg);
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  if (renderer.outputEncoding !== undefined && THREE.sRGBEncoding !== undefined) {
    renderer.outputEncoding = THREE.sRGBEncoding;
  }
  host.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e17);
  var camera = new THREE.PerspectiveCamera(52, w / h, 1, 500000);
  camera.position.set(300, 260, 300);

  var controls = null;
  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.maxPolarAngle = Math.PI * 0.98;
    controls.screenSpacePanning = false;
    controls.zoomSpeed = 1.1;
  } else {
    controls = { target: new THREE.Vector3(), update: function () {} };
  }

  scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x2b3040, 0.9));
  var d1 = new THREE.DirectionalLight(0xffffff, 0.95);
  d1.position.set(1, 1.5, 0.7);
  scene.add(d1);
  var d2 = new THREE.DirectionalLight(0x7fa8ff, 0.4);
  d2.position.set(-1, 0.6, -0.9);
  scene.add(d2);

  V3 = {
    ok: true, renderer: renderer, scene: scene, camera: camera, controls: controls,
    solid: new THREE.Group(), gridG: new THREE.Group(), tiles: new THREE.Group(),
    trackG: new THREE.Group(), craft: new THREE.Group(),
    lines: null, drop: null, dropStep: 1, dropN: 0, arrow: null, tmp: new THREE.Vector3()
  };
  [V3.solid, V3.gridG, V3.tiles, V3.trackG, V3.craft].forEach(function (g) { scene.add(g); });
  startLoop();
  return true;
}

function resize3D() {
  if (!V3 || !V3.ok) return;
  var host = $('canvas3d');
  var w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  V3.renderer.setSize(w, h, false);
  V3.camera.aspect = w / h;
  V3.camera.updateProjectionMatrix();
}

/* ---------- 地面：网格 + 刻度 + 起飞点 ---------- */
function buildGround() {
  if (!V3 || !V3.ok) return;
  clearGroup(V3.solid);
  clearGroup(V3.gridG);
  if (!track) return;

  var ext = track.extent;
  var step = niceStep(Math.max(5, ext / 6));
  var size = Math.ceil((ext * 1.7) / step) * step;
  var div = Math.max(2, Math.round(size / step));

  var plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ color: 0x0d1220, side: THREE.DoubleSide }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.5;
  V3.solid.add(plane);

  if (size > 0 && div > 0) {
    var grid = new THREE.GridHelper(size, div, 0x4a5a80, 0x27324b);
    grid.position.y = 0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.75;
    V3.gridG.add(grid);

    var every = div <= 10 ? 1 : (div <= 24 ? 2 : Math.ceil(div / 12));
    var half = size / 2;
    for (var i = 1; i < div; i++) {
      if (i % every) continue;
      var p = -half + i * step;
      var lx = makeLabel(fmtDist(p), step * 0.24);
      if (lx) { lx.position.set(p, 0.06, -half + step * 0.65); V3.gridG.add(lx); }
      var lz = makeLabel(fmtDist(-p), step * 0.24);
      if (lz) { lz.position.set(-half + step * 0.65, 0.06, p); V3.gridG.add(lz); }
    }
  }

  // 起飞点标记：只留贴地圆环（不再放浮空文字，免得挡住航迹）
  var r0 = Math.max(step * 0.12, ext * 0.012);
  var ring = new THREE.Mesh(new THREE.RingGeometry(r0 * 0.68, r0, 30),
    new THREE.MeshBasicMaterial({ color: 0xffb020, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  V3.gridG.add(ring);
}

/* ---------- 在线瓦片底图 ---------- */
function lon2tileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2tileY(lat, z) {
  var s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * RAD);
  return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z));
}
function tileY2lat(y, z) {
  var n = Math.pow(2, z);
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / RAD;
}

/* ---------- 坐标系：WGS-84 / GCJ-02(火星) / BD-09(百度) ---------- */
function wgs2gcj(lng, lat) {
  var a = 6378245.0, ee = 0.00669342162296594323;
  function tl(x, y) {
    var r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  }
  function tg(x, y) {
    var r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  }
  var dl = tl(lng - 105.0, lat - 35.0), dg = tg(lng - 105.0, lat - 35.0);
  var rad = lat * RAD, m = Math.sin(rad); m = 1 - ee * m * m;
  var sq = Math.sqrt(m);
  dl = (dl * 180) / ((a * (1 - ee)) / (m * sq) * Math.PI);
  dg = (dg * 180) / (a / sq * Math.cos(rad) * Math.PI);
  return [lng + dg, lat + dl];
}
function gcj2wgs(lng, lat) {           // 迭代反解，误差 < 1e-7 度
  var lo = lng, la = lat, g;
  for (var i = 0; i < 6; i++) {
    g = wgs2gcj(lo, la); lo -= g[0] - lng; la -= g[1] - lat;
  }
  return [lo, la];
}
function gcj2bd(lng, lat) {
  var x = lng + 0.0065, y = lat + 0.006;
  var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI * 3000 / 180);
  var th = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI * 3000 / 180);
  return [z * Math.cos(th), z * Math.sin(th)];
}
function bd2gcj(lng, lat) {
  var x = lng - 0.0065, y = lat - 0.006;
  var z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI * 3000 / 180);
  var th = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI * 3000 / 180);
  return [z * Math.cos(th), z * Math.sin(th)];
}
// 百度墨卡托 BD09MC（+proj=merc +a=6378206 +b=6356584.314245179），Y 轴朝北、原点在(0,0)
var BDA = 6378206.0, BDB = 6356584.314245179, BDE = Math.sqrt(1 - (BDB / BDA) * (BDB / BDA));
function bdMcX(lng) { return lng * Math.PI / 180 * BDA; }
function bdMcY(lat) {
  var p = lat * RAD;
  return BDA * Math.log(Math.tan(Math.PI / 4 + p / 2) *
    Math.pow((1 - BDE * Math.sin(p)) / (1 + BDE * Math.sin(p)), BDE / 2));
}
function bdMc2Lat(my) {
  var t = Math.exp(-my / BDA), p = Math.PI / 2 - 2 * Math.atan(t);
  for (var i = 0; i < 8; i++) {
    p = Math.PI / 2 - 2 * Math.atan(t *
      Math.pow((1 - BDE * Math.sin(p)) / (1 + BDE * Math.sin(p)), BDE / 2));
  }
  return p / RAD;
}
function toProv(lng, lat, d) {         // WGS-84 -> 提供方坐标
  if (d === 'gcj') return wgs2gcj(lng, lat);
  if (d === 'bd') return gcj2bd.apply(null, wgs2gcj(lng, lat));
  return [lng, lat];
}
function fromProv(lng, lat, d) {       // 提供方坐标 -> WGS-84
  if (d === 'gcj') return gcj2wgs(lng, lat);
  if (d === 'bd') { var c = bd2gcj(lng, lat); return gcj2wgs(c[0], c[1]); }
  return [lng, lat];
}

/* ---------- 在线瓦片底图（多提供商） ---------- */
// d: 坐标基准 wgs=WGS-84 / gcj=GCJ-02 火星坐标 / bd=BD-09 百度（自定义分片）
var TILE_PROVS = {
  grid: null,
  esri: { n: 'Esri 世界影像', g: '卫星影像', d: 'wgs', sub: '0123', c: '© Esri, Maxar, Earthstar Geographics',
    u: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' },
  gsat: { n: '谷歌 卫星', g: '卫星影像', d: 'wgs', sub: '0123', c: '© Google',
    u: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}' },
  asat: { n: '高德 卫星', g: '卫星影像', d: 'gcj', sub: '1234', c: '© 高德地图',
    u: 'https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=6' },
  bing: { n: '必应 影像', g: '卫星影像', d: 'wgs', sub: '0123', c: '© Microsoft Bing',
    u: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{q}.jpeg?g=587', qk: 1 },
  bdsat: { n: '百度 卫星', g: '卫星影像', d: 'bd', sub: '0123', c: '© 百度地图',
    u: 'https://maponline{s}.bdimg.com/it/u=x={x};y={y};z={z};v=009;type=sate&fm=46' },
  osm: { n: 'OpenStreetMap', g: '街道图', d: 'wgs', sub: '', c: '© OpenStreetMap contributors',
    u: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  gmap: { n: '谷歌 街道', g: '街道图', d: 'gcj', sub: '0123', c: '© Google',
    u: 'https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}' },
  amap: { n: '高德 街道', g: '街道图', d: 'gcj', sub: '1234', c: '© 高德地图',
    u: 'https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=7' },
  esrim: { n: 'Esri 街道', g: '街道图', d: 'wgs', sub: '0123', c: '© Esri',
    u: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}' },
  bdmap: { n: '百度 街道', g: '街道图', d: 'bd', sub: '0123', c: '© 百度地图',
    u: 'https://maponline{s}.bdimg.com/tile/?qt=vtile&x={x}&y={y}&z={z}&styles=pl' }
};
function xyz2quadkey(x, y, z) {        // 必应 quadkey
  var d = '', i, mask, m;
  for (i = z; i > 0; i--) {
    mask = 1 << (i - 1); m = 0;
    if ((x & mask) !== 0) m += 1;
    if ((y & mask) !== 0) m += 2;
    d += m;
  }
  return d;
}
function provRange(p, lngW, latS, lngE, latN, z) {   // 提供方坐标系下的瓦片范围
  if (p.d === 'bd') {
    var span = 256 * Math.pow(2, 18 - z);
    // BD09MC 的 Y 轴朝北（y 随纬度增大），故 y0 取南、y1 取北，保证 y0 <= y1
    return { x0: Math.floor(bdMcX(lngW) / span), x1: Math.floor(bdMcX(lngE) / span),
             y0: Math.floor(bdMcY(latS) / span), y1: Math.floor(bdMcY(latN) / span),
             hi: Math.floor(20037508.342789244 / span) };
  }
  var n = Math.pow(2, z);
  return { x0: lon2tileX(lngW, z), x1: lon2tileX(lngE, z),
           y0: lat2tileY(latN, z), y1: lat2tileY(latS, z), hi: n - 1 };
}
function provBounds(p, x, y, z) {      // 瓦片真实范围 -> WGS [西,南,东,北]
  var w, e, n, s, a, b;
  if (p.d === 'bd') {
    var span = 256 * Math.pow(2, 18 - z);
    w = (x * span) / BDA * 180 / Math.PI;
    e = ((x + 1) * span) / BDA * 180 / Math.PI;
    n = bdMc2Lat((y + 1) * span);
    s = bdMc2Lat(y * span);
    a = bd2gcj(w, s); b = bd2gcj(e, n);
    a = gcj2wgs(a[0], a[1]); b = gcj2wgs(b[0], b[1]);
    return [a[0], a[1], b[0], b[1]];
  }
  w = x / Math.pow(2, z) * 360 - 180;
  e = (x + 1) / Math.pow(2, z) * 360 - 180;
  n = tileY2lat(y, z); s = tileY2lat(y + 1, z);
  if (p.d === 'gcj') {
    a = gcj2wgs(w, n); b = gcj2wgs(e, s);
    return [a[0], b[1], b[0], a[1]];
  }
  return [w, s, e, n];
}
function provUrl(p, x, y, z, seq) {
  var u = p.u.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
  if (p.qk) u = u.replace('{q}', xyz2quadkey(x, y, z));
  if (p.sub) u = u.replace('{s}', p.sub.charAt(seq % p.sub.length));
  return u;
}

function applyBase() {
  if (!V3 || !V3.ok || !track) return;
  var kind = $('s3Base').value;
  clearGroup(V3.tiles);
  V3.gridG.visible = $('s3Grid').checked;
  var prov = TILE_PROVS[kind];
  var cr = $('credit3d');
  if (cr) cr.textContent = prov ? prov.c : '';
  if (!prov) {
    V3.solid.visible = true;
    setStatus('');
    return;
  }
  V3.solid.visible = false;
  loadTiles(kind);
}

function loadTiles(kind) {
  var prov = TILE_PROVS[kind];
  if (!prov) { V3.solid.visible = true; return; }
  var b = track.bounds;
  var lonW = track.lon0 + (b.minX - track.extent * 0.15) / track.mLon;
  var lonE = track.lon0 + (b.maxX + track.extent * 0.15) / track.mLon;
  var latN = track.lat0 - (b.minZ - track.extent * 0.15) / track.mLat;
  var latS = track.lat0 - (b.maxZ + track.extent * 0.15) / track.mLat;
  // 视窗转到该提供方的坐标系（GCJ/BD 各有偏移）
  var c1 = toProv(lonW, latS, prov.d), c2 = toProv(lonE, latN, prov.d);
  var pW = Math.min(c1[0], c2[0]), pE = Math.max(c1[0], c2[0]);
  var pS = Math.min(c1[1], c2[1]), pN = Math.max(c1[1], c2[1]);

  var bestZ = 0, ax0 = 0, ay0 = 0, ax1 = 0, ay1 = 0;
  var zMax = prov.d === 'bd' ? 18 : 17;
  for (var z = 1; z <= zMax; z++) {
    var r = provRange(prov, pW, pS, pE, pN, z);
    var x0 = Math.max(0, Math.min(r.hi, r.x0)), x1 = Math.max(0, Math.min(r.hi, r.x1));
    var y0 = Math.max(0, Math.min(r.hi, r.y0)), y1 = Math.max(0, Math.min(r.hi, r.y1));
    var cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cnt < 1 || cnt > 96) break;
    bestZ = z; ax0 = x0; ay0 = y0; ax1 = x1; ay1 = y1;
  }
  if (!bestZ) {
    V3.solid.visible = true;
    setStatus('底图范围过大，已回退为网格');
    return;
  }

  var loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  var aniso = V3.renderer.capabilities.getMaxAnisotropy ? V3.renderer.capabilities.getMaxAnisotropy() : 1;
  var total = (ax1 - ax0 + 1) * (ay1 - ay0 + 1);
  var done = 0, failed = 0, seq = 0;

  function finish() {
    if (failed && !done) {
      V3.solid.visible = true;
      setStatus('底图瓦片加载失败（可能无网络），已回退为网格');
    } else {
      setStatus('底图：' + prov.n + ' · ' + bestZ + ' 级 · ' + total + ' 块' +
        (failed ? '（' + failed + ' 块失败）' : ''));
    }
  }

  for (var tx = ax0; tx <= ax1; tx++) {
    for (var ty = ay0; ty <= ay1; ty++) {
      (function (tx, ty, seq) {
        var gb = provBounds(prov, tx, ty, bestZ);
        var x0w = (gb[0] - track.lon0) * track.mLon;
        var x1w = (gb[2] - track.lon0) * track.mLon;
        var z0w = -(gb[3] - track.lat0) * track.mLat;
        var z1w = -(gb[1] - track.lat0) * track.mLat;
        var yy = -0.3;
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
          x0w, yy, z0w, x1w, yy, z0w, x1w, yy, z1w,
          x0w, yy, z0w, x1w, yy, z1w, x0w, yy, z1w
        ]), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
          0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0
        ]), 2));
        var mtl = new THREE.MeshBasicMaterial({ color: 0x6d7788, side: THREE.DoubleSide });
        var mesh = new THREE.Mesh(geo, mtl);
        V3.tiles.add(mesh);
        loader.load(provUrl(prov, tx, ty, bestZ, seq),
          function (tex) {
            if (THREE.sRGBEncoding !== undefined && tex.encoding !== undefined) tex.encoding = THREE.sRGBEncoding;
            tex.anisotropy = aniso;
            mtl.map = tex; mtl.color.set(0xffffff); mtl.needsUpdate = true;
            if (++done + failed === total) finish();
          }, undefined, function () {
            if (++failed + done === total) finish();
          });
      })(tx, ty, seq++);
    }
  }
}

/* ---------- 航迹线（完整 / 已飞过 两套 drawRange 共享顶点） ---------- */
function makeSplitLine(posArr, segments) {
  var attr = new THREE.BufferAttribute(posArr, 3);
  var g1 = new THREE.BufferGeometry(); g1.setAttribute('position', attr); g1.computeBoundingSphere();
  var g2 = new THREE.BufferGeometry(); g2.setAttribute('position', attr); g2.computeBoundingSphere();
  var Cls = segments ? THREE.LineSegments : THREE.Line;
  var full = new Cls(g1, new THREE.LineBasicMaterial({ color: 0x4f7ad8, transparent: true, opacity: 0.5 }));
  var flown = new Cls(g2, new THREE.LineBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.95 }));
  flown.geometry.setDrawRange(0, 0);
  return { full: full, flown: flown, count: posArr.length / 3 };
}

function rebuildGeo() {
  if (!V3 || !V3.ok || !track) return;
  clearGroup(V3.trackG);
  V3.lines = V3.drop = V3.arrow = null;

  var n = track.n, exag = exagVal(), i;
  var pos = new Float32Array(n * 3);
  for (i = 0; i < n; i++) {
    pos[i * 3] = track.x[i];
    pos[i * 3 + 1] = track.alt[i] * exag;
    pos[i * 3 + 2] = track.z[i];
  }
  V3.lines = makeSplitLine(pos, false);
  V3.trackG.add(V3.lines.full);
  V3.trackG.add(V3.lines.flown);

  var dstep = Math.max(1, Math.ceil(n / 400));
  var dn = Math.floor((n - 1) / dstep) + 1;
  var dpos = new Float32Array(dn * 6), k = 0;
  for (i = 0; i < n; i += dstep) {
    dpos[k++] = track.x[i]; dpos[k++] = 0; dpos[k++] = track.z[i];
    dpos[k++] = track.x[i]; dpos[k++] = track.alt[i] * exag; dpos[k++] = track.z[i];
  }
  V3.dropStep = dstep; V3.dropN = dn;
  V3.drop = makeSplitLine(dpos, true);
  V3.drop.full.material.color.set(0x63739b);
  V3.drop.full.material.opacity = 0.3;
  V3.drop.flown.material.color.set(0xffb020);
  V3.drop.flown.material.opacity = 0.55;
  V3.trackG.add(V3.drop.full);
  V3.trackG.add(V3.drop.flown);

  // 地面机头朝向箭头
  var arGeo = new THREE.BufferGeometry();
  arGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, -0.5, 0.42, 0, 0.34, -0.42, 0, 0.34
  ]), 3));
  V3.arrow = new THREE.Mesh(arGeo, new THREE.MeshBasicMaterial({
    color: 0xffe08a, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  V3.trackG.add(V3.arrow);
  syncVis();
}

function syncVis() {
  if (!V3 || !V3.ok) return;
  if (V3.lines) {
    V3.lines.full.visible = $('s3Trail').checked;
    V3.lines.flown.visible = $('s3Flown').checked;
  }
  if (V3.drop) {
    V3.drop.full.visible = $('s3Drop').checked;
    V3.drop.flown.visible = $('s3Drop').checked;
  }
  if (V3.arrow) V3.arrow.visible = $('s3Orient').checked;
}

/* ---------- 飞机模型 ---------- */
var DIMS = {
  wing:  { len: 1.30, wid: 1.80, hgt: 0.45 },
  quad:  { len: 0.42, wid: 0.42, hgt: 0.20 },
  arrow: { len: 1.60, wid: 1.00, hgt: 0.25 }
};
function mkMat(c, o) {
  var m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.08 });
  if (o) for (var k in o) m[k] = o[k];
  return m;
}
function mkBox(w, h, d, c) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mkMat(c)); }

function buildAircraft() {
  if (!V3 || !V3.ok) return;
  clearGroup(V3.craft);
  var kind = $('s3Model').value;
  var g = new THREE.Group();
  var BODY = 0xe9eef7, WING = 0x3b8cff, TAIL = 0xf4553d, DARK = 0x272f44, HI = 0xffb020;
  var i, sx, sz, m;

  if (kind === 'quad') {
    m = mkBox(0.05, 0.045, 0.95, DARK); m.rotation.y = Math.PI / 4; g.add(m);
    m = mkBox(0.05, 0.045, 0.95, DARK); m.rotation.y = -Math.PI / 4; g.add(m);
    m = mkBox(0.30, 0.13, 0.38, WING); m.position.y = 0.01; g.add(m);
    m = mkBox(0.34, 0.03, 0.42, HI); m.position.y = 0.075; g.add(m);
    var dd = 0.33 / Math.SQRT2;
    for (i = 0; i < 4; i++) {
      sx = i < 2 ? -1 : 1; sz = (i % 2) ? -1 : 1;
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.10, 12), mkMat(DARK));
      m.position.set(sx * dd, 0.05, sz * dd); g.add(m);
      m = new THREE.Mesh(new THREE.CircleGeometry(0.17, 20),
        new THREE.MeshBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0.17, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.set(sx * dd, 0.105, sz * dd); g.add(m);
      m = mkBox(0.035, 0.16, 0.035, DARK);
      m.position.set(sx * 0.13, -0.13, sz * 0.13); g.add(m);
    }
  } else if (kind === 'arrow') {
    var tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, -0.5, 0.5, 0, 0.4, -0.5, 0, 0.4
    ]), 3));
    tri.computeVertexNormals();
    g.add(new THREE.Mesh(tri, new THREE.MeshBasicMaterial({
      color: HI, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })));
    g.add(mkBox(0.14, 0.1, 0.88, TAIL));
    m = mkBox(0.03, 0.32, 0.22, TAIL); m.position.set(0, 0.16, 0.3); g.add(m);
  } else {  // 固定翼
    g.add(mkBox(0.10, 0.12, 0.94, BODY));
    m = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.16, 10), mkMat(DARK));
    m.rotation.x = -Math.PI / 2; m.position.z = -0.55; g.add(m);
    m = mkBox(0.5, 0.03, 0.26, WING);
    m.position.set(-0.25, 0.01, -0.06); m.rotation.z = -0.14; g.add(m);
    m = mkBox(0.5, 0.03, 0.26, WING);
    m.position.set(0.25, 0.01, -0.06); m.rotation.z = 0.14; g.add(m);
    m = mkBox(0.44, 0.026, 0.16, TAIL); m.position.set(0, 0.03, 0.4); g.add(m);
    m = mkBox(0.028, 0.4, 0.2, TAIL); m.position.set(0, 0.2, 0.4); g.add(m);
    m = new THREE.Mesh(new THREE.CircleGeometry(0.17, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, side: THREE.DoubleSide }));
    m.position.z = -0.58; g.add(m);
  }
  V3.craft.add(g);
  applyCraftScale();
}

function craftScale() {
  var d = DIMS[$('s3Model').value] || DIMS.wing;
  if (!$('s3AutoSize').checked) return Math.max(0.01, numVal('s3Scale', 1));
  var base = Math.max(0.05, d.len, d.wid);
  var want = ((rng ? rng.extent : (track ? track.extent : 200)) / 45);
  return Math.max(0.01, Math.min(20000, want / base));
}
function applyCraftScale() {
  if (!V3 || !V3.ok || !V3.craft.children.length) return;
  var d = DIMS[$('s3Model').value] || DIMS.wing;
  var s = craftScale();
  V3.craft.children[0].scale.set(d.wid * s, d.hgt * s, d.len * s);
  if ($('s3AutoSize').checked) $('s3Scale').value = Math.min(500, s);
  var e1 = $('h3scale');
  var sp = rng || track;
  if (e1 && sp) {
    var b = sp.bounds;
    var ex = b.maxX - b.minX, ez = b.maxZ - b.minZ;
    e1.textContent = '航迹 ' + fmtDist(ex) + ' × ' + fmtDist(ez) +
      (rng && rng.cut ? '（区间）' : '') +
      ' · 模型显示 ×' + (s < 10 ? s.toFixed(1) : Math.round(s)) +
      (exagVal() !== 1 ? ' · 高度 ×' + exagVal() : '');
  }
}

function updateLimits() {
  if (!V3 || !V3.ok || !track) return;
  var r = Math.max(rng ? rng.extent : track.extent, 30);
  V3.controls.minDistance = r * 0.005;
  V3.controls.maxDistance = r * 8;
  V3.camera.near = Math.max(0.05, r * 0.0008);
  V3.camera.far = Math.max(5000, r * 400);
  V3.camera.updateProjectionMatrix();
}

function camPreset(kind) {
  if (!V3 || !V3.ok || !track) return;
  var r_ = rng || computeRange(), b = r_.bounds, exag = exagVal();
  var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  var cy = (Math.min(0, r_.minAlt * exag) + Math.max(0, r_.maxAlt * exag)) / 2;
  var r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ,
                   Math.max(30, (r_.maxAlt - r_.minAlt) * exag * 2.5));
  camRefR = r;
  var cam = V3.camera, ct = V3.controls;
  if (kind === 'top') {
    cam.up.set(0, 0, -1);
    ct.target.set(cx, cy, cz);
    cam.position.set(cx + 0.001, cy + r * 1.25, cz);
  } else {
    cam.up.set(0, 1, 0);
    ct.target.set(cx, cy, cz);
    if (kind === 'side') cam.position.set(cx + r * 1.4, cy + r * 0.35, cz + r * 0.001);
    else cam.position.set(cx + r * 1.05, cy + r * 0.85, cz + r * 1.05);
  }
  ct.update();
}

/* ---------- 回放区间：由折线图的时间缩放「切割」而来 ---------- */
function rangeKey() { return rng ? (rng.i0 + ':' + rng.i1) : 'none'; }

function computeRange() {
  if (!track) { rng = null; rngTk = null; return null; }
  rngTk = track;
  var full = function () {
    return { i0: 0, i1: track.n - 1, t0: track.t[0], t1: track.t[track.n - 1], cut: false,
             bounds: track.bounds, extent: track.extent,
             minAlt: track.minAlt, maxAlt: track.maxAlt, dist: track.dist };
  };
  if (!selRange) { rng = full(); return rng; }
  var lg = current3DLog(), off = lg ? (lg.offset || 0) : 0;
  var a = selRange.t0 - off, b = selRange.t1 - off;
  if (!(b - a > 0.05)) { rng = full(); return rng; }
  var i0 = sampleIdx(track, a).i;
  var i1 = sampleIdx(track, b).i;
  if (track.t[i0] < a) i0++;              // 起点取第一个 ≥ 区间起点的点（floor → ceil）
  if (i0 > track.n - 1) i0 = track.n - 1;
  if (i1 < i0) i1 = i0;
  var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  var minA = Infinity, maxA = -Infinity, dist = 0;
  for (var i = i0; i <= i1; i++) {
    if (track.x[i] < minX) minX = track.x[i];
    if (track.x[i] > maxX) maxX = track.x[i];
    if (track.z[i] < minZ) minZ = track.z[i];
    if (track.z[i] > maxZ) maxZ = track.z[i];
    if (track.alt[i] < minA) minA = track.alt[i];
    if (track.alt[i] > maxA) maxA = track.alt[i];
    if (i > i0) {
      var dx = track.x[i] - track.x[i - 1], dz = track.z[i] - track.z[i - 1];
      dist += Math.sqrt(dx * dx + dz * dz);
    }
  }
  if (!isFinite(minX)) { minX = maxX = minZ = maxZ = 0; }
  if (!isFinite(minA)) { minA = maxA = 0; }
  rng = { i0: i0, i1: i1, t0: track.t[i0], t1: track.t[i1],
          cut: !(i0 <= 0 && i1 >= track.n - 1),
          bounds: { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ },
          extent: Math.max(maxX - minX, maxZ - minZ, 1),
          minAlt: minA, maxAlt: maxA, dist: dist };
  return rng;
}
function rangeWin() {
  if (!track) return null;
  if (!rng || rngTk !== track) computeRange();
  return rng ? { t0: rng.t0, t1: rng.t1 } : null;
}
/* 把区间落到几何上：只画这一段（共享顶点，靠 drawRange 起止索引裁剪） */
function applyGeoRange() {
  if (!V3 || !V3.ok || !rng) return;
  if (V3.lines) V3.lines.full.geometry.setDrawRange(rng.i0, rng.i1 - rng.i0 + 1);
  if (V3.drop) {
    var da = Math.floor(rng.i0 / V3.dropStep);
    var db = Math.min(V3.dropN - 1, Math.floor(rng.i1 / V3.dropStep));
    V3.drop.full.geometry.setDrawRange(da * 2, (db - da + 1) * 2);
  }
}
function updateRangeUI() {
  var el = $('s3RangeTxt');
  if (el) {
    el.textContent = (track && rng && rng.cut)
      ? (fmtTime(rng.t0) + ' ~ ' + fmtTime(rng.t1) + ' · ' +
         Math.round(rng.t1 - rng.t0) + ' s · ' + fmtDist(rng.dist))
      : '全时段（整条航迹）';
  }
  var bt = $('s3RangeAll');
  if (bt) bt.disabled = !(track && rng && rng.cut);
}
/* 应用区间：重算包围盒/裁剪几何/调整模型尺度，必要时把镜头拉回这一段 */
function applyRange(o) {
  o = o || {};
  if (!track) { rng = null; updateRangeUI(); return; }
  computeRange();
  var k = rangeKey(), changed = (k !== lastRangeKey);
  lastRangeKey = k;
  if (V3 && V3.ok && appliedTk === track) {
    applyGeoRange();
    updateLimits();
    applyCraftScale();
    if (o.fit !== false && changed) camReframe();
  }
  var w = rangeWin();
  if (w && !(pb.t >= w.t0 && pb.t <= w.t1)) pb.t = w.t0;
  updateRangeUI();
  updateFrame();
}
/* 保留当前观察方向，把镜头推拉到新区间的尺度上（比整体重置更顺手） */
function camReframe() {
  if (!V3 || !V3.ok || !rng) return;
  var r_ = rng, exag = exagVal();
  var b = r_.bounds;
  var cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  var cy = (Math.min(0, r_.minAlt * exag) + Math.max(0, r_.maxAlt * exag)) / 2;
  var r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ,
                   Math.max(30, (r_.maxAlt - r_.minAlt) * exag * 2.5));
  var ct = V3.controls, cam = V3.camera;
  var dx = cam.position.x - ct.target.x, dy = cam.position.y - ct.target.y,
      dz = cam.position.z - ct.target.z;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  var need = (camRefR > 0 && len > 1e-6) ? len * (r / camRefR) : r * 1.7;
  camRefR = r;
  need = Math.max(r * 0.15, Math.min(r * 40, need));
  ct.target.set(cx, cy, cz);
  if (len > 1e-6) cam.position.set(cx + dx * (need / len), cy + dy * (need / len), cz + dz * (need / len));
  else cam.position.set(cx + need * 1.05, cy + need * 0.85, cz + need * 1.05);
  ct.update();
}

/* 折线图当前可视时间窗（读 dataZoom 的百分比，按曲线数据首尾换算成秒） */
function chartWindow() {
  if (!chart) return null;
  var opt;
  try { opt = chart.getOption(); } catch (e) { return null; }
  if (!opt || !opt.dataZoom || !opt.dataZoom[0]) return null;
  var dzs = opt.dataZoom;
  if (!dzs || !dzs.length) return null;
  var st = -Infinity, en = Infinity, zi, d0, za, zb;
  for (zi = 0; zi < dzs.length; zi++) {          // 交集 = 图上实际显示的时间窗
    d0 = dzs[zi];
    za = isFinite(d0.start) ? d0.start : 0;
    zb = isFinite(d0.end) ? d0.end : 100;
    if (za > st) st = za;
    if (zb < en) en = zb;
  }
  if (!(en > st)) return null;
  var xs0 = Infinity, xs1 = -Infinity, ss = opt.series || [], i, d, a, b;
  for (i = 0; i < ss.length; i++) {
    d = ss[i].data;
    if (!d || !d.length) continue;
    a = d[0]; b = d[d.length - 1];
    if (!a || !b || a.length < 1 || b.length < 1) continue;
    if (a[0] < xs0) xs0 = a[0];
    if (b[0] > xs1) xs1 = b[0];
  }
  if (!(xs1 > xs0)) return null;
  var span = xs1 - xs0;
  return { t0: xs0 + span * st / 100, t1: xs0 + span * en / 100,
           full: st <= 0.0001 && en >= 99.9999 };
}
function syncRangeFromChart() {
  if (!rangeSync) return;
  var w = chartWindow();
  selRange = (w && !w.full && (w.t1 - w.t0) > 0.05) ? { t0: w.t0, t1: w.t1 } : null;
  if (is3DView()) applyRange({ fit: true });
  else { computeRange(); lastRangeKey = rangeKey(); updateRangeUI(); }
}
/* 缩放过程中 dataZoom 会连续触发，稍作合并再同步，免得镜头一直跳 */
function scheduleRangeSync() {
  if (rangeTimer) clearTimeout(rangeTimer);
  rangeTimer = setTimeout(function () { rangeTimer = 0; syncRangeFromChart(); }, 200);
}

function applyTrack() {
  if (!V3 || !V3.ok || !track) return;
  appliedTk = track;
  computeRange();
  lastRangeKey = rangeKey();
  buildGround();
  rebuildGeo();
  applyGeoRange();
  applyBase();
  updateLimits();
  buildAircraft();          // 场景建好后才有机体；尺寸/倍率依赖它先存在
  applyCraftScale();
  var w = rangeWin();
  if (w && (pb.t < w.t0 || pb.t > w.t1)) pb.t = w.t0;
  camPreset('fit');
  updateFrame();
  updateRangeUI();
}

/* ---------- 回放 ---------- */
function lerp(a, b, f) { return a + (b - a) * f; }
function sampleIdx(tk, tt) {
  var n = tk.n, t = tk.t;
  if (tt <= t[0]) return { i: 0, f: 0 };
  if (tt >= t[n - 1]) return { i: n - 1, f: 0 };
  var lo = 0, hi = n - 1, mid;
  while (hi - lo > 1) { mid = (lo + hi) >> 1; if (t[mid] <= tt) lo = mid; else hi = mid; }
  var span = t[hi] - t[lo];
  return { i: lo, f: span > 0 ? (tt - t[lo]) / span : 0 };
}
function logById(id) {
  for (var i = 0; i < logs.length; i++) if (logs[i].id === id) return logs[i];
  return null;
}
function modeAt(log, t) {
  if (!log) return null;
  var m = log.msgs['MODE'];
  if (!m) return null;
  var fn = m.fields['ModeNum'] ? 'ModeNum' : (m.fields['Mode'] ? 'Mode' : null);
  if (!fn) return null;
  var last = null;
  for (var i = 0; i < m.count; i++) {
    if (m.time[i] > t) break;      // 轨迹时间轴是日志原始时间（不含 log.offset）
    last = m.fields[fn][i];
  }
  if (last === null) return m.count ? (MODE_NAME[m.fields[fn][0]] || '—') : null;
  return MODE_NAME[last] || ('MODE' + last);
}

function updateFrame() {
  if (!track || !V3 || !V3.ok) return;
  if (!rng || rngTk !== track) computeRange();
  var w0 = rng.t0, w1 = rng.t1;
  if (pb.t < w0) pb.t = w0; else if (pb.t > w1) pb.t = w1;
  var s = sampleIdx(track, pb.t), i = s.i, f = s.f;
  if (i < rng.i0) { i = rng.i0; f = 0; }
  if (i > rng.i1) { i = rng.i1; f = 0; }
  var j = Math.min(rng.i1, i + 1), exag = exagVal();
  var px = lerp(track.x[i], track.x[j], f);
  var pz = lerp(track.z[i], track.z[j], f);
  var py = lerp(track.alt[i], track.alt[j], f) * exag;
  var roll = lerp(track.roll[i], track.roll[j], f);
  var pitch = lerp(track.pitch[i], track.pitch[j], f);
  var yaw = lerp(track.yaw[i], track.yaw[j], f);

  var c = V3.craft;
  c.position.set(px, py, pz);
  c.rotation.order = 'YXZ';
  c.rotation.set(pitch * RAD, -yaw * RAD, -roll * RAD);

  if (V3.arrow) {
    V3.arrow.visible = $('s3Orient').checked;
    V3.arrow.position.set(px, 0.06, pz);   // 贴地显示，不随高度夸张浮动
    V3.arrow.rotation.y = -yaw * RAD;
    var sc = V3.craft.children.length ? V3.craft.children[0].scale.x : 1;
    V3.arrow.scale.set(Math.max(1, sc), Math.max(1, sc), Math.max(1, sc));
  }
  if (V3.lines) V3.lines.flown.geometry.setDrawRange(rng.i0, i - rng.i0 + 1);
  if (V3.drop) {
    var d0 = Math.floor(rng.i0 / V3.dropStep);
    var di = Math.min(V3.dropN - 1, Math.floor(i / V3.dropStep));
    V3.drop.flown.geometry.setDrawRange(d0 * 2, Math.max(1, di - d0 + 1) * 2);
  }
  if ($('s3Follow').checked) {
    V3.tmp.set(px, py, pz);
    V3.controls.target.lerp(V3.tmp, 0.2);
  }
  updateHUD(i, f, j, px, py, pz, roll, pitch, yaw);
}

function updateHUD(i, f, j, px, py, pz, roll, pitch, yaw) {
  var tk = track;
  var w = rangeWin() || { t0: tk.t0, t1: tk.tEnd };
  var wspan = w.t1 - w.t0;
  $('h3t').textContent = fmtTime(pb.t);
  $('h3d').textContent = '/ ' + fmtTime(w.t1);
  $('p3Time').textContent = fmtTime(pb.t) + ' / ' + fmtTime(w.t1);
  if (!pb.dragging) {
    $('p3Slider').value = wspan > 0 ? Math.round((pb.t - w.t0) / wspan * 1000) : 0;
  }
  var md = modeAt(logById(tk.logId), pb.t);
  var me = $('h3m');
  me.textContent = md || '—';
  me.style.color = md ? modeColor(md) : '#cdd8ef';

  var alt = lerp(tk.alt[i], tk.alt[j], f);
  $('h3alt').textContent = (alt >= 0 ? '+' : '') + alt.toFixed(1) + ' m';
  $('h3spd').textContent = lerp(tk.spd[i], tk.spd[j], f).toFixed(1) + ' m/s';
  $('h3rp').textContent = roll.toFixed(1) + '° / ' + pitch.toFixed(1) + '°';
  var yy = ((yaw % 360) + 360) % 360;
  var tag = tk.yawKey === 'GPS.GCrs' ? 'GPS 航迹' : (tk.yawKey ? (tk.yawKey.indexOf('GPS') === 0 ? 'GPS' : 'EKF') : '无数据');
  $('h3yaw').textContent = yy.toFixed(1) + '° · ' + tag;
  var la = lerp(tk.lat[i], tk.lat[j], f), lo = lerp(tk.lon[i], tk.lon[j], f);
  $('h3pos').textContent = la.toFixed(6) + '°N  ' + lo.toFixed(6) + '°E';
}

var rafId = 0, lastTs = 0;
function startLoop() { if (rafId) return; lastTs = 0; rafId = requestAnimationFrame(loop); }
function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
function loop(ts) {
  rafId = requestAnimationFrame(loop);
  if (!is3DView() || !V3 || !V3.ok) return;
  var dt = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  if (pb.playing && track) {
    var w = rangeWin();
    pb.t += dt * pb.speed;
    if (pb.t >= w.t1) {
      if (pb.loop) pb.t = w.t0;
      else { pb.t = w.t1; setPlay(false); }
    } else if (pb.t < w.t0) pb.t = w.t0;
  }
  updateFrame();
  if (V3.controls.update) V3.controls.update();
  V3.renderer.render(V3.scene, V3.camera);
}
function setPlay(on) {
  pb.playing = !!on;
  $('p3Play').textContent = pb.playing ? '⏸' : '▶';
  $('p3Play').classList.toggle('on', pb.playing);
  lastTs = 0;
}

/* ---------- 视图切换 ---------- */
function refreshEmpty() {
  $('empty').style.display = (!$('chart').hidden && !logs.length) ? 'flex' : 'none';
}
function setView(v) {
  if (v !== 'chart' && v !== '3d' && v !== 'split') return;
  if (v === curView) return;
  curView = v;
  $('btnViewChart').classList.toggle('on', v === 'chart');
  $('btnView3d').classList.toggle('on', v === '3d');
  $('btnViewSplit').classList.toggle('on', v === 'split');
  Array.prototype.forEach.call(document.querySelectorAll('.panel section[data-view]'), function (sec) {
    var w = sec.getAttribute('data-view');
    sec.hidden = !(w === 'both' || w === v || v === 'split');
  });
  $('chart').hidden = (v === '3d');
  $('v3d').hidden = (v === 'chart');
  document.querySelector('.main').classList.toggle('split', v === 'split');
  $('splitter').hidden = (v !== 'split');
  refreshEmpty();
  if (v !== 'chart') {
    syncRangeFromChart();
    enter3D();
    startLoop();
    if (chart) setTimeout(function () { chart.resize(); }, 0);
    resize3D();
  } else {
    stopLoop();
    if (pb.playing) setPlay(false);
    if (chart) setTimeout(function () { chart.resize(); }, 0);
  }
}
function enter3D() {
  refresh3DLogSel();
  var lg = current3DLog();
  if (!lg) {
    showMsg3d('<b>还没有可回放的日志</b><br>请先导入带位置数据（POS / GPS）的 .BIN 日志');
    stopLoop();
    return;
  }
  var tk = ensureTrack(lg);
  if (!tk) {
    showMsg3d('<b>' + esc(lg.name) + '</b><br>该日志没有位置数据（POS / GPS），无法做 3D 回放');
    stopLoop();
    return;
  }
  // 轨迹先落位：即使 WebGL 不可用，调用方也能拿到已解析好的轨迹数据
  if (track !== tk) { track = tk; pb.t = tk.t0; }
  if (!initScene()) { stopLoop(); return; }
  showMsg3d(null);
  if (appliedTk !== track) applyTrack();
  else applyRange({ fit: true });
  resize3D();
  updateFrame();
}

/* =========================================================================
   11. 事件绑定
   ========================================================================= */
$('btnImport').onclick = function () { $('fileInput').click(); };
$('fileInput').onchange = function (e) { handleFiles(e.target.files); e.target.value = ''; };
$('btnClear').onclick = function () {
  invalidatePts();
  logs = []; seriesList = [];
  axes = newAxes();
  trackCache = {}; track = null;
  selRange = null; rng = null; lastRangeKey = null;
  setPlay(false);
  renderLogs(); renderSeries(); refreshLogSelect(); refreshMsgSelect(); refreshEmpty();
  renderAxisBoxes();
  refresh3DLogSel();
  if (is3DView()) enter3D();
  updateChart();
  setStatus('');
};
$('selLog').onchange = refreshMsgSelect;
$('selMsg').onchange = refreshFieldList;
$('msgSearch').oninput = refreshMsgSelect;
$('fieldSearch').oninput = refreshFieldList;
$('btnAdd').onclick = addSeries;
$('optMode').onchange = updateChart;
$('optMax').onchange = updateChart;

/* 全部轴（含独立轴）重置回自动范围 */
$('rstAll').onclick = function () {
  Object.keys(axes).forEach(function (k) { axes[k].zoom = 1; axes[k].off = 0; });
  renderAxisBoxes();
  updateChart();
};

/* ---------- 视图切换 ---------- */
$('btnViewChart').onclick = function () { setView('chart'); };
$('btnView3d').onclick = function () { setView('3d'); };
$('btnViewSplit').onclick = function () { setView('split'); };

/* ---------- 同屏分屏：拖动中间的分隔条调整上下比例 ---------- */
(function () {
  var el = $('splitter'), main = document.querySelector('.main');
  if (!el || !main) return;
  var dragging = false;
  function move(e) {
    var r = main.getBoundingClientRect();
    if (!r.height) return;
    var p = (e.clientY - r.top) / r.height;
    p = Math.max(0.2, Math.min(0.8, p));
    main.style.setProperty('--sp', (p * 100).toFixed(2) + '%');
    if (chart) chart.resize();
    resize3D();
  }
  el.addEventListener('pointerdown', function (e) {
    dragging = true;
    el.classList.add('drag');
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
    e.preventDefault();
  });
  el.addEventListener('pointermove', function (e) { if (dragging) move(e); });
  function stop(e) {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('drag');
    if (e && e.pointerId !== undefined) {
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }
  }
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('dblclick', function () {
    main.style.removeProperty('--sp');
    if (chart) chart.resize();
    resize3D();
  });
})();

/* ---------- 3D 设置 ---------- */
var lastModel = 'wing';
function readDims() {
  return { len: Math.max(0.01, numVal('s3Len', 1.3)),
           wid: Math.max(0.01, numVal('s3Wid', 1.8)),
           hgt: Math.max(0.01, numVal('s3Hgt', 0.45)) };
}
function writeDims(d) {
  $('s3Len').value = d.len; $('s3Wid').value = d.wid; $('s3Hgt').value = d.hgt;
}
function reloadTrack() {
  if (!is3DView()) return;
  var lg = current3DLog();
  var tk = lg ? ensureTrack(lg) : null;
  if (!tk) {
    track = null;
    showMsg3d(lg ? '<b>' + esc(lg.name) + '</b><br>该日志没有位置数据（POS / GPS），无法做 3D 回放'
                 : '<b>还没有可回放的日志</b><br>请先导入带位置数据（POS / GPS）的 .BIN 日志');
    stopLoop();
    return;
  }
  showMsg3d(null);
  if (track !== tk) { track = tk; pb.t = tk.t0; applyTrack(); }
  else { rebuildGeo(); applyGeoRange(); applyCraftScale(); updateFrame(); }
}
$('s3Log').onchange = function () { refresh3DAltSel(); reloadTrack(); };
$('s3Alt').onchange = reloadTrack;
$('s3Yaw').onchange = reloadTrack;
$('s3Base').onchange = function () { if (track) applyBase(); };
$('s3Grid').onchange = function () { if (V3 && V3.ok) V3.gridG.visible = this.checked; };
$('s3Trail').onchange = syncVis;
$('s3Flown').onchange = syncVis;
$('s3Drop').onchange = syncVis;
$('s3Orient').onchange = syncVis;
$('s3Exag').oninput = function () {
  if (!is3DView() || !track) return;
  rebuildGeo(); applyGeoRange(); applyCraftScale(); updateFrame();
};
$('s3Model').onchange = function () {
  DIMS[lastModel] = readDims();
  lastModel = this.value;
  writeDims(DIMS[lastModel]);
  buildAircraft();
};
['s3Len', 's3Wid', 's3Hgt'].forEach(function (id) {
  $(id).oninput = function () { DIMS[lastModel] = readDims(); applyCraftScale(); };
});
$('s3AutoSize').onchange = function () {
  $('s3Scale').disabled = this.checked;
  applyCraftScale();
};
$('s3Scale').oninput = function () { applyCraftScale(); };
$('s3Follow').onchange = function () {
  if (V3 && V3.ok && !this.checked && track) camPreset('fit');
};
/* ---------- 回放时间范围（跟随折线图的时间缩放） ---------- */
$('s3FollowZoom').onchange = function () {
  rangeSync = this.checked;
  if (rangeSync) syncRangeFromChart();
};
$('s3RangeAll').onclick = function () {
  selRange = null;
  if (chart) {
    try {
      var o = chart.getOption();
      var n = (o && o.dataZoom && o.dataZoom.length) ? o.dataZoom.length : 1;
      for (var i = 0; i < n; i++) {
        chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: i, start: 0, end: 100 });
      }
    } catch (e) { /* 没有曲线时忽略 */ }
  }
  if (is3DView()) applyRange({ fit: true });
  else { computeRange(); lastRangeKey = rangeKey(); updateRangeUI(); updateFrame(); }
};
['camTop', 's3CamTop'].forEach(function (id) {
  $(id).onclick = function () { camPreset('top'); };
});
['camSide', 's3CamSide'].forEach(function (id) {
  $(id).onclick = function () { camPreset('side'); };
});
['camFit', 's3CamFit'].forEach(function (id) {
  $(id).onclick = function () { camPreset('fit'); };
});

/* ---------- 3D 回放控制 ---------- */
$('p3Start').onclick = function () { var w = rangeWin(); if (w) { pb.t = w.t0; updateFrame(); } };
$('p3End').onclick = function () { var w = rangeWin(); if (w) { pb.t = w.t1; updateFrame(); } };
$('p3Play').onclick = function () {
  var w = rangeWin();
  if (!w) return;
  if (!pb.playing && pb.t >= w.t1) pb.t = w.t0;
  setPlay(!pb.playing);
};
$('p3Speed').onchange = function () { pb.speed = parseFloat(this.value) || 1; };
$('p3Loop').onchange = function () { pb.loop = this.checked; };
$('p3Slider').addEventListener('pointerdown', function () { pb.dragging = true; });
window.addEventListener('pointerup', function () {
  if (!pb.dragging) return;
  pb.dragging = false;
  if (track) updateFrame();
});
$('p3Slider').oninput = function () {
  var w = rangeWin();
  if (!w) return;
  pb.t = w.t0 + (parseInt(this.value, 10) / 1000) * (w.t1 - w.t0);
  updateFrame();
};
document.addEventListener('keydown', function (e) {
  if (!is3DView() || !track) return;
  var tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); $('p3Play').click(); }
});
window.addEventListener('resize', function () { resize3D(); });

document.addEventListener('dragover', function (e) { e.preventDefault(); $('app').classList.add('drag'); });
document.addEventListener('dragleave', function (e) {
  if (e.relatedTarget === null) $('app').classList.remove('drag');
});
document.addEventListener('drop', function (e) {
  e.preventDefault();
  $('app').classList.remove('drag');
  if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
});

/* 初始化 */
writeDims(DIMS.wing);
$('s3Scale').disabled = true;
renderLogs(); renderSeries(); refreshLogSelect(); refreshMsgSelect(); refreshEmpty();
renderAxisBoxes();
refresh3DLogSel();
updateChart();
setView('split');          // 默认同屏：上面折线图、下面 3D 回放

/* 供自动化测试取用的内部句柄 */
function r3(v) { return Math.round(v * 1000) / 1000; }
window.__APM = {
  setView: setView, buildTrack: buildTrack, getTrack: function () { return track; },
  getLogs: function () { return logs; }, sampleIdx: sampleIdx, DIMS: DIMS,
  state: function () { return { view: curView, playing: pb.playing, t: pb.t,
                                scene: !!(V3 && V3.ok), msg: $('msg3d').textContent,
                                range: rng ? [rng.t0, rng.t1] : null }; },
  /* 当前 3D 显示/回放区间（由折线图时间缩放切割而来） */
  getRange: function () {
    return rng ? { i0: rng.i0, i1: rng.i1, t0: rng.t0, t1: rng.t1, cut: !!rng.cut,
                   extent: rng.extent, dist: rng.dist, n: rng.i1 - rng.i0 + 1 } : null;
  },
  setRange: function (a, b) {
    selRange = (a === null || b === null || !(b > a)) ? null : { t0: a, t1: b };
    if (is3DView()) applyRange({ fit: true });
    else { computeRange(); lastRangeKey = rangeKey(); updateRangeUI(); }
  },
  syncRange: function () { syncRangeFromChart(); },   // 立即同步（测试用，跳过防抖）
  chartWindow: chartWindow,
  /* 同步驱动一帧：浏览器窗口不可见时 rAF 会停摆，测试用它直接推进回放并渲染 */
  step: function (t) {
    if (typeof t === 'number' && track) {
      var w = rangeWin() || { t0: track.t0, t1: track.tEnd };
      pb.t = Math.max(w.t0, Math.min(w.t1, t));
      if (pb.playing) setPlay(false);
    }
    updateFrame();
    if (V3 && V3.ok) {
      if (V3.controls.update) V3.controls.update();
      V3.renderer.render(V3.scene, V3.camera);
    }
    return { t: pb.t, hud: $('h3alt').textContent, yaw: $('h3yaw').textContent,
             mode: $('h3m').textContent, bar: $('p3Time').textContent };
  },
  /* 场景体检：相机/模型/绘制范围/渲染统计，供自动化测试读取 */
  info: function () {
    if (!V3 || !V3.ok) return { scene: false };
    var cam = V3.camera, c = V3.craft;
    var vec = function (v) { return [r3(v.x), r3(v.y), r3(v.z)]; };
    return {
      scene: true,
      cam: { pos: vec(cam.position), target: vec(V3.controls.target), up: vec(cam.up) },
      craft: { pos: vec(c.position), rot: [r3(c.rotation.x), r3(c.rotation.y), r3(c.rotation.z)],
               order: c.rotation.order,
               scale: V3.craft.children.length ? vec(V3.craft.children[0].scale) : null,
               model: $('s3Model').value },
      objs: { solid: V3.solid.children.length, grid: V3.gridG.children.length,
              tiles: V3.tiles.children.length, track: V3.trackG.children.length,
              craft: V3.craft.children.length },
      draw: { trail: V3.lines ? V3.lines.full.geometry.drawRange.count : -1,
              trailStart: V3.lines ? V3.lines.full.geometry.drawRange.start : -1,
              flown: V3.lines ? V3.lines.flown.geometry.drawRange.count : -1,
              flownStart: V3.lines ? V3.lines.flown.geometry.drawRange.start : -1,
              dropFlown: V3.drop ? V3.drop.flown.geometry.drawRange.count : -1,
              dropStart: V3.drop ? V3.drop.full.geometry.drawRange.start : -1,
              dropCount: V3.drop ? V3.drop.full.geometry.drawRange.count : -1 },
      vis: { trail: V3.lines ? V3.lines.full.visible : null,
             flown: V3.lines ? V3.lines.flown.visible : null,
             drop: V3.drop ? V3.drop.full.visible : null,
             arrow: V3.arrow ? V3.arrow.visible : null,
             grid: V3.gridG.visible, solid: V3.solid.visible },
      render: { calls: V3.renderer.info.render.calls,
                tris: V3.renderer.info.render.triangles,
                lines: V3.renderer.info.render.lines }
    };
  }
};

})();
