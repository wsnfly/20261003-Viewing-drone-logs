# -*- coding: utf-8 -*-
"""把 tool_src.html 与本地 JS 依赖合并成一个自包含 HTML。"""
import os

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "tool_src.html")
OUT = os.path.join(BASE, "APM日志折线分析工具.html")

# (HTML 标签, 本地文件, 内联后的开头注释)
INLINES = [
    ('<script src="echarts.min.js"></script>', "echarts.min.js",
     "/* ECharts 5 (Apache-2.0) 内联以便单文件离线运行 */"),
    ('<script src="three.min.js"></script>', "three.min.js",
     "/* Three.js r147 (MIT) 内联以便单文件离线运行 */"),
    ('<script src="OrbitControls.js"></script>', "OrbitControls.js",
     "/* Three.js OrbitControls r147 (MIT) 内联以便单文件离线运行 */"),
]

html = open(SRC, encoding="utf-8").read()

for tag, fname, note in INLINES:
    if tag not in html:
        raise SystemExit("!! 未找到依赖标签 " + tag)
    code = open(os.path.join(BASE, fname), encoding="utf-8").read()
    if "</script" in code:
        raise SystemExit("!! %s 源码含 </script，需要转义" % fname)
    html = html.replace(tag, "<script>" + note + "\n" + code + "\n</script>")

open(OUT, "w", encoding="utf-8").write(html)
print("built:", OUT, len(html.encode("utf-8")), "bytes")
