import { z } from "zod";
import {
    type OcppCall,
    type OcppCallResult,
    OcppOutgoing,
} from "../../ocppMessage";
import type { VCP } from "../../vcp";
import { IdTagInfoSchema, IdTokenSchema, MeterValueSchema } from "./_common";
import {statusNotificationOcppMessage} from "./statusNotification";

const StopTransactionReqSchema = z.object({
    idTag: IdTokenSchema.nullish(),
    meterStop: z.number().int(),
    timestamp: z.string().datetime(),
    transactionId: z.number().int(),
    reason: z
        .enum([
            "DeAuthorized",
            "EmergencyStop",
            "EVDisconnected",
            "HardReset",
            "Local",
            "Other",
            "PowerLoss",
            "Reboot",
            "Remote",
            "SoftReset",
            "UnlockCommand",
        ])
        .nullish(),
    transactionData: z.array(MeterValueSchema).nullish(),
});
type StopTransactionReqType = typeof StopTransactionReqSchema;

const StopTransactionResSchema = z.object({
    idTagInfo: IdTagInfoSchema.nullish(),
});
type StopTransactionResType = typeof StopTransactionResSchema;

class StopTransactionOcppMessage extends OcppOutgoing<
    StopTransactionReqType,
    StopTransactionResType
> {
    resHandler = async (
        vcp: VCP,
        call: OcppCall<z.infer<StopTransactionReqType>>,
        _result: OcppCallResult<z.infer<StopTransactionResType>>,
    ): Promise<void> => {
        const transaction = vcp.transactionManager.transactions.get(call.payload.transactionId);
        vcp.transactionManager.stopTransaction(call.payload.transactionId);
        if (transaction) {
            vcp.send(
                statusNotificationOcppMessage.request({
                    connectorId: transaction.connectorId,
                    errorCode: "NoError",
                    status: "Finishing",
                }),
            );
            setTimeout(() => {
                vcp.send(
                    statusNotificationOcppMessage.request({
                        connectorId: transaction.connectorId,
                        errorCode: "NoError",
                        status: "Available",
                    }),
                );
            }, 2000);
        }
    };
}

export const stopTransactionOcppMessage = new StopTransactionOcppMessage(
    "StopTransaction",
    StopTransactionReqSchema,
    StopTransactionResSchema,
);