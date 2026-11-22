import { OPENAI_UPLOAD_EXPIRY_SECONDS, type Attachment } from "./attachments";
import { MAX_GENERATED_BYTES } from "./generated-files";
import type { DiagnosticFile, DiagnosticStage } from "./diagnostics";
import { diagnoseTransport, observeHttp } from "./diagnostic-network";

type FileRequest = {url:string;method:string;headers:Record<string,string>;contentType?:string;body?:ArrayBuffer;throw:false};
export type FileHttp = (request: FileRequest) => Promise<{status:number;text:string;arrayBuffer:ArrayBuffer;headers?: Readonly<Record<string, string>>}>;
export type FileDownload = (url: string, key: string, maximum: number, current: () => boolean, diagnostics?: DiagnosticFile) => Promise<ArrayBuffer>;
type DownloadRuntime = Pick<typeof window, "fetch" | "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval">;
const ROOT="https://api.openai.com/v1";
function check(status:number, action:string):void {if(status<200||status>=300)throw Error(`${action} failed (${status}). Check your OpenAI key, model access and usage allowance. No retry was made.`);}
async function multipart(file:Attachment,data:ArrayBuffer,fields:Record<string,string>) {
  const form=new FormData();for(const [name,value]of Object.entries(fields))form.append(name,value);form.append("file",new Blob([data],{type:file.mime}),file.name);
  const encoded=new Response(form);return {contentType:encoded.headers.get("content-type")!,body:await encoded.arrayBuffer()};
}
function verifyFileReply<T>(diagnostics: DiagnosticFile | undefined, stage: DiagnosticStage, httpStatus: number | undefined, verify: () => T): T {
  try { return verify(); }
  catch (error) {
    diagnostics?.run.event(stage, "unconfirmed", { reference: diagnostics.reference, httpStatus, reason: "response_invalid" });
    throw error;
  }
}

/** requestUrl buffers complete bodies. This isolated streaming path enforces a byte cap when provider metadata has no size. */
export async function boundedOpenAiDownload(url: string, key: string, maximum: number, current: () => boolean, runtime: DownloadRuntime = window, diagnostics?: DiagnosticFile): Promise<ArrayBuffer> {
  if (!/^https:\/\/api\.openai\.com\/v1\/containers\/cntr_[A-Za-z0-9_-]{1,150}\/files\/cfile_[A-Za-z0-9_-]{1,150}\/content$/.test(url) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_GENERATED_BYTES) throw Error("Invalid bounded file download.");
  if (!current()) throw Error("Stopped before retrieving the generated file.");
  const controller = new AbortController(), deadline = runtime.setTimeout(() => controller.abort(), 60000), stop = runtime.setInterval(() => { if (!current()) controller.abort(); }, 150);
  let receivedStatus: number | undefined;
  try {
    const { response, status } = await observeHttp(diagnostics?.run, "download", { reference: diagnostics?.reference, transport: "fetch" }, async () => {
      const response = await runtime.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: controller.signal });
      return { response, status: response.status, headers: { "x-request-id": response.headers.get("x-request-id") ?? "" } };
    });
    check(status, "Generated-file download");
    receivedStatus = status;
    const declared = response.headers.get("content-length"); if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) throw Error("The generated file exceeds the download size budget.");
    if (!response.body) throw Error("Bounded file streaming is unavailable.");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      if (!current()) throw Error("Stopped while retrieving the generated file.");
      const item = await reader.read(); if (item.done) break; total += item.value.byteLength;
      if (total > maximum) { await reader.cancel(); throw Error("The generated file exceeds the download size budget."); }
      chunks.push(item.value);
    }
    if (!current()) throw Error("Stopped before preserving the generated file.");
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    diagnostics?.run.event("download", "received", { dataBytes: total, reference: diagnostics.reference, transport: "fetch" });
    return bytes.buffer;
  } catch (error) {
    if (receivedStatus !== undefined) {
      const diagnosis = diagnoseTransport(error);
      diagnostics?.run.event("download", "unconfirmed", { ...diagnosis, transport: "fetch", httpStatus: receivedStatus,
        reference: diagnostics.reference, evidence: "http_response", reason: diagnosis.reason === "unknown" ? "response_invalid" : diagnosis.reason });
    }
    throw error;
  } finally { runtime.clearTimeout(deadline); runtime.clearInterval(stop); controller.abort(); }
}
export function providerFiles(request:FileHttp, stream?: FileDownload) {
  const observed = (stage: DiagnosticStage, input: FileRequest, diagnostics?: DiagnosticFile, accepted?: (status: number) => boolean) =>
    observeHttp(diagnostics?.run, stage, { requestBytes: input.body?.byteLength, reference: diagnostics?.reference, transport: "obsidian_http" },
      () => request(input), accepted);
  return {
    async upload(this: void, file:Attachment,data:ArrayBuffer,key:string,current:()=>boolean, diagnostics?: DiagnosticFile):Promise<string> {
      const payload=await multipart(file,data,{purpose:file.kind==="image"?"vision":"user_data","expires_after[anchor]":"created_at","expires_after[seconds]":String(OPENAI_UPLOAD_EXPIRY_SECONDS)});
      if(!current())throw Error("Stopped before uploading attachments.");
      const response=await observed("upload", {url:ROOT+"/files",method:"POST",headers:{Authorization:`Bearer ${key}`},...payload,throw:false}, diagnostics);check(response.status,"File upload");
      const id = verifyFileReply(diagnostics, "upload", response.status, () => {
        const result = JSON.parse(response.text) as { id?: unknown } | null;
        if (typeof result?.id !== "string" || !/^file-[A-Za-z0-9_-]{1,150}$/.test(result.id))
          throw Error("OpenAI returned an invalid file reference.");
        return result.id;
      });
      diagnostics?.run.event("upload", "ok", { reference: diagnostics.reference });
      return id;
    },
    async transcribe(this: void, file:Attachment,data:ArrayBuffer,key:string,current:()=>boolean, diagnostics?: DiagnosticFile):Promise<string> {
      const payload=await multipart(file,data,{model:"gpt-transcribe"});if(!current())throw Error("Stopped before audio transcription.");
      const response=await observed("transcription", {url:ROOT+"/audio/transcriptions",method:"POST",headers:{Authorization:`Bearer ${key}`},...payload,throw:false}, diagnostics);check(response.status,"Audio transcription");
      const text = verifyFileReply(diagnostics, "transcription", response.status, () => {
        const result = JSON.parse(response.text) as { text?: unknown } | null;
        if (typeof result?.text !== "string" || new TextEncoder().encode(result.text).length > 512 * 1024)
          throw Error("The transcript is unavailable or too large. The recording is kept locally.");
        return result.text;
      });
      diagnostics?.run.event("transcription", "ok", { reference: diagnostics.reference });
      return text;
    },
    async removeUpload(this: void, id:string,key:string, diagnostics?: DiagnosticFile):Promise<void> {
      if(!/^file-[A-Za-z0-9_-]{1,150}$/.test(id))throw Error("Invalid uploaded-file reference.");
      const response=await observed("delete_upload", {url:ROOT+"/files/"+id,method:"DELETE",headers:{Authorization:`Bearer ${key}`},throw:false}, diagnostics,
        status => status === 404 || status >= 200 && status < 300);
      if (response.status !== 404) {
        if (response.status < 200 || response.status >= 300)
          throw Object.assign(Error("Uploaded-file cleanup failed."), { status: response.status });
        verifyFileReply(diagnostics, "delete_upload", response.status, () => {
          let deleted: { id?: unknown; object?: unknown; deleted?: unknown } | null = null;
          try { deleted = JSON.parse(response.text) as { id?: unknown; object?: unknown; deleted?: unknown } | null; }
          catch { /* Keep the unconfirmed outcome. */ }
          if (deleted?.id !== id || deleted.object !== "file" || deleted.deleted !== true)
            throw Object.assign(Error("Uploaded-file deletion was not confirmed."), { status: response.status });
        });
      }
      diagnostics?.run.event("delete_upload", "ok", { reference: diagnostics.reference, remoteConfirmed: true });
    },
    async download(this: void, container:string,file:string,key:string,current:()=>boolean,byteBudget = MAX_GENERATED_BYTES, diagnostics?: DiagnosticFile):Promise<ArrayBuffer> {
      if(!/^cntr_[A-Za-z0-9_-]{1,150}$/.test(container)||!/^cfile_[A-Za-z0-9_-]{1,150}$/.test(file))throw Error("Invalid generated-file reference.");
      const url=ROOT+`/containers/${container}/files/${file}`;if(!current())throw Error("Stopped before retrieving generated files.");
      const metadata=await observed("download", {url,method:"GET",headers:{Authorization:`Bearer ${key}`},throw:false}, diagnostics);check(metadata.status,"Generated-file metadata");
      const maximum = Math.min(MAX_GENERATED_BYTES, byteBudget);
      const bytes = verifyFileReply(diagnostics, "download", metadata.status, () => {
        const object = JSON.parse(metadata.text) as { id?: unknown; container_id?: unknown; object?: unknown; bytes?: unknown } | null;
        if (object?.id !== file || object.container_id !== container || object.object !== "container.file")
          throw Error("Generated-file metadata does not match the returned reference.");
        const size = object.bytes;
        if (size != null && (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > maximum))
          throw Error("The generated download exceeds this step's size budget or has no verified size.");
        if (size == null && !stream)
          throw Error("The provider has not reported a size and bounded streaming is unavailable. No unbounded download was made.");
        return size ?? undefined;
      });
      if (!current()) throw Error("Stopped before retrieving generated files.");
      let data: ArrayBuffer, status: number | undefined;
      if (stream) data = await stream(url + "/content", key, maximum, current, diagnostics);
      else {
        const result = await observed("download", { url: url + "/content", method: "GET", headers: { Authorization: `Bearer ${key}` }, throw: false }, diagnostics);
        check(result.status, "Generated-file download");
        data = result.arrayBuffer;
        status = result.status;
      }
      verifyFileReply(diagnostics, "download", status, () => {
        if (data.byteLength > maximum || bytes !== undefined && data.byteLength !== bytes)
          throw Error("The generated file size could not be confirmed.");
      });
      diagnostics?.run.event("download", "ok", { reference: diagnostics.reference, dataBytes: data.byteLength });
      return data;
    },
  };
}
