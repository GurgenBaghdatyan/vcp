// Quick commands + Fault injection + MeterValues live control
// ── Commands ───────────────────────────────────────────────────────────────
const COMMANDS = [
    {
        label: "Boot",
        action: "BootNotification",
        payload: {chargePointVendor: "Solidstudio", chargePointModel: "VirtualCP"}
    },
    {
        label: "Available",
        action: "StatusNotification",
        payload: {connectorId: 1, errorCode: "NoError", status: "Available"}
    },
    {
        label: "Preparing",
        action: "StatusNotification",
        payload: {connectorId: 1, errorCode: "NoError", status: "Preparing"}
    },
    {
        label: "Charging",
        action: "StatusNotification",
        payload: {connectorId: 1, errorCode: "NoError", status: "Charging"}
    },
    {
        label: "Faulted",
        action: "StatusNotification",
        payload: {connectorId: 1, errorCode: "InternalError", status: "Faulted"}
    },
    {label: "Heartbeat", action: "Heartbeat", payload: {}},
    {label: "Authorize", action: "Authorize", payload: {idTag: "AABBCCDD"}},
    {
        label: "StartTx", action: "StartTransaction", get payload() {
            return {connectorId: 1, idTag: "AABBCCDD", meterStart: 0, timestamp: new Date().toISOString()};
        }
    },
    {
        label: "StopTx", action: "StopTransaction", get payload() {
            return {
                transactionId: 1,
                meterStop: 100,
                timestamp: new Date().toISOString(),
                reason: "Remote",
                idTag: "AABBCCDD"
            };
        }
    },
];

let activeStation = null, lastLogLen = 0, activeCmd = null;

for (const cmd of COMMANDS) {
    const pill = document.createElement("button");
    pill.className = "cmd-pill";
    pill.textContent = cmd.label;
    pill.onclick = () => {
        activeCmd?.classList.remove("active");
        pill.classList.add("active");
        activeCmd = pill;
        document.getElementById("action").value = cmd.action;
        document.getElementById("payload").value = JSON.stringify(cmd.payload, null, 2);
    };
    document.getElementById("cmd-grid").appendChild(pill);
}

// ── Fault Injection ────────────────────────────────────────────────────────
const FAULTS = [
    {label: "ConnectorLockFailure", desc: "Connector locking mechanism failure"},
    {label: "EVCommunicationError", desc: "Communication failure with EV"},
    {label: "GroundFailure", desc: "Ground fault detected"},
    {label: "HighTemperature", desc: "Temperature too high"},
    {label: "InternalError", desc: "Internal hardware / software error"},
    {label: "LocalListConflict", desc: "Presented token conflicts with local list"},
    {label: "NoError", desc: "No error (use for recovery)"},
    {label: "OtherError", desc: "Any other error"},
    {label: "OverCurrentFailure", desc: "Over-current protection triggered"},
    {label: "OverVoltage", desc: "Voltage higher than specification"},
    {label: "PowerMeterFailure", desc: "Power meter communication failure"},
    {label: "PowerSwitchFailure", desc: "Power switch control failure"},
    {label: "ReaderFailure", desc: "RFID reader failure"},
    {label: "ResetFailure", desc: "Reset failure"},
    {label: "UnderVoltage", desc: "Voltage below specification"},
    {label: "WeakSignal", desc: "Wireless link too weak"},
];

const faultGrid = document.getElementById("fault-grid");
for (const f of FAULTS) {
    const btn = document.createElement("button");
    btn.className = "fault-btn";
    btn.innerHTML = `<span class="fault-btn-label">${f.label}</span><span class="fault-btn-desc">${f.desc}</span>`;
    btn.onclick = () => sendFault(f.label);
    faultGrid.appendChild(btn);
}

async function sendFault(errorCode) {
    if (!activeStation) return;
    const statusEl = document.getElementById("fault-status");
    statusEl.textContent = "";
    statusEl.className = "fault-status";
    try {
        const isFault = errorCode !== "NoError";
        const r = await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                action: "StatusNotification",
                payload: {connectorId: 1, errorCode, status: isFault ? "Faulted" : "Available"}
            }),
        });
        if (!r.ok) throw new Error(await r.text());
        statusEl.textContent = isFault ? `⚠ Faulted: ${errorCode}` : "✓ Available";
        statusEl.className = isFault ? "fault-status err" : "fault-status ok";
        setTimeout(() => statusEl.textContent = "", 4000);
    } catch (e) {
        statusEl.textContent = e.message;
        statusEl.className = "fault-status err";
    }
}

document.getElementById("fault-recover-btn").onclick = () => sendFault("NoError");

// ── MeterValues live control ───────────────────────────────────────────────
const mvNoTx      = document.getElementById("mv-no-tx");
const mvPanel     = document.getElementById("mv-panel");
const mvTxId      = document.getElementById("mv-tx-id");
const mvTxWh      = document.getElementById("mv-tx-wh");
const mvWhSlider  = document.getElementById("mv-wh");
const mvWhValue   = document.getElementById("mv-wh-value");
const mvIntSlider = document.getElementById("mv-interval");
const mvIntValue  = document.getElementById("mv-interval-value");
const mvApplyBtn  = document.getElementById("mv-apply-btn");
const mvApplySt   = document.getElementById("mv-apply-status");

let mvActiveTxId  = null;
let mvPollTimer   = null;

function mvFormatWh(wh) {
    if (wh >= 1000) return (wh / 1000).toFixed(1) + "k Wh/min";
    return wh + " Wh/min";
}

// Slider → label sync
mvWhSlider.addEventListener("input", () => {
    mvWhValue.textContent = mvFormatWh(Number(mvWhSlider.value));
    document.querySelectorAll(".mv-preset-btn").forEach(b =>
        b.classList.toggle("active", Number(b.dataset.wh) === Number(mvWhSlider.value))
    );
});
mvIntSlider.addEventListener("input", () => {
    mvIntValue.textContent = mvIntSlider.value + " s";
    document.querySelectorAll(".mv-ipreset-btn").forEach(b =>
        b.classList.toggle("active", Number(b.dataset.sec) === Number(mvIntSlider.value))
    );
});

// Preset buttons
document.querySelectorAll(".mv-preset-btn").forEach(btn => {
    btn.onclick = () => {
        const wh = Number(btn.dataset.wh);
        mvWhSlider.value = wh;
        mvWhValue.textContent = mvFormatWh(wh);
        document.querySelectorAll(".mv-preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
    };
});
document.querySelectorAll(".mv-ipreset-btn").forEach(btn => {
    btn.onclick = () => {
        const sec = Number(btn.dataset.sec);
        mvIntSlider.value = sec;
        mvIntValue.textContent = sec + " s";
        document.querySelectorAll(".mv-ipreset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
    };
});

// Apply button
mvApplyBtn.onclick = async () => {
    if (!activeStation || !mvActiveTxId) return;
    mvApplySt.textContent = "";
    mvApplySt.className = "mv-apply-status";
    try {
        const r = await fetch("/stations/" + encodeURIComponent(activeStation) + "/meter-config", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                transactionId: mvActiveTxId,
                whPerMinute:   Number(mvWhSlider.value),
                intervalSec:   Number(mvIntSlider.value),
            }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || "Failed");
        mvApplySt.textContent = "✓ Applied";
        mvApplySt.className = "mv-apply-status ok";
        setTimeout(() => mvApplySt.textContent = "", 3000);
    } catch (e) {
        mvApplySt.textContent = e.message;
        mvApplySt.className = "mv-apply-status err";
    }
};

// Poll meter-config to detect transaction start/stop and update Wh counter
async function mvPoll() {
    if (!activeStation) return;
    try {
        const d = await fetch("/stations/" + encodeURIComponent(activeStation) + "/meter-config")
            .then(r => r.json());
        const txList = d.transactions || [];
        if (txList.length === 0) {
            mvActiveTxId = null;
            mvNoTx.style.display = "";
            mvPanel.style.display = "none";
        } else {
            // Show first active transaction (connector 1)
            const tx = txList[0];
            const firstLoad = mvActiveTxId === null;
            mvActiveTxId = tx.transactionId;
            mvNoTx.style.display = "none";
            mvPanel.style.display = "";
            mvTxId.textContent = tx.transactionId;
            mvTxWh.textContent = tx.meterValue >= 1000
                ? (tx.meterValue / 1000).toFixed(2) + " kWh"
                : tx.meterValue + " Wh";

            // On first load populate sliders from server state
            if (firstLoad) {
                mvWhSlider.value = tx.whPerMinute;
                mvWhValue.textContent = mvFormatWh(tx.whPerMinute);
                mvIntSlider.value = tx.intervalSec;
                mvIntValue.textContent = tx.intervalSec + " s";
                // sync preset active state
                document.querySelectorAll(".mv-preset-btn").forEach(b =>
                    b.classList.toggle("active", Number(b.dataset.wh) === tx.whPerMinute)
                );
                document.querySelectorAll(".mv-ipreset-btn").forEach(b =>
                    b.classList.toggle("active", Number(b.dataset.sec) === tx.intervalSec)
                );
            }
        }
    } catch { /* ignore */ }
}

// Start/stop polling when station is selected/deselected
function mvStartPoll() {
    mvStopPoll();
    mvActiveTxId = null;
    mvNoTx.style.display = "";
    mvPanel.style.display = "none";
    mvPoll();
    mvPollTimer = setInterval(mvPoll, 3000);
}

function mvStopPoll() {
    if (mvPollTimer) { clearInterval(mvPollTimer); mvPollTimer = null; }
    mvActiveTxId = null;
    mvNoTx.style.display = "";
    mvPanel.style.display = "none";
}

// Hook into station select/deselect (called from sm-stations.js)
const _origSelectStation = window._mvSelectHook;
window.mvOnSelectStation  = mvStartPoll;
window.mvOnDeselectStation = mvStopPoll;