// background.js / popup.js 共通ロジック
const STALE_MONTHS = 6;
const DEFAULT_TITLE = 'Fake Site Guard';

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return 'r' + (h >>> 0).toString(36);
}

// ルール1件を検証・正規化。エラーなら { error } を返す
function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'オブジェクトではありません' };
  const pattern = String(raw.pattern ?? '').trim();
  const legit = String(raw.legitimateDomain ?? '').trim().toLowerCase();
  const date = String(raw.date ?? '').trim();
  const category = String(raw.category ?? '').trim();
  if (!pattern) return { error: 'pattern が空です' };
  try { new RegExp(pattern, 'i'); } catch (e) { return { error: `正規表現が不正: ${pattern}` }; }
  if (!legit) return { error: 'legitimateDomain が空です' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
    return { error: `date は YYYY-MM-DD 形式にしてください: ${date}` };
  }
  return {
    rule: {
      id: String(raw.id || simpleHash(pattern + '|' + legit)),
      pattern,
      legitimateDomain: legit,
      date,
      category,
      note: raw.note ? String(raw.note) : ''
    }
  };
}

// URL をパースして http(s) のホスト名(小文字・punycode)を返す。対象外なら null
function parseHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase() || null;
  } catch (e) { return null; }
}

// 「ユーザーが正しいと登録したサイト」1件を検証・正規化
// { host, date, category, similarTo, note }
function normalizeTrusted(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'オブジェクトではありません' };
  // host か url のどちらでも受け付け、ホスト名にパースして保存する
  const host = String(raw.host ?? '').includes('/') || !raw.host
    ? parseHost(String(raw.url ?? raw.host ?? ''))
    : String(raw.host).trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return { error: `ホスト名を取得できません: ${raw.host ?? raw.url ?? ''}` };
  const date = String(raw.date ?? todayStr()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
    return { error: `date は YYYY-MM-DD 形式にしてください: ${date}` };
  }
  return {
    trusted: {
      host,
      date,
      category: String(raw.category ?? '').trim(),
      similarTo: Array.isArray(raw.similarTo) ? raw.similarTo.map(String) : [],
      note: raw.note ? String(raw.note) : ''
    }
  };
}

// 現在の URL を「正しいサイト」として登録する情報を作る(類似していた正解ドメインも控える)
function buildTrustedFromUrl(url, matches) {
  const host = parseHost(url);
  if (!host) return { error: 'このURLは登録できません(http/https のみ)' };
  const similarTo = [...new Set((matches || []).map((m) => m.legitimateDomain))];
  const category = (matches || []).find((m) => m.category)?.category || '';
  return normalizeTrusted({ host, date: todayStr(), category, similarTo, note: '' });
}

// JSON文字列 → { rules, trusted, errors }。{rules:[...], trusted:[...]} でも [...] でもOK
function parseRulesJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { rules: [], trusted: [], errors: ['JSONとして読み込めません: ' + e.message] }; }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : null;
  const tlist = data && !Array.isArray(data) && Array.isArray(data.trusted) ? data.trusted : [];
  if (!list && !tlist.length) return { rules: [], trusted: [], errors: ['rules 配列が見つかりません'] };
  const rules = [], trusted = [], errors = [];
  (list || []).forEach((r, i) => {
    const res = normalizeRule(r);
    if (res.error) errors.push(`#${i + 1}: ${res.error}`);
    else rules.push(res.rule);
  });
  tlist.forEach((t, i) => {
    const res = normalizeTrusted(t);
    if (res.error) errors.push(`trusted #${i + 1}: ${res.error}`);
    else trusted.push(res.trusted);
  });
  return { rules, trusted, errors };
}

function buildExport(rules, trusted = []) {
  return JSON.stringify({ version: 1, exported: todayStr(), rules, trusted }, null, 2);
}

// id が同じものは上書き、それ以外は追加
function mergeRules(current, incoming) {
  const map = new Map(current.map((r) => [r.id, r]));
  incoming.forEach((r) => map.set(r.id, r));
  return [...map.values()];
}

// ホスト名が同じものは上書き、それ以外は追加
function mergeTrusted(current, incoming) {
  const map = new Map(current.map((t) => [t.host, t]));
  incoming.forEach((t) => map.set(t.host, t));
  return [...map.values()];
}

function isStale(rule, now = new Date()) {
  const d = new Date(rule.date + 'T00:00:00');
  d.setMonth(d.getMonth() + STALE_MONTHS);
  return d.getTime() <= now.getTime();
}

const _reCache = new Map();
function getRegex(pattern) {
  if (!_reCache.has(pattern)) {
    try { _reCache.set(pattern, new RegExp(pattern, 'i')); } catch (e) { _reCache.set(pattern, null); }
  }
  return _reCache.get(pattern);
}

// URL に対してマッチするルールを返す。
// ホスト名がルールの正解ドメイン、またはユーザーが「正しい」と登録したホスト名と
// 完全一致する場合は正規サイトとして除外。
function matchUrl(url, rules, trusted = []) {
  const host = parseHost(url);
  if (!host) return [];
  if (trusted.some((t) => t.host === host)) return [];
  if (rules.some((r) => r.legitimateDomain === host)) return [];
  return rules.filter((r) => {
    const re = getRegex(r.pattern);
    return re && re.test(host);
  });
}
