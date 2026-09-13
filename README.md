# Pixel Race 🏁

A multiplayer browser racing game:

- **3D scene** rendered with [three.js](https://threejs.org/), using your uploaded `race_track.obj`/`.mtl` as the track and a low-poly car model as each player's vehicle.
- **Real-time multiplayer** over a single WebSocket server: create a room, get a **4-digit PIN**, share it, friends join, host starts the race, positions sync live, laps are tracked, results are shown at the end.
- **No database, no build step** — one Node process serves the static client and the WebSocket game server on the same port, which is exactly what Render's free tier wants.

## How it works

```
pixel-race/
├── server.js              # HTTP static file server + WebSocket room/game logic
├── package.json
├── render.yaml             # optional: infra-as-code for Render
└── public/
    ├── index.html          # menu / lobby / race / results screens
    ├── style.css
    ├── game.js              # three.js scene, car physics, networking
    └── models/
        ├── track/race_track.obj + .mtl     (your uploaded track)
        └── car/race.obj + .mtl + Textures/colormap.png  (car model)
```

There is **no build step**. `server.js` only depends on the `ws` package (everything else is Node's built-in `http`/`fs`). The browser loads three.js straight from a CDN via an import map — nothing to bundle.

### Networking protocol (JSON over WebSocket, path `/ws`)

| Client → Server | Server → Client |
|---|---|
| `create {name}` | `created {pin, playerId, players, hostId}` |
| `join {pin, name}` | `joined {pin, playerId, players, hostId}` |
| `leave` | `player_joined / player_left` |
| `start` (host only) | `race_start {startTime, totalLaps}` |
| `state {x,y,z,rotY,speed}` (~14x/sec) | `state_update {players[]}` (~16x/sec) |
| `lap` | `lap_update {id, laps, finished, rank}` |
| `restart` (host only) | `race_finished {results[]}` / `lobby_update` |

### Room rules (already implemented and tested)

- PINs are unique 4-digit codes (`1000`–`9999`), regenerated if collided.
- Max **8 players per room**, max **200 concurrent rooms** on the server (tune the constants at the top of `server.js`).
- A room is deleted automatically **30 seconds** after it becomes empty.
- Any room older than **3 hours** is force-closed as a safety net against abandoned rooms leaking memory on a long-running free instance.
- A dead/disconnected socket is detected via WebSocket ping/pong every 20s and cleaned up even if the browser closed without saying goodbye.
- Malformed messages, NaN/Infinity position values, and unknown message types are all validated and ignored rather than crashing the server (verified with an automated test harness that hammers the server with garbage input).
- Lap submissions are debounced server-side (4s cooldown) so a client can't spam laps.

### Driving controls

- **W/↑** accelerate, **S/↓** brake/reverse, **A/←** and **D/→** steer.
- On touch devices, on-screen buttons appear automatically.
- First to 3 laps (configurable via `TOTAL_LAPS` in `server.js`) wins; a results screen shows the final order, and the host can send everyone back to the lobby to race again.

## Run it locally

```bash
cd pixel-race
npm install
npm start
# open http://localhost:3000 in two browser tabs to test multiplayer
```

## Deploy to Render (free tier)

1. **Push this folder to a GitHub repo** (Render deploys from Git).
   ```bash
   cd pixel-race
   git init
   git add .
   git commit -m "Pixel Race"
   git branch -M main
   git remote add origin https://github.com/<you>/pixel-race.git
   git push -u origin main
   ```

2. **Create the service on Render:**
   - Go to [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
   - Connect your GitHub repo.
   - Render will detect `render.yaml` automatically and pre-fill everything (Node environment, free plan, build/start commands, health check). If it doesn't, set these manually:
     - **Environment**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Instance Type**: `Free`
   - Click **Create Web Service**.

3. **Wait for the build to finish.** Render gives you a URL like `https://pixel-race.onrender.com`. Open it — that's your game, and the same URL is used for both the page and the WebSocket (`wss://pixel-race.onrender.com/ws`), so nothing else to configure.

4. Share the URL with friends. Whoever creates a room gets a 4-digit PIN to hand out.

### Free-tier things worth knowing

- Render's free web services **spin down after ~15 minutes of no traffic** and take ~30–60 seconds to wake back up on the next request. That's fine for a casual game — just warn players the first load after idle time may be slow. (You can ping `/healthz` from an external uptime service if you want to keep it warm, at the cost of using your free hours faster.)
- Free instances run as a **single instance** (no autoscaling) — which is actually required here, since room state lives in memory in one process. Don't switch this to a paid plan with multiple instances without adding shared storage (e.g. Redis) for room state, or players on different instances won't see each other.
- A server restart/redeploy clears all in-memory rooms — anyone mid-race will need to create a new room.

## Customizing

- **Change the car**: the kit you uploaded (`OBJ_format.zip`) has many more vehicles (`sedan.obj`, `suv.obj`, `taxi.obj`, `hatchback-sports.obj`, `police.obj`, etc.), all using the same `Textures/colormap.png`. Swap the files in `public/models/car/` and update the two filenames in `game.js`'s `loadAssets()`.
- **Lap count**: change `TOTAL_LAPS` in `server.js`.
- **Room/player limits**: `MAX_ROOMS` and `MAX_PLAYERS_PER_ROOM` in `server.js`.
- **Car speed/handling**: `MAX_SPEED`, `ACCEL`, `TURN_RATE` etc. at the top of `public/game.js`.
