// Small helper for the YouTube-based recorded-class system: turns whatever
// URL format an admin pastes (or a bare 11-char ID) into the plain video ID
// the YouTube IFrame Player needs. No YouTube API key/quota involved — this
// is pure string parsing, deliberately kept dependency-free.
//
// Supported forms:
//   https://www.youtube.com/watch?v=VIDEOID
//   https://youtu.be/VIDEOID
//   https://www.youtube.com/embed/VIDEOID
//   https://www.youtube.com/shorts/VIDEOID
//   a bare 11-character video ID typed directly
const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

const extractYoutubeVideoId = (input) => {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();

  if (YOUTUBE_ID_PATTERN.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
      }
      const segments = url.pathname.split("/").filter(Boolean);
      // /embed/VIDEOID or /shorts/VIDEOID
      if (segments.length >= 2 && ["embed", "shorts", "live"].includes(segments[0])) {
        const id = segments[1];
        return YOUTUBE_ID_PATTERN.test(id) ? id : null;
      }
    }

    return null;
  } catch {
    // Not a valid absolute URL and not a bare ID either.
    return null;
  }
};

module.exports = { extractYoutubeVideoId };
