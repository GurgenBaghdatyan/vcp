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
    connectedAt: string;
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

    stations.set(chargePointId, {vcp, chargePointId, endpoint, connectedAt: new Date().toISOString()});

    vcp.on("disconnected", () => {
        logger.info(`Station ${chargePointId} disconnected unexpectedly — removing from registry`);
        stations.delete(chargePointId);
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
    c.json([...stations.values()].map(({chargePointId, endpoint, connectedAt}) => ({
        chargePointId, endpoint, connectedAt,
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
    try {
        entry.vcp.close();
    } catch {
    }
    stations.delete(id);
    return c.json({ok: true});
});

adminApi.post(
    "/stations/:id/execute",
    zValidator("json", z.object({action: z.string(), payload: z.any()})),
    (c) => {
        const id = c.req.param("id");
        const entry = stations.get(id);
        if (!entry) return c.json({ok: false, error: "Not found"}, 404);
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
        // send current snapshot first
        const logs = await entry.vcp.getDiagnosticData();
        await stream.writeSSE({ data: JSON.stringify({ type: "snapshot", logs }) });

        // then stream new entries
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
        // send existing snapshot first
        await stream.writeSSE({ data: JSON.stringify({ type: "snapshot", traffic: entry.vcp.getTrafficData() }) });

        // then stream new entries live
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
        connectors,
    });
});

adminApi.get("/ui", (c) => {
    const html = fs.readFileSync(path.join(__dirname, "ui/station-manager.html"), "utf-8");
    return c.html(html);
});

serve({fetch: adminApi.fetch, port: adminPort});