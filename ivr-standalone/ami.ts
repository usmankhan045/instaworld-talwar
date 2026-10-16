import {randomUUID} from "node:crypto";
import {connect, type Socket} from "node:net";

import type {CallProvider, OriginateRequest} from "./worker.ts";
import {IvrStore, type CallEventKind} from "./store.ts";

type AmiFrame = Record<string, string>;

function wireAction(fields: Array<[string, string]>): string {
  for (const [, value] of fields) {
    if (/[\r\n]/.test(value)) throw new Error("AMI values cannot contain line breaks");
  }
  return `${fields.map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`;
}

function parseFrame(raw: string): AmiFrame {
  const fields: AmiFrame = {};
  for (const line of raw.split("\r\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 2);
  }
  return fields;
}

/** AMI is plaintext; this client permits loopback only (or a local SSH tunnel). */
export class AmiClient {
  private socket: Socket | null = null;
  private buffer = "";
  private pending = new Map<string, {resolve: (frame: AmiFrame) => void; reject: (error: Error) => void}>();
  private onEvent: (frame: AmiFrame) => void;
  private config: {host: string; port: number; username: string; secret: string};

  constructor(config: {host: string; port: number; username: string; secret: string}, onEvent: (frame: AmiFrame) => void) {
    if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) throw new Error("AMI must use loopback or a local tunnel");
    this.config = config;
    this.onEvent = onEvent;
  }

  async open(): Promise<void> {
    if (this.socket) return;
    const socket = connect(this.config.port, this.config.host);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => { /* close rejects pending actions */ });
    socket.on("close", () => {
      this.socket = null;
      for (const pending of this.pending.values()) pending.reject(new Error("AMI disconnected"));
      this.pending.clear();
    });
    await new Promise<void>((resolveOpen, reject) => {
      socket.once("connect", resolveOpen);
      socket.once("error", reject);
    });
    const response = await this.action([["Action", "Login"], ["Username", this.config.username], ["Secret", this.config.secret], ["Events", "on"]]);
    if (response.Response !== "Success") throw new Error("AMI login failed");
  }

  close(): void { this.socket?.end(); }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) { this.socket?.destroy(new Error("AMI frame too large")); return; }
    let boundary = this.buffer.indexOf("\r\n\r\n");
    while (boundary >= 0) {
      const frame = parseFrame(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 4);
      if (frame.Event) this.onEvent(frame);
      else if (frame.ActionID && this.pending.has(frame.ActionID)) {
        this.pending.get(frame.ActionID)!.resolve(frame);
        this.pending.delete(frame.ActionID);
      }
      boundary = this.buffer.indexOf("\r\n\r\n");
    }
  }

  async action(fields: Array<[string, string]>, actionId: string = randomUUID()): Promise<AmiFrame> {
    if (!this.socket) throw new Error("AMI is not connected");
    const id = actionId;
    return new Promise((resolveAction, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("AMI action timed out"));
      }, 10_000);
      this.pending.set(id, {
        resolve: (frame) => { clearTimeout(timer); resolveAction(frame); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket!.write(wireAction([...fields, ["ActionID", id]]));
    });
  }
}

export class AsteriskTestProvider implements CallProvider {
  private ami: AmiClient;
  private config: {trunk: string; callerId: string; allowedNumbers: Set<string>};

  constructor(ami: AmiClient, config: {trunk: string; callerId: string; allowedNumbers: Set<string>}) {
    if (!/^[A-Za-z0-9_-]+$/.test(config.trunk)) throw new Error("invalid test trunk name");
    if (!/^\+?[0-9]{10,15}$/.test(config.callerId)) throw new Error("caller ID must be a verified number");
    this.ami = ami;
    this.config = config;
  }

  async originate(request: OriginateRequest): Promise<void> {
    if (!this.config.allowedNumbers.has(request.destination)) throw new Error("destination is not an approved test number");
    if (!request.audioFiles) throw new Error("rendered audio is required for Asterisk");
    const sound = (path: string) => {
      if (!/^\/[A-Za-z0-9/_-]+\.wav$/.test(path)) throw new Error("invalid Asterisk sound path");
      return path.slice(0, -4);
    };
    const response = await this.ami.action([
      ["Action", "Originate"],
      ["Channel", `PJSIP/${request.destination}@${this.config.trunk}`],
      ["Context", "talwar-ivr-test"], ["Exten", "s"], ["Priority", "1"],
      ["Timeout", "30000"], ["Async", "true"],
      ["CallerID", this.config.callerId], ["ChannelId", request.callId],
      ["Variable", `IVR_ATTEMPT_ID=${request.attemptId}`],
      ["Variable", `IVR_GREETING=${sound(request.audioFiles.greeting)}`],
      ["Variable", `IVR_ADDRESS=${sound(request.audioFiles.address)}`],
    ], request.callId);
    if (response.Response !== "Success") throw new Error(`AMI originate rejected: ${response.Message || "unknown error"}`);
  }
}

const validAmiKinds = new Set<CallEventKind>(["answered", "order_1", "order_2", "address_1", "address_2", "hangup", "no_input", "invalid_input"]);

export function handleAmiEvent(store: IvrStore, frame: AmiFrame): void {
  if (frame.Event === "UserEvent" && frame.UserEvent === "TalwarIvr" && frame.AttemptId && validAmiKinds.has(frame.Kind as CallEventKind)) {
    store.recordEvent({
      id: `ami:${frame.AttemptId}:${frame.Kind}`,
      attemptId: frame.AttemptId,
      providerCallId: frame.AttemptId,
      kind: frame.Kind as CallEventKind,
    });
  }
  if (frame.Event === "OriginateResponse" && frame.Response === "Failure" && frame.ActionID) {
    store.recordEvent({id: `ami:${frame.ActionID}:failed`, attemptId: frame.ActionID, providerCallId: frame.ActionID, kind: "no_answer"});
  }
}
