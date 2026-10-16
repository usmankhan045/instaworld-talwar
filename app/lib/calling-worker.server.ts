import type {CallAttempt, CallJob} from "@prisma/client";

import {buildCallAudioManifest, type CallAudioManifest} from "./calling-audio.server.ts";

export const CALL_JOB_LEASE_MS = 5 * 60 * 1000;

type QueuedCallJob = Pick<
  CallJob,
  | "id"
  | "shop"
  | "shopifyOrderId"
  | "shopifyOrderNumber"
  | "customerName"
  | "phone"
  | "productSummary"
  | "normalizedAddress"
  | "attemptCount"
>;

export type DryRunCallPlan = {
  mode: "dry-run";
  callJobId: string;
  callAttemptId: string;
  shop: string;
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  destination: string;
  audioManifest: CallAudioManifest;
  willPlaceCall: false;
  willBookShipment: false;
};

/** Shopify order jobs are intentionally dormant until explicit integration. */
export async function claimNextCallJob(): Promise<{
  job: QueuedCallJob;
  attempt: CallAttempt;
  leaseToken: string;
} | null> {
  return null;
}

/** Historical app DB rows are never recycled by the standalone worker. */
export async function releaseExpiredCallJobLeases(): Promise<number> {
  return 0;
}

/**
 * Build the exact variable/fixed audio sequence that a future Asterisk
 * adapter will play. This is a dry-run plan only: it never places a call or
 * changes booking state.
 */
export function buildDryRunCallPlan(
  job: QueuedCallJob,
  attempt: Pick<CallAttempt, "id">,
): DryRunCallPlan {
  return {
    mode: "dry-run",
    callJobId: job.id,
    callAttemptId: attempt.id,
    shop: job.shop,
    shopifyOrderId: job.shopifyOrderId,
    shopifyOrderNumber: job.shopifyOrderNumber,
    destination: job.phone,
    audioManifest: buildCallAudioManifest(job),
    willPlaceCall: false,
    willBookShipment: false,
  };
}
