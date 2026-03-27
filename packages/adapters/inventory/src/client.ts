import { jsonifyError, Logger } from '@mark/logger';
import { axiosGet, axiosPost } from '@mark/core';
import axios from 'axios';
import {
  Reservation,
  CreateReservationParams,
  ReservationStatus,
  NonceAssignment,
  InventoryBalance,
  PendingInbound,
  RegisterInboundParams,
} from './types';

/**
 * HTTP client for the unified inventory service (connext-api).
 *
 * The inventory API is served from the same base URL as the everclear API.
 * Uses the same axios helpers (axiosGet/axiosPost) as EverclearAdapter for
 * connection pooling, retries, and consistent error handling.
 *
 * All methods are non-throwing: failures are logged and return undefined/void,
 * so Mark degrades gracefully when the inventory service is unavailable.
 */
export class InventoryServiceClient {
  private readonly apiUrl: string;
  private readonly logger: Logger;

  constructor(apiUrl: string, logger: Logger) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.logger = logger;
  }

  /**
   * Logs API errors with full context, matching EverclearAdapter.logApiError pattern.
   */
  private logApiError(message: string, url: string, params: unknown, err: unknown): void {
    const errorContext = (err as { context?: Record<string, unknown> }).context;
    this.logger.warn(message, {
      url,
      errorMessage: (err as Error).message,
      apiResponseStatus: errorContext?.status,
      apiResponseBody: errorContext?.data,
      requestParams: params,
      error: jsonifyError(err),
    });
  }

  // ── Reservation Management ──────────────────────────────────────────

  /**
   * Create a reservation for an operation (rebalance, purchase, etc.).
   * POST /inventory/reserve
   */
  async createReservation(params: CreateReservationParams): Promise<Reservation | undefined> {
    const url = `${this.apiUrl}/inventory/reserve`;
    try {
      const { data } = await axiosPost<Reservation>(url, params, undefined, 1, 0);
      return data;
    } catch (err) {
      this.logApiError('Failed to create reservation (non-blocking)', url, params, err);
      return undefined;
    }
  }

  /**
   * Update the status of an existing reservation.
   * PUT /inventory/reserve/{reservationId}/status
   */
  async updateReservationStatus(
    reservationId: string,
    status: ReservationStatus,
    metadata?: Record<string, string>,
  ): Promise<Reservation | undefined> {
    const url = `${this.apiUrl}/inventory/reserve/${reservationId}/status`;
    const body = { status, metadata };
    try {
      const { data } = await axios.put<Reservation>(url, body);
      return data;
    } catch (err) {
      this.logApiError('Failed to update reservation status (non-blocking)', url, body, err);
      return undefined;
    }
  }

  /**
   * Delete (release) a reservation.
   * DELETE /inventory/reserve/{reservationId}
   */
  async deleteReservation(reservationId: string): Promise<boolean> {
    const url = `${this.apiUrl}/inventory/reserve/${reservationId}`;
    try {
      const { data } = await axios.delete<{ success: boolean }>(url);
      return data?.success ?? false;
    } catch (err) {
      this.logApiError('Failed to delete reservation (non-blocking)', url, { reservationId }, err);
      return false;
    }
  }

  /**
   * Get full inventory balance for a (chain, asset) pair.
   * GET /inventory/balance/{chainId}/{asset}
   *
   * Returns on-chain balance, available balance, reserved amounts by type,
   * pending inbound, and pending intents.
   */
  async getInventoryBalance(chainId: string, asset: string): Promise<InventoryBalance | undefined> {
    const url = `${this.apiUrl}/inventory/balance/${chainId}/${encodeURIComponent(asset)}`;
    try {
      const { data } = await axiosGet<InventoryBalance>(url, undefined, 1, 0);
      return data;
    } catch (err) {
      this.logApiError('Failed to get inventory balance (non-blocking)', url, { chainId, asset }, err);
      return undefined;
    }
  }

  /**
   * Get all reservations for an operation.
   * GET /inventory/operations/{operationId}
   */
  async getReservationsByOperation(operationId: string): Promise<Reservation[]> {
    const url = `${this.apiUrl}/inventory/operations/${encodeURIComponent(operationId)}`;
    try {
      const { data } = await axiosGet<{ reservations: Reservation[] }>(url, undefined, 1, 0);
      return data?.reservations ?? [];
    } catch (err) {
      this.logApiError('Failed to get reservations by operation (non-blocking)', url, { operationId }, err);
      return [];
    }
  }

  // ── Nonce Management ────────────────────────────────────────────────

  /**
   * Assign the next sequential nonce for a (chainId, wallet) pair.
   * POST /inventory/nonce/assign
   */
  async assignNonce(chainId: string, wallet: string, operationId?: string): Promise<NonceAssignment | undefined> {
    const url = `${this.apiUrl}/inventory/nonce/assign`;
    const body = { chainId, wallet, operationId };
    try {
      const { data } = await axiosPost<NonceAssignment>(url, body, undefined, 1, 0);
      return data;
    } catch (err) {
      this.logApiError('Failed to assign nonce from inventory service (non-blocking)', url, body, err);
      return undefined;
    }
  }

  /**
   * Confirm that a previously assigned nonce was successfully included on-chain.
   * POST /inventory/nonce/confirm
   */
  async confirmNonce(chainId: string, wallet: string, nonce: number, txHash?: string): Promise<void> {
    const url = `${this.apiUrl}/inventory/nonce/confirm`;
    const body = { chainId, wallet, nonce, txHash };
    try {
      await axiosPost(url, body, undefined, 1, 0);
    } catch (err) {
      this.logApiError('Failed to confirm nonce (non-blocking)', url, body, err);
    }
  }

  /**
   * Report that a previously assigned nonce failed (transaction not mined / reverted).
   * POST /inventory/nonce/fail
   */
  async failNonce(chainId: string, wallet: string, nonce: number): Promise<void> {
    const url = `${this.apiUrl}/inventory/nonce/fail`;
    const body = { chainId, wallet, nonce };
    try {
      await axiosPost(url, body, undefined, 1, 0);
    } catch (err) {
      this.logApiError('Failed to report nonce failure (non-blocking)', url, body, err);
    }
  }

  // ── Pending Inbound Tracking ────────────────────────────────────────

  /**
   * Register expected inbound funds from a cross-chain rebalance.
   * POST /inventory/inbound
   */
  async registerInbound(params: RegisterInboundParams): Promise<PendingInbound | undefined> {
    const url = `${this.apiUrl}/inventory/inbound`;
    try {
      const { data } = await axiosPost<PendingInbound>(url, params, undefined, 1, 0);
      return data;
    } catch (err) {
      this.logApiError('Failed to register pending inbound (non-blocking)', url, params, err);
      return undefined;
    }
  }

  /**
   * Confirm that pending inbound funds have arrived.
   * POST /inventory/inbound/{inboundId}/confirm
   */
  async confirmInbound(inboundId: string, txHash?: string): Promise<PendingInbound | undefined> {
    const url = `${this.apiUrl}/inventory/inbound/${inboundId}/confirm`;
    const body = { txHash };
    try {
      const { data } = await axiosPost<PendingInbound>(url, body, undefined, 1, 0);
      return data;
    } catch (err) {
      this.logApiError('Failed to confirm inbound (non-blocking)', url, body, err);
      return undefined;
    }
  }

  /**
   * Cancel a pending inbound that won't arrive.
   * POST /inventory/inbound/{inboundId}/cancel
   */
  async cancelInbound(inboundId: string, reason?: string): Promise<PendingInbound | undefined> {
    const url = `${this.apiUrl}/inventory/inbound/${inboundId}/cancel`;
    const body = { reason };
    try {
      const { data } = await axiosPost<PendingInbound>(url, body, undefined, 1, 0);
      return data;
    } catch (err) {
      this.logApiError('Failed to cancel inbound (non-blocking)', url, body, err);
      return undefined;
    }
  }

  // ── Transaction Result Reporting (convenience wrappers) ─────────────

  /**
   * Report a successful transaction result for a reservation.
   */
  async reportTransactionSuccess(
    reservationId: string,
    txHash: string,
    chainId: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.updateReservationStatus(reservationId, 'COMPLETED', {
      txHash,
      chainId,
      ...metadata,
    });
  }

  /**
   * Report a failed transaction result for a reservation.
   */
  async reportTransactionFailure(
    reservationId: string,
    reason: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.updateReservationStatus(reservationId, 'FAILED', {
      failureReason: reason,
      ...metadata,
    });
  }
}
