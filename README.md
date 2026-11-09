# LITESHOT V86 Online Rebuild

This package contains the V86 game client and a clean Socket.IO room server.
It replaces the previous online event backend while keeping the existing game, maps, movement, weapons and character customisation.

## Online features in this rebuild

- **Quick Match** finds or creates a public room for the selected map.
- **Private rooms** create a shareable five-character code or join one by code.
- Up to **8 players** per room.
- Players in separate maps never share a lobby.
- Room-specific movement, player appearance, chat, hit messages, kill/death scores and match timer.
- Server-controlled health changes, hit-rate limits, room-specific weapon pickups and respawns.
- Automatic socket reconnect and attempt to rejoin the same room.
- `/health` endpoint for Render monitoring.

**Online co-op/Wipeout is disabled in this first rebuild.** The old Wipeout enemies are created separately by each browser, so simply connecting the players would not create one shared enemy fight. PvP is the online mode rebuilt here.

## Files

- `LITESHOTV86_ONLINE_REBUILD.html`: game client. Upload this to your GitHub Pages repository as `index.html`.
- `server/server.js`: multiplayer server.
- `server/package.json`: server dependency and start command.
- `server/render.yaml`: Render Web Service settings.

## Deploy the new server on Render

The HTML uses `https://liteshot-server.onrender.com` by default, so you can keep that address if you update the existing Render service with this new server.

1. Put the contents of the `server` folder (`server.js`, `package.json`, `render.yaml`) in the root of a GitHub repository for the server.
2. In Render, create a **New Web Service** and connect that repository. Alternatively, update the existing LITESHOT server service only after backing up its old settings and pointing it at the new server files.
3. Use:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
4. Deploy. Visit `https://YOUR-SERVICE.onrender.com/health`. It should return JSON with `"ok":true`.
5. If your server URL is different from `https://liteshot-server.onrender.com`, change `SERVER_URL` near the top of the game script, or set `localStorage.liteshotServerUrl` in the browser to your Render URL.
6. Upload the game HTML to GitHub Pages with the filename `index.html`.

Render's current docs use `npm install` as a typical Node build command and `npm start` as a typical Node start command. The `render.yaml` included here sets the Node runtime and health check path. See [Render Web Services](https://render.com/docs/web-services) and [Render Health Checks](https://render.com/docs/health-checks).

## Local test

```bash
cd server
npm install
npm start
```

Set the game's `SERVER_URL` to `http://localhost:10000` while testing locally.

The client and server both use Socket.IO 4.x. The server package requests Socket.IO 4.8.4; the client loads 4.8.4 from the CDN.
