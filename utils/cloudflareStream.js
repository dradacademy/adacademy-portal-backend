// Thin wrapper around Cloudflare Stream's REST API + signed-token minting.
// All four Cloudflare credentials are admin-provided Railway env vars (see
// the plan's Context section) — none of these calls can succeed until the
// admin has completed the Cloudflare Stream account/API-token signup.
//
// Deliberately uses Node's built-in global `fetch` (Node 18+) rather than
// adding a new HTTP client dependency — this backend has no runtime HTTP
// client in its own `dependencies` (axios is a devDependency only, used by
// tests).
const jwt = require("jsonwebtoken");

const REQUIRED_ENV_VARS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_STREAM_API_TOKEN",
];

// The Stream Player iframe embed URL needs the account's Cloudflare
// "customer code" (found in the Stream Dashboard) — NOT the account ID —
// to build https://customer-<CODE>.cloudflarestream.com/<token>/iframe.
// Exposed to the frontend alongside the signed token (see
// videoPlaybackController.js's getPlaybackToken) since the player embed
// happens client-side.
const getCustomerCode = () => process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE || null;

const isConfigured = () =>
  REQUIRED_ENV_VARS.every((key) => !!process.env[key]);

const isSigningConfigured = () =>
  !!process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID &&
  !!process.env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM;

const assertConfigured = () => {
  if (!isConfigured()) {
    throw new Error(
      "Cloudflare Stream is not configured yet. An admin needs to set " +
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN (Railway env vars) " +
        "before recorded classes can be uploaded or played back."
    );
  }
};

const cloudflareApiBase = () =>
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/stream`;

const cloudflareHeaders = () => ({
  Authorization: `Bearer ${process.env.CLOUDFLARE_STREAM_API_TOKEN}`,
  "Content-Type": "application/json",
});

// Request a one-time direct-creator-upload URL. The ADMIN's BROWSER uploads
// the video file straight to this URL (never through our own Railway
// server) — essential for multi-hour class recordings, avoiding the
// server-side timeouts/memory pressure that routing multi-GB files through
// our own backend would cause.
// https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/
const createDirectUploadUrl = async ({ maxDurationSeconds = 4 * 60 * 60 } = {}) => {
  assertConfigured();

  const response = await fetch(`${cloudflareApiBase()}/direct_upload`, {
    method: "POST",
    headers: cloudflareHeaders(),
    body: JSON.stringify({
      maxDurationSeconds,
      // requireSignedURLs: playback is ONLY ever via a short-lived signed
      // token (see mintPlaybackToken below) — this is what actually
      // prevents an unauthenticated/unauthorized viewer from ever loading
      // the video, on top of our own enrollment/category checks.
      requireSignedURLs: true,
    }),
  });

  const json = await response.json();
  if (!response.ok || !json.success) {
    throw new Error(
      `Cloudflare direct_upload failed: ${JSON.stringify(json.errors || json)}`
    );
  }

  return {
    uploadUrl: json.result.uploadURL,
    videoUid: json.result.uid,
  };
};

// Permanently remove a video from Cloudflare Stream storage (used by the
// retention job — see jobs/videoRetentionJob.js).
const deleteStreamVideo = async (videoUid) => {
  assertConfigured();

  const response = await fetch(`${cloudflareApiBase()}/${videoUid}`, {
    method: "DELETE",
    headers: cloudflareHeaders(),
  });

  // Cloudflare returns 200 with success:true, or 404 if it's already gone —
  // either way the video no longer exists there, which is what we want.
  if (response.status === 404) return true;

  const json = await response.json();
  if (!response.ok || !json.success) {
    throw new Error(
      `Cloudflare delete video failed: ${JSON.stringify(json.errors || json)}`
    );
  }
  return true;
};

// Mint a short-lived signed JWT for HLS playback of one specific video.
// This is what satisfies "no download button" / "streaming only" / "no raw
// file exposure" — the Stream Player only ever receives this token, never
// a raw file URL, and the token expires quickly (default 4 hours, generous
// enough for one class re-watch sitting, short enough that a leaked token
// isn't useful for long).
// https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream-embeds/
const mintPlaybackToken = (videoUid, { expiresInSeconds = 4 * 60 * 60 } = {}) => {
  if (!isSigningConfigured()) {
    throw new Error(
      "Cloudflare Stream signing is not configured yet. An admin needs to set " +
        "CLOUDFLARE_STREAM_SIGNING_KEY_ID and CLOUDFLARE_STREAM_SIGNING_KEY_PEM " +
        "(Railway env vars) before video playback can be authorized."
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Common gotcha: a multi-line PEM pasted into a single-line env var
  // (Railway, .env, etc.) often ends up with literal "\n" two-character
  // sequences instead of real newlines. Normalize that here so the admin
  // doesn't have to fight PEM formatting when setting the env var — paste
  // the `pem` value from Cloudflare's key-creation response as-is.
  const signingKey = process.env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM.replace(
    /\\n/g,
    "\n"
  );

  return jwt.sign(
    {
      sub: videoUid,
      kid: process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID,
      exp: nowSeconds + expiresInSeconds,
      accessRules: [{ type: "any" }],
    },
    signingKey,
    {
      algorithm: "RS256",
      header: { kid: process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID },
    }
  );
};

module.exports = {
  isConfigured,
  isSigningConfigured,
  getCustomerCode,
  createDirectUploadUrl,
  deleteStreamVideo,
  mintPlaybackToken,
};
