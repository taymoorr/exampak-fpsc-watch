// FPSC watcher for ExamPak. No AI. Runs in GitHub Actions every 10 minutes (see .github/workflows/watch.yml).
//
// It opens the FPSC pages that matter to General Recruitment candidates, lists every document on them, works out what
// each document is from the page it sits on and from its file name, and tells exampak.com about anything new.
//
//   node watch.mjs            normal run: report new documents to ExamPak, then remember them in state.json
//   node watch.mjs --dry      look and print, change nothing, send nothing
//   node watch.mjs --seed     remember everything on the pages now, send nothing (the first run does this by itself)
//
// A new file is not always a new event: FPSC sometimes re-uploads old lists under new file numbers. So documents are
// grouped by (type, case, year). A new group is a new event; a new file in a known group is a "repeat" (re-upload or
// correction), which ExamPak records but does not alert on.
//
// Environment: EXAMPAK_KEY (GitHub secret) is the password for https://exampak.com/api/fpsc-event.
// NODE_EXTRA_CA_CERTS points at fpsc-intermediate.pem: FPSC's server forgets to send its intermediate certificate,
// so without it a client that checks certificates cannot connect. Certificate checking stays ON.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const STATE = join(here, 'state.json');
const BASE = 'https://www.fpsc.gov.pk';
const ENDPOINT = 'https://exampak.com/api/fpsc-event';
const CHECK_ENDPOINT = 'https://exampak.com/api/fpsc-check';

// Section pages. `type` is what a document there means; Short Listing is split further by file name (see typeOf).
const PAGES = [
  { key: 'jobs', label: 'Jobs, GR', url: '/Jobs?section=GR', mode: 'jobs', type: 'job' },
  { key: 'syllabus', label: 'Syllabus, GR', url: '/Syllabuses?section=GR%20Syllabus', type: 'syllabus' },
  { key: 'merit', label: 'Merit lists', url: '/Results?section=Merit%20List', type: 'merit' },
  { key: 'short', label: 'Shortlisting', url: '/Results?section=Short%20Listing', type: 'short' },
  { key: 'docs', label: 'Documents required', url: '/Results?section=Documents%20Required', type: 'docs' },
  { key: 'failure', label: 'Failure cases', url: '/Results?section=Failure%20Cases', type: 'failure' },
  { key: 'nominations', label: 'Nominations', url: '/Results?section=Nominations', type: 'final' },
  { key: 'written', label: 'Written results', url: '/Results?section=Written%20Result', type: 'written' },
  { key: 'finalres', label: 'Final results', url: '/Results?section=Final%20Result', type: 'final-result' },
  { key: 'keys', label: 'Answer keys', url: '/Results?section=Answer%20Keys', type: 'answer-key' },
  { key: 'exams', label: 'Test schedules and notices, GR', url: '/Schedule?section=Exams%2FGR', type: 'exam-notice' },
  { key: 'interviews', label: 'Interview programmes, GR', url: '/Schedule?section=Interviews%2FGR%2FGR+Interview+Programme', type: 'interview' },
  { key: 'home', label: 'Home page notices', url: '/', type: 'home-notice' },
  { key: 'tende', label: 'Public notices', url: '/tende', type: 'public-notice' },
];

const args = new Set(process.argv.slice(2));
const dry = args.has('--dry');
let seed = args.has('--seed');

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE = new RegExp(`^(${MONTHS}) \\d{1,2}, \\d{4}$`);
const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .split('|').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const iso = (d) => {
  const m = new RegExp(`^(${MONTHS}) (\\d{1,2}), (\\d{4})$`).exec(d || '');
  return m ? `${m[3]}-${String(MONTHS.split('|').indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
};

async function get(url) {
  const res = await fetch(BASE + url, { headers: { 'User-Agent': 'Mozilla/5.0 (ExamPak FPSC watcher; hello@exampak.com)' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Every document link on a page, with its title and the date printed above it. */
function pdfItems(raw) {
  const html = raw.replace(/\\+"/g, '"').replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&');
  const items = [];
  let last = 0;
  let date = '';
  for (const m of html.matchAll(/<a\b[^>]*href="((?:https:\/\/www\.fpsc\.gov\.pk)?\/uploads\/[^"]+?\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const between = html.slice(last, m.index);
    last = m.index + m[0].length;
    const d = [...textOf(between)].reverse().find((s) => DATE.test(s)) ?? between.match(/"uploadDate":"(\d{4}-\d{2}-\d{2})"/)?.[1];
    if (d) date = d;
    const href = m[1].startsWith('http') ? m[1] : BASE + m[1];
    const file = decodeURIComponent(href.split('/').pop()).replace(/^\d+_/, '');
    const own = textOf(m[2]).join(' ');
    const jsonTitle = [...between.matchAll(/"title":"([^"]+)"/g)].pop()?.[1];
    const near = textOf(between).filter((s) => !DATE.test(s) && !s.startsWith('{') && !s.includes('":')).pop();
    const title = jsonTitle ?? (own && own !== file && own !== 'Click here' ? own : near ?? '');
    if (items.some((x) => x.url === href)) continue;
    items.push({ url: href, file, title: title === file ? '' : title, date });
  }
  return items;
}

/** The ads under Jobs: FPSC sends them as data inside the page. An empty list is normal ("No active Jobs"). */
function jobItems(html) {
  const m = html.match(/\\"initialJobs\\":(\[.*?\])\}\]\]/);
  if (!m) {
    if (/No active Jobs available/i.test(html)) return [];
    throw new Error('could not find the list of jobs on the page');
  }
  const list = JSON.parse(JSON.parse('"' + m[1] + '"'));
  // FPSC gives an ad no address of its own: the PDF link is inside its description. Without a real fpsc.gov.pk address the Worker rejects the
  // event (that is how Ad 4/2026 went unnoticed on 6 Nov 2026), so fall back to the Jobs page itself.
  const pdf = (j) => { const h = String(j.description ?? '').match(/href="([^"]*\/uploads\/[^"]+\.pdf)"/i)?.[1]; return h ? (h.startsWith('http') ? h : BASE + h) : ''; };
  return list.map((j) => ({ url: j.url ? (j.url.startsWith('http') ? j.url : BASE + j.url) : pdf(j) || `${BASE}/Jobs?section=GR`, file: `job-${j.id}`, title: j.title ?? j.name ?? '', date: j.date ?? '' }));
}

/** Case number, optional letter (135A) and year from a title or file name: F.4-156-2026-R-..., F4_3_2026 Post, Interview_Program_164_2026. */
function caseOf(s) {
  let m = /F[\s_.-]*4[\s_-]*(\d{1,3})([A-Z])?[\s_/-]+(\d{4})/i.exec(s);
  if (m) return { id: String(Number(m[1])), letter: (m[2] || '').toUpperCase(), year: m[3] };
  m = /Interview[\s_]*Prog(?:ram|ramme)?[\s_.-]*(?:No\.?)?[\s_-]*(\d{1,3})([A-Z])?[\s_/-]+(\d{4})/i.exec(s);
  if (m) return { id: String(Number(m[1])), letter: (m[2] || '').toUpperCase(), year: m[3] };
  return null;
}

/** What a document is. Short Listing holds three kinds, told apart by the code at the end of the file name. */
function typeOf(page, file) {
  if (page.key !== 'short') return page.type;
  if (/-R(PS|PH)\.pdf$/i.test(file)) return 'hearing-decision';
  if (/-PS\.pdf$/i.test(file)) return 'prelim-short';
  return 'short';
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { version: 1, groups: {} };
if (!Object.keys(state.groups).length) seed = true;

const events = [];
const problems = [];
const counts = {};

for (const page of PAGES) {
  let items;
  try {
    const html = await get(page.url);
    items = page.mode === 'jobs' ? jobItems(html) : pdfItems(html);
  } catch (e) {
    problems.push(`${page.label}: could not read the page (${e.message})`);
    continue;
  }
  counts[page.key] = items.length;
  const known = state.pages?.[page.key] ?? 0;
  // A page that held many documents and now shows none has probably changed its layout.
  if (!items.length && known >= 5) problems.push(`${page.label}: no documents found (had ${known}), the page layout may have changed`);

  for (const it of items) {
    const type = typeOf(page, it.file);
    const c = caseOf(`${it.file} ${it.title}`);
    const listed = iso(it.date) || (/^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : '');
    // Hearing decisions are one letter per candidate: group them by case and day so a batch is one event.
    const group = c
      ? `${type}|${c.id}${c.letter}|${c.year}${type === 'hearing-decision' ? '|' + listed : ''}`
      : `${type}|-|${it.file || it.url}`;
    const files = state.groups[group];
    if (files?.includes(it.file)) continue;
    const repeat = !!files && !!c; // known group, new file: re-upload or correction
    events.push({
      group, type, repeat, section: page.label, case: c?.id ?? '', letter: c?.letter ?? '', year: c?.year ?? '',
      title: it.title, file: it.file, url: it.url, listed,
    });
    (state.groups[group] ??= []).push(it.file);
  }
  state.pages = { ...(state.pages ?? {}), [page.key]: items.length };
}

const fresh = events.filter((e) => !e.repeat);
const repeats = events.filter((e) => e.repeat);
console.log(`${Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(' ')}`);
console.log(seed ? `SEED: remembering ${events.length} documents, sending nothing.` : `New: ${fresh.length}. Repeats (re-uploads or corrections): ${repeats.length}. Problems: ${problems.length}.`);
if (seed) console.log('types: ' + Object.entries(events.reduce((h, e) => ((h[e.type] = (h[e.type] || 0) + 1), h), {})).map(([k, n]) => `${k}=${n}`).join(' '));
for (const e of events.slice(0, seed ? 0 : 60)) console.log(`- ${e.repeat ? 'repeat' : 'NEW   '} [${e.type}] case ${e.case || '-'}${e.letter} ${e.listed} ${e.title || e.file}`);
for (const p of problems) console.log(`! ${p}`);

let failed = problems.length > 0 && problems.length >= PAGES.length; // nothing could be read at all
if (!seed && !dry && events.length) {
  const key = process.env.EXAMPAK_KEY;
  // A burst far bigger than a normal day is FPSC reorganising its site, not news: report it as one item.
  const bulk = fresh.length > 40;
  const body = bulk
    ? [{ type: 'bulk', repeat: false, section: 'all', case: '', letter: '', year: '', title: `${fresh.length} new documents at once`, file: '', url: BASE, listed: '' }]
    : events;
  if (!key) {
    console.log('EXAMPAK_KEY is not set: nothing sent, nothing remembered, so the next run will try again.');
    failed = true;
    for (const e of events) state.groups[e.group] = state.groups[e.group].filter((f) => f !== e.file);
  } else if (!dry) {
    try {
      for (let i = 0; i < body.length; i += 25) {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ events: body.slice(i, i + 25).map(({ group, ...e }) => e) }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`ExamPak answered HTTP ${res.status}`);
        const said = await res.json().catch(() => ({}));
        if (said.invalid > 0) { console.log(`! ExamPak refused ${said.invalid} document(s) as invalid: the run is marked failed so it shows red on GitHub.`); failed = true; }
      }
      console.log(`Sent ${body.length} event(s) to ExamPak.`);
    } catch (e) {
      console.log(`! Could not tell ExamPak (${e.message}): nothing remembered, the next run will try again.`);
      failed = true;
      for (const ev of events) state.groups[ev.group] = (state.groups[ev.group] ?? []).filter((f) => f !== ev.file);
    }
  }
}

// Every complete run (all pages read, any news delivered) tells ExamPak the time, so pages show today's "Checked" date
// without a rebuild. A failure here is not fatal: it only means the date waits for the next run.
if (!seed && !dry && !failed && problems.length === 0 && process.env.EXAMPAK_KEY) {
  try {
    const res = await fetch(CHECK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EXAMPAK_KEY}` },
      body: JSON.stringify({ pages: PAGES.length }),
      signal: AbortSignal.timeout(20000),
    });
    console.log(res.ok ? 'Told ExamPak the check time.' : `! ExamPak did not take the check time (HTTP ${res.status}).`);
  } catch (e) { console.log(`! Could not send the check time (${e.message}).`); }
}

if (!dry) {
  for (const g of Object.keys(state.groups)) if (!state.groups[g].length) delete state.groups[g];
  const ordered = { version: 1, pages: state.pages, groups: Object.fromEntries(Object.entries(state.groups).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(STATE, JSON.stringify(ordered) + '\n');
}
if (problems.length) failed = failed || problems.some((p) => /layout may have changed|could not find the list/.test(p));
process.exit(failed ? 1 : 0);
