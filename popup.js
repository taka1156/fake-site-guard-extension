const $ = (s) => document.querySelector(s);
const state = { rules: [], trusted: [], sourceUrl: '', lastFetched: '' };

async function load() {
  const d = await chrome.storage.local.get(['rules', 'trusted', 'sourceUrl', 'lastFetched']);
  state.rules = d.rules || [];
  state.trusted = d.trusted || [];
  state.sourceUrl = d.sourceUrl || '';
  state.lastFetched = d.lastFetched || '';
}
async function save() {
  await chrome.storage.local.set({
    rules: state.rules, trusted: state.trusted, sourceUrl: state.sourceUrl, lastFetched: state.lastFetched
  });
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  children.flat().forEach((c) => e.append(c));
  return e;
}

/* ---------- タブ ---------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    ['now', 'rules', 'io'].forEach((n) => { $('#tab-' + n).hidden = n !== btn.dataset.tab; });
  });
});
function showTab(name) { document.querySelector(`.tab[data-tab="${name}"]`).click(); }

/* ---------- 現在のサイト ---------- */
async function renderNow() {
  const box = $('#nowStatus');
  box.replaceChildren();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = tab && tab.url ? parseHost(tab.url) : null;

  if (!host) {
    box.append(el('div', { className: 'status neutral', textContent: 'このページは判定の対象外です。' }));
    return;
  }

  // ユーザーが「正しい」と登録済みのサイト
  const trustedEntry = state.trusted.find((t) => t.host === host);
  if (trustedEntry) {
    box.append(el('div', { className: 'status ok' },
      el('div', { className: 'title', textContent: '✓ あなたが「正しいサイト」として登録済みです' }),
      el('div', { className: 'host', textContent: host }),
      el('div', { className: 'hint', textContent: `登録日 ${trustedEntry.date}` }),
      el('button', { className: 'small', textContent: '登録を解除する', onclick: async () => {
        state.trusted = state.trusted.filter((t) => t.host !== host);
        await save(); renderAll();
      } })));
    return;
  }

  const matches = matchUrl(tab.url, state.rules, state.trusted);
  if (!matches.length) {
    const exact = state.rules.find((r) => r.legitimateDomain === host);
    box.append(el('div', { className: 'status ok' },
      el('div', { className: 'title', textContent: exact ? '✓ 登録済みの正規ドメインです' : '類似パターンは見つかりませんでした' }),
      el('div', { className: 'host', textContent: host })));
    return;
  }
  const wrap = el('div', { className: 'status warn' },
    el('div', { className: 'title', textContent: '⚠ 似ているサイトがあります' }),
    el('div', {}, '今見ているのは ', el('span', { className: 'host', textContent: host }), ' です。'));
  const seen = new Set();
  matches.forEach((m) => {
    if (seen.has(m.legitimateDomain)) return;
    seen.add(m.legitimateDomain);
    wrap.append(el('div', { className: 'legit' },
      'もしかして ', el('b', { textContent: m.legitimateDomain }), ' と勘違いしていませんか?',
      m.category ? el('span', { className: 'tag', textContent: m.category }) : ''));
  });
  wrap.append(el('div', { className: 'trust-box' },
    el('button', { className: 'small', textContent: 'このサイトは正しい(登録して今後は警告しない)', onclick: async () => {
      const res = buildTrustedFromUrl(tab.url, matches);
      if (res.error) { alert(res.error); return; }
      const ok = confirm(
        `「${res.trusted.host}」を正しいサイトとして登録します。\n` +
        `今後このホスト名では警告されません。\n\n` +
        `本当に ${res.trusted.similarTo.join(', ')} とは別の、信頼できるサイトですか?`);
      if (!ok) return;
      state.trusted = mergeTrusted(state.trusted, [res.trusted]);
      await save(); renderAll();
    } }),
    el('div', { className: 'hint', textContent: 'URLからホスト名を取り出して登録します(完全一致のみ)。' })));
  box.append(wrap);
}

/* ---------- 古さアラート ---------- */
function renderStaleBanner() {
  const n = state.rules.filter((r) => isStale(r)).length;
  const b = $('#staleBanner');
  b.hidden = n === 0;
  if (n) {
    b.replaceChildren(`${n}件のルールが${STALE_MONTHS}ヶ月以上確認されていません。 `,
      el('a', { href: '#', textContent: '見直す', onclick: (e) => { e.preventDefault(); showTab('rules'); } }));
  }
}

/* ---------- ルール一覧 ---------- */
function renderRules() {
  $('#ruleCount').textContent = state.rules.length ? `(${state.rules.length})` : '';

  const cats = [...new Set(state.rules.map((r) => r.category).filter(Boolean))].sort();
  const sel = $('#catFilter');
  const cur = sel.value || '__all';
  sel.replaceChildren(el('option', { value: '__all', textContent: 'すべてのカテゴリ' }),
    el('option', { value: '__stale', textContent: '⏰ 要確認のみ' }),
    ...cats.map((c) => el('option', { value: c, textContent: c })));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '__all';
  $('#catList').replaceChildren(...cats.map((c) => el('option', { value: c })));

  const f = sel.value;
  const list = state.rules.filter((r) =>
    f === '__all' ? true : f === '__stale' ? isStale(r) : r.category === f);
  const ul = $('#ruleList');
  ul.replaceChildren();
  if (!list.length) { ul.append(el('li', { className: 'empty', textContent: 'ルールがありません' })); return; }

  list.forEach((r) => {
    const stale = isStale(r);
    ul.append(el('li', {},
      el('div', {}, el('code', { textContent: r.pattern })),
      el('div', { className: 'meta' },
        `→ ${r.legitimateDomain}  ｜  ${r.category || '(カテゴリなし)'}  ｜  確認日 ${r.date}`,
        stale ? el('span', { className: 'stale-tag', textContent: '  ⏰要確認' }) : ''),
      r.note ? el('div', { className: 'meta', textContent: r.note }) : '',
      el('div', { className: 'actions' },
        el('button', { className: 'small', textContent: '確認済みにする', onclick: async () => {
          r.date = todayStr(); await save(); renderAll();
        } }),
        el('button', { className: 'small', textContent: '削除', onclick: async () => {
          state.rules = state.rules.filter((x) => x.id !== r.id); await save(); renderAll();
        } }))));
  });
}
/* ---------- 「正しいサイト」として登録したホスト一覧 ---------- */
function renderTrusted() {
  const ul = $('#trustedList');
  $('#trustedCount').textContent = state.trusted.length ? `(${state.trusted.length})` : '';
  ul.replaceChildren();
  if (!state.trusted.length) {
    ul.append(el('li', { className: 'empty', textContent: '登録はありません' }));
    return;
  }
  state.trusted.forEach((t) => {
    const stale = isStale(t);
    ul.append(el('li', {},
      el('div', {}, el('code', { textContent: t.host })),
      el('div', { className: 'meta' },
        `登録日 ${t.date}` + (t.category ? `  ｜  ${t.category}` : '') +
        (t.similarTo.length ? `  ｜  似ていた: ${t.similarTo.join(', ')}` : ''),
        stale ? el('span', { className: 'stale-tag', textContent: '  ⏰要確認' }) : ''),
      el('div', { className: 'actions' },
        el('button', { className: 'small', textContent: '確認済みにする', onclick: async () => {
          t.date = todayStr(); await save(); renderAll();
        } }),
        el('button', { className: 'small', textContent: '解除', onclick: async () => {
          state.trusted = state.trusted.filter((x) => x.host !== t.host); await save(); renderAll();
        } }))));
  });
}

$('#catFilter').addEventListener('change', renderRules);
$('#toggleAdd').addEventListener('click', () => { const f = $('#addForm'); f.hidden = !f.hidden; });
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = normalizeRule({
    pattern: $('#fPattern').value, legitimateDomain: $('#fDomain').value,
    category: $('#fCategory').value, date: $('#fDate').value
  });
  if (res.error) { alert(res.error); return; }
  state.rules = mergeRules(state.rules, [res.rule]);
  await save();
  e.target.reset(); $('#fDate').value = todayStr(); e.target.hidden = true;
  renderAll();
});

/* ---------- 入出力 ---------- */
function msg(text, kind = '') {
  const m = $('#ioMessage'); m.textContent = text; m.className = 'hint ' + kind;
}
async function applyImport(text, label) {
  const { rules, trusted, errors } = parseRulesJson(text);
  if (!rules.length && !trusted.length) { msg(`取り込めるルールがありません。\n${errors.join('\n')}`, 'err'); return false; }
  const replace = $('#replaceMode').checked;
  if (rules.length) state.rules = replace ? rules : mergeRules(state.rules, rules);
  if (trusted.length) state.trusted = replace ? trusted : mergeTrusted(state.trusted, trusted);
  await save();
  renderAll();
  msg(`${label}: ルール${rules.length}件、正しいサイト${trusted.length}件を取り込みました。` +
    (errors.length ? `\nスキップ ${errors.length}件:\n${errors.join('\n')}` : ''), errors.length ? '' : 'ok');
  return true;
}

$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([buildExport(state.rules, state.trusted)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `fake-site-rules-${todayStr()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#btnFile').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  await applyImport(await file.text(), file.name);
  e.target.value = '';
});
$('#btnPaste').addEventListener('click', async () => {
  const t = $('#pasteArea').value.trim(); if (!t) return;
  if (await applyImport(t, '貼り付け')) $('#pasteArea').value = '';
});

async function fetchFromUrl(url) {
  let origin;
  try { origin = new URL(url).origin; } catch (e) { msg('URLが不正です。', 'err'); return; }
  // ユーザー操作の直後に権限リクエスト(そのサイトにだけアクセス許可を求める)
  const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
  if (!granted) { msg('このURLへのアクセスが許可されませんでした。', 'err'); return; }
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ok = await applyImport(await res.text(), 'URL');
    if (ok) {
      state.sourceUrl = url; state.lastFetched = todayStr(); await save(); renderSource();
    }
  } catch (e) { msg('取得に失敗しました: ' + e.message, 'err'); }
}
$('#btnUrl').addEventListener('click', () => {
  const url = $('#urlInput').value.trim(); if (url) fetchFromUrl(url);
});
function renderSource() {
  $('#urlInput').value = state.sourceUrl;
  $('#sourceInfo').textContent = state.sourceUrl ? `最終取込: ${state.lastFetched || '-'}(同じURLで「取込」を押すと再取得)` : '';
}

/* ---------- 起動 ---------- */
function renderAll() { renderStaleBanner(); renderRules(); renderTrusted(); renderNow(); }
(async () => {
  await load();
  $('#fDate').value = todayStr();
  renderSource();
  renderAll();
})();
