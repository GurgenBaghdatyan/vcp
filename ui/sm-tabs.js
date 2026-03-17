// Tab switching
// ── Tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "timeline" && activeStation) {
            const scroll = document.getElementById("tl-scroll");
            const badge = document.getElementById("tl-new-badge");
            pendingNewCount = 0;
            badge.style.display = "none";
            scroll.scrollTop = scroll.scrollHeight;
        }
    });
});