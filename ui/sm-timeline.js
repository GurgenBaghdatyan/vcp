// Traffic timeline (SSE, render, append, toggle)
// ── Timeline ───────────────────────────────────────────────────────────────
let trafficCache = [];
let tlFilter = "all";
let expandedIds = new Set();
let trafficSSE = null;
let pendingNewCount = 0;

document.querySelectorAll(".tl-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tl-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        tlFilter = btn.dataset.tlFilter;
        renderTimeline();
    });
});

document.getElementById("tl-clear").onclick = () => {
    trafficCache = [];
    expandedIds.clear();
    renderTimeline();
};

function connectTrafficSSE(id) {
    if (trafficSSE) { trafficSSE.close(); trafficSSE = null; }
    trafficCache = [];
    expandedIds.clear();
    pendingNewCount = 0;
    renderTimeline(); // clear DOM

    const es = new EventSource("/stations/" + encodeURIComponent(id) + "/traffic/stream");
    es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        console.log("[SSE]", data.type, data);
        if (data.type === "snapshot") {
            trafficCache = data.traffic || [];
            renderTimeline(); // full render on snapshot
        } else if (data.type === "entry") {
            trafficCache.push(data.entry);
            if (trafficCache.length > 500) trafficCache.shift();
            console.log("[SSE] calling appendTimelineEntry, trafficCache.length=", trafficCache.length);
            appendTimelineEntry(data.entry);
        }
        document.getElementById("tl-count").textContent = trafficCache.length;
    };
    es.onerror = () => {};
    trafficSSE = es;
}

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeTlRowHTML(entry) {
    const ts = (entry.timestamp || "").replace("T", " ").slice(11, 19);
    const isOut = entry.direction === "out";
    const isErr = entry.messageType === "CallError";
    const dirCls = isErr ? "tl-dir-err" : isOut ? "tl-dir-out" : "tl-dir-in";
    const dirSymbol = isErr ? "✕" : isOut ? "↗" : "↙";
    const typeCls = isErr ? "tb-error" : entry.messageType === "CallResult" ? "tb-result" : "tb-call";
    const typeLabel = isErr ? "err" : entry.messageType === "CallResult" ? "res" : "req";
    const action = entry.action || (isErr ? `${entry.errorCode}` : "—");
    const isExpanded = expandedIds.has(entry.id);
    const payloadJson = JSON.stringify(entry.payload, null, 2);
    return `<div class="tl-row${isExpanded ? " expanded" : ""}" data-tl-id="${esc(entry.id)}" onclick="toggleTlRow('${esc(entry.id)}')">
                <span class="tl-ts">${ts}</span>
                <span class="${dirCls}">${dirSymbol}</span>
                <span class="tl-type-badge ${typeCls}">${typeLabel}</span>
                <span class="tl-action">${esc(action)}</span>
                <span class="tl-arrow">${isExpanded ? "▲" : "▼"}</span>
            </div>${isExpanded ? `<div class="tl-payload-row"><pre class="tl-payload-json">${esc(payloadJson)}</pre></div>` : ""}`;
}

function appendTimelineEntry(entry) {
    const scroll = document.getElementById("tl-scroll");
    const empty = document.getElementById("tl-empty");
    const badge = document.getElementById("tl-new-badge");

    // hide empty state
    empty.style.display = "none";

    // check if entry passes current filter
    if (tlFilter === "out" && entry.direction !== "out") return;
    if (tlFilter === "in" && entry.direction !== "in") return;
    if (tlFilter === "error" && entry.messageType !== "CallError") return;

    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;

    const tmp = document.createElement("div");
    tmp.innerHTML = makeTlRowHTML(entry);
    while (tmp.firstChild) scroll.appendChild(tmp.firstChild);

    // cap DOM rows at 200
    const rows = scroll.querySelectorAll(".tl-row");
    if (rows.length > 200) {
        let toRemove = rows.length - 200;
        for (let i = 0; i < toRemove; i++) {
            const row = rows[i];
            // also remove payload if expanded
            if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains("tl-payload-row")) {
                row.nextSibling.remove();
            }
            row.remove();
        }
    }

    if (atBottom) {
        scroll.scrollTop = scroll.scrollHeight;
        badge.style.display = "none";
        pendingNewCount = 0;
    } else {
        pendingNewCount++;
        badge.textContent = `↓ ${pendingNewCount} new message${pendingNewCount > 1 ? "s" : ""}`;
        badge.style.display = "";
    }
}

// scroll-to-bottom badge click
document.getElementById("tl-new-badge").onclick = () => {
    const scroll = document.getElementById("tl-scroll");
    scroll.scrollTo({top: scroll.scrollHeight, behavior: "smooth"});
};

// hide badge when user manually scrolls to bottom
document.getElementById("tl-scroll").addEventListener("scroll", () => {
    const scroll = document.getElementById("tl-scroll");
    const badge = document.getElementById("tl-new-badge");
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 30) {
        badge.style.display = "none";
        pendingNewCount = 0;
    }
});

function renderTimeline() {
    const scroll = document.getElementById("tl-scroll");
    const empty = document.getElementById("tl-empty");
    const badge = document.getElementById("tl-new-badge");
    pendingNewCount = 0;
    badge.style.display = "none";

    let entries = trafficCache;
    if (tlFilter === "out") entries = entries.filter(e => e.direction === "out");
    if (tlFilter === "in") entries = entries.filter(e => e.direction === "in");
    if (tlFilter === "error") entries = entries.filter(e => e.messageType === "CallError");
    entries = entries.slice(-200);

    document.getElementById("tl-count").textContent = trafficCache.length;

    if (entries.length === 0) {
        scroll.innerHTML = "";
        scroll.appendChild(empty);
        empty.style.display = "flex";
        return;
    }
    empty.style.display = "none";
    scroll.innerHTML = entries.map(makeTlRowHTML).join("");
    scroll.scrollTop = scroll.scrollHeight;
}

window.toggleTlRow = function (id) {
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    // re-render only the clicked row in place to avoid scroll jump
    const scroll = document.getElementById("tl-scroll");
    const rowEl = scroll.querySelector(`[data-tl-id="${id}"]`);
    if (!rowEl) { renderTimeline(); return; }
    const entry = trafficCache.find(e => e.id === id);
    if (!entry) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = makeTlRowHTML(entry);
    // remove old payload row if present
    if (rowEl.nextSibling && rowEl.nextSibling.classList && rowEl.nextSibling.classList.contains("tl-payload-row")) {
        rowEl.nextSibling.remove();
    }
    rowEl.replaceWith(...tmp.childNodes);
};