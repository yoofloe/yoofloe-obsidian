import type { ActivityState } from "./work-activity";

export interface ResponseWire {
  on(event: string, handler: (data?: unknown) => void): void;
  send(message: string, callback: (error?: Error) => void): void;
  close(): void;
}

export type LiveSteerEvent = "accepted" | "applied" | "deferred";
export interface LiveResponseHooks {
  ready(): void;
  steer(event: LiveSteerEvent): void;
  activity(text: string, state: ActivityState): void;
  summary(text: string): void;
}
export interface LiveResponseResult {
  response: string | null;
  superseded: string | null;
}
export interface LiveResponseRound {
  request(body: string, hooks: LiveResponseHooks): Promise<LiveResponseResult>;
  steer(text: string): boolean;
  close(): void;
}
export type OpenLiveResponse = (key: string) => Promise<LiveResponseRound | null>;

const toolEvents: Record<string, [string, ActivityState]> = {
  "response.web_search_call.searching": ["Searching the web", "working"],
  "response.web_search_call.completed": ["Web search finished", "done"],
  "response.code_interpreter_call.interpreting": ["Analyzing data", "working"],
  "response.code_interpreter_call.completed": ["Analysis finished", "done"],
  "response.image_generation_call.generating": ["Generating an image", "working"],
  "response.image_generation_call.completed": ["Image generation finished", "done"],
};
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One explicit response and, at most, one server-started steering continuation. */
export class ResponsesSocketRound implements LiveResponseRound {
  private finish: ((value: LiveResponseResult) => void) | null = null;
  private hooks: LiveResponseHooks | null = null;
  private firstId: string | null = null;
  private successorId: string | null = null;
  private original: string | null = null;
  private steering = false;
  private deferred = false;
  private closed = false;
  private timer: number | undefined;

  constructor(private readonly wire: ResponseWire, private readonly timers: Pick<Window, "setTimeout" | "clearTimeout">) {
    wire.on("message", data => this.receive(data));
    wire.on("error", () => this.close());
    wire.on("close", () => this.close());
  }

  request(body: string, hooks: LiveResponseHooks): Promise<LiveResponseResult> {
    if (this.closed || this.finish || this.hooks) return Promise.resolve({ response: null, superseded: null });
    return new Promise(resolve => {
      this.hooks = hooks;
      this.finish = resolve;
      this.armTimeout();
      try {
        const fields = JSON.parse(body) as Record<string, unknown>;
        delete fields.stream;
        this.send({ ...fields, type: "response.create" });
      } catch { this.close(); }
    });
  }

  steer(text: string): boolean {
    if (this.closed || !this.finish || !this.firstId || this.original || this.steering) return false;
    this.steering = true;
    this.send({ type: "response.steer", previous_response_id: this.firstId, input: text });
    return true;
  }

  private send(value: unknown): void {
    try { this.wire.send(JSON.stringify(value), error => { if (error) this.close(); }); }
    catch { this.close(); }
  }

  private armTimeout(): void {
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.close(), 10 * 60 * 1000);
  }

  private receive(data: unknown): void {
    if (this.closed || !this.finish || !this.hooks) return;
    try {
      const event = object(JSON.parse(String(data)) as unknown);
      if (!event || typeof event.type !== "string") { this.close(); return; }
      this.armTimeout();
      const response = object(event.response), id = response?.id;
      const steer = object(event.steer);
      if (event.type === "response.created") {
        if (typeof id !== "string" || !id || id.length > 200) { this.close(); return; }
        if (!this.firstId) {
          this.firstId = id;
          this.hooks.ready();
        } else if (this.steering && this.original && !this.successorId && id !== this.firstId && !this.deferred) {
          this.successorId = id;
          this.hooks.steer("applied");
        } else this.close();
      } else if (event.type === "response.steer.accepted" && this.steering && steer?.previous_response_id === this.firstId) {
        this.hooks.steer("accepted");
      } else if ((event.type === "response.steer.failed" || event.type === "response.steer.pending" && event.reason === "waiting_for_required_input") &&
        this.steering && !this.successorId && steer?.previous_response_id === this.firstId) {
        // The server has not started a successor. Its pending input is scoped to this socket.
        this.deferred = true;
        this.hooks.steer("deferred");
        if (this.original) this.settle(this.original, null);
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        if (!response || (id !== this.firstId && id !== this.successorId)) { this.close(); return; }
        const json = JSON.stringify(response);
        if (id === this.successorId) this.settle(json, this.original);
        else if (!this.steering || this.deferred) this.settle(json, null);
        else this.original = json;
      } else if (event.type === "error" || event.type === "response.failed" || event.type === "response.cancelled") {
        this.close();
      } else if (event.type === "response.output_item.added" && object(event.item)?.type === "compaction") {
        this.hooks.activity("Compacting conversation context", "working");
      } else if (event.type === "response.reasoning_summary_text.done" && typeof event.text === "string") {
        this.hooks.summary(event.text);
      } else if (Object.hasOwn(toolEvents, event.type)) {
        this.hooks.activity(...toolEvents[event.type]);
      }
    } catch { this.close(); }
  }

  private settle(response: string | null, superseded: string | null): void {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearTimeout(this.timer);
    const finish = this.finish;
    this.finish = null;
    this.hooks = null;
    try { this.wire.close(); } catch { /* A disconnected socket is already unusable. */ }
    finish?.({ response, superseded });
  }

  close(): void { this.settle(null, this.original); }
}
