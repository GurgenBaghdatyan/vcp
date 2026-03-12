import * as util from "node:util";
import { WebSocket } from "ws";

import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "./logger";
import { call } from "./messageFactory";
import type { OcppCall, OcppCallError, OcppCallResult } from "./ocppMessage";
import {
  type OcppMessageHandler,
  resolveMessageHandler,
} from "./ocppMessageHandler";
import { ocppOutbox } from "./ocppOutbox";
import { type OcppVersion, toProtocolVersion } from "./ocppVersion";
import {
  validateOcppIncomingRequest,
  validateOcppIncomingResponse,
  validateOcppOutgoingRequest,
  validateOcppOutgoingResponse,
} from "./schemaValidator";
import { TransactionManager } from "./transactionManager";
import { heartbeatOcppMessage } from "./v16/messages/heartbeat";

interface VCPOptions {
  ocppVersion: OcppVersion;
  endpoint: string;
  chargePointId: string;
  basicAuthPassword?: string;
  adminPort?: number;
}

interface LogEntry {
  type: "Application";
  timestamp: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
}

export class VCP {
  private ws?: WebSocket;
  private messageHandler: OcppMessageHandler;

  private isFinishing = false;
  private logBuffer: LogEntry[] = [];

  transactionManager = new TransactionManager();

  constructor(private vcpOptions: VCPOptions) {
    this.messageHandler = resolveMessageHandler(vcpOptions.ocppVersion);

    // Capture logs in memory for UI/diagnostics
    const transport = logger.transports[0];
    transport.on(
      "logged",
      (info: {
        timestamp?: string;
        level: string;
        message: string;
        [key: string]: unknown;
      }) => {
        const entry: LogEntry = {
          type: "Application",
          timestamp: info.timestamp || new Date().toISOString(),
          level: info.level,
          message: info.message,
          metadata: Object.fromEntries(
            Object.entries(info).filter(
              ([key]) => !["timestamp", "level", "message"].includes(key),
            ),
          ),
        };
        this.logBuffer.push(entry);
        if (this.logBuffer.length > 300) {
          this.logBuffer.shift();
        }
      },
    );

    if (vcpOptions.adminPort) {
      const adminApi = new Hono();

      // Basic CORS to allow local frontends
      adminApi.use("*", async (c, next) => {
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Access-Control-Allow-Headers", "Content-Type");
        c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        if (c.req.method === "OPTIONS") {
          return c.text("OK");
        }
        await next();
      });

      adminApi.get("/health", (c) => c.text("OK"));
      adminApi.post(
        "/execute",
        zValidator(
          "json",
          z.object({
            action: z.string(),
            payload: z.any(),
          }),
        ),
        (c) => {
          const validated = c.req.valid("json");
          this.send(call(validated.action, validated.payload));
          return c.text("OK");
        },
      );
      adminApi.get("/logs", (c) => c.json({ logs: this.logBuffer }));
      adminApi.get("/state", (c) =>
        c.json({
          chargePointId: this.vcpOptions.chargePointId,
          endpoint: this.vcpOptions.endpoint,
          ocppVersion: this.vcpOptions.ocppVersion,
          connected: Boolean(this.ws),
          readyState: this.ws?.readyState ?? null,
        }),
      );
      adminApi.get("/ui", (c) =>
        c.html(`
        <!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>OCPP VCP Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0b0e14;
      --surface:   #111620;
      --surface2:  #181f2e;
      --border:    #1e2840;
      --border2:   #2a3650;
      --accent:    #3b82f6;
      --accent2:   #60a5fa;
      --green:     #22c55e;
      --red:       #ef4444;
      --yellow:    #f59e0b;
      --text:      #e2e8f0;
      --muted:     #64748b;
      --mono:      "IBM Plex Mono", monospace;
      --sans:      "IBM Plex Sans", sans-serif;
    }

    html, body { height: 100%; }

    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      display: grid;
      grid-template-rows: 48px 1fr;
      grid-template-columns: 260px 1fr;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Topbar ── */
    header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      z-index: 10;
    }
    .logo {
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--accent2);
    }
    .logo span { color: var(--muted); }
    .sep { flex: 1; }
    .badge {
      font-family: var(--mono);
      font-size: 11px;
      padding: 3px 9px;
      border-radius: 99px;
      border: 1px solid var(--border2);
      color: var(--muted);
    }
    .badge.ok { border-color: #166534; color: var(--green); background: #0f2b1a; }
    .badge.err { border-color: #7f1d1d; color: var(--red); background: #2b0f0f; }

    /* ── Sidebar ── */
    nav {
      background: var(--surface);
      border-right: 1px solid var(--border);
      overflow-y: auto;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .nav-section {
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 8px 8px 4px;
    }
    .cmd-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 7px;
      color: var(--text);
      font-family: var(--sans);
      font-size: 13px;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s, border-color 0.15s;
    }
    .cmd-btn:hover { background: var(--surface2); border-color: var(--border); }
    .cmd-btn.active { background: #1a2744; border-color: var(--accent); color: var(--accent2); }
    .cmd-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }
    .cmd-btn.active .cmd-dot { background: var(--accent); }

    /* ── Main ── */
    main {
      display: grid;
      grid-template-rows: 1fr 200px;
      overflow: hidden;
    }

    .workspace {
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: var(--muted);
      text-transform: uppercase;
    }
    .panel-body { padding: 16px; }

    /* ── State grid ── */
    .state-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
    }
    .state-item { display: flex; flex-direction: column; gap: 4px; }
    .state-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .state-value {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--text);
    }

    /* ── Send form ── */
    .form-row { display: flex; flex-direction: column; gap: 6px; }
    label.field-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    input.field, textarea.field {
      width: 100%;
      padding: 9px 12px;
      background: var(--bg);
      border: 1px solid var(--border2);
      border-radius: 7px;
      color: var(--text);
      font-family: var(--mono);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
      resize: vertical;
    }
    input.field:focus, textarea.field:focus { border-color: var(--accent); }

    .send-row { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
    .btn-primary {
      padding: 9px 20px;
      background: var(--accent);
      border: none;
      border-radius: 7px;
      color: #fff;
      font-family: var(--sans);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .btn-primary:hover { background: #2563eb; }
    .btn-primary:active { transform: scale(0.97); }
    #send-status {
      font-family: var(--mono);
      font-size: 12px;
    }
    .status-ok { color: var(--green); }
    .status-err { color: var(--red); }

    /* ── Log panel ── */
    .log-pane {
      background: var(--bg);
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .log-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .log-title {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .log-count {
      font-family: var(--mono);
      font-size: 10px;
      background: var(--surface2);
      border: 1px solid var(--border2);
      color: var(--muted);
      padding: 1px 7px;
      border-radius: 99px;
    }
    .log-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 8px 16px;
    }
    .log-line {
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-ts { color: #334155; }
    .log-info { color: #38bdf8; }
    .log-warn { color: var(--yellow); }
    .log-error { color: var(--red); }
    .log-msg { color: #94a3b8; }

    /* scrollbars */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
  </style>
</head>
<body>

<header>
  <div class="logo">OCPP <span>/</span> VCP Admin</div>
  <div class="sep"></div>
  <div class="badge" id="health-badge">connecting…</div>
</header>

<nav>
  <div class="nav-section">Commands</div>
  <div id="cmd-list"></div>
</nav>

<main>
  <div class="workspace">

    <!-- State -->
    <div class="panel">
      <div class="panel-header">
        <span>Connection State</span>
        <span id="ready-state" style="font-family:var(--mono);font-size:11px;"></span>
      </div>
      <div class="panel-body">
        <div class="state-grid" id="state-grid">
          <div class="state-item"><div class="state-label">Charge Point</div><div class="state-value" id="s-cpid">—</div></div>
          <div class="state-item"><div class="state-label">Endpoint</div><div class="state-value" id="s-ep">—</div></div>
          <div class="state-item"><div class="state-label">OCPP Version</div><div class="state-value" id="s-ver">—</div></div>
          <div class="state-item"><div class="state-label">Connected</div><div class="state-value" id="s-conn">—</div></div>
        </div>
      </div>
    </div>

    <!-- Send -->
    <div class="panel">
      <div class="panel-header">Send Message</div>
      <div class="panel-body" style="display:flex;flex-direction:column;gap:12px;">
        <div class="form-row">
          <label class="field-label">Action</label>
          <input id="action" class="field" readonly placeholder="Select a command →" />
        </div>
        <div class="form-row" id="payload-block">
          <label class="field-label">Payload <span style="color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">(JSON)</span></label>
          <textarea id="payload" class="field" rows="6" spellcheck="false"></textarea>
        </div>
        <div class="send-row">
          <button class="btn-primary" id="send">Send ↗</button>
          <span id="send-status"></span>
        </div>
      </div>
    </div>

  </div>

  <!-- Logs -->
  <div class="log-pane">
    <div class="log-toolbar">
      <span class="log-title">Logs</span>
      <span class="log-count" id="log-count">0</span>
    </div>
    <div class="log-scroll" id="log-scroll"></div>
  </div>
</main>

<script>
  const COMMANDS = [
    { label: "BootNotification",     action: "BootNotification",     payload: { chargePointVendor: "Solidstudio", chargePointModel: "VirtualCP" } },
    { label: "Status — Available",   action: "StatusNotification",   payload: { connectorId: 1, errorCode: "NoError", status: "Available" } },
    { label: "Status — Charging",    action: "StatusNotification",   payload: { connectorId: 1, errorCode: "NoError", status: "Charging" } },
    { label: "Heartbeat",            action: "Heartbeat",            payload: {} },
    { label: "Authorize",            action: "Authorize",            payload: { idTag: "AABBCCDD" } },
    { label: "StartTransaction",     action: "StartTransaction",     payload: { connectorId: 1, idTag: "AABBCCDD", meterStart: 0, timestamp: new Date().toISOString() } },
    { label: "StopTransaction",      action: "StopTransaction",      payload: { transactionId: 1, meterStop: 10, timestamp: new Date().toISOString() } },
    { label: "MeterValues",          action: "MeterValues",          payload: { connectorId: 1, transactionId: 1, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [{ value: "1.0", measurand: "Energy.Active.Import.Register" }] }] } },
    { label: "RemoteStartTransaction", action: "RemoteStartTransaction", payload: { idTag: "AABBCCDD", connectorId: 1 } },
    { label: "RemoteStopTransaction",  action: "RemoteStopTransaction",  payload: { transactionId: 1 } },
    { label: "Custom",               action: "",                     payload: {} },
  ];

  const actionEl    = document.getElementById("action");
  const payloadEl   = document.getElementById("payload");
  const payloadBlock= document.getElementById("payload-block");
  const statusEl    = document.getElementById("send-status");
  const logScroll   = document.getElementById("log-scroll");
  const logCount    = document.getElementById("log-count");
  const healthBadge = document.getElementById("health-badge");
  let activeBtn     = null;

  // Build sidebar
  const cmdList = document.getElementById("cmd-list");
  COMMANDS.forEach((cmd) => {
    const btn = document.createElement("button");
    btn.className = "cmd-btn";
    btn.innerHTML = '<span class="cmd-dot"></span>' + cmd.label;
    btn.onclick = () => {
      if (activeBtn) activeBtn.classList.remove("active");
      btn.classList.add("active");
      activeBtn = btn;
      actionEl.value = cmd.action;
      payloadEl.value = cmd.label === "Custom" ? "{}" : JSON.stringify(cmd.payload, null, 2);
      payloadBlock.style.display = "flex";
    };
    cmdList.appendChild(btn);
  });

  // State
  async function fetchState() {
    try {
      const r = await fetch("/state");
      const d = await r.json();
      document.getElementById("s-cpid").textContent = d.chargePointId ?? "—";
      document.getElementById("s-ep").textContent   = d.endpoint ?? "—";
      document.getElementById("s-ver").textContent  = d.ocppVersion ?? "—";
      const connEl = document.getElementById("s-conn");
      connEl.textContent = d.connected ? "yes" : "no";
      connEl.style.color = d.connected ? "var(--green)" : "var(--red)";
      const dash = "—";
      document.getElementById("ready-state").textContent = "readyState " + (d.readyState ?? dash);
    } catch {}
  }

  // Health
  async function fetchHealth() {
    try {
      const r = await fetch("/health");
      const t = await r.text();
      healthBadge.textContent = t;
      healthBadge.className = "badge ok";
    } catch {
      healthBadge.textContent = "offline";
      healthBadge.className = "badge err";
    }
  }

  // Logs
  let lastLogLen = 0;
  async function fetchLogs() {
    try {
      const r = await fetch("/logs");
      const d = await r.json();
      const logs = d.logs ?? [];
      logCount.textContent = logs.length;
      if (logs.length === lastLogLen) return;
      lastLogLen = logs.length;
      const atBottom = logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 40;
      logScroll.innerHTML = logs.slice(-300).map(l => {
        const lvl = (l.level || "info").toLowerCase();
        const cls = lvl === "warn" ? "log-warn" : lvl === "error" ? "log-error" : "log-info";
        const ts  = (l.timestamp || "").replace("T"," ").slice(0,19);
        return '<div class="log-line"><span class="log-ts">' + ts + '</span> <span class="' + cls + '">[' + lvl + ']</span> <span class="log-msg">' + escHtml(l.message) + '</span></div>';
      }).join("");
      if (atBottom) logScroll.scrollTop = logScroll.scrollHeight;
    } catch {}
  }

  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // Send
  document.getElementById("send").addEventListener("click", async () => {
    statusEl.textContent = "";
    const action = actionEl.value.trim();
    if (!action) { statusEl.textContent = "Select a command first"; statusEl.className = "status-err"; return; }
    let parsed;
    try { parsed = payloadEl.value.trim() ? JSON.parse(payloadEl.value) : {}; }
    catch { statusEl.textContent = "Invalid JSON"; statusEl.className = "status-err"; return; }
    try {
      const r = await fetch("/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload: parsed }),
      });
      if (!r.ok) throw new Error(r.statusText);
      statusEl.textContent = "✓ Sent";
      statusEl.className = "status-ok";
      setTimeout(() => statusEl.textContent = "", 3000);
      fetchLogs();
    } catch (e) {
      statusEl.textContent = "Error: " + e.message;
      statusEl.className = "status-err";
    }
  });

  fetchState(); fetchHealth(); fetchLogs();
  setInterval(fetchState,  5000);
  setInterval(fetchHealth, 10000);
  setInterval(fetchLogs,   3000);
</script>
</body>
</html>
`),
      );
      serve({
        fetch: adminApi.fetch,
        port: vcpOptions.adminPort,
      });
    }
  }

  async connect(): Promise<void> {
    logger.info(`Connecting... | ${util.inspect(this.vcpOptions)}`);
    this.isFinishing = false;
    return new Promise((resolve) => {
      const websocketUrl = `${this.vcpOptions.endpoint}/${this.vcpOptions.chargePointId}`;
      const protocol = toProtocolVersion(this.vcpOptions.ocppVersion);
      this.ws = new WebSocket(websocketUrl, [protocol], {
        rejectUnauthorized: false,
        followRedirects: true,
        headers: {
          ...(this.vcpOptions.basicAuthPassword && {
            Authorization: `Basic ${Buffer.from(
              `${this.vcpOptions.chargePointId}:${this.vcpOptions.basicAuthPassword}`,
            ).toString("base64")}`,
          }),
        },
      });

      this.ws.on("open", () => resolve());
      this.ws.on("message", (message: string) => this._onMessage(message));
      this.ws.on("ping", () => {
        logger.info("Received PING");
      });
      this.ws.on("pong", () => {
        logger.info("Received PONG");
      });
      this.ws.on("close", (code: number, reason: string) =>
        this._onClose(code, reason),
      );
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  send(ocppCall: OcppCall<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    ocppOutbox.enqueue(ocppCall);
    const jsonMessage = JSON.stringify([
      2,
      ocppCall.messageId,
      ocppCall.action,
      ocppCall.payload,
    ]);
    logger.info(`Sending message ➡️  ${jsonMessage}`);
    validateOcppOutgoingRequest(
      this.vcpOptions.ocppVersion,
      ocppCall.action,
      JSON.parse(JSON.stringify(ocppCall.payload)),
    );
    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respond(result: OcppCallResult<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    validateOcppIncomingResponse(
      this.vcpOptions.ocppVersion,
      result.action,
      JSON.parse(JSON.stringify(result.payload)),
    );
    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respondError(error: OcppCallError<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    const jsonMessage = JSON.stringify([
      4,
      error.messageId,
      error.errorCode,
      error.errorDescription,
      error.errorDetails,
    ]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    this.ws.send(jsonMessage);
  }

  configureHeartbeat(interval: number) {
    setInterval(() => {
      this.send(heartbeatOcppMessage.request({}));
    }, interval);
  }

  close() {
    if (!this.ws) {
      throw new Error(
        "Trying to close a Websocket that was not opened. Call connect() first",
      );
    }
    this.isFinishing = true;
    this.ws.close();
    this.ws = undefined;
    process.exit(1);
  }

  async getDiagnosticData(): Promise<LogEntry[]> {
    try {
      return this.logBuffer;
    } catch (err) {
      logger.error("Failed to read application logs:", err);
      return [];
    }
  }

  private _onMessage(message: string) {
    logger.info(`Receive message ⬅️  ${message}`);
    const data = JSON.parse(message);
    const [type, ...rest] = data;
    if (type === 2) {
      const [messageId, action, payload] = rest;
      validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);
      this.messageHandler.handleCall(this, { messageId, action, payload });
    } else if (type === 3) {
      const [messageId, payload] = rest;
      const enqueuedCall = ocppOutbox.get(messageId);
      if (!enqueuedCall) {
        throw new Error(
          `Received CallResult for unknown messageId=${messageId}`,
        );
      }
      validateOcppOutgoingResponse(
        this.vcpOptions.ocppVersion,
        enqueuedCall.action,
        payload,
      );
      this.messageHandler.handleCallResult(this, enqueuedCall, {
        messageId,
        payload,
        action: enqueuedCall.action,
      });
    } else if (type === 4) {
      const [messageId, errorCode, errorDescription, errorDetails] = rest;
      this.messageHandler.handleCallError(this, {
        messageId,
        errorCode,
        errorDescription,
        errorDetails,
      });
    } else {
      throw new Error(`Unrecognized message type ${type}`);
    }
  }

  private _onClose(code: number, reason: string) {
    if (this.isFinishing) {
      return;
    }
    logger.info(`Connection closed. code=${code}, reason=${reason}`);
    process.exit();
  }
}
