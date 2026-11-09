#!/usr/bin/env node
/**
 * DocCertified — single-file rapid prototype
 * Made by VoidClient02 with help from Claude (Anthropic).
 * Run:   node doccertified.js        -> http://localhost:3000
 * SQL:   node doccertified.js --sql  -> prints the Supabase/PostgreSQL schema
 * Needs: Node 18+, no npm packages (React loads from a CDN in the browser).
 *
 * Migration map (when ready to split up):
 *   SQL const      -> Supabase SQL editor / migrations
 *   client()       -> React app (Vite), components App/Dashboard/DocForm
 *   routes()       -> Supabase client calls or Edge Functions / Render service
 *   registryCheck  -> real issuer-registry API integration
 *   scan()         -> Supabase pg_cron job or Render cron job
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'doccertified.db.json');
const UP_DIR = path.join(__dirname, 'uploads');
const DAY = 864e5, WARN_DAYS = 30;

// ---------- PostgreSQL schema (for Supabase) ----------
const SQL = `
create table subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('employee','vendor')),
  created_at timestamptz default now()
);
create table requirements (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  doc_type text not null,
  unique (kind, doc_type)
);
create table documents (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid references subjects(id) on delete cascade,
  doc_type text not null,
  issuer text not null,
  number text not null,
  issued_on date not null,
  expires_on date not null,
  file_path text,
  sha256 text,
  verification text default 'pending' check (verification in ('pending','verified','failed')),
  verified_at timestamptz,
  created_at timestamptz default now()
);
create table alerts (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  subject_id uuid references subjects(id) on delete cascade,
  level text not null,
  message text not null,
  created_at timestamptz default now()
);
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz default now(),
  action text not null,
  detail text
);
-- Supabase: enable row level security + add policies per company before going live.
alter table subjects enable row level security;
alter table documents enable row level security;
`;
if (process.argv.includes('--sql')) { console.log(SQL); process.exit(0); }

// ---------- Data store (JSON file stands in for Postgres) ----------
const uid = () => crypto.randomUUID();
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
function seed() {
  const a = uid(), b = uid();
  const d = (s, t, i, n, e, v) => ({ id: uid(), subject_id: s, type: t, issuer: i, number: n, issued: iso(-300), expires: iso(e), verification: v, verified_at: v === 'pending' ? null : new Date().toISOString(), file: null, sha256: null });
  return {
    requirements: { employee: ['ID Document', 'Medical Certificate', 'Safety Training'], vendor: ['Tax Clearance', 'Insurance', 'Business License'] },
    subjects: [{ id: a, name: 'Thabo Mokoena', kind: 'employee' }, { id: b, name: 'Acme Supplies (Pty) Ltd', kind: 'vendor' }],
    documents: [
      d(a, 'ID Document', 'DHA', 'DHA-900112', 2000, 'verified'),
      d(a, 'Medical Certificate', 'OHC', 'OHC-55821', 12, 'verified'),
      d(a, 'Safety Training', 'SETA', 'SETA-7731', -5, 'verified'),
      d(b, 'Tax Clearance', 'SARS', 'SARS-120045', 200, 'verified'),
      d(b, 'Insurance', 'SANTAM', 'SANTAM-0042', 90, 'pending')
    ],
    alerts: [], log: []
  };
}
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : seed();
fs.mkdirSync(UP_DIR, { recursive: true });
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
const log = (action, detail = '') => { db.log.unshift({ at: new Date().toISOString(), action, detail }); db.log = db.log.slice(0, 100); };

// ---------- Core logic ----------
function docStatus(d) {
  if (d.verification === 'failed') return 'invalid';
  const left = (new Date(d.expires) - Date.now()) / DAY;
  if (left < 0) return 'expired';
  if (left <= WARN_DAYS) return 'expiring';
  return 'valid';
}
function compliance(s) {
  return (db.requirements[s.kind] || []).map(type => {
    const docs = db.documents.filter(d => d.subject_id === s.id && d.type === type).sort((x, y) => y.expires.localeCompare(x.expires));
    const doc = docs[0];
    return { type, status: doc ? docStatus(doc) : 'missing', doc_id: doc && doc.id, expires: doc && doc.expires };
  });
}
// Simulated issuer registry. Replace with real API calls per issuer.
const REVOKED = ['REG-000000'];
function registryCheck(d) {
  if (!/^[A-Z]{2,8}-\d{4,}$/.test(d.number)) return { ok: false, reason: 'Number format not recognised by issuer registry' };
  if (REVOKED.includes(d.number)) return { ok: false, reason: 'Certificate revoked by issuer' };
  return { ok: true, reason: 'Matched issuer registry (simulated)' };
}
function verify(d) {
  let ok = true, reasons = [];
  if (d.file && d.sha256) {
    const p = path.join(UP_DIR, d.file);
    const now = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    if (now !== d.sha256) { ok = false; reasons.push('File integrity check failed (missing or altered)'); }
    else reasons.push('File hash intact');
  }
  const r = registryCheck(d);
  if (!r.ok) ok = false;
  reasons.push(r.reason);
  d.verification = ok ? 'verified' : 'failed';
  d.verified_at = new Date().toISOString();
  log('verify', `${d.type} ${d.number}: ${d.verification}`);
  return { ok, reasons };
}
// Automation: runs on a timer and after every change. Raises/clears alerts.
function scan() {
  const wanted = new Map();
  for (const s of db.subjects) for (const c of compliance(s)) {
    if (c.status === 'valid') continue;
    const level = c.status === 'expiring' ? 'warn' : 'critical';
    const msg = c.status === 'missing' ? `${s.name}: ${c.type} is missing`
      : c.status === 'expiring' ? `${s.name}: ${c.type} expires on ${c.expires}`
      : `${s.name}: ${c.type} is ${c.status}`;
    wanted.set(`${s.id}:${c.type}:${c.status}`, { subject_id: s.id, level, message: msg });
  }
  db.alerts = db.alerts.filter(a => wanted.has(a.key));
  for (const [key, v] of wanted) if (!db.alerts.find(a => a.key === key)) { db.alerts.push({ id: uid(), key, created: new Date().toISOString(), ...v }); log('alert', v.message); }
  // auto-verify anything still pending
  db.documents.filter(d => d.verification === 'pending').forEach(verify);
  save();
}
function view() {
  const subjects = db.subjects.map(s => ({ ...s, compliance: compliance(s) }));
  const documents = db.documents.map(d => ({ ...d, status: docStatus(d), subject: (db.subjects.find(s => s.id === d.subject_id) || {}).name }));
  const all = subjects.flatMap(s => s.compliance);
  const stats = { subjects: subjects.length, compliant: subjects.filter(s => s.compliance.every(c => c.status === 'valid' || c.status === 'expiring')).length, expiring: all.filter(c => c.status === 'expiring').length, problems: all.filter(c => ['expired', 'invalid', 'missing'].includes(c.status)).length };
  return { requirements: db.requirements, subjects, documents, alerts: db.alerts, log: db.log.slice(0, 20), stats };
}

// ---------- API ----------
function body(req) {
  return new Promise((res, rej) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > 10e6) { rej(new Error('Body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(parts.length ? JSON.parse(Buffer.concat(parts)) : {}); } catch (e) { rej(e); } });
  });
}
async function api(req, url) {
  const m = req.method, p = url.pathname.replace('/api/', '');
  if (m === 'GET' && p === 'state') return view();
  if (m === 'POST' && p === 'reset') { db = seed(); scan(); return { message: 'Demo data reset' }; }
  if (m === 'POST' && p === 'subjects') {
    const b = await body(req);
    if (!b.name || !db.requirements[b.kind]) return { error: 'Name and valid kind required' };
    db.subjects.push({ id: uid(), name: b.name.trim(), kind: b.kind }); log('subject', b.name); scan();
    return { message: 'Subject added' };
  }
  if (m === 'POST' && p === 'documents') {
    const b = await body(req);
    const s = db.subjects.find(x => x.id === b.subject_id);
    if (!s || !b.type || !b.issuer || !b.number || !b.issued || !b.expires) return { error: 'All fields are required' };
    if (b.expires < b.issued) return { error: 'Expiry date is before issue date' };
    const d = { id: uid(), subject_id: s.id, type: b.type, issuer: b.issuer.trim(), number: b.number.trim().toUpperCase(), issued: b.issued, expires: b.expires, verification: 'pending', verified_at: null, file: null, sha256: null };
    if (b.file && b.file.b64) {
      const buf = Buffer.from(b.file.b64, 'base64');
      d.file = d.id + path.extname(b.file.name || '').slice(0, 8);
      fs.writeFileSync(path.join(UP_DIR, d.file), buf);
      d.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    }
    db.documents.push(d); log('upload', `${d.type} for ${s.name}`); scan();
    return { message: `Document added: ${d.verification}` };
  }
  const vm = p.match(/^documents\/([\w-]+)\/verify$/);
  if (m === 'POST' && vm) {
    const d = db.documents.find(x => x.id === vm[1]);
    if (!d) return { error: 'Not found' };
    const r = verify(d); scan();
    return { message: (r.ok ? 'Verified: ' : 'Failed: ') + r.reasons.join('; ') };
  }
  const dm = p.match(/^documents\/([\w-]+)$/);
  if (m === 'DELETE' && dm) {
    const d = db.documents.find(x => x.id === dm[1]);
    if (d && d.file) try { fs.unlinkSync(path.join(UP_DIR, d.file)); } catch (e) {}
    db.documents = db.documents.filter(x => x.id !== dm[1]); log('delete', dm[1]); scan();
    return { message: 'Document deleted' };
  }
  return { error: 'Not found' };
}

// ---------- Client (React + htm, no build step) ----------
function client() {
  const { useState, useEffect, useCallback } = React;
  const html = htm.bind(React.createElement);
  const call = async (p, method, b) => (await fetch('/api/' + p, method ? { method, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined } : undefined)).json();
  const Badge = ({ s }) => html`<span class=${'badge ' + s}>${s}</span>`;
  const readB64 = f => new Promise(r => { const fr = new FileReader(); fr.onload = () => r({ name: f.name, b64: fr.result.split(',')[1] }); fr.readAsDataURL(f); });

  function DocForm({ d, act }) {
    const blank = { subject_id: '', type: '', issuer: '', number: '', issued: '', expires: '', file: null };
    const [f, setF] = useState(blank);
    const sub = d.subjects.find(s => s.id === f.subject_id);
    const set = k => e => setF({ ...f, [k]: e.target.value });
    return html`<form onSubmit=${async e => { e.preventDefault(); await act('documents', 'POST', f); setF(blank); e.target.reset(); }}>
      <h3>Add document</h3>
      <select required value=${f.subject_id} onChange=${e => setF({ ...f, subject_id: e.target.value, type: '' })}>
        <option value="">Subject…</option>${d.subjects.map(s => html`<option value=${s.id}>${s.name}</option>`)}</select>
      <select required value=${f.type} onChange=${set('type')}>
        <option value="">Document type…</option>${sub && d.requirements[sub.kind].map(t => html`<option>${t}</option>`)}</select>
      <input required placeholder="Issuer (e.g. SARS)" value=${f.issuer} onInput=${set('issuer')} />
      <input required placeholder="Certificate no. (e.g. SARS-120045)" value=${f.number} onInput=${set('number')} />
      <label>Issued <input required type="date" value=${f.issued} onInput=${set('issued')} /></label>
      <label>Expires <input required type="date" value=${f.expires} onInput=${set('expires')} /></label>
      <input type="file" onChange=${async e => setF({ ...f, file: e.target.files[0] ? await readB64(e.target.files[0]) : null })} />
      <button>Add and verify</button></form>`;
  }
  function SubjectForm({ act }) {
    const [name, setName] = useState(''), [kind, setKind] = useState('employee');
    return html`<form onSubmit=${async e => { e.preventDefault(); await act('subjects', 'POST', { name, kind }); setName(''); }}>
      <h3>Add employee / vendor</h3>
      <input required placeholder="Name" value=${name} onInput=${e => setName(e.target.value)} />
      <select value=${kind} onChange=${e => setKind(e.target.value)}><option>employee</option><option>vendor</option></select>
      <button>Add</button></form>`;
  }
  function App() {
    const [d, setD] = useState(null), [msg, setMsg] = useState('');
    const load = useCallback(() => call('state').then(setD), []);
    useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
    const act = async (p, m, b) => { const r = await call(p, m, b); setMsg(r.message || r.error || ''); load(); };
    if (!d) return html`<p>Loading…</p>`;
    const S = d.stats;
    return html`<main>
      <header><h1>DocCertified</h1><button class="ghost" onClick=${() => act('reset', 'POST')}>Reset demo data</button></header>
      ${msg && html`<div class="msg" onClick=${() => setMsg('')}>${msg}</div>`}
      <section class="cards">
        <div><b>${S.subjects}</b>subjects</div><div><b>${S.compliant}</b>compliant</div>
        <div class="warn"><b>${S.expiring}</b>expiring soon</div><div class="crit"><b>${S.problems}</b>need action</div>
      </section>
      <section><h2>Compliance matrix</h2><div class="scroll"><table>
        ${d.subjects.map(s => html`<tr key=${s.id}><th>${s.name}<small>${s.kind}</small></th>
          ${s.compliance.map(c => html`<td key=${c.type}><small>${c.type}</small><${Badge} s=${c.status} /></td>`)}</tr>`)}
      </table></div></section>
      <section><h2>Alerts (${d.alerts.length})</h2>
        ${d.alerts.length ? d.alerts.map(a => html`<div class=${'alert ' + a.level} key=${a.id}>${a.message}</div>`) : html`<p>All documentation is up to date.</p>`}</section>
      <section class="forms"><${SubjectForm} act=${act} /><${DocForm} d=${d} act=${act} /></section>
      <section><h2>Documents</h2><div class="scroll"><table>
        <tr><th>Subject</th><th>Type</th><th>Number</th><th>Expires</th><th>Status</th><th>Registry</th><th></th></tr>
        ${d.documents.map(x => html`<tr key=${x.id}><td>${x.subject}</td><td>${x.type}</td><td>${x.number}</td><td>${x.expires}</td>
          <td><${Badge} s=${x.status} /></td><td>${x.verification}</td>
          <td><button class="ghost" onClick=${() => act('documents/' + x.id + '/verify', 'POST')}>Verify</button>
              <button class="ghost" onClick=${() => confirm('Delete?') && act('documents/' + x.id, 'DELETE')}>✕</button></td></tr>`)}
      </table></div></section>
      <section><h2>Audit log</h2>${d.log.map((l, i) => html`<div class="log" key=${i}><time>${l.at.slice(0, 19).replace('T', ' ')}</time> <b>${l.action}</b> ${l.detail}</div>`)}</section>
    </main>`;
  }
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DocCertified</title>
<style>
:root{--bg:#f6f7f9;--fg:#1c2128;--card:#fff;--line:#dde1e6;--accent:#2563eb;--ok:#15803d;--warn:#b45309;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--fg:#e6e9ee;--card:#171c23;--line:#2a313b;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1000px;margin:auto;padding:16px}header{display:flex;justify-content:space-between;align-items:center}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
h1{margin:0}h2,h3{margin:0 0 10px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;background:none;border:0;padding:0}
.cards div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.cards b{display:block;font-size:26px}
.warn b{color:var(--warn)}.crit b{color:var(--bad)}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}small{display:block;opacity:.65}
.badge{padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid currentColor}.valid{color:var(--ok)}.expiring{color:var(--warn)}
.expired,.invalid,.missing{color:var(--bad)}.alert{padding:8px 10px;border-left:4px solid;margin:6px 0;border-radius:4px;background:var(--bg)}
.alert.warn{border-color:var(--warn)}.alert.critical{border-color:var(--bad)}.forms{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
form{display:flex;flex-direction:column;gap:8px}input,select,button{font:inherit;padding:8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button{background:var(--accent);color:#fff;border:0;cursor:pointer}button.ghost{background:none;color:var(--accent);border:1px solid var(--line)}
.msg{background:var(--accent);color:#fff;padding:8px 12px;border-radius:6px;cursor:pointer}.log{font-size:13px;padding:2px 0}time{opacity:.6}
</style></head><body><div id="root"></div>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/htm@3.1.1/dist/htm.umd.js"></script>
<script>(${client})()</script></body></html>`;

// ---------- Server ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await api(req, url);
      res.writeHead(out.error ? 400 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => { scan(); console.log(`DocCertified running at http://localhost:${PORT}`); });
setInterval(scan, 60 * 1000); // automated re-check every minute (prototype); use a cron job in production
