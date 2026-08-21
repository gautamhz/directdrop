/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface UploadedPart {
  partNumber: number;
  etag: string;
}

interface VideoObject {
  size: number;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface VideoObjectBody extends VideoObject {
  body: ReadableStream;
}

interface MultipartVideoUpload {
  uploadId: string;
  uploadPart(partNumber: number, body: ReadableStream | Uint8Array): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<VideoObject>;
  abort(): Promise<void>;
}

interface VideoBucket {
  createMultipartUpload(
    key: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<MultipartVideoUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartVideoUpload;
  head(key: string): Promise<VideoObject | null>;
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<VideoObjectBody | null>;
  delete(key: string): Promise<void>;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  VIDEOS: VideoBucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = MAX_UPLOAD_BYTES / PART_SIZE;
const MAX_UPLOAD_ID_LENGTH = 2048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const PUBLIC_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, ETag",
  "X-Content-Type-Options": "nosniff",
};

function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...PUBLIC_HEADERS,
      ...extraHeaders,
    },
  });
}

function sanitizeFilename(filename: string) {
  const leaf = filename.split(/[\\/]/).pop() ?? "video";
  const sanitized = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180);
  return sanitized || "video";
}

function filenameHeader(filename: string, disposition: "attachment" | "inline") {
  const fallback = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function objectKey(id: string) {
  return `videos/${id}`;
}

function safeDecode(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  try {
    return decodeURIComponent(value);
  } catch {
    return fallback;
  }
}

function parseRange(value: string, size: number) {
  if (!value.startsWith("bytes=") || value.includes(",")) return null;
  const [startText, endText] = value.slice(6).split("-", 2);
  if (startText === "" && endText === "") return null;

  let start: number;
  let end: number;
  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === "" ? size - 1 : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null;
    if (start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

async function readUploadEnvelope(stream: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const separator = bytes.indexOf(10);
  if (separator < 1 || separator > MAX_UPLOAD_ID_LENGTH) throw new Error("Missing upload envelope.");
  const uploadId = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, separator));
  const body = bytes.subarray(separator + 1);
  if (body.byteLength < 1) throw new Error("The upload chunk is empty.");
  return { uploadId, body };
}

async function startMultipartUpload(request: Request, env: Env) {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > 16 * 1024) return json({ error: "Upload metadata is too large." }, 413);

  const input = await request.json() as Record<string, unknown>;
  const originalName = typeof input.fileName === "string" ? input.fileName : "";
  const fileSize = Number(input.fileSize);
  const suppliedType = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
  const duration = Number(input.duration);
  const extension = originalName.split(".").pop()?.toLowerCase() ?? "";
  const expectedType = VIDEO_TYPES[extension];

  if (!expectedType || (suppliedType && suppliedType !== expectedType)) {
    return json({ error: "Only MP4, MOV, and WebM video files are allowed." }, 415);
  }
  if (!Number.isInteger(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD_BYTES) {
    return json({ error: "Videos must be larger than 0 bytes and no more than 1 GB." }, 413);
  }
  if (!Number.isFinite(duration) || duration < 0 || duration > 31_536_000) {
    return json({ error: "The video duration is invalid." }, 400);
  }

  const id = crypto.randomUUID();
  const fileName = sanitizeFilename(originalName);
  const upload = await env.VIDEOS.createMultipartUpload(objectKey(id), {
    httpMetadata: { contentType: expectedType },
    customMetadata: {
      id,
      filename: encodeURIComponent(fileName),
      declaredSize: String(fileSize),
      duration: String(duration),
      createdAt: new Date().toISOString(),
    },
  });

  return json({ id, uploadId: upload.uploadId, partSize: PART_SIZE }, 201);
}

async function uploadMultipartPart(request: Request, env: Env, id: string, partText: string, pathUploadId?: string) {
  const partNumber = Number(partText);
  let uploadId = pathUploadId ?? request.headers.get("X-Upload-ID") ?? new URL(request.url).searchParams.get("uploadId") ?? "";
  const contentLength = Number(request.headers.get("Content-Length") ?? -1);
  if (!UUID_PATTERN.test(id) || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    return json({ error: "Invalid upload part." }, 400);
  }
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > PART_SIZE + MAX_UPLOAD_ID_LENGTH + 1) {
    return json({ error: "Upload chunks must be between 1 byte and 16 MB." }, 413);
  }
  if (!request.body) return json({ error: "The upload chunk is empty." }, 400);

  let partBody: ReadableStream<Uint8Array> | Uint8Array = request.body;
  if (!uploadId) {
    try {
      const envelope = await readUploadEnvelope(partBody);
      uploadId = envelope.uploadId;
      partBody = envelope.body;
    } catch {
      return json({ error: "Missing upload ID." }, 400);
    }
  }
  if (!uploadId || uploadId.length > MAX_UPLOAD_ID_LENGTH) return json({ error: "Missing upload ID." }, 400);

  const multipart = env.VIDEOS.resumeMultipartUpload(objectKey(id), uploadId);
  const uploaded = await multipart.uploadPart(partNumber, partBody);
  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

async function completeMultipartUpload(request: Request, env: Env, id: string) {
  if (!UUID_PATTERN.test(id)) return json({ error: "Invalid video ID." }, 400);
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > 64 * 1024) return json({ error: "Completion data is too large." }, 413);

  const input = await request.json() as { uploadId?: unknown; parts?: unknown };
  if (typeof input.uploadId !== "string" || input.uploadId.length > MAX_UPLOAD_ID_LENGTH || !Array.isArray(input.parts)) {
    return json({ error: "Invalid completion data." }, 400);
  }
  const parts = input.parts.map((part) => {
    const candidate = part as { partNumber?: unknown; etag?: unknown };
    return { partNumber: Number(candidate.partNumber), etag: candidate.etag };
  });
  if (
    parts.length < 1 ||
    parts.length > MAX_PARTS ||
    parts.some((part) => !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > MAX_PARTS || typeof part.etag !== "string" || part.etag.length > 256)
  ) {
    return json({ error: "Invalid uploaded parts." }, 400);
  }

  const completed = await env.VIDEOS
    .resumeMultipartUpload(objectKey(id), input.uploadId)
    .complete(parts as UploadedPart[]);
  if (completed.size > MAX_UPLOAD_BYTES) {
    await env.VIDEOS.delete(objectKey(id));
    return json({ error: "The completed video exceeds the 1 GB limit." }, 413);
  }

  const url = new URL(request.url);
  const fileName = safeDecode(completed.customMetadata?.filename, "video");
  return json({
    id,
    fileName,
    fileSize: completed.size,
    directUrl: `${url.origin}/api/download/${id}`,
    watchUrl: `${url.origin}/watch/${id}`,
  });
}

async function abortMultipartUpload(request: Request, env: Env, id: string, pathUploadId?: string) {
  let uploadId = pathUploadId ?? request.headers.get("X-Upload-ID") ?? new URL(request.url).searchParams.get("uploadId") ?? "";
  if (!uploadId && request.method === "POST") {
    const input = await request.json() as { uploadId?: unknown };
    if (typeof input.uploadId === "string") uploadId = input.uploadId;
  }
  if (!UUID_PATTERN.test(id) || !uploadId || uploadId.length > MAX_UPLOAD_ID_LENGTH) {
    return json({ error: "Invalid upload." }, 400);
  }
  await env.VIDEOS.resumeMultipartUpload(objectKey(id), uploadId).abort();
  return new Response(null, { status: 204, headers: PUBLIC_HEADERS });
}

async function serveVideo(request: Request, env: Env, id: string, inline: boolean) {
  if (!UUID_PATTERN.test(id)) return json({ error: "Video not found." }, 404);
  const key = objectKey(id);
  const object = await env.VIDEOS.head(key);
  if (!object) return json({ error: "Video not found." }, 404);

  const fileName = safeDecode(object.customMetadata?.filename, "video");
  const storedType = object.httpMetadata?.contentType ?? "video/mp4";
  const headers = new Headers({
    ...PUBLIC_HEADERS,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": filenameHeader(fileName, inline ? "inline" : "attachment"),
    "Content-Type": inline ? storedType : "application/octet-stream",
    "ETag": object.httpEtag,
    "Last-Modified": object.uploaded.toUTCString(),
  });

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeValue = request.headers.get("Range");
  if (rangeValue) {
    const range = parseRange(rangeValue, object.size);
    if (!range) {
      headers.set("Content-Range", `bytes */${object.size}`);
      return new Response(null, { status: 416, headers });
    }
    const body = await env.VIDEOS.get(key, { range: { offset: range.start, length: range.length } });
    if (!body) return json({ error: "Video not found." }, 404);
    headers.set("Content-Length", String(range.length));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${object.size}`);
    return new Response(body.body, { status: 206, headers });
  }

  const body = await env.VIDEOS.get(key);
  if (!body) return json({ error: "Video not found." }, 404);
  headers.set("Content-Length", String(object.size));
  return new Response(body.body, { status: 200, headers });
}

async function handleApi(request: Request, env: Env, url: URL) {
  if (!env.VIDEOS) return json({ error: "Video storage is unavailable." }, 503);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...PUBLIC_HEADERS,
        "Access-Control-Allow-Headers": "Content-Type, Range, X-Upload-ID",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    if (url.pathname === "/api/uploads" && request.method === "POST") {
      return await startMultipartUpload(request, env);
    }
    const partMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/parts\/(\d+)(?:\/([^/]+))?$/);
    if (partMatch && request.method === "PUT") {
      return await uploadMultipartPart(request, env, partMatch[1], partMatch[2], partMatch[3]);
    }
    const completeMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
    if (completeMatch && request.method === "POST") {
      return await completeMultipartUpload(request, env, completeMatch[1]);
    }
    const bodyAbortMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/abort$/);
    if (bodyAbortMatch && request.method === "POST") {
      return await abortMultipartUpload(request, env, bodyAbortMatch[1]);
    }
    const pathAbortMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)\/abort\/([^/]+)$/);
    if (pathAbortMatch && request.method === "DELETE") {
      return await abortMultipartUpload(request, env, pathAbortMatch[1], pathAbortMatch[2]);
    }
    const abortMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/);
    if (abortMatch && request.method === "DELETE") {
      return await abortMultipartUpload(request, env, abortMatch[1]);
    }
    const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
    if (downloadMatch && (request.method === "GET" || request.method === "HEAD")) {
      return await serveVideo(request, env, downloadMatch[1], false);
    }
    const streamMatch = url.pathname.match(/^\/api\/stream\/([^/]+)$/);
    if (streamMatch && (request.method === "GET" || request.method === "HEAD")) {
      return await serveVideo(request, env, streamMatch[1], true);
    }
    return json({ error: "Endpoint not found." }, 404);
  } catch (error) {
    console.error("Video API error", error);
    return json({ error: "The video service could not complete this request." }, 500);
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
