importScripts('shared.js');

const ALARM_NAME = 'staleCheck';
const NOTIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 通知は最大で週1回

async function getRules() {
  const { rules = [] } = await chrome.storage.local.get('rules');
  return rules;
}
async function getTrusted() {
  const { trusted = [] } = await chrome.storage.local.get('trusted');
  return trusted;
}

// 類似サイトならバッジ「!」だけ出す(ページには何も差し込まない)
async function updateBadge(tabId, url) {
  if (!url) return;
  const [rules, trusted] = await Promise.all([getRules(), getTrusted()]);
  const matches = matchUrl(url, rules, trusted);
  try {
    if (matches.length) {
      const domains = [...new Set(matches.map((m) => m.legitimateDomain))].join(', ');
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' });
      await chrome.action.setTitle({ tabId, title: `類似サイトの可能性があります。正しいドメイン: ${domains}` });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
    }
  } catch (e) { /* タブが閉じられた等は無視 */ }
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) updateBadge(tab.id, tab.url);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') {
    updateBadge(tabId, tab.url);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await chrome.tabs.get(tabId); updateBadge(tabId, tab.url); } catch (e) {}
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.rules || changes.trusted)) refreshActiveTab();
});

// 6ヶ月以上確認されていないルールの通知
async function checkStale() {
  const rules = await getRules();
  const stale = rules.filter((r) => isStale(r));
  if (!stale.length) return;
  const { lastStaleNotified = 0 } = await chrome.storage.local.get('lastStaleNotified');
  if (Date.now() - lastStaleNotified < NOTIFY_INTERVAL_MS) return;
  chrome.notifications.create('stale-rules', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Fake Site Guard',
    message: `${stale.length}件のルールが${STALE_MONTHS}ヶ月以上確認されていません。拡張機能ボタンから見直してください。`,
    priority: 0
  });
  await chrome.storage.local.set({ lastStaleNotified: Date.now() });
}

function setupAlarm() {
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 60 * 24 });
}
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(() => { setupAlarm(); checkStale(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM_NAME) checkStale(); });
