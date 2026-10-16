import {randomUUID} from "node:crypto";

import type {CallAttempt, CallJob} from "@prisma/client";

import prisma from "../db.server.ts";
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

function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + CALL_JOB_LEASE_MS);
}

/**
 * Atomically claim the oldest eligible queued job and create its attempt.
 * No external call is made by this function.
 */
export async function claimNextCallJob(now = new Date()): Promise<{
  job: QueuedCallJob;
  attempt: CallAttempt;
  leaseToken: string;
} | null> {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.callJob.findFirst({
      where: {
        callStatus: "queued",
        OR: [{nextAttemptAt: null}, {nextAttemptAt: {lte: now}}],
      },
      orderBy: [{createdAt: "asc"}, {id: "asc"}],
    });

    if (!candidate) return null;

    const leaseToken = randomUUID();
    const leaseExpiresAt = leaseExpiry(now);
    const claimed = await tx.callJob.updateMany({
      where: {
        id: candidate.id,
        callStatus: "queued",
        OR: [{nextAttemptAt: null}, {nextAttemptAt: {lte: now}}],
      },
      data: {
        callStatus: "preparing_audio",
        attemptCount: {increment: 1},
        activeLeaseToken: leaseToken,
        leaseExpiresAt,
      },
    });

    if (claimed.count !== 1) return null;

    const attempt = await tx.callAttempt.create({
      data: {
        callJobId: candidate.id,
        attemptNumber: candidate.attemptCount + 1,
        status: "created",
      },
    });

    const job = await tx.callJob.update({
      where: {id: candidate.id},
      data: {lastCallAttemptId: attempt.id},
    });

    return {job, attempt, leaseToken};
  });
}

/** Return expired preparation leases to the queue without making a call. */
export async function releaseExpiredCallJobLeases(now = new Date()): Promise<number> {
  const result = await prisma.callJob.updateMany({
    where: {
      callStatus: "preparing_audio",
      leaseExpiresAt: {lt: now},
    },
    data: {
      callStatus: "queued",
      activeLeaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: now,
    },
  });

  return result.count;
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
