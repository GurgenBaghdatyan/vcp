import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";

import {serve} from "@hono/node-server";
import {zValidator} from "@hono/zod-validator";
import {Hono} from "hono";
import {streamSSE} from "hono/streaming";
import {z} from "zod";
import {OcppVersion} from "./src/ocppVersion";
import {call} from "./src/messageFactory";
import {logger} from "./src/logger";
import {bootNotificationOcppMessage} from "./src/v16/messages/bootNotification";
import {statusNotificationOcppMessage} from "./src/v16/messages/statusNotification";
import {VCP} from "./src/vcp";


const defaultEndpoint = process.env.WS_URL ?? "ws://localhost:8088/OCPP";
const defaultCpId = process.env.CP_ID ?? "123456";
const defaultPassword = process.env.PASSWORD;
const adminPort = Number.parseInt(process.env.ADMIN_PORT ?? "9999");

interface StationEntry {
    vcp: VCP;
    chargePointId: string;
    endpoint: string;
    password?: string;
    connectedAt: string;
    status: "connected" | "disconnected";
}

const stations = new Map<string, StationEntry>();

async function spawnStation(chargePointId: string, endpoint: string, password?: string): Promise<void> {
    if (stations.has(chargePointId)) {
        throw new Error(`Station ${chargePointId} already exists`);
    }

    const vcp = new VCP({
        endpoint,
        chargePointId,
        ocppVersion: OcppVersion.OCPP_1_6,
        basicAuthPassword: password,
    });

    await vcp.connect();

    vcp.send(bootNotificationOcppMessage.request({
        chargePointVendor: "Solidstudio",
        chargePointModel: "VirtualChargePoint",
        chargePointSerialNumber: chargePointId,
        firmwareVersion: "1.0.0",
    }));

    vcp.send(statusNotificationOcppMessage.request({
        connectorId: 1,
        errorCode: "NoError",
        status: "Available",
    }));

    stations.set(chargePointId, {
        vcp,
        chargePointId,
        endpoint,
        password,
        connectedAt: new Date().toISOString(),
        status: "connected",
    });

    vcp.on("disconnected", () => {
        logger.info(`Station ${chargePointId} disconnected unexpectedly — marking as disconnected`);
        const entry = stations.get(chargePointId);
        if (entry) entry.status = "disconnected";
    });
}

async function reconnectStation(chargePointId: string): Promise<void> {
    const entry = stations.get(chargePointId);
    if (!entry) throw new Error(`Station ${chargePointId} not found`);
    if (entry.status === "connected") throw new Error(`Station ${chargePointId} is already connected`);

    const vcp = new VCP({
        endpoint: entry.endpoint,
        chargePointId,
        ocppVersion: OcppVersion.OCPP_1_6,
        basicAuthPassword: entry.password,
    });

    await vcp.connect();

    vcp.send(bootNotificationOcppMessage.request({
        chargePointVendor: "Solidstudio",
        chargePointModel: "VirtualChargePoint",
        chargePointSerialNumber: chargePointId,
        firmwareVersion: "1.0.0",
    }));

    vcp.send(statusNotificationOcppMessage.request({
        connectorId: 1,
        errorCode: "NoError",
        status: "Available",
    }));

    entry.vcp = vcp;
    entry.connectedAt = new Date().toISOString();
    entry.status = "connected";

    vcp.on("disconnected", () => {
        logger.info(`Station ${chargePointId} disconnected unexpectedly — marking as disconnected`);
        const e = stations.get(chargePointId);
        if (e) e.status = "disconnected";
    });
}

const adminApi = new Hono();

(async () => {
    await spawnStation(defaultCpId, defaultEndpoint, defaultPassword);
    console.log(`✅  Station ${defaultCpId} started. Admin UI → http://localhost:${adminPort}/ui`);
})();

adminApi.use("*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    if (c.req.method === "OPTIONS") return c.text("OK");
    await next();
});

adminApi.get("/health", (c) => c.text("OK"));

adminApi.get("/stations", (c) =>
    c.json([...stations.values()].map(({chargePointId, endpoint, connectedAt, status}) => ({
        chargePointId, endpoint, connectedAt, status,
    }))),
);

adminApi.post(
    "/stations",
    zValidator("json", z.object({
        chargePointId: z.string().min(1),
        endpoint: z.string().optional(),
        password: z.string().optional(),
    })),
    async (c) => {
        const {chargePointId, endpoint, password} = c.req.valid("json");
        try {
            await spawnStation(chargePointId, endpoint ?? defaultEndpoint, password ?? defaultPassword);
            return c.json({ok: true, chargePointId});
        } catch (err: any) {
            return c.json({ok: false, error: err.message}, 400);
        }
    },
);

adminApi.delete("/stations/:id", (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);
    try { entry.vcp.close(); } catch {}
    stations.delete(id);
    return c.json({ok: true});
});

adminApi.post("/stations/:id/reconnect", async (c) => {
    const id = c.req.param("id");
    try {
        await reconnectStation(id);
        return c.json({ok: true});
    } catch (err: any) {
        return c.json({ok: false, error: err.message}, 400);
    }
});

adminApi.post(
    "/stations/:id/execute",
    zValidator("json", z.object({action: z.string(), payload: z.any()})),
    (c) => {
        const id = c.req.param("id");
        const entry = stations.get(id);
        if (!entry) return c.json({ok: false, error: "Not found"}, 404);
        if (entry.status === "disconnected") return c.json({ok: false, error: "Station is disconnected"}, 400);
        const {action, payload} = c.req.valid("json");
        entry.vcp.send(call(action, payload));
        return c.json({ok: true});
    },
);

adminApi.get("/stations/:id/logs", async (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);
    const logs = await entry.vcp.getDiagnosticData();
    return c.json({logs});
});

adminApi.get("/stations/:id/logs/stream", async (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);

    return streamSSE(c, async (stream) => {
        const logs = await entry.vcp.getDiagnosticData();
        await stream.writeSSE({ data: JSON.stringify({ type: "snapshot", logs }) });

        await new Promise<void>((resolve) => {
            const onLog = async (info: object) => {
                try {
                    await stream.writeSSE({ data: JSON.stringify({ type: "log", entry: info }) });
                } catch { resolve(); }
            };
            entry.vcp.on("log", onLog);
            stream.onAbort(() => { entry.vcp.off("log", onLog); resolve(); });
        });
    });
});

adminApi.get("/stations/:id/traffic", (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);
    return c.json({ traffic: entry.vcp.getTrafficData() });
});

adminApi.get("/stations/:id/traffic/stream", async (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);

    return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: JSON.stringify({ type: "snapshot", traffic: entry.vcp.getTrafficData() }) });

        await new Promise<void>((resolve) => {
            const onTraffic = async (t: object) => {
                try {
                    await stream.writeSSE({ data: JSON.stringify({ type: "entry", entry: t }) });
                } catch { resolve(); }
            };
            entry.vcp.on("traffic", onTraffic);
            stream.onAbort(() => { entry.vcp.off("traffic", onTraffic); resolve(); });
        });
    });
});

adminApi.get("/stations/:id/state", (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);
    const connectors = Object.fromEntries(entry.vcp.connectorStatus);
    return c.json({
        chargePointId: entry.chargePointId,
        endpoint: entry.endpoint,
        connectedAt: entry.connectedAt,
        status: entry.status,
        connectors,
    });
});

// ── Meter config ──────────────────────────────────────────────────────────────
adminApi.get("/stations/:id/meter-config", (c) => {
    const id = c.req.param("id");
    const entry = stations.get(id);
    if (!entry) return c.json({ok: false, error: "Not found"}, 404);

    const transactions = entry.vcp.transactionManager.getActiveTransactions();
    return c.json({
        ok: true,
        transactions: transactions.map(t => ({
            transactionId: t.transactionId,
            connectorId:   t.connectorId,
            idTag:         t.idTag,
            meterValue:    t.meterValue,
            whPerMinute:   t.whPerMinute,
            intervalSec:   t.intervalSec,
            startedAt:     t.startedAt,
        })),
    });
});

adminApi.post(
    "/stations/:id/meter-config",
    zValidator("json", z.object({
        transactionId: z.union([z.string(), z.number()]),
        whPerMinute:   z.number().int().min(1).max(600_000).optional(),
        intervalSec:   z.number().int().min(5).max(3600).optional(),
    })),
    (c) => {
        const id = c.req.param("id");
        const entry = stations.get(id);
        if (!entry) return c.json({ok: false, error: "Not found"}, 404);

        const { transactionId, whPerMinute, intervalSec } = c.req.valid("json");
        const updated = entry.vcp.transactionManager.updateMeterConfig(
            transactionId,
            { whPerMinute, intervalSec },
        );

        if (!updated) return c.json({ok: false, error: "Transaction not found"}, 404);
        return c.json({ok: true});
    },
);

adminApi.get("/ui", (c) => {
    const html = fs.readFileSync(path.join(__dirname, "ui/station-manager.html"), "utf-8");
    return c.html(html);
});

const MIME: Record<string, string> = {
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".html": "text/html",
    ".json": "application/json",
};

adminApi.get("/ui/:file", (c) => {
    const file = c.req.param("file");
    const filePath = path.join(__dirname, "ui", file);
    if (!fs.existsSync(filePath)) return c.text("Not found", 404);
    const ext = path.extname(file);
    const mime = MIME[ext] ?? "application/octet-stream";
    const content = fs.readFileSync(filePath);
    return c.body(content, 200, { "Content-Type": mime });
});

serve({fetch: adminApi.fetch, port: adminPort});