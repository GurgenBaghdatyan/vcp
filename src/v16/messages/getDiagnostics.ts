import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { diagnosticsStatusNotificationOcppMessage } from "./diagnosticsStatusNotification";
import { Client as FtpClient } from "basic-ftp";
import { URL } from "node:url";
import { Readable } from "node:stream";

const GetDiagnosticsReqSchema = z.object({
  location: z.string().url(),
  retries: z.number().int().nullish(),
  retryInterval: z.number().int().nullish(),
  startTime: z.string().datetime().nullish(),
  stopTime: z.string().datetime().nullish(),
});
type GetDiagnosticsReqType = typeof GetDiagnosticsReqSchema;

const GetDiagnosticsResSchema = z.object({
  fileName: z.string().max(255).nullish(),
});
type GetDiagnosticsResType = typeof GetDiagnosticsResSchema;

class GetDiagnosticsOcppMessage extends OcppIncoming<
  GetDiagnosticsReqType,
  GetDiagnosticsResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<GetDiagnosticsReqType>>,
  ): Promise<void> => {
    const fileName = `diagnostics_${new Date().toISOString()}.log`;

    asyncUploadDiagnostics(vcp, call, fileName);

    vcp.respond(
      this.response(call, {
        fileName: fileName,
      }),
    );
  };
}

const asyncUploadDiagnostics = async (
  vcp: VCP,
  call: OcppCall<z.infer<GetDiagnosticsReqType>>,
  fileName: string,
) => {
  vcp.send(
    diagnosticsStatusNotificationOcppMessage.request({
      status: "Uploading",
    }),
  );

  const diagnosticData = await vcp.getDiagnosticData();

  try {
    let diagnosticContent: string;
    try {
      diagnosticContent = JSON.stringify(diagnosticData, null, 2);
    } catch (e) {
      diagnosticContent = String(diagnosticData);
    }

    const ftpUrl = new URL(call.payload.location);
    const ftpClient = new FtpClient();
    ftpClient.ftp.verbose = true;

    await ftpClient.access({
      host: ftpUrl.hostname,
      port: ftpUrl.port ? Number.parseInt(ftpUrl.port, 10) : 21,
      user: ftpUrl.username || "anonymous",
      password: ftpUrl.password || "guest",
      secure: false,
    });

    const pathParts = ftpUrl.pathname.split("/").filter(Boolean);
    const remoteFileName = fileName;

    if (pathParts.length > 0) {
      for (const part of pathParts) {
        try {
          await ftpClient.cd(part);
        } catch (e) {
          await ftpClient.send(`MKD ${part}`);
          await ftpClient.cd(part);
        }
      }
    }

    const buffer = Buffer.from(diagnosticContent, "utf8");
    const contentStream = Readable.from(buffer);

    await ftpClient.uploadFrom(contentStream, remoteFileName);

    await ftpClient.close();

    await new Promise((resolve) => setTimeout(resolve, 10000));
    vcp.send(
      diagnosticsStatusNotificationOcppMessage.request({
        status: "Uploaded",
      }),
    );
  } catch (err) {
    console.error("Error uploading diagnostic file via FTP:", err);
    vcp.send(
      diagnosticsStatusNotificationOcppMessage.request({
        status: "UploadFailed",
      }),
    );
    throw err;
  }
};

export const getDiagnosticsOcppMessage = new GetDiagnosticsOcppMessage(
  "GetDiagnostics",
  GetDiagnosticsReqSchema,
  GetDiagnosticsResSchema,
);
