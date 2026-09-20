'use strict';

/*
 * Ringtone Maker backend
 *   GET /api/search?q=...   -> proxies the YouTube Data API (keeps your API key off the phone)
 *   GET /api/yt?url=...     -> downloads the video's audio with yt-dlp and returns it as MP3
 *   GET /health             -> status check
 */

const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT || '10000', 10);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const MAX_DURATION_SEC = parseInt(process.env.MAX_DURATION_SEC || '900', 10); // 15 min
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '150000', 10);
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || 'node'; // set to "none" to disable
const PROXY = process.env.YT_PROXY || '';
const AUTO_UPDATE = process.env.AUTO_UPDATE_YTDLP !== '0';

const COOKIE_PATH = path.join(os.tmpdir(), 'yt-cookies.txt');
let hasCookies = false;
let ytdlpVersion = 'unknown';
let activeJobs = 0;

// ---------------------------------------------------------------- helpers
function setupCookies() {
  try {
    if (process.env.YT_COOKIES && process.env.YT_COOKIES.trim()) {
      fs.writeFileSync(COOKIE_PATH, process.env.YT_COOKIES, { mode: 0o600 });
      hasCookies = true;
    } else if (fs.existsSync('/etc/secrets/cookies.txt')) {
      // Render "Secret File" is read-only, yt-dlp wants to write to it, so use a copy
      fs.copyFileSync('/etc/secrets/cookies.txt', COOKIE_PATH);
      fs.chmodSync(COOKIE_PATH, 0o600);
      hasCookies = true;
    }
  } catch (err) {
    console.error('Cookie setup failed:', err.message);
  }
}

function refreshVersion() {
  execFile('yt-dlp', ['--version'], (err, stdout) => {
    if (!err) ytdlpVersion = String(stdout).trim();
  });
}

// YouTube changes often; keep yt-dlp fresh on every boot (runs in the background)
function updateYtDlp() {
  if (!AUTO_UPDATE) {
    refreshVersion();
    return;
  }
  execFile(
    'pip3',
    ['install', '-U', '--break-system-packages', '--no-cache-dir', 'yt-dlp[default]'],
    { timeout: 180000 },
    (err) => {
      if (err) console.error('yt-dlp update skipped:', err.message);
      refreshVersion();
    }
  );
}

// Accepts watch / youtu.be / shorts / embed / live links and returns the 11-char video id
function extractVideoId(input) {
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    let id = null;
    if (host === 'youtu.be') {
      id = u.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch') {
        id = u.searchParams.get('v');
      } else {
        const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
        if (m) id = m[1];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch (err) {
    return null;
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(ip, fresh);
      else hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    arr.push(now);
    hits.set(req.ip, arr);
    next();
  };
}

// ---------------------------------------------------------------- yt-dlp
function runYtDlp(videoId, workDir, onSpawn) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--newline',
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '2',
      '--match-filter', 'duration<=' + MAX_DURATION_SEC,
      '--max-filesize', '80M',
      '--write-info-json',
      '--socket-timeout', '20',
      '--retries', '3',
      '-o', path.join(workDir, 'audio.%(ext)s'),
    ];
    if (JS_RUNTIME && JS_RUNTIME !== 'none') args.push('--js-runtimes', JS_RUNTIME);
    if (hasCookies) args.push('--cookies', COOKIE_PATH);
    if (PROXY) args.push('--proxy', PROXY);
    args.push('--', 'https://www.youtube.com/watch?v=' + videoId);

    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(child);

    let out = '';
    let timedOut = false;
    const collect = (d) => {
      out += d.toString();
      if (out.length > 20000) out = out.slice(-20000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DOWNLOAD_TIMEOUT_MS);

    child.on('error', () => {
      clearTimeout(timer);
      reject(httpError(500, 'yt-dlp is not available on the server.'));
    });

    child.on('close', async () => {
      clearTimeout(timer);
      const file = path.join(workDir, 'audio.mp3');

      if (fs.existsSync(file)) {
        let title = 'youtube_audio';
        try {
          const info = JSON.parse(await fsp.readFile(path.join(workDir, 'audio.info.json'), 'utf8'));
          if (info && info.title) title = String(info.title);
        } catch (err) {}
        return resolve({ file, title });
      }

      console.error('yt-dlp failed for ' + videoId + ':\n' + out);

      if (timedOut) return reject(httpError(504, 'Download took too long. Try a shorter video.'));
      if (/does not pass filter/i.test(out)) {
        return reject(httpError(422, 'Video is longer than ' + Math.round(MAX_DURATION_SEC / 60) + ' minutes.'));
      }
      if (/sign in to confirm|not a bot|cookies/i.test(out)) {
        return reject(httpError(502, 'YouTube is blocking this server (bot check). Add a cookies file or proxy, see README.'));
      }
      if (/private video|unavailable|been removed|not available|copyright/i.test(out)) {
        return reject(httpError(404, 'This video is unavailable.'));
      }
      if (/larger than max-filesize/i.test(out)) {
        return reject(httpError(422, 'This video is too large.'));
      }
      reject(httpError(502, 'Could not download audio for this video.'));
    });
  });
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Title');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => {
  res.type('text/plain').send('Ringtone Maker backend is running.');
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ytdlp: ytdlpVersion,
    cookies: hasCookies,
    searchConfigured: !!YOUTUBE_API_KEY,
  });
});

// ---- search (cached, because every YouTube search costs 100 quota units of the free 10,000/day)
const searchCache = new Map();
const SEARCH_TTL_MS = 10 * 60 * 1000;

app.get('/api/search', rateLimit(60, 60 * 1000), async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ items: [] });
  if (!YOUTUBE_API_KEY) return res.status(500).json({ items: [], error: 'YOUTUBE_API_KEY is not set on the server.' });

  const cacheKey = q.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.t < SEARCH_TTL_MS) return res.json(cached.data);

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      maxResults: '5',
      type: 'video',
      q: q,
      key: YOUTUBE_API_KEY,
    });
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?' + params.toString());
    const data = await r.json();
    if (!r.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : 'YouTube search failed.';
      return res.status(502).json({ items: [], error: msg });
    }
    if (searchCache.size >= 200) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(cacheKey, { t: Date.now(), data: data });
    res.json(data);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(502).json({ items: [], error: 'YouTube search failed.' });
  }
});

// ---- audio download
app.get('/api/yt', rateLimit(10, 60 * 1000), async (req, res) => {
  const videoId = extractVideoId(String(req.query.url || ''));
  if (!videoId) return res.status(400).json({ error: 'Please provide a valid YouTube link.' });
  if (activeJobs >= MAX_CONCURRENT) return res.status(429).json({ error: 'Server is busy. Try again in a moment.' });

  activeJobs++;
  let released = false;
  let workDir = null;
  let child = null;

  const release = () => {
    if (!released) {
      released = true;
      activeJobs--;
    }
    if (workDir) fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  };

  // Fires when the response finishes OR the client disconnects
  res.on('close', () => {
    if (child && !res.writableFinished) child.kill('SIGKILL');
    release();
  });

  try {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rt-'));
    const result = await runYtDlp(videoId, workDir, (c) => { child = c; });
    if (res.destroyed) return;

    const stat = await fsp.stat(result.file);
    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Title', encodeURIComponent(result.title.slice(0, 80)));
    fs.createReadStream(result.file)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch (err) {
    console.error('Request failed:', err.message);
    if (!res.headersSent && !res.destroyed) {
      res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
    }
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

setupCookies();
updateYtDlp();
app.listen(PORT, '0.0.0.0', () => {
  console.log('Ringtone backend listening on port ' + PORT);
});
