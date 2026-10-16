import {randomUUID} from "node:crypto";
import {chmodSync, mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";

export type JobStatus = "queued" | "calling" | "order_confirmed" | "confirmed" | "cancelled" | "address_change_required" | "no_answer" | "busy" | "dropped" | "failed" | "manual_review";
export type CallEventKind = "answered" | "order_1" | "order_2" | "address_1" | "address_2" | "no_answer" | "busy" | "hangup" | "failed" | "no_input" | "invalid_input";

export type TestJob = {
  id: string;
  reference: string;
  customerName: string;
  productSummary: string;
  address: string;
  phone: string;
  status: JobStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TestAttempt = {
  id: string;
  jobId: string;
  number: number;
  providerCallId: string | null;
  status: string;
  orderChoice: string | null;
  addressChoice: string | null;
  result: string | null;
  greetingText: string | null;
  addressText: string | null;
  audioManifest: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type CallEvent = {id: string; attemptId: string; providerCallId: string; kind: CallEventKind};

const MAX_ATTEMPTS = 3;

export function retryDelayMs(kind: "no_answer" | "busy" | "dropped" | "failed"): number {
  return {no_answer: 45, busy: 20, dropped: 15, failed: 30}[kind] * 60_000;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const cleaned = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max) throw new Error(`${name} must be 1-${max} characters`);
  return cleaned;
}

export function validateTestJob(input: Record<string, unknown>, allowedNumbers: Set<string>) {
  const reference = requiredText(input.reference, "reference", 64);
  const customerName = requiredText(input.customerName, "customerName", 120);
  const productSummary = requiredText(input.productSummary, "productSummary", 500);
  const address = requiredText(input.address, "address", 900);
  const phone = requiredText(input.phone, "phone", 20);
  if (!/^\+?[0-9]{10,15}$/.test(phone)) throw new Error("phone must be a valid test number");
  if (!allowedNumbers.has(phone)) throw new Error("phone is not in IVR_TEST_NUMBERS");
  return {reference, customerName, productSummary, address, phone};
}

export class IvrStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, customerName TEXT NOT NULL,
        productSummary TEXT NOT NULL, address TEXT NOT NULL, phone TEXT NOT NULL,
        status TEXT NOT NULL, attemptCount INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt TEXT, activeAttemptId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id), number INTEGER NOT NULL,
        providerCallId TEXT UNIQUE, status TEXT NOT NULL, orderChoice TEXT, addressChoice TEXT,
        result TEXT, greetingText TEXT, addressText TEXT, audioManifest TEXT,
        startedAt TEXT NOT NULL, completedAt TEXT,
        UNIQUE(jobId, number)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, attemptId TEXT NOT NULL REFERENCES attempts(id),
        kind TEXT NOT NULL, receivedAt TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createJob(input: ReturnType<typeof validateTestJob>, now = new Date()): TestJob {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE reference = ?").get(input.reference) as TestJob | undefined;
      if (existing) {
        if (["customerName", "productSummary", "address", "phone"].some((field) => existing[field as keyof TestJob] !== input[field as keyof typeof input])) {
          throw new Error("reference already belongs to a different test job");
        }
        return existing;
      }
      const id = randomUUID();
      const time = now.toISOString();
      this.db.prepare("INSERT INTO jobs (id, reference, customerName, productSummary, address, phone, status, attemptCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)")
        .run(id, input.reference, input.customerName, input.productSummary, input.address, input.phone, time, time);
      return this.getJob(id)!;
    });
  }

  getJob(id: string): TestJob | null {
    return (this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as TestJob | undefined) ?? null;
  }

  listJobs(limit = 50): TestJob[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY createdAt DESC, id DESC LIMIT ?").all(limit) as TestJob[];
  }

  attemptsFor(jobId: string): TestAttempt[] {
    return this.db.prepare("SELECT * FROM attempts WHERE jobId = ? ORDER BY number DESC").all(jobId) as TestAttempt[];
  }

  claimNext(now = new Date()): {job: TestJob; attempt: TestAttempt} | null {
    return this.transaction(() => {
      const job = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND attemptCount < ? AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?) ORDER BY createdAt, id LIMIT 1")
        .get(MAX_ATTEMPTS, now.toISOString()) as TestJob | undefined;
      if (!job) return null;
      const attemptId = randomUUID();
      const time = now.toISOString();
      this.db.prepare("INSERT INTO attempts (id, jobId, number, status, startedAt) VALUES (?, ?, ?, 'created', ?)")
        .run(attemptId, job.id, job.attemptCount + 1, time);
      this.db.prepare("UPDATE jobs SET status = 'calling', attemptCount = attemptCount + 1, activeAttemptId = ?, nextAttemptAt = NULL, updatedAt = ? WHERE id = ?")
        .run(attemptId, time, job.id);
      return {job: this.getJob(job.id)!, attempt: this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as TestAttempt};
    });
  }

  markOriginated(attemptId: string, providerCallId: string): void {
    this.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as TestAttempt | undefined;
      if (!attempt || attempt.status !== "created") throw new Error("attempt cannot be originated");
      this.db.prepare("UPDATE attempts SET providerCallId = ?, status = 'originated' WHERE id = ?").run(providerCallId, attemptId);
    });
  }

  prepareAttempt(attemptId: string, greetingText: string, addressText: string, manifest: string): void {
    this.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as TestAttempt | undefined;
      if (!attempt || attempt.status !== "created") throw new Error("attempt cannot be prepared");
      this.db.prepare("UPDATE attempts SET greetingText = ?, addressText = ?, audioManifest = ? WHERE id = ?")
        .run(greetingText, addressText, manifest, attemptId);
    });
  }

  failPreparation(attemptId: string, now = new Date()): void {
    this.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as TestAttempt | undefined;
      if (!attempt || attempt.status !== "created") throw new Error("attempt cannot fail preparation");
      const job = this.getJob(attempt.jobId)!;
      const time = now.toISOString();
      const retry = job.attemptCount < MAX_ATTEMPTS;
      this.db.prepare("UPDATE attempts SET status = 'completed', result = 'audio_failed', completedAt = ? WHERE id = ?").run(time, attemptId);
      this.db.prepare("UPDATE jobs SET status = ?, activeAttemptId = NULL, nextAttemptAt = ?, updatedAt = ? WHERE id = ?")
        .run(retry ? "queued" : "manual_review", retry ? new Date(now.getTime() + retryDelayMs("failed")).toISOString() : null, time, job.id);
    });
  }

  holdUnapprovedNumber(attemptId: string, now = new Date()): void {
    this.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as TestAttempt | undefined;
      if (!attempt || attempt.status !== "created") throw new Error("attempt cannot be held");
      const time = now.toISOString();
      this.db.prepare("UPDATE attempts SET status = 'completed', result = 'number_not_allowlisted', completedAt = ? WHERE id = ?").run(time, attemptId);
      this.db.prepare("UPDATE jobs SET status = 'manual_review', activeAttemptId = NULL, nextAttemptAt = NULL, updatedAt = ? WHERE id = ?")
        .run(time, attempt.jobId);
    });
  }

  markOriginationUncertain(attemptId: string, now = new Date()): void {
    this.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as TestAttempt | undefined;
      // Asterisk may deliver the final event while the originate action is still
      // awaiting its response. Preserve that durable result instead of replacing it.
      if (attempt?.completedAt) return;
      if (!attempt || attempt.status !== "originated") throw new Error("attempt cannot be marked uncertain");
      const time = now.toISOString();
      this.db.prepare("UPDATE attempts SET status = 'completed', result = 'origination_uncertain', completedAt = ? WHERE id = ?").run(time, attemptId);
      this.db.prepare("UPDATE jobs SET status = 'manual_review', activeAttemptId = NULL, nextAttemptAt = NULL, updatedAt = ? WHERE id = ?")
        .run(time, attempt.jobId);
    });
  }

  holdStaleCallsForReview(now = new Date(), maxAgeMs = 60 * 60_000): number {
    return this.transaction(() => {
      const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
      const stale = this.db.prepare("SELECT id, activeAttemptId FROM jobs WHERE status IN ('calling', 'order_confirmed') AND activeAttemptId IS NOT NULL AND updatedAt < ?")
        .all(cutoff) as Array<{id: string; activeAttemptId: string}>;
      const time = now.toISOString();
      for (const job of stale) {
        this.db.prepare("UPDATE attempts SET status = 'completed', result = 'event_timeout', completedAt = ? WHERE id = ? AND completedAt IS NULL")
          .run(time, job.activeAttemptId);
        this.db.prepare("UPDATE jobs SET status = 'manual_review', activeAttemptId = NULL, nextAttemptAt = NULL, updatedAt = ? WHERE id = ?")
          .run(time, job.id);
      }
      return stale.length;
    });
  }

  recordEvent(event: CallEvent, now = new Date()): {duplicate: boolean; job: TestJob} {
    return this.transaction(() => {
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(event.attemptId) as TestAttempt | undefined;
      if (!attempt || attempt.providerCallId !== event.providerCallId) throw new Error("unknown attempt or provider call ID");
      const job = this.getJob(attempt.jobId)!;
      if (this.db.prepare("SELECT id FROM events WHERE id = ?").get(event.id)) return {duplicate: true, job};
      if (attempt.completedAt) return {duplicate: true, job};
      if (job.activeAttemptId !== attempt.id) throw new Error("attempt is no longer active");
      const time = now.toISOString();
      this.db.prepare("INSERT INTO events (id, attemptId, kind, receivedAt) VALUES (?, ?, ?, ?)").run(event.id, attempt.id, event.kind, time);
      const finish = (status: JobStatus, result: string, retry?: "no_answer" | "busy" | "dropped" | "failed") => {
        const shouldRetry = Boolean(retry && job.attemptCount < MAX_ATTEMPTS);
        const finalStatus = retry ? (shouldRetry ? "queued" : "manual_review") : status;
        const nextAt = shouldRetry ? new Date(now.getTime() + retryDelayMs(retry!)).toISOString() : null;
        this.db.prepare("UPDATE attempts SET status = 'completed', result = ?, completedAt = ? WHERE id = ?").run(result, time, attempt.id);
        this.db.prepare("UPDATE jobs SET status = ?, activeAttemptId = NULL, nextAttemptAt = ?, updatedAt = ? WHERE id = ?")
          .run(finalStatus, nextAt, time, job.id);
      };
      if (event.kind === "answered") {
        this.db.prepare("UPDATE attempts SET status = 'answered' WHERE id = ?").run(attempt.id);
      } else if (event.kind === "order_1" && attempt.status === "answered" && !attempt.orderChoice) {
        this.db.prepare("UPDATE attempts SET orderChoice = '1' WHERE id = ?").run(attempt.id);
        this.db.prepare("UPDATE jobs SET status = 'order_confirmed', updatedAt = ? WHERE id = ?").run(time, job.id);
      } else if (event.kind === "order_2" && attempt.status === "answered" && !attempt.orderChoice) {
        this.db.prepare("UPDATE attempts SET orderChoice = '2' WHERE id = ?").run(attempt.id);
        finish("cancelled", "cancelled");
      } else if (event.kind === "address_1" && attempt.orderChoice === "1" && !attempt.addressChoice) {
        this.db.prepare("UPDATE attempts SET addressChoice = '1' WHERE id = ?").run(attempt.id);
        finish("confirmed", "order_and_address_confirmed");
      } else if (event.kind === "address_2" && attempt.orderChoice === "1" && !attempt.addressChoice) {
        this.db.prepare("UPDATE attempts SET addressChoice = '2' WHERE id = ?").run(attempt.id);
        finish("address_change_required", "address_change_required");
      } else if (event.kind === "hangup") {
        finish("dropped", "dropped", "dropped");
      } else if (event.kind === "no_answer" || event.kind === "busy" || event.kind === "failed") {
        finish(event.kind, event.kind, event.kind);
      } else if (event.kind === "no_input" || event.kind === "invalid_input") {
        finish("manual_review", event.kind);
      } else {
        throw new Error("event is out of order");
      }
      return {duplicate: false, job: this.getJob(job.id)!};
    });
  }
}
