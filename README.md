# 🎛️ Hope Studio

**Your phone becomes a stream deck for OBS, plus two live games for your stream: a Car Meet Scoreboard and Pit Pass (viewer challenges).**
Free, runs 100% on your own PC and Wi-Fi. No accounts, no cloud, no subscription.

Built for small console streamers (PS5 + capture card + OBS) who can't pay for a Stream Deck or overlay services.

## What it does
| Page | What you get |
|---|---|
| **Deck** (`/`) | Switch OBS scenes, mute mics, Go Live / Record, **🎬 CLIP IT** (saves the OBS replay buffer), a pre-stream check (OBS connected, recording drive, replay buffer), and one-tap vertical 1080x1920 versions of your clips (ffmpeg + NVIDIA NVENC). |
| **Car Meet** (`/meet`) | Run a car meet from your phone: add players + cars, score each car in up to 8 weighted categories, put one car "on stage", reveal the winner with a trophy + confetti on stream. Keeps a Hall of Fame across meets. |
| **Pit Pass** (`/pit`) | Chat requests a card (car / route / challenge, 20 built in, add your own). Fair by design: open to everyone, 1 request per person, max 5 in the queue, 2-minute turns with a live timer, no paid priority. Season stats + shout-outs for regulars. |
| **Overlay** (`/overlay`) | ONE OBS Browser Source that shows the scoreboard, on-stage card, winner reveal, Pit Pass queue + timer and the Hall of Fame. Transparent, works in 16:9 and 9:16. |

## Setup (Windows, 5 minutes)
1. Install [Node.js](https://nodejs.org) 18+ and OBS 28+ (obs-websocket v5 is built in). Optional: ffmpeg for vertical clips.
2. In OBS: **Tools → WebSocket Server Settings → Enable** (keep authentication ON). For CLIP IT: **Settings → Output → Replay Buffer → Enable**.
3. Download this repo and double-click **`start.bat`** (or run `npm install` then `npm start`).
4. Scan the QR code in the window with your phone (same Wi-Fi).
5. In OBS add a **Browser Source** (1920x1080) with the overlay link printed in the window.

Port: `8793` by default, change it with the `PORT` environment variable.

## Security
- Every page and socket needs a random token (created on first run, saved in `token.txt`, which is git-ignored). Without it you get 403.
- LAN only. The OBS password is read locally from OBS's own config file and is never sent to the phone.

## Files
`server.js` (HTTP + WebSocket server, OBS client, clips) · `meet.js` + `meet.html` (Car Meet) · `pitpass.js` + `pit.html` (Pit Pass) ·
`deck.html` (phone deck) · `overlay.html` (OBS overlay). Data is saved next to the app in `meets.json`, `pit.json`, `clips.json`.

## Status
v2, used on my own streams (The Crew Motorfest on PS5). Built with Claude. Issues and ideas welcome.

## License
MIT
