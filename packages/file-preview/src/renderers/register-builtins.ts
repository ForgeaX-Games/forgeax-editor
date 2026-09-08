// Builtin renderer registrations. Imported for its side effect by FilePreview,
// so the builtins are present whenever the host is used. Registration is
// idempotent by id, so double evaluation (HMR / multiple entry points) is safe.

import { registerFilePreviewRenderer } from '../registry';
import { CodePreview, matchesCode } from './CodePreview';
import { AudioPreview, ImagePreview, VideoPreview, matchesAudio, matchesImage, matchesVideo } from './MediaPreviews';
import { FontPreview, matchesFont } from './FontPreview';

// Builtins share priority 0; their `match` predicates are mutually exclusive
// (mime/family/extension), and a plugin registered later wins on any tie.
registerFilePreviewRenderer({ id: 'builtin:image', match: matchesImage, component: ImagePreview });
registerFilePreviewRenderer({ id: 'builtin:audio', match: matchesAudio, component: AudioPreview });
registerFilePreviewRenderer({ id: 'builtin:video', match: matchesVideo, component: VideoPreview });
registerFilePreviewRenderer({ id: 'builtin:font', match: matchesFont, component: FontPreview });
registerFilePreviewRenderer({ id: 'builtin:code', match: matchesCode, component: CodePreview });
