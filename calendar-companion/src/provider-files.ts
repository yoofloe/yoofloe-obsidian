import type { Attachment } from "./attachments";
import { MAX_GENERATED_BYTES } from "./generated-files";

export type FileHttp = (request:{url:string;method:string;headers:Record<string,string>;contentType?:string;body?:ArrayBuffer;throw:false}) => Promise<{status:number;text:string;arrayBuffer:ArrayBuffer}>;
export type FileDownload = (url: string, key: string, maximum: number, current: () => boolean) => Promise<ArrayBuffer>;
type DownloadRuntime = Pick<typeof window, "fetch" | "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval">;
const ROOT="https://api.openai.com/v1";
function check(status:number, action:string):void {if(status<200||status>=300)throw Error(`${action} failed (${status}). Check your OpenAI key, model access and usage allowance. No retry was made.`);}
async function multipart(file:Attachment,data:ArrayBuffer,fields:Record<string,string>) {
  const form=new FormData();for(const [name,value]of Object.entries(fields))form.append(name,value);form.append("file",new Blob([data],{type:file.mime}),file.name);
  const encoded=new Response(form);return {contentType:encoded.headers.get("content-type")!,body:await encoded.arrayBuffer()};
}
/** requestUrl buffers complete bodies. This isolated streaming path enforces a byte cap when provider metadata has no size. */
export async function boundedOpenAiDownload(url: string, key: string, maximum: number, current: () => boolean, runtime: DownloadRuntime = window): Promise<ArrayBuffer> {
  if (!/^https:\/\/api\.openai\.com\/v1\/containers\/cntr_[A-Za-z0-9_-]{1,150}\/files\/cfile_[A-Za-z0-9_-]{1,150}\/content$/.test(url) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_GENERATED_BYTES) throw Error("Invalid bounded file download.");
  if (!current()) throw Error("Stopped before retrieving the generated file.");
  const controller = new AbortController(), deadline = runtime.setTimeout(() => controller.abort(), 60000), stop = runtime.setInterval(() => { if (!current()) controller.abort(); }, 150);
  try {
    const response = await runtime.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: controller.signal }); check(response.status, "Generated-file download");
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
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes.buffer;
  } finally { runtime.clearTimeout(deadline); runtime.clearInterval(stop); controller.abort(); }
}
export function providerFiles(request:FileHttp, stream?: FileDownload) {
  return {
    async upload(this: void, file:Attachment,data:ArrayBuffer,key:string,current:()=>boolean):Promise<string> {
      const payload=await multipart(file,data,{purpose:file.kind==="image"?"vision":"user_data","expires_after[anchor]":"created_at","expires_after[seconds]":"3600"});
      if(!current())throw Error("Stopped before uploading attachments.");
      const response=await request({url:ROOT+"/files",method:"POST",headers:{Authorization:`Bearer ${key}`},...payload,throw:false});check(response.status,"File upload");
      const result:unknown=JSON.parse(response.text);if(!result||typeof result!=="object"||typeof(result as Record<string,unknown>).id!=="string"||!/^file-[A-Za-z0-9_-]{1,150}$/.test(String((result as Record<string,unknown>).id)))throw Error("OpenAI returned an invalid file reference.");
      return String((result as Record<string,unknown>).id);
    },
    async transcribe(this: void, file:Attachment,data:ArrayBuffer,key:string,current:()=>boolean):Promise<string> {
      const payload=await multipart(file,data,{model:"gpt-transcribe"});if(!current())throw Error("Stopped before audio transcription.");
      const response=await request({url:ROOT+"/audio/transcriptions",method:"POST",headers:{Authorization:`Bearer ${key}`},...payload,throw:false});check(response.status,"Audio transcription");
      const result:unknown=JSON.parse(response.text), text=result&&typeof result==="object"?(result as Record<string,unknown>).text:undefined;
      if(typeof text!=="string"||new TextEncoder().encode(text).length>512*1024)throw Error("The transcript is unavailable or too large. The recording is kept locally.");
      return text;
    },
    async removeUpload(this: void, id:string,key:string):Promise<void> {
      if(!/^file-[A-Za-z0-9_-]{1,150}$/.test(id))throw Error("Invalid uploaded-file reference.");
      const response=await request({url:ROOT+"/files/"+id,method:"DELETE",headers:{Authorization:`Bearer ${key}`},throw:false});if(response.status!==404)check(response.status,"Uploaded-file cleanup");
    },
    async download(this: void, container:string,file:string,key:string,current:()=>boolean,byteBudget = MAX_GENERATED_BYTES):Promise<ArrayBuffer> {
      if(!/^cntr_[A-Za-z0-9_-]{1,150}$/.test(container)||!/^cfile_[A-Za-z0-9_-]{1,150}$/.test(file))throw Error("Invalid generated-file reference.");
      const url=ROOT+`/containers/${container}/files/${file}`;if(!current())throw Error("Stopped before retrieving generated files.");
      const metadata=await request({url,method:"GET",headers:{Authorization:`Bearer ${key}`},throw:false});check(metadata.status,"Generated-file metadata");
      const value:unknown=JSON.parse(metadata.text), object=value&&typeof value==="object"?value as Record<string,unknown>:null, bytes=object?.bytes, maximum=Math.min(MAX_GENERATED_BYTES,byteBudget);
      if (object?.id !== file || object.container_id !== container || object.object !== "container.file") throw Error("Generated-file metadata does not match the returned reference.");
      if(bytes!==null&&bytes!==undefined&&(typeof bytes!=="number"||!Number.isSafeInteger(bytes)||bytes<=0||bytes>maximum))throw Error("The generated download exceeds this step's size budget or has no verified size.");
      if(!current())throw Error("Stopped before retrieving generated files.");
      if (stream) { const data = await stream(url+"/content",key,maximum,current); if (data.byteLength > maximum || typeof bytes === "number" && data.byteLength !== bytes) throw Error("The generated file size could not be confirmed."); return data; }
      if (typeof bytes !== "number") throw Error("The provider has not reported a size and bounded streaming is unavailable. No unbounded download was made.");
      const result=await request({url:url+"/content",method:"GET",headers:{Authorization:`Bearer ${key}`},throw:false});check(result.status,"Generated-file download");
      if(result.arrayBuffer.byteLength!==bytes)throw Error("The generated file size could not be confirmed.");return result.arrayBuffer;
    },
  };
}
