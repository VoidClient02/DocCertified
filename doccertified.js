#!/usr/bin/env node
/**
 * DocCertified v2 — single-file rapid prototype
 * Made by VoidClient02 with help from Claude (Anthropic).
 * Run:   node doccertified.js        -> http://localhost:3000
 * SQL:   node doccertified.js --sql  -> prints the Supabase/PostgreSQL schema
 * Needs: Node 18+, no npm packages. Browser loads React, pdf.js and Tesseract.js (OCR) from CDNs, so it needs internet.
 *
 * Migration map: SQL -> Supabase | client() -> React (Vite) | api() -> Supabase/Render service
 *   registryCheck -> real issuer APIs | analyse() -> Edge Function | scan() -> pg_cron / Render cron
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'doccertified.db.json');
const UP_DIR = path.join(__dirname, 'uploads');
const DAY = 864e5, WARN_DAYS = 30;

// ---------- Catalogue (drives every dropdown) ----------
const E = 'employee', V = 'vendor', C = 'contractor';
const TYPES = {
  'ID Document': { k: [E, C], kw: ['identity', 'id number', 'republic', 'home affairs', 'surname'] },
  'Passport': { k: [E, C], kw: ['passport', 'nationality', 'date of birth'] },
  'Work Permit / Visa': { k: [E, C], kw: ['visa', 'permit', 'immigration', 'permitted'] },
  "Driver's Licence": { k: [E, C], kw: ['driving licence', "driver's licence", 'licence', 'code'] },
  'Medical Certificate': { k: [E, C], kw: ['medical', 'fit for', 'fitness', 'practitioner', 'examination'] },
  'Safety Training': { k: [E, C], kw: ['safety', 'training', 'competent', 'attended', 'course'] },
  'First Aid Certificate': { k: [E, C], kw: ['first aid', 'cpr', 'resuscitation'] },
  'Qualification / Degree': { k: [E], kw: ['degree', 'diploma', 'qualification', 'university', 'awarded'] },
  'Professional Registration': { k: [E, C], kw: ['registered', 'registration', 'council', 'professional'] },
  'Police Clearance': { k: [E, C], kw: ['police', 'clearance', 'criminal', 'saps'] },
  'Tax Clearance': { k: [V], kw: ['tax', 'compliance status', 'revenue service', 'sars', 'good standing'] },
  'Insurance': { k: [V, C], kw: ['insurance', 'policy', 'insured', 'cover', 'liability'] },
  'Business License': { k: [V], kw: ['licen', 'trading', 'business', 'municipal', 'authorised'] },
  'Company Registration (CIPC)': { k: [V], kw: ['cipc', 'companies', 'registration', 'enterprise', 'company'] },
  'B-BBEE Certificate': { k: [V], kw: ['b-bbee', 'bbbee', 'broad-based', 'verification', 'level'] },
  'COID Letter of Good Standing': { k: [V, C], kw: ['compensation', 'coid', 'good standing', 'labour'] },
  'VAT Registration': { k: [V], kw: ['vat', 'value-added', 'value added'] },
  'ISO Certification': { k: [V], kw: ['iso', 'management system', 'certified', 'standard'] },
  'Bank Confirmation Letter': { k: [V], kw: ['bank', 'account', 'branch', 'confirm'] }
};
const ISSUERS = ['SARS', 'DHA', 'CIPC', 'Department of Labour', 'SETA', 'SABS', 'SAQA', 'HPCSA', 'ECSA', 'SAPS', 'Santam', 'Old Mutual', 'Sanlam', 'Discovery', 'Momentum', 'B-BBEE Verification Agency', 'Local Municipality'];
const DEPTS = ['Operations', 'Finance', 'Human Resources', 'IT', 'Legal & Compliance', 'Procurement', 'Logistics', 'Health & Safety', 'Sales & Marketing'];
const REQUIRED = { employee: ['ID Document', 'Medical Certificate', 'Safety Training'], vendor: ['Tax Clearance', 'Insurance', 'Business License'], contractor: ['ID Document', 'Safety Training', 'Insurance'] };

// ---------- PostgreSQL schema (for Supabase) ----------
const SQL = `
create table subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null, kind text not null, department text,
  created_at timestamptz default now()
);
create table requirements (
  id uuid primary key default gen_random_uuid(),
  kind text not null, doc_type text not null, unique (kind, doc_type)
);
create table documents (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid references subjects(id) on delete cascade,
  doc_type text not null, issuer text not null, number text not null,
  issued_on date not null, expires_on date not null,
  file_path text, sha256 text,
  extraction_method text, extraction_confidence int,
  content_score int, content_checks jsonb,
  verification text default 'pending' check (verification in ('pending','verified','review','failed')),
  verified_at timestamptz, created_at timestamptz default now()
);
create table alerts (
  id uuid primary key default gen_random_uuid(),
  key text unique not null, subject_id uuid references subjects(id) on delete cascade,
  level text not null, message text not null, created_at timestamptz default now()
);
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz default now(), action text not null, detail text
);
-- Before going live: add RLS policies per company.
alter table subjects enable row level security;
alter table documents enable row level security;
`;
if (process.argv.includes('--sql')) { console.log(SQL); process.exit(0); }

// ---------- Shared helpers (also sent to the browser) ----------
function pad(n) { return String(n).padStart(2, '0'); }
function findDates(t) {
  const M = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], out = []; let m;
  const add = (y, mo, d, i) => { if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && +y > 1990 && +y < 2100) out.push({ iso: y + '-' + pad(mo) + '-' + pad(d), i }); };
  const a = /(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/g; while ((m = a.exec(t))) add(m[1], m[2], m[3], m.index);
  const b = /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/g; while ((m = b.exec(t))) add(m[3], m[2], m[1], m.index);
  const c = /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/gi;
  while ((m = c.exec(t))) add(m[3], M.indexOf(m[2].toLowerCase()) + 1, m[1], m.index);
  return out.sort((x, y) => x.i - y.i);
}
function detectFields(text, cat, onlyTypes) {
  const t = text.replace(/\s+/g, ' '), low = t.toLowerCase(), out = {};
  let best = 0;
  for (const n of (onlyTypes || Object.keys(cat.types))) { const k = cat.types[n].kw.filter(w => low.includes(w)).length; if (k > best) { best = k; out.type = n; } }
  const iss = cat.issuers.find(i => low.includes(i.toLowerCase())); if (iss) out.issuer = iss;
  for (const m of t.matchAll(/(?:certificate|cert|reference|ref|licen[cs]e|policy|registration|permit)\s*(?:no|number|nr|#)?\s*[.:#]*\s*([A-Z0-9][A-Z0-9\-\/]{3,24})/gi)) {
    if (/\d/.test(m[1]) && m[1].length >= 5) { out.number = m[1].toUpperCase(); break; }
  }
  if (!out.number) { const m = t.match(/\b[A-Z]{2,8}-\d{4,}\b/); if (m) out.number = m[0]; }
  const ds = findDates(t); let iDate, eDate;
  for (const d of ds) {
    const ctx = t.slice(Math.max(0, d.i - 35), d.i);
    if (/expir|valid (until|to|till)|renew/i.test(ctx) && !eDate) eDate = d.iso; else if (/issu|dated|date of/i.test(ctx) && !iDate) iDate = d.iso;
  }
  const isos = [...new Set(ds.map(d => d.iso))].sort();
  if (!iDate && isos.length) iDate = isos[0];
  if (!eDate && isos.length > 1) eDate = isos[isos.length - 1];
  if (iDate) out.issued = iDate;
  if (eDate && eDate !== iDate) out.expires = eDate;
  return out;
}

// ---------- Data store (JSON file stands in for Postgres) ----------
const uid = () => crypto.randomUUID();
const iso = n => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
function seed() {
  const a = uid(), b = uid();
  const d = (s, t, i, n, e) => ({ id: uid(), subject_id: s, type: t, issuer: i, number: n, issued: iso(-300), expires: iso(e), verification: 'verified', verified_at: new Date().toISOString(), file: null, sha256: null, demo: true });
  return {
    requirements: JSON.parse(JSON.stringify(REQUIRED)),
    subjects: [{ id: a, name: 'Thabo Mokoena', kind: E, dept: 'Operations' }, { id: b, name: 'Acme Supplies (Pty) Ltd', kind: V, dept: 'Procurement' }],
    documents: [d(a, 'ID Document', 'DHA', 'DHA-900112', 2000), d(a, 'Medical Certificate', 'HPCSA', 'HPCSA-55821', 12), d(a, 'Safety Training', 'SETA', 'SETA-7731', -5),
      d(b, 'Tax Clearance', 'SARS', 'SARS-120045', 200), d(b, 'Insurance', 'Santam', 'SANTAM-0042', 90)],
    alerts: [], log: []
  };
}
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : seed();
for (const k in REQUIRED) if (!db.requirements[k]) db.requirements[k] = [...REQUIRED[k]];
db.documents.forEach(d => { if (!d.file && d.verification === 'verified' && !d.analysis) d.demo = true; });
fs.mkdirSync(UP_DIR, { recursive: true });
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
const log = (action, detail = '') => { db.log.unshift({ at: new Date().toISOString(), action, detail }); db.log = db.log.slice(0, 100); };

// ---------- Core logic ----------
function docStatus(d) {
  if (d.verification === 'failed') return 'invalid';
  const left = (new Date(d.expires) - Date.now()) / DAY;
  if (left < 0) return 'expired';
  if (d.verification === 'review') return 'review';
  return left <= WARN_DAYS ? 'expiring' : 'valid';
}
function compliance(s) {
  return (db.requirements[s.kind] || []).map(type => {
    const doc = db.documents.filter(d => d.subject_id === s.id && d.type === type).sort((x, y) => y.expires.localeCompare(x.expires))[0];
    return { type, status: doc ? docStatus(doc) : 'missing', doc_id: doc && doc.id, expires: doc && doc.expires };
  });
}
const OK = c => c.status === 'valid' || c.status === 'expiring';
// Simulated issuer registry. Replace with real API calls per issuer.
const REVOKED = ['REG-000000'];
function registryCheck(d) {
  if (!/^(?=.*\d)[A-Z0-9][A-Z0-9\-\/]{3,29}$/.test(d.number)) return { ok: false, reason: 'Certificate number format not recognised' };
  if (REVOKED.includes(d.number)) return { ok: false, reason: 'Certificate revoked by issuer' };
  return { ok: true, reason: 'Matched issuer registry (simulated)' };
}
// Content check: does the uploaded file actually contain what we need to verify?
function analyse(d, text) {
  const clean = (text || '').replace(/\s+/g, ' '), low = clean.toLowerCase(), cfg = TYPES[d.type];
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hits = cfg ? cfg.kw.filter(k => low.includes(k)).length : 0;
  const ds = findDates(clean).map(x => x.iso);
  const checks = [
    { label: 'Readable text found in file', ok: clean.trim().length >= 40, w: 25 },
    { label: cfg ? `Wording matches "${d.type}" (${hits}/${cfg.kw.length} keywords)` : 'Custom document type (wording not checked)', ok: cfg ? hits >= Math.min(2, cfg.kw.length) : true, w: 25 },
    { label: 'Certificate number appears in document', ok: norm(clean).includes(norm(d.number)), w: 25 },
    { label: 'Issue or expiry date appears in document', ok: ds.includes(d.issued) || ds.includes(d.expires), w: 15 },
    { label: 'Issuer is named in document', ok: low.includes(d.issuer.toLowerCase()), w: 10 }
  ];
  const score = checks.reduce((s, c) => s + (c.ok ? c.w : 0), 0);
  return { score, verdict: score >= 70 ? 'strong' : score >= 40 ? 'partial' : 'weak', checks: checks.map(({ label, ok }) => ({ label, ok })) };
}
function verify(d) {
  const why = []; let hard = false, soft = false;
  if (d.file && d.sha256) {
    const p = path.join(UP_DIR, d.file);
    const now = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    if (now !== d.sha256) { hard = true; why.push('File integrity failed (missing or altered)'); } else why.push('File integrity intact');
  }
  const r = registryCheck(d); if (!r.ok) hard = true; why.push(r.reason);
  if (db.documents.some(x => x.id !== d.id && x.number === d.number && x.subject_id !== d.subject_id)) { hard = true; why.push('Same certificate number is registered to another subject'); }
  if (d.analysis) {
    if (d.analysis.verdict === 'weak') { hard = true; why.push(`Content check weak (${d.analysis.score}%): file lacks verifiable content`); }
    else if (d.analysis.verdict === 'partial') { soft = true; why.push(`Content check partial (${d.analysis.score}%): manual review needed`); }
    else why.push(`Content check strong (${d.analysis.score}%)`);
  } else if (!d.demo) { soft = true; why.push('No file attached: nothing to check the details against'); }
  d.verification = hard ? 'failed' : soft ? 'review' : 'verified';
  d.verified_at = new Date().toISOString(); d.notes = why;
  log('verify', `${d.type} ${d.number}: ${d.verification}`);
  return { state: d.verification, reasons: why };
}
function scan() {
  const wanted = new Map();
  for (const s of db.subjects) for (const c of compliance(s)) {
    if (c.status === 'valid') continue;
    const msg = c.status === 'missing' ? `${s.name}: ${c.type} is missing` : c.status === 'expiring' ? `${s.name}: ${c.type} expires on ${c.expires}`
      : c.status === 'review' ? `${s.name}: ${c.type} needs manual review` : `${s.name}: ${c.type} is ${c.status}`;
    wanted.set(`${s.id}:${c.type}:${c.status}`, { subject_id: s.id, level: c.status === 'expiring' || c.status === 'review' ? 'warn' : 'critical', message: msg });
  }
  db.alerts = db.alerts.filter(a => wanted.has(a.key));
  for (const [key, v] of wanted) if (!db.alerts.find(a => a.key === key)) { db.alerts.push({ id: uid(), key, created: new Date().toISOString(), ...v }); log('alert', v.message); }
  db.documents.filter(d => d.verification === 'pending').forEach(verify);
  save();
}
function view() {
  const subjects = db.subjects.map(s => { const c = compliance(s); return { ...s, compliance: c, pct: c.length ? Math.round(100 * c.filter(OK).length / c.length) : 100 }; });
  const documents = db.documents.map(d => ({ ...d, status: docStatus(d), subject: (db.subjects.find(s => s.id === d.subject_id) || {}).name }));
  const all = subjects.flatMap(s => s.compliance);
  const stats = {
    subjects: subjects.length, pct: all.length ? Math.round(100 * all.filter(OK).length / all.length) : 100,
    expiring: all.filter(c => c.status === 'expiring').length, review: all.filter(c => c.status === 'review').length,
    problems: all.filter(c => ['expired', 'invalid', 'missing'].includes(c.status)).length
  };
  const byKind = {}; for (const k in db.requirements) byKind[k] = Object.keys(TYPES).filter(t => TYPES[t].k.includes(k));
  for (const k in byKind) if (!byKind[k].length) byKind[k] = Object.keys(TYPES);
  return { subjects, documents, alerts: db.alerts, log: db.log, stats, catalog: { types: TYPES, byKind, issuers: ISSUERS, depts: DEPTS, kinds: Object.keys(db.requirements) } };
}

// ---------- API ----------
function body(req) {
  return new Promise((res, rej) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > 15e6) { rej(new Error('Body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(parts.length ? JSON.parse(Buffer.concat(parts)) : {}); } catch (e) { rej(e); } });
  });
}
const txt = (s, n = 80) => String(s || '').trim().slice(0, n);
async function api(req, url) {
  const m = req.method, p = url.pathname.replace('/api/', '');
  if (m === 'GET' && p === 'state') return view();
  if (m === 'POST' && p === 'reset') { db = seed(); for (const k in REQUIRED) if (!db.requirements[k]) db.requirements[k] = [...REQUIRED[k]]; scan(); return { message: 'Demo data reset' }; }
  if (m === 'POST' && p === 'subjects') {
    const b = await body(req), name = txt(b.name), kind = txt(b.kind, 30).toLowerCase();
    if (!name || !kind) return { error: 'Name and type are required' };
    if (!db.requirements[kind]) db.requirements[kind] = [];
    db.subjects.push({ id: uid(), name, kind, dept: txt(b.dept, 40) }); log('subject', name); scan();
    return { message: `${name} added` };
  }
  const sm = p.match(/^subjects\/([\w-]+)$/);
  if (m === 'DELETE' && sm) {
    db.documents.filter(d => d.subject_id === sm[1] && d.file).forEach(d => { try { fs.unlinkSync(path.join(UP_DIR, d.file)); } catch (e) {} });
    db.documents = db.documents.filter(d => d.subject_id !== sm[1]); db.subjects = db.subjects.filter(s => s.id !== sm[1]); log('delete subject', sm[1]); scan();
    return { message: 'Subject and its documents deleted' };
  }
  if (m === 'POST' && p === 'documents') {
    const b = await body(req), s = db.subjects.find(x => x.id === b.subject_id);
    const d = { id: uid(), subject_id: s && s.id, type: txt(b.type), issuer: txt(b.issuer), number: txt(b.number, 30).toUpperCase().replace(/\s+/g, ''), issued: b.issued, expires: b.expires, verification: 'pending', verified_at: null, file: null, sha256: null };
    if (!s || !d.type || !d.issuer || !d.number || !d.issued || !d.expires) return { error: 'All fields are required' };
    if (d.expires < d.issued) return { error: 'Expiry date is before the issue date' };
    if (b.file && b.file.b64) {
      const buf = Buffer.from(b.file.b64, 'base64');
      d.file = d.id + path.extname(String(b.file.name || '')).slice(0, 8).replace(/[^\w.]/g, '');
      fs.writeFileSync(path.join(UP_DIR, d.file), buf);
      d.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      d.analysis = analyse(d, b.text);
      d.method = txt(b.ocr && b.ocr.method, 20); d.confidence = b.ocr && b.ocr.confidence;
    }
    db.documents.push(d); log('upload', `${d.type} for ${s.name}`); verify(d); scan();
    return { message: { verified: 'Document verified', review: 'Added: needs manual review', failed: 'Added: verification failed' }[d.verification], state: d.verification };
  }
  const vm = p.match(/^documents\/([\w-]+)\/verify$/);
  if (m === 'POST' && vm) {
    const d = db.documents.find(x => x.id === vm[1]); if (!d) return { error: 'Not found' };
    const r = verify(d); scan(); return { message: `${r.state.toUpperCase()}: ${r.reasons.join('; ')}` };
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
  const LBL = { valid: 'Valid', expiring: 'Expiring soon', review: 'Needs review', expired: 'Expired', invalid: 'Invalid', missing: 'Missing', verified: 'Verified', failed: 'Failed', pending: 'Pending' };
  const CLS = { verified: 'valid', failed: 'invalid', pending: 'missing' };
  const Badge = ({ s }) => html`<span class=${'badge ' + (CLS[s] || s)}>${LBL[s] || s}</span>`;
  const left = iso => Math.ceil((new Date(iso) - Date.now()) / 864e5);
  const toB64 = f => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(f); });

  async function extract(file, progress) {
    const n = file.name.toLowerCase();
    if (file.type === 'application/pdf' || n.endsWith('.pdf')) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = '', ocr = false; const conf = [];
      for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
        const page = await pdf.getPage(p);
        let t = (await page.getTextContent()).items.map(i => i.str).join(' ');
        if (t.trim().length < 40) {
          progress('Scanned page detected, running OCR on page ' + p + '…');
          const vp = page.getViewport({ scale: 2 }), c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          const r = await Tesseract.recognize(c, 'eng'); t = r.data.text; conf.push(r.data.confidence); ocr = true;
        }
        text += ' ' + t;
      }
      return { text, method: ocr ? 'OCR' : 'PDF text', confidence: conf.length ? Math.round(conf.reduce((a, b) => a + b) / conf.length) : 100 };
    }
    if (file.type.startsWith('image/')) {
      progress('Running OCR…');
      const r = await Tesseract.recognize(file, 'eng', { logger: m => m.status === 'recognizing text' && progress('OCR ' + Math.round(m.progress * 100) + '%') });
      return { text: r.data.text, method: 'OCR', confidence: Math.round(r.data.confidence) };
    }
    return { text: await file.text(), method: 'Text file', confidence: 100 };
  }

  // Dropdown with "Other" free-text option
  function Pick({ label, opts, value, onChange, reqd }) {
    const [other, setOther] = useState(false);
    const show = other || (value && !opts.includes(value));
    return html`<label class="fld"><span>${label}${reqd && ' *'}</span>
      <select required=${reqd} value=${show ? '__o' : value} onChange=${e => { if (e.target.value === '__o') { setOther(true); onChange(''); } else { setOther(false); onChange(e.target.value); } }}>
        <option value="">Select…</option>${opts.map(o => html`<option key=${o} value=${o}>${o}</option>`)}<option value="__o">Other (type your own)…</option></select>
      ${show && html`<input required=${reqd} placeholder=${'Enter ' + label.toLowerCase()} value=${value} onInput=${e => onChange(e.target.value)} />`}</label>`;
  }
  const Field = ({ label, children }) => html`<label class="fld"><span>${label}</span>${children}</label>`;

  function Dashboard({ d, go }) {
    const S = d.stats;
    return html`<div>
      <div class="kpis">
        <div class="kpi ringcard"><div class="ring" style=${{ '--p': S.pct }}><b>${S.pct}%</b></div><div><h4>Compliance rate</h4><small>of required documents valid</small></div></div>
        <div class="kpi"><h4>People & vendors</h4><b>${S.subjects}</b></div>
        <div class="kpi warn"><h4>Expiring in 30 days</h4><b>${S.expiring}</b></div>
        <div class="kpi review"><h4>Awaiting review</h4><b>${S.review}</b></div>
        <div class="kpi crit"><h4>Need action</h4><b>${S.problems}</b></div>
      </div>
      <div class="panel"><div class="ph"><h3>Compliance overview</h3></div>
        ${d.subjects.length ? d.subjects.map(s => html`<div class="row" key=${s.id}>
          <div class="who"><b>${s.name}</b><small>${s.kind}${s.dept ? ' · ' + s.dept : ''} · ${s.pct}% compliant</small></div>
          <div class="chips">${s.compliance.length ? s.compliance.map(c => html`<span class="chip" key=${c.type}><small>${c.type}</small><${Badge} s=${c.status} /></span>`) : html`<small>No required documents</small>`}</div></div>`) : html`<p class="empty">No subjects yet.</p>`}</div>
      <div class="panel"><div class="ph"><h3>Needs attention</h3><button class="btn ghost" onClick=${() => go('alerts')}>View all (${d.alerts.length})</button></div>
        ${d.alerts.length ? d.alerts.slice(0, 5).map(a => html`<div class=${'alert ' + a.level} key=${a.id}>${a.message}</div>`) : html`<p class="empty">Everything is up to date.</p>`}</div></div>`;
  }

  function Docs({ d, act }) {
    const [q, setQ] = useState(''), [st, setSt] = useState(''), [ty, setTy] = useState(''), [su, setSu] = useState(''), [open, setOpen] = useState('');
    const rows = d.documents.filter(x => (!st || x.status === st) && (!ty || x.type === ty) && (!su || x.subject_id === su) && (!q || (x.subject + x.type + x.number + x.issuer).toLowerCase().includes(q.toLowerCase())));
    const types = [...new Set(d.documents.map(x => x.type))].sort();
    const exportCsv = () => {
      const r = [['Subject', 'Type', 'Number', 'Issuer', 'Issued', 'Expires', 'Status', 'Verification', 'Content score']].concat(rows.map(x => [x.subject, x.type, x.number, x.issuer, x.issued, x.expires, x.status, x.verification, x.analysis ? x.analysis.score : '']));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.map(l => l.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n')], { type: 'text/csv' })); a.download = 'doccertified-documents.csv'; a.click();
    };
    return html`<div class="panel"><div class="ph"><h3>Documents (${rows.length})</h3><button class="btn ghost" onClick=${exportCsv}>Export CSV</button></div>
      <div class="filters"><input placeholder="Search name, type, number, issuer…" value=${q} onInput=${e => setQ(e.target.value)} />
        <select value=${st} onChange=${e => setSt(e.target.value)}><option value="">All statuses</option>${['valid', 'expiring', 'review', 'expired', 'invalid'].map(s => html`<option value=${s}>${LBL[s]}</option>`)}</select>
        <select value=${ty} onChange=${e => setTy(e.target.value)}><option value="">All document types</option>${types.map(t => html`<option>${t}</option>`)}</select>
        <select value=${su} onChange=${e => setSu(e.target.value)}><option value="">All subjects</option>${d.subjects.map(s => html`<option value=${s.id}>${s.name}</option>`)}</select></div>
      <div class="scroll"><table><thead><tr><th>Subject</th><th>Document</th><th>Number</th><th>Issuer</th><th>Expires</th><th>Status</th><th>Registry</th><th>Content</th><th></th></tr></thead><tbody>
        ${rows.map(x => html`<${React.Fragment} key=${x.id}><tr>
          <td>${x.subject}</td><td>${x.type}</td><td class="mono">${x.number}</td><td>${x.issuer}</td>
          <td>${x.expires}<small>${left(x.expires) < 0 ? Math.abs(left(x.expires)) + ' days ago' : left(x.expires) + ' days left'}</small></td>
          <td><${Badge} s=${x.status} /></td><td><${Badge} s=${x.verification} /></td>
          <td>${x.analysis ? html`<span class=${'score ' + x.analysis.verdict}>${x.analysis.score}%</span>` : html`<small>${x.demo ? 'demo' : 'no file'}</small>`}</td>
          <td class="acts"><button class="btn ghost" onClick=${() => setOpen(open === x.id ? '' : x.id)}>${open === x.id ? 'Hide' : 'Details'}</button>
            <button class="btn ghost" onClick=${() => act('documents/' + x.id + '/verify', 'POST')}>Re-verify</button>
            <button class="btn ghost danger" onClick=${() => confirm('Delete this document?') && act('documents/' + x.id, 'DELETE')}>Delete</button></td></tr>
          ${open === x.id && html`<tr class="detail"><td colspan="9">
            ${x.analysis ? html`<b>Content checks</b><ul>${x.analysis.checks.map((c, i) => html`<li key=${i} class=${c.ok ? 'yes' : 'no'}>${c.ok ? '✔' : '✘'} ${c.label}</li>`)}</ul>` : html`<p>No file attached, so no content checks were run.</p>`}
            ${x.notes && html`<b>Verification notes</b><ul>${x.notes.map((n, i) => html`<li key=${i}>${n}</li>`)}</ul>`}
            <small>${x.method ? 'Read by ' + x.method + (x.confidence != null ? ' (' + x.confidence + '% confidence)' : '') + ' · ' : ''}${x.sha256 ? 'SHA-256 ' + x.sha256.slice(0, 16) + '…' : ''}${x.verified_at ? ' · checked ' + x.verified_at.slice(0, 16).replace('T', ' ') : ''}</small></td></tr>`}</${React.Fragment}>`)}
      </tbody></table>${!rows.length && html`<p class="empty">No documents match.</p>`}</div></div>`;
  }

  function Upload({ d, act, notify, go }) {
    const blank = { subject_id: '', type: '', issuer: '', number: '', issued: '', expires: '', file: null, text: '', ocr: null };
    const [f, setF] = useState(blank), [sc, setSc] = useState(null), [k, setK] = useState(0);
    const sub = d.subjects.find(s => s.id === f.subject_id);
    const types = sub ? d.catalog.byKind[sub.kind] : Object.keys(d.catalog.types);
    const set = key => v => setF(p => ({ ...p, [key]: v && v.target ? v.target.value : v }));
    const onFile = async e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 8e6) return notify('File too large (max 8 MB)', 1);
      setSc({ busy: 'Reading file…' });
      try {
        const r = await extract(file, m => setSc({ busy: m }));
        const det = detectFields(r.text, d.catalog, sub ? types : null);
        const b64 = await toB64(file);
        setF(p => ({ ...p, ...det, file: { name: file.name, b64 }, text: r.text.slice(0, 6000), ocr: { method: r.method, confidence: r.confidence } }));
        setSc({ chars: r.text.trim().length, method: r.method, conf: r.confidence, det });
      } catch (err) { setSc({ err: 'Could not read this file: ' + err.message }); }
    };
    const submit = async e => {
      e.preventDefault();
      const r = await act('documents', 'POST', f);
      if (!r.error) { setF(blank); setSc(null); setK(k + 1); go('docs'); }
    };
    const D = sc && sc.det;
    return html`<form class="panel" key=${k} onSubmit=${submit}>
      <div class="ph"><h3>Upload and verify a document</h3></div>
      <div class="grid2">
        <div><label class="drop"><b>Drop a PDF, photo or scan here, or click to browse</b><small>We read it automatically (PDF text or OCR) and fill in the form. Max 8 MB.</small>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" onChange=${onFile} /></label>
          ${sc && sc.busy && html`<div class="note">⏳ ${sc.busy}</div>`}
          ${sc && sc.err && html`<div class="note bad">${sc.err}</div>`}
          ${sc && sc.chars != null && html`<div class=${'note ' + (sc.chars < 40 ? 'bad' : 'ok')}>
            ${sc.chars < 40 ? 'No readable text was found in this file. It cannot be verified, so use a clearer scan.' : `Read ${sc.chars} characters using ${sc.method} (${sc.conf}% confidence). Please check the details on the right.`}
            ${D && sc.chars >= 40 && html`<div class="chips">${Object.entries(D).map(([a, b]) => html`<span class="tag" key=${a}>${a}: ${b}</span>`)}</div>`}
            ${D && !Object.keys(D).length && sc.chars >= 40 && html`<div>Nothing recognisable detected. Fill in the details manually.</div>`}</div>`}</div>
        <div class="form">
          <${Field} label="Subject *"><select required value=${f.subject_id} onChange=${set('subject_id')}><option value="">Select person or vendor…</option>${d.subjects.map(s => html`<option value=${s.id}>${s.name} (${s.kind})</option>`)}</select></${Field}>
          <${Pick} label="Document type" reqd=${true} opts=${types} value=${f.type} onChange=${set('type')} />
          <${Pick} label="Issuer" reqd=${true} opts=${d.catalog.issuers} value=${f.issuer} onChange=${set('issuer')} />
          <${Field} label="Certificate number *"><input required placeholder="e.g. SARS-120045" value=${f.number} onInput=${set('number')} /></${Field}>
          <div class="two"><${Field} label="Issued *"><input required type="date" value=${f.issued} onInput=${set('issued')} /></${Field}>
            <${Field} label="Expires *"><input required type="date" value=${f.expires} onInput=${set('expires')} /></${Field}></div>
          <button class="btn primary" disabled=${!!(sc && sc.busy)}>Add and verify</button></div></div></form>`;
  }

  function Subjects({ d, act }) {
    const [name, setName] = useState(''), [kind, setKind] = useState(''), [dept, setDept] = useState('');
    return html`<div>
      <form class="panel" onSubmit=${async e => { e.preventDefault(); const r = await act('subjects', 'POST', { name, kind, dept }); if (!r.error) { setName(''); setKind(''); setDept(''); } }}>
        <div class="ph"><h3>Add employee, vendor or contractor</h3></div>
        <div class="grid3"><${Field} label="Name *"><input required value=${name} onInput=${e => setName(e.target.value)} placeholder="Full name or company" /></${Field}>
          <${Pick} label="Type" reqd=${true} opts=${d.catalog.kinds} value=${kind} onChange=${setKind} />
          <${Pick} label="Department" opts=${d.catalog.depts} value=${dept} onChange=${setDept} /></div>
        <button class="btn primary">Add</button></form>
      <div class="panel"><div class="ph"><h3>People & vendors (${d.subjects.length})</h3></div><div class="scroll"><table>
        <thead><tr><th>Name</th><th>Type</th><th>Department</th><th>Compliance</th><th></th></tr></thead><tbody>
        ${d.subjects.map(s => html`<tr key=${s.id}><td><b>${s.name}</b></td><td>${s.kind}</td><td>${s.dept || '—'}</td>
          <td><div class="bar"><i style=${{ width: s.pct + '%' }}></i></div><small>${s.pct}%</small></td>
          <td><button class="btn ghost danger" onClick=${() => confirm('Delete ' + s.name + ' and all their documents?') && act('subjects/' + s.id, 'DELETE')}>Delete</button></td></tr>`)}
      </tbody></table></div></div></div>`;
  }

  function App() {
    const [d, setD] = useState(null), [tab, setTab] = useState('dash'), [toast, setToast] = useState(null);
    const [theme, setTheme] = useState(localStorage.getItem('dc-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('dc-theme', theme); }, [theme]);
    const load = useCallback(() => call('state').then(setD), []);
    useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
    const notify = (m, bad) => { setToast({ m, bad }); setTimeout(() => setToast(null), 4500); };
    const act = async (p, m, b) => { const r = await call(p, m, b); notify(r.message || r.error, !!r.error || r.state === 'failed'); load(); return r; };
    if (!d) return html`<p style=${{ padding: 24 }}>Loading…</p>`;
    const nav = [['dash', 'Dashboard'], ['docs', 'Documents'], ['upload', 'Upload'], ['subjects', 'People & vendors'], ['alerts', 'Alerts'], ['audit', 'Audit log']];
    return html`<div class="shell">
      <aside><div class="brand"><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z" fill="#2F6BFF"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>DocCertified</span></div>
        <nav>${nav.map(([id, l]) => html`<button key=${id} class=${tab === id ? 'on' : ''} onClick=${() => setTab(id)}>${l}${id === 'alerts' && d.alerts.length ? html`<i>${d.alerts.length}</i>` : ''}</button>`)}</nav>
        <div class="side-foot"><button class="btn ghost" onClick=${() => setTheme(theme === 'dark' ? 'light' : 'dark')}>${theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
          <button class="btn ghost" onClick=${() => confirm('Reset all data to the demo set?') && act('reset', 'POST')}>Reset demo data</button></div></aside>
      <main><h1>${nav.find(n => n[0] === tab)[1]}</h1>
        ${tab === 'dash' && html`<${Dashboard} d=${d} go=${setTab} />`}
        ${tab === 'docs' && html`<${Docs} d=${d} act=${act} />`}
        ${tab === 'upload' && html`<${Upload} d=${d} act=${act} notify=${notify} go=${setTab} />`}
        ${tab === 'subjects' && html`<${Subjects} d=${d} act=${act} />`}
        ${tab === 'alerts' && html`<div class="panel">${d.alerts.length ? d.alerts.map(a => html`<div class=${'alert ' + a.level} key=${a.id}>${a.message}<small>${a.created.slice(0, 16).replace('T', ' ')}</small></div>`) : html`<p class="empty">No open alerts.</p>`}</div>`}
        ${tab === 'audit' && html`<div class="panel">${d.log.map((l, i) => html`<div class="log" key=${i}><time>${l.at.slice(0, 19).replace('T', ' ')}</time><b>${l.action}</b><span>${l.detail}</span></div>`)}</div>`}
      </main>
      ${toast && html`<div class=${'toast ' + (toast.bad ? 'bad' : '')} onClick=${() => setToast(null)}>${toast.m}</div>`}</div>`;
  }
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
}

const CSS = `
:root{--bg:#F3F5F9;--sf:#fff;--bd:#E2E7EF;--tx:#0F172A;--mu:#64748B;--nav:#0B1F3A;--ac:#2F6BFF;--ok:#15803D;--okb:#DCFCE7;--wn:#B45309;--wnb:#FEF3C7;--bad:#B91C1C;--badb:#FEE2E2;--rv:#6D28D9;--rvb:#EDE9FE;--nu:#475569;--nub:#E8EDF4}
:root[data-theme=dark]{--bg:#0A101C;--sf:#111A2B;--bd:#223049;--tx:#E6EDF7;--mu:#8EA0B8;--nav:#070D18;--ac:#5B8CFF;--ok:#4ADE80;--okb:#12301F;--wn:#FBBF24;--wnb:#3A2A0B;--bad:#F87171;--badb:#3B1414;--rv:#A78BFA;--rvb:#2A1F4D;--nu:#A7B4C6;--nub:#1C2638}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--tx)}
.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}aside{background:var(--nav);color:#C9D6EA;padding:18px 12px;display:flex;flex-direction:column;gap:18px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:#fff;padding:0 8px}nav{display:flex;flex-direction:column;gap:2px;flex:1}
nav button{all:unset;cursor:pointer;padding:9px 12px;border-radius:8px;display:flex;justify-content:space-between;color:#C9D6EA}nav button:hover{background:#ffffff14}nav button.on{background:var(--ac);color:#fff}
nav i{font-style:normal;background:#ffffff30;border-radius:99px;padding:0 8px;font-size:12px}.side-foot{display:flex;flex-direction:column;gap:8px}
main{padding:24px 28px;max-width:1180px;width:100%}h1{font-size:22px;margin:0 0 16px}h3{margin:0;font-size:15px}h4{margin:0 0 4px;font-size:12px;color:var(--mu);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.panel{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:16px}.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}.kpi{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:14px}.kpi b{font-size:28px}
.kpi.warn b{color:var(--wn)}.kpi.crit b{color:var(--bad)}.kpi.review b{color:var(--rv)}.ringcard{display:flex;gap:12px;align-items:center}.ringcard small{color:var(--mu)}
.ring{width:64px;height:64px;border-radius:50%;background:conic-gradient(var(--ok) calc(var(--p)*1%),var(--bd) 0);display:grid;place-items:center;position:relative}
.ring:before{content:"";position:absolute;inset:7px;background:var(--sf);border-radius:50%}.ring b{position:relative;font-size:15px}
.row{display:flex;gap:16px;padding:12px 0;border-top:1px solid var(--bd);flex-wrap:wrap}.row:first-of-type{border-top:0}.who{min-width:210px}.who small,td small,.alert small{display:block;color:var(--mu)}
.chips{display:flex;gap:8px;flex-wrap:wrap;flex:1}.chip{display:flex;flex-direction:column;gap:3px;background:var(--bg);border-radius:8px;padding:6px 10px}.chip small{color:var(--mu);font-size:11px}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.valid{background:var(--okb);color:var(--ok)}.expiring{background:var(--wnb);color:var(--wn)}.review{background:var(--rvb);color:var(--rv)}.expired,.invalid,.missing{background:var(--badb);color:var(--bad)}
.badge.missing{background:var(--nub);color:var(--nu)}.alert{padding:10px 12px;border-left:4px solid;border-radius:6px;background:var(--bg);margin:6px 0}.alert.warn{border-color:var(--wn)}.alert.critical{border-color:var(--bad)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th{font-size:12px;color:var(--mu);text-transform:uppercase;letter-spacing:.04em}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--bd);vertical-align:top}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px}.acts{white-space:nowrap}.detail td{background:var(--bg)}.detail ul{margin:6px 0 10px;padding-left:4px;list-style:none}.yes{color:var(--ok)}.no{color:var(--bad)}
.score{font-weight:700}.score.strong{color:var(--ok)}.score.partial{color:var(--wn)}.score.weak{color:var(--bad)}.empty{color:var(--mu);text-align:center;padding:18px}
.filters{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin-bottom:12px}input,select{font:inherit;padding:9px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--sf);color:var(--tx);width:100%}
input:focus,select:focus{outline:2px solid var(--ac);outline-offset:-1px}.fld{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}.fld>span{font-size:12px;font-weight:600;color:var(--mu)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.btn{font:inherit;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid var(--bd);cursor:pointer;background:var(--sf);color:var(--tx)}.btn.primary{background:var(--ac);color:#fff;border-color:var(--ac);padding:10px 18px}
.btn.primary:disabled{opacity:.5;cursor:wait}.btn.ghost{padding:5px 10px;font-size:13px;font-weight:500}aside .btn{background:#ffffff10;color:#C9D6EA;border-color:#ffffff22}.danger{color:var(--bad)}
.drop{display:flex;flex-direction:column;gap:6px;align-items:center;text-align:center;border:2px dashed var(--bd);border-radius:12px;padding:34px 16px;cursor:pointer;background:var(--bg)}.drop:hover{border-color:var(--ac)}.drop small{color:var(--mu)}.drop input{margin-top:10px}
.note{margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--bg)}.note.ok{background:var(--okb);color:var(--ok)}.note.bad{background:var(--badb);color:var(--bad)}.tag{background:var(--sf);color:var(--tx);border-radius:6px;padding:2px 8px;font-size:12px;margin-top:6px}
.bar{height:8px;width:120px;background:var(--bd);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--ok)}.log{display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--bd);font-size:13px}.log time{color:var(--mu);min-width:150px}.log b{min-width:110px}
.toast{position:fixed;right:20px;bottom:20px;background:var(--nav);color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 8px 24px #0004;max-width:420px;cursor:pointer;z-index:9;border-left:4px solid var(--ok)}.toast.bad{border-color:var(--bad)}
@media(max-width:860px){.shell{grid-template-columns:1fr}aside{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;padding:10px}nav{flex-direction:row;overflow-x:auto;flex:1 1 100%;order:3}.side-foot{flex-direction:row}
main{padding:16px}.grid2,.filters{grid-template-columns:1fr}}`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DocCertified</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div id="root"></div>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/htm@3.1.1/dist/htm.umd.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script>${[pad, findDates, detectFields].map(String).join('\n')}
(${client})()</script></body></html>`;

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
