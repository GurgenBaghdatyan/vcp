// Theme switcher
// ── Theme ──────────────────────────────────────────────────────────────────
const THEMES = ["dark", "dimmed", "light", "solarized"];
const root = document.documentElement;

function applyTheme(t) {
    if (!THEMES.includes(t)) t = "dark";
    root.setAttribute("data-theme", t);
    localStorage.setItem("ocpp-theme", t);
    document.querySelectorAll(".theme-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.theme === t);
    });
}

document.querySelectorAll(".theme-btn").forEach(btn => btn.addEventListener("click", () => applyTheme(btn.dataset.theme)));
applyTheme(localStorage.getItem("ocpp-theme") || "dark");