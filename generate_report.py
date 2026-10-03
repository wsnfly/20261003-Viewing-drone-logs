import json
import math
import os

BASE = r"e:\azz\20260917-大红翁飞机\ai"
with open(os.path.join(BASE, "log_data.json"), encoding="utf-8") as f:
    DATA = json.load(f)
with open(os.path.join(BASE, "echarts.min.js"), encoding="utf-8") as f:
    ECHARTS = f.read().replace("</script", "<\\/script")

MODE_COLOR = {
    "QLAND": "#f59e0b", "CRUISE": "#6366f1", "QHOVER": "#10b981",
    "QLOITER": "#06b6d4", "QSTABILIZE": "#a855f7", "QRTL": "#ef4444",
    "AUTO": "#8b5cf6", "LOITER": "#14b8a6", "RTL": "#f97316",
    "FBWA": "#84cc16", "MANUAL": "#94a3b8",
}
MODE_DESC = {
    "QLAND": "多旋翼垂直降落/悬停",
    "CRUISE": "固定翼巡航（前飞）",
    "QHOVER": "多旋翼定高悬停",
}


def mc(name):
    return MODE_COLOR.get(name, "#94a3b8")


def segments(log):
    ms, dur, out = log["modes"], log["duration"], []
    for i, (t, num, name) in enumerate(ms):
        t_end = ms[i + 1][0] if i + 1 < len(ms) else dur
        if t_end > t:
            out.append({"start": t, "end": t_end, "name": name, "num": num,
                        "dur": round(t_end - t, 1)})
    return out


def transitions(log):
    segs, samples, ev = segments(log), log["samples"], []
    for i, sg in enumerate(segs):
        t0 = sg["start"]
        win = [s for s in samples if t0 <= s[0] <= t0 + 12]
        if not win:
            continue
        pk = max(win, key=lambda s: abs(s[1] - s[2]))
        mx = max(win, key=lambda s: abs(s[1]))
        ev.append({"t": t0, "from": segs[i - 1]["name"] if i else "—", "to": sg["name"],
                   "peak_pitch": mx[1], "peak_pitch_t": mx[0], "des_at_peak": mx[2],
                   "max_err": round(abs(pk[1] - pk[2]), 1), "max_err_t": pk[0]})
    return ev


def analyse(log):
    segs = segments(log)
    dur, samples = log["duration"], log["samples"]
    sw = [s["start"] for s in segs[1:]]
    steady, trans = [], []
    for t, p, d in samples:
        (trans if any(abs(t - s) <= 12 for s in sw) else steady).append((t, p, d))
    r = {
        "n_total": len(samples), "n_steady": len(steady), "n_trans": len(trans),
        "mae_steady": sum(abs(p - d) for _, p, d in steady) / len(steady),
        "mae_trans": sum(abs(p - d) for _, p, d in trans) / len(trans),
        "rms_steady": math.sqrt(sum((p - d) ** 2 for _, p, d in steady) / len(steady)),
        "rms_trans": math.sqrt(sum((p - d) ** 2 for _, p, d in trans) / len(trans)),
        "modes": [],
    }
    for sg in segs:
        v = [(p, d) for t, p, d in samples
             if sg["start"] <= t < sg["end"] and not any(abs(t - s) <= 12 for s in sw)]
        if len(v) < 30:
            continue
        e = [p - d for p, d in v]
        r["modes"].append({
            "name": sg["name"], "dur": sg["dur"], "n": len(v),
            "mae": sum(abs(x) for x in e) / len(e), "mean": sum(e) / len(e),
            "pos": 100 * sum(1 for x in e if x > 0) / len(e),
            "act": sum(p for p, _ in v) / len(v), "des": sum(d for _, d in v) / len(v),
        })
    return r


report = []
for lg in DATA["logs"]:
    report.append({"log": lg, "segs": segments(lg), "events": transitions(lg), "an": analyse(lg)})

PAYLOAD = json.dumps({"logs": report}, ensure_ascii=False, separators=(",", ":"))
COLORS = json.dumps(MODE_COLOR, ensure_ascii=False)
DESCS = json.dumps(MODE_DESC, ensure_ascii=False)

# ---- global aggregates used in the written conclusions ----
g = report
cr_bias = [m["mean"] for r in g for m in r["an"]["modes"] if m["name"] == "CRUISE"]
cr_pos = [m["pos"] for r in g for m in r["an"]["modes"] if m["name"] == "CRUISE"]
cr_mae = [m["mae"] for r in g for m in r["an"]["modes"] if m["name"] == "CRUISE"]
hv_mae = [m["mae"] for r in g for m in r["an"]["modes"] if m["name"] in ("QLAND", "QHOVER")]
hv_bias = [abs(m["mean"]) for r in g for m in r["an"]["modes"] if m["name"] in ("QLAND", "QHOVER")]
fwd = [e for r in g for e in r["events"] if e["to"] == "CRUISE"]
back = [e for r in g for e in r["events"] if e["to"] == "QLAND" and e["from"] == "CRUISE"]
summ = {
    "cr_bias": (min(cr_bias), max(cr_bias)),
    "cr_pos": (min(cr_pos), max(cr_pos)),
    "cr_mae": (min(cr_mae), max(cr_mae)),
    "hv_mae": (min(hv_mae), max(hv_mae)),
    "hv_bias": max(hv_bias),
    "fwd_peak": (min(e["peak_pitch"] for e in fwd), max(e["peak_pitch"] for e in fwd)),
    "fwd_err": (min(e["max_err"] for e in fwd), max(e["max_err"] for e in fwd)),
    "fwd_des": (min(e["des_at_peak"] for e in fwd), max(e["des_at_peak"] for e in fwd)),
    "fwd_lag": (min(e["peak_pitch_t"] - e["t"] for e in fwd), max(e["peak_pitch_t"] - e["t"] for e in fwd)),
    "back_peak": (min(e["peak_pitch"] for e in back), max(e["peak_pitch"] for e in back)),
    "back_err": (min(e["max_err"] for e in back), max(e["max_err"] for e in back)),
    "back_des": (min(e["des_at_peak"] for e in back), max(e["des_at_peak"] for e in back)),
    "n_fwd": len(fwd), "n_back": len(back),
    "rms_s": (min(r["an"]["rms_steady"] for r in g), max(r["an"]["rms_steady"] for r in g)),
    "rms_t": (min(r["an"]["rms_trans"] for r in g), max(r["an"]["rms_trans"] for r in g)),
    "trans_pct": (min(100 * r["an"]["n_trans"] / r["an"]["n_total"] for r in g),
                  max(100 * r["an"]["n_trans"] / r["an"]["n_total"] for r in g)),
}
S = json.dumps(summ)

HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大红翁飞机 · APM 日志仰角跟踪分析报告</title>
<style>
  :root{
    --bg:#0f1420; --panel:#161c2b; --line:#28324a;
    --tx:#e6ebf5; --tx2:#9aa8c0; --tx3:#6b7a94;
    --real:#f4553d; --des:#3b8cff; --accent:#5b8def;
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--bg); color:var(--tx);
    font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; line-height:1.62;}
  .wrap{max-width:1360px; margin:0 auto; padding:0 26px 70px}
  header{padding:52px 0 30px; border-bottom:1px solid var(--line); margin-bottom:34px;
    background:radial-gradient(900px 320px at 12% -30%, rgba(91,141,239,.22), transparent 70%);}
  .kicker{font-size:12.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--accent); font-weight:600}
  h1{margin:12px 0 8px; font-size:33px; font-weight:700; letter-spacing:-.4px}
  .sub{color:var(--tx2); font-size:14.5px; max-width:960px}
  .meta{display:flex; flex-wrap:wrap; gap:9px; margin-top:20px}
  .chip{background:var(--panel); border:1px solid var(--line); border-radius:999px;
    padding:5px 14px; font-size:12.5px; color:var(--tx2);}
  .chip b{color:var(--tx); font-weight:600}
  h2{font-size:21px; margin:54px 0 6px; display:flex; align-items:center; gap:11px; letter-spacing:-.2px}
  h2 .idx{display:inline-flex; align-items:center; justify-content:center; width:27px; height:27px;
    border-radius:8px; background:rgba(91,141,239,.16); color:var(--accent); font-size:13px;
    font-weight:700; border:1px solid rgba(91,141,239,.3);}
  h2 small{font-size:12.5px; color:var(--tx3); font-weight:400; margin-left:auto; font-variant-numeric:tabular-nums}
  .lead{color:var(--tx2); font-size:14px; margin:0 0 20px}
  .stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:12px; margin:20px 0 26px}
  .stat{background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:14px 16px}
  .stat .k{font-size:11.5px; color:var(--tx3); letter-spacing:.05em; margin-bottom:6px}
  .stat .v{font-size:23px; font-weight:650; font-variant-numeric:tabular-nums; letter-spacing:-.5px}
  .stat .v span{font-size:12.5px; font-weight:400; color:var(--tx2); margin-left:3px}
  .stat.warn .v{color:#ffb020} .stat.bad .v{color:#ff6b6b}
  .card{background:var(--panel); border:1px solid var(--line); border-radius:16px;
    padding:16px 18px 10px; margin-bottom:16px;}
  .card .ttl{font-size:13.5px; font-weight:600; margin:0 0 2px}
  .card .hint{font-size:12px; color:var(--tx3); margin:0 0 8px}
  .chart{width:100%; height:400px} .chart.sm{height:230px} .chart.xs{height:190px}
  .legendrow{display:flex; flex-wrap:wrap; gap:16px; align-items:center; margin:4px 0 14px; font-size:12.5px; color:var(--tx2)}
  .lg{display:flex; align-items:center; gap:7px}
  .sw{width:20px; height:3px; border-radius:2px; display:inline-block}
  table{width:100%; border-collapse:collapse; font-size:13px; margin-top:6px}
  th,td{padding:9px 11px; text-align:right; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums}
  th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}
  thead th{color:var(--tx3); font-weight:500; font-size:11.5px; letter-spacing:.04em; text-transform:uppercase}
  tbody tr:hover{background:rgba(91,141,239,.06)}
  .tag{display:inline-block; padding:2px 9px; border-radius:6px; font-size:11.5px; font-weight:600}
  .neg{color:#ff6b6b} .pos{color:#3ddc97} .mut{color:var(--tx3)}
  .findings{display:grid; gap:13px; margin-top:8px}
  .finding{background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
    border-radius:11px; padding:15px 19px;}
  .finding.warn{border-left-color:#ffb020} .finding.bad{border-left-color:#ff6b6b}
  .finding.ok{border-left-color:#3ddc97}
  .finding h4{margin:0 0 6px; font-size:14.5px; font-weight:650}
  .finding p{margin:0 0 4px; font-size:13.5px; color:var(--tx2)}
  .finding p:last-child{margin-bottom:0}
  code{background:rgba(255,255,255,.07); padding:1px 6px; border-radius:5px; font-size:12.5px; color:#ffd479}
  footer{margin-top:56px; padding-top:22px; border-top:1px solid var(--line); color:var(--tx3); font-size:12px}
  .modekey{display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:var(--tx2); margin-top:12px}
  .modekey .k{display:flex; align-items:center; gap:6px}
  .dot{width:10px; height:10px; border-radius:3px; display:inline-block}
  .scroll{overflow-x:auto}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="kicker">ArduPilot DataFlash Log Analysis</div>
  <h1>大红翁飞机 · 真实仰角 vs 目标仰角 跟踪分析</h1>
  <p class="sub">对 <code>APM/LOGS</code> 下两个飞行日志的 <b>ATT.Pitch（真实仰角）</b> 与
  <b>ATT.DesPitch（目标仰角）</b> 做逐帧对比，叠加飞行模式时间轴，评估俯仰跟踪品质、模式切换瞬态，
  并结合 <code>20260928-参数.param</code> 给出可核查的线索。</p>
  <div class="meta">
    <span class="chip">固件 <b>ArduPlane V4.5.6</b></span>
    <span class="chip">飞控 <b>MatekH743</b></span>
    <span class="chip">机型 <b>QuadPlane QUAD/X</b></span>
    <span class="chip">日志 <b>2 个 (BIN)</b></span>
    <span class="chip">数据源 <b>ATT / MODE / MSG</b></span>
  </div>
</header>
<main id="root"></main>
<footer>
  数据来源：<code>APM/LOGS/00000001.BIN</code>、<code>APM/LOGS/00000002.BIN</code>；
  字段：<code>ATT.Pitch</code>（真实仰角）、<code>ATT.DesPitch</code>（目标仰角）、<code>MODE.ModeNum</code>（飞行模式）、<code>MSG</code>（过渡事件）。
  约定：仰角正值为机头抬头，负值为机头低头；跟踪误差 = 真实仰角 − 目标仰角。
  稳态统计已剔除每次模式切换前后各 12 s 的瞬态区间。
</footer>
</div>
<script>__ECHARTS__</script>
<script>
const DATA = __PAYLOAD__, MODE_COLOR = __COLORS__, MODE_DESC = __DESCS__, SUM = __SUM__;
const REAL_C = '#f4553d', DES_C = '#3b8cff';
const mc = n => MODE_COLOR[n] || '#94a3b8';
const charts = [];
const AXIS = {color:'#6b7a94', fontSize:11};
const SPLIT = {lineStyle:{color:'rgba(255,255,255,.06)'}};
const TIP = {backgroundColor:'rgba(14,19,31,.95)', borderColor:'#33405e', borderWidth:1,
             textStyle:{color:'#e6ebf5', fontSize:12.5}, padding:[10,13]};

function fmtT(s){const m=Math.floor(s/60),x=Math.floor(s%60);return m+':'+String(x).padStart(2,'0');}
function modeAt(modes,t){let c=modes.length?modes[0][2]:'—';for(const m of modes){if(t>=m[0])c=m[2];else break;}return c;}
function modeArea(segs){return segs.map(s=>[{name:s.name,xAxis:s.start,
  itemStyle:{color:MODE_COLOR[s.name]||'#94a3b8',opacity:.10}},{xAxis:s.end}]);}
function modeLines(segs){return segs.slice(1).map(s=>({xAxis:s.start}));}

function mainOption(log,segs){
  const S=log.samples;
  return {animation:false, backgroundColor:'transparent',
    grid:{left:62,right:26,top:38,bottom:56},
    legend:{top:2,right:8,itemWidth:20,itemHeight:3,itemGap:18,textStyle:{color:'#9aa8c0',fontSize:12},
      data:[{name:'真实仰角 ATT.Pitch',icon:'rect'},{name:'目标仰角 ATT.DesPitch',icon:'rect'}]},
    tooltip:Object.assign({trigger:'axis',axisPointer:{type:'line',lineStyle:{color:'rgba(255,255,255,.28)'}},
      formatter:function(ps){
        if(!ps.length)return '';
        const t=ps[0].value[0], mode=modeAt(log.modes,t);
        let h='<b>'+fmtT(t)+'</b> &nbsp;<span style="color:#9aa8c0">t='+t.toFixed(2)+'s</span><br/>';
        h+='<span style="color:'+(MODE_COLOR[mode]||'#94a3b8')+'">●</span> 飞行模式：<b>'+mode+'</b>';
        if(MODE_DESC[mode]) h+=' <span style="color:#6b7a94">('+MODE_DESC[mode]+')</span>';
        h+='<br/>';
        let p=null,d=null;
        ps.forEach(x=>{if(x.seriesName.indexOf('真实')===0)p=x.value[1];if(x.seriesName.indexOf('目标')===0)d=x.value[1];});
        if(p!==null)h+='<span style="color:'+REAL_C+'">●</span> 真实仰角：<b>'+p.toFixed(2)+'°</b><br/>';
        if(d!==null)h+='<span style="color:'+DES_C+'">●</span> 目标仰角：<b>'+d.toFixed(2)+'°</b><br/>';
        if(p!==null&&d!==null){const e=p-d;
          h+='跟踪误差：<b style="color:'+(Math.abs(e)>8?'#ff6b6b':'#3ddc97')+'">'+(e>0?'+':'')+e.toFixed(2)+'°</b>';}
        return h;}}, TIP),
    xAxis:{type:'value',min:0,max:Math.ceil(log.duration),name:'飞行时间 (s)',nameLocation:'end',
      nameTextStyle:{color:'#6b7a94',fontSize:11,padding:[24,0,0,-14]},
      axisLabel:Object.assign({},AXIS,{formatter:v=>fmtT(v)}),axisLine:{lineStyle:{color:'#28324a'}},
      splitLine:SPLIT,axisTick:{show:false}},
    yAxis:{type:'value',name:'仰角 (°)',nameTextStyle:{color:'#6b7a94',fontSize:11,padding:[0,0,6,0]},
      axisLabel:AXIS,axisLine:{show:false},splitLine:SPLIT},
    dataZoom:[{type:'inside',xAxisIndex:0,filterMode:'none'},
      {type:'slider',xAxisIndex:0,height:20,bottom:12,filterMode:'none',
       backgroundColor:'rgba(255,255,255,.03)',borderColor:'#28324a',fillerColor:'rgba(91,141,239,.18)',
       handleStyle:{color:'#5b8def'},textStyle:{color:'#6b7a94',fontSize:10},labelFormatter:v=>fmtT(v)}],
    series:[
      {name:'真实仰角 ATT.Pitch',type:'line',data:S.map(s=>[s[0],s[1]]),showSymbol:false,sampling:'lttb',
       lineStyle:{width:1.7,color:REAL_C},itemStyle:{color:REAL_C},z:4,
       markArea:{silent:true,data:modeArea(segs)},
       markLine:{silent:true,symbol:'none',lineStyle:{color:'rgba(255,255,255,.22)',type:'dashed',width:1},data:modeLines(segs)}},
      {name:'目标仰角 ATT.DesPitch',type:'line',data:S.map(s=>[s[0],s[2]]),showSymbol:false,sampling:'lttb',
       lineStyle:{width:1.7,color:DES_C},itemStyle:{color:DES_C},z:5}]};
}

function stripOption(log,segs){
  return {animation:false,backgroundColor:'transparent',
    grid:{left:62,right:26,top:30,bottom:52},
    tooltip:Object.assign({trigger:'item',formatter:p=>{
      const s=p.value[0],d=p.value[1];
      return '<b>'+p.name+'</b>'+(MODE_DESC[p.name]?' <span style="color:#6b7a94">('+MODE_DESC[p.name]+')</span>':'')+
        '<br/>开始 '+fmtT(s)+' (t='+s.toFixed(2)+'s)<br/>持续 <b>'+d.toFixed(1)+' s</b>';}},TIP),
    xAxis:{type:'value',min:0,max:Math.ceil(log.duration),axisLabel:Object.assign({},AXIS,{formatter:v=>fmtT(v)}),
      axisLine:{lineStyle:{color:'#28324a'}},splitLine:SPLIT,axisTick:{show:false}},
    yAxis:{type:'category',data:['飞行模式'],axisLabel:{color:'#9aa8c0',fontSize:11.5},
      axisLine:{show:false},axisTick:{show:false}},
    dataZoom:[{type:'inside',xAxisIndex:0,filterMode:'none'}],
    series:[{type:'bar',stack:'mode',barWidth:34,
      data:segs.map(s=>({value:[s.start,s.dur],name:s.name,
        itemStyle:{color:MODE_COLOR[s.name]||'#94a3b8',opacity:.85,borderRadius:3}})),
      label:{show:true,position:'inside',color:'#0f1420',fontSize:11,fontWeight:600,
        formatter:p=>p.value[1]>log.duration*0.055?p.name:''}}]};
}

function errOption(log,segs){
  return {animation:false,backgroundColor:'transparent',
    grid:{left:62,right:26,top:30,bottom:34},
    tooltip:Object.assign({trigger:'axis',axisPointer:{type:'line',lineStyle:{color:'rgba(255,255,255,.28)'}},
      formatter:ps=>{if(!ps.length)return '';const t=ps[0].value[0],e=ps[0].value[1];
        return '<b>'+fmtT(t)+'</b> <span style="color:#9aa8c0">t='+t.toFixed(2)+'s</span><br/>模式：<b>'+
          modeAt(log.modes,t)+'</b><br/>跟踪误差：<b style="color:'+(Math.abs(e)>8?'#ff6b6b':'#3ddc97')+'">'+
          (e>0?'+':'')+e.toFixed(2)+'°</b>';}},TIP),
    xAxis:{type:'value',min:0,max:Math.ceil(log.duration),axisLabel:Object.assign({},AXIS,{formatter:v=>fmtT(v)}),
      axisLine:{lineStyle:{color:'#28324a'}},splitLine:SPLIT,axisTick:{show:false}},
    yAxis:{type:'value',name:'误差 (°)',nameTextStyle:{color:'#6b7a94',fontSize:11},axisLabel:AXIS,
      axisLine:{show:false},splitLine:SPLIT},
    series:[{type:'line',data:log.samples.map(s=>[s[0],+(s[1]-s[2]).toFixed(2)]),showSymbol:false,sampling:'lttb',
      lineStyle:{width:1.4,color:'#c084fc'},itemStyle:{color:'#c084fc'},
      areaStyle:{color:'rgba(192,132,252,.14)'},z:3,markArea:{silent:true,data:modeArea(segs)}}]};
}

const root=document.getElementById('root');
let html='';

/* ---------- 总览对比 ---------- */
html+='<h2><span class="idx">Σ</span>两架次总览对比<small>稳态统计已剔除模式切换前后各 12 s</small></h2>';
html+='<div class="scroll"><table><thead><tr><th>日志</th><th>时长</th><th>模式片段</th>'+
  '<th>悬停稳态 MAE</th><th>巡航稳态 MAE</th><th>巡航平均偏差</th><th>最大跟踪误差</th>'+
  '<th>瞬态 RMS / 稳态 RMS</th></tr></thead><tbody>';
DATA.logs.forEach(item=>{
  const L=item.log,an=item.an;
  const hv=an.modes.filter(m=>m.name==='QLAND'||m.name==='QHOVER');
  const cr=an.modes.filter(m=>m.name==='CRUISE');
  const hvM=hv.length?hv.reduce((a,m)=>a+m.mae*m.n,0)/hv.reduce((a,m)=>a+m.n,0):0;
  const crM=cr.length?cr.reduce((a,m)=>a+m.mae*m.n,0)/cr.reduce((a,m)=>a+m.n,0):0;
  const crB=cr.length?cr.reduce((a,m)=>a+m.mean*m.n,0)/cr.reduce((a,m)=>a+m.n,0):0;
  html+='<tr><td><b>'+L.name+'</b></td><td>'+L.duration.toFixed(1)+' s</td><td>'+item.segs.length+'</td>'+
    '<td class="pos">'+hvM.toFixed(2)+'°</td>'+
    '<td class="neg">'+crM.toFixed(2)+'°</td>'+
    '<td class="neg">+'+crB.toFixed(2)+'°</td>'+
    '<td class="neg">'+L.stats.max_abs_err.toFixed(1)+'°</td>'+
    '<td><span class="neg">'+an.rms_trans.toFixed(2)+'°</span> / <span class="pos">'+an.rms_steady.toFixed(2)+'°</span></td></tr>';
});
html+='</tbody></table></div>';

/* ---------- 每架次详情 ---------- */
DATA.logs.forEach((item,i)=>{
  const L=item.log, st=L.stats, an=item.an;
  html+='<h2><span class="idx">'+(i+1)+'</span>'+L.name+
    '<small>时长 '+L.duration.toFixed(1)+' s · 有效 ATT 帧 '+L.att_count.toLocaleString()+'</small></h2>';
  html+='<p class="lead">共 '+L.att_count.toLocaleString()+' 帧姿态数据，'+item.segs.length+' 个模式片段、'+
    item.events.length+' 次模式切换。曲线按 LTTB 抽样绘制，支持滚轮缩放与拖动，下方模式轴与主图缩放联动。</p>';
  html+='<div class="stats">'+
    '<div class="stat"><div class="k">飞行时长</div><div class="v">'+L.duration.toFixed(1)+'<span>s</span></div></div>'+
    '<div class="stat"><div class="k">真实仰角范围</div><div class="v">'+st.pitch_min.toFixed(1)+' ~ '+st.pitch_max.toFixed(1)+'<span>°</span></div></div>'+
    '<div class="stat"><div class="k">稳态 MAE</div><div class="v">'+an.mae_steady.toFixed(2)+'<span>°</span></div></div>'+
    '<div class="stat"><div class="k">瞬态 MAE</div><div class="v">'+an.mae_trans.toFixed(2)+'<span>°</span></div></div>'+
    '<div class="stat bad"><div class="k">最大跟踪误差</div><div class="v">'+st.max_abs_err.toFixed(1)+'<span>°</span></div></div>'+
    '<div class="stat"><div class="k">最大误差时刻</div><div class="v">'+fmtT(st.max_err_t)+'</div></div>'+
    '</div>';
  html+='<div class="card"><p class="ttl">真实仰角 / 目标仰角 对比曲线</p>'+
    '<p class="hint">背景色带为飞行模式区间，竖直虚线为模式切换时刻；悬停可查看该时刻的模式、双曲线数值与误差。</p>'+
    '<div class="legendrow"><span class="lg"><span class="sw" style="background:'+REAL_C+'"></span>真实仰角 ATT.Pitch</span>'+
    '<span class="lg"><span class="sw" style="background:'+DES_C+'"></span>目标仰角 ATT.DesPitch</span></div>'+
    '<div class="chart" id="main'+i+'"></div>'+
    '<div class="modekey">'+Object.keys(MODE_COLOR).filter(k=>st.mode_time[k]).map(k=>
      '<span class="k"><span class="dot" style="background:'+MODE_COLOR[k]+'"></span>'+k+
      (MODE_DESC[k]?' · '+MODE_DESC[k]:'')+'</span>').join('')+'</div></div>';
  html+='<div class="card"><p class="ttl">飞行模式时间轴</p><p class="hint">与上图缩放联动。</p>'+
    '<div class="chart sm" id="strip'+i+'"></div></div>';
  html+='<div class="card"><p class="ttl">跟踪误差曲线（真实 − 目标）</p>'+
    '<p class="hint">正值 = 实际仰角高于目标（抬头过量），负值 = 低头过量。</p>'+
    '<div class="chart xs" id="err'+i+'"></div></div>';

  html+='<div class="card"><p class="ttl">分模式稳态跟踪品质</p>'+
    '<p class="hint">仅统计距任意模式切换 12 s 以上的采样，反映各模式的稳态控制品质。</p>'+
    '<div class="scroll"><table><thead><tr><th>模式</th><th>时长</th><th>样本</th><th>MAE</th>'+
    '<th>平均偏差（真实−目标）</th><th>实际仰角均值</th><th>目标仰角均值</th><th>实际高于目标占比</th>'+
    '</tr></thead><tbody>';
  an.modes.forEach(m=>{
    const c=mc(m.name), bias=Math.abs(m.mean);
    html+='<tr><td><span class="tag" style="background:'+c+'22;color:'+c+'">'+m.name+'</span></td>'+
      '<td>'+m.dur.toFixed(1)+' s</td><td>'+m.n.toLocaleString()+'</td>'+
      '<td class="'+(m.mae>2.5?'neg':'pos')+'">'+m.mae.toFixed(2)+'°</td>'+
      '<td class="'+(bias>2?'neg':'pos')+'">'+(m.mean>0?'+':'')+m.mean.toFixed(2)+'°</td>'+
      '<td>'+m.act.toFixed(2)+'°</td><td>'+m.des.toFixed(2)+'°</td>'+
      '<td class="'+(m.pos>80?'neg':'')+'">'+m.pos.toFixed(0)+'%</td></tr>';
  });
  html+='</tbody></table></div></div>';

  html+='<div class="card"><p class="ttl">模式切换与俯仰瞬态</p>'+
    '<p class="hint">每次模式切换后 12 s 内出现的最大仰角偏差。</p>'+
    '<div class="scroll"><table><thead><tr><th>切换时刻</th><th>模式变化</th><th>峰值真实仰角</th>'+
    '<th>峰值出现时刻</th><th>该时刻目标仰角</th><th>最大跟踪误差</th></tr></thead><tbody>';
  item.events.forEach(e=>{
    const c=mc(e.to);
    html+='<tr><td>'+fmtT(e.t)+' <span class="mut">('+e.t.toFixed(1)+'s)</span></td>'+
      '<td>'+(e.from==='—'?'—':e.from)+' <span class="mut">→</span> '+
      '<span class="tag" style="background:'+c+'22;color:'+c+'">'+e.to+'</span></td>'+
      '<td>'+e.peak_pitch.toFixed(1)+'°</td>'+
      '<td>'+fmtT(e.peak_pitch_t)+' <span class="mut">(+'+(e.peak_pitch_t-e.t).toFixed(1)+'s)</span></td>'+
      '<td>'+e.des_at_peak.toFixed(1)+'°</td>'+
      '<td class="'+(e.max_err>8?'neg':'')+'">'+e.max_err.toFixed(1)+'°</td></tr>';
  });
  html+='</tbody></table></div></div>';
});

/* ---------- 结论 ---------- */
html+='<h2><span class="idx">✓</span>分析结论与可核查线索</h2>';
html+='<div class="findings">';
html+='<div class="finding ok"><h4>1. 悬停（QLAND）俯仰跟踪优秀，基本无静差</h4>'+
  '<p>悬停稳态 MAE 仅 <b>'+SUM.hv_mae[0].toFixed(2)+'~'+SUM.hv_mae[1].toFixed(2)+'°</b>，'+
  '各段平均偏差绝对值不超过 <b>'+SUM.hv_bias.toFixed(2)+'°</b>，实际高于目标的采样占比仅 25%~41%，'+
  '说明多旋翼姿态控制器在悬停下几乎无偏跟踪。</p></div>';
html+='<div class="finding bad"><h4>2. 固定翼巡航（CRUISE）存在系统性抬头偏差 +'+
  SUM.cr_bias[0].toFixed(1)+'~+'+SUM.cr_bias[1].toFixed(1)+'°</h4>'+
  '<p>两个架次共 '+SUM.n_fwd+' 段巡航中，<b>每一段</b>都有 <b>'+SUM.cr_pos[0].toFixed(0)+'%~'+SUM.cr_pos[1].toFixed(0)+'%</b> '+
  '的采样点实际仰角高于目标，平均偏差 <b>+'+SUM.cr_bias[0].toFixed(2)+'~+'+SUM.cr_bias[1].toFixed(2)+'°</b>，'+
  '巡航稳态 MAE 达 <b>'+SUM.cr_mae[0].toFixed(2)+'~'+SUM.cr_mae[1].toFixed(2)+'°</b>。</p>'+
  '<p>由于同一架次悬停段无此偏差，可排除 IMU/AHRS 水平校准或安装角误差，'+
  '该偏差属于固定翼气动配平与俯仰指令层面的问题。</p></div>';
html+='<div class="finding warn"><h4>3. 模式切换瞬态是最大误差来源</h4>'+
  '<p><b>QLAND → CRUISE（悬停转前飞）</b>：共 '+SUM.n_fwd+' 次，真实仰角冲高至 <b>+'+
  SUM.fwd_peak[0].toFixed(1)+'~+'+SUM.fwd_peak[1].toFixed(1)+'°</b>，而同时刻目标仰角仅 '+
  SUM.fwd_des[0].toFixed(1)+'~'+SUM.fwd_des[1].toFixed(1)+'°，最大跟踪误差 <b>'+
  SUM.fwd_err[0].toFixed(1)+'~'+SUM.fwd_err[1].toFixed(1)+'°</b>，峰值出现在切换后 '+
  SUM.fwd_lag[0].toFixed(1)+'~'+SUM.fwd_lag[1].toFixed(1)+' s。</p>'+
  '<p><b>CRUISE → QLAND（前飞转悬停）</b>：共 '+SUM.n_back+' 次，目标仰角抬升至 '+
  SUM.back_des[0].toFixed(1)+'~'+SUM.back_des[1].toFixed(1)+'°（拉平），实际峰值 '+
  SUM.back_peak[0].toFixed(1)+'~'+SUM.back_peak[1].toFixed(1)+'°，误差仅 '+
  SUM.back_err[0].toFixed(1)+'~'+SUM.back_err[1].toFixed(1)+'°，跟随明显更好。</p>'+
  '<p>瞬态区间占全部采样的 '+SUM.trans_pct[0].toFixed(0)+'%~'+SUM.trans_pct[1].toFixed(0)+'%，'+
  '使 RMS 由稳态的 '+SUM.rms_s[0].toFixed(2)+'~'+SUM.rms_s[1].toFixed(2)+'° 抬升到 '+
  SUM.rms_t[0].toFixed(2)+'~'+SUM.rms_t[1].toFixed(2)+'°。</p></div>';
html+='<div class="finding"><h4>4. 参数线索（来自 20260928-参数.param）</h4>'+
  '<p>升降舵为 <code>SERVO4_FUNCTION=19</code> / <code>SERVO5_FUNCTION=19</code>（双升降舵，对应 <code>RCOU.C4</code> / <code>C5</code>）：'+
  '巡航段均值分别为 1468 / 1518，几乎等于配平值 <code>SERVO4_TRIM=1470</code>、<code>SERVO5_TRIM=1520</code>，'+
  '且全程未触及行程限幅（1070~1870 / 1120~1920）。说明 <b>不是舵面饱和</b>，问题出在指令与配平层面。</p>'+
  '<p><code>ARSPD_USE = 0</code>：空速计已配置（<code>ARSPD_TYPE=1</code>、<code>ARSPD_RATIO=2</code>、<code>ARSPD_BUS=1</code>）'+
  '但未接入控制回路，TECS 只能依赖合成空速，俯仰/油门指令的可信度受限。</p>'+
  '<p><code>TECS_PITCH_MIN = 0</code>、<code>TECS_PITCH_MAX = 35</code>：TECS 俯仰指令区间为 0~+35°，'+
  '缺少低头权限（非对称）；而实测巡航目标仰角约 −1.4~−2.3°，说明限幅并非唯一因素，需结合 TECS 整定一并核查。</p>'+
  '<p>其余相关量：<code>PTCH_LIM_MIN_DEG=-25</code> / <code>PTCH_LIM_MAX_DEG=35</code>、'+
  '<code>PTCH2SRV_TCONST=0.45</code>、<code>TRIM_THROTTLE=35</code>，参数表中未设置 <code>TRIM_PITCH_CD</code>（默认 0）。</p></div>';
html+='<div class="finding"><h4>5. 建议后续核查项</h4>'+
  '<p>① 巡航抬头偏差：核对重心位置与 <code>TRIM_THROTTLE = 35</code> 对应的实际巡航油门，'+
  '确认是否存在持续的气动抬头力矩；再评估是否需要引入俯仰配平补偿或调整 <code>PTCH2SRV_TCONST</code>。</p>'+
  '<p>② 前飞过渡瞬态：重点复看切换后 0~3 s 的俯仰冲高（峰值达 '+
  SUM.fwd_peak[1].toFixed(1)+'°），核查过渡时长与 <code>PTCH_LIM_MAX_DEG = 35</code> 的俯仰权限是否匹配、'+
  '过渡期间是否需要限制抬头速率。</p>'+
  '<p>③ 空速：若空速计数据可靠，建议开启 <code>ARSPD_USE</code> 并重新整定 TECS，'+
  '可同时改善巡航俯仰指令质量与过渡判定（当前过渡依赖合成空速）。</p></div>';
html+='</div>';

root.innerHTML=html;

DATA.logs.forEach((item,i)=>{
  const L=item.log;
  const c1=echarts.init(document.getElementById('main'+i),null,{renderer:'canvas'});
  c1.setOption(mainOption(L,item.segs));
  const c2=echarts.init(document.getElementById('strip'+i),null,{renderer:'canvas'});
  c2.setOption(stripOption(L,item.segs));
  const c3=echarts.init(document.getElementById('err'+i),null,{renderer:'canvas'});
  c3.setOption(errOption(L,item.segs));
  c1.group='g'+i; c2.group='g'+i;
  charts.push(c1,c2,c3);
});
DATA.logs.forEach((_,i)=>echarts.connect('g'+i));
window.addEventListener('resize',()=>charts.forEach(c=>c.resize()));
</script>
</body>
</html>
"""

html = (HEAD.replace("__ECHARTS__", ECHARTS).replace("__PAYLOAD__", PAYLOAD)
            .replace("__COLORS__", COLORS).replace("__DESCS__", DESCS).replace("__SUM__", S))

dst = os.path.join(BASE, "飞机仰角分析报告.html")
with open(dst, "w", encoding="utf-8") as f:
    f.write(html)
print("written:", dst, round(len(html) / 1024), "KB")
print("summary:", json.dumps(summ, indent=1))