// Helpers + station list + select + add forms + logs + keyboard
// ── Helpers ────────────────────────────────────────────────────────────────
function setMsg(el, text, ok) {
    el.textContent = text;
    el.className = "form-msg" + (ok === true ? " msg-ok" : ok === false ? " msg-err" : "");
}

const STATUS_CLASS = {
    Available: "cb-available", Charging: "cb-charging", Preparing: "cb-preparing",
    Faulted: "cb-faulted", Unavailable: "cb-unavailable", Finishing: "cb-finishing",
    SuspendedEV: "cb-finishing", SuspendedEVSE: "cb-finishing", Reserved: "cb-other",
};

async function fetchConnectors(id) {
    try {
        const d = await fetch("/stations/" + encodeURIComponent(id) + "/state").then(r => r.json());
        return d.connectors || {};
    } catch {
        return {};
    }
}

async function renderStations() {
    let stations = [];
    try {
        stations = await fetch("/stations").then(r => r.json());
    } catch {
        return;
    }
    document.getElementById("station-count").textContent = stations.length;
    const list = document.getElementById("station-list");
    list.innerHTML = "";
    for (const s of stations) {
        const connectors = await fetchConnectors(s.chargePointId);
        const card = document.createElement("div");
        card.className = "station-card" + (s.chargePointId === activeStation ? " active" : "");
        const badgesHtml = Object.entries(connectors).map(([cid, status]) => {
            const cls = STATUS_CLASS[status] || "cb-other";
            return `<span class="connector-badge ${cls}">#${cid} ${status}</span>`;
        }).join("");
        card.innerHTML = `
                <div class="station-dot"></div>
                <div class="station-info">
                    <div class="station-id">${esc(s.chargePointId)}</div>
                    <div class="station-ep">${esc(s.endpoint)}</div>
                    ${badgesHtml ? `<div class="connector-badges">${badgesHtml}</div>` : ""}
                </div>
                <button class="btn-remove" title="Disconnect">✕</button>`;
        card.onclick = e => {
            if (!e.target.classList.contains("btn-remove")) selectStation(s.chargePointId);
        };
        card.querySelector(".btn-remove").onclick = async e => {
            e.stopPropagation();
            await fetch("/stations/" + encodeURIComponent(s.chargePointId), {method: "DELETE"});
            if (activeStation === s.chargePointId) deselectStation();
            renderStations();
        };
        list.appendChild(card);
    }
}

function selectStation(id) {
    activeStation = id;
    document.getElementById("empty-state").style.display = "none";
    document.getElementById("detail-content").style.display = "flex";
    document.getElementById("log-station").textContent = id;
    lastLogLen = 0;
    fetchLogs();
    connectTrafficSSE(id);
    renderStations();
    // reset sim
    if (simInterval) {
        clearInterval(simInterval);
        simInterval = null;
        simBtn.textContent = "▶ Start Charging Sim";
        simBtn.classList.remove("running");
    }
}

function deselectStation() {
    activeStation = null;
    if (trafficSSE) {
        trafficSSE.close();
        trafficSSE = null;
    }
    document.getElementById("empty-state").style.display = "flex";
    document.getElementById("detail-content").style.display = "none";
    document.getElementById("log-scroll").innerHTML = "";
    document.getElementById("log-count").textContent = "0";
    document.getElementById("log-station").textContent = "";
    logCache = [];
    lastLogLen = 0;
    trafficCache = [];
    expandedIds.clear();
    searchInput.value = "";
    logSearch = "";
    searchClear.style.display = "none";
}

// ── Mode toggle ────────────────────────────────────────────────
document.getElementById("mode-single").onclick = () => {
    document.getElementById("mode-single").classList.add("active");
    document.getElementById("mode-batch").classList.remove("active");
    document.getElementById("panel-single").style.display = "";
    document.getElementById("panel-batch").style.display = "none";
    document.getElementById("add-msg").textContent = "";
};
document.getElementById("mode-batch").onclick = () => {
    document.getElementById("mode-batch").classList.add("active");
    document.getElementById("mode-single").classList.remove("active");
    document.getElementById("panel-single").style.display = "none";
    document.getElementById("panel-batch").style.display = "";
    document.getElementById("add-msg").textContent = "";
};

// ── Single add ────────────────────────────────────────────────
document.getElementById("btn-add").onclick = async () => {
    const id = document.getElementById("new-id").value.trim();
    const ep = document.getElementById("new-endpoint").value.trim();
    const pw = document.getElementById("new-password").value.trim();
    const msg = document.getElementById("add-msg");
    if (!id) { setMsg(msg, "Charge Point ID required", false); return; }
    setMsg(msg, "Connecting…", null);
    try {
        const d = await fetch("/stations", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({chargePointId: id, endpoint: ep || undefined, password: pw || undefined}),
        }).then(r => r.json());
        if (d.ok) {
            setMsg(msg, "✓ Connected", true);
            ["new-id", "new-endpoint", "new-password"].forEach(x => document.getElementById(x).value = "");
            renderStations();
            setTimeout(() => msg.textContent = "", 3000);
        } else {
            setMsg(msg, d.error || "Failed", false);
        }
    } catch (e) { setMsg(msg, e.message, false); }
};

// ── Batch add ────────────────────────────────────────────────
document.getElementById("btn-batch").onclick = async () => {
    const raw = document.getElementById("batch-ids").value;
    const ep  = document.getElementById("batch-endpoint").value.trim();
    const pw  = document.getElementById("batch-password").value.trim();
    const msg = document.getElementById("add-msg");

    const ids = raw.split("\n").map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) { setMsg(msg, "Enter at least one ID", false); return; }

    const progress  = document.getElementById("batch-progress");
    const bar       = document.getElementById("batch-bar");
    const counter   = document.getElementById("batch-counter");
    const statusTxt = document.getElementById("batch-status-text");
    const errBox    = document.getElementById("batch-errors");

    progress.style.display = "";
    bar.style.background = "var(--accent)";
    bar.style.width = "0%";
    errBox.textContent = "";
    document.getElementById("btn-batch").disabled = true;
    setMsg(msg, "", null);

    let done = 0, failed = 0;
    const errors = [];

    for (const id of ids) {
        statusTxt.textContent = `Connecting ${id}…`;
        counter.textContent   = `${done}/${ids.length}`;
        try {
            const d = await fetch("/stations", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({chargePointId: id, endpoint: ep || undefined, password: pw || undefined}),
            }).then(r => r.json());
            if (!d.ok) { failed++; errors.push(`✗ ${id}: ${d.error || "failed"}`); }
        } catch (e) { failed++; errors.push(`✗ ${id}: ${e.message}`); }
        done++;
        bar.style.width = `${Math.round((done / ids.length) * 100)}%`;
        counter.textContent = `${done}/${ids.length}`;
        errBox.textContent = errors.join("\n");
        renderStations();
    }

    const ok = done - failed;
    statusTxt.textContent = `Done — ${ok} connected, ${failed} failed`;
    bar.style.background = failed === 0 ? "var(--green)" : failed === done ? "var(--red)" : "var(--yellow)";
    document.getElementById("btn-batch").disabled = false;
    if (failed === 0) {
        document.getElementById("batch-ids").value = "";
        setTimeout(() => { progress.style.display = "none"; bar.style.width = "0%"; bar.style.background = "var(--accent)"; }, 3000);
    }
};

document.getElementById("btn-send").onclick = async () => {
    if (!activeStation) return;
    const statusEl = document.getElementById("send-status");
    const action = document.getElementById("action").value.trim();
    const raw = document.getElementById("payload").value.trim();
    if (!action) {
        statusEl.textContent = "Action required";
        statusEl.style.color = "var(--red)";
        return;
    }
    let payload;
    try {
        payload = JSON.parse(raw || "{}");
    } catch {
        statusEl.textContent = "Invalid JSON";
        statusEl.style.color = "var(--red)";
        return;
    }
    try {
        const r = await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({action, payload}),
        });
        if (!r.ok) throw new Error(await r.text());
        statusEl.textContent = "✓ Sent";
        statusEl.style.color = "var(--green)";
        setTimeout(() => statusEl.textContent = "", 2500);
    } catch (e) {
        statusEl.textContent = e.message;
        statusEl.style.color = "var(--red)";
    }
};

document.getElementById("action").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("btn-send").click();
});

// ── Log filter ─────────────────────────────────────────────────────────────
let activeFilter = "all";
let logCache = [];
let logSearch = "";

document.querySelectorAll(".log-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".log-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activeFilter = btn.dataset.filter;
        renderLogs();
    });
});

const searchInput = document.getElementById("log-search");
const searchClear = document.getElementById("log-search-clear");

searchInput.addEventListener("input", () => {
    logSearch = searchInput.value;
    searchClear.style.display = logSearch ? "block" : "none";
    renderLogs();
});
searchClear.addEventListener("click", () => {
    searchInput.value = "";
    logSearch = "";
    searchClear.style.display = "none";
    searchInput.focus();
    renderLogs();
});
document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f" && activeStation) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
    }
    if (e.key === "Escape" && document.activeElement === searchInput) searchInput.blur();
});

function highlight(text, query) {
    if (!query) return esc(text);
    return esc(text).replace(
        new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        m => `<mark class="log-match">${m}</mark>`
    );
}

function applyFilter(logs) {
    if (activeFilter === "out") return logs.filter(l => (l.message || "").includes("➡️"));
    if (activeFilter === "inc") return logs.filter(l => (l.message || "").includes("⬅️"));
    if (activeFilter === "warn") return logs.filter(l => ["warn", "error"].includes((l.level || "").toLowerCase()));
    return logs;
}

function renderLogs() {
    const scroll = document.getElementById("log-scroll");
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    let filtered = applyFilter(logCache);
    if (logSearch) {
        const q = logSearch.toLowerCase();
        filtered = filtered.filter(l => (l.message || "").toLowerCase().includes(q));
    }
    filtered = filtered.slice(-300);
    scroll.innerHTML = filtered.map(l => {
        const lvl = (l.level || "info").toLowerCase();
        const cls = lvl === "warn" ? "l-warn" : lvl === "error" ? "l-error" : "l-info";
        const ts = (l.timestamp || "").replace("T", " ").slice(0, 19);
        const msg = l.message || "";
        const dir = msg.includes("➡️") ? "out" : msg.includes("⬅️") ? "inc" : "";
        const msgHtml = logSearch ? highlight(msg, logSearch) : esc(msg);
        return `<div class="log-line ${dir}"><span class="log-ts">${ts}</span><span class="${cls}">${lvl.slice(0, 4)}</span><span class="log-msg">${msgHtml}</span></div>`;
    }).join("");
    if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

async function fetchLogs() {
    if (!activeStation) return;
    try {
        const {logs = []} = await fetch("/stations/" + encodeURIComponent(activeStation) + "/logs").then(r => r.json());
        document.getElementById("log-count").textContent = logs.length;
        if (logs.length === lastLogLen) return;
        lastLogLen = logs.length;
        logCache = logs;
        renderLogs();
    } catch {
    }
}

async function fetchHealth() {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    try {
        await fetch("/health");
        dot.className = "status-dot ok";
        text.textContent = "online";
    } catch {
        dot.className = "status-dot err";
        text.textContent = "offline";
    }
}

// ── Log resize ─────────────────────────────────────────────────────────────
const detail = document.querySelector(".detail");
const logPane = document.getElementById("log-pane");
const handle = document.getElementById("log-resize-handle");
const collapseBtn = document.getElementById("log-collapse-btn");

const MIN_LOG_H = 36, MAX_LOG_H = 600, DEF_LOG_H = 220, TOOLBAR_H = 36;
let logH = parseInt(localStorage.getItem("ocpp-log-h") || DEF_LOG_H);
let collapsed = localStorage.getItem("ocpp-log-collapsed") === "1";

function setLogHeight(h, save = true) {
    logH = Math.max(MIN_LOG_H, Math.min(MAX_LOG_H, h));
    detail.style.gridTemplateRows = collapsed ? `1fr ${TOOLBAR_H}px` : `1fr ${logH}px`;
    if (save) localStorage.setItem("ocpp-log-h", logH);
    syncCollapseBtn();
}

function syncCollapseBtn() {
    collapseBtn.textContent = collapsed ? "╷" : "╵";
    collapseBtn.title = collapsed ? "Expand logs" : "Collapse logs";
    logPane.querySelector(".log-scroll").style.display = collapsed ? "none" : "";
}

function applyCollapsed(save = true) {
    detail.style.gridTemplateRows = collapsed ? `1fr ${TOOLBAR_H}px` : `1fr ${logH}px`;
    if (save) localStorage.setItem("ocpp-log-collapsed", collapsed ? "1" : "0");
    syncCollapseBtn();
}

collapseBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    applyCollapsed();
});
logPane.querySelector(".log-toolbar").addEventListener("dblclick", (e) => {
    if (e.target === collapseBtn) return;
    collapsed = !collapsed;
    applyCollapsed();
});

let dragStartY = 0, dragStartH = 0;
handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartH = logH;
    collapsed = false;
    handle.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
});
document.addEventListener("mousemove", (e) => {
    if (!handle.classList.contains("dragging")) return;
    setLogHeight(dragStartH + (dragStartY - e.clientY));
});
document.addEventListener("mouseup", () => {
    if (!handle.classList.contains("dragging")) return;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem("ocpp-log-h", logH);
});

applyCollapsed(false);
if (!collapsed) setLogHeight(logH, false);

// ── Boot ───────────────────────────────────────────────────────────────────
renderStations();
fetchHealth();
setInterval(renderStations, 5000);
setInterval(fetchHealth, 10000);
setInterval(fetchLogs, 2000);