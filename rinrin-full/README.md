# Ringtone Maker: backend + app patch

```
backend/    -> the server (put the CONTENTS of this folder at the root of a new GitHub repo)
frontend/   -> index.html.patch.txt (Find-and-Replace blocks for your index.html)
```

## 1. Put the backend on GitHub
Create a NEW repo (e.g. `ringtone-backend`, separate from Rinrin so your APK workflow is not disturbed).
Upload everything inside `backend/` so `Dockerfile`, `server.js`, `package.json` sit at the repo root.

## 2. Deploy on Render
1. Render dashboard -> New -> Web Service -> connect the repo.
2. Language: **Docker**. Instance type: Free.
3. Environment variable: `YOUTUBE_API_KEY` = your (new, see below) YouTube Data API v3 key.
4. Create Web Service. First build takes a few minutes.
(Alternative: New -> Blueprint and Render reads `render.yaml`.)

## 3. Test it in a browser
- `https://YOUR-SERVICE.onrender.com/health`  -> shows ok, yt-dlp version, searchConfigured true
- `https://YOUR-SERVICE.onrender.com/api/search?q=arijit`
- `https://YOUR-SERVICE.onrender.com/api/yt?url=https://youtu.be/dQw4w9WgXcQ`  -> should download an MP3

## 4. Patch the app
Open `frontend/index.html.patch.txt`, apply each block (OLD ===SPLIT=== NEW, blocks separated by ===BLOCK===) to your index.html,
then replace `YOUR-SERVICE-NAME` in the first block with your real Render subdomain. Rebuild the APK with your usual workflow.

## Things to know
- **Rotate your YouTube API key.** The old one was pasted in plain text; create a new one in Google Cloud and restrict it to "YouTube Data API v3". The new key lives only in Render's env var.
- **Search quota:** each YouTube search costs 100 units of the free 10,000/day (about 100 searches). The backend caches repeated queries for 10 minutes, but the app searches as you type, so consider searching only on Enter if you hit the limit.
- **Free Render sleeps** after ~15 min idle; the first request then takes up to a minute (the app now says so).
- **YouTube may block Render's IPs** with a "confirm you're not a bot" error. Fixes, in order:
  1. Render -> Environment -> Secret Files -> add `cookies.txt` (Netscape format, exported from a browser logged into a throwaway Google account). The server picks it up automatically.
  2. Set `YT_PROXY` to a residential proxy URL.
  3. Redeploy with "Clear build cache" now and then so yt-dlp stays current (it also self-updates on every boot).
- Optional env vars: `MAX_DURATION_SEC` (default 900), `MAX_CONCURRENT` (2), `AUTO_UPDATE_YTDLP=0`, `YTDLP_JS_RUNTIME=none`.
- Downloading from YouTube is against YouTube's Terms of Service; use this only for content you have the right to use.
