// PayQA dashboard
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BUG_NAMES = {
  'amount-mismatch': 'Wrong amount sent to PayPal',
  'false-success': 'Failed payments shown as success',
  'paid-before-capture': 'Marked paid before PayPal confirms',
  'no-idempotency': 'Retries record payment twice',
  'input-validation': 'Invalid carts accepted',
  'checkout-broken': 'Checkout does not complete',
  inventory: 'Stock count goes wrong',
};
const MODE_NAMES = { chaos: 'Chaos', browser: 'Browser', full: 'Full' };
const GROUP_NAMES = { chaos: 'Payment failures (API)', browser: 'Customer journey (browser)' };
const ICONS = { passed: '✓', failed: '✕', error: '!', skipped: '–' };

let currentRunId = null;
let pollTimer = null;
const openScenarios = new Set();
const printed = new Set();
let stampShownFor = null;

// ---------- helpers ----------
const fmtTime = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtDate = (iso) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const scoreClass = (s) => (s >= 90 ? 'high' : s >= 60 ? 'mid' : 'low');
const isActive = (run) => run && (run.status === 'running' || run.status === 'analyzing');

function showNote(msg) {
  const el = $('form-note');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function showError(msg) {
  const el = $('form-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------- receipt ----------
function renderReceipt(run) {
  const body = $('receipt-body');
  if (!run) {
    body.innerHTML = '<p class="r-title">PayQA test receipt</p><p class="r-muted">Waiting for a run</p>';
    return;
  }

  const lines = (run.results || [])
    .map((r) => {
      const key = `${run.id}:${r.mode || ''}:${r.id}`;
      const done = ['passed', 'failed', 'error', 'skipped'].includes(r.status);
      const fresh = done && !printed.has(key);
      if (done) printed.add(key);
      const val =
        r.status === 'passed' ? '<span class="val pass">PASS</span>'
        : r.status === 'failed' ? '<span class="val fail">FAIL</span>'
        : r.status === 'error' ? '<span class="val err">ERROR</span>'
        : r.status === 'skipped' ? '<span class="val skip">SKIP</span>'
        : r.status === 'running' ? '<span class="val wait">testing…</span>'
        : '<span class="val wait">-</span>';
      return `<div class="r-line${fresh ? ' printed' : ''}"><span class="name">${esc(r.title)}</span>${val}</div>`;
    })
    .join('');

  let footer = '';
  if (run.status === 'error') {
    footer = `<hr class="r-rule" /><p class="r-muted">Run stopped</p>`;
  } else if (run.summary) {
    const s = run.summary;
    const tested = s.checksTotal > 0;
    const ready = tested && s.failed === 0 && s.errors === 0;
    const landed = stampShownFor !== run.id;
    stampShownFor = run.id;
    const bugs = s.bugsFound.length
      ? `<ul class="r-bugs">${s.bugsFound.map((b) => `<li>${esc(BUG_NAMES[b] || b)}</li>`).join('')}</ul>`
      : '';
    footer = `
      <hr class="r-rule" />
      <div class="r-line"><span class="name">Scenarios passed</span><span class="val">${s.passed}/${s.scenarios}</span></div>
      <div class="r-line"><span class="name">Checks passed</span><span class="val">${s.checksPassed}/${s.checksTotal}</span></div>
      <hr class="r-rule" />
      <div class="r-total"><span>Readiness</span><strong>${tested ? s.score : '–'}<small>/100</small></strong></div>
      ${bugs}
      ${tested
        ? `<div class="stamp ${ready ? 'yes' : 'no'}${landed ? ' landed' : ''}">${ready ? 'Cleared for go-live' : 'Not ready to go live'}</div>`
        : '<p class="r-muted">Nothing was tested</p>'}`;
  } else {
    footer = `<hr class="r-rule" /><p class="r-muted">${run.status === 'analyzing' ? 'Totalling up…' : 'Running…'}</p>`;
  }

  body.innerHTML = `
    <p class="r-title">PayQA test receipt</p>
    <p class="r-meta">${esc(run.storeUrl)}<br />${esc(MODE_NAMES[run.mode] || run.mode)} run · ${esc(fmtDate(run.createdAt))}</p>
    <hr class="r-rule" />
    ${lines || '<p class="r-muted">Preparing…</p>'}
    ${footer}`;
}

// ---------- scenarios ----------
function renderCheck(c) {
  if (c.passed) {
    return `<div class="check ok"><span class="mark">✓</span><div class="c-title">${esc(c.title)}</div></div>`;
  }
  return `<div class="check bad"><span class="mark">✕</span><div>
      <div class="c-title">${esc(c.title)}</div>
      <div class="ea">
        <div><b>Expected</b>${esc(c.expected)}</div>
        <div class="actual"><b>Actual</b>${esc(c.actual)}</div>
      </div></div></div>`;
}

function renderScenario(r, runId) {
  const key = `${r.mode || ''}:${r.id}`;
  const open = openScenarios.has(key) ? ' open' : '';
  const shot = r.evidence?.screenshot
    ? `<a class="shot" href="/screenshots/${encodeURIComponent(r.evidence.screenshot)}" target="_blank" rel="noopener">
         <img src="/screenshots/${encodeURIComponent(r.evidence.screenshot)}" alt="Screenshot of the store during ${esc(r.title)}" loading="lazy" />
         <span>Open full screenshot</span></a>`
    : '';
  const body =
    r.status === 'error'
      ? `<p class="s-error">This scenario couldn't finish: ${esc(r.error)}</p>`
      : r.status === 'skipped'
        ? `<p class="s-skip">Skipped: ${esc(r.skipReason)}</p>`
        : r.checks.map(renderCheck).join('');

  return `<details class="scenario" data-key="${esc(key)}"${open}>
    <summary>
      <span class="dot ${r.status}" aria-label="${r.status}">${ICONS[r.status] || ''}</span>
      <span><span class="s-title">${esc(r.title)}</span><br /><span class="s-meta">${esc(r.category)}</span></span>
      <span class="s-time">${fmtTime(r.durationMs)}</span>
    </summary>
    <div class="s-body">
      <p class="s-desc">${esc(r.description)}</p>
      ${['pending', 'running'].includes(r.status) ? '' : body}
      ${shot}
    </div>
  </details>`;
}

function renderScenarios(run) {
  const results = run?.results || [];
  if (run?.status === 'error' && !results.length) {
    $('scenarios').innerHTML = `<p class="s-error">${esc(run.error)}</p>`;
    return;
  }
  const groups = {};
  for (const r of results) (groups[r.mode || run.mode] ||= []).push(r);
  $('scenarios').innerHTML = Object.entries(groups)
    .map(
      ([mode, list]) =>
        `${Object.keys(groups).length > 1 || mode ? `<h3 class="group-title">${esc(GROUP_NAMES[mode] || mode)}</h3>` : ''}
         ${list.map((r) => renderScenario(r, run.id)).join('')}`
    )
    .join('');
  if (run?.status === 'error' && run.error) {
    $('scenarios').insertAdjacentHTML('afterbegin', `<p class="s-error">${esc(run.error)}</p>`);
  }
}

$('scenarios').addEventListener(
  'toggle',
  (e) => {
    const key = e.target.dataset?.key;
    if (!key) return;
    e.target.open ? openScenarios.add(key) : openScenarios.delete(key);
  },
  true
);

// ---------- AI analysis ----------
function renderAnalysis(run) {
  const el = $('analysis');
  const a = run?.analysis;
  if (!a || a.error) {
    el.hidden = true;
    return;
  }
  const issues = a.issues
    .map(
      (i) => `<article class="issue ${i.severity}">
        <span class="sev">${esc(i.severity[0].toUpperCase() + i.severity.slice(1))}</span>
        <h3>${esc(i.title)}</h3>
        <p>${esc(i.explanation)}</p>
        <p class="impact">${esc(i.impact)}</p>
        ${i.fix ? `<pre><code>${esc(i.fix)}</code></pre>` : ''}
        <p class="seen-in">Seen in: ${i.scenarios.map(esc).join(', ')}</p>
      </article>`
    )
    .join('');
  el.innerHTML = `
    <div class="analysis-head">
      <h2>${a.ready ? 'Ready to go live' : a.issues.length ? 'What to fix' : 'Result'}</h2>
      ${a.source === 'claude' ? '<span class="badge ai">PayQA AI · powered by Claude</span>'
        : a.source === 'preview' ? '<span class="badge">Built-in explanations</span>' : ''}
    </div>
    <p class="analysis-summary">${esc(a.summary)}</p>
    ${issues}`;
  el.hidden = false;
}

// ---------- history ----------
async function loadHistory() {
  const runs = await fetch('/api/runs').then((r) => r.json());
  $('history-count').textContent = runs.length ? `(${runs.length})` : '';
  if (!runs.length) {
    $('history').innerHTML = '<p class="r-muted" style="text-align:left">No runs yet.</p>';
    return runs;
  }
  $('history').innerHTML = `<table>
    <thead><tr><th>When</th><th>Mode</th><th>Store</th><th>Score</th><th>Result</th></tr></thead>
    <tbody>${runs
      .map((r) => {
        const s = r.summary;
        const result = isActive(r) ? 'Running…'
          : r.status === 'error' ? 'Stopped'
          : !s.checksTotal ? 'Nothing tested'
          : s.failed + s.errors === 0 ? 'Cleared'
          : `${s.failed + s.errors} failing`;
        return `<tr class="row${r.id === currentRunId ? ' active' : ''}" data-id="${esc(r.id)}" tabindex="0">
          <td>${esc(fmtDate(r.createdAt))}</td>
          <td>${esc(MODE_NAMES[r.mode] || r.mode)}</td>
          <td>${esc(r.storeUrl)}</td>
          <td>${s?.checksTotal ? `<span class="score-chip ${scoreClass(s.score)}">${s.score}</span>` : '-'}</td>
          <td>${esc(result)}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  return runs;
}

$('history').addEventListener('click', (e) => {
  const row = e.target.closest('tr.row');
  if (row) {
    showRun(row.dataset.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
$('history').addEventListener('keydown', (e) => {
  const row = e.target.closest('tr.row');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    showRun(row.dataset.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// ---------- run lifecycle ----------
function render(run) {
  $('empty').hidden = Boolean(run);
  $('results-bar').hidden = !run;
  $('clear-btn').disabled = isActive(run);
  $('clear-btn').title = isActive(run) ? 'Wait for the run to finish' : '';
  renderReceipt(run);
  renderScenarios(run);
  renderAnalysis(run);
  $('run-btn').disabled = isActive(run);
  $('run-btn').textContent = isActive(run) ? 'Running tests…' : 'Run tests';
}

async function showRun(id) {
  clearTimeout(pollTimer);
  currentRunId = id;
  openScenarios.clear();
  const run = await fetch(`/api/runs/${id}`).then((r) => r.json());
  // an old run is shown fully printed, without replaying the animations
  if (!isActive(run)) {
    for (const r of run.results || []) printed.add(`${run.id}:${r.mode || ''}:${r.id}`);
    stampShownFor = run.id;
  }
  render(run);
  loadHistory();
  if (isActive(run)) poll(id);
}

async function poll(id) {
  const run = await fetch(`/api/runs/${id}`).then((r) => r.json());
  if (id !== currentRunId) return;
  render(run);
  if (isActive(run)) {
    pollTimer = setTimeout(() => poll(id), 1000);
  } else {
    loadHistory();
  }
}

$('run-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const storeUrl = $('store-url').value.trim();
  const storeToken = $('store-token').value.trim() || undefined;
  const mode = new FormData(e.target).get('mode');

  $('run-btn').disabled = true;
  $('run-btn').textContent = 'Checking store…';
  // a sleeping free-tier store can take up to a minute to wake up
  const slow = setTimeout(() => showNote('Waking up the store. On free hosting this can take up to a minute…'), 4000);
  const check = await fetch('/api/store-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeUrl, storeToken }),
  }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Lost connection to PayQA. Refresh the page and try again.' }));
  clearTimeout(slow);
  showNote('');
  if (!check.ok) {
    showError(check.error);
    $('run-btn').disabled = false;
    $('run-btn').textContent = 'Run tests';
    return;
  }

  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, storeUrl, storeToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    showError(data.error);
    $('run-btn').disabled = false;
    $('run-btn').textContent = 'Run tests';
    return;
  }
  openScenarios.clear();
  currentRunId = data.id;
  loadHistory();
  poll(data.id);
});

// ---------- quick-pick stores ----------
function renderQuickPicks(stores) {
  const box = $('quick-picks');
  box.innerHTML = stores
    .map((st, i) => `<button type="button" data-i="${i}" aria-pressed="false">${esc(st.label)}</button>`)
    .join('');
  const sync = () => {
    for (const b of box.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(stores[b.dataset.i].url === $('store-url').value.trim()));
    }
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const st = stores[b.dataset.i];
    $('store-url').value = st.url;
    $('store-token').value = st.token || '';
    document.querySelector('.token').open = Boolean(st.token);
    showError('');
    sync();
  });
  $('store-url').addEventListener('input', sync);
  sync();
}

// ---------- clear ----------
function clearResults() {
  clearTimeout(pollTimer);
  currentRunId = null;
  openScenarios.clear();
  showError('');
  render(null);
  loadHistory();
}
$('clear-btn').addEventListener('click', clearResults);

// ---------- start ----------
(async function init() {
  const config = await fetch('/api/config').then((r) => r.json());
  $('store-url').value = config.defaultStoreUrl;
  renderQuickPicks(config.stores || []);
  fetch('/api/warmup', { method: 'POST' }).catch(() => {}); // start waking sleeping demo stores

  // Hosted demo: Browser Mode needs a full Chrome, so it's local only
  if (config.browserMode === false) {
    for (const input of document.querySelectorAll('input[name=mode]')) {
      if (input.value === 'chaos') continue;
      input.disabled = true;
      input.closest('label').classList.add('off');
      input.closest('label').querySelector('small').textContent = 'Runs locally only';
    }
  }
  if (config.lockedStores) {
    $('store-url').readOnly = true;
    document.querySelector('.token').hidden = true;
  }
  // Every visit starts fresh. Only a run that's still in progress is picked up again.
  const runs = await loadHistory();
  const active = runs.find(isActive);
  if (active) showRun(active.id);
  else render(null);
})();
