/* ============================================================
   HouseCart — single-file client app
   Storage: localStorage key "housecart.v1"
   Item shape:
   {
     id, name, category, priority, cost, store,
     due (ISO date string|null), recur (""|"weekly"|...),
     related (string[]),
     notes,
     status ("active"|"bought"|"archived"),
     history: [{ date, cost, store }]
   }
   ============================================================ */

// ── DOM helpers ────────────────────────────────────────────────────────────
// Short aliases used throughout to reduce noise. `$` is getElementById;
// `show`/`hide` toggle the "hidden" class on an element or an id string.
const $ = (id) => document.getElementById(id);
const show = (el) =>
  (typeof el === "string" ? $(el) : el)?.classList.remove("hidden");
const hide = (el) =>
  (typeof el === "string" ? $(el) : el)?.classList.add("hidden");
// ───────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "housecart.v1";
// IndexedDB is our durable primary store. localStorage is kept as a synchronous
// mirror so initial paint doesn't have to await an async DB open, and so the
// cross-tab `storage` event still fires for free.
const IDB_NAME = "housecart";
const IDB_STORE = "kv";
const IDB_KEY = "state";
// Layer 2 (backup) and Layer 3 (Gist sync) configuration keys.
// These MUST be declared up here — not lower in the file — because save()
// calls helpers that read them, and save() runs from prefillAutopay() on the
// very first launch (before the file has finished parsing if these consts
// were declared further down: hello, temporal dead zone).
const BACKUP_PREFS_KEY = "housecart.backup.intervalDays";
const GIST_TOKEN_KEY = "housecart.gist.token";
const GIST_ID_KEY = "housecart.gist.id";
const GIST_FILENAME = "housecart-state.json";
const RECUR_DAYS = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  yearly: 365,
};

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.snoozed) parsed.snoozed = {};
      return parsed;
    }
  } catch {}
  return { items: [], snoozed: {} };
}

// Cross-tab / cross-window sync: if another window (or the Safari tab while
// the installed PWA is also open) writes to our storage key, refresh in-memory
// state so we don't silently overwrite each other's changes. The `storage`
// event only fires in *other* windows, never the one that did the write.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY || !e.newValue) return;
  try {
    const next = JSON.parse(e.newValue);
    if (!next.snoozed) next.snoozed = {};
    state = next;
    renderAll();
  } catch {}
});

// --- IndexedDB helpers (durable storage; survives Safari 7-day eviction
// better than localStorage, and has a much larger quota). Each call opens a
// short-lived transaction; the DB handle itself is cached.
let _idbPromise = null;
function idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window))
      return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE))
        db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    _idbPromise = null; // allow retry
    throw e;
  });
  return _idbPromise;
}
async function idbGet() {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("idbGet failed", e);
    return null;
  }
}
async function idbPut(value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    // IndexedDB can fail in Safari private mode; localStorage mirror is the
    // fallback so we don't lose user data — just log.
    console.warn("idbPut failed", e);
  }
}

// Write to both stores. Used by save() and by sync code paths that need to
// persist sync metadata without triggering further saves.
function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Most common cause: QuotaExceededError after years of history.
    console.error("housecart localStorage save failed", e);
    flash(
      e?.name === "QuotaExceededError"
        ? "⚠️ Browser storage is full. Export your data from Settings, then clear or trim history."
        : `⚠️ Save failed: ${(e?.message || "unknown error").slice(0, 80)}`,
    );
  }
  idbPut(state); // fire-and-forget; idbPut handles its own errors
}

function save() {
  state.updatedAt = new Date().toISOString();
  persistState();
  // Layer 2: nudge the user when a backup is overdue
  refreshBackupHint();
  // Layer 3: push to GitHub Gist (debounced)
  scheduleGistSync();
  renderAll();
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------------- Tabs + More sheet ---------------- */
// Secondary tabs live in the More sheet, not the primary tab bar.
const SECONDARY_TABS = new Set(["goals", "suggestions", "history", "settings"]);

function switchTab(tabName) {
  const isSecondary = SECONDARY_TABS.has(tabName);
  // Deactivate all primary tabs
  document
    .querySelectorAll(".tab[data-tab]")
    .forEach((x) => x.classList.remove("active"));
  // Deactivate all panels
  document
    .querySelectorAll(".tab-panel")
    .forEach((x) => x.classList.remove("active"));
  // Deactivate more-nav items
  document
    .querySelectorAll(".more-nav-item")
    .forEach((x) => x.classList.remove("active"));

  // Activate the target panel
  const panel = $("tab-" + tabName);
  if (panel) panel.classList.add("active");

  // Update tab bar active indicator
  const primaryTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (primaryTab) {
    primaryTab.classList.add("active");
  }
  // Highlight the More button when a secondary tab is shown
  const moreBtn = $("moreTabBtn");
  if (moreBtn) moreBtn.classList.toggle("secondary-active", isSecondary);
  // Highlight the matching more-nav item
  const moreItem = document.querySelector(
    `.more-nav-item[data-tab="${tabName}"]`,
  );
  if (moreItem) moreItem.classList.add("active");
  // Close the sheet after navigation
  closeMoreSheet();
}

function openMoreSheet() {
  show("moreSheet");
}
function closeMoreSheet() {
  hide("moreSheet");
}

// Primary tab bar clicks
document.querySelectorAll(".tab[data-tab]").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

// More button opens the sheet
$("moreTabBtn")?.addEventListener("click", openMoreSheet);

// More sheet navigation items
document.querySelectorAll(".more-nav-item[data-tab]").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

// Close the sheet via backdrop or close button
document
  .querySelector(".more-sheet-backdrop")
  ?.addEventListener("click", closeMoreSheet);
$("moreSheetCloseBtn")?.addEventListener("click", closeMoreSheet);

// Keyboard shortcut: Escape closes the sheet
// (handled in the global keydown below, but also wire it here defensively)
$("moreSheet")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMoreSheet();
});

/* ---------------- Quick add (natural language) ---------------- */
const STORE_HINTS = [
  "home depot",
  "lowes",
  "amazon",
  "target",
  "walmart",
  "costco",
  "trader joes",
  "whole foods",
  "safeway",
  "kroger",
  "ikea",
  "best buy",
  "cvs",
  "walgreens",
];
const CATEGORY_HINTS = {
  grocery: ["grocery", "groceries", "food", "milk", "bread", "eggs"],
  household: [
    "household",
    "cleaner",
    "detergent",
    "paper towels",
    "toilet paper",
  ],
  maintenance: [
    "maintenance",
    "filter",
    "washer",
    "screw",
    "nail",
    "battery",
    "bulb",
    "caulk",
  ],
  recurring: [
    "recurring",
    "subscription",
    "bill",
    "monthly",
    "yearly",
    "weekly",
  ],
  project: ["project", "paint", "wood", "tile", "lumber"],
  goal: ["goal", "saving for", "save for"],
  surprise: ["surprise", "clog", "leak", "broken", "emergency", "repair"],
};
const RECUR_HINTS = {
  weekly: ["weekly", "every week"],
  biweekly: ["biweekly", "every 2 weeks", "every two weeks"],
  monthly: ["monthly", "every month", "/mo", "per month"],
  quarterly: ["quarterly", "every quarter"],
  yearly: ["yearly", "annually", "every year", "/yr", "per year"],
};
const PRIORITY_HINTS = {
  urgent: ["urgent", "asap", "now", "today", "tomorrow"],
  someday: ["someday", "eventually", "wishlist"],
};

function parseNaturalLanguage(text) {
  const lower = text.toLowerCase();
  const item = {
    name: text.trim(),
    category: "other",
    priority: "normal",
    cost: null,
    store: "",
    due: "",
    recur: "",
    related: [],
    autopay: false,
    notes: "",
    status: "active",
  };

  // autopay flag
  if (/\b(autopay|auto[- ]?paid|auto[- ]?charged|on auto)\b/i.test(text)) {
    item.autopay = true;
  }

  // cost: require either a $ prefix OR a clear decimal price (e.g. 5.99).
  // Bare integers like "2 gallons of milk" should NOT be treated as $2.
  const cost = text.match(
    /\$\s*(\d+(?:\.\d{1,2})?)|(?:^|\s)(\d+\.\d{2})(?!\d)/,
  );
  if (cost) item.cost = parseFloat(cost[1] || cost[2]);

  // store
  for (const s of STORE_HINTS) {
    if (lower.includes(s)) {
      item.store = s.replace(/\b\w/g, (c) => c.toUpperCase());
      break;
    }
  }

  // category
  for (const [cat, words] of Object.entries(CATEGORY_HINTS)) {
    if (words.some((w) => lower.includes(w))) {
      item.category = cat;
      break;
    }
  }

  // recurrence
  for (const [r, words] of Object.entries(RECUR_HINTS)) {
    if (words.some((w) => lower.includes(w))) {
      item.recur = r;
      if (item.category === "other") item.category = "recurring";
      break;
    }
  }

  // priority
  for (const [p, words] of Object.entries(PRIORITY_HINTS)) {
    if (words.some((w) => lower.includes(w))) {
      item.priority = p;
      break;
    }
  }

  // clean name: strip prices, "at <store>", priority/recur words
  // Only strip numbers that look like prices ($-prefixed OR a decimal).
  let name = text
    .replace(/\$\s*\d+(?:\.\d{1,2})?|\b\d+\.\d{2}\b/g, "")
    .replace(/\bat\s+[a-z ]+/i, "")
    .replace(
      /\b(monthly|weekly|yearly|biweekly|quarterly|annually|recurring|urgent|someday|maintenance|grocery|project|surprise|autopay|auto[- ]?paid|auto[- ]?charged|on auto)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (name) item.name = name;

  // default due for recurring = today
  if (item.recur && !item.due) item.due = todayISO();

  return item;
}

$("quickAddBtn").addEventListener("click", quickAdd);
$("quickAddInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") quickAdd();
});
function quickAdd() {
  const input = $("quickAddInput");
  const text = input.value.trim();
  if (!text) return;
  const parsed = parseNaturalLanguage(text);
  parsed.id = uid();
  state.items.push(parsed);
  input.value = "";
  save();
  // Echo what was parsed so users learn the syntax.
  const tags = [parsed.category];
  if (parsed.cost) tags.push(`$${parsed.cost.toFixed(2)}`);
  if (parsed.store) tags.push(`📍 ${parsed.store}`);
  if (parsed.recur) tags.push(`🔁 ${parsed.recur}`);
  if (parsed.priority !== "normal") tags.push(parsed.priority);
  if (parsed.autopay) tags.push("💳 autopay");
  // Undo lets users back out of a misparse without opening the modal.
  showUndoToast(`Added: ${parsed.name} · ${tags.join(" · ")}`, () => {
    state.items = state.items.filter((i) => i.id !== parsed.id);
    save();
    flash("Undone.");
  });
}

/* ---------------- Receipt parser ---------------- */
$("receiptBtn").addEventListener("click", () => {
  show("receiptModal");
});
$("receiptCancelBtn").addEventListener("click", () => {
  hide("receiptModal");
});
$("receiptParseBtn").addEventListener("click", () => {
  const text = $("receiptText").value;
  const items = parseReceipt(text);
  if (!items.length) {
    appAlert("Couldn't find any line items.");
    return;
  }
  const addedIds = [];
  items.forEach((it) => {
    const id = uid();
    addedIds.push(id);
    state.items.push({
      ...it,
      id,
      status: "bought",
      history: [{ date: todayISO(), cost: it.cost, store: it.store }],
    });
  });
  $("receiptText").value = "";
  hide("receiptModal");
  save();
  // Undo removes every item we just inserted (safer than retrying parse).
  showUndoToast(
    `Logged ${items.length} purchased item${items.length > 1 ? "s" : ""}.`,
    () => {
      const drop = new Set(addedIds);
      state.items = state.items.filter((i) => !drop.has(i.id));
      save();
      flash("Receipt undone.");
    },
  );
});

function parseReceipt(text) {
  // detect store from first non-empty line if matches hints
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let store = "";
  for (const s of STORE_HINTS) {
    if (lines[0] && lines[0].toLowerCase().includes(s)) {
      store = s.replace(/\b\w/g, (c) => c.toUpperCase());
      break;
    }
  }
  const SKIP =
    /^(sub\s*total|subtotal|total|tax|change|cash|visa|mastercard|debit|credit|tender|balance|amount|thank you|receipt)\b/i;
  const items = [];
  for (const line of lines) {
    if (SKIP.test(line)) continue;
    // capture trailing price
    const m = line.match(/^(.+?)\s+\$?(\d+(?:\.\d{1,2}))\s*$/);
    if (!m) continue;
    let name = m[1].replace(/\s{2,}/g, " ").trim();
    // strip leading qty like "2x" or "2 " and multiply price by qty.
    let qty = 1;
    name = name.replace(/^(\d+)\s*x\s+/i, (_, q) => {
      qty = parseInt(q, 10) || 1;
      return "";
    });
    const unitCost = parseFloat(m[2]);
    const cost = Math.round(unitCost * qty * 100) / 100;
    if (!name || cost > 99999) continue;
    items.push({
      name,
      cost,
      store,
      category: guessCategory(name),
      priority: "normal",
      due: "",
      recur: "",
      related: [],
      notes: "Imported from receipt",
    });
  }
  return items;
}
function guessCategory(name) {
  const l = name.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_HINTS)) {
    if (words.some((w) => l.includes(w))) return cat;
  }
  return "household";
}

/* ---------------- Modal (add/edit) ---------------- */
const modal = $("modal");
const form = $("itemForm");

function openModal(item) {
  $("modalTitle").textContent = item ? "Edit item" : "Add item";
  $("f-id").value = item?.id || "";
  $("f-name").value = item?.name || "";
  $("f-category").value = item?.category || "household";
  $("f-priority").value = item?.priority || "normal";
  $("f-cost").value = item?.cost ?? "";
  $("f-store").value = item?.store || "";
  $("f-due").value = item?.due || "";
  $("f-recur").value = item?.recur || "";
  $("f-related").value = (item?.related || []).join(", ");
  $("f-autopay").checked = !!item?.autopay;
  $("f-notes").value = item?.notes || "";
  $("deleteBtn").classList.toggle("hidden", !item);
  show(modal);
}
$("cancelBtn").addEventListener("click", () => hide(modal));

// Date quick-presets on the add/edit form. Tap a chip to fill the date input.
document.querySelectorAll(".date-presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const dueInput = $("f-due");
    const days = btn.dataset.days;
    dueInput.value =
      days === "" ? "" : addDaysISO(todayISO(), parseInt(days, 10));
  });
});
$("deleteBtn").addEventListener("click", async () => {
  const id = $("f-id").value;
  if (id && (await appConfirm("Delete this item?"))) {
    state.items = state.items.filter((i) => i.id !== id);
    hide(modal);
    save();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("f-id").value;
  const data = {
    name: $("f-name").value.trim(),
    category: $("f-category").value,
    priority: $("f-priority").value,
    cost: parseFloat($("f-cost").value) || null,
    store: $("f-store").value.trim(),
    due: $("f-due").value || "",
    recur: $("f-recur").value,
    related: $("f-related")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    autopay: $("f-autopay").checked,
    notes: $("f-notes").value.trim(),
  };
  if (id) {
    const existing = state.items.find((i) => i.id === id);
    Object.assign(existing, data);
  } else {
    state.items.push({ ...data, id: uid(), status: "active", history: [] });
  }
  hide(modal);
  save();
});

/* ---------------- Mark bought / restock (with undo) ---------------- */
function markBought(id, opts = {}) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  // Snapshot for undo
  const snapshot = JSON.parse(JSON.stringify(it));
  it.history = it.history || [];
  it.history.push({ date: todayISO(), cost: it.cost, store: it.store });
  if (it.recur) {
    it.due = addDaysISO(todayISO(), RECUR_DAYS[it.recur]);
    it.status = "active";
  } else {
    it.status = "bought";
  }
  it.inTrip = false; // remove from queue on purchase
  save();
  if (!opts.silent) {
    showUndoToast(`Marked "${it.name}" as bought.`, () => {
      const target = state.items.find((i) => i.id === id);
      if (target) Object.assign(target, snapshot);
      save();
      flash("Undone.");
    });
  }
}

function toggleTripQueue(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  it.inTrip = !it.inTrip;
  save();
  if (it.inTrip) {
    // Surface the next logical action right at the moment of queuing,
    // so users don't have to navigate to Today or All Items to build the trip.
    const queueCount = state.items.filter(
      (i) => i.status === "active" && i.inTrip,
    ).length;
    showActionToast(
      `Added to trip queue (${queueCount}).`,
      "\uD83D\uDECD\uFE0F Start trip",
      () => generateTrip({ onlyQueued: true, skipPreview: true }),
    );
  }
}

// Clone an existing item as a fresh active entry. History/inTrip/status are reset
// so the duplicate behaves like a brand-new shopping target.
function duplicateItem(id) {
  const src = state.items.find((i) => i.id === id);
  if (!src) return;
  const copy = {
    ...src,
    id: uid(),
    status: "active",
    history: [],
    inTrip: false,
    due: src.recur ? todayISO() : "",
  };
  state.items.push(copy);
  save();
  showUndoToast(`Duplicated "${src.name}".`, () => {
    state.items = state.items.filter((i) => i.id !== copy.id);
    save();
    flash("Undone.");
  });
}

// Re-add a previously bought item as an active to-buy. Used from the History tab.
function reAddFromHistory(id) {
  const src = state.items.find((i) => i.id === id);
  if (!src) return;
  // If an active copy already exists, just queue/flash instead of duplicating.
  const existing = state.items.find(
    (i) =>
      i.id !== src.id &&
      i.status === "active" &&
      i.name.toLowerCase() === src.name.toLowerCase(),
  );
  if (existing) {
    if (!existing.inTrip) {
      existing.inTrip = true;
      save();
    }
    flash(`"${src.name}" is already active — queued for next trip.`);
    return;
  }
  duplicateItem(id);
}

/* ---------------- Rendering ---------------- */
function renderAll() {
  populateCategoryFilter();
  renderToday();
  renderList();
  renderRecurring();
  renderGoals();
  renderSuggestions();
  renderHistory();
  renderSummary();
}

function renderSummary() {
  const active = state.items.filter((i) => i.status === "active");
  const needsAction = active.filter((i) => !i.autopay && i.category !== "goal");
  const dueSoon = needsAction.filter(
    (i) => daysUntil(i.due) !== null && daysUntil(i.due) <= 7,
  ).length;
  const inTrip = active.filter((i) => i.inTrip && !i.autopay).length;
  $("activeCount").textContent = needsAction.length;
  $("dueSoonCount").textContent = dueSoon;
  $("tripQueueCount").textContent = inTrip;
  // Highlight the trip tile when the queue has items
  $("tripQueueTile")?.classList.toggle("has-queue", inTrip > 0);

  // Tab count badges — mirror what each tab actually renders, so users can
  // see at a glance where action is needed without clicking through.
  const counts = {
    list: state.items.filter(
      (i) => i.status === "active" && i.category !== "goal" && !i.autopay,
    ).length,
    recurring: state.items.filter((i) => i.recur && !i.autopay).length,
    goals: state.items.filter(
      (i) => i.category === "goal" && i.status !== "bought",
    ).length,
    suggestions: computeSuggestions().length,
    history: state.items.reduce((n, i) => n + (i.history?.length || 0), 0),
  };
  for (const [tab, n] of Object.entries(counts)) {
    const el = $(`tabCount-${tab}`);
    if (!el) continue;
    el.textContent = n ? String(n) : "";
    el.classList.toggle("hidden", !n);
  }
}

function populateCategoryFilter() {
  const sel = $("filterCategory");
  const current = sel.value;
  const cats = [...new Set(state.items.map((i) => i.category))].sort();
  sel.innerHTML =
    '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${c}">${c}</option>`).join("");
  sel.value = current;
}

function makeCard(item) {
  const dueDays = daysUntil(item.due);
  let cls = "card";
  if (item.priority === "urgent") cls += " urgent";
  if (item.priority === "someday") cls += " someday";
  if (dueDays !== null && dueDays <= 7 && !item.autopay) cls += " due-soon";
  if (item.autopay) cls += " autopay";
  if (item.inTrip) cls += " in-trip";

  const dueLabel =
    dueDays === null
      ? ""
      : dueDays < 0
        ? `overdue ${-dueDays}d`
        : dueDays === 0
          ? "today"
          : `in ${dueDays}d`;

  const div = document.createElement("div");
  div.className = cls;
  div.innerHTML = `
    <h3>
      <span>${escapeHtml(item.name)}</span>
      ${item.cost ? `<span class="cost">$${item.cost.toFixed(2)}</span>` : ""}
    </h3>
    <div class="meta">
      <span>${item.category}</span>
      ${item.store ? `<span>📍 ${escapeHtml(item.store)}</span>` : ""}
      ${item.recur ? `<span>🔁 ${item.recur}</span>` : ""}
      ${item.autopay ? `<span title="Auto-paid — no action needed">💳 auto-paid</span>` : ""}
      ${dueLabel ? `<span>⏰ ${dueLabel}</span>` : ""}
      ${item.priority !== "normal" ? `<span>${item.priority === "urgent" ? "🔥" : "💤"} ${item.priority}</span>` : ""}
    </div>
    ${item.related?.length ? `<div class="related">+ also: ${item.related.map(escapeHtml).join(", ")}</div>` : ""}
    ${item.inTrip ? `<div class="in-trip-badge">🛍️ in next trip</div>` : ""}
    ${item.notes ? `<div class="meta"><span>📝 ${escapeHtml(item.notes)}</span></div>` : ""}
    <div class="card-actions">
      <button class="ca ca-bought" data-act="bought">✓ Bought</button>
      <button class="ca ca-trip${item.inTrip ? " queued" : ""}" data-act="queue">${item.inTrip ? "✕ Remove" : "+ Trip"}</button>
      <button class="ca" data-act="dup" title="Duplicate as a new active item" aria-label="Duplicate">⧉ Copy</button>
    </div>
  `;
  div.querySelector('[data-act="bought"]').addEventListener("click", (e) => {
    e.stopPropagation();
    markBought(item.id);
  });
  div.querySelector('[data-act="queue"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleTripQueue(item.id);
  });
  div.querySelector('[data-act="dup"]').addEventListener("click", (e) => {
    e.stopPropagation();
    duplicateItem(item.id);
  });
  div.addEventListener("click", () => openModal(item));
  return div;
}

function renderList() {
  const root = $("itemList");
  root.innerHTML = "";
  const cat = $("filterCategory").value;
  const prio = $("filterPriority").value;
  const due = $("filterDue")?.value || "";
  // Search reads from the always-visible global search input.
  const q = ($("globalSearch")?.value || "").trim().toLowerCase();
  const items = state.items
    .filter((i) => i.status === "active" && i.category !== "goal" && !i.autopay)
    .filter((i) => !cat || i.category === cat)
    .filter((i) => !prio || i.priority === prio)
    .filter((i) => {
      if (!due) return true;
      const d = daysUntil(i.due);
      if (d === null) return false;
      if (due === "overdue") return d < 0;
      return d <= Number(due);
    })
    .filter(
      (i) =>
        !q ||
        i.name.toLowerCase().includes(q) ||
        (i.store || "").toLowerCase().includes(q) ||
        (i.notes || "").toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const da = daysUntil(a.due) ?? 999,
        db = daysUntil(b.due) ?? 999;
      if (da !== db) return da - db;
      const pr = { urgent: 0, normal: 1, someday: 2 };
      return pr[a.priority] - pr[b.priority];
    });
  if (!items.length) {
    root.innerHTML =
      '<p class="hint">Nothing here yet. Use the quick-add bar above ⬆️</p>';
    return;
  }
  items.forEach((i) => root.appendChild(makeCard(i)));
}

function renderRecurring() {
  const root = $("recurringList");
  root.innerHTML = "";
  const showAutopay = $("showAutopay")?.checked;
  const items = state.items
    .filter((i) => i.recur)
    .filter((i) => showAutopay || !i.autopay)
    .sort((a, b) => (daysUntil(a.due) ?? 999) - (daysUntil(b.due) ?? 999));
  if (!items.length) {
    const hiddenCount = state.items.filter((i) => i.recur && i.autopay).length;
    root.innerHTML =
      showAutopay || !hiddenCount
        ? '<p class="hint">No recurring items yet. Add a bill or routine purchase to get started.</p>'
        : `<p class="hint">All ${hiddenCount} recurring items are auto-paid — nothing to do. Toggle above to view them.</p>`;
    return;
  }
  items.forEach((i) => root.appendChild(makeCard(i)));
}

function renderGoals() {
  const root = $("goalsList");
  root.innerHTML = "";
  const items = state.items.filter(
    (i) => i.category === "goal" && i.status !== "bought",
  );
  if (!items.length) {
    root.innerHTML =
      '<p class="hint">No long-term goals yet. Add one with category "Long-term goal".</p>';
    return;
  }
  items.forEach((i) => root.appendChild(makeCard(i)));
}

/* ---------------- Smart suggestions ---------------- */
function renderSuggestions() {
  const root = $("suggestionsList");
  const sugg = computeSuggestions();
  if (!sugg.length) {
    root.innerHTML =
      '<p class="hint">No suggestions right now. Add purchases and history to see smart reminders.</p>';
    return;
  }
  root.innerHTML = "";
  sugg.forEach((s) => {
    const el = document.createElement("div");
    el.className = "suggestion";
    el.innerHTML = `
      <div class="body">${s.html}</div>
      <div class="suggestion-actions">
        ${s.snooze ? `<button class="snooze" title="Hide for a while">Not now</button>` : ""}
        <button class="primary-sm">${s.action}</button>
      </div>
    `;
    el.querySelector(".primary-sm").addEventListener("click", s.handler);
    el.querySelector(".snooze")?.addEventListener("click", () => {
      s.snooze();
      flash("Snoozed.");
    });
    root.appendChild(el);
  });
}

function computeSuggestions() {
  const out = [];
  const active = state.items.filter((i) => i.status === "active");
  const now = todayISO();
  // Drop expired snoozes so the map doesn't grow forever.
  state.snoozed = state.snoozed || {};
  for (const k of Object.keys(state.snoozed)) {
    if (state.snoozed[k] <= now) delete state.snoozed[k];
  }
  const isSnoozed = (key) => state.snoozed[key] && state.snoozed[key] > now;
  const snooze = (key, days = 14) => {
    state.snoozed[key] = addDaysISO(now, days);
    save();
  };

  // 1) Recurring items overdue / due soon (skip autopay — nothing to do)
  for (const i of state.items) {
    if (!i.recur || i.autopay) continue;
    const d = daysUntil(i.due);
    if (d !== null && d <= 3) {
      const key = `recur-${i.id}`;
      if (isSnoozed(key)) continue;
      out.push({
        html: `<strong>${escapeHtml(i.name)}</strong> is ${d < 0 ? `overdue by ${-d}d` : d === 0 ? "due today" : `due in ${d}d`} (${i.recur}).`,
        action: "Mark bought",
        handler: () => markBought(i.id),
        snooze: () => snooze(key, 7),
      });
    }
  }

  // 2) History-based reorder: if last bought > recurrence-ish ago and no active dupe
  for (const i of state.items) {
    if (!i.history?.length) continue;
    const last = i.history[i.history.length - 1].date;
    const daysAgo = daysSince(last);
    const interval =
      RECUR_DAYS[i.recur] || (i.category === "maintenance" ? 90 : null);
    if (interval && daysAgo >= interval * 0.9) {
      const dup = active.find(
        (x) => x.name.toLowerCase() === i.name.toLowerCase() && x.id !== i.id,
      );
      if (!dup && i.status === "bought") {
        const key = `restock-${i.id}`;
        if (isSnoozed(key)) continue;
        out.push({
          html: `You bought <strong>${escapeHtml(i.name)}</strong> ${daysAgo}d ago. Time to restock?`,
          action: "Add to list",
          handler: () => {
            state.items.push({
              ...i,
              id: uid(),
              status: "active",
              history: [],
              due: todayISO(),
            });
            save();
          },
          snooze: () => snooze(key, 14),
        });
      }
    }
  }

  // 3) Related items: for any active item, suggest its related entries if not already on list
  const activeNames = new Set(active.map((i) => i.name.toLowerCase()));
  for (const i of active) {
    for (const r of i.related || []) {
      if (!activeNames.has(r.toLowerCase())) {
        const key = `related-${i.id}-${r.toLowerCase()}`;
        if (isSnoozed(key)) {
          activeNames.add(r.toLowerCase());
          continue;
        }
        out.push({
          html: `Since you're getting <strong>${escapeHtml(i.name)}</strong>, don't forget <strong>${escapeHtml(r)}</strong>.`,
          action: "Add",
          handler: () => {
            state.items.push({
              id: uid(),
              name: r,
              category: i.category,
              priority: "normal",
              cost: null,
              store: i.store,
              due: "",
              recur: "",
              related: [],
              notes: `Suggested with ${i.name}`,
              status: "active",
              history: [],
            });
            save();
          },
          snooze: () => snooze(key, 30),
        });
        activeNames.add(r.toLowerCase()); // dedupe within this run
      }
    }
  }

  return out.slice(0, 25);
}

/* ---------------- History ---------------- */
function renderHistory() {
  const root = $("historyList");
  const rows = [];
  for (const i of state.items) {
    for (const h of i.history || []) {
      rows.push({
        itemId: i.id,
        name: i.name,
        store: h.store || i.store,
        cost: h.cost ?? i.cost,
        date: h.date,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!rows.length) {
    root.innerHTML =
      '<p class="hint">No purchase history yet. Mark items as Bought to track them here.</p>';
    return;
  }
  root.innerHTML = "";
  rows.forEach((r) => {
    const el = document.createElement("div");
    el.className = "history-row";
    el.title = "Click to re-add as active";
    el.innerHTML = `
      <span>${escapeHtml(r.name)} ${r.store ? `<small style="color:var(--muted)">@ ${escapeHtml(r.store)}</small>` : ""}</span>
      <span>${r.cost ? "$" + Number(r.cost).toFixed(2) : ""} <span class="date">${r.date}</span>
        <button class="history-readd" title="Re-add as active item">↻ Re-add</button>
      </span>
    `;
    el.querySelector(".history-readd").addEventListener("click", (e) => {
      e.stopPropagation();
      reAddFromHistory(r.itemId);
    });
    el.addEventListener("click", () => reAddFromHistory(r.itemId));
    root.appendChild(el);
  });
}

/* ---------------- Filters wiring ---------------- */
["filterCategory", "filterPriority", "filterDue"].forEach((id) =>
  $(id).addEventListener("input", renderList),
);
$("showAutopay").addEventListener("change", renderRecurring);

// Global search (header / quick-add bar): always-visible search that jumps
// to the All Items tab and re-renders. Filter logic reads #globalSearch directly.
$("globalSearch")?.addEventListener("input", () => {
  const listPanel = $("tab-list");
  if (listPanel && !listPanel.classList.contains("active")) switchTab("list");
  renderList();
});

/* ---------------- Settings ---------------- */
$("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `housecart-${todayISO()}.json`;
  a.click();
});
$("importInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.items) throw new Error("Invalid file");
    state = data;
    save();
    flash("Imported.");
  } catch (err) {
    appAlert("Import failed: " + err.message);
  }
});
$("clearBtn").addEventListener("click", async () => {
  if (await appConfirm("Delete ALL data? This cannot be undone.")) {
    state = { items: [] };
    save();
  }
});

/* ---------------- Backup (Layer 2) ---------------- */
$("backupNowBtn")?.addEventListener("click", () => {
  makeBackup().catch((e) => appAlert("Backup failed: " + e.message));
});
$("backupInterval")?.addEventListener("change", (e) => {
  setBackupIntervalDays(parseInt(e.target.value, 10));
});
$("bannerBackupBtn")?.addEventListener("click", () => {
  makeBackup().catch((e) => appAlert("Backup failed: " + e.message));
});
$("bannerDismissBtn")?.addEventListener("click", async () => {
  // "Dismiss" = pretend a backup just happened so we wait another full interval
  // before nagging again. The data is NOT actually backed up — make this clear.
  if (
    await appConfirm(
      "Dismiss without backing up?\nThe reminder will return after the next interval.",
    )
  ) {
    state.lastBackup = new Date().toISOString();
    persistState();
    refreshBackupHint();
  }
});

/* ---------------- Cloud sync — GitHub Gist (Layer 3) ---------------- */
function loadCloudSettingsUI() {
  const { token, gistId } = getGistConfig();
  const tokenEl = $("gistToken");
  const idEl = $("gistId");
  if (tokenEl) tokenEl.value = token;
  if (idEl) idEl.value = gistId;
  const intervalEl = $("backupInterval");
  if (intervalEl) intervalEl.value = String(getBackupIntervalDays());
  updateSyncStatus();
  refreshBackupHint();
}
// NOTE: do NOT call loadCloudSettingsUI() here — it reaches into module-level
// `const`s (GIST_TOKEN_KEY, etc.) that are declared further down the file and
// are still in the temporal dead zone at this point. We invoke it from the
// startup IIFE at the bottom instead.

$("gistSaveBtn")?.addEventListener("click", () => {
  const token = $("gistToken").value.trim();
  const gistId = $("gistId").value.trim();
  setGistConfig({ token, gistId });
  flash("Cloud sync settings saved.");
  // If they just configured a token + gist, pull immediately to fetch any
  // existing remote state.
  if (token) cloudPullOnLaunch();
});
$("gistSyncBtn")?.addEventListener("click", async () => {
  // Auto-save inputs so user doesn't have to remember "Save & connect" first.
  const tokenInput = $("gistToken")?.value.trim() || "";
  const idInput = $("gistId")?.value.trim() || "";
  if (tokenInput || idInput)
    setGistConfig({ token: tokenInput, gistId: idInput });
  const { token } = getGistConfig();
  if (!token) return appAlert("Save your GitHub token first.");
  try {
    updateSyncStatus("Pushing…");
    await gistPush();
    flash("☁️ Pushed to cloud.");
    // Refresh the Gist ID input in case gistPush() just created one.
    const idEl = $("gistId");
    if (idEl) idEl.value = getGistConfig().gistId || "";
  } catch (e) {
    appAlert("Push failed: " + e.message);
    updateSyncStatus();
  }
});
$("gistPullBtn")?.addEventListener("click", async () => {
  // Auto-save inputs so user doesn't have to remember "Save & connect" first.
  const tokenInput = $("gistToken")?.value.trim() || "";
  const idInput = $("gistId")?.value.trim() || "";
  if (tokenInput || idInput)
    setGistConfig({ token: tokenInput, gistId: idInput });
  // Reflect the normalized Gist ID back into the input (handles URL paste).
  const idEl0 = $("gistId");
  if (idEl0) idEl0.value = getGistConfig().gistId || "";
  const { token, gistId } = getGistConfig();
  if (!token || !gistId)
    return appAlert("Enter both a GitHub token AND a Gist ID, then tap Pull.");
  const ok = await appConfirm(
    "Replace your current local data with the cloud version?\nUnsaved local changes will be lost.",
    { okText: "Pull from cloud" },
  );
  if (!ok) return;
  try {
    updateSyncStatus("Pulling…");
    const remote = await gistPull();
    if (!remote) {
      await appAlert("Gist is empty — nothing to pull yet.");
      updateSyncStatus();
      return;
    }
    state = remote;
    state.lastSync = new Date().toISOString();
    persistState();
    renderAll();
    flash("☁️ Pulled from cloud.");
  } catch (e) {
    appAlert("Pull failed: " + e.message);
    updateSyncStatus();
  }
});
$("gistDisableBtn")?.addEventListener("click", async () => {
  const ok = await appConfirm(
    "Disconnect cloud sync? Your local data is unaffected.",
    { okText: "Disconnect" },
  );
  if (!ok) return;
  setGistConfig({ token: "", gistId: "" });
  const t = $("gistToken");
  const i = $("gistId");
  if (t) t.value = "";
  if (i) i.value = "";
  flash("Cloud sync disconnected.");
});

// One-time setup link: encode current token + gist ID in URL hash and copy.
// The hash fragment is NEVER sent to servers (so no logs, no analytics, no
// CDN, no Pages access log will ever see it). On the receiving device the
// app reads it once, saves to localStorage, then strips it from the URL.
$("gistShareLinkBtn")?.addEventListener("click", () => {
  const { token, gistId } = getGistConfig();
  if (!token || !gistId) {
    return appAlert(
      "Connect this device first (Save & connect, then Push now) so a Gist ID exists.",
    );
  }
  const url = buildSetupLink({ token, gistId });
  showSetupLinkModal(url);
});

function showSetupLinkModal(url) {
  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:600;" +
    "display:flex;align-items:center;justify-content:center;padding:1rem;";
  const box = document.createElement("div");
  box.style.cssText =
    "background:#0c1322;color:#e2e8f0;border:1px solid #334155;" +
    "border-radius:12px;padding:1.2rem;max-width:520px;width:100%;" +
    "box-shadow:0 10px 40px rgba(0,0,0,0.5);";

  const h = document.createElement("h3");
  h.textContent = "🔗 Setup link for another device";
  h.style.cssText = "margin:0 0 0.6rem 0;font-size:1.1rem;";

  const warn = document.createElement("p");
  warn.style.cssText =
    "margin:0 0 0.8rem 0;font-size:0.85rem;line-height:1.4;color:#fbbf24;";
  warn.textContent =
    "⚠️ Treat this link like a password. Anyone with it can read/overwrite your HouseCart data. Send via a private channel (AirDrop, iMessage, Signal). The link is consumed on first open.";

  const ta = document.createElement("textarea");
  ta.value = url;
  ta.readOnly = true;
  ta.rows = 4;
  ta.style.cssText =
    "width:100%;box-sizing:border-box;padding:0.6rem;border-radius:8px;" +
    "background:#0a0f1e;color:#e2e8f0;border:1px solid #334155;" +
    "font-family:monospace;font-size:0.78rem;word-break:break-all;" +
    "resize:vertical;";

  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;gap:0.6rem;justify-content:flex-end;flex-wrap:wrap;margin-top:0.9rem;";

  const finish = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") finish();
  };
  document.addEventListener("keydown", onKey);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "secondary";
  closeBtn.textContent = "Done";
  closeBtn.style.minHeight = "44px";
  closeBtn.addEventListener("click", finish);

  // Optional native share (iOS share sheet / Android share)
  let shareBtn = null;
  if (navigator.share) {
    shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.textContent = "📤 Share";
    shareBtn.style.minHeight = "44px";
    shareBtn.addEventListener("click", async () => {
      try {
        await navigator.share({
          title: "HouseCart setup link",
          text: "HouseCart cloud sync setup (one-time link — keep private):",
          url,
        });
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.warn("share failed", err);
        }
      }
    });
  }

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "📋 Copy link";
  copyBtn.style.minHeight = "44px";
  copyBtn.addEventListener("click", async () => {
    const ok = await copyToClipboard(url, ta);
    if (ok) {
      copyBtn.textContent = "✓ Copied!";
      setTimeout(() => (copyBtn.textContent = "📋 Copy link"), 1800);
    } else {
      copyBtn.textContent = "⚠️ Select & copy manually";
      ta.focus();
      ta.select();
    }
  });

  row.appendChild(closeBtn);
  if (shareBtn) row.appendChild(shareBtn);
  row.appendChild(copyBtn);

  box.appendChild(h);
  box.appendChild(warn);
  box.appendChild(ta);
  box.appendChild(row);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Select the URL so iOS users can long-press → Copy if both auto-paths fail.
  setTimeout(() => {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
  }, 50);
}

// Robust clipboard copy with fallbacks for iOS PWA / older Safari / restricted contexts.
async function copyToClipboard(text, srcTextarea) {
  // 1) Modern async clipboard API (requires secure context + user gesture)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn("clipboard.writeText failed, falling back", e);
    }
  }
  // 2) Legacy execCommand path — still works in iOS PWA standalone mode.
  try {
    const ta = srcTextarea || document.createElement("textarea");
    if (!srcTextarea) {
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
      document.body.appendChild(ta);
    }
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand && document.execCommand("copy");
    if (!srcTextarea) ta.remove();
    if (ok) return true;
  } catch (e) {
    console.warn("execCommand copy failed", e);
  }
  return false;
}

function buildSetupLink({ token, gistId }) {
  // Lightweight obfuscation so the link doesn't read as obviously a token
  // when glanced at. NOT cryptographic — anyone determined can decode it.
  const payload = JSON.stringify({ t: token, g: gistId, v: 1 });
  const b64 = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  // Use the hash fragment, NOT the query string, so the secret is never
  // sent to any server (browsers strip fragments from network requests).
  const base = `${location.origin}${location.pathname}`;
  return `${base}#hc=${b64}`;
}

function consumeSetupLinkFromUrl() {
  const hash = location.hash || "";
  const m = hash.match(/(?:^#|[#&])hc=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = decodeURIComponent(escape(atob(b64)));
    const data = JSON.parse(json);
    if (!data || !data.t || !data.g) return false;
    setGistConfig({ token: data.t, gistId: data.g });
    flash("☁️ Cloud sync configured from setup link.");
    return true;
  } catch (e) {
    console.warn("Failed to parse setup link", e);
    return false;
  } finally {
    // ALWAYS strip the hash so the secret isn't sitting in the URL bar,
    // browser history, screenshots, or shared via "Copy current URL".
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      location.hash = "";
    }
  }
}

$("saveKeyBtn").addEventListener("click", () => {
  const k = $("apiKey").value.trim();
  if (k) {
    localStorage.setItem("housecart.apikey", k);
    flash("Key saved locally.");
  }
});
$("apiKey").value = localStorage.getItem("housecart.apikey") || "";

$("seedBtn").addEventListener("click", async () => {
  if (
    state.items.length &&
    !(await appConfirm("Append sample data to your current list?"))
  )
    return;
  state.items.push(...sampleData());
  save();
});

$("prefillAutopayBtn").addEventListener("click", () => {
  const added = prefillAutopay();
  flash(
    added
      ? `Added ${added} auto-paid bill${added > 1 ? "s" : ""}.`
      : "All common bills already exist.",
  );
});

$("dedupeBtn").addEventListener("click", () => {
  const before = state.items.length;
  const seen = new Map();
  const kept = [];
  for (const it of state.items) {
    const key = `${it.name.trim().toLowerCase()}|${(it.store || "").trim().toLowerCase()}|${it.recur || ""}`;
    if (seen.has(key)) {
      // Merge history into the kept item
      const k = seen.get(key);
      k.history = [...(k.history || []), ...(it.history || [])];
      continue;
    }
    seen.set(key, it);
    kept.push(it);
  }
  state.items = kept;
  save();
  flash(
    `Removed ${before - kept.length} duplicate${before - kept.length === 1 ? "" : "s"}.`,
  );
});

/* ---------------- Auto-prefill autopay bills ---------------- */
const DEFAULT_AUTOPAY = [
  { name: "Netflix", cost: 15.49, recur: "monthly" },
  { name: "Spotify", cost: 11.99, recur: "monthly" },
  { name: "Amazon Prime", cost: 14.99, recur: "monthly" },
  { name: "Internet bill", cost: 70.0, recur: "monthly" },
  { name: "Cell phone", cost: 45.0, recur: "monthly" },
  { name: "Electric bill", cost: 110.0, recur: "monthly" },
  { name: "Gas bill", cost: 45.0, recur: "monthly" },
  { name: "Water bill", cost: 60.0, recur: "quarterly" },
  { name: "Car insurance", cost: 140.0, recur: "monthly" },
  { name: "iCloud storage", cost: 2.99, recur: "monthly" },
];
function prefillAutopay() {
  const existing = new Set(state.items.map((i) => i.name.toLowerCase()));
  let added = 0;
  const t = todayISO();
  for (const b of DEFAULT_AUTOPAY) {
    if (existing.has(b.name.toLowerCase())) continue;
    state.items.push({
      id: uid(),
      name: b.name,
      category: "recurring",
      priority: "normal",
      cost: b.cost,
      store: "",
      due: addDaysISO(t, Math.floor(Math.random() * 28) + 1),
      recur: b.recur,
      related: [],
      autopay: true,
      notes: "",
      status: "active",
      history: [],
    });
    added++;
  }
  if (added) save();
  return added;
}

/* ---------------- Generate shopping trip ---------------- */
let currentTrip = []; // [{ id, name, cost, store, reason }]

function generateTrip(opts = {}) {
  const candidates = state.items
    // Goal items are excluded from auto-generated trips, but if the user
    // explicitly queued one (inTrip === true) we honor that opt-in.
    .filter(
      (i) =>
        i.status === "active" &&
        !i.autopay &&
        (i.category !== "goal" || i.inTrip),
    )
    .filter((i) => !opts.onlyQueued || i.inTrip)
    .map((i) => {
      const d = daysUntil(i.due);
      let reason = "",
        score = 0;
      if (i.inTrip) {
        reason = "in queue";
        score = 110;
      } else if (i.priority === "urgent") {
        reason = "urgent";
        score = 100;
      } else if (d !== null && d < 0) {
        reason = `overdue ${-d}d`;
        score = 90 + Math.min(-d, 30);
      } else if (d !== null && d === 0) {
        reason = "due today";
        score = 85;
      } else if (d !== null && d <= 3) {
        reason = `due in ${d}d`;
        score = 70;
      } else if (d !== null && d <= 7) {
        reason = `due in ${d}d`;
        score = 50;
      } else if (i.recur && d === null) {
        reason = "no due date";
        score = 30;
      } else if (i.priority === "someday") {
        reason = "someday";
        score = 5;
      } else {
        reason = "normal";
        score = 20;
      }
      return { item: i, reason, score };
    })
    .filter((x) => opts.onlyQueued || x.score >= 30)
    .sort((a, b) => b.score - a.score);

  // De-duplicate by (name + store) — keep the highest-scoring candidate.
  // Items already sorted by score desc, so the first occurrence wins.
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    const key = `${c.item.name.trim().toLowerCase()}|${(c.item.store || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  // Group by store (or "Any store")
  const groups = {};
  for (const c of deduped) {
    const key = c.item.store || "Any store";
    (groups[key] = groups[key] || []).push(c);
  }

  // Build modal
  const root = $("tripGroups");
  root.innerHTML = "";
  currentTrip = [];

  if (!deduped.length) {
    root.innerHTML = opts.onlyQueued
      ? '<p class="hint">Your trip queue is empty — tap <strong>+ Trip</strong> on items first to build a custom trip.</p>'
      : '<p class="hint">Nothing urgent right now. Add items or wait until due dates approach.</p>';
    $("tripSummary").textContent = "";
  } else {
    const totalCost = deduped.reduce((s, c) => s + (c.item.cost || 0), 0);
    $("tripSummary").textContent =
      `${deduped.length} item${deduped.length > 1 ? "s" : ""} across ${Object.keys(groups).length} store${Object.keys(groups).length > 1 ? "s" : ""} · est. $${totalCost.toFixed(2)}`;

    // Sort stores: real stores first (alphabetical), "Any store" last
    const storeKeys = Object.keys(groups).sort((a, b) => {
      if (a === "Any store") return 1;
      if (b === "Any store") return -1;
      return a.localeCompare(b);
    });

    for (const store of storeKeys) {
      const list = groups[store];
      const subTotal = list.reduce((s, c) => s + (c.item.cost || 0), 0);
      const div = document.createElement("div");
      div.className =
        "trip-group" + (store === "Any store" ? " any-store" : "");
      const items = list
        .map((c) => {
          const id = `trip-${c.item.id}`;
          currentTrip.push({ id, itemId: c.item.id });
          const relatedNote = c.item.related?.length
            ? ` <span class="item-reason">+ also: ${c.item.related.map(escapeHtml).join(", ")}</span>`
            : "";
          return `
          <div class="trip-item" data-id="${id}">
            <span class="trip-item-name">${escapeHtml(c.item.name)} <span class="item-reason">(${c.reason})</span>${relatedNote}</span>
            ${c.item.cost ? `<span class="item-cost">$${c.item.cost.toFixed(2)}</span>` : ""}
          </div>
        `;
        })
        .join("");
      div.innerHTML = `
        <h3>
          <span>📍 ${escapeHtml(store)} <small>${list.length} item${list.length > 1 ? "s" : ""} · $${subTotal.toFixed(2)}</small></span>
        </h3>
        ${items}
      `;
      root.appendChild(div);
    }
  }

  show("tripModal");
  if (opts.skipPreview && currentTrip.length) {
    hide("tripModal");
    enterShopMode(currentTrip.map((t) => t.itemId));
  }
}

$("tripCloseBtn").addEventListener("click", () => {
  hide("tripModal");
});
$("tripCopyBtn").addEventListener("click", () => {
  const root = $("tripGroups");
  const lines = [];
  root.querySelectorAll(".trip-group").forEach((g) => {
    lines.push(g.querySelector("h3").textContent.trim());
    g.querySelectorAll(".trip-item").forEach((row) => {
      const text = row
        .querySelector(".trip-item-name")
        .textContent.trim()
        .split(" (")[0];
      const cost = row.querySelector(".item-cost")?.textContent || "";
      lines.push(`  • ${text}${cost ? "  " + cost : ""}`);
    });
    lines.push("");
  });
  navigator.clipboard
    .writeText(lines.join("\n"))
    .then(() => flash("Copied to clipboard."));
});

/* ---------------- Shop Mode (full-screen in-store) ---------------- */
let shopState = { items: [], checked: new Set(), wakeLock: null };

$("tripShopModeBtn").addEventListener("click", () => {
  enterShopMode(currentTrip.map((t) => t.itemId));
});

function enterShopMode(itemIds) {
  if (!itemIds.length) {
    flash("Generate a trip first.");
    return;
  }
  shopState.items = itemIds
    .map((id) => state.items.find((i) => i.id === id))
    .filter(Boolean);
  shopState.checked = new Set();
  hide("tripModal");
  show("shopMode");
  $("shopMode").classList.remove("hide-checked");
  // Lock background scroll so iOS doesn't rubber-band the body behind the
  // fixed shop overlay (which can make items appear to overlap the header).
  document.body.classList.add("shop-open");
  renderShopMode();
  requestWakeLock();
}

function exitShopMode() {
  hide("shopMode");
  document.body.classList.remove("shop-open");
  releaseWakeLock();
  renderSummary();
}
$("shopExitBtn").addEventListener("click", async () => {
  if (
    shopState.checked.size &&
    !(await appConfirm("Exit without marking items as bought?"))
  )
    return;
  exitShopMode();
});

function renderShopMode() {
  const body = $("shopBody");
  body.innerHTML = "";

  // Group by store
  const groups = {};
  shopState.items.forEach((it) => {
    const key = it.store || "Any store";
    (groups[key] = groups[key] || []).push(it);
  });

  const storeKeys = Object.keys(groups).sort((a, b) => {
    if (a === "Any store") return 1;
    if (b === "Any store") return -1;
    return a.localeCompare(b);
  });

  for (const store of storeKeys) {
    const list = groups[store];
    const checkedInStore = list.filter((i) =>
      shopState.checked.has(i.id),
    ).length;
    const total = list.length;
    const complete = checkedInStore === total;
    const subTotal = list.reduce((s, i) => s + (i.cost || 0), 0);

    const storeEl = document.createElement("div");
    storeEl.className = "shop-store" + (complete ? " complete" : "");
    storeEl.innerHTML = `
      <div class="shop-store-header">
        <span>📍 ${escapeHtml(store)}</span>
        <span class="progress">${checkedInStore}/${total} · $${subTotal.toFixed(2)}</span>
      </div>
      <div class="shop-store-items"></div>
    `;
    const itemsRoot = storeEl.querySelector(".shop-store-items");
    list.forEach((it) => itemsRoot.appendChild(makeShopItem(it)));

    // Collapse on header tap
    storeEl
      .querySelector(".shop-store-header")
      .addEventListener("click", () => {
        storeEl.classList.toggle("collapsed");
      });

    body.appendChild(storeEl);
  }

  // Progress bar + counter
  const total = shopState.items.length;
  const done = shopState.checked.size;
  $("shopProgress").textContent = `${done}/${total}`;
  $("shopProgressFill").style.width = total ? `${(done / total) * 100}%` : "0%";

  const total$ = shopState.items.reduce((s, i) => s + (i.cost || 0), 0);
  $("shopTitle").textContent = `Shopping · est. $${total$.toFixed(2)}`;
}

function makeShopItem(item) {
  const d = daysUntil(item.due);
  const dueLabel =
    d === null
      ? ""
      : d < 0
        ? `overdue ${-d}d`
        : d === 0
          ? "due today"
          : `due in ${d}d`;
  const metaParts = [
    item.category,
    dueLabel,
    item.priority === "urgent" ? "<span class='urgent'>🔥 urgent</span>" : "",
    item.notes ? `📝 ${escapeHtml(item.notes)}` : "",
  ].filter(Boolean);

  const el = document.createElement("div");
  el.className =
    "shop-item" + (shopState.checked.has(item.id) ? " checked" : "");
  el.innerHTML = `
    <div class="shop-checkbox"></div>
    <div class="shop-item-body">
      <div class="shop-item-name">${escapeHtml(item.name)}</div>
      ${metaParts.length ? `<div class="shop-item-meta">${metaParts.join(" · ")}</div>` : ""}
      ${item.related?.length ? `<div class="shop-item-related">+ also: ${item.related.map(escapeHtml).join(", ")}</div>` : ""}
    </div>
    ${item.cost ? `<div class="shop-item-cost">$${item.cost.toFixed(2)}</div>` : ""}
  `;
  el.addEventListener("click", () => {
    if (shopState.checked.has(item.id)) shopState.checked.delete(item.id);
    else shopState.checked.add(item.id);
    renderShopMode();
  });
  return el;
}

$("shopHideCheckedBtn").addEventListener("click", (e) => {
  const sm = $("shopMode");
  sm.classList.toggle("hide-checked");
  e.target.textContent = sm.classList.contains("hide-checked")
    ? "👁️ Show all"
    : "👁️ Hide checked";
});

$("shopFinishBtn").addEventListener("click", async () => {
  if (!shopState.checked.size) {
    if (!(await appConfirm("Nothing checked. Exit anyway?"))) return;
    exitShopMode();
    return;
  }
  let n = 0;
  shopState.checked.forEach((id) => {
    markBought(id, { silent: true });
    n++;
  });
  exitShopMode();
  flash(`Trip complete! Marked ${n} item${n > 1 ? "s" : ""} as bought.`);
});

$("shopShareBtn").addEventListener("click", async () => {
  const lines = ["🛒 Shopping list", ""];
  const groups = {};
  shopState.items.forEach((it) => {
    const key = it.store || "Any store";
    (groups[key] = groups[key] || []).push(it);
  });
  for (const store of Object.keys(groups).sort()) {
    lines.push(`📍 ${store}`);
    groups[store].forEach((it) => {
      const mark = shopState.checked.has(it.id) ? "[x]" : "[ ]";
      const cost = it.cost ? `  $${it.cost.toFixed(2)}` : "";
      lines.push(`  ${mark} ${it.name}${cost}`);
    });
    lines.push("");
  }
  const text = lines.join("\n");
  // Try Web Share first (mobile), fall back to clipboard
  if (navigator.share) {
    try {
      await navigator.share({ title: "Shopping list", text });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
    flash("List copied to clipboard.");
  } catch {
    appAlert("Copy failed — here's the text:\n\n" + text);
  }
});

/* Wake Lock — keep the screen on while shopping */
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    shopState.wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}
function releaseWakeLock() {
  try {
    shopState.wakeLock?.release();
  } catch {}
  shopState.wakeLock = null;
}
// Re-acquire if user tabs away and back
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    !$("shopMode").classList.contains("hidden")
  ) {
    requestWakeLock();
  }
});

/* ---------------- Utilities ---------------- */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso) - new Date(todayISO());
  return Math.round(ms / 86400000);
}
function daysSince(iso) {
  if (!iso) return null;
  return Math.round((new Date(todayISO()) - new Date(iso)) / 86400000);
}
function addDaysISO(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

let flashTimer = null;
// Brief informational banner. Never has a button — uses .flash (pointer-events:none)
// so it can never sit on top of a real toast button.
function flash(msg) {
  let el = $("flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "flash";
    el.className = "flash";
    document.body.appendChild(el);
  }
  el.style.bottom = toastBottom();
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}

/* ---------------- In-app confirm/alert ----------------
   iOS Safari in PWA (Home Screen) standalone mode silently suppresses
   native alert()/confirm()/prompt(). These helpers replace them with a
   real DOM modal so flows keep working. */
function appAlert(message) {
  return appConfirm(message, { okOnly: true });
}
function appConfirm(message, opts = {}) {
  const { okText = "OK", cancelText = "Cancel", okOnly = false } = opts;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:600;" +
      "display:flex;align-items:center;justify-content:center;padding:1rem;";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#0c1322;color:#e2e8f0;border:1px solid #334155;" +
      "border-radius:12px;padding:1.2rem;max-width:420px;width:100%;" +
      "box-shadow:0 10px 40px rgba(0,0,0,0.5);";
    const text = document.createElement("p");
    text.style.cssText =
      "margin:0 0 1rem 0;white-space:pre-line;line-height:1.4;font-size:1rem;";
    text.textContent = message;
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;gap:0.6rem;justify-content:flex-end;flex-wrap:wrap;";
    const finish = (val) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && !okOnly) finish(false);
      else if (e.key === "Enter") finish(true);
    };
    document.addEventListener("keydown", onKey);
    if (!okOnly) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = cancelText;
      cancel.style.minHeight = "44px";
      cancel.addEventListener("click", () => finish(false));
      row.appendChild(cancel);
    }
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = okText;
    ok.style.minHeight = "44px";
    ok.addEventListener("click", () => finish(true));
    row.appendChild(ok);
    box.appendChild(text);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    setTimeout(() => ok.focus(), 0);
  });
}

/* ---------------- Toasts (undo + action) ---------------- */

// Compute the bottom offset so toasts always sit above the shop-mode footer
// (when open) and otherwise hug the safe-area bottom.
function toastBottom() {
  const shopMode = $("shopMode");
  const shopOpen = shopMode && !shopMode.classList.contains("hidden");
  if (shopOpen) {
    const footer = shopMode.querySelector(".shop-footer");
    const footerH = footer?.getBoundingClientRect().height || 64;
    return `${footerH + 16}px`;
  }
  return "calc(env(safe-area-inset-bottom, 0px) + 24px)";
}

// Generic toast with a single action button.
// Used by both "Undo" toasts and forward-action toasts (e.g. "Start trip").
const toastTimers = {};
function showToast(id, message, actionLabel, onAction) {
  let el = $(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = "toast";
    el.innerHTML = `<span class="toast-msg"></span><button class="toast-btn"></button>`;
    document.body.appendChild(el);
  }
  el.querySelector(".toast-msg").textContent = message;
  const btn = el.querySelector(".toast-btn");
  btn.textContent = actionLabel;
  el.style.bottom = toastBottom();
  el.classList.remove("hidden");
  clearTimeout(toastTimers[id]);
  const hide = () => el.classList.add("hidden");
  btn.onclick = () => {
    hide();
    onAction();
  };
  toastTimers[id] = setTimeout(hide, 5000);
}

const showUndoToast = (message, onUndo) =>
  showToast("undoToast", message, "Undo", onUndo);
const showActionToast = (message, actionLabel, onAction) =>
  showToast("actionToast", message, actionLabel, onAction);

/* ---------------- Today screen ---------------- */
function renderToday() {
  const active = state.items.filter(
    (i) => i.status === "active" && !i.autopay && i.category !== "goal",
  );

  // First-time onboarding: only autopay/no items at all — show a friendly nudge
  // on the urgent card so new users have an obvious next step.
  const onboarding =
    !active.length && !state.items.some((i) => i.history?.length);
  // Act today: urgent or due <= 0
  const act = active.filter((i) => {
    const d = daysUntil(i.due);
    return i.priority === "urgent" || (d !== null && d <= 0);
  });
  // This week: due 1-7
  const week = active.filter((i) => {
    const d = daysUntil(i.due);
    return d !== null && d > 0 && d <= 7 && i.priority !== "urgent";
  });
  // Trip queue includes anything the user manually queued, including goals.
  const queue = state.items.filter(
    (i) => i.status === "active" && !i.autopay && i.inTrip,
  );
  const tips = computeSuggestions().slice(0, 5);

  renderTodayList("actToday", act, "Nothing urgent. \uD83C\uDF89");
  renderTodayList("thisWeek", week, "Clear this week.");
  renderTodayList(
    "tripQueue",
    queue,
    "Trip queue is empty. Use + Trip on any item to add it.",
  );
  renderTodayTips(tips);

  // Replace the "Nothing urgent" placeholder with an actionable onboarding block.
  if (onboarding) {
    const root = $("actToday");
    root.innerHTML = `
      <div class="onboarding">
        <p><strong>Welcome to HouseCart!</strong> Try one of these to get going:</p>
        <ul>
          <li>Type something into the quick-add bar above (e.g. <em>milk $4 weekly</em>) and hit <kbd>Enter</kbd>.</li>
          <li>Paste a digital receipt with the <strong>📷 Receipt</strong> button to bulk-log purchases.</li>
          <li>Or load demo data: <button class="link-btn" id="onboardSeedBtn">🌱 Load sample data</button></li>
        </ul>
        <p class="hint" style="margin:0.5rem 0 0">Press <kbd>?</kbd> anytime for keyboard shortcuts.</p>
      </div>
    `;
    root.querySelector("#onboardSeedBtn").addEventListener("click", () => {
      state.items.push(...sampleData());
      save();
      flash("Sample data loaded.");
    });
  }

  $("actCount").textContent = act.length ? `${act.length}` : "";
  $("weekCount").textContent = week.length ? `${week.length}` : "";
  $("queueCount").textContent = queue.length
    ? `${queue.length} · $${queue.reduce((s, i) => s + (i.cost || 0), 0).toFixed(0)}`
    : "";
  $("tipsCount").textContent = tips.length ? `${tips.length}` : "";
}

function renderTodayList(rootId, items, emptyMsg) {
  const root = $(rootId);
  root.innerHTML = "";
  if (!items.length) {
    root.innerHTML = `<p class="hint" style="margin:0">${emptyMsg}</p>`;
    return;
  }
  items.slice(0, 8).forEach((i) => {
    const row = document.createElement("div");
    row.className = "today-row";
    const d = daysUntil(i.due);
    const dueLabel =
      d === null
        ? ""
        : d < 0
          ? `overdue ${-d}d`
          : d === 0
            ? "today"
            : `in ${d}d`;
    const tags = [
      i.store ? `📍 ${escapeHtml(i.store)}` : "",
      dueLabel ? `⏰ ${dueLabel}` : "",
      i.priority === "urgent" ? "🔥 urgent" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    row.innerHTML = `
      <span class="row-main">
        <span class="name">${escapeHtml(i.name)}</span>
        ${tags ? `<span class="row-sub"><span class="meta-tag">${tags}</span></span>` : ""}
      </span>
      ${i.cost ? `<span class="cost-tag">$${i.cost.toFixed(2)}</span>` : ""}
      <span class="row-actions">
        <button data-act="bought" class="bought-now" title="Mark bought">✓</button>
        <button data-act="queue" class="${i.inTrip ? "queued" : ""}" title="${i.inTrip ? "Remove from trip" : "Add to trip"}">${i.inTrip ? "✕" : "+"}</button>
      </span>
    `;
    row.querySelector('[data-act="bought"]').addEventListener("click", (e) => {
      e.stopPropagation();
      markBought(i.id);
    });
    row.querySelector('[data-act="queue"]').addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTripQueue(i.id);
    });
    row.addEventListener("click", () => openModal(i));
    root.appendChild(row);
  });
  if (items.length > 8) {
    const more = document.createElement("p");
    more.className = "hint";
    more.style.margin = "0.4rem 0 0";
    more.textContent = `+ ${items.length - 8} more…`;
    root.appendChild(more);
  }
}

function renderTodayTips(tips) {
  const root = $("todayTips");
  root.innerHTML = "";
  if (!tips.length) {
    root.innerHTML = '<p class="hint" style="margin:0">No tips right now.</p>';
    return;
  }
  tips.forEach((s) => {
    const row = document.createElement("div");
    row.className = "today-row tip-row";
    row.innerHTML = `<span class="name">${s.html}</span>
      <span class="row-actions"><button>${s.action}</button></span>`;
    row.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      s.handler();
    });
    root.appendChild(row);
  });
}

// "Build trip from queue" — skip preview, go straight to Shop Mode
$("generateFromQueueBtn").addEventListener("click", () => {
  const queue = state.items.filter((i) => i.status === "active" && i.inTrip);
  if (!queue.length) {
    flash("Trip queue is empty. Use + Trip on any item.");
    return;
  }
  generateTrip({ onlyQueued: true, skipPreview: true });
});

// Header summary tiles — single delegated handler covers all three:
//   - active items → open Items tab, clear filters
//   - due ≤ 7d     → open Items tab, filter by "Due ≤ 7 days"
//   - trip queue   → start Shop Mode from queued items
document.querySelector(".summary")?.addEventListener("click", (e) => {
  const tile = e.target.closest(".summary-tile");
  if (!tile) return;
  switch (tile.dataset.tile) {
    case "active":
      $("filterCategory").value = "";
      $("filterPriority").value = "";
      $("filterDue").value = "";
      renderList();
      switchTab("list");
      break;
    case "due-soon":
      $("filterCategory").value = "";
      $("filterPriority").value = "";
      $("filterDue").value = "7";
      renderList();
      switchTab("list");
      break;
    case "trip": {
      const queue = state.items.filter(
        (i) => i.status === "active" && i.inTrip,
      );
      if (!queue.length) {
        flash("Trip queue is empty. Use + Trip on any item.");
        return;
      }
      generateTrip({ onlyQueued: true, skipPreview: true });
      break;
    }
  }
});

// "Clear" — dequeue every item in one click (with undo).
$("clearQueueBtn")?.addEventListener("click", () => {
  const queued = state.items.filter((i) => i.inTrip);
  if (!queued.length) {
    flash("Trip queue is already empty.");
    return;
  }
  const ids = queued.map((i) => i.id);
  ids.forEach((id) => {
    const it = state.items.find((i) => i.id === id);
    if (it) it.inTrip = false;
  });
  save();
  showUndoToast(
    `Cleared ${ids.length} item${ids.length > 1 ? "s" : ""} from queue.`,
    () => {
      ids.forEach((id) => {
        const it = state.items.find((i) => i.id === id);
        if (it) it.inTrip = true;
      });
      save();
      flash("Restored.");
    },
  );
});

/* ---------------- Help modal ---------------- */
const helpModal = $("helpModal");
function openHelp() {
  closeMoreSheet();
  show(helpModal);
}
$("helpBtn")?.addEventListener("click", openHelp);
$("helpCloseBtn")?.addEventListener("click", () => {
  hide(helpModal);
});

/* ---------------- Voice add (Web Speech API) ---------------- */
(function setupVoice() {
  const btn = $("voiceBtn");
  const input = $("quickAddInput");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    btn.style.opacity = "0.4";
    btn.title = "Voice not supported in this browser (try Chrome/Edge)";
    btn.addEventListener("click", () =>
      appAlert("Voice input requires Chrome or Edge."),
    );
    return;
  }
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  let listening = false;

  btn.addEventListener("click", () => {
    if (listening) {
      rec.stop();
      return;
    }
    try {
      rec.start();
    } catch {}
  });
  rec.addEventListener("start", () => {
    listening = true;
    btn.classList.add("listening");
    input.value = "";
    input.placeholder = "Listening…";
  });
  rec.addEventListener("end", () => {
    listening = false;
    btn.classList.remove("listening");
    input.placeholder =
      'Try: "garden hose washer $5 at Home Depot maintenance"';
    if (input.value.trim()) quickAdd();
  });
  rec.addEventListener("error", () => {
    listening = false;
    btn.classList.remove("listening");
    input.placeholder =
      'Try: "garden hose washer $5 at Home Depot maintenance"';
  });
  rec.addEventListener("result", (e) => {
    let text = "";
    for (const r of e.results) text += r[0].transcript;
    input.value = text.trim();
  });
})();

/* ---------------- Keyboard shortcuts ---------------- */
document.addEventListener("keydown", (e) => {
  // ignore when typing
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case "/":
    case "f":
      e.preventDefault();
      // Prefer the always-visible global search.
      $("globalSearch")?.focus();
      break;
    case "n":
      e.preventDefault();
      $("quickAddInput").focus();
      break;
    case "g":
      e.preventDefault();
      generateTrip();
      break;
    case "v":
      e.preventDefault();
      $("voiceBtn").click();
      break;
    case "?":
      e.preventDefault();
      openHelp();
      break;
    case "escape":
      document
        .querySelectorAll(".modal:not(.hidden)")
        .forEach((m) => m.classList.add("hidden"));
      break;
    default:
      // Numbered tabs: 1=Today 2=Items 3=Recurring 4=Goals 5=Suggestions 6=History 7=Settings
      if (/^[1-7]$/.test(e.key)) {
        const tabNames = [
          "today",
          "list",
          "recurring",
          "goals",
          "suggestions",
          "history",
          "settings",
        ];
        const name = tabNames[parseInt(e.key, 10) - 1];
        if (name) {
          e.preventDefault();
          switchTab(name);
        }
      }
  }
});

/* ---------------- Sample data (3 months of mock history) ---------------- */
function sampleData() {
  const t = todayISO();
  const items = [];
  const mk = (o) => ({
    id: uid(),
    priority: "normal",
    cost: null,
    store: "",
    due: "",
    recur: "",
    related: [],
    notes: "",
    status: "active",
    history: [],
    ...o,
  });

  // Build a recurring item and back-fill history over ~90 days
  const recurring = (o) => {
    const intervalDays = RECUR_DAYS[o.recur] || 30;
    const history = [];
    // Generate purchases going back ~90 days
    for (let d = intervalDays; d <= 95; d += intervalDays) {
      // Add a tiny bit of price jitter to feel realistic
      const jitter = (Math.random() - 0.5) * (o.cost * 0.05);
      history.push({
        date: addDaysISO(t, -d + Math.floor(Math.random() * 3 - 1)),
        cost: Math.round((o.cost + jitter) * 100) / 100,
        store: o.store || "",
      });
    }
    history.reverse(); // oldest first
    // Next due based on most recent purchase
    const last = history[history.length - 1];
    const due = last
      ? addDaysISO(last.date, intervalDays)
      : addDaysISO(t, intervalDays);
    return mk({ ...o, history, due });
  };

  // --- Recurring bills (autopay — hidden from main shopping list) ---
  items.push(
    recurring({
      name: "Netflix",
      category: "recurring",
      cost: 15.49,
      recur: "monthly",
      autopay: true,
    }),
    recurring({
      name: "Spotify Family",
      category: "recurring",
      cost: 16.99,
      recur: "monthly",
      autopay: true,
    }),
    recurring({
      name: "Internet bill",
      category: "recurring",
      cost: 72.0,
      recur: "monthly",
      store: "Comcast",
      autopay: true,
    }),
    recurring({
      name: "Cell phone",
      category: "recurring",
      cost: 45.0,
      recur: "monthly",
      store: "Mint",
      autopay: true,
    }),
    recurring({
      name: "Electric bill",
      category: "recurring",
      cost: 118.0,
      recur: "monthly",
      store: "PG&E",
      autopay: true,
    }),
    recurring({
      name: "Gym membership",
      category: "recurring",
      cost: 39.0,
      recur: "monthly",
      autopay: true,
    }),
    recurring({
      name: "Car insurance",
      category: "recurring",
      cost: 142.0,
      recur: "monthly",
      store: "GEICO",
      autopay: true,
    }),
    recurring({
      name: "Amazon Prime",
      category: "recurring",
      cost: 14.99,
      recur: "monthly",
      autopay: true,
    }),
  );

  // --- Recurring household / consumables ---
  items.push(
    recurring({
      name: "Toilet paper (24pk)",
      category: "household",
      cost: 22.99,
      recur: "monthly",
      store: "Costco",
    }),
    recurring({
      name: "Paper towels",
      category: "household",
      cost: 19.99,
      recur: "monthly",
      store: "Costco",
      related: ["dish soap"],
    }),
    recurring({
      name: "Laundry detergent",
      category: "household",
      cost: 14.49,
      recur: "biweekly",
      store: "Target",
      related: ["dryer sheets"],
    }),
    recurring({
      name: "Coffee beans",
      category: "grocery",
      cost: 16.0,
      recur: "biweekly",
      store: "Trader Joes",
    }),
    recurring({
      name: "Milk + eggs run",
      category: "grocery",
      cost: 12.5,
      recur: "weekly",
      store: "Safeway",
    }),
    recurring({
      name: "Weekly grocery haul",
      category: "grocery",
      cost: 95.0,
      recur: "weekly",
      store: "Trader Joes",
    }),
  );

  // --- Maintenance with history ---
  items.push(
    mk({
      name: "HVAC filter",
      category: "maintenance",
      cost: 18.0,
      store: "Amazon",
      recur: "quarterly",
      due: addDaysISO(t, 7),
      notes: "16x25x1 MERV 11",
      history: [{ date: addDaysISO(t, -85), cost: 18.0, store: "Amazon" }],
    }),
    mk({
      name: "Smoke detector batteries",
      category: "maintenance",
      cost: 11.99,
      store: "Amazon",
      related: ["9V batteries"],
      history: [{ date: addDaysISO(t, -75), cost: 11.99, store: "Amazon" }],
      status: "bought",
    }),
    mk({
      name: "Lawn fertilizer",
      category: "maintenance",
      cost: 24.97,
      store: "Home Depot",
      history: [{ date: addDaysISO(t, -62), cost: 24.97, store: "Home Depot" }],
      status: "bought",
    }),
    mk({
      name: "Garden hose washers",
      category: "maintenance",
      cost: 4.97,
      store: "Home Depot",
      related: ["teflon tape"],
      notes: "Pack of 10",
    }),
  );

  // --- Surprises / repairs over the last 3 months ---
  items.push(
    mk({
      name: "Drain snake",
      category: "surprise",
      priority: "urgent",
      cost: 12.99,
      store: "Home Depot",
      due: t,
      related: ["drain cleaner", "rubber gloves"],
      notes: "Bathroom sink clogged",
    }),
    mk({
      name: "Replacement window screen",
      category: "surprise",
      cost: 28.5,
      store: "Home Depot",
      notes: "Kid kicked through it",
      history: [{ date: addDaysISO(t, -52), cost: 28.5, store: "Home Depot" }],
      status: "bought",
    }),
    mk({
      name: "Garbage disposal",
      category: "surprise",
      cost: 109.0,
      store: "Lowes",
      notes: "Old one started leaking",
      history: [{ date: addDaysISO(t, -38), cost: 109.0, store: "Lowes" }],
      status: "bought",
    }),
    mk({
      name: "Car battery",
      category: "surprise",
      cost: 165.0,
      store: "AutoZone",
      notes: "Wouldn't start on a cold morning",
      history: [{ date: addDaysISO(t, -18), cost: 165.0, store: "AutoZone" }],
      status: "bought",
    }),
  );

  // --- Project: paint bedroom ---
  items.push(
    mk({
      name: "Paint bedroom — sage green",
      category: "project",
      cost: 45.0,
      store: "Home Depot",
      related: ["rollers", "painter's tape", "drop cloth", "2in brush"],
      notes: "1 gallon eggshell",
    }),
    mk({
      name: "Patio refresh — string lights",
      category: "project",
      priority: "someday",
      cost: 38.0,
      store: "Target",
      related: ["outdoor extension cord", "outdoor cushions"],
    }),
  );

  // --- Long-term goals ---
  items.push(
    mk({
      name: "New e-bike",
      category: "goal",
      priority: "someday",
      cost: 1800.0,
      notes: "Saving up — target $1800",
    }),
    mk({
      name: "Replace dishwasher",
      category: "goal",
      cost: 750.0,
      store: "Best Buy",
      notes: "Current one is noisy; aim for end of summer",
    }),
    mk({
      name: "Vacation: Iceland",
      category: "goal",
      priority: "someday",
      cost: 3500.0,
      notes: "Targeting next September",
    }),
  );

  // --- Misc historical one-offs to flesh out 3 months ---
  items.push(
    mk({
      name: "Birthday gift — Mom",
      category: "other",
      cost: 65.0,
      store: "Amazon",
      history: [{ date: addDaysISO(t, -78), cost: 65.0, store: "Amazon" }],
      status: "bought",
    }),
    mk({
      name: "New running shoes",
      category: "other",
      cost: 119.0,
      store: "REI",
      history: [{ date: addDaysISO(t, -45), cost: 119.0, store: "REI" }],
      status: "bought",
    }),
    mk({
      name: "Printer ink",
      category: "household",
      cost: 42.0,
      store: "Staples",
      history: [{ date: addDaysISO(t, -30), cost: 42.0, store: "Staples" }],
      status: "bought",
    }),
    mk({
      name: "USB-C cables (3pk)",
      category: "household",
      cost: 14.99,
      store: "Amazon",
      history: [{ date: addDaysISO(t, -22), cost: 14.99, store: "Amazon" }],
      status: "bought",
    }),
    mk({
      name: "Dog food (30lb)",
      category: "household",
      cost: 54.0,
      store: "Chewy",
      recur: "monthly",
      due: addDaysISO(t, 6),
      history: [
        { date: addDaysISO(t, -88), cost: 54.0, store: "Chewy" },
        { date: addDaysISO(t, -58), cost: 54.0, store: "Chewy" },
        { date: addDaysISO(t, -27), cost: 54.0, store: "Chewy" },
      ],
    }),
  );

  return items;
}

// On first launch (empty state), pre-seed common auto-paid bills so the
// dashboard isn't blank and the user can see the autopay pattern.
if (!state.items.length) {
  prefillAutopay();
}

renderAll();

/* ============================================================
   Durable persistence — Layer 1 (IndexedDB hydration)
   ============================================================
   On startup, replace the synchronously-loaded localStorage state with the
   IndexedDB copy if it is newer. This is also where the one-time migration
   from "localStorage only" happens: the first time the app runs after the
   IDB upgrade, IDB is empty, so we push the current localStorage state into
   IDB to seed it.
*/
(async () => {
  try {
    const remote = await idbGet();
    const localTs = state.updatedAt || "";
    const remoteTs = remote?.updatedAt || "";
    if (remote && remoteTs && remoteTs > localTs) {
      // IDB has newer data (e.g. another tab wrote it). Adopt it.
      if (!remote.snoozed) remote.snoozed = {};
      state = remote;
      renderAll();
    } else if (state.items?.length && !remote) {
      // First run after upgrade — migrate the localStorage copy into IDB.
      idbPut(state);
    }
    refreshBackupHint();
  } catch (e) {
    console.warn("IDB hydration failed", e);
  }

  // Populate Settings UI now that all module-level consts (including the
  // GIST_* constants used by getGistConfig) have been initialized. Calling
  // this earlier would hit the temporal dead zone.
  try {
    // If we were opened from a setup link (#hc=...), consume it FIRST so
    // the UI shows the imported token/Gist ID and the launch pull uses it.
    consumeSetupLinkFromUrl();
    loadCloudSettingsUI();
  } catch (e) {
    console.warn("Cloud settings UI init failed", e);
  }

  // After local persistence is settled, try to pull from cloud (if configured).
  try {
    await cloudPullOnLaunch();
  } catch (e) {
    console.warn("Cloud pull failed", e);
  }
})();

/* ============================================================
   Layer 2 — Backups
   ============================================================
   Goal: even if every cache is wiped, the user has a JSON file somewhere
   they can re-import. We periodically nudge them; on mobile we use the
   native share sheet so they can stash the file in iCloud Drive / Files /
   Google Drive without ever touching a server.
*/
// BACKUP_PREFS_KEY is declared at the top of the file (hoisted to avoid TDZ).
function getBackupIntervalDays() {
  const v = parseInt(localStorage.getItem(BACKUP_PREFS_KEY) || "7", 10);
  return Number.isFinite(v) && v >= 0 ? v : 7;
}
function setBackupIntervalDays(days) {
  localStorage.setItem(BACKUP_PREFS_KEY, String(days));
  refreshBackupHint();
}
function daysSinceISO(iso) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}
function formatRelative(iso) {
  if (!iso) return "never";
  const d = daysSinceISO(iso);
  if (d < 1 / 24) return "just now";
  if (d < 1) return `${Math.floor(d * 24)}h ago`;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

async function makeBackup({ silent = false } = {}) {
  const filename = `housecart-backup-${todayISO()}.json`;
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: "application/json" });

  // Prefer native share sheet on mobile so the file can land in iCloud Drive /
  // Files. canShare with a file isn't supported on iOS Safari for non-image
  // files in all versions, so we fall back to a download link.
  let shared = false;
  try {
    const file = new File([blob], filename, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: "HouseCart backup",
        text: "Save this file somewhere safe (iCloud Drive, Files, Dropbox, etc.)",
      });
      shared = true;
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      // User cancelled the share sheet. Do NOT mark a backup as done — they
      // may have meant to cancel.
      return false;
    }
    // Some browsers throw a TypeError for unsupported file shares; fall through
    // to the download path below.
    console.warn("share failed, falling back to download", err);
  }

  if (!shared) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  state.lastBackup = new Date().toISOString();
  persistState();
  refreshBackupHint();
  if (!silent) flash("💾 Backup created. Save it somewhere safe.");
  return true;
}

function refreshBackupHint() {
  // Update the "Last backup: …" line in Settings (if rendered)
  const lastEl = $("lastBackupHint");
  if (lastEl) {
    lastEl.textContent = `Last backup: ${formatRelative(state.lastBackup)}`;
  }
  // Update the Today-tab banner that nudges the user
  const banner = $("backupBanner");
  if (!banner) return;
  const interval = getBackupIntervalDays();
  const due =
    interval > 0 &&
    state.items?.length &&
    daysSinceISO(state.lastBackup) >= interval;
  banner.classList.toggle("hidden", !due);
  if (due) {
    const daysEl = banner.querySelector(".days");
    if (daysEl)
      daysEl.textContent = state.lastBackup
        ? `${Math.floor(daysSinceISO(state.lastBackup))} days ago`
        : "never";
  }
}

/* ============================================================
   Layer 3 — Cross-device sync via a secret GitHub Gist
   ============================================================
   Why a Gist?
   - Free, no service to run, no spin-down delays
   - Versioned automatically (every push = a git commit; full history = undo)
   - Auth = single Personal Access Token with ONLY the "gist" scope
   The strategy is timestamp-based last-write-wins (per `state.updatedAt`).
   If we detect a conflict (remote newer than local AND local has changes
   since our last sync) we prompt before clobbering.
*/
// GIST_TOKEN_KEY / GIST_ID_KEY / GIST_FILENAME are declared at the top of
// the file (hoisted to avoid TDZ when save() reaches them during startup).

function getGistConfig() {
  return {
    token: localStorage.getItem(GIST_TOKEN_KEY) || "",
    gistId: localStorage.getItem(GIST_ID_KEY) || "",
  };
}
// Accept a raw ID, a full gist.github.com URL, or sloppy paste with whitespace.
// gist.github.com URLs look like:
//   https://gist.github.com/username/abc123def456...
//   https://gist.github.com/abc123def456...
function normalizeGistId(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if (s.includes("/")) {
    // grab the last non-empty path segment, drop any #/? fragment
    s = s.split(/[?#]/)[0].replace(/\/+$/, "");
    s = s.split("/").filter(Boolean).pop() || "";
  }
  return s;
}
function setGistConfig({ token, gistId }) {
  if (token !== undefined) {
    const t = (token || "").trim();
    if (t) localStorage.setItem(GIST_TOKEN_KEY, t);
    else localStorage.removeItem(GIST_TOKEN_KEY);
  }
  if (gistId !== undefined) {
    const g = normalizeGistId(gistId);
    if (g) localStorage.setItem(GIST_ID_KEY, g);
    else localStorage.removeItem(GIST_ID_KEY);
  }
  updateSyncStatus();
}

async function gistFetch(path, opts = {}) {
  const { token } = getGistConfig();
  if (!token) throw new Error("No GitHub token configured");
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    // Surface common failures with human-readable hints.
    if (r.status === 404) {
      throw new Error(
        "Gist not found (404). Check that the Gist ID is correct AND that " +
          "this token belongs to the same GitHub account that owns the gist.",
      );
    }
    if (r.status === 401) {
      throw new Error("Token rejected (401). It may be expired or mistyped.");
    }
    if (r.status === 403) {
      throw new Error(
        "Forbidden (403). Use a CLASSIC token with the `gist` scope — " +
          "fine-grained PATs cannot access the Gist API.",
      );
    }
    throw new Error(`GitHub ${r.status}: ${msg.slice(0, 120) || r.statusText}`);
  }
  return r.json();
}

async function gistPull() {
  const { gistId } = getGistConfig();
  if (!gistId) return null;
  const data = await gistFetch(`/gists/${gistId}`);
  const file = data.files?.[GIST_FILENAME];
  if (!file) return null;
  // GitHub truncates files > 1 MB; pull the raw URL if needed.
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const r = await fetch(file.raw_url);
    content = await r.text();
  }
  const parsed = JSON.parse(content);
  if (!parsed.snoozed) parsed.snoozed = {};
  return parsed;
}

async function gistPush() {
  const { gistId } = getGistConfig();
  const body = {
    description: `HouseCart state @ ${state.updatedAt || new Date().toISOString()}`,
    files: {
      [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) },
    },
  };
  let result;
  if (gistId) {
    result = await gistFetch(`/gists/${gistId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } else {
    result = await gistFetch(`/gists`, {
      method: "POST",
      body: JSON.stringify({ ...body, public: false }),
    });
    setGistConfig({ gistId: result.id });
  }
  state.lastSync = new Date().toISOString();
  persistState();
  updateSyncStatus();
  return result;
}

let _gistDebounce = null;
let _gistInflight = false;
function scheduleGistSync() {
  if (!getGistConfig().token) return;
  clearTimeout(_gistDebounce);
  // Debounce so a burst of edits results in one push, not N.
  _gistDebounce = setTimeout(async () => {
    if (_gistInflight) {
      // Re-schedule if a sync is already running.
      scheduleGistSync();
      return;
    }
    _gistInflight = true;
    try {
      await gistPush();
    } catch (e) {
      console.warn("Gist push failed", e);
      flash(`☁️ Cloud sync failed: ${e.message.slice(0, 60)}`);
    } finally {
      _gistInflight = false;
    }
  }, 4000);
}

async function cloudPullOnLaunch() {
  const { token, gistId } = getGistConfig();
  if (!token || !gistId) return;
  updateSyncStatus("Syncing…");
  let remote;
  try {
    remote = await gistPull();
  } catch (e) {
    updateSyncStatus(`⚠️ ${e.message.slice(0, 60)}`);
    return;
  }
  if (!remote) {
    // Empty gist — push our local data to seed it.
    if (state.items?.length) {
      try {
        await gistPush();
      } catch (e) {
        console.warn("seed push failed", e);
      }
    }
    return;
  }
  const localTs = state.updatedAt || "";
  const remoteTs = remote.updatedAt || "";
  if (remoteTs && remoteTs > localTs) {
    // Remote is newer. Detect a real conflict: did we make local changes
    // that haven't been synced yet?
    const haveUnsynced =
      state.updatedAt && (!state.lastSync || state.updatedAt > state.lastSync);
    if (haveUnsynced) {
      const ok = await appConfirm(
        `Cloud has a newer version from ${new Date(remoteTs).toLocaleString()}.\n\n` +
          `Your unsynced local changes will be REPLACED.\n\n` +
          `Tap "Use cloud" to replace local, or "Keep local" to push your version instead.`,
        { okText: "Use cloud", cancelText: "Keep local" },
      );
      if (!ok) {
        // User chose local; push it.
        try {
          await gistPush();
          flash("☁️ Local pushed to cloud.");
        } catch (e) {
          flash(`☁️ Push failed: ${e.message.slice(0, 60)}`);
        }
        return;
      }
    }
    state = remote;
    state.lastSync = new Date().toISOString();
    persistState();
    renderAll();
    flash("☁️ Synced from cloud.");
  } else if (localTs && localTs > remoteTs) {
    // Local is newer than cloud; push.
    try {
      await gistPush();
    } catch (e) {
      console.warn("Catch-up push failed", e);
    }
  } else {
    // In sync.
    state.lastSync = new Date().toISOString();
    persistState();
  }
  updateSyncStatus();
}

function updateSyncStatus(override) {
  const el = $("gistStatus");
  if (!el) return;
  if (override) {
    el.textContent = override;
    return;
  }
  const { token, gistId } = getGistConfig();
  if (!token) {
    el.textContent = "Not connected.";
    return;
  }
  if (!gistId) {
    el.textContent = "Connected — first save will create a private Gist.";
    return;
  }
  el.textContent = `Connected · Last sync ${formatRelative(state.lastSync)}`;
}

/* ---------------- PWA: service worker registration ----------------
 * Registered AFTER the first render so the SW install can't block the
 * initial paint. Skipped under file:// since SWs require a real origin.
 * If the SW ships a new version, we activate it and reload once.
 */
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => {
        // When a new worker takes control, reload so users get the update.
        let refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (
              sw.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              // New SW waiting; tell it to take over immediately.
              sw.postMessage("SKIP_WAITING");
            }
          });
        });
      })
      .catch((err) => console.warn("SW registration failed:", err));
  });
}

// Ask the browser to make our storage durable so iOS / Safari won't evict
// localStorage during storage pressure. Best-effort; ignored where unsupported.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage
    .persisted()
    .then((already) => {
      if (!already) navigator.storage.persist();
    })
    .catch(() => {});
}
