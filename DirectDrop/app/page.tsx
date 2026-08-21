"use client";

import { useRef, useState } from "react";

const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
const EXTENSIONS = new Set(["mp4", "mov", "webm"]);

type UploadResult = {
  id: string;
  fileName: string;
  fileSize: number;
  duration: number;
  directUrl: string;
  watchUrl: string;
};

type UploadStart = {
  id: string;
  uploadId: string;
  partSize: number;
};

type UploadedPart = {
  partNumber: number;
  etag: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function getDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("This file does not contain readable video metadata."));
    };
    video.src = objectUrl;
  });
}

function uploadPart(
  url: string,
  body: Blob,
  uploadId: string,
  onProgress: (loaded: number) => void,
) {
  return new Promise<UploadedPart>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const prefix = new TextEncoder().encode(`${uploadId}\n`);
    const payload = new Blob([prefix, body], { type: "application/octet-stream" });
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress(Math.max(0, event.loaded - prefix.byteLength));
    xhr.onerror = () => reject(new Error("The upload connection was interrupted."));
    xhr.onload = () => {
      try {
        const response = JSON.parse(xhr.responseText) as UploadedPart & { error?: string };
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(response.error || "A video chunk could not be uploaded."));
          return;
        }
        resolve(response);
      } catch {
        reject(new Error("The upload service returned an invalid response."));
      }
    };
    xhr.send(payload);
  });
}

async function readError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [readingMetadata, setReadingMetadata] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function chooseFile(nextFile?: File) {
    if (!nextFile) return;
    setError("");
    setResult(null);
    const extension = nextFile.name.split(".").pop()?.toLowerCase() ?? "";
    if (!EXTENSIONS.has(extension)) {
      setError("Choose an MP4, MOV, or WebM video.");
      return;
    }
    if (nextFile.size <= 0 || nextFile.size > MAX_FILE_BYTES) {
      setError("Videos must be larger than 0 bytes and no more than 1 GB.");
      return;
    }
    setFile(nextFile);
    setReadingMetadata(true);
    try {
      setDuration(await getDuration(nextFile));
    } catch (metadataError) {
      setFile(null);
      setError(metadataError instanceof Error ? metadataError.message : "Could not read this video.");
    } finally {
      setReadingMetadata(false);
    }
  }

  async function startUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setError("");
    setProgress(0);
    let started: UploadStart | null = null;

    try {
      const startResponse = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          contentType: file.type,
          duration,
        }),
      });
      if (!startResponse.ok) throw new Error(await readError(startResponse));
      started = (await startResponse.json()) as UploadStart;

      const parts: UploadedPart[] = [];
      let uploadedBytes = 0;
      let partNumber = 1;
      while (uploadedBytes < file.size) {
        const end = Math.min(uploadedBytes + started.partSize, file.size);
        const chunk = file.slice(uploadedBytes, end);
        const baseUploaded = uploadedBytes;
        const part = await uploadPart(
          `/api/uploads/${started.id}/parts/${partNumber}`,
          chunk,
          started.uploadId,
          (loaded) => {
            const percent = Math.round(((baseUploaded + loaded) / file.size) * 100);
            setProgress(Math.min(percent, 99));
          },
        );
        parts.push(part);
        uploadedBytes = end;
        partNumber += 1;
      }

      const completeResponse = await fetch(`/api/uploads/${started.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: started.uploadId, parts }),
      });
      if (!completeResponse.ok) throw new Error(await readError(completeResponse));

      const completed = (await completeResponse.json()) as Omit<UploadResult, "duration">;
      setProgress(100);
      setResult({ ...completed, duration });
    } catch (uploadError) {
      if (started) {
        void fetch(`/api/uploads/${started.id}/abort`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId: started.uploadId }),
        });
      }
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.directUrl);
    } catch {
      const text = document.createElement("textarea");
      text.value = result.directUrl;
      document.body.appendChild(text);
      text.select();
      document.execCommand("copy");
      text.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function reset() {
    setFile(null);
    setResult(null);
    setProgress(0);
    setError("");
    setCopied(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <main className="site-shell">
      <header className="brand" aria-label="DirectDrop home">
        <span className="brand-mark" aria-hidden="true">↑</span>
        <span>DirectDrop</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="eyebrow">PUBLIC VIDEO LINKS</div>
        <h1 id="page-title">Upload once. Share directly.</h1>
        <p className="lede">
          Turn a video into a permanent, public download link that works for
          people, tools, and AI—no sign-in or preview page in the way.
        </p>

        {!result && !uploading && (
          <div
            className={`drop-zone${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void chooseFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              ref={inputRef}
              className="file-input"
              type="file"
              accept={ACCEPT}
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
            <span className="upload-glyph" aria-hidden="true">↑</span>
            {file ? (
              <>
                <span className="drop-title">{file.name}</span>
                <span className="drop-copy">
                  {formatBytes(file.size)}{readingMetadata ? " · Reading video…" : ` · ${formatDuration(duration)}`}
                </span>
                <div className="file-actions">
                  <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
                    Choose Another
                  </button>
                  <button className="primary-button" type="button" disabled={readingMetadata} onClick={startUpload}>
                    Upload Video
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="drop-title">Drop your video here</span>
                <span className="drop-copy">or choose a file from your device</span>
                <button className="primary-button choose-button" type="button" onClick={() => inputRef.current?.click()}>
                  Upload Video
                </button>
              </>
            )}
            <span className="limits">MP4, MOV or WebM · up to 1 GB</span>
          </div>
        )}

        {uploading && (
          <div className="progress-card" role="status" aria-live="polite">
            <span className="upload-glyph progress-glyph" aria-hidden="true">↑</span>
            <span className="drop-title">Uploading {file?.name}</span>
            <span className="drop-copy">Keep this tab open until the link is ready.</span>
            <div className="progress-track" aria-label={`Upload ${progress}% complete`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <strong className="progress-number">{progress}%</strong>
          </div>
        )}

        {result && (
          <div className="complete-card">
            <div className="success-mark" aria-hidden="true">✓</div>
            <div className="complete-label">Upload complete</div>
            <h2>{result.fileName}</h2>
            <div className="file-meta">
              <span>{formatBytes(result.fileSize)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(result.duration)}</span>
            </div>
            <label className="link-label" htmlFor="direct-link">Direct download link</label>
            <div className="link-row">
              <input id="direct-link" readOnly value={result.directUrl} onFocus={(event) => event.currentTarget.select()} />
              <button className="copy-button" type="button" onClick={copyLink}>{copied ? "Copied!" : "Copy Link"}</button>
            </div>
            <div className="result-actions">
              <button className="primary-button" type="button" onClick={copyLink}>Copy Direct Link</button>
              <a className="secondary-button" href={result.watchUrl} target="_blank" rel="noreferrer">Open Video</a>
              <button className="text-button" type="button" onClick={reset}>Upload Another Video</button>
            </div>
          </div>
        )}

        {error && <div className="error-message" role="alert">{error}</div>}

        <div className="assurances" aria-label="Upload assurances">
          <span><i aria-hidden="true" /> Direct file URL</span>
          <span><i aria-hidden="true" /> No login required</span>
          <span><i aria-hidden="true" /> Range requests supported</span>
        </div>
      </section>

      <footer>
        Anyone with a generated link can download its video. Links do not expire.
      </footer>
    </main>
  );
}
