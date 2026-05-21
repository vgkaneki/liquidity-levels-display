const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'verify-render-build.cjs');
if (!fs.existsSync(file)) process.exit(0);

let source = fs.readFileSync(file, 'utf8');
let changed = false;

if (!source.includes('RENDER_VERIFY_VERBOSE')) {
  source = source.replace(
    "const phase = process.env.RENDER_VERIFY_PHASE || 'pre';\nconst checks = [];",
    "const phase = process.env.RENDER_VERIFY_PHASE || 'pre';\nconst verbose = process.env.RENDER_VERIFY_VERBOSE === '1' || process.env.CI_VERBOSE === '1';\nconst checks = [];",
  );
  source = source.replace(
    "function check(name, ok, detail) {\n  checks.push({ name, ok, detail });\n  const tag = ok ? 'OK' : 'FAIL';\n  console.log(`[render-verify:${phase}] ${tag}: ${name}${detail ? ` — ${detail}` : ''}`);\n}\n",
    "function check(name, ok, detail) {\n  checks.push({ name, ok, detail });\n  if (ok && !verbose) return;\n  const tag = ok ? 'OK' : 'FAIL';\n  const line = `[render-verify:${phase}] ${tag}: ${name}${detail ? ` — ${detail}` : ''}`;\n  if (ok) console.log(line);\n  else console.error(line);\n}\n",
  );
  changed = true;
}

if (changed) fs.writeFileSync(file, source);
console.log('[quiet-render-verifier] OK');
