// Quick commands + Fault injection + Charging sim
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

        // If faulting and a sim is running — stop it first
        if (isFault && simInterval) {
            clearInterval(simInterval);
            simInterval = null;
            simBtn.textContent = "▶ Start Charging Sim";
            simBtn.classList.remove("running");
            simInfo.textContent = "Sends MeterValues every 30s with increasing energy";
            // send StopTransaction
            await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    action: "StopTransaction",
                    payload: {
                        transactionId: simTxId,
                        meterStop: simMeter,
                        timestamp: new Date().toISOString(),
                        reason: "EmergencyStop",
                        idTag: "AABBCCDD"
                    }
                }),
            });
            await new Promise(r => setTimeout(r, 200));
        }

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

// ── Charging Simulation ────────────────────────────────────────────────────
let simInterval = null;
let simMeter = 0;
let simTxId = 1;

const simBtn = document.getElementById("sim-btn");
const simInfo = document.getElementById("sim-info");

simBtn.onclick = async () => {
    if (simInterval) {
        clearInterval(simInterval);
        simInterval = null;
        simBtn.textContent = "▶ Start Charging Sim";
        simBtn.classList.remove("running");
        simInfo.textContent = "Sends MeterValues every 30s with increasing energy";
        // send StopTransaction
        if (activeStation) {
            await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    action: "StopTransaction",
                    payload: {
                        transactionId: simTxId,
                        meterStop: simMeter,
                        timestamp: new Date().toISOString(),
                        reason: "Local",
                        idTag: "AABBCCDD"
                    }
                }),
            });
        }
        return;
    }
    if (!activeStation) return;
    simMeter = 0;
    simTxId = Math.floor(Math.random() * 90000) + 10000;
    // Authorize → StartTransaction
    await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({action: "Authorize", payload: {idTag: "AABBCCDD"}}),
    });
    await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            action: "StartTransaction",
            payload: {connectorId: 1, idTag: "AABBCCDD", meterStart: 0, timestamp: new Date().toISOString()}
        }),
    });
    await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            action: "StatusNotification",
            payload: {connectorId: 1, errorCode: "NoError", status: "Charging"}
        }),
    });

    simBtn.textContent = "■ Stop Charging Sim";
    simBtn.classList.add("running");

    simInterval = setInterval(async () => {
        if (!activeStation) {
            clearInterval(simInterval);
            simInterval = null;
            return;
        }
        simMeter += Math.floor(Math.random() * 500 + 200); // 200–700 Wh per interval
        const elapsed = Math.floor(simMeter / 1000 * 10) / 10; // fake kWh
        simInfo.textContent = `⚡ ${elapsed} kWh charged (txId: ${simTxId})`;
        await fetch("/stations/" + encodeURIComponent(activeStation) + "/execute", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                action: "MeterValues",
                payload: {
                    connectorId: 1,
                    transactionId: simTxId,
                    meterValue: [{
                        timestamp: new Date().toISOString(),
                        sampledValue: [{
                            value: String(simMeter),
                            measurand: "Energy.Active.Import.Register",
                            unit: "Wh"
                        }]
                    }]
                }
            }),
        });
    }, 10000); // every 10s for demo (use 30000 for real)
};