import { z } from "zod";
import {
    type OcppCall,
    type OcppCallResult,
    OcppOutgoing,
} from "../../ocppMessage";
import type { VCP } from "../../vcp";
import type { TransactionState } from "../../transactionManager";
import { ConnectorIdSchema, IdTagInfoSchema, IdTokenSchema } from "./_common";
import { meterValuesOcppMessage } from "./meterValues";
import { statusNotificationOcppMessage } from "./statusNotification";
import { stopTransactionOcppMessage } from "./stopTransaction";

const StartTransactionReqSchema = z.object({
    connectorId: ConnectorIdSchema,
    idTag: IdTokenSchema,
    meterStart: z.number().int(),
    reservationId: z.number().int().nullish(),
    timestamp: z.string().datetime(),
});
type StartTransactionReqType = typeof StartTransactionReqSchema;

const StartTransactionResSchema = z.object({
    idTagInfo: IdTagInfoSchema,
    transactionId: z.number().int(),
});
type StartTransactionResType = typeof StartTransactionResSchema;

class StartTransactionOcppMessage extends OcppOutgoing<
    StartTransactionReqType,
    StartTransactionResType
> {
    resHandler = async (
        vcp: VCP,
        call: OcppCall<z.infer<StartTransactionReqType>>,
        result: OcppCallResult<z.infer<StartTransactionResType>>,
    ): Promise<void> => {
        vcp.transactionManager.startTransaction(vcp, {
            transactionId: result.payload.transactionId,
            idTag: call.payload.idTag,
            connectorId: call.payload.connectorId,
            meterValuesCallback: async (state: TransactionState) => {
                vcp.send(
                    meterValuesOcppMessage.request({
                        connectorId:   state.connectorId,
                        transactionId: Number(state.transactionId),
                        meterValue: [
                            {
                                timestamp: new Date().toISOString(),
                                sampledValue: [
                                    {
                                        value:     state.meterValue.toString(),
                                        measurand: "Energy.Active.Import.Register",
                                        unit:      "Wh",
                                        context:   "Sample.Periodic",
                                        format:    "Raw",
                                        location:  "Outlet",
                                    },
                                    {
                                        value:     Math.round(state.whPerMinute / 60 * 1000).toString(),
                                        measurand: "Power.Active.Import",
                                        unit:      "W",
                                        context:   "Sample.Periodic",
                                        format:    "Raw",
                                        location:  "Outlet",
                                    },
                                ],
                            },
                        ],
                    }),
                );
            },
        });

        if (result.payload.idTagInfo.status !== "Accepted") {
            vcp.send(
                stopTransactionOcppMessage.request({
                    transactionId: result.payload.transactionId,
                    meterStop: 0,
                    reason: "DeAuthorized",
                    timestamp: new Date().toISOString(),
                }),
            );
            vcp.send(
                statusNotificationOcppMessage.request({
                    connectorId: call.payload.connectorId,
                    errorCode: "NoError",
                    status: "Available",
                }),
            );
        }
    };
}

export const startTransactionOcppMessage = new StartTransactionOcppMessage(
    "StartTransaction",
    StartTransactionReqSchema,
    StartTransactionResSchema,
);