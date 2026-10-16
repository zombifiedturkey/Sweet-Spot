// Artist "About" info from open sources (Spotify no longer provides bios or stats):
//   MusicBrainz → origin, year formed, members, genres, links (and the exact Wikidata ID)
//   Wikidata    → the matching English Wikipedia article (avoids "Nirvana (band)" vs the concept)
//   Wikipedia   → the short description and opening paragraph
// Runs in the main process so it can send a proper User-Agent (MusicBrainz asks for one)
// and keeps a small on-disk cache so each artist is only looked up once a fortnight.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const UA = 'SweetSpot/1.0 ( https://github.com/zombifiedturkey/Sweet-Spot )';
const TTL = 14 * 24 * 60 * 60 * 1000;
const cacheFile = () => path.join(app.getPath('userData'), 'artist-info.json');
let cache = null;
let lastMb = 0;

function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try { fs.writeFileSync(cacheFile(), JSON.stringify(cache)); } catch {}
}

async function getJson(url, { mb = false } = {}) {
  if (mb) {
    // MusicBrainz allows about one request per second.
    const wait = lastMb + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastMb = Date.now();
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

// Pick the MusicBrainz artist that best matches the Spotify artist name (and genres, as a tie-breaker).
function pickArtist(results, name, genres) {
  const want = norm(name);
  const exact = results.filter((a) => norm(a.name) === want || (a.aliases || []).some((x) => norm(x.name) === want));
  if (!exact.length) return null;
  if (exact.length === 1 || !genres || !genres.length) return exact[0];
  const g = genres.map((x) => x.toLowerCase());
  const scoreOf = (a) => (a.tags || []).reduce((n, t) => n + (g.some((x) => x.includes(t.name) || t.name.includes(x)) ? t.count || 1 : 0), 0) + (a.score || 0) / 100;
  return exact.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0];
}

function yearOf(d) { return d ? String(d).slice(0, 4) : null; }

async function wikipediaSummary(title) {
  const s = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (!s || s.type === 'disambiguation' || !s.extract) return null;
  return {
    title: s.title,
    description: s.description || null,
    extract: s.extract,
    url: s.content_urls && s.content_urls.desktop ? s.content_urls.desktop.page : `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`
  };
}

async function lookup(name, genres) {
  const info = { name, sources: [] };

  // 1) MusicBrainz
  let mbArtist = null;
  try {
    const q = `artist:"${name.replace(/"/g, '')}"`;
    const search = await getJson(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(q)}&fmt=json&limit=8`, { mb: true });
    const hit = pickArtist(search.artists || [], name, genres);
    if (hit) {
      mbArtist = await getJson(`https://musicbrainz.org/ws/2/artist/${hit.id}?inc=artist-rels+url-rels+genres+tags&fmt=json`, { mb: true });
    }
  } catch (e) { info.mbError = e.message; }

  let wikidataId = null;
  if (mbArtist) {
    info.sources.push({ name: 'MusicBrainz', url: `https://musicbrainz.org/artist/${mbArtist.id}` });
    info.type = mbArtist.type || null; // Person, Group, Orchestra, Choir…
    const ls = mbArtist['life-span'] || {};
    info.begin = yearOf(ls.begin);
    info.end = ls.ended ? yearOf(ls.end) || 'yes' : null;
    const area = mbArtist['begin-area'] || mbArtist.area;
    info.origin = area ? area.name : null;
    if (mbArtist.area && mbArtist['begin-area'] && mbArtist.area.name !== mbArtist['begin-area'].name) {
      info.origin = `${mbArtist['begin-area'].name}, ${mbArtist.area.name}`;
    }
    const genreList = (mbArtist.genres && mbArtist.genres.length ? mbArtist.genres : mbArtist.tags || [])
      .slice().sort((a, b) => (b.count || 0) - (a.count || 0)).map((g) => g.name);
    info.genres = genreList.slice(0, 6);

    const rels = mbArtist.relations || [];
    // Band members (for groups) — current first.
    const seen = new Map();
    for (const r of rels) {
      if (r.type !== 'member of band' || r.direction !== 'backward' || !r.artist) continue;
      const prev = seen.get(r.artist.id);
      const m = {
        name: r.artist.name,
        current: !r.ended,
        from: yearOf(r.begin),
        to: yearOf(r.end),
        roles: (r.attributes || []).filter((a) => !['original', 'founder'].includes(a))
      };
      // The same person can have several stints; keep the current/latest one.
      if (!prev || (m.current && !prev.current) || (m.to || '') > (prev.to || '')) seen.set(r.artist.id, m);
    }
    info.members = [...seen.values()].sort((a, b) => (b.current - a.current) || String(a.from || '').localeCompare(String(b.from || '')));

    // Links
    const links = {};
    for (const r of rels) {
      if (!r.url || !r.url.resource) continue;
      if (r.type === 'wikidata') wikidataId = r.url.resource.split('/').pop();
      if (r.type === 'official homepage' && !links.official) links.official = r.url.resource;
      if (r.type === 'wikipedia' && !links.wikipedia && /en\.wikipedia/.test(r.url.resource)) links.wikipedia = r.url.resource;
    }
    info.links = links;
  }

  // 2) Wikipedia (via Wikidata when MusicBrainz gave us one, so we get the right page)
  let wiki = null;
  try {
    let title = null;
    if (info.links && info.links.wikipedia) title = decodeURIComponent(info.links.wikipedia.split('/wiki/')[1] || '');
    if (!title && wikidataId) {
      const wd = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`);
      const ent = wd.entities && (wd.entities[wikidataId] || Object.values(wd.entities)[0]);
      title = ent && ent.sitelinks && ent.sitelinks.enwiki ? ent.sitelinks.enwiki.title : null;
    }
    if (title) wiki = await wikipediaSummary(title);
    if (!wiki) {
      // No MusicBrainz link: try the common Wikipedia naming patterns.
      const kinds = info.type === 'Person' ? ['musician', 'singer', 'rapper'] : ['band', 'musician', 'singer', 'rapper', 'group'];
      for (const t of [name, ...kinds.map((k) => `${name} (${k})`)]) {
        try {
          const w = await wikipediaSummary(t);
          // Make sure it's actually about music, not a place or a film.
          if (w && /(band|musician|singer|rapper|group|duo|producer|DJ|composer|songwriter|artist|record|music)/i.test(`${w.description} ${w.extract.slice(0, 300)}`)) { wiki = w; break; }
        } catch {}
      }
    }
  } catch (e) { info.wikiError = e.message; }

  if (wiki) {
    info.description = wiki.description;
    info.extract = wiki.extract;
    info.links = { ...(info.links || {}), wikipedia: wiki.url };
    info.sources.unshift({ name: 'Wikipedia', url: wiki.url });
  }
  info.found = !!(mbArtist || wiki);
  return info;
}

async function getArtistInfo(spotifyId, name, genres) {
  const c = loadCache();
  const hit = c[spotifyId];
  if (hit && Date.now() - hit.at < TTL) return hit.info;
  const info = await lookup(name, genres);
  // Don't cache a total miss caused by a network error, so it's retried next time.
  if (info.found || (!info.mbError && !info.wikiError)) {
    c[spotifyId] = { at: Date.now(), info };
    saveCache();
  }
  return info;
}

module.exports = { getArtistInfo, _test: { pickArtist, norm, lookup } };
