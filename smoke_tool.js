/* 端到端冒烟测试：
   1) 在 jsdom 中加载成品 HTML，用同步假 Worker 驱动真实 .BIN 导入
   2) 通过 DOM 事件完成「选消息类型 -> 勾字段 -> 添加曲线」
   3) 用真实 echarts（SSR/SVG）渲染捕获到的 option，确认可出图
*/
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_PATH);

const BASE = __dirname;
const BUILT = path.join(BASE, 'APM日志折线分析工具.html');
const BIN = path.join(BASE, 'APM', 'LOGS', process.argv[2] || '00000002.BIN');

// 各日志的期望极值（由 pymavlink 独立解析得到）
const EXPECT = {
  '00000001.BIN': { pitch: [-10.58, 22.18], desp: [-9.94, 9.98], modes: 11, att: 20698, dur: 1097.2 },
  '00000002.BIN': { pitch: [-12.39, 20.90], desp: [-9.98, 9.97], modes: 5, att: 9059, dur: 511.0 }
};

let html = fs.readFileSync(BUILT, 'utf8');

// 用桩替换内联的 echarts，便于捕获 option
const marker = '/* ECharts 5 (Apache-2.0) 内联以便单文件离线运行 */';
const mi = html.indexOf(marker);
if (mi < 0) { console.log('!! echarts marker not found'); process.exit(1); }
const sStart = html.lastIndexOf('<script>', mi);
const sEnd = html.indexOf('</script>', mi);
const stub = [
  '<script>',
  'window.__opts = [];',
  'window.echarts = { init: function(){',
  '  var inst = { __h: [],',
  '    setOption: function(o){ window.__opts.push(o); },',
  '    clear: function(){ window.__opts.push({}); },',
  '    resize: function(){},',
  '    on: function(t, f){ inst.__h.push([t, f]); },',
  '    off: function(){ inst.__h = []; },',
  '    dispatchAction: function(a){',
  '      if (a && a.type === "dataZoom") {',
  '        var o = window.__opts[window.__opts.length - 1], i = a.dataZoomIndex || 0;',
  '        if (o && o.dataZoom && o.dataZoom[i]) { o.dataZoom[i].start = a.start; o.dataZoom[i].end = a.end; }',
  '        inst.__h.forEach(function(p){ if (p[0] === "dataZoom") p[1]({}); });',
  '      } },',
  '    getOption: function(){ return window.__opts[window.__opts.length - 1] || null; } };',
  '  window.__chart = inst;',
  '  return inst; },',
  '  getInstanceByDom: function(){ return window.__chart || null; } };',
  '</script>'
].join('\n');
html = html.slice(0, sStart) + stub + html.slice(sEnd + 9);

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(win) {
    const OrigBlob = win.Blob;
    const urls = [];
    function PatchedBlob(parts, opts) {
      const b = new OrigBlob(parts, opts);
      b.__parts = parts;
      return b;
    }
    PatchedBlob.prototype = OrigBlob.prototype;
    win.Blob = PatchedBlob;
    win.URL.createObjectURL = function (blob) { urls.push(blob); return 'blob:test:' + (urls.length - 1); };
    win.URL.revokeObjectURL = function () {};

    win.Worker = function (url) {
      const idx = parseInt(String(url).split(':').pop(), 10);
      const blob = urls[idx];
      const src = (blob && blob.__parts) ? blob.__parts.join('') : '';
      const selfObj = {};
      const me = this;
      selfObj.postMessage = function (m) { if (me.__h) me.__h({ data: m }); };
      new Function('self', src)(selfObj);
      this.__h = null;
      this.postMessage = function (msg) { if (selfObj.onmessage) selfObj.onmessage({ data: msg }); };
      this.addEventListener = function (t, h) { this.__h = h; };
      this.removeEventListener = function () { this.__h = null; };
    };
    win.__jsdomErrors = [];
    // jsdom 没有 canvas 实现：打桩成 null，避免 WebGL 探测时往 stderr 刷 "Not implemented"
    win.HTMLCanvasElement.prototype.getContext = function () { return null; };
    win.addEventListener('error', function (e) { win.__jsdomErrors.push(String(e.message || e.error)); });
  }
});
const win = dom.window;
const doc = win.document;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function fail(msg) { console.log('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('  ok  ', msg); }

(async function main() {
  console.log('=== 冒烟测试', path.basename(BIN), '===');

  // 1. 模拟拖放导入
  const buf = fs.readFileSync(BIN);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const file = new win.File([ab], path.basename(BIN));
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file] } });
  doc.dispatchEvent(ev);

  // 2. 等解析完成
  const t0 = Date.now();
  let item = null;
  while (Date.now() - t0 < 180000) {
    item = doc.querySelector('#logList .logitem');
    if (item && win.__opts.length) break;
    await sleep(50);
  }
  if (!item) { fail('日志未加载（#logList 中没有条目）'); console.log('status:', doc.getElementById('status').textContent); return; }
  ok('日志已导入：' + item.querySelector('.meta').textContent.trim());

  // 3. 选消息类型 ATT
  const selMsg = doc.getElementById('selMsg');
  const hasATT = Array.prototype.some.call(selMsg.options, o => o.value === 'ATT');
  if (!hasATT) { fail('消息类型列表里没有 ATT'); return; }
  selMsg.value = 'ATT';
  selMsg.dispatchEvent(new win.Event('change'));

  // 4. 勾选 Pitch / DesPitch
  const boxes = Array.prototype.slice.call(doc.querySelectorAll('#fieldList input[type=checkbox]'));
  const want = ['Pitch', 'DesPitch'];
  let picked = 0;
  boxes.forEach(c => { if (want.indexOf(c.value) >= 0) { c.checked = true; picked++; } });
  if (picked !== 2) { fail('字段列表缺少 Pitch/DesPitch，实际字段：' + boxes.map(b => b.value).join(',')); return; }
  ok('字段列表包含 Pitch / DesPitch');

  const btnAdd = doc.getElementById('btnAdd');
  if (btnAdd.disabled) { fail('「添加为曲线」按钮被禁用'); return; }
  btnAdd.dispatchEvent(new win.Event('click'));

  const opt = win.__opts[win.__opts.length - 1];
  if (!opt || !opt.series || opt.series.length !== 2) {
    fail('曲线数量应为 2，实际 ' + (opt && opt.series ? opt.series.length : 'none'));
    return;
  }
  ok('已生成 2 条曲线：' + opt.series.map(s => s.name).join(' | '));

  // 5. 数据正确性（对照 pymavlink：Pitch -12.39~20.90 / DesPitch -9.98~9.97）
  const sp = opt.series.find(s => /\.Pitch$/.test(s.name));
  const sd = opt.series.find(s => /\.DesPitch$/.test(s.name));
  const mm = (s) => { let a = Infinity, b = -Infinity; s.data.forEach(p => { if (p[1] === null) return; if (p[1] < a) a = p[1]; if (p[1] > b) b = p[1]; }); return [a, b]; };
  const [pmin, pmax] = mm(sp), [dmin, dmax] = mm(sd);
  const ex = EXPECT[path.basename(BIN)];
  if (!ex) { fail('没有 ' + path.basename(BIN) + ' 的期望值'); return; }
  console.log('  Pitch  min/max = %s / %s  (期望 %s / %s)', pmin.toFixed(2), pmax.toFixed(2), ex.pitch[0], ex.pitch[1]);
  console.log('  DesPit min/max = %s / %s  (期望 %s / %s)', dmin.toFixed(2), dmax.toFixed(2), ex.desp[0], ex.desp[1]);
  if (Math.abs(pmin - ex.pitch[0]) > 0.02 || Math.abs(pmax - ex.pitch[1]) > 0.02) fail('Pitch 数值与 pymavlink 不一致');
  if (Math.abs(dmin - ex.desp[0]) > 0.02 || Math.abs(dmax - ex.desp[1]) > 0.02) fail('DesPitch 数值与 pymavlink 不一致');

  // 6. 飞行模式色带（挂在第一条曲线上）
  const s0 = opt.series[0];
  if (!s0.markArea || !s0.markArea.data || !s0.markArea.data.length) fail('缺少飞行模式色带');
  else ok('飞行模式色带（挂在 ' + s0.name + '）：' + s0.markArea.data.map(a => a[0].name).join(' -> '));
  if (!s0.markLine || s0.markLine.data.length !== s0.markArea.data.length - 1) fail('模式分隔虚线数量不对');
  else ok('模式分隔虚线 ' + s0.markLine.data.length + ' 条');
  const modeNames = s0.markArea.data.map(a => a[0].name);
  if (modeNames.indexOf('CRUISE') < 0 || modeNames.indexOf('QLAND') < 0) fail('模式名称解析异常：' + modeNames.join(','));
  if (modeNames.length !== ex.modes) fail('模式段数应为 ' + ex.modes + '，实际 ' + modeNames.length);

  // 7. Y 轴范围调节：左轴（Pitch + DesPitch 都在左轴）
  // Y 轴面板按 data-axis / data-role 动态渲染，这里统一用查询函数定位
  const boxOf = (k) => doc.querySelector('#adjBoxes [data-axis="' + k + '"]');
  const numOf = (k, p) => boxOf(k).querySelector('[data-role="num-' + p + '"]');
  const sldOf = (k, p) => boxOf(k).querySelector('[data-role="slider-' + p + '"]');
  const lblOf = (k, p) => boxOf(k).querySelector('[data-role="val-' + p + '"]');
  const rngOf = (k) => boxOf(k).querySelector('[data-role="range"]').textContent;
  const axSelOf = (name) => {
    let hit = null;
    Array.prototype.forEach.call(doc.querySelectorAll('#seriesList .seriesitem'), it => {
      if (it.querySelector('.nm').textContent.indexOf(name) >= 0) hit = it.querySelector('.axsel');
    });
    return hit;
  };
  const nBoxes = () => doc.querySelectorAll('#adjBoxes .adjbox').length;

  const setRange = (el, v) => { el.value = String(v); el.dispatchEvent(new win.Event('input')); };
  const last = () => win.__opts[win.__opts.length - 1];
  const axisSpan = (o, i) => o.yAxis[i].max - o.yAxis[i].min;   // 仅对锁定了 min/max 的轴有效
  const axisMid = (o, i) => (o.yAxis[i].max + o.yAxis[i].min) / 2;
  const dataSpan = (o, axis) => {
    let a = Infinity, b = -Infinity;
    o.series.forEach(s => {
      if (s.yAxisIndex !== axis) return;
      s.data.forEach(p => { if (p[1] === null) return; if (p[1] < a) a = p[1]; if (p[1] > b) b = p[1]; });
    });
    return b - a;
  };

  if (nBoxes() !== 2) fail('初始应有 左轴/右轴 两个调节盒，实际 ' + nBoxes());
  if (!/自动/.test(rngOf('L'))) fail('左轴初始范围未显示为自动：' + rngOf('L'));
  else ok('左轴初始：' + rngOf('L'));
  if (!boxOf('R').classList.contains('off')) fail('无右轴曲线时右轴面板未置灰');
  else ok('无右轴曲线时右轴面板置灰');

  const autoSpan = dataSpan(last(), 0);
  setRange(numOf('L', 'zoom'), 0.5);
  const oZoom = last();
  if (Math.abs(axisSpan(oZoom, 0) - autoSpan * 0.5) > 0.05) fail('左轴缩放未生效：' + axisSpan(oZoom, 0) + ' vs ' + autoSpan * 0.5);
  else ok('左轴缩放 ×0.5 生效：跨度 ' + autoSpan.toFixed(2) + ' -> ' + axisSpan(oZoom, 0).toFixed(2));
  if (lblOf('L', 'zoom').textContent !== '×0.50') fail('缩放数值标签未更新：' + lblOf('L', 'zoom').textContent);
  if (!/当前/.test(rngOf('L'))) fail('左轴范围未显示为手动：' + rngOf('L'));

  setRange(numOf('L', 'off'), 0.5);
  const oOff = last();
  if (Math.abs(axisMid(oOff, 0) - (axisMid(oZoom, 0) + 0.5 * autoSpan)) > 0.05) fail('左轴偏移未生效：中心 ' + axisMid(oOff, 0));
  else ok('左轴偏移 +0.5 生效：中心 ' + axisMid(oZoom, 0).toFixed(2) + ' -> ' + axisMid(oOff, 0).toFixed(2));
  if (oOff.series[0].data !== oZoom.series[0].data) fail('降采样缓存未复用（数据被重算）');
  else ok('拖动滑块时降采样结果复用缓存');
  if (oOff.yAxis[1].min !== null || oOff.yAxis[1].max !== null) fail('右轴不应受左轴调节影响');

  boxOf('L').querySelector('[data-act="reset"]').dispatchEvent(new win.Event('click'));
  const oRst = last();
  if (oRst.yAxis[0].min !== null || oRst.yAxis[0].max !== null) fail('左轴重置后仍锁定 min/max');
  else ok('左轴重置回自动');

  // 8. 把 Pitch 曲线挪到右轴，验证右轴独立调节
  const pitchSel = axSelOf('ATT.Pitch');
  if (!pitchSel) { fail('曲线列表里找不到 ATT.Pitch 的轴选择器'); return; }
  pitchSel.value = 'R';
  pitchSel.dispatchEvent(new win.Event('change'));
  const oR = last();
  if (!oR.yAxis[1].show) fail('切换到右轴后 yAxis[1] 未显示');
  else ok('左右 Y 轴切换正常');
  if (boxOf('R').classList.contains('off')) fail('有右轴曲线后右轴面板仍置灰');
  if (numOf('R', 'zoom').disabled) fail('右轴控件未启用');
  else ok('右轴面板已启用：' + rngOf('R'));

  setRange(numOf('R', 'zoom'), 0.5);
  const oRz = last();
  const spanR0 = dataSpan(oR, 1);
  if (Math.abs((oRz.yAxis[1].max - oRz.yAxis[1].min) - spanR0 * 0.5) > 0.05) fail('右轴缩放未生效');
  else ok('右轴缩放 ×0.5 生效：跨度 ' + spanR0.toFixed(2) + ' -> ' + (oRz.yAxis[1].max - oRz.yAxis[1].min).toFixed(2));
  if (oRz.yAxis[0].min !== null) fail('调节右轴不应影响左轴');
  else ok('左右轴互不影响');

  doc.getElementById('rstAll').dispatchEvent(new win.Event('click'));
  const oAll = last();
  if (oAll.yAxis[0].min !== null || oAll.yAxis[1].min !== null) fail('全部重置未生效');
  else ok('两个共享轴全部重置回自动');

  // 9. 再叠加一条高频曲线（IMU.AccX，14.5 万点）用于验证降采样
  selMsg.value = 'IMU';
  selMsg.dispatchEvent(new win.Event('change'));
  const imuBox = Array.prototype.slice.call(doc.querySelectorAll('#fieldList input[type=checkbox]'))
    .filter(c => c.value === 'AccX')[0];
  if (!imuBox) { fail('IMU 字段列表缺少 AccX'); return; }
  imuBox.checked = true;
  btnAdd.dispatchEvent(new win.Event('click'));
  const optIMU = win.__opts[win.__opts.length - 1];
  const imuSeries = optIMU.series.find(s => /IMU\.AccX$/.test(s.name));
  if (!imuSeries) { fail('IMU.AccX 曲线未添加'); return; }
  ok('叠加 IMU.AccX：' + imuSeries.data.length + ' 点（上限 2.5 万）');
  if (imuSeries.data.length > 25000) fail('默认采样上限未生效：' + imuSeries.data.length);

  // 10. 采样上限改为 1 万
  const maxSel = doc.getElementById('optMax');
  maxSel.value = '10000';
  maxSel.dispatchEvent(new win.Event('change'));
  const opt3 = last();
  const n3 = opt3.series.find(s => /IMU\.AccX$/.test(s.name)).data.length;
  if (n3 > 10000 || n3 < 5000) fail('采样上限未生效，点数 ' + n3);
  else ok('采样上限 1 万生效，点数 ' + n3);
  doc.getElementById('optMode').checked = false;
  doc.getElementById('optMode').dispatchEvent(new win.Event('change'));
  const opt4 = last();
  if (opt4.series[0].markArea) fail('关闭模式色带后 markArea 仍在');
  else ok('模式色带可关闭');
  doc.getElementById('optMode').checked = true;
  doc.getElementById('optMode').dispatchEvent(new win.Event('change'));

  // 11. 手动输入：数值可以超出滑块量程（滑块 0.1~5，这里输入 12）
  const oMan0 = last();
  const spanL0 = dataSpan(oMan0, 0);
  setRange(numOf('L', 'zoom'), 12);
  const oMan = last();
  if (Math.abs(axisSpan(oMan, 0) - spanL0 * 12) > 0.5) fail('手动输入缩放 ×12 未生效：跨度 ' + axisSpan(oMan, 0) + ' vs ' + spanL0 * 12);
  else ok('手动输入缩放 ×12 生效（滑块量程 0.1~5 之外）：跨度 ' + spanL0.toFixed(2) + ' -> ' + axisSpan(oMan, 0).toFixed(2));
  if (parseFloat(sldOf('L', 'zoom').value) !== 5) fail('滑块未钳制到量程上限：' + sldOf('L', 'zoom').value);
  if (lblOf('L', 'zoom').textContent !== '×12.00') fail('数值标签未同步：' + lblOf('L', 'zoom').textContent);
  else ok('滑块钳制在量程内，数值标签同步为 ' + lblOf('L', 'zoom').textContent);
  setRange(numOf('L', 'off'), 3);   // 偏移滑块量程 -2~2，手输 3 个跨度
  const oManOff = last();
  if (Math.abs(axisMid(oManOff, 0) - (axisMid(oMan, 0) + 3 * spanL0)) > 0.5) fail('手动输入偏移未生效');
  else ok('手动输入偏移 +3 生效（滑块量程 -2~2 之外）');
  boxOf('L').querySelector('[data-act="reset"]').dispatchEvent(new win.Event('click'));

  // 12. 独立轴：把 IMU.AccX 切到自己的轴
  const imuSel = axSelOf('IMU.AccX');
  if (!imuSel) { fail('曲线列表里找不到 IMU.AccX 的轴选择器'); return; }
  if (imuSel.options.length !== 3) fail('轴选择器应有 左/右/独立 三项');
  const indepVal = imuSel.options[2].value;
  if (!/^S\d+$/.test(indepVal)) fail('独立轴键名异常：' + indepVal);
  imuSel.value = indepVal;
  imuSel.dispatchEvent(new win.Event('change'));
  const oInd = last();
  if (nBoxes() !== 3) fail('切到独立轴后应多出 1 个调节盒，实际 ' + nBoxes());
  else ok('切到独立轴后新增调节盒，共 ' + nBoxes() + ' 个');
  if (!oInd.yAxis[2] || !oInd.yAxis[2].show) fail('独立轴 yAxis[2] 未显示');
  const indIdx = oInd.series.findIndex(s => /IMU\.AccX$/.test(s.name));
  if (oInd.series[indIdx].yAxisIndex !== 2) fail('IMU.AccX 未指向独立轴：' + oInd.series[indIdx].yAxisIndex);
  else ok('IMU.AccX 独占 yAxis[2]（position=' + oInd.yAxis[2].position + '，offset=' + oInd.yAxis[2].offset + '）');
  const leftIdx = oInd.series.findIndex(s => /ATT\.DesPitch$/.test(s.name));
  if (oInd.series[leftIdx].yAxisIndex !== 0) fail('DesPitch 应仍在共享左轴');
  const ownL = boxOf('L').querySelector('[data-role="owner"]').textContent;
  const ownI = boxOf(indepVal).querySelector('[data-role="owner"]').textContent;
  if (ownL.indexOf('DesPitch') < 0 || ownL.indexOf('AccX') >= 0) fail('左轴归属未剔除已独立出去的 AccX：' + ownL);
  else ok('左轴只统计剩下的曲线：' + ownL);
  if (ownI.indexOf('AccX') < 0) fail('独立轴归属未显示 AccX：' + ownI);
  else ok('独立轴归属：' + ownI);

  // 13. 独立轴单独调节，不影响其它轴
  const iSpan = dataSpan(oInd, 2);
  setRange(numOf(indepVal, 'zoom'), 0.25);
  const oI2 = last();
  if (Math.abs((oI2.yAxis[2].max - oI2.yAxis[2].min) - iSpan * 0.25) > 0.5) fail('独立轴缩放未生效');
  else ok('独立轴缩放 ×0.25 生效：跨度 ' + iSpan.toFixed(2) + ' -> ' + (oI2.yAxis[2].max - oI2.yAxis[2].min).toFixed(2));
  if (oI2.yAxis[0].min !== null || oI2.yAxis[1].min !== null) fail('调节独立轴不应影响共享轴');
  else ok('独立轴与共享轴互不影响');
  setRange(numOf(indepVal, 'off'), 1);
  const oI3 = last();
  if (Math.abs(axisMid(oI3, 2) - (axisMid(oI2, 2) + 1 * iSpan)) > 0.5) fail('独立轴偏移未生效');
  else ok('独立轴偏移 +1 生效：中心 ' + axisMid(oI2, 2).toFixed(2) + ' -> ' + axisMid(oI3, 2).toFixed(2));

  // 14. 独立轴换边
  const sideBtn = boxOf(indepVal).querySelector('[data-act="side"]');
  if (!sideBtn) fail('独立轴缺少换边按钮');
  sideBtn.dispatchEvent(new win.Event('click'));
  const oSide = last();
  if (oSide.yAxis[2].position !== 'right') fail('换边未生效：' + oSide.yAxis[2].position);
  else ok('独立轴换到右侧（offset=' + oSide.yAxis[2].offset + '）');
  boxOf(indepVal).querySelector('[data-act="side"]').dispatchEvent(new win.Event('click'));
  if (last().yAxis[2].position !== 'left') fail('换回左侧未生效');

  // 15. 切回共享轴后独立轴被回收
  axSelOf('IMU.AccX').value = 'L';
  axSelOf('IMU.AccX').dispatchEvent(new win.Event('change'));
  if (nBoxes() !== 2) fail('切回共享轴后独立轴未回收，仍有 ' + nBoxes() + ' 个调节盒');
  else ok('切回共享轴后独立轴被回收，回到 ' + nBoxes() + ' 个调节盒');
  const oBack = last();
  if (oBack.series[oBack.series.findIndex(s => /IMU\.AccX$/.test(s.name))].yAxisIndex !== 0) fail('AccX 未回到共享左轴');

  // 16. 删除曲线时同样回收独立轴
  const delSel = axSelOf('IMU.AccX');
  const delRow = delSel.closest('.seriesitem');
  delRow.querySelector('.icon:last-child').dispatchEvent(new win.Event('click'));
  if (nBoxes() !== 2) fail('删除曲线后调节盒数量异常：' + nBoxes());
  else ok('删除曲线后轴面板正常');

  // 17. 3D 回放：轨迹数据 + 视图切换（jsdom 无 WebGL，应降级而不是抛异常）
  const APM = win.__APM;
  if (!APM) fail('缺少 window.__APM 测试句柄');
  else {
    APM.setView('3d');
    let st = APM.state();
    if (st.view !== '3d') fail('切换到 3D 视图失败');
    const tk = APM.getTrack();
    if (!tk) { fail('3D 轨迹未生成'); }
    else {
      const w = tk.bounds.maxX - tk.bounds.minX, d = tk.bounds.maxZ - tk.bounds.minZ;
      console.log('  3D 轨迹：点数 ' + tk.n + '，时长 ' + tk.dur.toFixed(1) + 's，跨度 ' +
        Math.round(w) + '×' + Math.round(d) + ' m，高度 ' + tk.minAlt.toFixed(1) + '~' +
        tk.maxAlt.toFixed(1) + ' m，航程 ' + Math.round(tk.dist) + ' m，原点 ' +
        tk.lat0.toFixed(5) + ',' + tk.lon0.toFixed(5));
      if (tk.n < 1000) fail('轨迹点数过少：' + tk.n);
      const ex = EXPECT[path.basename(BIN)];
      if (!(tk.dur > 0)) fail('轨迹时长异常');
      if (ex && ex.dur) {
        if (tk.dur > ex.dur + 2) fail('轨迹时长超过日志时长：' + tk.dur.toFixed(1) + ' vs ' + ex.dur);
        else if (tk.dur < ex.dur * 0.8) fail('轨迹只覆盖了日志的一小段：' + tk.dur.toFixed(1) + ' / ' + ex.dur);
        else ok('轨迹时长覆盖日志：' + tk.dur.toFixed(1) + 's / ' + ex.dur + 's');
      }
      if (w < 10 || d < 10) fail('轨迹跨度异常（经纬度没换算成米？）：' + w + '×' + d);
      if (tk.minAlt < -50 || tk.maxAlt > 2000) fail('高度范围异常：' + tk.minAlt + '~' + tk.maxAlt);
      if (Math.abs(tk.lat0 - 30.35) > 0.2 || Math.abs(tk.lon0 - 120.04) > 0.2) fail('原点经纬度异常：' + tk.lat0 + ',' + tk.lon0);
      let rmin = Infinity, rmax = -Infinity, pmin = Infinity, pmax = -Infinity;
      let yawSpread = 0, y0 = tk.yaw[0];
      for (let i = 0; i < tk.n; i++) {
        if (tk.roll[i] < rmin) rmin = tk.roll[i];
        if (tk.roll[i] > rmax) rmax = tk.roll[i];
        if (tk.pitch[i] < pmin) pmin = tk.pitch[i];
        if (tk.pitch[i] > pmax) pmax = tk.pitch[i];
        if (Math.abs(tk.yaw[i] - y0) > yawSpread) yawSpread = Math.abs(tk.yaw[i] - y0);
      }
      console.log('  姿态范围：Roll ' + rmin.toFixed(1) + '~' + rmax.toFixed(1) +
        '  Pitch ' + pmin.toFixed(1) + '~' + pmax.toFixed(1) +
        '  航向去缠绕跨度 ' + yawSpread.toFixed(1) + '°');
      if (ex) {
        if (Math.abs(pmin - ex.pitch[0]) > 0.6 || Math.abs(pmax - ex.pitch[1]) > 0.6)
          fail('轨迹 Pitch 范围与折线图期望不一致：' + pmin + '~' + pmax);
        else ok('轨迹 Pitch 范围与 ATT 期望一致：' + pmin.toFixed(2) + '~' + pmax.toFixed(2));
      }
      if (yawSpread < 30) fail('航向几乎没有变化，回放会看不出朝向：' + yawSpread);
      // 抽帧：t=0 / 中点 / 末点 的插值结果
      const s0 = APM.sampleIdx(tk, tk.t0), s1 = APM.sampleIdx(tk, tk.tEnd);
      if (s0.i !== 0) fail('起点采样索引应为 0，实际 ' + s0.i);
      if (s1.i !== tk.n - 1) fail('终点采样索引应为末点，实际 ' + s1.i);
      const mid = (tk.t0 + tk.tEnd) / 2, s2 = APM.sampleIdx(tk, mid);
      if (!(s2.i > 0 && s2.i < tk.n - 1 && s2.f >= 0 && s2.f <= 1)) fail('中点插值异常：' + JSON.stringify(s2));
      else ok('时间轴采样（起点/中点/终点）正常');
    }

    // 无 WebGL：应给出降级提示，且不应留下场景
    st = APM.state();
    if (st.scene) fail('jsdom 中不应初始化出 WebGL 场景');
    else if (!st.msg) fail('无 WebGL 时未给出降级提示');
    else ok('无 WebGL 降级提示：' + st.msg.replace(/\s+/g, ' ').slice(0, 60));

    // 回放控件
    const play = doc.getElementById('p3Play'), slider = doc.getElementById('p3Slider');
    if (!play || !slider) fail('缺少回放控件');
    else if (!tk) fail('轨迹缺失，跳过回放控件检查');
    else {
      slider.value = '500';
      slider.dispatchEvent(new win.Event('input'));
      const tA = APM.state().t;
      if (!(tA > tk.t0 && tA < tk.tEnd)) fail('拖动时间轴未生效：' + tA);
      else ok('时间轴拖动生效：t=' + tA.toFixed(1) + 's');
      play.dispatchEvent(new win.Event('click'));
      if (!APM.state().playing) fail('播放按钮未进入播放态');
      else ok('播放 / 暂停切换正常');
      play.dispatchEvent(new win.Event('click'));
      if (APM.state().playing) fail('播放按钮未退出播放态');
      doc.getElementById('p3End').dispatchEvent(new win.Event('click'));
      if (Math.abs(APM.state().t - tk.tEnd) > 0.01) fail('跳到终点未生效');
      else ok('起点 / 终点跳转正常');
    }

    // 模型与尺寸
    const modelSel = doc.getElementById('s3Model');
    const lenIn = doc.getElementById('s3Len');
    if (!modelSel || !lenIn) fail('缺少模型尺寸控件');
    else {
      if (parseFloat(lenIn.value) !== APM.DIMS.wing.len) fail('默认尺寸未回填：' + lenIn.value);
      modelSel.value = 'quad';
      modelSel.dispatchEvent(new win.Event('change'));
      if (parseFloat(lenIn.value) !== APM.DIMS.quad.len) fail('切换模型后尺寸未更新：' + lenIn.value);
      lenIn.value = '0.9';
      lenIn.dispatchEvent(new win.Event('input'));
      if (APM.DIMS.quad.len !== 0.9) fail('尺寸输入未写入模型参数');
      modelSel.value = 'wing';
      modelSel.dispatchEvent(new win.Event('change'));
      if (APM.DIMS.quad.len !== 0.9 || parseFloat(lenIn.value) !== APM.DIMS.wing.len)
        fail('切换模型时尺寸未按模型分别保存');
      ok('模型切换与尺寸设置（按模型分别记忆）正常');
    }

    // 航向来源（ATT.Yaw/AHR2.Yaw 均为 uint16 厘度，必须能解析出真实跨度；
    //  若某日志的 EKF 航向确实卡死，pickYaw 要能自动退到 GPS 航迹角）
    const yawSel = doc.getElementById('s3Yaw');
    if (!yawSel || !tk) fail('缺少航向来源控件或轨迹');
    else {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < tk.n; i++) { if (tk.yaw[i] < lo) lo = tk.yaw[i]; if (tk.yaw[i] > hi) hi = tk.yaw[i]; }
      console.log('  自动航向来源 = ' + tk.yawKey + '，航向跨度 ' + (hi - lo).toFixed(1) + '°');
      if (!tk.yawKey) fail('自动航向来源解析失败');
      if (hi - lo < 30) fail('航向来源仍无变化，机头会一直朝向同一方向：' + (hi - lo).toFixed(1));
      const other = tk.yawKey === 'GPS.GCrs' ? 'ATT.Yaw' : 'GPS.GCrs';
      let has = false;
      for (let i = 0; i < yawSel.options.length; i++) if (yawSel.options[i].value === other) has = true;
      if (!has) fail('航向来源缺少选项：' + other);
      else {
        yawSel.value = other;
        yawSel.dispatchEvent(new win.Event('change'));
        const tk2 = APM.getTrack();
        if (!tk2 || tk2.yawKey !== other) fail('切换航向来源未重建轨迹');
        else ok('航向来源切换生效：' + tk2.yawKey + '，轨迹重新生成（点数 ' + tk2.n + '）');
        yawSel.value = 'auto';
        yawSel.dispatchEvent(new win.Event('change'));
        if (!APM.getTrack() || APM.getTrack().yawKey !== tk.yawKey) fail('切回自动航向来源失败');
        else ok('航向来源切回自动正常');
      }
    }
    // 折线图时间缩放 -> 3D 回放区间（切割时间线）
    const ec = (win.echarts && doc.getElementById('chart'))
      ? win.echarts.getInstanceByDom(doc.getElementById('chart')) : null;
    if (!ec || !tk) ok('（跳过）暂无折线图实例或轨迹，无法测时间缩放联动');
    else if (!APM.chartWindow()) ok('（跳过）折线图还没有时间轴数据');
    else {
      const slider2 = doc.getElementById('p3Slider');
      ec.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 25, end: 55 });
      APM.syncRange();
      const cut = APM.getRange();
      if (!cut || !cut.cut) fail('折线图缩放后 3D 区间没有跟着切割：' + JSON.stringify(cut));
      else if (!(cut.t0 > tk.t0 + 0.5 && cut.t1 < tk.tEnd - 0.5))
        fail('切割区间不在轨迹范围内：' + cut.t0.toFixed(1) + '~' + cut.t1.toFixed(1));
      else if (cut.n >= tk.n) fail('切割后点数没有减少：' + cut.n + ' / ' + tk.n);
      else {
        const txt = doc.getElementById('s3RangeTxt').textContent;
        console.log('  切割区间：' + cut.t0.toFixed(1) + '~' + cut.t1.toFixed(1) + 's，点数 ' +
          cut.n + '/' + tk.n + '，跨度 ' + Math.round(cut.extent) + ' m，文案 ' + txt);
        if (txt.indexOf('~') < 0) fail('区间文案未更新：' + txt);
        APM.step(cut.t1 + 999);
        if (APM.state().t > cut.t1 + 1e-6) fail('回放没有被限制在切割区间内：' + APM.state().t);
        else ok('回放终点被限制在切割区间（' + APM.state().t.toFixed(1) + 's）');
        slider2.value = '0';
        slider2.dispatchEvent(new win.Event('input'));
        if (Math.abs(APM.state().t - cut.t0) > 0.5) fail('滑块拖到最左应落在区间起点：' + APM.state().t);
        else ok('时间轴滑块按切割区间重新映射');
        // 关掉跟随：再缩放折线图不应改动区间
        const fz = doc.getElementById('s3FollowZoom');
        fz.checked = false; fz.dispatchEvent(new win.Event('change'));
        ec.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 40, end: 70 });
        APM.syncRange();
        const keep = APM.getRange();
        if (!keep || keep.t0 !== cut.t0 || keep.t1 !== cut.t1) fail('关闭「跟随折线图缩放」后区间仍被改动');
        else ok('关闭跟随后区间保持不变');
        fz.checked = true; fz.dispatchEvent(new win.Event('change'));
        APM.syncRange();
        const rec = APM.getRange();
        if (!rec || !rec.cut) fail('重新打开跟随后没有恢复切割');
        else if (rec.t0 === keep.t0 && rec.t1 === keep.t1) fail('重新打开跟随后没有读到折线图的新区间');
        else ok('重新打开跟随立即同步折线图新区间（' + rec.t0.toFixed(1) + '~' + rec.t1.toFixed(1) + 's）');
        // 全时段按钮
        doc.getElementById('s3RangeAll').dispatchEvent(new win.Event('click'));
        const back = APM.getRange();
        if (!back || back.cut) fail('「全时段」没有恢复整条航迹');
        else if (Math.abs(back.t0 - tk.t0) > 0.01 || Math.abs(back.t1 - tk.tEnd) > 0.01)
          fail('恢复全时段后边界不对：' + back.t0 + '~' + back.t1);
        else ok('「全时段」恢复整条航迹（' + back.n + ' 点）');
      }
    }

    APM.setView('chart');
    if (APM.state().view !== 'chart') fail('切回折线图失败');
    else ok('3D / 折线图 视图切换往返正常');

    // 同屏分屏：折线图与 3D 回放在同一个页面里
    APM.setView('split');
    if (APM.state().view !== 'split') fail('切换到同屏视图失败');
    else {
      const secs = [].slice.call(doc.querySelectorAll('.panel section[data-view]'));
      const vis = secs.filter(s => !s.hidden).length;
      const sp = doc.getElementById('splitter');
      const probs = [];
      if (doc.getElementById('chart').hidden) probs.push('折线图不可见');
      if (doc.getElementById('v3d').hidden) probs.push('3D 面板不可见');
      if (sp.hidden) probs.push('分隔条未显示');
      if (vis !== secs.length) probs.push('左侧面板只显示了 ' + vis + '/' + secs.length + ' 个区块');
      if (!doc.querySelector('.main').classList.contains('split')) probs.push('主容器缺少 split 类');
      if (probs.length) fail('同屏视图异常：' + probs.join('；'));
      else {
        ok('同屏分屏：折线图 + 3D 同时可见，面板区块 ' + vis + '/' + secs.length + ' 全部展开');
        // 拖动分隔条与双击复位都不应抛异常（jsdom 无布局，这里只验健壮性）
        sp.dispatchEvent(new win.Event('pointerdown'));
        sp.dispatchEvent(new win.Event('pointermove'));
        sp.dispatchEvent(new win.Event('pointerup'));
        sp.dispatchEvent(new win.Event('dblclick'));
        ok('分隔条拖动 / 双击复位事件正常');
      }
      APM.setView('chart');
      if (APM.state().view !== 'chart') fail('同屏切回折线图失败');
      else ok('折线图 / 3D / 同屏 三视图切换正常');
    }
  }

  // 18. 清空
  doc.getElementById('btnClear').dispatchEvent(new win.Event('click'));
  if (doc.querySelector('#logList .logitem')) fail('清空后日志仍在');
  else ok('清空正常');
  if (nBoxes() !== 2) fail('清空后应只剩 左/右 两个调节盒');
  if (!/该轴暂无曲线/.test(rngOf('L'))) fail('清空后范围读数未复位：' + rngOf('L'));
  else ok('清空后范围读数复位');

  if (win.__jsdomErrors.length) fail('页面抛出异常：' + win.__jsdomErrors.join(' | '));

  // 19. 用真实 echarts 渲染：分别验证「手动锁定 min/max」与「自动(null)」两种轴配置
  const ec = require(process.env.ECHARTS_PATH);
  const render = (o, tag) => {
    const inst = ec.init(null, null, { renderer: 'svg', ssr: true, width: 1280, height: 620 });
    inst.setOption(o);
    const svg = inst.renderToSVGString();
    const paths = (svg.match(/<path/g) || []).length;
    console.log('  SSR %s：svg %d bytes，path %d 个', tag, svg.length, paths);
    if (svg.length < 20000 || paths < 20) fail('ECharts SSR 渲染异常（' + tag + '）');
    return svg;
  };
  render(oZoom, '左轴缩放/偏移');
  render(optIMU, '自动范围');
  const svgInd = render(oI3, '独立轴 + 共享轴混合');
  const nText = (svgInd.match(/<text/g) || []).length;
  console.log('  独立轴布局：yAxis %d 个，text %d 个', oI3.yAxis.length, nText);
  if (oI3.yAxis.length !== 3) fail('混合场景应有 3 个 yAxis，实际 ' + oI3.yAxis.length);
  ok('真实 ECharts 渲染通过（含锁定 min/max、自动、多轴混合三种配置）');

  console.log(process.exitCode ? '=== 存在失败项 ===' : '=== 全部通过 ===');
})().catch(e => { console.log('EXCEPTION', e && e.stack || e); process.exitCode = 1; })
  .then(function () {
    // jsdom 窗口里还挂着定时器，显式收尾，否则测试进程不会退出
    setTimeout(function () {
      try { dom.window.close(); } catch (e) {}
      process.exit(process.exitCode || 0);
    }, 150);
  });