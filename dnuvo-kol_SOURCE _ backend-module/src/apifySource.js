function toActorRef(actor) {
  return String(actor || '').trim().replace('/', '~');
}

function pickFirst(obj, keys, fallback = null) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function normNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferPlatform(item, profileUrl = '') {
  const p = String(item?.platform || '').toLowerCase();
  if (p.includes('tiktok')) return 'TikTok';
  if (p.includes('instagram') || p === 'ig') return 'Instagram';
  const u = String(profileUrl).toLowerCase();
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('instagram.com')) return 'Instagram';
  return 'Unknown';
}

function extractHandle(item, profileUrl = '') {
  const h = pickFirst(item, [
    'handle',
    'username',
    'userName',
    'authorUniqueId',
    'author_username',
    'ownerUsername',
  ]);
  if (h) return String(h).replace(/^@/, '').trim();
  const m = String(profileUrl).match(/@?([A-Za-z0-9._]{3,})\/?$/);
  return m ? m[1] : null;
}

function calcTierFromFollowers(f) {
  if (!f) return 'unknown';
  if (f < 25000) return 'nano';
  if (f < 100000) return 'micro';
  if (f < 500000) return 'mid';
  if (f < 1000000) return 'macro';
  return 'mega';
}

function getTierFloors() {
  return {
    nano: Number(process.env.APIFY_MIN_FOLLOWERS_NANO || 1000),
    micro: Number(process.env.APIFY_MIN_FOLLOWERS_MICRO || 25000),
    mid: Number(process.env.APIFY_MIN_FOLLOWERS_MID || 100000),
    macro: Number(process.env.APIFY_MIN_FOLLOWERS_MACRO || 500000),
    mega: Number(process.env.APIFY_MIN_FOLLOWERS_MEGA || 1000000),
  };
}

function passesHardGates(candidate) {
  if (!candidate.profileUrl) return false;
  if (!candidate.followers || !Number.isFinite(Number(candidate.followers))) return false;
  if (!candidate.tier || candidate.tier === 'unknown') return false;
  const floors = getTierFloors();
  const minFollowers = floors[candidate.tier];
  if (!minFollowers) return false;
  return Number(candidate.followers) >= minFollowers;
}

function hardGateReason(candidate) {
  if (!candidate.profileUrl) return 'missing_profile_url';
  if (!candidate.followers || !Number.isFinite(Number(candidate.followers))) return 'missing_followers';
  if (!candidate.tier || candidate.tier === 'unknown') return 'unknown_tier';
  const floors = getTierFloors();
  const minFollowers = floors[candidate.tier];
  if (!minFollowers) return 'unknown_tier';
  if (Number(candidate.followers) < minFollowers) return 'below_tier_floor';
  return null;
}

function computeSgLocalConfidence(candidate, setup) {
  const locTarget = String(setup?.loc || '').toLowerCase();
  if (!locTarget.includes('singapore')) return 0.7;

  const hay = `${candidate.location || ''} ${candidate.bio || ''} ${candidate.name || ''}`.toLowerCase();
  let score = 0;
  if (hay.includes('singapore')) score += 0.7;
  if (/\bsg\b/.test(hay)) score += 0.2;
  if (/(orchard|tampines|woodlands|jurong|bedok|bishan|punggol|toa payoh|pasir ris)/.test(hay)) score += 0.15;
  if (/(my|id|ph|th|vn|jakarta|kuala lumpur|bangkok|manila)/.test(hay)) score -= 0.25;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function scoreCandidate(c, setup, tiersRequested = {}) {
  const bio = `${c.bio || ''} ${c.name || ''}`.toLowerCase();
  const skuWords = (setup?.skus || [])
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  const nicheHits = skuWords.reduce((acc, w) => (bio.includes(w) ? acc + 1 : acc), 0);
  const nicheScore = Math.min(1, nicheHits / 4);

  const localScore = computeSgLocalConfidence(c, setup);

  const er = c.engagementRate || 0;
  const erNorm = c.platform === 'TikTok' ? Math.min(1, er / 6) : Math.min(1, er / 4);

  const desired = Object.entries(tiersRequested)
    .filter(([, n]) => Number(n) > 0)
    .map(([k]) => k);
  const tierScore = desired.length ? (desired.includes(c.tier) ? 1 : 0.45) : 0.7;

  const score = (0.35 * nicheScore) + (0.25 * localScore) + (0.25 * erNorm) + (0.15 * tierScore);
  return Math.round(score * 100);
}

async function runActorAndFetchItems({ token, actor, input, waitSecs = 90 }) {
  const actorRef = toActorRef(actor);
  const runUrl = `https://api.apify.com/v2/acts/${actorRef}/runs?token=${encodeURIComponent(token)}&waitForFinish=${waitSecs}`;
  const runRes = await fetch(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
  });
  const runJson = await runRes.json();
  if (!runRes.ok) {
    throw new Error(`Apify run failed (${actor}): ${runJson?.error?.message || runRes.status}`);
  }
  const runData = runJson?.data || {};
  if (!runData.defaultDatasetId) {
    return { actor, runId: runData.id || null, items: [] };
  }
  const dsUrl = `https://api.apify.com/v2/datasets/${runData.defaultDatasetId}/items?token=${encodeURIComponent(token)}&clean=true`;
  const dsRes = await fetch(dsUrl);
  const items = dsRes.ok ? await dsRes.json() : [];
  return {
    actor,
    runId: runData.id || null,
    datasetId: runData.defaultDatasetId,
    items: Array.isArray(items) ? items : [],
  };
}

function normalizeDiscoveryItems(items) {
  return (items || []).map((item) => {
    const profileUrl = pickFirst(item, ['profileUrl', 'url', 'profile_link', 'authorUrl'], '');
    const followers = normNumber(pickFirst(item, ['followers', 'followerCount', 'followersCount', 'fans', 'authorFollowerCount']));
    const engagementRate = normNumber(pickFirst(item, ['engagementRate', 'er', 'engagement_rate']));
    const location = pickFirst(item, ['location', 'country', 'region', 'audienceLocation'], '');
    const name = pickFirst(item, ['name', 'fullName', 'displayName', 'authorName'], 'Unknown');
    const handle = extractHandle(item, profileUrl);
    const platform = inferPlatform(item, profileUrl);
    return {
      name,
      handle,
      platform,
      profileUrl,
      followers,
      engagementRate,
      bio: pickFirst(item, ['bio', 'description', 'headline'], ''),
      location,
      email: pickFirst(item, ['email', 'businessEmail'], null),
      source: 'discovery',
      tier: calcTierFromFollowers(followers),
      raw: item,
    };
  });
}

function mergeByHandle(base, enrich, sourceLabel) {
  const m = new Map(base.map((b) => [`${b.platform}:${b.handle || b.profileUrl}`, { ...b }]));
  for (const e of enrich) {
    const key = `${e.platform}:${e.handle || e.profileUrl}`;
    if (!m.has(key)) continue;
    const curr = m.get(key);
    m.set(key, {
      ...curr,
      followers: e.followers || curr.followers,
      engagementRate: e.engagementRate || curr.engagementRate,
      email: e.email || curr.email,
      source: `${curr.source}+${sourceLabel}`,
      raw: curr.raw,
    });
  }
  return [...m.values()];
}

async function sourceKolMultiActor({ token, setup, tiers = {}, backup = 5, maxResults = 40, actors = {} }) {
  const platforms = (setup?.platforms || [])
    .map((p) => String(p || '').toLowerCase())
    .filter((p) => ['tiktok', 'instagram'].includes(p));
  const tiersRequested = tiers || {};

  const discoveryInput = {
    platforms: platforms.length ? platforms : ['tiktok', 'instagram'],
    niches: ['skincare', 'k-beauty', 'sensitive skin', 'beauty'],
    keywords: ['ceramide', 'milia', 'ampoule', 'skin barrier'],
    locations: [setup?.loc || 'Singapore'],
    influencerTiers: Object.entries(tiersRequested).filter(([, n]) => Number(n) > 0).map(([k]) => k),
    minEngagementRate: 2,
    includeContactInfo: true,
    maxResults,
    languagePreference: 'en',
    sortBy: 'engagementRate',
  };

  const used = [];
  const discoveryRun = await runActorAndFetchItems({
    token,
    actor: actors.discovery,
    input: discoveryInput,
    waitSecs: Number(process.env.APIFY_WAIT_SECS || 90),
  });
  used.push({ actor: actors.discovery, runId: discoveryRun.runId, itemCount: discoveryRun.items.length });
  let candidates = normalizeDiscoveryItems(discoveryRun.items);

  const ttProfiles = candidates
    .filter((c) => c.platform === 'TikTok' && c.profileUrl)
    .slice(0, 20)
    .map((c) => c.profileUrl);
  if (ttProfiles.length && actors.tiktok) {
    try {
      const ttRun = await runActorAndFetchItems({
        token,
        actor: actors.tiktok,
        input: { profiles: ttProfiles, maxVideos: 6, includeAnalytics: true },
        waitSecs: Number(process.env.APIFY_WAIT_SECS || 90),
      });
      used.push({ actor: actors.tiktok, runId: ttRun.runId, itemCount: ttRun.items.length });
      const ttNorm = normalizeDiscoveryItems(ttRun.items).map((x) => ({ ...x, source: 'tiktok-enrichment' }));
      candidates = mergeByHandle(candidates, ttNorm, 'tt');
    } catch (e) {
      used.push({ actor: actors.tiktok, error: e.message });
    }
  }

  const igHandles = candidates
    .filter((c) => c.platform === 'Instagram' && c.handle)
    .slice(0, 30)
    .map((c) => c.handle);
  if (igHandles.length && actors.instagram) {
    try {
      // Try a simple profile enrichment schema first.
      let igRun = await runActorAndFetchItems({
        token,
        actor: actors.instagram,
        input: { profiles: igHandles.map((h) => `https://www.instagram.com/${h}`) },
        waitSecs: Number(process.env.APIFY_WAIT_SECS || 90),
      });

      // If no results, retry with a username-based schema.
      if (!igRun.items.length) {
        igRun = await runActorAndFetchItems({
          token,
          actor: actors.instagram,
          input: { usernames: igHandles },
          waitSecs: Number(process.env.APIFY_WAIT_SECS || 90),
        });
      }

      used.push({ actor: actors.instagram, runId: igRun.runId, itemCount: igRun.items.length });
      const igNorm = normalizeDiscoveryItems(igRun.items).map((x) => ({ ...x, source: 'instagram-enrichment' }));
      candidates = mergeByHandle(candidates, igNorm, 'ig');
    } catch (e) {
      used.push({ actor: actors.instagram, error: e.message });
    }
  }

  const uniq = new Map();
  for (const c of candidates) {
    if (!c.handle && !c.profileUrl) continue;
    if (!['TikTok', 'Instagram'].includes(c.platform)) continue;
    const key = `${c.platform}:${c.handle || c.profileUrl}`;
    if (!uniq.has(key)) uniq.set(key, c);
  }
  const debug = {
    totalRawCandidates: 0,
    dedupedCandidates: 0,
    rejected: {
      missing_profile_url: [],
      missing_followers: [],
      unknown_tier: [],
      below_tier_floor: [],
      low_sg_confidence: [],
    },
  };

  const deduped = [...uniq.values()];
  debug.totalRawCandidates = candidates.length;
  debug.dedupedCandidates = deduped.length;

  const hardPassed = [];
  for (const c of deduped) {
    const reason = hardGateReason(c);
    if (reason) {
      debug.rejected[reason].push({
        platform: c.platform,
        handle: c.handle,
        profileUrl: c.profileUrl,
        followers: c.followers,
        tier: c.tier,
      });
      continue;
    }
    hardPassed.push(c);
  }

  let list = hardPassed
    .map((c) => ({
    ...c,
    localConfidence: computeSgLocalConfidence(c, setup),
    score: scoreCandidate(c, setup, tiersRequested),
  }));

  const locStrict = String(setup?.loc || '').toLowerCase();
  if (locStrict.includes('singapore')) {
    const minLocalConfidence = Number(process.env.APIFY_SG_LOCAL_CONFIDENCE_MIN || 0.7);
    const passed = [];
    for (const c of list) {
      if (c.localConfidence >= minLocalConfidence) {
        passed.push(c);
      } else {
        debug.rejected.low_sg_confidence.push({
          platform: c.platform,
          handle: c.handle,
          profileUrl: c.profileUrl,
          followers: c.followers,
          tier: c.tier,
          localConfidence: c.localConfidence,
        });
      }
    }
    list = passed;
  }
  list.sort((a, b) => b.score - a.score);

  const needed = Math.max(1, Object.values(tiersRequested).reduce((a, b) => a + Number(b || 0), 0));
  const shortlist = list.slice(0, needed);
  const backups = list.slice(needed, needed + Number(backup || 5));

  return {
    actorsUsed: used,
    shortlist,
    backups,
    totalCandidates: list.length,
    debug,
  };
}

module.exports = { sourceKolMultiActor };
