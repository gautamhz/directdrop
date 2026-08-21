import type { Metadata } from "next";

type WatchProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: WatchProps): Promise<Metadata> {
  const { id } = await params;
  const shortId = id.slice(0, 8);
  const title = `Video ${shortId} — DirectDrop`;
  const description = "Public video preview with a permanent direct-download link.";
  return {
    title,
    description,
    openGraph: { title, description, images: [] },
    twitter: { title, description, images: [] },
  };
}

export default async function Watch({ params }: WatchProps) {
  const { id } = await params;
  const encodedId = encodeURIComponent(id);
  return (
    <main className="watch-shell">
      <a className="brand watch-brand" href="/" aria-label="Back to DirectDrop">
        <span className="brand-mark" aria-hidden="true">↑</span>
        <span>DirectDrop</span>
      </a>
      <section className="watch-card">
        <video controls preload="metadata" src={`/api/stream/${encodedId}`}>
          Your browser does not support video playback.
        </video>
        <div className="watch-actions">
          <div>
            <div className="complete-label">Public video</div>
            <p>This preview and its direct link require no account.</p>
          </div>
          <a className="primary-button" href={`/api/download/${encodedId}`}>Download Video</a>
        </div>
      </section>
    </main>
  );
}
