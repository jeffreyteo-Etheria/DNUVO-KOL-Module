// TikTok Content Posting API v2 — Direct Post flow
// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
// Requires: approved app with video.publish scope + user access token (.env)
// Flow: 1) init → 2) upload video bytes → 3) TikTok processes & publishes

async function postTikTok({ videoUrl, caption }) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error('TIKTOK_ACCESS_TOKEN missing — complete API application first (see guide).');

  // Step 1 — initialise a PULL_FROM_URL direct post (simplest server flow)
  const init = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_info: {
        title: caption?.slice(0, 2200) || '',
        privacy_level: 'SELF_ONLY',   // start private; switch to PUBLIC_TO_EVERYONE after app audit
        disable_duet: false, disable_comment: false, disable_stitch: false,
      },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    }),
  });
  const data = await init.json();
  if (data.error?.code !== 'ok') throw new Error(`TikTok init failed: ${JSON.stringify(data.error)}`);

  // Step 2 — poll publish status
  const publishId = data.data.publish_id;
  return { publishId, note: 'Poll /v2/post/publish/status/fetch/ with this publish_id until PUBLISH_COMPLETE.' };
}

module.exports = { postTikTok };
