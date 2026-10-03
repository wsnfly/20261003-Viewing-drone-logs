const fs = require('fs');
const h = fs.readFileSync('tool_src.html', 'utf8');
const m = h.indexOf('<script id="app">');
if (m < 0) { console.log('app script not found'); process.exit(1); }
const s = h.indexOf('>', m) + 1;
const e = h.lastIndexOf('</script>');
const code = h.slice(s, e);
fs.writeFileSync('_app_check.js', code);
console.log('script chars', code.length);
