import { el, replace } from "../dom.ts";
import { ago, bytes, kind } from "../format.ts";
import { search } from "../search.ts";
import type { App } from "../app.ts";
import type { VaultItem } from "../../vault/types.ts";
import { openImport } from "./importSheet.ts";
import { openItem } from "./itemSheet.ts";
import { openSettings } from "./settings.ts";

/** §47. Search first, collections and storage health alongside. */
export function renderBrowse(app: App): HTMLElement {
  const searchBox = el("input", {
    type: "search",
    placeholder: "Search your vault…",
    value: app.query,
    name: "q",
    "aria-label": "Search your vault",
  });
  const results = el("div", {});
  const filePicker = el("input", {
    type: "file",
    multiple: true,
    class: "visually-hidden",
    tabindex: "-1",
    name: "import",
    // The "+ Add" button is the real control. This input has to stay rendered
    // for the chooser to open, but it should not be a second thing in the a11y
    // tree; tabindex -1 keeps it unfocusable, so aria-hidden is safe here.
    "aria-hidden": "true",
  });

  // showPicker() is the sanctioned way to open a chooser and does not care
  // whether the input is rendered; .click() is the fallback for anything that
  // lacks it. Both need transient user activation, which the click handler has.
  const openPicker = () => {
    const withPicker = filePicker as HTMLInputElement & { showPicker?: () => void };
    try {
      if (typeof withPicker.showPicker === "function") {
        withPicker.showPicker();
        return;
      }
    } catch {
      /* SecurityError / NotAllowedError - fall through to click() */
    }
    filePicker.click();
  };

  const paint = () => {
    const matched = search(app.index, app.query).filter(
      (i) => !i.archived && (!app.activeCollection || i.collectionId === app.activeCollection),
    );
    replace(results, ...sections(app, matched));
  };

  searchBox.addEventListener("input", () => {
    app.query = searchBox.value;
    paint();
  });

  filePicker.addEventListener("change", () => {
    const files = [...(filePicker.files ?? [])];
    filePicker.value = "";
    if (files.length) openImport(app, files);
  });

  const main = el("div", { class: "main" }, [
    el("div", { class: "field" }, [searchBox]),
    results,
  ]);

  // §15: drag-and-drop, alongside the picker. These live on `main`, which is
  // rebuilt each render, so they die with it. Paste is document-level and is
  // therefore registered once by App -- registering it here leaked a listener
  // per render, and one paste opened one sheet per past render.
  main.addEventListener("dragover", (e) => e.preventDefault());
  main.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...((e as DragEvent).dataTransfer?.files ?? [])];
    if (files.length) openImport(app, files);
  });

  paint();

  const shell = el("div", { class: "shell" }, [
    el("div", { class: "topbar" }, [
      el("h1", { text: "LOCAL VAULT" }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "btn",
        text: "＋ Add",
        onClick: openPicker,
      }),
      el("button", {
        class: "icon-btn",
        text: "⚙",
        title: "Settings",
        "aria-label": "Settings",
        onClick: () => openSettings(app),
      }),
      el("button", {
        class: "icon-btn",
        text: "🔒",
        title: "Lock vault",
        "aria-label": "Lock vault",
        onClick: () => void app.lock(),
      }),
      filePicker,
    ]),
    el("div", { class: "body" }, [main, sidebar(app)]),
  ]);

  if (app.pending.length) {
    const files = app.pending;
    app.pending = [];
    queueMicrotask(() => openImport(app, files));
  }

  return shell;
}

function sections(app: App, matched: VaultItem[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const snap = app.snapshot!;

  if (app.query || app.activeCollection) {
    out.push(
      section(
        app.activeCollection
          ? (snap.collections.find((c) => c.id === app.activeCollection)?.name ?? "Collection")
          : `${matched.length} result${matched.length === 1 ? "" : "s"}`,
        matched.length
          ? matched.map((i) => itemRow(app, i))
          : [el("div", { class: "empty", text: "Nothing matches." })],
      ),
    );
    return out;
  }

  const favorites = matched.filter((i) => i.favorite);
  if (favorites.length) {
    out.push(section("Pinned", favorites.map((i) => itemRow(app, i))));
  }

  const expiring = matched
    .filter((i) => i.expiresAt && new Date(i.expiresAt).getTime() - Date.now() < 180 * 86_400_000)
    .sort((a, b) => (a.expiresAt! < b.expiresAt! ? -1 : 1));
  if (expiring.length) {
    out.push(section("Expiring Soon", expiring.map((i) => itemRow(app, i, true))));
  }

  const recent = [...matched]
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .slice(0, 25);
  out.push(
    section(
      "Recent",
      recent.length
        ? recent.map((i) => itemRow(app, i))
        : [
            el("div", { class: "empty" }, [
              el("div", { text: "Nothing in the vault yet." }),
              el("div", {
                class: "hint",
                text: "Add a file, drop one here, or paste from the clipboard.",
              }),
            ]),
          ],
    ),
  );
  return out;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  return el("div", { class: "section" }, [
    el("h2", { text: title }),
    el("div", { class: "stack" }, children),
  ]);
}

function itemRow(app: App, item: VaultItem, showExpiry = false): HTMLElement {
  const right = showExpiry && item.expiresAt ? `expires ${ago(item.expiresAt).replace(" ago", "")}` : bytes(item.size);
  return el(
    "div",
    {
      class: "row",
      tabindex: "0",
      role: "button",
      onClick: () => openItem(app, item.id),
      onKeydown: (e: Event) => {
        const key = (e as KeyboardEvent).key;
        if (key === "Enter" || key === " ") {
          e.preventDefault();
          openItem(app, item.id);
        }
      },
    },
    [
      el("span", { class: "muted", style: "width:38px;font-size:11px", text: kind(item.mimeType, item.originalName ?? "") }),
      el("span", { class: "grow" }, [
        el("div", { class: "name", text: item.displayName }),
        item.tags.length
          ? el("div", { class: "meta", text: item.tags.join(" · ") })
          : null,
      ]),
      item.favorite ? el("span", { class: "muted", text: "★" }) : null,
      el("span", { class: "meta num", text: right }),
    ],
  );
}

function sidebar(app: App): HTMLElement {
  const snap = app.snapshot!;
  const counts = new Map<string, number>();
  for (const item of snap.items) {
    if (item.archived) continue;
    if (item.collectionId) counts.set(item.collectionId, (counts.get(item.collectionId) ?? 0) + 1);
  }

  const collectionRows = snap.collections
    .filter((c) => counts.get(c.id))
    .map((c) =>
      el(
        "div",
        {
          class: `row${app.activeCollection === c.id ? " active" : ""}`,
          tabindex: "0",
          onClick: () => {
            app.activeCollection = app.activeCollection === c.id ? null : c.id;
            app.render();
          },
        },
        [
          el("span", { class: "grow name", text: c.name }),
          el("span", { class: "meta num", text: String(counts.get(c.id) ?? 0) }),
        ],
      ),
    );

  return el("div", { class: "side" }, [
    el("div", { class: "section" }, [
      el("h2", { text: "Collections" }),
      el("div", { class: "stack" }, [
        app.activeCollection
          ? el("button", {
              class: "btn ghost",
              text: "← All items",
              onClick: () => {
                app.activeCollection = null;
                app.render();
              },
            })
          : null,
        ...(collectionRows.length
          ? collectionRows
          : [el("div", { class: "empty", text: "No collections in use yet." })]),
      ]),
    ]),
    storagePanel(app),
    backupPanel(app),
  ]);
}

/** §23, §24, §25 — status, quota, and honest language about what it means. */
function storagePanel(app: App): HTMLElement {
  const s = app.storage;
  if (!s) return el("div", {});
  const pct = s.quota ? Math.round((s.usage / s.quota) * 100) : 0;

  return el("div", { class: "section" }, [
    el("h2", { text: "Storage" }),
    el("div", { class: "card stack" }, [
      el("div", { class: "hstack" }, [
        el("span", {
          class: s.persisted ? "ok-text" : "warn-text",
          text: s.persisted ? "● Persistent" : "⚠ Not persistent",
        }),
      ]),
      el("div", { class: "bar" }, [el("i", { style: `width:${pct}%` })]),
      el("div", { class: "meta num", text: `${bytes(s.usage)} of ~${bytes(s.quota)} browser quota` }),
      el("div", {
        class: "hint",
        text: "A browser estimate, not free disk space.",
      }),
      !s.persisted
        ? el("div", { class: "notice warn" }, [
            el("div", { text: "Your browser may clear this site's data under storage pressure." }),
            el("div", { class: "hint", style: "color:inherit", text: "Keep an exported backup." }),
          ])
        : null,
      s.level !== "ok"
        ? el("div", { class: `notice ${s.level === "critical" ? "error" : "warn"}` }, [
            el("div", { text: s.level === "critical" ? "Storage is nearly full." : "Storage is getting low." }),
            el("div", {
              class: "hint",
              style: "color:inherit",
              text: "No vault files will be deleted automatically. Back up before adding more.",
            }),
          ])
        : null,
    ]),
  ]);
}

function backupPanel(app: App): HTMLElement {
  const snap = app.snapshot!;
  const stale =
    snap.settings.backupReminderDays !== null &&
    (!snap.lastBackupAt ||
      Date.now() - new Date(snap.lastBackupAt).getTime() >
        snap.settings.backupReminderDays * 86_400_000);

  return el("div", { class: "section" }, [
    el("h2", { text: "Backup" }),
    el("div", { class: "card stack" }, [
      el("dl", { class: "kv" }, [
        el("dt", { text: "Last" }),
        el("dd", { text: ago(snap.lastBackupAt) }),
        el("dt", { text: "Changed" }),
        el("dd", { text: `${snap.changesSinceBackup} since` }),
      ]),
      stale
        ? el("div", { class: "notice warn", text: "Backup recommended." })
        : null,
      el("button", {
        class: "btn primary",
        text: "Export Encrypted Backup",
        onClick: () => openSettings(app, "backup"),
      }),
    ]),
  ]);
}
