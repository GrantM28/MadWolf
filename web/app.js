// MadWolf Web UI (no framework)
// Requires server endpoints:
// - GET  /api/setup/status
// - POST /api/setup/init
// - POST /api/auth/login
// - POST /api/auth/logout
// - GET  /api/libraries
// - GET  /api/libraries/discover?depth=4
// - POST /api/libraries
// - POST /api/libraries/{id}/scan
// - GET  /api/items?library_id=...&limit=...
// - GET  /api/rows/because-you-watched?item_id=...
// - GET  /api/rows/continue-watching
// - POST /api/items/{id}/progress
// - GET  /api/items/{id}/file

const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

const app = document.querySelector("#app");

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "include",
  });

  // Try to extract a useful error message
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json();
        if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
        else msg = JSON.stringify(j);
      } else {
        const txt = await res.text();
        if (txt) msg = txt;
      }
    } catch (_) {}
    throw new Error(msg);
  }

  // JSON by default
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function renderShell(inner) {
  app.innerHTML = "";
  const root = el(`
    <div class="container">
      <div class="header">
        <div class="brand">
          <div class="logo"></div>
          <div>
            <h1>MadWolf</h1>
            <div class="sub">Self-hosted streaming (MVP)</div>
          </div>
        </div>
        <div class="toolbar" id="top-actions"></div>
      </div>
      ${inner}
    </div>
  `);
  app.appendChild(root);
  return root;
}

function toast(message, type = "info", timeout = 2600) {
  let host = document.querySelector("#toastHost");
  if (!host) {
    host = el(`<div id="toastHost" class="toast-host"></div>`);
    document.body.appendChild(host);
  }
  const t = el(`
    <div class="toast ${type}">
      <div class="toast-dot"></div>
      <div class="toast-msg">${escapeHtml(message)}</div>
    </div>
  `);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 220);
  }, timeout);
}

function modal({ title, bodyHtml, onClose }) {
  const m = el(`
    <div class="modal-backdrop">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title">${escapeHtml(title)}</div>
          <button class="btn" id="close">Close</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    </div>
  `);

  const close = () => {
    m.remove();
    onClose?.();
  };

  m.querySelector("#close").onclick = close;
  m.onclick = (e) => {
    if (e.target === m) close();
  };

  document.body.appendChild(m);
  return { root: m, close };
}

async function boot() {
  const st = await api("/api/setup/status");
  if (st.needsSetup) return renderSetup(st.mediaRoot);
  return renderLogin(st.mediaRoot);
}

function renderSetup(mediaRoot) {
  const root = renderShell(`
    <div class="card">
      <div class="section-title">First run setup</div>
      <div class="notice">Media root inside container: <span class="code">${escapeHtml(mediaRoot)}</span></div>

      <div class="row" style="margin-top:10px;">
        <div class="col">
          <label>Admin username</label>
          <input id="u" placeholder="admin" autocomplete="username" />
        </div>
        <div class="col">
          <label>Admin password</label>
          <input id="p" type="password" placeholder="min 8 chars" autocomplete="new-password" />
        </div>
      </div>

      <div class="toolbar" style="margin-top:14px;">
        <button class="btn" id="go">Create admin</button>
      </div>

      <div class="notice" style="margin-top:14px;">
        Your Docker run must mount host media into the container at:
        <span class="code">${escapeHtml(mediaRoot)}</span>.
        Example: <span class="code">-v /mnt/user/media:${escapeHtml(mediaRoot)}</span>
      </div>
    </div>
  `);

  root.querySelector("#go").onclick = async () => {
    const username = root.querySelector("#u").value.trim();
    const password = root.querySelector("#p").value;
    try {
      await api("/api/setup/init", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      toast("Admin created", "ok");
      await boot();
    } catch (e) {
      toast(`Setup failed: ${e.message}`, "err", 4200);
    }
  };
}

function renderLogin(mediaRoot) {
  const root = renderShell(`
    <div class="card">
      <div class="section-title">Sign in</div>
      <div class="notice">Media root: <span class="code">${escapeHtml(mediaRoot)}</span></div>

      <div class="row" style="margin-top:10px;">
        <div class="col">
          <label>Username</label>
          <input id="u" placeholder="admin" autocomplete="username" />
        </div>
        <div class="col">
          <label>Password</label>
          <input id="p" type="password" placeholder="••••••••" autocomplete="current-password" />
        </div>
      </div>

      <div class="toolbar" style="margin-top:14px;">
        <button class="btn" id="go">Login</button>
      </div>
    </div>
  `);

  const login = async () => {
    const username = root.querySelector("#u").value.trim();
    const password = root.querySelector("#p").value;
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      toast("Logged in", "ok");
      await renderApp();
    } catch (e) {
      toast(`Login failed: ${e.message}`, "err", 4200);
    }
  };

  root.querySelector("#go").onclick = login;
  root.querySelector("#p").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
}

async function openAddLibraryModal(mediaRoot, onCreated) {
  const { root, close } = modal({
    title: "Add library",
    bodyHtml: `
      <div class="notice">
        Choose a discovered folder under <span class="code">${escapeHtml(mediaRoot)}</span>.
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="col">
          <label>Library name</label>
          <input id="libName" value="Movies" />
        </div>
        <div class="col">
          <label>Discovered folder</label>
          <select id="folderSelect"></select>
        </div>
      </div>

      <div class="row" style="margin-top:10px;">
        <div class="col">
          <label>Filter folders</label>
          <input id="folderFilter" placeholder="type to filter (e.g. Movies, TV, Anime)" />
        </div>
        <div class="col">
          <label>Depth</label>
          <select id="depthSel">
            <option value="2">2 (fast)</option>
            <option value="3" selected>3</option>
            <option value="4">4 (deeper)</option>
            <option value="5">5 (deep)</option>
          </select>
        </div>
      </div>

      <div class="toolbar" style="margin-top:14px;">
        <button class="btn" id="refreshDisc">Refresh discovered</button>
        <div class="spacer"></div>
        <button class="btn" id="createLib">Create</button>
        <button class="btn" id="createScan">Create + Scan</button>
      </div>

      <div class="notice" id="msg" style="margin-top:10px;"></div>

      <div class="notice" style="margin-top:12px;">
        If this list is empty: your container can't see your media. Fix your Docker mount:
        <span class="code">-v /mnt/user/media:${escapeHtml(mediaRoot)}</span>
      </div>
    `,
  });

  const msg = root.querySelector("#msg");
  const folderSelect = root.querySelector("#folderSelect");
  const folderFilter = root.querySelector("#folderFilter");
  const libName = root.querySelector("#libName");
  const depthSel = root.querySelector("#depthSel");

  let discovered = [];

  function renderOptions() {
    const q = folderFilter.value.trim().toLowerCase();
    const list = q
      ? discovered.filter((f) => (f.label || "").toLowerCase().includes(q))
      : discovered;

    if (!list.length) {
      folderSelect.innerHTML = `<option value="">(no folders found)</option>`;
      return;
    }

    folderSelect.innerHTML = list
      .slice(0, 800) // avoid nuking the DOM if someone has insane folder depth
      .map((f) => `<option value="${escapeHtml(f.path)}">${escapeHtml(f.label)}</option>`)
      .join("");

    // Smart-ish default library name from selection
    const first = list[0]?.label || "";
    if (first && libName.value.trim() === "Movies") {
      const base = first.split("/").pop();
      if (base) libName.value = base;
    }
  }

  async function loadDiscovered() {
    msg.textContent = "Discovering folders…";
    folderSelect.disabled = true;

    try {
      const depth = parseInt(depthSel.value, 10) || 3;
      const disc = await api(`/api/libraries/discover?depth=${depth}`);
      discovered = Array.isArray(disc.folders) ? disc.folders : [];
      msg.textContent = discovered.length
        ? `Found ${discovered.length} folder(s).`
        : "No folders found. Your mount is probably wrong.";
      renderOptions();
    } catch (e) {
      msg.textContent = `Discover failed: ${e.message}`;
      discovered = [];
      renderOptions();
    } finally {
      folderSelect.disabled = false;
    }
  }

  async function create(doScan) {
    const name = libName.value.trim() || "Library";
    const path = folderSelect.value;

    if (!path) {
      msg.textContent = "Pick a folder first.";
      return;
    }

    msg.textContent = "Creating library…";
    try {
      const res = await api("/api/libraries", {
        method: "POST",
        body: JSON.stringify({ name, path }),
      });

      if (doScan && res?.library?.id) {
        msg.textContent = "Scan queued…";
        await api(`/api/libraries/${res.library.id}/scan`, { method: "POST" });
      }

      toast("Library created", "ok");
      close();
      await onCreated?.();
    } catch (e) {
      msg.textContent = `Add library failed: ${e.message}`;
      toast("Add library failed", "err", 3000);
    }
  }

  root.querySelector("#refreshDisc").onclick = loadDiscovered;
  root.querySelector("#createLib").onclick = () => create(false);
  root.querySelector("#createScan").onclick = () => create(true);
  folderFilter.oninput = renderOptions;
  depthSel.onchange = loadDiscovered;

  await loadDiscovered();
}

async function renderApp() {
  const shell = renderShell(`
    <div class="card">
      <div class="toolbar" style="justify-content:space-between;">
        <div class="toolbar" style="gap:10px; flex-wrap:wrap;">
          <div class="field">
            <label style="margin:0 0 6px;">Library</label>
            <select id="libSelect"></select>
          </div>

          <button class="btn" id="scanLib">Scan</button>
          <button class="btn" id="addLib">Add</button>
          <button class="btn" id="refresh">Refresh</button>
        </div>

        <button class="btn danger" id="logout">Logout</button>
      </div>

      <div id="status" class="notice" style="margin-top:10px;"></div>

      <div class="row" style="margin-top:12px;">
        <div class="col">
          <label>Search</label>
          <input id="q" placeholder="Type to filter..." />
        </div>
      </div>

      <div id="grid" class="grid"></div>

      <div id="homeRows" style="margin-top:14px;"></div>

      <div id="playerWrap" style="display:none;">
        <div class="player">
          <video id="player" controls></video>
        </div>
        <div class="notice" id="rows"></div>
      </div>
    </div>
  `);

  shell.querySelector("#logout").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" });
    toast("Logged out", "ok");
    await boot();
  };

  const statusEl = shell.querySelector("#status");
  const libSelect = shell.querySelector("#libSelect");
  const gridEl = shell.querySelector("#grid");
  const qEl = shell.querySelector("#q");
  const playerWrap = shell.querySelector("#playerWrap");
  const player = shell.querySelector("#player");
  const rows = shell.querySelector("#rows");
  const homeRows = shell.querySelector("#homeRows");

  let mediaRoot = "/mnt/media";
  let libs = [];
  let currentLibId = null;
  let items = [];

  function setStatus(msg) {
    statusEl.innerHTML = msg;
  }

  async function loadLibs() {
    const data = await api("/api/libraries");
    libs = Array.isArray(data.libraries) ? data.libraries : [];
    mediaRoot = data.mediaRoot || mediaRoot;

    if (!libs.length) {
      libSelect.innerHTML = `<option value="">(no libraries yet)</option>`;
      currentLibId = null;
      items = [];
      gridEl.innerHTML = "";
      homeRows.innerHTML = `
        <div class="empty">
          <div class="empty-title">No libraries yet</div>
          <div class="empty-sub">
            Add one by selecting a discovered folder under <span class="code">${escapeHtml(mediaRoot)}</span>.
          </div>
          <div class="toolbar" style="margin-top:12px;">
            <button class="btn" id="emptyAdd">Add library</button>
          </div>
        </div>
      `;
      homeRows.querySelector("#emptyAdd").onclick = () =>
        openAddLibraryModal(mediaRoot, async () => {
          await loadLibs();
          await loadItems();
          await loadHomeRows();
        });

      setStatus(`Media root: <span class="code">${escapeHtml(mediaRoot)}</span>`);
      return;
    }

    // preserve selection if possible
    const prev = currentLibId;
    libSelect.innerHTML = libs
      .map((l) => `<option value="${l.id}">${escapeHtml(l.name)}</option>`)
      .join("");

    currentLibId = prev && libs.some((l) => l.id === prev) ? prev : libs[0].id;
    libSelect.value = String(currentLibId);

    setStatus(
      `Media root: <span class="code">${escapeHtml(mediaRoot)}</span> • Libraries: <span class="pill">${libs.length}</span>`
    );
  }

  function renderItems() {
    const q = qEl.value.trim().toLowerCase();
    const filtered = q ? items.filter((i) => (i.title || "").toLowerCase().includes(q)) : items;

    if (!filtered.length) {
      gridEl.innerHTML = `
        <div class="empty" style="grid-column: 1 / -1;">
          <div class="empty-title">No items found</div>
          <div class="empty-sub">
            ${items.length ? "Try a different search." : "Scan the library to index files."}
          </div>
        </div>
      `;
      return;
    }

    gridEl.innerHTML = filtered.map((i) => `
      <div class="tile" data-id="${i.id}">
        <div class="title">${escapeHtml(i.title)}</div>
        <div class="meta">${escapeHtml(i.ext)} • ${(i.size_bytes/1024/1024/1024).toFixed(2)} GB</div>
      </div>
    `).join("");

    gridEl.querySelectorAll(".tile").forEach((t) => {
      t.onclick = async () => {
        const id = parseInt(t.getAttribute("data-id"), 10);
        await play(id);
      };
    });
  }

  async function loadItems() {
    if (!currentLibId) return;
    const data = await api(`/api/items?library_id=${currentLibId}&limit=500`);
    items = Array.isArray(data.items) ? data.items : [];
    renderItems();
  }

  async function loadHomeRows() {
    // Continue watching row on the home screen
    try {
      const cont = await api(`/api/rows/continue-watching`);
      const entries = Array.isArray(cont.items) ? cont.items : [];

      if (!entries.length) {
        homeRows.innerHTML = "";
        return;
      }

      homeRows.innerHTML = `
        <div class="rowblock">
          <div class="rowhead">
            <div class="rowtitle">Continue watching</div>
            <div class="rowsub">${entries.length} item(s)</div>
          </div>
          <div class="rowgrid">
            ${entries.slice(0, 10).map((e) => {
              const it = e.item;
              if (!it) return "";
              return `
                <div class="tile mini" data-id="${it.id}">
                  <div class="title">${escapeHtml(it.title)}</div>
                  <div class="meta">${escapeHtml(it.ext)} • ${Math.floor((e.position_seconds || 0) / 60)}m</div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;

      homeRows.querySelectorAll(".tile").forEach((t) => {
        t.onclick = async () => {
          const id = parseInt(t.getAttribute("data-id"), 10);
          await play(id);
        };
      });
    } catch (_) {
      homeRows.innerHTML = "";
    }
  }

  async function play(itemId) {
    playerWrap.style.display = "block";
    rows.innerHTML = "";

    player.src = `/api/items/${itemId}/file`;
    player.play().catch(() => {});

    // Save progress periodically
    const tick = async () => {
      if (player.duration && !Number.isNaN(player.duration)) {
        await api(`/api/items/${itemId}/progress`, {
          method: "POST",
          body: JSON.stringify({
            position_seconds: Math.floor(player.currentTime || 0),
            duration_seconds: Math.floor(player.duration || 0),
          }),
        }).catch(() => {});
      }
    };
    clearInterval(window.__mwTick);
    window.__mwTick = setInterval(tick, 8000);

    // Because-you-watched row
    const because = await api(`/api/rows/because-you-watched?item_id=${itemId}`).catch(() => ({ items: [] }));
    const list = Array.isArray(because.items) ? because.items : [];

    rows.innerHTML = `
      <div class="rowblock">
        <div class="rowhead">
          <div class="rowtitle">Because you watched this</div>
          <div class="rowsub">${list.length ? `${list.length} match(es)` : "No matches yet"}</div>
        </div>
        <div class="rowgrid">
          ${list.slice(0, 10).map((i) => `
            <div class="tile mini" data-id="${i.id}">
              <div class="title">${escapeHtml(i.title)}</div>
              <div class="meta">${escapeHtml(i.ext)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    rows.querySelectorAll(".tile").forEach((t) => {
      t.onclick = async () => {
        const id = parseInt(t.getAttribute("data-id"), 10);
        await play(id);
      };
    });
  }

  async function scanCurrentLibrary() {
    if (!currentLibId) return toast("No library selected", "err");
    try {
      await api(`/api/libraries/${currentLibId}/scan`, { method: "POST" });
      toast("Scan queued", "ok");
    } catch (e) {
      toast(`Scan failed: ${e.message}`, "err", 4200);
    }
  }

  // Wire up controls
  libSelect.onchange = async () => {
    currentLibId = parseInt(libSelect.value, 10);
    await loadItems();
  };

  shell.querySelector("#scanLib").onclick = async () => {
    await scanCurrentLibrary();
  };

  shell.querySelector("#addLib").onclick = async () => {
    await openAddLibraryModal(mediaRoot, async () => {
      await loadLibs();
      await loadItems();
      await loadHomeRows();
    });
  };

  shell.querySelector("#refresh").onclick = async () => {
    await loadLibs();
    await loadItems();
    await loadHomeRows();
    toast("Refreshed", "ok");
  };

  qEl.oninput = renderItems;

  // Initial load
  await loadLibs();
  await loadItems();
  await loadHomeRows();
}

boot().catch((e) => {
  renderShell(
    `<div class="card">Boot error: <span class="code">${escapeHtml(String(e.message || e))}</span></div>`
  );
});
