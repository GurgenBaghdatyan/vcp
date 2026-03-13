import {EventEmitter} from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import {WebSocket} from "ws";

import {serve} from "@hono/node-server";
import {zValidator} from "@hono/zod-validator";
import {Hono} from "hono";
import {z} from "zod";
import {logger} from "./logger";
import {call} from "./messageFactory";
import type {OcppCall, OcppCallError, OcppCallResult} from "./ocppMessage";
import {type OcppMessageHandler, resolveMessageHandler} from "./ocppMessageHandler";
import {ocppOutbox} from "./ocppOutbox";
import {type OcppVersion, toProtocolVersion} from "./ocppVersion";
import {
    validateOcppIncomingRequest,
    validateOcppIncomingResponse,
    validateOcppOutgoingRequest,
    validateOcppOutgoingResponse,
} from "./schemaValidator";
import {TransactionManager} from "./transactionManager";
import {heartbeatOcppMessage} from "./v16/messages/heartbeat";

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


export class VCP extends EventEmitter {
    private ws?: WebSocket;
    private readonly messageHandler: OcppMessageHandler;
    private readonly logBuffer: LogEntry[] = [];
    private isFinishing = false;

    transactionManager = new TransactionManager();

    /** connectorId → last reported status */
    connectorStatus: Map<number, string> = new Map();

    constructor(private readonly vcpOptions: VCPOptions) {
        super();
        this.messageHandler = resolveMessageHandler(vcpOptions.ocppVersion);
        this.attachLogListener();
        if (vcpOptions.adminPort) {
            this.startAdminServer(vcpOptions.adminPort);
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
            this.ws.on("ping", () => logger.info("Received PING"));
            this.ws.on("pong", () => logger.info("Received PONG"));
            this.ws.on("close", (code: number, reason: string) => this._onClose(code, reason));
        });
    }

    send(ocppCall: OcppCall<any>) {
        if (!this.ws) throw new Error("Websocket not initialized. Call connect() first");

        ocppOutbox.enqueue(ocppCall);
        const jsonMessage = JSON.stringify([2, ocppCall.messageId, ocppCall.action, ocppCall.payload]);
        logger.info(`Sending message ➡️  ${jsonMessage}`);
        validateOcppOutgoingRequest(this.vcpOptions.ocppVersion, ocppCall.action, JSON.parse(JSON.stringify(ocppCall.payload)));
        this.ws.send(jsonMessage);
    }

    respond(result: OcppCallResult<any>) {
        if (!this.ws) throw new Error("Websocket not initialized. Call connect() first");

        const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);
        logger.info(`Responding with ➡️  ${jsonMessage}`);
        validateOcppIncomingResponse(this.vcpOptions.ocppVersion, result.action, JSON.parse(JSON.stringify(result.payload)));
        this.ws.send(jsonMessage);
    }

    respondError(error: OcppCallError<any>) {
        if (!this.ws) throw new Error("Websocket not initialized. Call connect() first");

        const jsonMessage = JSON.stringify([4, error.messageId, error.errorCode, error.errorDescription, error.errorDetails]);
        logger.info(`Responding with ➡️  ${jsonMessage}`);
        this.ws.send(jsonMessage);
    }

    configureHeartbeat(interval: number) {
        setInterval(() => this.send(heartbeatOcppMessage.request({})), interval);
    }

    close() {
        if (!this.ws) throw new Error("Trying to close a Websocket that was not opened. Call connect() first");
        this.isFinishing = true;
        this.ws.close();
        this.ws = undefined;
    }

    async getDiagnosticData(): Promise<LogEntry[]> {
        return this.logBuffer;
    }

    private attachLogListener() {
        const transport = logger.transports[0];
        transport.on("logged", (info: {
            timestamp?: string;
            level: string;
            message: string;
            [key: string]: unknown
        }) => {
            const {timestamp, level, message, ...rest} = info;
            this.logBuffer.push({
                type: "Application",
                timestamp: timestamp ?? new Date().toISOString(),
                level,
                message,
                metadata: rest,
            });
            if (this.logBuffer.length > 300) this.logBuffer.shift();
        });
    }

    private startAdminServer(port: number) {
        const adminApi = new Hono();

        adminApi.use("*", async (c, next) => {
            c.header("Access-Control-Allow-Origin", "*");
            c.header("Access-Control-Allow-Headers", "Content-Type");
            c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            if (c.req.method === "OPTIONS") return c.text("OK");
            await next();
        });

        adminApi.get("/health", (c) => c.text("OK"));
        adminApi.get("/logs", (c) => c.json({logs: this.logBuffer}));
        adminApi.get("/state", (c) => c.json({
            chargePointId: this.vcpOptions.chargePointId,
            endpoint: this.vcpOptions.endpoint,
            ocppVersion: this.vcpOptions.ocppVersion,
            connected: Boolean(this.ws),
            readyState: this.ws?.readyState ?? null,
        }));
        adminApi.post(
            "/execute",
            zValidator("json", z.object({action: z.string(), payload: z.any()})),
            (c) => {
                const {action, payload} = c.req.valid("json");
                this.send(call(action, payload));
                return c.text("OK");
            },
        );
        adminApi.get("/ui", (c) => {
            const html = fs.readFileSync(path.join(__dirname, "ui/vcp-admin.html"), "utf-8");
            return c.html(html);
        });

        serve({fetch: adminApi.fetch, port});
    }

    private _onMessage(message: string) {
        logger.info(`Receive message ⬅️  ${message}`);
        const [type, ...rest] = JSON.parse(message);

        if (type === 2) {
            const [messageId, action, payload] = rest;
            validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);
            this.emit(`_incoming:${action}`, payload);
            this.messageHandler.handleCall(this, {messageId, action, payload});
        } else if (type === 3) {
            const [messageId, payload] = rest;
            const enqueuedCall = ocppOutbox.get(messageId);
            if (!enqueuedCall) throw new Error(`Received CallResult for unknown messageId=${messageId}`);
            validateOcppOutgoingResponse(this.vcpOptions.ocppVersion, enqueuedCall.action, payload);
            this.emit(`_response:${enqueuedCall.action}`, payload);
            this.emit("_lastPayload", payload);
            this.messageHandler.handleCallResult(this, enqueuedCall, {messageId, payload, action: enqueuedCall.action});
        } else if (type === 4) {
            const [messageId, errorCode, errorDescription, errorDetails] = rest;
            this.messageHandler.handleCallError(this, {messageId, errorCode, errorDescription, errorDetails});
        } else {
            throw new Error(`Unrecognized message type ${type}`);
        }
    }

    private _onClose(code: number, reason: string) {
        if (this.isFinishing) return;
        logger.info(`Connection closed. code=${code}, reason=${String(reason)}`);
        this.emit("disconnected", { code, reason: String(reason) });
    }
}