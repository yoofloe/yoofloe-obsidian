import { diagnoseLocal, type DiagnosticDetail, type DiagnosticRun } from "./diagnostics";

export type BeginCompanionDiagnostics = (action: string) => DiagnosticRun | undefined;

/** Known transfer errors are reduced to a code. Paths, reply text and secrets stay in the app. */
export function replyFailure(run: DiagnosticRun | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message.slice(0, 160) : "";
  const reason = /\bexpired\b/i.test(message) ? "expired" :
    /^No (?:Calendar|ChronoHUD|verified|reply)|\bno reply yet\b/i.test(message) ? "no_verified_reply" :
    /(?:could not be verified|invalid|too large|does not match)/i.test(message) ? "invalid_reply" : diagnoseLocal(error);
  const stage = reason === "invalid_reply" || reason === "expired" ? "reply_verify" : "reply_read";
  run?.event(stage, reason === "no_verified_reply" ? "unconfirmed" : "failed", { reason });
  run?.finish(reason === "expired" ? "failed" : "waiting", reason === "expired" ? "review" : "check_result");
}
export function waitForReply(run: DiagnosticRun | undefined): void {
  run?.event("transfer_write", "ok", { transport: "app_handoff" });
  run?.event("approval", "waiting", { transport: "app_handoff" });
  run?.finish("waiting", "check_result");
}
export function verifiedReply(run: DiagnosticRun | undefined, detail: DiagnosticDetail): void {
  run?.event("reply_verify", "ok", { ...detail, evidence: "verified_reply" });
  run?.event("result_receive", "ok", detail);
}
