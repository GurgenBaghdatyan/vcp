import type { VCP } from "./vcp";

type TransactionId = string | number;

export interface TransactionState {
  startedAt: Date;
  idTag: string;
  transactionId: TransactionId;
  /** Accumulated energy in Wh */
  meterValue: number;
  evseId?: number;
  connectorId: number;
  /** Wh added per minute — changeable at runtime */
  whPerMinute: number;
  /** MeterValues send interval in seconds — changeable at runtime */
  intervalSec: number;
}

interface StartTransactionProps {
  transactionId: TransactionId;
  idTag: string;
  evseId?: number;
  connectorId: number;
  meterValuesCallback: (transactionState: TransactionState) => Promise<void>;
}

const DEFAULT_WH_PER_MINUTE = 600;
const DEFAULT_INTERVAL_SEC  = 15;

type InternalEntry = TransactionState & {
  meterValuesTimer: ReturnType<typeof setInterval>;
  meterValuesCallback: (s: TransactionState) => Promise<void>;
};

export class TransactionManager {
  private _entries: Map<TransactionId, InternalEntry> = new Map();

  /** Public read-only view used by external code */
  get transactions(): Map<TransactionId, TransactionState & { meterValuesTimer: ReturnType<typeof setInterval> }> {
    return this._entries as any;
  }

  canStartNewTransaction(connectorId: number): boolean {
    return !Array.from(this._entries.values()).some(
        (t) => t.connectorId === connectorId,
    );
  }

  startTransaction(_vcp: VCP, props: StartTransactionProps): void {
    const intervalSec = DEFAULT_INTERVAL_SEC;
    const whPerMinute = DEFAULT_WH_PER_MINUTE;

    const state: TransactionState = {
      transactionId: props.transactionId,
      idTag:         props.idTag,
      meterValue:    0,
      startedAt:     new Date(),
      evseId:        props.evseId,
      connectorId:   props.connectorId,
      whPerMinute,
      intervalSec,
    };

    const timer = this._makeTimer(props.transactionId, props.meterValuesCallback);

    this._entries.set(props.transactionId, {
      ...state,
      meterValuesTimer:    timer,
      meterValuesCallback: props.meterValuesCallback,
    });

    props.meterValuesCallback({ ...state });
  }

  /**
   * Change whPerMinute and/or intervalSec on an active transaction.
   * Restarts the timer so the new interval takes effect on the next tick.
   * Returns false if the transaction doesn't exist.
   */
  updateMeterConfig(
      transactionId: TransactionId,
      patch: { whPerMinute?: number; intervalSec?: number },
  ): boolean {
    const entry = this._entries.get(transactionId);
    if (!entry) return false;

    clearInterval(entry.meterValuesTimer);

    if (patch.whPerMinute !== undefined) entry.whPerMinute = patch.whPerMinute;
    if (patch.intervalSec !== undefined) entry.intervalSec  = patch.intervalSec;

    entry.meterValuesTimer = this._makeTimer(transactionId, entry.meterValuesCallback);
    return true;
  }

  stopTransaction(transactionId: TransactionId): void {
    const entry = this._entries.get(transactionId);
    if (entry) {
      clearInterval(entry.meterValuesTimer);
      this._entries.delete(transactionId);
    }
  }

  getMeterValue(transactionId: TransactionId): number {
    return this._entries.get(transactionId)?.meterValue ?? 0;
  }

  /** Plain snapshot of all active transactions (no internal fields). */
  getActiveTransactions(): TransactionState[] {
    return Array.from(this._entries.values()).map(
        ({ meterValuesTimer: _t, meterValuesCallback: _c, ...rest }) => rest,
    );
  }


  private _makeTimer(
      transactionId: TransactionId,
      callback: (s: TransactionState) => Promise<void>,
  ): ReturnType<typeof setInterval> {
    const getEntry = () => this._entries.get(transactionId);

    const fire = () => {
      const entry = getEntry();
      if (!entry) return;

      const whPerTick = (entry.whPerMinute / 60) * entry.intervalSec;
      entry.meterValue = Math.round(entry.meterValue + whPerTick);

      const { meterValuesTimer: _t, meterValuesCallback: _c, ...snapshot } = entry;
      callback({ ...snapshot });
    };

    const entry = getEntry();
    return setInterval(fire, (entry?.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000);
  }
}