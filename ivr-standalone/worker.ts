import {buildCallAudioManifest} from "../app/lib/calling-audio.server.ts";
import {renderDynamicAudio, type AudioConfig} from "./audio.ts";
import {IvrStore, type TestJob} from "./store.ts";

export type OriginateRequest = {
  callId: string;
  attemptId: string;
  destination: string;
  greetingText: string;
  addressText: string;
  audioFiles?: {greeting: string; address: string};
};

export interface CallProvider {
  originate(request: OriginateRequest): Promise<void>;
}

/** Records a call intent only. The simulator never contacts a phone network. */
export class SimulatedProvider implements CallProvider {
  readonly calls: OriginateRequest[] = [];

  async originate(request: OriginateRequest): Promise<void> {
    this.calls.push(request);
  }
}

export function isWithinPakistanCallingHours(now: Date, startHour = 10, endHour = 20): boolean {
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || startHour >= endHour) {
    throw new Error("invalid Pakistan calling hours");
  }
  const hour = Number(new Intl.DateTimeFormat("en-GB", {timeZone: "Asia/Karachi", hour: "2-digit", hourCycle: "h23"}).format(now));
  return hour >= startHour && hour < endHour;
}

function audioFor(job: TestJob) {
  return buildCallAudioManifest({
    id: job.id,
    shopifyOrderNumber: job.reference,
    customerName: job.customerName,
    productSummary: job.productSummary,
    normalizedAddress: job.address,
  });
}

export async function processNextTestCall(store: IvrStore, provider: CallProvider, now = new Date(), audioConfig?: AudioConfig, allowedNumbers?: Set<string>) {
  if (!isWithinPakistanCallingHours(now)) return null;
  const claimed = store.claimNext(now);
  if (!claimed) return null;
  const {job, attempt} = claimed;
  if (allowedNumbers && !allowedNumbers.has(job.phone)) {
    store.holdUnapprovedNumber(attempt.id, now);
    return {job: store.getJob(job.id)!, attemptId: attempt.id, manifest: null};
  }
  const manifest = audioFor(job);
  const greetingText = manifest.dynamicSegments[0].text;
  const addressText = manifest.dynamicSegments[1].text;
  store.prepareAttempt(attempt.id, greetingText, addressText, JSON.stringify(manifest));
  let audioFiles: {greeting: string; address: string} | undefined;
  if (audioConfig) {
    try {
      audioFiles = await renderDynamicAudio(manifest, audioConfig);
    } catch {
      store.failPreparation(attempt.id, now);
      return {job: store.getJob(job.id)!, attemptId: attempt.id, manifest};
    }
  }
  // The attempt ID is the idempotency key for the eventual PBX originate call.
  store.markOriginated(attempt.id, attempt.id);
  try {
    await provider.originate({
      callId: attempt.id,
      attemptId: attempt.id,
      destination: job.phone,
      greetingText,
      addressText,
      audioFiles,
    });
  } catch {
    // A timed-out originate can have reached the PBX. Never redial blindly.
    store.markOriginationUncertain(attempt.id, now);
  }
  return {job: store.getJob(job.id)!, attemptId: attempt.id, manifest};
}
