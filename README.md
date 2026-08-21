# DirectDrop

DirectDrop is a single-purpose video uploader. It stores videos in Cloudflare R2 and returns a permanent, public, same-origin URL that serves the file bytes directly. The raw URL requires no account, cookie, JavaScript, CAPTCHA, permission page, or browser session.

## What is included

- Drag-and-drop MP4, MOV, and WebM uploads up to 1 GiB.
- Chunked multipart uploads (16 MiB per request), so large files are never loaded into Worker memory.
- Upload percentage, video duration, file size, and one-click link copying.
- R2 object metadata with a random UUID key for every video.
- `GET` and `HEAD` at `/api/download/:id` with `Content-Disposition: attachment`, `application/octet-stream`, exact `Content-Length`, and `Accept-Ranges: bytes`.
- Single-range `GET` support with HTTP `206` and `Content-Range`.
- Optional browser preview at `/watch/:id`, backed by `/api/stream/:id`.

## Local development

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
cp .env.example .env
npm run dev
```

The local Cloudflare runtime creates an emulated R2 bucket automatically from `.openai/hosting.json`. Open `http://localhost:3000`.

`SITE_ORIGIN` is the only environment value. It is a public trusted origin used for absolute social-card metadata, not a secret. R2 credentials are never exposed to the browser because the deployed Worker uses an R2 binding instead of access keys.

## Deployment

This project is configured for OpenAI Sites. Build it with `npm run build`, create or select a Site, configure its production `SITE_ORIGIN` to the final `https://...` origin, save a version, and deploy it. Sites provisions and binds the `VIDEOS` R2 bucket declared in `.openai/hosting.json`.

For a standalone Cloudflare Workers deployment, keep the Worker-compatible build output and bind an R2 bucket as `VIDEOS`. Set `SITE_ORIGIN` to the public HTTPS origin. No R2 access key belongs in frontend code or in public environment variables.

## Direct-link verification

Upload a video in the site, copy its direct link, then run:

```bash
curl -I "DIRECT_URL"
curl -L "DIRECT_URL" -o test-video.mp4
curl -H "Range: bytes=0-999999" "DIRECT_URL" -o partial.bin
```

The first response should be `200` and include `Accept-Ranges: bytes`, the original `Content-Length`, `Content-Type: application/octet-stream`, and an attachment filename. The second file should match the uploaded byte size and checksum. The range request should return `206`; its output will be 1,000,000 bytes when the source video is at least that large.

## Security notes

- Both file extension and reported MIME type are validated; the stored MIME type is server-selected.
- Filenames are sanitized and are used only as download metadata. R2 keys are UUIDs.
- Upload metadata, chunk size, part count, total completed size, IDs, and HTTP methods are bounded and validated.
- Public links are intentionally bearer-style: anyone who has a hard-to-guess URL can download the video, and links do not expire.
- A public anonymous uploader can be abused. For an internet-facing high-volume deployment, configure Cloudflare rate limiting, spend alerts, retention rules, and abuse monitoring without putting authentication in front of the download endpoint.
