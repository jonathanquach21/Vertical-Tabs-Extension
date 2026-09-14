// background.js — service worker
// Owns: per-window open/closed sidebar state, global settings, custom
// (vertical-tabs-only) tab groups, and sidebar-only tab labels. Talks to the
// native side panel via messages.

const DEFAULT_SETTINGS = {
  position: "right",   // "left" | "right"
  width: 300,
  searchPosition: "bottom", // "top" | "bottom"
  theme: "dark",        // "dark" | "light"
  fontSize: 13,
  fontColor: "",
  showNewTabButton: true,
  showTabTimes: false,
  shortcut: {
    key: "",
    meta: false,
    ctrl: false,
    alt: false,
    shift: false
  }
};

let settings = { ...DEFAULT_SETTINGS };
const IS_INCOGNITO_CONTEXT = chrome.extension?.inIncognitoContext === true;
const CONTEXT_STORAGE_KEY = IS_INCOGNITO_CONTEXT
  ? "verticalTabsStateIncognito"
  : "verticalTabsStateRegular";
let groups = {}; // groupId -> { id, name, color, tabIds: [], collapsed }
let groupOrder = [];
let tabNames = {}; // tabId -> sidebar-only label
let tabCreatedAt = {}; // tabId -> timestamp used for newest/oldest sorting
let layoutOrder = []; // mixed top-level order: tab:<id> and group:<id>
let deletedGroups = []; // most recently deleted custom groups for this context
// Chrome tab IDs are only valid for the current browser session. These
// records let us reconnect saved groups/layout entries to the new IDs Chrome
// assigns when it restores tabs after a restart.
let tabRecords = {}; // stable record key -> { key, tabId, url, title, ... }
// windowId -> active group focus and the original native tab-group snapshot.
// This remains stored until the user chooses "Show all".
let browserFocusSnapshots = {};
const browserFocusQueues = new Map();
const sidebarOpenByWindow = {}; // windowId -> boolean
let persistQueue = Promise.resolve();
let startupReconcileTimer = null;

// ---------- storage ----------
const stateReady = (async function loadState() {
  const stored = await chrome.storage.local.get([
    "settings",
    CONTEXT_STORAGE_KEY,
    // These are retained only as a one-time migration source for the old
    // single shared state format.
    "groups", "groupOrder", "tabNames", "tabCreatedAt",
    "layoutOrder", "deletedGroups", "tabRecords", "browserFocusSnapshots"
  ]);
  if (stored.settings) {
    settings = {
      ...DEFAULT_SETTINGS,
      ...stored.settings,
      shortcut: { ...DEFAULT_SETTINGS.shortcut, ...(stored.settings.shortcut || {}) }
    };
  }
  const scoped = stored[CONTEXT_STORAGE_KEY];
  const legacy = !scoped ? stored : {};
  if (scoped?.groups && typeof scoped.groups === "object") groups = scoped.groups;
  else if (legacy.groups && typeof legacy.groups === "object") groups = legacy.groups;
  groupOrder = Array.isArray(scoped?.groupOrder)
    ? scoped.groupOrder
    : Array.isArray(legacy.groupOrder) ? legacy.groupOrder : Object.keys(groups);
  if (scoped?.tabNames && typeof scoped.tabNames === "object") tabNames = scoped.tabNames;
  else if (legacy.tabNames && typeof legacy.tabNames === "object") tabNames = legacy.tabNames;
  if (scoped?.tabCreatedAt && typeof scoped.tabCreatedAt === "object") tabCreatedAt = scoped.tabCreatedAt;
  else if (legacy.tabCreatedAt && typeof legacy.tabCreatedAt === "object") tabCreatedAt = legacy.tabCreatedAt;
  layoutOrder = Array.isArray(scoped?.layoutOrder)
    ? scoped.layoutOrder
    : Array.isArray(legacy.layoutOrder) ? legacy.layoutOrder : [];
  deletedGroups = Array.isArray(scoped?.deletedGroups)
    ? scoped.deletedGroups
    : Array.isArray(legacy.deletedGroups) ? legacy.deletedGroups : [];
  if (scoped?.tabRecords && typeof scoped.tabRecords === "object") tabRecords = scoped.tabRecords;
  else if (legacy.tabRecords && typeof legacy.tabRecords === "object") tabRecords = legacy.tabRecords;
  if (scoped?.browserFocusSnapshots && typeof scoped.browserFocusSnapshots === "object") {
    browserFocusSnapshots = scoped.browserFocusSnapshots;
  } else if (legacy.browserFocusSnapshots && typeof legacy.browserFocusSnapshots === "object") {
    browserFocusSnapshots = legacy.browserFocusSnapshots;
  }

  // The old build could have put incognito tab IDs into the shared regular
  // state. When migrating that state, keep only tabs visible to this context.
  if (!scoped) {
    try {
      const currentTabs = await chrome.tabs.query({});
      const currentIds = new Set(currentTabs.map((tab) => tab.id));
      for (const group of Object.values(groups)) {
        group.tabIds = Array.isArray(group.tabIds)
          ? group.tabIds.filter((id) => currentIds.has(Number(id)))
          : [];
        group.incognito = IS_INCOGNITO_CONTEXT;
      }
      for (const id of Object.keys(tabNames)) {
        if (!currentIds.has(Number(id))) delete tabNames[id];
      }
      for (const id of Object.keys(tabCreatedAt)) {
        if (!currentIds.has(Number(id))) delete tabCreatedAt[id];
      }
      for (const deletedGroup of deletedGroups) {
        deletedGroup.tabIds = Array.isArray(deletedGroup.tabIds)
          ? deletedGroup.tabIds.filter((id) => currentIds.has(Number(id)))
          : [];
        deletedGroup.incognito = IS_INCOGNITO_CONTEXT;
      }
    } catch (e) {}
  }
  normalizeGroups();
  normalizeTabRecords();
  normalizeLayoutOrder();
  normalizeGroupOrder();
  normalizeDeletedGroups();

  // Reconcile as soon as the worker starts. The first query normally contains
  // Chrome's restored session tabs; the delayed pass handles browsers that
  // finish restoring a window in several batches.
  try {
    const currentTabs = await chrome.tabs.query({});
    if (reconcileStoredTabIds(currentTabs)) await persist();
    scheduleStartupReconciliation();
  } catch (e) {}
})();
function persist() {
  normalizeGroups();
  normalizeTabRecords();
  normalizeGroupOrder();
  normalizeLayoutOrder();
  normalizeDeletedGroups();
  const payload = {
    settings: cloneState(settings),
    [CONTEXT_STORAGE_KEY]: {
      groups: cloneState(groups),
      groupOrder: cloneState(groupOrder),
      tabNames: cloneState(tabNames),
      tabCreatedAt: cloneState(tabCreatedAt),
      layoutOrder: cloneState(layoutOrder),
      deletedGroups: cloneState(deletedGroups),
      tabRecords: cloneState(tabRecords),
      browserFocusSnapshots: cloneState(browserFocusSnapshots)
    }
  };
  // Queue writes and return the promise so message/event handlers can keep the
  // service worker alive until the latest organization is actually stored.
  const nextWrite = persistQueue.catch(() => {}).then(() => chrome.storage.local.set(payload));
  persistQueue = nextWrite.catch(() => {});
  return nextWrite;
}

function cloneState(value) {
  try { return structuredClone(value); } catch (e) {
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
  }
}

// ---------- helpers ----------
function layoutToken(kind, id) {
  return `${kind}:${String(id)}`;
}

function normalizeLayoutOrder() {
  const seen = new Set();
  layoutOrder = layoutOrder.filter((token) => {
    if (typeof token !== "string" || !/^(tab|group):.+$/.test(token) || seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

function normalizeGroups() {
  if (!groups || typeof groups !== "object") groups = {};
  for (const [key, group] of Object.entries(groups)) {
    if (!group || typeof group !== "object") {
      delete groups[key];
      continue;
    }
    group.id = String(group.id || key);
    group.name = String(group.name || "Unnamed group");
    group.color = String(group.color || "#5b6eff");
    group.tabIds = Array.from(new Set(
      (Array.isArray(group.tabIds) ? group.tabIds : [])
        .map(Number)
        .filter(Number.isInteger)
    ));
    group.collapsed = group.collapsed === true;
    group.incognito = IS_INCOGNITO_CONTEXT;
  }
}

function normalizeTabRecords() {
  if (!tabRecords || typeof tabRecords !== "object") tabRecords = {};
  const normalized = {};
  for (const [key, value] of Object.entries(tabRecords)) {
    if (!value || typeof value !== "object") continue;
    const recordKey = String(value.key || key);
    const tabId = Number(value.tabId);
    normalized[recordKey] = {
      ...value,
      key: recordKey,
      tabId: Number.isInteger(tabId) ? tabId : null,
      url: String(value.url || ""),
      title: String(value.title || ""),
      originalTitle: String(value.originalTitle || value.title || ""),
      incognito: value.incognito === true,
      windowId: Number.isInteger(Number(value.windowId)) ? Number(value.windowId) : null,
      index: Number.isInteger(Number(value.index)) ? Number(value.index) : null,
      createdAt: Number(value.createdAt) || 0
    };
  }
  tabRecords = normalized;
}

function makeTabRecordKey() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function tabIdentityUrl(tab) {
  return String(tab?.url || tab?.pendingUrl || "").trim();
}

function tabIdentityTitle(tab) {
  return String(tab?.title || "").trim();
}

function findTabRecordById(tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return null;
  return Object.values(tabRecords)
    .filter((record) => Number(record.tabId) === id && record.incognito === IS_INCOGNITO_CONTEXT)
    .sort((a, b) => Number(b.lastMatchedAt || 0) - Number(a.lastMatchedAt || 0))[0] || null;
}

function upsertTabRecord(tab) {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId)) return false;
  let record = findTabRecordById(tabId);
  if (!record) {
    const key = makeTabRecordKey();
    record = {
      key,
      tabId,
      url: "",
      title: "",
      originalTitle: "",
      incognito: IS_INCOGNITO_CONTEXT,
      windowId: null,
      index: null,
      createdAt: 0,
      lastMatchedAt: 0
    };
    tabRecords[key] = record;
  }

  const nextUrl = tabIdentityUrl(tab);
  const nextTitle = tabIdentityTitle(tab);
  const nextOriginalTitle = String(tab?.title || tab?.url || "New Tab");
  const nextWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : null;
  const nextIndex = Number.isInteger(tab?.index) ? tab.index : null;
  const nextCreatedAt = Number(tabCreatedAt[String(tabId)]) || Number(record.createdAt) ||
    Number(tab?.lastAccessed) || Date.now();
  const changed = record.tabId !== tabId ||
    record.url !== nextUrl ||
    record.title !== nextTitle ||
    record.originalTitle !== nextOriginalTitle ||
    record.windowId !== nextWindowId ||
    record.index !== nextIndex ||
    Number(record.createdAt) !== nextCreatedAt;

  record.tabId = tabId;
  record.url = nextUrl;
  record.title = nextTitle;
  record.originalTitle = nextOriginalTitle;
  record.incognito = IS_INCOGNITO_CONTEXT;
  record.windowId = nextWindowId;
  record.index = nextIndex;
  record.createdAt = nextCreatedAt;
  record.lastMatchedAt = Date.now();
  delete record.closedAt;
  tabCreatedAt[String(tabId)] = nextCreatedAt;
  return changed;
}

function collectReferencedTabIds() {
  const ids = new Set();
  for (const group of Object.values(groups)) {
    for (const tabId of Array.isArray(group.tabIds) ? group.tabIds : []) {
      if (Number.isInteger(Number(tabId))) ids.add(Number(tabId));
    }
  }
  for (const tabId of Object.keys(tabNames)) {
    if (Number.isInteger(Number(tabId))) ids.add(Number(tabId));
  }
  for (const tabId of Object.keys(tabCreatedAt)) {
    if (Number.isInteger(Number(tabId))) ids.add(Number(tabId));
  }
  for (const token of layoutOrder) {
    const match = /^tab:(-?\d+)$/.exec(String(token));
    if (match) ids.add(Number(match[1]));
  }
  for (const snapshot of Object.values(browserFocusSnapshots)) {
    if (Number.isInteger(Number(snapshot?.activeTabId))) ids.add(Number(snapshot.activeTabId));
    for (const entry of Array.isArray(snapshot?.tabs) ? snapshot.tabs : []) {
      if (Number.isInteger(Number(entry?.id))) ids.add(Number(entry.id));
    }
  }
  return ids;
}

function recordMatchesTab(record, tab, referencedIds) {
  if (!record || record.incognito !== !!tab?.incognito) return -Infinity;
  const recordId = Number(record.tabId);
  const tabId = Number(tab?.id);
  const recordUrl = String(record.url || "");
  const currentUrl = tabIdentityUrl(tab);
  const recordTitle = String(record.title || record.originalTitle || "");
  const currentTitle = tabIdentityTitle(tab);
  const sameUrl = !!recordUrl && !!currentUrl && recordUrl === currentUrl;
  const sameTitle = !!recordTitle && !!currentTitle && recordTitle === currentTitle;
  const sameIdAndWindow = recordId === tabId && Number(record.windowId) === Number(tab.windowId);

  // An exact URL is the reliable cross-restart signal. A same-ID,
  // same-window match also preserves a tab that navigated while the worker
  // was asleep.
  if (!sameUrl && !sameIdAndWindow && !(sameTitle && !recordUrl && !currentUrl)) return -Infinity;

  let score = 0;
  if (sameUrl) score += 600;
  if (sameTitle) score += 120;
  if (sameIdAndWindow) score += 300;
  if (referencedIds.has(recordId)) score += 180;
  if (Number(record.windowId) === Number(tab.windowId)) score += 30;
  if (Number.isInteger(record.index) && Number.isInteger(tab.index)) {
    score -= Math.min(120, Math.abs(record.index - tab.index));
  }
  return score;
}

function remapTabId(tabId, idMap) {
  if (tabId === null || tabId === undefined || tabId === "") return null;
  const numericId = Number(tabId);
  return idMap.has(numericId) ? idMap.get(numericId) : numericId;
}

function remapIdArray(ids, idMap, currentIds, pruneStale) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(ids) ? ids : []) {
    const id = remapTabId(value, idMap);
    if (!Number.isInteger(id) || (pruneStale && !currentIds.has(id)) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function remapStoredTabNames(idMap, currentIds, pruneStale) {
  const next = {};
  for (const [oldId, name] of Object.entries(tabNames)) {
    const id = remapTabId(oldId, idMap);
    if (!Number.isInteger(id) || (pruneStale && !currentIds.has(id))) continue;
    if (!Object.prototype.hasOwnProperty.call(next, String(id)) || id === Number(oldId)) {
      next[String(id)] = name;
    }
  }
  tabNames = next;
}

function remapStoredCreatedAt(idMap, currentIds, pruneStale) {
  const next = {};
  for (const [oldId, createdAt] of Object.entries(tabCreatedAt)) {
    const id = remapTabId(oldId, idMap);
    if (!Number.isInteger(id) || (pruneStale && !currentIds.has(id))) continue;
    if (!Object.prototype.hasOwnProperty.call(next, String(id)) || id === Number(oldId)) {
      next[String(id)] = Number(createdAt) || Date.now();
    }
  }
  tabCreatedAt = next;
}

function remapLayoutTabTokens(idMap, currentIds, pruneStale) {
  layoutOrder = layoutOrder
    .map((token) => {
      const match = /^tab:(-?\d+)$/.exec(String(token));
      if (!match) return token;
      const id = remapTabId(Number(match[1]), idMap);
      if (!Number.isInteger(id) || (pruneStale && !currentIds.has(id))) return null;
      return layoutToken("tab", id);
    })
    .filter(Boolean);
}

function remapSnapshots(idMap, currentTabs, currentIds, pruneStale) {
  const currentById = new Map(currentTabs.map((tab) => [Number(tab.id), tab]));
  const nextSnapshots = {};
  for (const snapshot of Object.values(browserFocusSnapshots)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const mappedTabs = (Array.isArray(snapshot.tabs) ? snapshot.tabs : [])
      .map((entry) => ({
        ...entry,
        id: remapTabId(entry.id, idMap)
      }))
      .filter((entry) => Number.isInteger(Number(entry.id)) && (!pruneStale || currentIds.has(Number(entry.id))));
    const activeTabId = remapTabId(snapshot.activeTabId, idMap);
    const windowCounts = new Map();
    for (const entry of mappedTabs) {
      const tab = currentById.get(Number(entry.id));
      if (!tab) continue;
      windowCounts.set(tab.windowId, (windowCounts.get(tab.windowId) || 0) + 1);
    }
    const targetWindowId = Array.from(windowCounts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0];
    if (targetWindowId === undefined || !mappedTabs.length) continue;
    nextSnapshots[String(targetWindowId)] = {
      ...snapshot,
      windowId: targetWindowId,
      activeTabId,
      tabs: mappedTabs
    };
  }
  browserFocusSnapshots = nextSnapshots;
}

function reconcileStoredTabIds(currentTabs, { pruneStale = false } = {}) {
  normalizeGroups();
  normalizeTabRecords();
  const tabs = (Array.isArray(currentTabs) ? currentTabs : [])
    .filter((tab) => Number.isInteger(Number(tab?.id)))
    .map((tab) => ({ ...tab, id: Number(tab.id) }))
    .sort((a, b) => Number(a.windowId) - Number(b.windowId) || Number(a.index) - Number(b.index));
  const currentIds = new Set(tabs.map((tab) => tab.id));
  const referencedIds = collectReferencedTabIds();
  const records = Object.values(tabRecords);
  const usedRecords = new Set();
  const assignments = new Map();
  const idMap = new Map();

  for (const tab of tabs) {
    let best = null;
    let bestScore = -Infinity;
    for (const record of records) {
      if (usedRecords.has(record.key)) continue;
      const score = recordMatchesTab(record, tab, referencedIds);
      if (score > bestScore) {
        best = record;
        bestScore = score;
      }
    }
    // 250 allows an exact URL match without requiring a title, while still
    // rejecting unrelated records left behind by an old browser session.
    if (best && bestScore >= 250) {
      usedRecords.add(best.key);
      assignments.set(tab.id, best);
      const oldId = Number(best.tabId);
      if (Number.isInteger(oldId)) idMap.set(oldId, tab.id);
    }
  }

  const nextRecords = {};
  for (const record of records) {
    if (!usedRecords.has(record.key) && !pruneStale) {
      nextRecords[record.key] = record;
    }
  }
  for (const tab of tabs) {
    let record = assignments.get(tab.id);
    if (!record) {
      const key = makeTabRecordKey();
      record = {
        key,
        tabId: tab.id,
        url: "",
        title: "",
        originalTitle: "",
        incognito: IS_INCOGNITO_CONTEXT,
        windowId: null,
        index: null,
        createdAt: 0,
        lastMatchedAt: 0
      };
    }
    record.tabId = tab.id;
    record.url = tabIdentityUrl(tab);
    record.title = tabIdentityTitle(tab);
    record.originalTitle = String(tab.title || tab.url || "New Tab");
    record.incognito = IS_INCOGNITO_CONTEXT;
    record.windowId = Number.isInteger(tab.windowId) ? tab.windowId : null;
    record.index = Number.isInteger(tab.index) ? tab.index : null;
    record.createdAt = Number(tabCreatedAt[String(tab.id)]) || Number(record.createdAt) ||
      Number(tab.lastAccessed) || Date.now();
    record.lastMatchedAt = Date.now();
    delete record.closedAt;
    tabCreatedAt[String(tab.id)] = record.createdAt;
    nextRecords[record.key] = record;
  }
  tabRecords = nextRecords;

  remapStoredTabNames(idMap, currentIds, pruneStale);
  remapStoredCreatedAt(idMap, currentIds, pruneStale);
  remapLayoutTabTokens(idMap, currentIds, pruneStale);
  for (const group of Object.values(groups)) {
    group.tabIds = remapIdArray(group.tabIds, idMap, currentIds, pruneStale);
  }
  for (const deletedGroup of deletedGroups) {
    deletedGroup.tabIds = remapIdArray(deletedGroup.tabIds, idMap, currentIds, pruneStale);
  }
  remapSnapshots(idMap, tabs, currentIds, pruneStale);

  if (pruneStale) {
    for (const groupId of Object.keys(groups)) {
      if (!groups[groupId].tabIds.length) {
        delete groups[groupId];
        groupOrder = groupOrder.filter((id) => id !== groupId);
        layoutOrder = layoutOrder.filter((token) => token !== layoutToken("group", groupId));
      }
    }
  }
  normalizeGroupOrder();
  normalizeLayoutOrder();
  normalizeDeletedGroups();
  return true;
}

function scheduleStartupReconciliation() {
  if (startupReconcileTimer) clearTimeout(startupReconcileTimer);
  startupReconcileTimer = setTimeout(async () => {
    startupReconcileTimer = null;
    try {
      const currentTabs = await chrome.tabs.query({});
      reconcileStoredTabIds(currentTabs, { pruneStale: true });
      await persist();
      const windowIds = Array.from(new Set(currentTabs
        .map((tab) => tab.windowId)
        .filter((id) => Number.isInteger(id))));
      for (const windowId of windowIds) {
        // If a group was focused before the restart, recreate the temporary
        // hidden-tab group after Chrome has finished restoring its tabs.
        await enforceBrowserGroupFocus(windowId);
        await refreshWindow(windowId);
      }
    } catch (e) {}
  }, 1500);
}

function ensureLayoutTokens(tabs = []) {
  normalizeLayoutOrder();
  const seen = new Set(layoutOrder);
  let changed = false;
  for (const tab of tabs) {
    const token = layoutToken("tab", tab.id);
    if (!seen.has(token)) {
      layoutOrder.push(token);
      seen.add(token);
      changed = true;
    }
  }
  for (const group of Object.values(groups)) {
    const token = layoutToken("group", group.id);
    if (!seen.has(token)) {
      layoutOrder.push(token);
      seen.add(token);
      changed = true;
    }
  }
  return changed;
}

async function getTabsForWindow(windowId) {
  await stateReady;
  const tabs = await chrome.tabs.query({ windowId });
  tabs.sort((a, b) => a.index - b.index);
  let createdAtChanged = false;
  let recordsChanged = false;
  for (const tab of tabs) {
    const key = String(tab.id);
    if (!tabCreatedAt[key]) {
      // Existing tabs may predate this version, so use their last access as a
      // useful approximation until newly created tabs receive a real timestamp.
      tabCreatedAt[key] = Number(tab.lastAccessed) || Date.now();
      createdAtChanged = true;
    }
    if (upsertTabRecord(tab)) recordsChanged = true;
  }
  if (createdAtChanged || recordsChanged) await persist();
  return tabs.map((t) => ({
    id: t.id,
    title: tabNames[String(t.id)] || t.title || t.url || "New Tab",
    originalTitle: t.title || t.url || "New Tab",
    hasCustomName: Object.prototype.hasOwnProperty.call(tabNames, String(t.id)),
    url: t.url || "",
    favIconUrl: t.favIconUrl || "",
    active: t.active,
    incognito: !!t.incognito,
    pinned: t.pinned,
    audible: !!t.audible,
    muted: !!t.mutedInfo?.muted,
    mutedInfo: t.mutedInfo,
    status: t.status || "complete",
    loading: t.status === "loading",
    lastAccessed: t.lastAccessed || 0,
    createdAt: tabCreatedAt[String(t.id)],
    index: t.index
  }));
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // content script not present on this page (chrome://, web store, etc) — ignore
  }
}

async function broadcastToWindow(windowId, message) {
  const tabs = await chrome.tabs.query({ windowId });
  for (const t of tabs) sendToTab(t.id, message);
  try { await chrome.runtime.sendMessage({ ...message, windowId }); } catch (e) {}
}

async function broadcastAll(message) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) sendToTab(t.id, message);
  try { await chrome.runtime.sendMessage(message); } catch (e) {}
}

async function updateActionIndicator(windowId, tabs) {
  if (!chrome.action?.setBadgeText) return;
  const activeTab = tabs.find((tab) => tab.active);
  const audioTab = tabs.find((tab) => tab.audible);
  const loadingTab = tabs.find((tab) => tab.status === "loading");
  const badgeText = loadingTab
    ? "…"
    : audioTab ? "♪" : "";
  for (const tab of tabs) {
    try { await chrome.action.setBadgeText({ tabId: tab.id, text: "" }); } catch (e) {}
  }
  if (activeTab) {
    try { await chrome.action.setBadgeText({ tabId: activeTab.id, text: badgeText }); } catch (e) {}
    if (badgeText) {
      try {
        await chrome.action.setBadgeBackgroundColor({
          tabId: activeTab.id,
          color: loadingTab ? "#5b6eff" : "#e8a33a"
        });
      } catch (e) {}
    }
  }
}

async function refreshWindow(windowId) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const tabs = await getTabsForWindow(windowId);
  if (ensureLayoutTokens(tabs)) await persist();
  updateActionIndicator(windowId, tabs);
  normalizeGroupOrder();
  normalizeLayoutOrder();
  broadcastToWindow(windowId, {
    type: "TABS_UPDATED", tabs, groups, groupOrder, layoutOrder,
    deletedGroups,
    focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
  });
}

function pruneGroupsOfTabId(tabId) {
  let changed = false;
  for (const [recordKey, record] of Object.entries(tabRecords)) {
    if (Number(record.tabId) === Number(tabId)) {
      record.closedAt = Date.now();
      changed = true;
    }
  }
  return changed;
}

function normalizeGroupOrder() {
  const existing = new Set(Object.keys(groups));
  groupOrder = groupOrder.filter((id) => existing.has(id));
  for (const id of existing) {
    if (!groupOrder.includes(id)) groupOrder.push(id);
  }
}

function normalizeDeletedGroups() {
  deletedGroups = (Array.isArray(deletedGroups) ? deletedGroups : [])
    .filter((item) => item && typeof item === "object" && item.id !== undefined && Array.isArray(item.tabIds))
    .map((item) => ({
      ...item,
      tabIds: Array.from(new Set(item.tabIds.map(Number).filter(Number.isInteger))),
      incognito: IS_INCOGNITO_CONTEXT
    }))
    .slice(0, 20);
}

function syncGroupTokensToGroupOrder() {
  const orderedGroupTokens = groupOrder.map((id) => layoutToken("group", id));
  let index = 0;
  layoutOrder = layoutOrder.map((token) => {
    if (!token.startsWith("group:")) return token;
    return orderedGroupTokens[index++] || token;
  });
  for (; index < orderedGroupTokens.length; index++) {
    if (!layoutOrder.includes(orderedGroupTokens[index])) layoutOrder.push(orderedGroupTokens[index]);
  }
  normalizeLayoutOrder();
}

function getNativeGroupId(tab) {
  return Number.isInteger(tab?.groupId) ? tab.groupId : -1;
}

async function captureBrowserFocusSnapshot(windowId, customGroupId) {
  const tabs = await chrome.tabs.query({ windowId });
  const nativeGroups = chrome.tabGroups?.query
    ? await chrome.tabGroups.query({ windowId })
    : [];
  return {
    customGroupId,
    activeTabId: tabs.find((tab) => tab.active)?.id || null,
    tabs: tabs.map((tab) => ({ id: tab.id, groupId: getNativeGroupId(tab) })),
    groups: nativeGroups.map((group) => ({
      id: group.id,
      title: group.title || "",
      color: group.color || "grey",
      collapsed: !!group.collapsed
    }))
  };
}

function queueBrowserFocusOperation(windowId, operation) {
  if (!Number.isInteger(windowId)) return Promise.resolve().then(operation);
  const previous = browserFocusQueues.get(windowId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  browserFocusQueues.set(windowId, current);
  current.finally(() => {
    if (browserFocusQueues.get(windowId) === current) browserFocusQueues.delete(windowId);
  }).catch(() => {});
  return current;
}

function restoreBrowserGroupFocus(windowId) {
  return queueBrowserFocusOperation(windowId, () => restoreBrowserGroupFocusUnlocked(windowId));
}

async function restoreBrowserGroupFocusUnlocked(windowId) {
  const key = String(windowId);
  const snapshot = browserFocusSnapshots[key];
  if (!snapshot) return { ok: true };
  const hiddenGroupId = Number(snapshot.hiddenGroupId);
  const hasHiddenGroupId = Number.isInteger(hiddenGroupId);

  async function ungroupAllNonPinnedTabs() {
    if (typeof chrome.tabs.ungroup !== "function") return false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentTabs = await chrome.tabs.query({ windowId });
      const groupedTabs = currentTabs.filter((tab) => getNativeGroupId(tab) !== -1 && !tab.pinned);
      if (!groupedTabs.length) return true;

      // A collapsed group can keep its tabs visually hidden while Chrome is
      // processing the ungroup request. Expand the temporary group first,
      // then remove tabs one native group at a time with an individual retry.
      if (hasHiddenGroupId && chrome.tabGroups?.update) {
        try {
          await chrome.tabGroups.update(hiddenGroupId, { collapsed: false });
        } catch (e) {}
      }

      const nativeGroupIds = Array.from(new Set(groupedTabs.map(getNativeGroupId)));
      for (const nativeGroupId of nativeGroupIds) {
        const tabIds = groupedTabs
          .filter((tab) => getNativeGroupId(tab) === nativeGroupId)
          .map((tab) => tab.id);
        if (!tabIds.length) continue;
        try {
          await chrome.tabs.ungroup(tabIds);
        } catch (e) {
          // A batch can fail while Chrome is still editing another tab. Retry
          // one tab at a time so no hidden group is left behind.
          for (const tabId of tabIds) {
            try { await chrome.tabs.ungroup(tabId); } catch (error) {}
          }
        }
      }

      // Let Chrome publish the resulting tab/group state before verifying it.
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    const remainingTabs = await chrome.tabs.query({ windowId });
    return !remainingTabs.some((tab) => getNativeGroupId(tab) !== -1 && !tab.pinned);
  }

  let currentTabs;
  try {
    currentTabs = await chrome.tabs.query({ windowId });
    if (!(await ungroupAllNonPinnedTabs())) {
      return { ok: false, error: "Chrome could not restore all tabs yet. Try Show all again." };
    }
    currentTabs = await chrome.tabs.query({ windowId });
    const currentIds = new Set(currentTabs.map((tab) => Number(tab.id)));

    for (const originalGroup of snapshot.groups || []) {
      const ids = (snapshot.tabs || [])
        .filter((record) => Number(record.groupId) === Number(originalGroup.id) && currentIds.has(Number(record.id)))
        .map((record) => currentTabs.find((tab) => Number(tab.id) === Number(record.id)))
        .filter((tab) => tab && !tab.pinned)
        .map((tab) => tab.id);
      if (!ids.length) continue;

      let groupId = Number(originalGroup.id);
      let existingGroup = null;
      try {
        existingGroup = await chrome.tabGroups.get(groupId);
      } catch (e) {}
      if (!existingGroup || (Number.isInteger(existingGroup.windowId) && existingGroup.windowId !== windowId)) {
        groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      }
      try {
        await chrome.tabs.group({ groupId, tabIds: ids });
      } catch (e) {}
      try {
        const groupPatch = { collapsed: !!originalGroup.collapsed };
        if (originalGroup.title) groupPatch.title = originalGroup.title;
        if (originalGroup.color) groupPatch.color = originalGroup.color;
        await chrome.tabGroups.update(groupId, groupPatch);
      } catch (e) {}
    }

    if (snapshot.activeTabId && currentIds.has(Number(snapshot.activeTabId))) {
      try { await chrome.tabs.update(Number(snapshot.activeTabId), { active: true }); } catch (e) {}
    }

    const remainingHiddenTabs = await chrome.tabs.query({ windowId });
    if (hasHiddenGroupId && remainingHiddenTabs.some((tab) =>
      getNativeGroupId(tab) === hiddenGroupId && !tab.pinned
    )) {
      return { ok: false, error: "Chrome could not release the hidden tabs yet. Try Show all again." };
    }
  } catch (e) {
    // A tab may have closed or a browser group may have changed while focus was active.
    return { ok: false, error: "Chrome could not restore the hidden tabs yet. Try Show all again." };
  }

  delete browserFocusSnapshots[key];
  await persist();
  return { ok: true };
}

function focusBrowserGroup(windowId, customGroupId, requestedTabIds) {
  return queueBrowserFocusOperation(windowId, () =>
    focusBrowserGroupUnlocked(windowId, customGroupId, requestedTabIds)
  );
}

async function focusBrowserGroupUnlocked(windowId, customGroupId, requestedTabIds) {
  if (!Number.isInteger(windowId) || !chrome.tabs.group || !chrome.tabs.ungroup || !chrome.tabGroups?.update) {
    return { ok: false, error: "Chrome tab groups are unavailable." };
  }

  const currentTabs = await chrome.tabs.query({ windowId });
  const requested = new Set((Array.isArray(requestedTabIds) ? requestedTabIds : []).map(Number));
  const visibleTabs = currentTabs.filter((tab) => requested.has(tab.id) && !tab.pinned);
  if (!visibleTabs.length) {
    return { ok: false, error: "This group has no unpinned tabs in the current window." };
  }

  const key = String(windowId);
  const existing = browserFocusSnapshots[key];
  if (existing && existing.customGroupId !== customGroupId) {
    const restored = await restoreBrowserGroupFocusUnlocked(windowId);
    if (restored?.ok === false) return restored;
  }
  if (browserFocusSnapshots[key]?.customGroupId === customGroupId) {
    await enforceBrowserGroupFocusUnlocked(windowId);
    const refreshedSnapshot = browserFocusSnapshots[key];
    if (!refreshedSnapshot) return { ok: false, error: "This group is no longer available." };
    const hiddenGroupId = Number(refreshedSnapshot.hiddenGroupId);
    if (Number.isInteger(hiddenGroupId)) {
      try { await chrome.tabGroups.update(hiddenGroupId, { collapsed: true }); } catch (e) {}
    }
    return { ok: true };
  }

  const snapshot = await captureBrowserFocusSnapshot(windowId, customGroupId);
  browserFocusSnapshots[key] = snapshot;
  await persist();

  const nativeGroups = await chrome.tabGroups.query({ windowId });
  for (const nativeGroup of nativeGroups) {
    const containsVisibleTab = currentTabs.some((tab) =>
      tab.groupId === nativeGroup.id && visibleTabs.some((visible) => visible.id === tab.id)
    );
    if (containsVisibleTab && nativeGroup.collapsed) {
      try { await chrome.tabGroups.update(nativeGroup.id, { collapsed: false }); } catch (e) {}
    }
  }

  const activeTab = currentTabs.find((tab) => tab.active);
  if (!activeTab || !visibleTabs.some((tab) => tab.id === activeTab.id)) {
    try { await chrome.tabs.update(visibleTabs[0].id, { active: true }); } catch (e) {}
  }

  const hiddenIds = currentTabs
    .filter((tab) => !tab.pinned && !requested.has(tab.id))
    .map((tab) => tab.id);
  if (hiddenIds.length) {
    try {
      const hiddenGroupId = await chrome.tabs.group({
        tabIds: hiddenIds,
        createProperties: { windowId }
      });
      snapshot.hiddenGroupId = hiddenGroupId;
      await chrome.tabGroups.update(hiddenGroupId, {
        title: "Vertical Tabs — Hidden",
        color: "grey",
        collapsed: true
      });
      await persist();
    } catch (e) {
      // The sidebar still filters its own list if Chrome cannot create the temporary group.
    }
  }
  return { ok: true };
}

function enforceBrowserGroupFocus(windowId) {
  return queueBrowserFocusOperation(windowId, () => enforceBrowserGroupFocusUnlocked(windowId));
}

async function enforceBrowserGroupFocusUnlocked(windowId) {
  const snapshot = browserFocusSnapshots[String(windowId)];
  if (!snapshot || !Number.isInteger(windowId)) return;
  const group = groups[snapshot.customGroupId];
  if (!group) {
    await restoreBrowserGroupFocusUnlocked(windowId);
    return;
  }

  const currentTabs = await chrome.tabs.query({ windowId });
  const visibleIds = new Set(group.tabIds.map(Number));
  const visibleTabs = currentTabs.filter((tab) => visibleIds.has(tab.id) && !tab.pinned);
  if (!visibleTabs.length) return;

  const activeTab = currentTabs.find((tab) => tab.active);
  if (!activeTab || !visibleTabs.some((tab) => tab.id === activeTab.id)) {
    try { await chrome.tabs.update(visibleTabs[0].id, { active: true }); } catch (e) {}
  }

  const hiddenGroupId = Number(snapshot.hiddenGroupId);
  if (Number.isInteger(hiddenGroupId)) {
    const visibleInHiddenGroup = currentTabs
      .filter((tab) => visibleIds.has(tab.id) && getNativeGroupId(tab) === hiddenGroupId)
      .map((tab) => tab.id);
    if (visibleInHiddenGroup.length) {
      try { await chrome.tabs.ungroup(visibleInHiddenGroup); } catch (e) {}
    }
  }

  const hiddenIds = currentTabs
    .filter((tab) => !tab.pinned && !visibleIds.has(tab.id))
    .map((tab) => tab.id);
  if (!hiddenIds.length) return;

  try {
    let groupId = hiddenGroupId;
    if (!Number.isInteger(groupId)) {
      groupId = await chrome.tabs.group({ tabIds: hiddenIds, createProperties: { windowId } });
      snapshot.hiddenGroupId = groupId;
    } else {
      try {
        await chrome.tabGroups.get(groupId);
        await chrome.tabs.group({ groupId, tabIds: hiddenIds });
      } catch (e) {
        groupId = await chrome.tabs.group({ tabIds: hiddenIds, createProperties: { windowId } });
        snapshot.hiddenGroupId = groupId;
      }
    }
    await chrome.tabGroups.update(groupId, { collapsed: true });
    await persist();
  } catch (e) {}
}

// ---------- native side panel ----------
function getMessageWindowId(msg, sender) {
  if (Number.isInteger(msg?.windowId)) return msg.windowId;
  if (Number.isInteger(sender?.tab?.windowId)) return sender.tab.windowId;
  return undefined;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function openSidePanel(windowId) {
  if (!chrome.sidePanel || !Number.isInteger(windowId)) return false;
  try {
    // This call is intentionally made directly from the user-triggered path.
    await chrome.sidePanel.open({ windowId });
    sidebarOpenByWindow[windowId] = true;
    return true;
  } catch (e) {
    return false;
  }
}

async function closeSidePanel(windowId) {
  if (!chrome.sidePanel || !Number.isInteger(windowId)) return false;
  try {
    if (typeof chrome.sidePanel.close === "function") {
      await chrome.sidePanel.close({ windowId });
    } else {
      // Compatibility fallback for Chrome versions before sidePanel.close().
      await chrome.sidePanel.setOptions({ enabled: false });
      await chrome.sidePanel.setOptions({ enabled: true });
    }
    sidebarOpenByWindow[windowId] = false;
    return true;
  } catch (e) {
    return false;
  }
}

async function toggleForTab(tab) {
  if (!tab || !Number.isInteger(tab.windowId)) return false;
  const windowId = tab.windowId;
  if (sidebarOpenByWindow[windowId]) return closeSidePanel(windowId);
  return openSidePanel(windowId);
}

if (chrome.sidePanel?.onOpened) {
  chrome.sidePanel.onOpened.addListener((info) => {
    if (!Number.isInteger(info?.windowId)) return;
    sidebarOpenByWindow[info.windowId] = true;
    chrome.runtime.sendMessage({ type: "SET_SIDEBAR_STATE", windowId: info.windowId, open: true }).catch(() => {});
  });
}

if (chrome.sidePanel?.onClosed) {
  chrome.sidePanel.onClosed.addListener((info) => {
    if (!Number.isInteger(info?.windowId)) return;
    sidebarOpenByWindow[info.windowId] = false;
    // Closing the native panel must not clear group focus. The temporary
    // hidden-tab group stays collapsed until the user chooses "Show all" or
    // another group from the sidebar after reopening it.
    refreshWindow(info.windowId).catch(() => {});
    chrome.runtime.sendMessage({ type: "SET_SIDEBAR_STATE", windowId: info.windowId, open: false }).catch(() => {});
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  // The public command is intentionally named "Activate the extension" so
  // Chrome's shortcut settings show Option+V/Alt+V on the correct row.
  // Keep the old key as a compatibility alias for already-loaded builds.
  if (command !== "activate-extension" && command !== "toggle-sidebar") return;
  const tab = await getActiveTab();
  if (!tab) return;
  toggleForTab(tab);
});

chrome.action.onClicked.addListener((tab) => {
  toggleForTab(tab);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  delete sidebarOpenByWindow[windowId];
  delete browserFocusSnapshots[String(windowId)];
  try { await persist(); } catch (e) {}
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    // stateReady schedules the delayed pass. Keep this event as a second
    // trigger for Chrome versions that restore the session after onStartup.
    stateReady.then(() => scheduleStartupReconciliation()).catch(() => {});
  });
}

// ---------- live tab tracking ----------
function addCreatedTabToFocusedGroup(tab) {
  if (!tab || tab.id === undefined || !Number.isInteger(tab.windowId)) return false;
  const snapshot = browserFocusSnapshots[String(tab.windowId)];
  const focusedGroup = snapshot?.customGroupId
    ? groups[snapshot.customGroupId]
    : null;
  if (!focusedGroup) return false;

  const tabId = Number(tab.id);
  let changed = false;
  for (const group of Object.values(groups)) {
    if (group.id === focusedGroup.id) continue;
    const nextIds = group.tabIds.filter((id) => Number(id) !== tabId);
    if (nextIds.length !== group.tabIds.length) {
      group.tabIds = nextIds;
      changed = true;
    }
  }
  if (!focusedGroup.tabIds.some((id) => Number(id) === tabId)) {
    focusedGroup.tabIds.push(tabId);
    changed = true;
  }
  return changed;
}

chrome.tabs.onCreated.addListener((tab) => {
  const windowId = Number.isInteger(tab?.windowId) ? tab.windowId : undefined;
  queueBrowserFocusOperation(windowId, async () => {
    await stateReady;
    if (tab?.id !== undefined) {
      tabCreatedAt[String(tab.id)] = Date.now();
      addCreatedTabToFocusedGroup(tab);
      await persist();
    }
    if (windowId !== undefined) {
      // Adopt browser-created tabs (Ctrl+T/Cmd+T) before rebuilding the
      // temporary hidden group used by focus mode.
      await enforceBrowserGroupFocusUnlocked(windowId);
      await refreshWindow(windowId);
    }
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  pruneGroupsOfTabId(tabId);
  persist().catch(() => {});
  // Give Chrome a chance to restore the session before removing the saved
  // membership. On a normal tab close this cleans up shortly afterward; on a
  // browser restart it lets the next startup reconciliation reconnect the tab.
  scheduleStartupReconciliation();
  refreshWindow(info.windowId).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title || changeInfo.favIconUrl || changeInfo.status || changeInfo.url || changeInfo.pinned || changeInfo.audible || changeInfo.mutedInfo || changeInfo.groupId) {
    refreshWindow(tab.windowId);
  }
});
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  enforceBrowserGroupFocus(windowId)
    .catch(() => {})
    .finally(() => refreshWindow(windowId));
});
chrome.tabs.onMoved.addListener((tabId, info) => refreshWindow(info.windowId));
chrome.tabs.onAttached.addListener((tabId, info) => refreshWindow(info.newWindowId));
chrome.tabs.onDetached.addListener((tabId, info) => refreshWindow(info.oldWindowId));

// ---------- message handling ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TOGGLE_SIDEBAR_SHORTCUT") {
    const tabPromise = sender?.tab || getActiveTab();
    Promise.resolve(tabPromise).then((tab) => toggleForTab(tab)).then(sendResponse);
    return true;
  }
  handleMessage(msg, sender).then(sendResponse);
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  await stateReady;
  const windowId = getMessageWindowId(msg, sender) ?? (await getActiveTab())?.windowId;

  switch (msg.type) {
    case "REQUEST_STATE": {
      const tabs = windowId !== undefined ? await getTabsForWindow(windowId) : [];
      if (ensureLayoutTokens(tabs)) await persist();
      return {
        open: !!sidebarOpenByWindow[windowId],
        tabs,
        settings,
        groups,
        groupOrder,
        layoutOrder,
        deletedGroups,
        incognito: IS_INCOGNITO_CONTEXT,
        focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
      };
    }

    case "OPEN_SHORTCUT_SETTINGS": {
      try {
        const createOptions = { url: "chrome://extensions/shortcuts" };
        if (Number.isInteger(windowId)) createOptions.windowId = windowId;
        await chrome.tabs.create(createOptions);
      } catch (e) {}
      return { ok: true };
    }

    case "OPEN_PANEL_SETTINGS": {
      try {
        const createOptions = { url: "chrome://settings/appearance" };
        if (Number.isInteger(windowId)) createOptions.windowId = windowId;
        await chrome.tabs.create(createOptions);
      } catch (e) {}
      return { ok: true };
    }

    case "FOCUS_GROUP": {
      const group = groups[msg.groupId];
      const result = group
        ? await focusBrowserGroup(windowId, group.id, group.tabIds)
        : { ok: false, error: "Group not found." };
      if (windowId !== undefined) await refreshWindow(windowId);
      return result;
    }

    case "CLEAR_GROUP_FOCUS": {
      const result = windowId !== undefined
        ? await restoreBrowserGroupFocus(windowId)
        : { ok: true };
      if (windowId !== undefined) await refreshWindow(windowId);
      return result;
    }

    case "ACTIVATE_TAB": {
      try { await chrome.tabs.update(msg.tabId, { active: true }); } catch (e) {}
      return { ok: true };
    }

    case "CLOSE_TABS": {
      try {
        await chrome.tabs.remove(msg.tabIds);
      } catch (e) {}
      return { ok: true };
    }

    case "PIN_TABS": {
      for (const id of msg.tabIds) {
        try { await chrome.tabs.update(id, { pinned: msg.pinned }); } catch (e) {}
      }
      return { ok: true };
    }

    case "DUPLICATE_TAB": {
      try { await chrome.tabs.duplicate(msg.tabId); } catch (e) {}
      return { ok: true };
    }

    case "CREATE_TAB": {
      let created = null;
      try {
        const createOptions = Number.isInteger(windowId) ? { windowId } : {};
        created = await chrome.tabs.create(createOptions);
      } catch (e) {}
      const targetGroup = groups[msg.groupId];
      if (created?.id !== undefined && targetGroup) {
        const newTabId = Number(created.id);
        for (const other of Object.values(groups)) {
          if (other.id === targetGroup.id) continue;
          other.tabIds = other.tabIds.filter((id) => Number(id) !== newTabId);
        }
        if (!targetGroup.tabIds.some((id) => Number(id) === newTabId)) {
          targetGroup.tabIds.push(newTabId);
        }
        await persist();
        if (windowId !== undefined) {
          await broadcastToWindow(windowId, {
            type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
            focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
          });
          if (browserFocusSnapshots[String(windowId)]?.customGroupId === targetGroup.id) {
            await enforceBrowserGroupFocus(windowId);
          }
        }
      }
      return { ok: true, tabId: created?.id ?? null, groupId: targetGroup?.id || null };
    }

    case "MUTE_TABS": {
      const ids = Array.isArray(msg.tabIds) ? msg.tabIds : [];
      for (const id of ids) {
        try { await chrome.tabs.update(Number(id), { muted: !!msg.muted }); } catch (e) {}
      }
      return { ok: true };
    }

    case "RELOAD_TABS": {
      const ids = Array.from(new Set((Array.isArray(msg.tabIds) ? msg.tabIds : [])
        .map(Number)
        .filter(Number.isInteger)));
      for (const id of ids) {
        try { await chrome.tabs.reload(id); } catch (e) {}
      }
      return { ok: true };
    }

    case "BOOKMARK_TABS": {
      const ids = Array.from(new Set((Array.isArray(msg.tabIds) ? msg.tabIds : [])
        .map(Number)
        .filter(Number.isInteger)));
      for (const id of ids) {
        try {
          const tab = await chrome.tabs.get(id);
          if (!tab.url || /^(chrome|edge|about|view-source):/i.test(tab.url)) continue;
          await chrome.bookmarks.create({
            parentId: "1",
            title: tabNames[String(id)] || tab.title || tab.url,
            url: tab.url
          });
        } catch (e) {}
      }
      return { ok: true };
    }

    case "RENAME_TAB": {
      const id = Number(msg.tabId);
      if (Number.isInteger(id)) {
        const name = String(msg.name || "").trim().slice(0, 120);
        if (name) tabNames[String(id)] = name;
        else delete tabNames[String(id)];
        await persist();
        if (windowId !== undefined) refreshWindow(windowId);
      }
      return { ok: true };
    }

    case "MOVE_TAB": {
      try {
        await chrome.tabs.move(msg.tabId, { index: msg.index });
      } catch (e) {}
      return { ok: true };
    }

    case "CREATE_GROUP": {
      const id = "g_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      // remove these tabs from any existing group first
      for (const g of Object.values(groups)) {
        g.tabIds = g.tabIds.filter((tid) => !msg.tabIds.includes(tid));
      }
      groups[id] = {
        id,
        name: msg.name || "New Group",
        color: msg.color || "#5b6eff",
        tabIds: [...msg.tabIds],
        collapsed: false,
        incognito: IS_INCOGNITO_CONTEXT
      };
      groupOrder.push(id);
      layoutOrder.push(layoutToken("group", id));
      normalizeLayoutOrder();
      normalizeGroupOrder();
      await persist();
      if (windowId !== undefined) broadcastToWindow(windowId, {
        type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
        focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
      });
      return { ok: true, groupId: id };
    }

    case "UPDATE_GROUP": {
      const g = groups[msg.groupId];
      if (g) {
        Object.assign(g, msg.patch);
        normalizeGroupOrder();
        await persist();
        if (windowId !== undefined) broadcastToWindow(windowId, {
          type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
          focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
        });
      }
      return { ok: true };
    }

    case "DELETE_GROUP": {
      const group = groups[msg.groupId];
      if (!group) return { ok: false, error: "Group not found." };
      if (windowId !== undefined && browserFocusSnapshots[String(windowId)]?.customGroupId === msg.groupId) {
        const restored = await restoreBrowserGroupFocus(windowId);
        if (restored?.ok === false) return restored;
      }
      deletedGroups.unshift({
        historyId: `${group.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
        id: group.id,
        name: group.name || "Unnamed group",
        color: group.color || "#5b6eff",
        tabIds: Array.isArray(group.tabIds) ? [...group.tabIds] : [],
        collapsed: !!group.collapsed,
        groupOrderIndex: groupOrder.indexOf(group.id),
        layoutIndex: layoutOrder.indexOf(layoutToken("group", group.id)),
        deletedAt: Date.now(),
        incognito: IS_INCOGNITO_CONTEXT
      });
      normalizeDeletedGroups();
      delete groups[msg.groupId];
      groupOrder = groupOrder.filter((id) => id !== msg.groupId);
      layoutOrder = layoutOrder.filter((item) => item !== layoutToken("group", msg.groupId));
      await persist();
      if (windowId !== undefined) broadcastToWindow(windowId, {
        type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
        deletedGroups,
        focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
      });
      return { ok: true };
    }

    case "RESTORE_DELETED_GROUP": {
      const requestedHistoryId = String(msg.historyId || "");
      const historyIndex = deletedGroups.findIndex((item) =>
        String(item.historyId || item.id) === requestedHistoryId
      );
      if (historyIndex === -1) return { ok: false, error: "Deleted group was not found." };

      const archived = deletedGroups[historyIndex];
      const openTabs = await chrome.tabs.query({});
      const openTabIds = new Set(openTabs.map((tab) => tab.id));
      const restoredTabIds = (Array.isArray(archived.tabIds) ? archived.tabIds : [])
        .filter((id) => openTabIds.has(Number(id)));
      const restoredTabIdSet = new Set(restoredTabIds.map((id) => Number(id)));
      const groupId = groups[archived.id]
        ? "g_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
        : archived.id;

      for (const other of Object.values(groups)) {
        other.tabIds = other.tabIds.filter((id) => !restoredTabIdSet.has(Number(id)));
      }
      groups[groupId] = {
        id: groupId,
        name: archived.name || "Restored group",
        color: archived.color || "#5b6eff",
        tabIds: restoredTabIds,
        collapsed: !!archived.collapsed,
        incognito: IS_INCOGNITO_CONTEXT
      };

      const groupInsertAt = Math.max(0, Math.min(
        Number.isInteger(archived.groupOrderIndex) ? archived.groupOrderIndex : groupOrder.length,
        groupOrder.length
      ));
      groupOrder.splice(groupInsertAt, 0, groupId);
      const groupToken = layoutToken("group", groupId);
      const layoutInsertAt = Math.max(0, Math.min(
        Number.isInteger(archived.layoutIndex) && archived.layoutIndex >= 0
          ? archived.layoutIndex
          : layoutOrder.length,
        layoutOrder.length
      ));
      layoutOrder.splice(layoutInsertAt, 0, groupToken);
      deletedGroups.splice(historyIndex, 1);
      normalizeGroupOrder();
      normalizeLayoutOrder();
      normalizeDeletedGroups();
      await persist();
      if (windowId !== undefined) broadcastToWindow(windowId, {
        type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
        deletedGroups,
        focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
      });
      return { ok: true, groupId, restoredTabCount: restoredTabIds.length };
    }

    case "CLEAR_DELETED_GROUP_HISTORY": {
      deletedGroups = [];
      await persist();
      await broadcastAll({
        type: "GROUPS_UPDATED",
        groups,
        groupOrder,
        layoutOrder,
        deletedGroups
      });
      return { ok: true };
    }

    case "REMOVE_TABS_FROM_GROUP": {
      for (const g of Object.values(groups)) {
        g.tabIds = g.tabIds.filter((tid) => !msg.tabIds.includes(tid));
      }
      for (const gid of Object.keys(groups)) {
        if (groups[gid].tabIds.length === 0) {
          delete groups[gid];
          groupOrder = groupOrder.filter((id) => id !== gid);
          layoutOrder = layoutOrder.filter((item) => item !== layoutToken("group", gid));
        }
      }
      await persist();
      if (windowId !== undefined) broadcastToWindow(windowId, {
        type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
        focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
      });
      return { ok: true };
    }

    case "MOVE_TABS_TO_GROUP":
    case "ADD_TABS_TO_GROUP": {
      const g = groups[msg.groupId];
      if (!g) return { ok: false, error: "Group not found." };
      const movingIds = Array.from(new Set(
        (Array.isArray(msg.tabIds) ? msg.tabIds : [])
          .map(Number)
          .filter(Number.isInteger)
      ));
      const movingSet = new Set(movingIds);
      if (movingIds.length) {
        for (const other of Object.values(groups)) {
          if (other.id === g.id) continue;
          other.tabIds = other.tabIds.filter((tid) => !movingSet.has(Number(tid)));
        }
        for (const tid of movingIds) {
          if (!g.tabIds.some((id) => Number(id) === tid)) g.tabIds.push(tid);
        }
        await persist();
        if (windowId !== undefined) broadcastToWindow(windowId, {
          type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
          focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
        });
      }
      return { ok: true };
    }

    case "REORDER_GROUP_TABS": {
      const g = groups[msg.groupId];
      if (g && Array.isArray(msg.tabIds)) {
        const valid = new Set(g.tabIds);
        g.tabIds = msg.tabIds.filter((id) => valid.has(id));
        for (const id of valid) {
          if (!g.tabIds.includes(id)) g.tabIds.push(id);
        }
        await persist();
        if (windowId !== undefined) broadcastToWindow(windowId, {
          type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
          focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
        });
      }
      return { ok: true };
    }

    case "REORDER_GROUPS": {
      if (Array.isArray(msg.groupOrder)) {
        groupOrder = msg.groupOrder;
        normalizeGroupOrder();
        syncGroupTokensToGroupOrder();
        await persist();
        if (windowId !== undefined) broadcastToWindow(windowId, {
          type: "GROUPS_UPDATED", groups, groupOrder, layoutOrder,
          focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
        });
      }
      return { ok: true };
    }

    case "REORDER_LAYOUT": {
      if (Array.isArray(msg.layoutOrder)) {
        layoutOrder = msg.layoutOrder.filter((token) => typeof token === "string");
        normalizeLayoutOrder();
        await persist();
        if (windowId !== undefined) broadcastToWindow(windowId, {
          type: "TABS_UPDATED",
          tabs: await getTabsForWindow(windowId),
          groups,
          groupOrder,
          layoutOrder,
          focusedGroupId: browserFocusSnapshots[String(windowId)]?.customGroupId || null
        });
      }
      return { ok: true };
    }

    case "SETTINGS_CHANGED": {
      settings = { ...settings, ...msg.settings };
      await persist();
      broadcastAll({ type: "SETTINGS_UPDATED", settings });
      return { ok: true };
    }

    case "CLOSE_SIDEBAR": {
      if (windowId !== undefined) {
        await closeSidePanel(windowId);
        sidebarOpenByWindow[windowId] = false;
        const message = { type: "SET_SIDEBAR_STATE", windowId, open: false };
        broadcastToWindow(windowId, message);
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: "unknown message" };
  }
}
