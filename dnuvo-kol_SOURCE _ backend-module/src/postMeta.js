// Meta Graph API — Instagram Reels + Facebook Page posts
// Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing
// Requires: Business app, IG Business account linked to a FB Page,
//           long-lived Page token with instagram_content_publish + pages_manage_posts

const G = 'https://graph.facebook.com/v21.0';

async function postInstagram({ videoUrl, caption }) {
  const { META_IG_USER_ID: ig, META_ACCESS_TOKEN: token } = process.env;
  if (!ig || !token) throw new Error('Meta credentials missing — see API-APPLICATION-GUIDE.md');

  // 1) Create media container (REELS for video)
  const c = await fetch(`${G}/${ig}/media`, {
    method: 'POST',
    body: new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption: caption || '', access_token: token }),
  }).then(r => r.json());
  if (!c.id) throw new Error(`IG container failed: ${JSON.stringify(c)}`);

  // 2) Publish (container must reach FINISHED — poll status_code first in production)
  const pub = await fetch(`${G}/${ig}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: c.id, access_token: token }),
  }).then(r => r.json());
  return { containerId: c.id, published: pub };
}

async function postFacebook({ videoUrl, caption }) {
  const { META_PAGE_ID: page, META_ACCESS_TOKEN: token } = process.env;
  if (!page || !token) throw new Error('Meta credentials missing — see API-APPLICATION-GUIDE.md');
  const r = await fetch(`${G}/${page}/videos`, {
    method: 'POST',
    body: new URLSearchParams({ file_url: videoUrl, description: caption || '', access_token: token }),
  }).then(r => r.json());
  return r;
}

module.exports = { postInstagram, postFacebook };
