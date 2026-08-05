// test/fmt_check.js - check formatter idempotency on all examples
'use strict';
const { formatWoolan } = require('../src/formatter');
const fs = require('fs');
const path = require('path');
const exDir = path.join(__dirname, '..', '..', 'examples');

let issues = 0;
for (const f of fs.readdirSync(exDir).filter(f => f.endsWith('.woo'))) {
  const src = fs.readFileSync(path.join(exDir, f), 'utf8');
  let o1;
  try { o1 = formatWoolan(src); } catch (e) { console.log('FMT ERROR', f, '-', e.message); issues++; continue; }
  let o2;
  try { o2 = formatWoolan(o1); } catch (e) { console.log('RE-FMT ERROR', f, '-', e.message); issues++; continue; }
  if (o1 !== o2) { console.log('NOT IDEMPOTENT:', f); issues++; }
}
console.log(issues === 0 ? 'all examples: idempotent, no errors' : (issues + ' issue(s)'));
