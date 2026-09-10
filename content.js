// content.js — injects the vertical tabs sidebar into every page via a
// shadow-DOM host so page styles never leak in (and ours never leak out).

(function () {
  try {
  const IS_NATIVE_SIDE_PANEL = location.protocol === "chrome-extension:";

  // The UI lives in the native Chrome Side Panel. Chrome owns the extension
  // command shortcut, so no page-level Alt/Option+V listener is installed.
  if (!IS_NATIVE_SIDE_PANEL) {
    return;
  }

  if (window.__vtSidebarInjected) return;
  window.__vtSidebarInjected = true;

  const GROUP_COLORS = [
    "#5b6eff", "#ff6b6b", "#ffb020", "#2ecc71",
    "#00c2d1", "#a76bff", "#ff7ab6", "#8d9aab"
  ];

  const ICONS = {
    settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.36.28.8.45 1.51.45H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
    filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M7 12h10M10 18h4"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5a4 4 0 010 5M19.5 7a7 7 0 010 10"/></svg>`,
    muted: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M18 9l4 6M22 9l-4 6"/></svg>`,
    spinner: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a9 9 0 108.5 6"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>`
  };

  let state = {
    open: false,
    tabs: [],
    groups: {},
    groupOrder: [],
    settings: {
      position: "right",
      width: 300,
      searchPosition: "bottom",
      theme: "dark",
      fontSize: 13,
      fontColor: "",
      showNewTabButton: true,
      showTabTimes: false,
      shortcut: { key: "", meta: false, ctrl: false, alt: false, shift: false }
    },
    layoutOrder: [],
    deletedGroups: [],
    activeView: "default",
    activeGroupId: null,
    sortMode: "custom",
    filter: "",
    selection: new Set(),
    lastClickedId: null
  };
  let panelWindowId = null;
  let activeDrag = null;
  let dragOverEl = null;

  // ---------- shadow host ----------
  const hostEl = document.createElement("div");
  hostEl.id = "__vt_sidebar_host__";
  hostEl.style.all = "initial";
  hostEl.style.display = "block";
  hostEl.style.width = "100%";
  hostEl.style.height = "100vh";
  const shadow = hostEl.attachShadow({ mode: "open" });

  const linkEl = document.createElement("link");
  linkEl.rel = "stylesheet";
  linkEl.href = chrome.runtime.getURL("sidebar.css");
  shadow.appendChild(linkEl);

  const root = document.createElement("div");
  root.className = "vt-root";
  shadow.appendChild(root);

  root.innerHTML = `
    <div class="vt-panel" data-theme="dark">
      <div class="vt-resize-handle"></div>
      <div class="vt-header">
        <div class="vt-brand">Vertical Tabs <span class="vt-tab-count" aria-label="Open tabs">0</span></div>
        <div class="vt-view-tabs">
          <button data-view="default" class="active">Default</button>
          <button data-view="tabs">Tabs</button>
          <button data-view="groups">Groups</button>
        </div>
        <div class="vt-header-actions">
          <div class="vt-theme-switch" title="Toggle theme"><div class="vt-knob">${ICONS.moon}</div></div>
          <button class="vt-icon-btn vt-filter-btn" title="Sort tabs">${ICONS.filter}</button>
          <button class="vt-icon-btn vt-settings-btn" title="Settings">${ICONS.settings}</button>
        </div>
        <div class="vt-popover vt-sort-popover">
          <div class="vt-popover-label">Sort Tabs</div>
          <button class="vt-sort-option active" data-sort="custom">Default order</button>
          <button class="vt-sort-option" data-sort="newest">Newest</button>
          <button class="vt-sort-option" data-sort="oldest">Oldest</button>
          <button class="vt-sort-option" data-sort="alphabetical">Alphabetical</button>
        </div>
        <div class="vt-popover vt-settings-popover">
          <div class="vt-panel-layout-note">The native Side Panel reserves browser space. Chrome controls its actual side and outer width; use the Side panel menu to change those.</div>
          <div class="vt-popover-row">
            <div class="vt-popover-label">Sidebar side</div>
            <div class="vt-segmented vt-side-seg">
              <button data-val="left">Left</button>
              <button data-val="right">Right</button>
            </div>
            <div class="vt-panel-side-status" aria-live="polite">
              <span class="vt-panel-side-message"></span>
              <button type="button" class="vt-side-settings-link">Open Chrome appearance settings</button>
            </div>
          </div>
          <div class="vt-popover-row">
            <div class="vt-popover-label">Search bar position</div>
            <div class="vt-segmented vt-search-pos-seg">
              <button data-val="top">Top</button>
              <button data-val="bottom">Bottom</button>
            </div>
          </div>
          <div class="vt-popover-row">
            <div class="vt-popover-label">Font size</div>
            <input type="range" min="10" max="18" step="1" class="vt-slider vt-font-size-slider">
          </div>
          <div class="vt-popover-row vt-color-row">
            <div class="vt-popover-label">Font color</div>
            <input type="color" class="vt-font-color-picker">
            <input type="text" class="vt-hex-input vt-font-color-hex" maxlength="7" placeholder="#e7e8ec">
          </div>
          <div class="vt-popover-row">
            <label class="vt-toggle-row">
              <span>New tab plus button</span>
              <input type="checkbox" class="vt-new-tab-toggle">
            </label>
          </div>
          <div class="vt-popover-row">
            <label class="vt-toggle-row">
              <span>Show tab dates and open time</span>
              <input type="checkbox" class="vt-tab-time-toggle">
            </label>
          </div>
          <div class="vt-popover-row">
            <div class="vt-popover-label vt-history-label">
              <span>Deleted group history</span>
              <button type="button" class="vt-clear-history-btn" disabled>Clear history</button>
            </div>
            <div class="vt-deleted-groups" aria-live="polite"></div>
          </div>
          <div class="vt-popover-row">
            <div class="vt-popover-label">Side bar shortcut</div>
            <div class="vt-shortcut-hint"><a href="chrome://extensions/shortcuts" target="_blank" rel="noopener" class="vt-shortcut-link">Activate the extension shortcut</a></div>
            <div class="vt-shortcut-status" aria-live="polite"></div>
          </div>
        </div>
      </div>
      <div class="vt-search-wrap">
        <span class="vt-search-icon">${ICONS.search}</span>
        <input type="text" class="vt-search" placeholder="Search tabs…">
      </div>
      <div class="vt-list"></div>
      <button class="vt-new-tab-btn" title="New tab">${ICONS.plus}</button>
      <div class="vt-menu"></div>
      <div class="vt-modal-overlay">
        <div class="vt-modal"></div>
      </div>
    </div>
  `;

  const panelEl = root.querySelector(".vt-panel");
  const listEl = root.querySelector(".vt-list");
  const searchWrapEl = root.querySelector(".vt-search-wrap");
  const searchInputEl = root.querySelector(".vt-search");
  const settingsPopoverEl = root.querySelector(".vt-settings-popover");
  const sortPopoverEl = root.querySelector(".vt-sort-popover");
  const menuEl = root.querySelector(".vt-menu");
  const modalOverlayEl = root.querySelector(".vt-modal-overlay");
  const modalEl = root.querySelector(".vt-modal");
  const tabCountEl = root.querySelector(".vt-tab-count");
  const deletedGroupsEl = root.querySelector(".vt-deleted-groups");
  const clearHistoryBtnEl = root.querySelector(".vt-clear-history-btn");
  const sideStatusEl = root.querySelector(".vt-panel-side-status");
  const sideMessageEl = root.querySelector(".vt-panel-side-message");
  const sideSettingsBtnEl = root.querySelector(".vt-side-settings-link");
  const tabTimeToggleEl = root.querySelector(".vt-tab-time-toggle");
  const newTabBtnEl = root.querySelector(".vt-new-tab-btn");

  panelEl.classList.add("native-panel");

  (document.body || document.documentElement).appendChild(hostEl);

  // ---------- messaging with background ----------
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function queryTabs(queryInfo) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query(queryInfo, (tabs) => {
          if (chrome.runtime.lastError) {
            resolve([]);
            return;
          }
          resolve(tabs || []);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  async function getPanelWindowId() {
    const [tab] = await queryTabs({ active: true, lastFocusedWindow: true });
    return tab?.windowId ?? null;
  }

  async function requestState() {
    panelWindowId = await getPanelWindowId();
    const res = await send({ type: "REQUEST_STATE", windowId: panelWindowId });
    if (!res) return;
    state.open = true;
    state.tabs = res.tabs;
    state.groups = res.groups;
    state.groupOrder = res.groupOrder || Object.keys(res.groups || {});
    state.layoutOrder = Array.isArray(res.layoutOrder) ? res.layoutOrder : state.layoutOrder;
    state.deletedGroups = Array.isArray(res.deletedGroups) ? res.deletedGroups : state.deletedGroups;
    state.settings = { ...state.settings, ...res.settings };
    if (res.focusedGroupId && state.groups[res.focusedGroupId]) {
      state.activeGroupId = res.focusedGroupId;
      state.activeView = "group";
    }
    applyOpenState();
    applySettings();
    render();
    setTimeout(() => searchInputEl.focus({ preventScroll: true }), 0);
  }
  applyOpenState();
  applySettings();
  render();
  requestState().catch((error) => showStartupError(error));
  setInterval(() => {
    if (state.settings.showTabTimes) render();
  }, 30000);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "PING") {
      sendResponse({ pong: true });
      return; // synchronous response, no need to keep channel open
    }
    if (msg.windowId !== undefined && panelWindowId !== null && msg.windowId !== panelWindowId) return;
    switch (msg.type) {
      case "SET_SIDEBAR_STATE":
        state.open = msg.open !== false;
        applyOpenState();
        break;
      case "TABS_UPDATED":
        state.tabs = msg.tabs;
        state.groups = msg.groups;
        state.groupOrder = msg.groupOrder || state.groupOrder;
        state.layoutOrder = Array.isArray(msg.layoutOrder) ? msg.layoutOrder : state.layoutOrder;
        if (Array.isArray(msg.deletedGroups)) state.deletedGroups = msg.deletedGroups;
        if (msg.focusedGroupId && state.groups[msg.focusedGroupId]) {
          state.activeGroupId = msg.focusedGroupId;
          state.activeView = "group";
        } else if (state.activeView === "group" && !msg.focusedGroupId) {
          state.activeGroupId = null;
          state.activeView = "default";
        }
        render();
        break;
      case "GROUPS_UPDATED":
        state.groups = msg.groups;
        state.groupOrder = msg.groupOrder || state.groupOrder;
        state.layoutOrder = Array.isArray(msg.layoutOrder) ? msg.layoutOrder : state.layoutOrder;
        if (Array.isArray(msg.deletedGroups)) state.deletedGroups = msg.deletedGroups;
        if (msg.focusedGroupId && state.activeGroupId === msg.focusedGroupId && state.groups[msg.focusedGroupId]) {
          send({
            type: "FOCUS_GROUP",
            groupId: msg.focusedGroupId,
            tabIds: state.groups[msg.focusedGroupId].tabIds,
            windowId: panelWindowId
          });
        }
        render();
        break;
      case "SETTINGS_UPDATED":
        state.settings = msg.settings;
        applySettings();
        render();
        break;
    }
  });

  function applyOpenState() {
    panelEl.classList.toggle("open", IS_NATIVE_SIDE_PANEL || state.open);
  }

  function applySettings() {
    const s = state.settings;
    panelEl.classList.toggle("pos-left", s.position === "left");
    panelEl.classList.toggle("pos-right", s.position !== "left");
    panelEl.dataset.theme = s.theme;
    const knob = root.querySelector(".vt-theme-switch .vt-knob");
    if (knob) knob.innerHTML = s.theme === "dark" ? ICONS.moon : ICONS.sun;
    panelEl.style.setProperty("--vt-user-font-size", `${s.fontSize || 13}px`);
    panelEl.style.setProperty("--vt-user-font-color", s.fontColor || "var(--vt-text)");
    searchWrapEl.classList.toggle("at-bottom", s.searchPosition === "bottom");
    // reorder: list is order 2 always; search order 1 or 3
    searchWrapEl.style.order = s.searchPosition === "bottom" ? "3" : "1";
    listEl.style.order = "2";
    // reflect popover controls
    root.querySelectorAll(".vt-search-pos-seg button").forEach((b) =>
      b.classList.toggle("active", b.dataset.val === s.searchPosition)
    );
    root.querySelectorAll(".vt-side-seg button").forEach((b) =>
      b.classList.toggle("active", b.dataset.val === (s.position === "left" ? "left" : "right"))
    );
    root.querySelector(".vt-font-size-slider").value = s.fontSize || 13;
    const fontColor = normalizeHexColor(s.fontColor) || (s.theme === "dark" ? "#e7e8ec" : "#1c1d22");
    root.querySelector(".vt-font-color-picker").value = fontColor;
    root.querySelector(".vt-font-color-hex").value = s.fontColor || "";
    root.querySelector(".vt-new-tab-toggle").checked = s.showNewTabButton !== false;
    tabTimeToggleEl.checked = s.showTabTimes === true;
    newTabBtnEl.classList.toggle("hidden", s.showNewTabButton === false);
    updateNativeSideStatus();
    panelEl.style.display = "flex";
    panelEl.style.flexDirection = "column";
  }

  async function updateNativeSideStatus() {
    if (!sideStatusEl) return;
    const setSideSelection = (side) => root.querySelectorAll(".vt-side-seg button").forEach((button) =>
      button.classList.toggle("active", button.dataset.val === side)
    );
    if (typeof chrome.sidePanel?.getLayout !== "function") {
      setSideSelection(state.settings.position === "left" ? "left" : "right");
      sideMessageEl.textContent = "Use Chrome's Side panel menu to move it.";
      return;
    }
    try {
      const layout = await chrome.sidePanel.getLayout();
      const side = layout?.side === "left" ? "left" : "right";
      setSideSelection(side);
      sideMessageEl.textContent = `Chrome side: ${side}. Chrome controls this setting.`;
    } catch (e) {
      setSideSelection(state.settings.position === "left" ? "left" : "right");
      sideMessageEl.textContent = "Use Chrome's Side panel menu to move it.";
    }
  }

  function normalizeHexColor(value) {
    const raw = String(value || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
    return "";
  }

  function saveSettings(patch) {
    state.settings = { ...state.settings, ...patch };
    applySettings();
    send({ type: "SETTINGS_CHANGED", settings: patch });
  }

  // ---------- header interactions ----------
  root.querySelector(".vt-theme-switch").addEventListener("click", () => {
    saveSettings({ theme: state.settings.theme === "dark" ? "light" : "dark" });
  });
  root.querySelector(".vt-settings-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    sortPopoverEl.classList.remove("open");
    settingsPopoverEl.classList.toggle("open");
  });
  root.querySelector(".vt-filter-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPopoverEl.classList.remove("open");
    sortPopoverEl.classList.toggle("open");
  });
  root.querySelectorAll(".vt-view-tabs button").forEach((b) =>
    b.addEventListener("click", async () => {
      // Default/Tabs/Groups are the escape hatch from a focused group. This
      // also works after the panel was closed and reopened with the browser
      // still keeping the selected group's tabs visible.
      if (state.activeGroupId || state.activeView === "group" || b.dataset.view === "default") {
        const response = await send({ type: "CLEAR_GROUP_FOCUS", windowId: panelWindowId });
        if (!response || response.ok === false) return;
      }
      state.activeView = b.dataset.view;
      state.activeGroupId = null;
      root.querySelectorAll(".vt-view-tabs button").forEach((n) => n.classList.toggle("active", n === b));
      render();
    })
  );
  root.querySelectorAll(".vt-sort-option").forEach((b) =>
    b.addEventListener("click", () => {
      state.sortMode = b.dataset.sort;
      root.querySelectorAll(".vt-sort-option").forEach((n) => n.classList.toggle("active", n === b));
      sortPopoverEl.classList.remove("open");
      render();
    })
  );
  root.querySelectorAll(".vt-search-pos-seg button").forEach((b) =>
    b.addEventListener("click", () => saveSettings({ searchPosition: b.dataset.val }))
  );
  root.querySelectorAll(".vt-side-seg button").forEach((b) =>
    b.addEventListener("click", async () => {
      const side = b.dataset.val === "left" ? "left" : "right";
      saveSettings({ position: side });
      if (typeof chrome.sidePanel?.setLayout === "function") {
        try { await chrome.sidePanel.setLayout({ side }); } catch (e) {}
      } else {
        // Chrome versions that expose getLayout() do not expose a setter. Open
        // the browser's appearance page so the requested side can be changed
        // in Chrome's own Side panel controls.
        await send({ type: "OPEN_PANEL_SETTINGS", windowId: panelWindowId });
      }
      updateNativeSideStatus();
    })
  );
  sideSettingsBtnEl.addEventListener("click", () => {
    send({ type: "OPEN_PANEL_SETTINGS", windowId: panelWindowId });
  });
  root.querySelector(".vt-font-size-slider").addEventListener("input", (e) => {
    saveSettings({ fontSize: parseInt(e.target.value, 10) });
  });
  root.querySelector(".vt-font-color-picker").addEventListener("input", (e) => {
    saveSettings({ fontColor: e.target.value });
  });
  root.querySelector(".vt-font-color-hex").addEventListener("change", (e) => {
    const color = normalizeHexColor(e.target.value);
    if (color) saveSettings({ fontColor: color });
    else saveSettings({ fontColor: "" });
  });
  root.querySelector(".vt-new-tab-toggle").addEventListener("change", (e) => {
    saveSettings({ showNewTabButton: e.target.checked });
  });
  tabTimeToggleEl.addEventListener("change", (e) => {
    saveSettings({ showTabTimes: e.target.checked });
    render();
  });
  function createTabForCurrentView() {
    const groupId = state.activeView === "group" && state.groups[state.activeGroupId]
      ? state.activeGroupId
      : null;
    return send({ type: "CREATE_TAB", windowId: panelWindowId, groupId });
  }
  newTabBtnEl.addEventListener("click", createTabForCurrentView);
  root.querySelector(".vt-shortcut-link").addEventListener("click", (e) => {
    e.preventDefault();
    send({ type: "OPEN_SHORTCUT_SETTINGS" });
  });
  document.addEventListener("click", (e) => {
    const path = e.composedPath();
    if (!path.includes(settingsPopoverEl) && !path.includes(root.querySelector(".vt-settings-btn"))) {
      settingsPopoverEl.classList.remove("open");
    }
    if (!path.includes(sortPopoverEl) && !path.includes(root.querySelector(".vt-filter-btn"))) {
      sortPopoverEl.classList.remove("open");
    }
    if (!path.includes(menuEl)) closeMenu();
  }, true);

  searchInputEl.addEventListener("input", (e) => {
    state.filter = e.target.value.trim().toLowerCase();
    render();
  });
  searchInputEl.addEventListener("keydown", (e) => e.stopPropagation());

  // Ctrl+T on Windows/Linux and Cmd+T on macOS are browser shortcuts, so the
  // background tab-created handler also adopts the new tab. This listener
  // covers the case where the native side-panel document receives the key
  // event directly and keeps the plus button and keyboard path identical.
  document.addEventListener("keydown", (e) => {
    if (e.repeat || (!e.ctrlKey && !e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key || "").toLowerCase() !== "t") return;
    if (state.activeView !== "group" || !state.groups[state.activeGroupId]) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    createTabForCurrentView();
  }, true);

  // ---------- resize handle ----------
  const resizeHandle = root.querySelector(".vt-resize-handle");
  let resizing = false;
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizing = true;
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const rect = panelEl.getBoundingClientRect();
    let w;
    if (state.settings.position === "left") {
      w = e.clientX;
    } else {
      w = window.innerWidth - e.clientX;
    }
    w = Math.max(220, Math.min(480, w));
    panelEl.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = "";
    saveSettings({ width: parseInt(panelEl.style.width, 10) });
  });

  // ---------- escape closes sidebar ----------
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.open) {
      if (menuEl.classList.contains("open")) return closeMenu();
      if (modalOverlayEl.classList.contains("open")) return closeModal();
      send({ type: "CLOSE_SIDEBAR" });
    }
  });

  // ---------- rendering ----------
  function matchesFilter(tab) {
    if (!state.filter) return true;
    const title = String(tab.title || "").toLowerCase();
    const url = String(tab.url || "").toLowerCase();
    return title.includes(state.filter) || url.includes(state.filter);
  }

  function getOrderedGroups() {
    const ids = state.groupOrder.length ? state.groupOrder : Object.keys(state.groups);
    const seen = new Set();
    const ordered = [];
    ids.forEach((id) => {
      if (state.groups[id] && !seen.has(id)) {
        ordered.push(state.groups[id]);
        seen.add(id);
      }
    });
    Object.values(state.groups).forEach((group) => {
      if (!seen.has(group.id)) ordered.push(group);
    });
    return ordered;
  }

  function sortTabs(tabs) {
    const items = [...tabs];
    switch (state.sortMode) {
      case "newest":
        return items.sort((a, b) =>
          (Number(b.createdAt) || Number(b.lastAccessed) || b.id) -
          (Number(a.createdAt) || Number(a.lastAccessed) || a.id)
        );
      case "oldest":
        return items.sort((a, b) =>
          (Number(a.createdAt) || Number(a.lastAccessed) || a.id) -
          (Number(b.createdAt) || Number(b.lastAccessed) || b.id)
        );
      case "alphabetical":
        return items.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
      default:
        return items.sort((a, b) => a.index - b.index);
    }
  }

  function getCustomFlatTabs(tabsById, groupedIds) {
    const ordered = state.tabs
      .filter((tab) => !groupedIds.has(tab.id))
      .sort((a, b) => a.index - b.index);
    getOrderedGroups().forEach((group) => {
      group.tabIds.forEach((id) => {
        const tab = tabsById.get(id);
        if (tab) ordered.push(tab);
      });
    });
    return ordered;
  }

  function layoutToken(kind, id) {
    return `${kind}:${String(id)}`;
  }

  function getDefaultLayoutItems(tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]))) {
    const groupedIds = new Set();
    Object.values(state.groups).forEach((group) => {
      group.tabIds.forEach((id) => groupedIds.add(id));
    });

    const itemByToken = new Map();
    state.tabs.forEach((tab) => {
      if (!groupedIds.has(tab.id)) {
        itemByToken.set(layoutToken("tab", tab.id), { kind: "tab", tab });
      }
    });
    getOrderedGroups().forEach((group) => {
      itemByToken.set(layoutToken("group", group.id), { kind: "group", group });
    });

    const fallback = [
      ...state.tabs
        .filter((tab) => !groupedIds.has(tab.id))
        .sort((a, b) => a.index - b.index)
        .map((tab) => layoutToken("tab", tab.id)),
      ...getOrderedGroups().map((group) => layoutToken("group", group.id))
    ];
    const result = [];
    const seen = new Set();
    [...(Array.isArray(state.layoutOrder) ? state.layoutOrder : []), ...fallback].forEach((token) => {
      if (seen.has(token) || !itemByToken.has(token)) return;
      seen.add(token);
      result.push(itemByToken.get(token));
    });
    return result;
  }

  function mergeCurrentLayoutOrder(orderedTokens, currentTokens) {
    const currentSet = new Set(currentTokens);
    const next = [...orderedTokens];
    (state.layoutOrder || []).forEach((token) => {
      if (!currentSet.has(token) && !next.includes(token)) next.push(token);
    });
    return next;
  }

  async function reorderDefaultLayout(movingTokens, targetToken, event, targetEl) {
    const items = getDefaultLayoutItems();
    const currentTokens = items.map((item) =>
      item.kind === "group" ? layoutToken("group", item.group.id) : layoutToken("tab", item.tab.id)
    );
    const movingSet = new Set(movingTokens);
    const remaining = currentTokens.filter((token) => !movingSet.has(token));
    const targetIndex = remaining.indexOf(targetToken);
    if (targetIndex === -1) return null;
    const rect = targetEl.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const insertAt = Math.max(0, targetIndex + (after ? 1 : 0));
    const ordered = [...remaining];
    ordered.splice(insertAt, 0, ...movingTokens);
    state.layoutOrder = mergeCurrentLayoutOrder(ordered, currentTokens.concat(movingTokens));
    await send({ type: "REORDER_LAYOUT", layoutOrder: state.layoutOrder, windowId: panelWindowId });
    render();
    return ordered;
  }

  function updateViewButtons() {
    const activeView = state.activeView === "group" ? "default" : state.activeView;
    root.querySelectorAll(".vt-view-tabs button").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === activeView);
    });
  }

  function showGroupOnly(groupId) {
    if (!state.groups[groupId]) return;
    state.activeGroupId = groupId;
    state.activeView = "group";
    updateViewButtons();
    render();
    send({
      type: "FOCUS_GROUP",
      groupId,
      tabIds: state.groups[groupId].tabIds,
      windowId: panelWindowId
    });
  }

  function renderDeletedGroupHistory() {
    if (!deletedGroupsEl) return;
    if (clearHistoryBtnEl) clearHistoryBtnEl.disabled = state.deletedGroups.length === 0;
    deletedGroupsEl.replaceChildren();
    if (!state.deletedGroups.length) {
      const empty = document.createElement("div");
      empty.className = "vt-deleted-empty";
      empty.textContent = "No deleted groups";
      deletedGroupsEl.appendChild(empty);
      return;
    }

    state.deletedGroups.forEach((deletedGroup) => {
      const row = document.createElement("div");
      row.className = "vt-deleted-group-row";
      const details = document.createElement("div");
      details.className = "vt-deleted-group-details";
      details.innerHTML = `
        <span class="vt-deleted-group-name">${escapeHtml(deletedGroup.name || "Unnamed group")}</span>
        <span class="vt-deleted-group-meta">${Array.isArray(deletedGroup.tabIds) ? deletedGroup.tabIds.length : 0} tabs</span>
      `;
      const restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "vt-restore-group-btn";
      restoreButton.textContent = "Restore";
      restoreButton.addEventListener("click", async (e) => {
        e.stopPropagation();
        restoreButton.disabled = true;
        const response = await send({
          type: "RESTORE_DELETED_GROUP",
          historyId: deletedGroup.historyId || deletedGroup.id,
          windowId: panelWindowId
        });
        if (!response || response.ok === false) {
          restoreButton.disabled = false;
          restoreButton.textContent = "Try again";
        }
      });
      row.append(details, restoreButton);
      deletedGroupsEl.appendChild(row);
    });
  }

  clearHistoryBtnEl.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.deletedGroups.length) return;
    if (!window.confirm("Clear all deleted group history? This cannot be undone.")) return;

    clearHistoryBtnEl.disabled = true;
    clearHistoryBtnEl.textContent = "Clearing…";
    const response = await send({
      type: "CLEAR_DELETED_GROUP_HISTORY",
      windowId: panelWindowId
    });
    if (!response || response.ok === false) {
      clearHistoryBtnEl.disabled = false;
      clearHistoryBtnEl.textContent = "Try again";
      return;
    }
    state.deletedGroups = [];
    clearHistoryBtnEl.textContent = "Clear history";
    renderDeletedGroupHistory();
  });

  function buildGroupFilterBanner(group) {
    const banner = document.createElement("div");
    banner.className = "vt-group-filter-banner";
    banner.innerHTML = `
      <span>Showing <strong>${escapeHtml(group.name)}</strong></span>
      <button type="button">Show all</button>
    `;
    banner.querySelector("button").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const button = e.currentTarget;
      button.disabled = true;
      const response = await send({ type: "CLEAR_GROUP_FOCUS", windowId: panelWindowId });
      if (!response || response.ok === false) {
        button.disabled = false;
        return;
      }
      state.activeGroupId = null;
      state.activeView = "default";
      updateViewButtons();
      render();
    });
    return banner;
  }

  function buildHiddenGroupsDropdown(focusedGroupId, orderedGroups) {
    const hiddenGroups = orderedGroups.filter((group) => group.id !== focusedGroupId);
    const wrapper = document.createElement("div");
    wrapper.className = "vt-hidden-groups";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "vt-hidden-groups-toggle";
    toggle.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = "Hidden";
    const count = document.createElement("span");
    count.className = "vt-hidden-groups-count";
    count.textContent = String(hiddenGroups.length);
    const arrow = document.createElement("span");
    arrow.className = "vt-hidden-groups-arrow";
    arrow.textContent = "⌄";
    toggle.append(label, count, arrow);

    const list = document.createElement("div");
    list.className = "vt-hidden-groups-list";
    list.setAttribute("role", "menu");
    if (!hiddenGroups.length) {
      const empty = document.createElement("div");
      empty.className = "vt-hidden-groups-empty";
      empty.textContent = "No other groups";
      list.appendChild(empty);
    } else {
      hiddenGroups.forEach((group) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "vt-hidden-group-option";
        option.setAttribute("role", "menuitem");
        const dot = document.createElement("span");
        dot.className = "vt-hidden-group-dot";
        dot.style.background = group.color || "var(--vt-accent)";
        const name = document.createElement("span");
        name.className = "vt-hidden-group-name";
        name.textContent = group.name || "Unnamed group";
        const tabCount = document.createElement("span");
        tabCount.className = "vt-hidden-group-tab-count";
        tabCount.textContent = String(Array.isArray(group.tabIds) ? group.tabIds.length : 0);
        option.append(dot, name, tabCount);
        option.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          showGroupOnly(group.id);
        });
        list.appendChild(option);
      });
    }

    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = wrapper.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    wrapper.append(toggle, list);
    return wrapper;
  }

  function render() {
    const scrollTop = listEl.scrollTop;
    const fragment = document.createDocumentFragment();
    renderDeletedGroupHistory();
    tabCountEl.textContent = String(state.tabs.length);
    const tabsById = new Map(state.tabs.map((t) => [t.id, t]));
    const groupedIds = new Set();
    Object.values(state.groups).forEach((g) => g.tabIds.forEach((id) => groupedIds.add(id)));
    const groups = getOrderedGroups();

    const ungrouped = sortTabs(state.tabs.filter((t) => !groupedIds.has(t.id)));
    const visibleUngrouped = ungrouped.filter(matchesFilter);

    let anythingVisible = false;
    let activeView = state.activeView;
    let focusedGroup = state.activeGroupId ? state.groups[state.activeGroupId] : null;
    if (activeView === "group" && !focusedGroup) {
      send({ type: "CLEAR_GROUP_FOCUS", windowId: panelWindowId });
      state.activeView = "default";
      state.activeGroupId = null;
      activeView = "default";
    }
    updateViewButtons();

    if (activeView === "group" && focusedGroup) {
      fragment.appendChild(buildGroupFilterBanner(focusedGroup));
      fragment.appendChild(buildHiddenGroupsDropdown(focusedGroup.id, groups));
      const groupTabs = focusedGroup.tabIds.map((id) => tabsById.get(id)).filter(Boolean);
      const visible = state.sortMode === "custom"
        ? groupTabs.filter(matchesFilter)
        : sortTabs(groupTabs.filter(matchesFilter));
      if (visible.length) {
        fragment.appendChild(buildGroupEl(focusedGroup, groupTabs, visible, { forceExpanded: true }));
        anythingVisible = true;
      }
    } else if (activeView === "tabs") {
      const flatTabs = state.sortMode === "custom"
        ? getCustomFlatTabs(tabsById, groupedIds)
        : sortTabs(state.tabs);
      flatTabs.filter(matchesFilter).forEach((tab) => {
        fragment.appendChild(buildTabEl(tab, { dragContext: "all" }));
        anythingVisible = true;
      });
    } else if (activeView === "groups") {
      groups.forEach((g) => {
        const groupTabs = g.tabIds.map((id) => tabsById.get(id)).filter(Boolean);
        const groupMatches = state.filter && String(g.name || "").toLowerCase().includes(state.filter);
        if (state.filter && !groupMatches && !groupTabs.some(matchesFilter)) return;
        const visible = state.sortMode === "custom"
          ? (groupMatches ? groupTabs : groupTabs.filter(matchesFilter))
          : sortTabs(groupMatches ? groupTabs : groupTabs.filter(matchesFilter));
        fragment.appendChild(buildGroupEl(g, groupTabs, visible, { groupsOnly: true }));
        anythingVisible = true;
      });
    } else {
      const layoutItems = getDefaultLayoutItems(tabsById);
      const sortedUngrouped = state.sortMode === "custom"
        ? layoutItems.filter((item) => item.kind === "tab").map((item) => item.tab)
        : sortTabs(layoutItems.filter((item) => item.kind === "tab").map((item) => item.tab));
      let sortedTabIndex = 0;

      layoutItems.forEach((item) => {
        if (item.kind === "tab") {
          const tab = sortedUngrouped[sortedTabIndex++];
          if (!tab || !matchesFilter(tab)) return;
          fragment.appendChild(buildTabEl(tab, { dragContext: "ungrouped" }));
          anythingVisible = true;
          return;
        }

        const group = item.group;
        const groupTabs = group.tabIds.map((id) => tabsById.get(id)).filter(Boolean);
        const groupMatches = state.filter && String(group.name || "").toLowerCase().includes(state.filter);
        if (state.filter && !groupMatches && !groupTabs.some(matchesFilter)) return;
        const visible = state.sortMode === "custom"
          ? (groupMatches ? groupTabs : groupTabs.filter(matchesFilter))
          : sortTabs(groupMatches ? groupTabs : groupTabs.filter(matchesFilter));
        if (state.filter && visible.length === 0) return;
        fragment.appendChild(buildGroupEl(group, groupTabs, visible));
        anythingVisible = true;
      });
    }

    if (!anythingVisible) {
      const empty = document.createElement("div");
      empty.className = "vt-empty";
      empty.textContent = state.filter ? "No tabs match your search" : "No open tabs";
      fragment.appendChild(empty);
    }
    listEl.replaceChildren(fragment);
    requestAnimationFrame(() => { listEl.scrollTop = scrollTop; });
  }

  function faviconStyle(tab) {
    if (tab.favIconUrl && !tab.favIconUrl.startsWith("chrome://")) {
      return `background-image:url('${tab.favIconUrl.replace(/'/g, "%27")}')`;
    }
    return "";
  }

  function tabStatusMarkup(tab) {
    const loading = tab.loading || tab.status === "loading";
    const muted = tab.muted || tab.mutedInfo?.muted;
    if (loading) {
      return `<span class="vt-tab-indicator loading" title="Tab is loading">${ICONS.spinner}</span>`;
    }
    if (tab.audible) {
      return `<span class="vt-tab-indicator audible" title="Sound is playing">${muted ? ICONS.muted : ICONS.audio}</span>`;
    }
    if (muted) {
      return `<span class="vt-tab-indicator muted" title="Tab is muted">${ICONS.muted}</span>`;
    }
    return "";
  }

  function formatRelativeTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - (Number(timestamp) || Date.now()));
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.floor(days / 30);
    return `${months} mo${months === 1 ? "" : "s"} ago`;
  }

  function formatOpenDuration(timestamp) {
    const elapsed = Math.max(0, Date.now() - (Number(timestamp) || Date.now()));
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "Open <1 min";
    if (minutes < 60) return `Open ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return `Open ${hours} hr${hours === 1 ? "" : "s"}${remainingMinutes ? ` ${remainingMinutes} min` : ""}`;
    const days = Math.floor(hours / 24);
    return `Open ${days} day${days === 1 ? "" : "s"}`;
  }

  function buildTabEl(tab, options = {}) {
    const el = document.createElement("div");
    el.className = "vt-tab";
    if (tab.active) el.classList.add("active");
    if (tab.pinned) el.classList.add("pinned");
    if (state.selection.has(tab.id)) el.classList.add("selected");
    el.dataset.tabId = tab.id;
    el.draggable = true;
    el.dataset.dragContext = options.dragContext || "group";
    el.innerHTML = `
      <span class="vt-favicon-wrap">
        <span class="vt-favicon" style="${faviconStyle(tab)}"></span>
      </span>
      <div class="vt-title-wrap">
        <div class="vt-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</div>
        ${state.settings.showTabTimes ? `<div class="vt-tab-meta">Opened ${escapeHtml(formatRelativeTime(tab.createdAt))} · ${escapeHtml(formatOpenDuration(tab.createdAt))}</div>` : ""}
      </div>
      <span class="vt-tab-state">${tabStatusMarkup(tab)}</span>
      <button class="vt-close-btn">${ICONS.close}</button>
    `;
    el.addEventListener("click", (e) => onTabClick(e, tab));
    el.addEventListener("dragstart", (e) => onTabDragStart(e, tab, options));
    el.addEventListener("dragover", (e) => onTabDragOver(e, tab));
    el.addEventListener("drop", (e) => onTabDrop(e, tab, options));
    el.addEventListener("dragend", clearDragClasses);
    el.querySelector(".vt-close-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "CLOSE_TABS", tabIds: [tab.id] });
    });
    return el;
  }

  function buildGroupEl(group, allGroupTabs, visibleTabs, options = {}) {
    const el = document.createElement("div");
    el.className = "vt-group" + (group.collapsed && !options.forceExpanded && !options.groupsOnly ? " collapsed" : "");
    el.style.setProperty("--vt-group-color", group.color);
    el.dataset.groupId = group.id;
    el.draggable = false;
    el.addEventListener("dragover", (e) => onGroupDragOver(e, group));
    el.addEventListener("drop", (e) => onGroupDrop(e, group, el));

    const header = document.createElement("div");
    header.className = "vt-group-header";
    header.draggable = state.activeView === "default" || state.activeView === "groups";
    header.innerHTML = `
      <button type="button" class="vt-group-chevron" aria-label="Collapse or expand group">${ICONS.chevron}</button>
      <span class="vt-group-dot"></span>
      <span class="vt-group-name">${escapeHtml(group.name)}</span>
      <span class="vt-group-count">${allGroupTabs.length}</span>
    `;
    const chevron = header.querySelector(".vt-group-chevron");
    const stopChevronEvent = (e) => e.stopPropagation();
    chevron.addEventListener("pointerdown", stopChevronEvent);
    chevron.addEventListener("mousedown", stopChevronEvent);
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "UPDATE_GROUP", groupId: group.id, patch: { collapsed: !group.collapsed } });
    });

    // Only the group name activates group-only mode. Keeping this separate
    // from the draggable header makes the collapse control impossible to
    // confuse with the group filter action.
    const groupName = header.querySelector(".vt-group-name");
    groupName.tabIndex = 0;
    groupName.setAttribute("role", "button");
    groupName.addEventListener("click", (e) => {
      e.stopPropagation();
      showGroupOnly(group.id);
    });
    groupName.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      showGroupOnly(group.id);
    });
    header.addEventListener("dragstart", (e) => onGroupDragStart(e, group));
    header.addEventListener("dragend", clearDragClasses);
    el.appendChild(header);

    const body = document.createElement("div");
    body.className = "vt-group-body";
    const displayTabs = state.sortMode === "custom" && !state.filter ? allGroupTabs : visibleTabs;
    displayTabs.forEach((tab) => body.appendChild(buildTabEl(tab, {
      dragContext: "group",
      groupId: group.id
    })));
    body.addEventListener("dragover", (e) => onGroupBodyDragOver(e, group, el));
    body.addEventListener("drop", (e) => onGroupBodyDrop(e, group));
    el.appendChild(body);

    return el;
  }

  function setSortMode(mode) {
    state.sortMode = mode;
    root.querySelectorAll(".vt-sort-option").forEach((n) => {
      n.classList.toggle("active", n.dataset.sort === mode);
    });
  }

  function dragPayload(e) {
    try {
      return JSON.parse(e.dataTransfer.getData("application/json") || "{}");
    } catch (error) {
      return {};
    }
  }

  function onTabDragStart(e, tab) {
    const selected = state.selection.has(tab.id) ? Array.from(state.selection) : [tab.id];
    activeDrag = {
      type: "tabs",
      tabIds: selected.map(Number),
      sourceGroupId: findGroupForTab(tab.id)?.id || ""
    };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/json", JSON.stringify({
      type: "tabs",
      tabIds: activeDrag.tabIds,
      sourceGroupId: activeDrag.sourceGroupId
    }));
    e.currentTarget.classList.add("dragging");
  }

  function onGroupDragStart(e, group) {
    if (state.activeView !== "default" && state.activeView !== "groups") return;
    activeDrag = { type: "group", groupId: group.id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/json", JSON.stringify({ type: "group", groupId: group.id }));
    e.currentTarget.closest(".vt-group")?.classList.add("dragging");
  }

  function markDragTarget(target) {
    if (dragOverEl && dragOverEl !== target) dragOverEl.classList.remove("drag-over");
    dragOverEl = target;
    if (target) target.classList.add("drag-over");
  }

  function onTabDragOver(e, tab) {
    if (!activeDrag || (activeDrag.type !== "tabs" && activeDrag.type !== "group")) return;
    if (activeDrag.type === "group" && (
      state.activeView !== "default" || e.currentTarget.dataset.dragContext !== "ungrouped"
    )) return;
    e.preventDefault();
    e.stopPropagation();
    if (activeDrag.type === "tabs" && activeDrag.tabIds.includes(tab.id)) {
      markDragTarget(null);
      return;
    }
    markDragTarget(e.currentTarget);
  }

  function onGroupDragOver(e, group) {
    if (!activeDrag || (activeDrag.type !== "tabs" && activeDrag.type !== "group")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (activeDrag.type === "group" && activeDrag.groupId === group.id) {
      markDragTarget(null);
      return;
    }
    markDragTarget(e.currentTarget);
  }

  async function onTabDrop(e, targetTab, options = {}) {
    e.preventDefault();
    e.stopPropagation();
    const data = activeDrag || dragPayload(e);
    clearDragClasses();
    if (data.type === "group") {
      if (state.activeView === "default" && options.dragContext === "ungrouped") {
        await reorderDefaultLayout(
          [layoutToken("group", data.groupId)],
          layoutToken("tab", targetTab.id),
          e,
          e.currentTarget
        );
      }
      return;
    }
    if (data.type !== "tabs" || !Array.isArray(data.tabIds) || data.tabIds.includes(targetTab.id)) return;
    setSortMode("custom");

    const moving = data.tabIds.map(Number).filter(Number.isInteger);
    if (state.activeView === "default" && options.dragContext === "ungrouped") {
      await reorderDefaultLayout(
        moving.map((id) => layoutToken("tab", id)),
        layoutToken("tab", targetTab.id),
        e,
        e.currentTarget
      );
    }

    const targetGroup = findGroupForTab(targetTab.id);
    if (targetGroup) {
      const ids = data.tabIds.map(Number).filter(Number.isInteger);
      const nextOrder = targetGroup.tabIds.filter((id) => !ids.includes(id));
      const targetIndex = nextOrder.indexOf(targetTab.id);
      if (targetIndex === -1) return;
      const after = e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2;
      const insertAt = Math.max(0, targetIndex + (after ? 1 : 0));
      nextOrder.splice(insertAt, 0, ...ids);
      await send({ type: "ADD_TABS_TO_GROUP", groupId: targetGroup.id, tabIds: ids });
      await send({ type: "REORDER_GROUP_TABS", groupId: targetGroup.id, tabIds: nextOrder });
      return;
    }

    if (moving.some((id) => findGroupForTab(id))) {
      await send({ type: "REMOVE_TABS_FROM_GROUP", tabIds: moving });
    }
    const remaining = state.tabs.filter((tab) => !moving.includes(tab.id));
    const targetIndex = remaining.findIndex((tab) => tab.id === targetTab.id);
    if (targetIndex === -1) return;
    const after = e.clientY > e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2;
    const insertAt = Math.max(0, targetIndex + (after ? 1 : 0));
    for (let i = 0; i < moving.length; i++) {
      await send({ type: "MOVE_TAB", tabId: moving[i], index: insertAt + i });
    }
  }

  function onGroupBodyDragOver(e, group, groupEl) {
    if (!activeDrag) return;
    e.preventDefault();
    e.stopPropagation();
    if (activeDrag.type === "group") markDragTarget(groupEl);
    else if (activeDrag.type === "tabs") markDragTarget(e.currentTarget);
  }

  async function onGroupBodyDrop(e, targetGroup) {
    e.preventDefault();
    e.stopPropagation();
    const data = activeDrag || dragPayload(e);
    if (data.type === "group") {
      await onGroupDrop(e, targetGroup, e.currentTarget.closest(".vt-group"), data);
      return;
    }
    clearDragClasses();
    if (data.type !== "tabs" || !Array.isArray(data.tabIds)) return;
    setSortMode("custom");
    const ids = data.tabIds.map(Number).filter(Number.isInteger);
    const nextOrder = targetGroup.tabIds.filter((id) => !ids.includes(id));
    nextOrder.push(...ids);
    await send({ type: "ADD_TABS_TO_GROUP", groupId: targetGroup.id, tabIds: ids });
    await send({ type: "REORDER_GROUP_TABS", groupId: targetGroup.id, tabIds: nextOrder });
  }

  async function onGroupDrop(e, targetGroup, targetEl = null, suppliedData = null) {
    e.preventDefault();
    e.stopPropagation();
    const data = suppliedData || activeDrag || dragPayload(e);
    clearDragClasses();
    if (data.type === "tabs" && Array.isArray(data.tabIds)) {
      const ids = data.tabIds.map(Number).filter(Number.isInteger);
      await send({ type: "ADD_TABS_TO_GROUP", groupId: targetGroup.id, tabIds: ids });
      return;
    }
    if (data.type !== "group" || data.groupId === targetGroup.id) return;

    if (state.activeView === "default") {
      const ordered = await reorderDefaultLayout(
        [layoutToken("group", data.groupId)],
        layoutToken("group", targetGroup.id),
        e,
        targetEl || e.currentTarget
      );
      if (!ordered) return;
      const nextGroupOrder = ordered
        .filter((token) => token.startsWith("group:"))
        .map((token) => token.slice("group:".length));
      state.groupOrder = nextGroupOrder;
      await send({ type: "REORDER_GROUPS", groupOrder: nextGroupOrder, windowId: panelWindowId });
      return;
    }

    const order = getOrderedGroups().map((g) => g.id).filter((id) => id !== data.groupId);
    const rect = (targetEl || e.currentTarget).getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const targetIndex = order.indexOf(targetGroup.id);
    const insertAt = Math.max(0, targetIndex + (after ? 1 : 0));
    order.splice(insertAt, 0, data.groupId);
    state.groupOrder = order;
    await send({ type: "REORDER_GROUPS", groupOrder: order });
    render();
  }

  function clearDragClasses() {
    root.querySelectorAll(".dragging, .drag-over").forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
    activeDrag = null;
    dragOverEl = null;
  }

  listEl.addEventListener("contextmenu", (e) => {
    const tabEl = e.target.closest("[data-tab-id]");
    if (tabEl) {
      const tab = state.tabs.find((item) => item.id === Number(tabEl.dataset.tabId));
      if (tab) onTabContextMenu(e, tab);
      return;
    }
    const groupEl = e.target.closest("[data-group-id]");
    if (groupEl) {
      const group = state.groups[groupEl.dataset.groupId];
      if (group) onGroupContextMenu(e, group);
    }
  }, true);

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ---------- selection & click behavior ----------
  function onTabClick(e, tab) {
    if (e.metaKey || e.ctrlKey) {
      if (state.selection.has(tab.id)) state.selection.delete(tab.id);
      else state.selection.add(tab.id);
      state.lastClickedId = tab.id;
      render();
      return;
    }
    if (e.shiftKey && state.lastClickedId !== null) {
      const orderedIds = getVisibleOrderedIds();
      const a = orderedIds.indexOf(state.lastClickedId);
      const b = orderedIds.indexOf(tab.id);
      if (a !== -1 && b !== -1) {
        const [start, end] = a < b ? [a, b] : [b, a];
        for (let i = start; i <= end; i++) state.selection.add(orderedIds[i]);
        render();
        return;
      }
    }
    // plain click: switch to tab
    state.selection.clear();
    state.lastClickedId = tab.id;
    send({ type: "ACTIVATE_TAB", tabId: tab.id });
  }

  function getVisibleOrderedIds() {
    return Array.from(listEl.querySelectorAll("[data-tab-id]")).map((n) => parseInt(n.dataset.tabId, 10));
  }

  // ---------- context menus ----------
  function closeMenu() {
    menuEl.classList.remove("open");
    menuEl.innerHTML = "";
  }

  function positionMenu(e) {
    // The menu is positioned inside the native panel. Display it before
    // measuring so long menus can be clamped to the panel and scrolled.
    menuEl.style.left = "0px";
    menuEl.style.top = "0px";
    menuEl.scrollTop = 0;
    menuEl.classList.add("open");

    const margin = 8;
    const panelRect = panelEl.getBoundingClientRect();
    const panelWidth = panelRect.width || window.innerWidth || 0;
    const panelHeight = panelRect.height || window.innerHeight || 0;
    const availableHeight = Math.max(80, panelHeight - margin * 2);
    menuEl.style.maxHeight = `${Math.min(560, availableHeight)}px`;
    const menuRect = menuEl.getBoundingClientRect();
    const localX = e.clientX - panelRect.left;
    const localY = e.clientY - panelRect.top;
    const maxX = Math.max(margin, panelWidth - menuRect.width - margin);
    const maxY = Math.max(margin, panelHeight - menuRect.height - margin);
    const x = Math.min(Math.max(localX, margin), maxX);
    const y = Math.min(Math.max(localY, margin), maxY);

    menuEl.style.left = x + "px";
    menuEl.style.top = y + "px";
  }

  function menuItem(label, onClick, opts = {}) {
    const item = document.createElement("div");
    item.className = "vt-menu-item" + (opts.danger ? " danger" : "");
    item.textContent = label;
    item.addEventListener("click", () => {
      closeMenu();
      onClick();
    });
    return item;
  }

  function menuSep() {
    const sep = document.createElement("div");
    sep.className = "vt-menu-sep";
    return sep;
  }

  function moveToMenuItem(tabIds) {
    const wrap = document.createElement("div");
    wrap.className = "vt-menu-submenu";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "vt-menu-item vt-menu-submenu-trigger";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const triggerLabel = document.createElement("span");
    triggerLabel.textContent = "Move to";
    const triggerArrow = document.createElement("span");
    triggerArrow.className = "vt-menu-submenu-arrow";
    triggerArrow.textContent = "›";
    trigger.append(triggerLabel, triggerArrow);

    const options = document.createElement("div");
    options.className = "vt-menu-submenu-options";
    options.setAttribute("role", "menu");
    const groups = getOrderedGroups();
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "vt-menu-group-empty";
      empty.textContent = "No groups yet";
      options.appendChild(empty);
    } else {
      groups.forEach((group) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "vt-menu-group-option";
        option.setAttribute("role", "menuitem");
        const dot = document.createElement("span");
        dot.className = "vt-menu-group-dot";
        dot.style.background = group.color || "var(--vt-accent)";
        const name = document.createElement("span");
        name.className = "vt-menu-group-option-name";
        name.textContent = group.name || "Unnamed group";
        const alreadyThere = tabIds.every((id) => group.tabIds.includes(id));
        const check = document.createElement("span");
        check.className = "vt-menu-group-check";
        check.textContent = alreadyThere ? "✓" : "";
        option.append(dot, name, check);
        option.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          send({
            type: "MOVE_TABS_TO_GROUP",
            groupId: group.id,
            tabIds: [...tabIds],
            windowId: panelWindowId
          });
        });
        options.appendChild(option);
      });
    }

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = wrap.classList.toggle("open");
      trigger.setAttribute("aria-expanded", String(open));
    });
    wrap.append(trigger, options);
    return wrap;
  }

  function onTabClick_selectForMenu(tab) {
    if (!state.selection.has(tab.id)) {
      state.selection = new Set([tab.id]);
      render();
    }
  }

  function onTabContextMenu(e, tab) {
    e.preventDefault();
    e.stopPropagation();
    onTabClick_selectForMenu(tab);
    const ids = Array.from(state.selection);
    const inGroup = findGroupForTab(tab.id);
    const sortedTabs = [...state.tabs].sort((a, b) => a.index - b.index);
    const aboveIds = sortedTabs.filter((item) => item.index < tab.index).map((item) => item.id);
    const belowIds = sortedTabs.filter((item) => item.index > tab.index).map((item) => item.id);
    const allIds = sortedTabs.map((item) => item.id);

    menuEl.innerHTML = "";
    menuEl.appendChild(menuItem("Rename Tab (sidebar only)", () => openRenameTabModal(tab)));
    menuEl.appendChild(menuItem(tab.muted ? "Unmute Tab" : "Mute Tab", () => {
      send({ type: "MUTE_TABS", tabIds: ids, muted: !tab.muted });
    }));
    menuEl.appendChild(menuSep());
    menuEl.appendChild(menuItem(ids.length > 1 ? `Reload ${ids.length} Selected Tabs` : "Reload Tab", () => {
      send({ type: "RELOAD_TABS", tabIds: ids });
    }));
    menuEl.appendChild(menuItem("Reload All Tabs", () => {
      send({ type: "RELOAD_TABS", tabIds: allIds });
    }));
    menuEl.appendChild(menuItem(ids.length > 1 ? "Bookmark Selected Tabs" : "Bookmark Tab", () => {
      send({ type: "BOOKMARK_TABS", tabIds: ids });
    }));
    menuEl.appendChild(menuSep());
    menuEl.appendChild(
      menuItem(ids.length > 1 ? `Group ${ids.length} Tabs…` : "Group Tab…", () => openGroupModal(ids))
    );
    menuEl.appendChild(moveToMenuItem(ids));
    if (inGroup) {
      menuEl.appendChild(menuItem("Show Only This Group", () => showGroupOnly(inGroup.id)));
      menuEl.appendChild(menuItem("Remove from Group", () => {
        send({ type: "REMOVE_TABS_FROM_GROUP", tabIds: ids });
      }));
    }
    menuEl.appendChild(menuSep());
    menuEl.appendChild(menuItem(tab.pinned ? "Unpin Tab" : "Pin Tab", () => {
      send({ type: "PIN_TABS", tabIds: ids, pinned: !tab.pinned });
    }));
    menuEl.appendChild(menuItem("Duplicate Tab", () => {
      send({ type: "DUPLICATE_TAB", tabId: tab.id });
    }));
    menuEl.appendChild(menuSep());
    if (aboveIds.length) {
      menuEl.appendChild(menuItem(`Close All Tabs Above (${aboveIds.length})`, () => {
        send({ type: "CLOSE_TABS", tabIds: aboveIds });
      }, { danger: true }));
    }
    if (belowIds.length) {
      menuEl.appendChild(menuItem(`Close All Tabs Below (${belowIds.length})`, () => {
        send({ type: "CLOSE_TABS", tabIds: belowIds });
      }, { danger: true }));
    }
    menuEl.appendChild(
      menuItem(ids.length > 1 ? `Close ${ids.length} Tabs` : "Close Tab", () => {
        send({ type: "CLOSE_TABS", tabIds: ids });
        state.selection.clear();
      }, { danger: true })
    );

    positionMenu(e);
  }

  function onGroupContextMenu(e, group) {
    e.preventDefault();
    e.stopPropagation();
    menuEl.innerHTML = "";
    menuEl.appendChild(menuItem("Show Only This Group", () => showGroupOnly(group.id)));
    menuEl.appendChild(menuItem("Rename Group", () => openRenameModal(group)));
    menuEl.appendChild(menuItem("Reload Group Tabs", () => {
      send({ type: "RELOAD_TABS", tabIds: group.tabIds });
    }));
    const groupTabs = group.tabIds.map((id) => state.tabs.find((tab) => tab.id === id)).filter(Boolean);
    const shouldMuteGroup = groupTabs.some((tab) => !tab.muted);
    menuEl.appendChild(menuItem(`${shouldMuteGroup ? "Mute" : "Unmute"} Group Tabs`, () => {
      send({ type: "MUTE_TABS", tabIds: group.tabIds, muted: shouldMuteGroup });
    }));

    const colorsWrap = document.createElement("div");
    colorsWrap.className = "vt-menu-colors";
    GROUP_COLORS.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "vt-color-swatch" + (c === group.color ? " selected" : "");
      sw.style.background = c;
      sw.addEventListener("click", () => {
        closeMenu();
        send({ type: "UPDATE_GROUP", groupId: group.id, patch: { color: c } });
      });
      colorsWrap.appendChild(sw);
    });
    const customColor = document.createElement("div");
    customColor.className = "vt-menu-custom-color";
    customColor.innerHTML = `
      <input type="color" value="${normalizeHexColor(group.color) || "#5b6eff"}">
      <input type="text" maxlength="7" value="${normalizeHexColor(group.color) || "#5b6eff"}" aria-label="Group hex color">
    `;
    const colorPicker = customColor.querySelector('input[type="color"]');
    const colorHex = customColor.querySelector('input[type="text"]');
    const saveColor = (value) => {
      const color = normalizeHexColor(value);
      if (!color) return;
      colorPicker.value = color;
      colorHex.value = color;
      send({ type: "UPDATE_GROUP", groupId: group.id, patch: { color } });
    };
    colorPicker.addEventListener("input", (e) => saveColor(e.target.value));
    colorHex.addEventListener("change", (e) => saveColor(e.target.value));
    menuEl.appendChild(colorsWrap);
    menuEl.appendChild(customColor);
    menuEl.appendChild(menuSep());
    menuEl.appendChild(menuItem("Delete Group", () => {
      send({ type: "DELETE_GROUP", groupId: group.id });
    }));
    menuEl.appendChild(menuItem(`Close ${group.tabIds.length} Tabs`, () => {
      send({ type: "CLOSE_TABS", tabIds: group.tabIds });
    }, { danger: true }));

    positionMenu(e);
  }

  function findGroupForTab(tabId) {
    return Object.values(state.groups).find((g) => g.tabIds.includes(tabId));
  }

  // ---------- modal (create group / rename) ----------
  function closeModal() {
    modalOverlayEl.classList.remove("open");
    modalEl.innerHTML = "";
  }
  modalOverlayEl.addEventListener("click", (e) => {
    if (e.target === modalOverlayEl) closeModal();
  });

  function openGroupModal(tabIds) {
    let chosenColor = GROUP_COLORS[Object.keys(state.groups).length % GROUP_COLORS.length];
    modalEl.innerHTML = `
      <div class="vt-modal-title">New Group</div>
      <input type="text" class="vt-modal-input" placeholder="Group name" maxlength="40">
      <div class="vt-modal-colors"></div>
      <div class="vt-modal-color-custom">
        <input type="color" class="vt-group-color-picker">
        <input type="text" class="vt-hex-input vt-group-color-hex" maxlength="7">
      </div>
      <div class="vt-modal-actions">
        <button class="vt-btn secondary">Cancel</button>
        <button class="vt-btn primary">Create</button>
      </div>
    `;
    const input = modalEl.querySelector(".vt-modal-input");
    const colorsWrap = modalEl.querySelector(".vt-modal-colors");
    const colorPicker = modalEl.querySelector(".vt-group-color-picker");
    const colorHex = modalEl.querySelector(".vt-group-color-hex");
    const reflectColor = (color) => {
      chosenColor = color;
      colorPicker.value = color;
      colorHex.value = color;
      colorsWrap.querySelectorAll(".vt-color-swatch").forEach((n) => {
        n.classList.toggle("selected", n.dataset.color === color);
      });
    };
    reflectColor(chosenColor);
    GROUP_COLORS.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "vt-color-swatch" + (c === chosenColor ? " selected" : "");
      sw.dataset.color = c;
      sw.style.background = c;
      sw.addEventListener("click", () => reflectColor(c));
      colorsWrap.appendChild(sw);
    });
    colorPicker.addEventListener("input", (e) => reflectColor(e.target.value));
    colorHex.addEventListener("change", (e) => {
      const color = normalizeHexColor(e.target.value);
      if (color) reflectColor(color);
      else colorHex.value = chosenColor;
    });
    modalEl.querySelector(".secondary").addEventListener("click", closeModal);
    modalEl.querySelector(".primary").addEventListener("click", () => {
      const name = input.value.trim() || "New Group";
      send({ type: "CREATE_GROUP", name, color: chosenColor, tabIds });
      state.selection.clear();
      closeModal();
    });
    modalOverlayEl.classList.add("open");
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") modalEl.querySelector(".primary").click();
    });
  }

  function openRenameTabModal(tab) {
    modalEl.innerHTML = `
      <div class="vt-modal-title">Rename Tab</div>
      <div class="vt-modal-description">This name is used only in Vertical Tabs.</div>
      <input type="text" class="vt-modal-input" maxlength="120">
      <div class="vt-modal-actions">
        <button class="vt-btn reset" ${tab.hasCustomName ? "" : "disabled"}>Reset</button>
        <button class="vt-btn secondary">Cancel</button>
        <button class="vt-btn primary">Save</button>
      </div>
    `;
    const input = modalEl.querySelector(".vt-modal-input");
    input.value = tab.title;
    modalEl.querySelector(".reset").addEventListener("click", () => {
      send({ type: "RENAME_TAB", tabId: tab.id, name: "" });
      closeModal();
    });
    modalEl.querySelector(".secondary").addEventListener("click", closeModal);
    modalEl.querySelector(".primary").addEventListener("click", () => {
      const name = input.value.trim();
      send({ type: "RENAME_TAB", tabId: tab.id, name });
      closeModal();
    });
    modalOverlayEl.classList.add("open");
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") modalEl.querySelector(".primary").click();
    });
  }

  function openRenameModal(group) {
    modalEl.innerHTML = `
      <div class="vt-modal-title">Rename Group</div>
      <input type="text" class="vt-modal-input" maxlength="40">
      <div class="vt-modal-actions">
        <button class="vt-btn secondary">Cancel</button>
        <button class="vt-btn primary">Save</button>
      </div>
    `;
    const input = modalEl.querySelector(".vt-modal-input");
    input.value = group.name;
    modalEl.querySelector(".secondary").addEventListener("click", closeModal);
    modalEl.querySelector(".primary").addEventListener("click", () => {
      const name = input.value.trim() || group.name;
      send({ type: "UPDATE_GROUP", groupId: group.id, patch: { name } });
      closeModal();
    });
    modalOverlayEl.classList.add("open");
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") modalEl.querySelector(".primary").click();
    });
  }
  } catch (error) {
    showStartupError(error);
  }

  function showStartupError(error) {
    const message = error?.message || String(error || "Unknown error");
    const target = document.body || document.documentElement;
    if (!target) return;
    target.innerHTML = `
      <div style="box-sizing:border-box;min-height:100vh;padding:18px;background:#1c1d22;color:#e7e8ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="font-weight:700;margin-bottom:8px;">Vertical Tabs could not start</div>
        <div style="font-size:13px;line-height:1.45;color:#b7bac4;">${escapeErrorHtml(message)}</div>
      </div>
    `;
  }

  function escapeErrorHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
