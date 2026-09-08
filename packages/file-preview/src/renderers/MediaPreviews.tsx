import type { ReactNode } from 'react';
import type { FilePreviewInput } from '../types';

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv']);

export function matchesImage(input: FilePreviewInput): boolean {
  return input.family === 'image' || input.mime.startsWith('image/');
}
export function matchesAudio(input: FilePreviewInput): boolean {
  return input.family === 'audio' || input.mime.startsWith('audio/');
}
export function matchesVideo(input: FilePreviewInput): boolean {
  return input.mime.startsWith('video/') || VIDEO_EXTS.has(input.ext);
}

export function ImagePreview({ rawUrl, name }: FilePreviewInput): ReactNode {
  return (
    <div className="fx-fp-media">
      <img src={rawUrl} alt={name} />
    </div>
  );
}

export function AudioPreview({ rawUrl }: FilePreviewInput): ReactNode {
  // A user-asset audio file has no caption track to offer.
  return (
    <div className="fx-fp-media">
      <audio controls src={rawUrl} />
    </div>
  );
}

export function VideoPreview({ rawUrl }: FilePreviewInput): ReactNode {
  // A user-asset video file has no caption track to offer.
  return (
    <div className="fx-fp-media">
      <video controls src={rawUrl} />
    </div>
  );
}
