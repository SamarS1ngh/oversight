"use client";
import { clipVideoUrl } from "@/lib/api";

// Fullscreen-ish modal that plays one clip. Native <video controls> gives
// scrubbing for free (the API serves HTTP Range).
export function ClipPlayer({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <video src={clipVideoUrl(clipId)} controls autoPlay playsInline />
        <div className="modal-actions">
          <a href={clipVideoUrl(clipId)} download className="btn">
            Download
          </a>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
