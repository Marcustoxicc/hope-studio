// 🎛️ HOPE STUDIO: your phone becomes an OBS stream deck + clip factory. NO Claude needed.
//   Start: start.bat (or `npm start`) → scan the QR (or open the printed URL) on the phone (same Wi-Fi).
//   Needs (one time, in OBS): Tools → WebSocket Server Settings → Enable WebSocket server (keep "Enable Authentication" ON)
//                             Settings → Output → Replay Buffer → Enable (for CLIP IT).
//   Security: random token on every request + socket; LAN only; the OBS password is read locally from OBS's own config, never sent to the phone.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const QR = require('qrcode');

const PORT = Number(process.env.PORT) || 8793;
const HERE = __dirname;
const TOKEN_FILE = path.join(HERE, 'token.txt');
const TOKEN = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  : (() => { const t = crypto.randomBytes(9).toString('base64url'); fs.writeFileSync(TOKEN_FILE, t); return t; })();
const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && a.address.startsWith('192.168.'))?.address || '127.0.0.1';
const URL_ = `http://${ip}:${PORT}/?t=${TOKEN}`;
const FFMPEG = (() => {
  const base = path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Packages');
  try {
    for (const d of fs.readdirSync(base).filter((x) => /FFmpeg/i.test(x))) {
      const stack = [path.join(base, d)];
      while (stack.length) { const p = stack.pop(); for (const f of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, f.name); if (f.isDirectory()) stack.push(fp); else if (f.name.toLowerCase() === 'ffmpeg.exe') return fp; } }
    }
  } catch {}
  return 'ffmpeg';
})();
const OBS_CFG = path.join(process.env.APPDATA, 'obs-studio/plugin_config/obs-websocket/config.json');
const VERT_DIR = path.join(HERE, 'clips');
fs.mkdirSync(VERT_DIR, { recursive: true });

// ---------- OBS WebSocket v5 client ----------
let obs = null, obsReady = false, reqId = 0, pending = new Map(), lastErr = 'not connected yet';
const state = { scenes: [], current: '', streaming: false, recording: false, replay: false, mics: [], streamStart: 0, clips: [] };
function obsCfg() { try { return JSON.parse(fs.readFileSync(OBS_CFG, 'utf8')); } catch { return {}; } }
function connectObs() {
  if (obs) return;
  const cfg = obsCfg();
  obs = new WebSocket(`ws://127.0.0.1:${cfg.server_port || 4455}`);
  obs.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.op === 0) { // Hello
      const ident = { rpcVersion: 1, eventSubscriptions: (1 << 0) | (1 << 2) | (1 << 3) | (1 << 6) | (1 << 7) }; // General, Scenes, Inputs, Outputs
      if (m.d.authentication) {
        const pw = obsCfg().server_password || '';
        const secret = crypto.createHash('sha256').update(pw + m.d.authentication.salt).digest('base64');
        ident.authentication = crypto.createHash('sha256').update(secret + m.d.authentication.challenge).digest('base64');
      }
      obs.send(JSON.stringify({ op: 1, d: ident }));
    } else if (m.op === 2) { obsReady = true; lastErr = ''; refresh(); }
    else if (m.op === 7) { const p = pending.get(m.d.requestId); if (p) { pending.delete(m.d.requestId); p(m.d); } }
    else if (m.op === 5) onEvent(m.d.eventType, m.d.eventData || {});
  });
  obs.on('close', (code, reason) => {
    obsReady = false; obs = null;
    lastErr = code === 4009 ? 'OBS password mismatch (re-open Hope Studio after changing it)' : 'OBS is closed or its WebSocket server is OFF';
    broadcast(); setTimeout(connectObs, 3000);
  });
  obs.on('error', () => {});
}
function call(requestType, requestData = {}) {
  return new Promise((res) => {
    if (!obsReady) return res({ requestStatus: { result: false, comment: lastErr } });
    const id = String(++reqId); pending.set(id, res);
    obs.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData } }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ requestStatus: { result: false, comment: 'timeout' } }); } }, 5000);
  });
}
// ---------- v2: ONE-TAP PREFLIGHT (fields verified vs obs-websocket v5 protocol.md, Nov 7) ----------
async function preflight() {
  const items = []; const add = (ok, label, detail) => items.push({ ok, label, detail });
  if (!obsReady) { add(false, 'OBS connection', lastErr || 'OBS not connected'); state.preflight = { at: Date.now(), items }; return broadcast(); }
  add(true, 'OBS connection', 'connected');
  const st = (await call('GetStats')).responseData || {};
  const fps = Math.round(st.activeFps || 0);
  add(fps >= 58, 'OBS frame rate', `${fps} fps${fps < 58 ? ' (should be ~60: close heavy apps or lower the game settings)' : ''}`);
  const skipPct = st.renderTotalFrames ? (st.renderSkippedFrames / st.renderTotalFrames) * 100 : 0;
  add(skipPct < 0.5, 'Render lag', `${skipPct.toFixed(2)}% frames skipped${skipPct >= 0.5 ? ' (GPU overloaded: cap the game at 60 fps)' : ''}`);
  add((st.cpuUsage || 0) < 80, 'CPU', `${Math.round(st.cpuUsage || 0)}% used by OBS`);
  const gb = (st.availableDiskSpace || 0) / 1024;
  add(gb >= 50, 'Recording space', `${gb.toFixed(0)} GB free on the recording drive (~${Math.round(gb * 1024 / 520)} min of 4K)`);
  const dir = (await call('GetRecordDirectory')).responseData?.recordDirectory || '';
  add(!/^c:/i.test(dir), 'Recording folder', dir ? `${dir}${/^c:/i.test(dir) ? ' → C: is nearly full. OBS Settings → Output → Recording Path → D:\\Recordings' : ''}` : 'unknown');
  const inputs = (await call('GetInputList')).responseData?.inputs || [];
  const cams = inputs.filter((i) => /dshow|av_capture|video_capture/i.test(i.inputKind) || /elgato|capture/i.test(i.inputName));
  let camLive = null;
  for (const c of cams) { const a = (await call('GetSourceActive', { sourceName: c.inputName })).responseData; if (a?.videoActive) { camLive = c.inputName; break; } }
  add(!!camLive, 'Game capture (Elgato)', camLive ? `"${camLive}" is live in the current scene` : cams.length ? `found ${cams.map((c) => '"' + c.inputName + '"').join(', ')} but none is live in this scene` : 'no capture source found: add Video Capture Device → Elgato 4K Pro');
  const mics = inputs.filter((i) => /wasapi_input|input_capture/i.test(i.inputKind));
  if (!mics.length) add(false, 'Mic', 'no mic source in OBS: add Audio Input Capture → fifine');
  for (const m of mics) {
    const mu = (await call('GetInputMute', { inputName: m.inputName })).responseData?.inputMuted;
    const v = (await call('GetInputVolume', { inputName: m.inputName })).responseData?.inputVolumeDb;
    add(!mu && v > -30, `Mic: ${m.inputName}`, mu ? 'MUTED' : v <= -30 ? `volume slider very low (${Math.round(v)} dB)` : `on, slider ${Math.round(v)} dB`);
  }
  let rb = (await call('GetReplayBufferStatus'));
  if (rb.requestStatus?.result === false) add(false, 'Replay buffer (CLIP IT)', 'off in OBS settings: Settings → Output → Replay Buffer → Enable');
  else if (!rb.responseData?.outputActive) { const s = await call('StartReplayBuffer'); add(s.requestStatus?.result !== false, 'Replay buffer (CLIP IT)', s.requestStatus?.result !== false ? 'was off → turned ON' : 'could not start: ' + (s.requestStatus?.comment || '')); }
  else add(true, 'Replay buffer (CLIP IT)', 'on');
  const ss = (await call('GetStreamStatus')).responseData;
  if (ss?.outputActive) { const d = ss.outputTotalFrames ? ss.outputSkippedFrames / ss.outputTotalFrames * 100 : 0; add(d < 1 && (ss.outputCongestion || 0) < 0.2, 'Live connection', `${d.toFixed(2)}% dropped, congestion ${Math.round((ss.outputCongestion || 0) * 100)}%`); }
  state.preflight = { at: Date.now(), items, pass: items.every((i) => i.ok) };
  broadcast(); refresh();
}
async function refresh() {
  if (!obsReady) return broadcast();
  const sc = await call('GetSceneList');
  if (sc.responseData) { state.scenes = sc.responseData.scenes.map((s) => s.sceneName).reverse(); state.current = sc.responseData.currentProgramSceneName; }
  const st = await call('GetStreamStatus'); state.streaming = !!st.responseData?.outputActive;
  if (state.streaming && !state.streamStart) state.streamStart = Date.now() - (st.responseData.outputDuration || 0);
  if (!state.streaming) state.streamStart = 0;
  const rc = await call('GetRecordStatus'); state.recording = !!rc.responseData?.outputActive;
  const rb = await call('GetReplayBufferStatus'); state.replay = !!rb.responseData?.outputActive; state.replayAvailable = rb.requestStatus?.result !== false;
  const inputs = await call('GetInputList');
  const mics = [];
  for (const i of inputs.responseData?.inputs || []) {
    if (!/input_capture|wasapi_output|dshow/.test(i.inputKind)) continue;
    const mu = await call('GetInputMute', { inputName: i.inputName });
    if (mu.responseData) mics.push({ name: i.inputName, muted: mu.responseData.inputMuted });
  }
  state.mics = mics;
  broadcast();
}
function onEvent(type, d) {
  if (type === 'CurrentProgramSceneChanged') state.current = d.sceneName;
  else if (type === 'StreamStateChanged') { state.streaming = d.outputActive; state.streamStart = d.outputActive ? Date.now() : 0; }
  else if (type === 'RecordStateChanged') state.recording = d.outputActive;
  else if (type === 'ReplayBufferStateChanged') state.replay = d.outputActive;
  else if (type === 'InputMuteStateChanged') { const m = state.mics.find((x) => x.name === d.inputName); if (m) m.muted = d.inputMuted; }
  else if (type === 'ReplayBufferSaved') { addClip(d.savedReplayPath); toast(`🎬 Clip saved: ${path.basename(d.savedReplayPath)}`); }
  else if (/Scene(Created|Removed|NameChanged)|InputCreated|InputRemoved/.test(type)) return refresh();
  broadcast();
}

// ---------- clips ----------
const CLIPS_FILE = path.join(HERE, 'clips.json');
try { state.clips = JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf8')); } catch { state.clips = []; }
function saveClips() { fs.writeFileSync(CLIPS_FILE, JSON.stringify(state.clips, null, 1)); }
function addClip(p) { state.clips.unshift({ id: crypto.randomBytes(4).toString('hex'), src: p, at: Date.now(), vertical: null, busy: false }); state.clips = state.clips.slice(0, 60); saveClips(); }
function makeVertical(clip, mode) {
  if (!fs.existsSync(clip.src)) { clip.err = 'original file is gone'; return broadcast(); }
  clip.busy = true; clip.err = ''; broadcast();
  const out = path.join(VERT_DIR, path.basename(clip.src).replace(/\.[^.]+$/, '') + `_vertical_${mode}.mp4`);
  const vf = mode === 'crop'
    ? ['-vf', 'scale=-2:1920,crop=1080:1920']
    : ['-filter_complex', '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]', '-map', '[v]', '-map', '0:a?'];
  const args = ['-y', '-i', clip.src, ...vf, '-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21', '-r', '60', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let errTail = ''; p.stderr.on('data', (b) => { errTail = (errTail + b).slice(-400); });
  p.on('close', (code) => {
    clip.busy = false;
    if (code === 0) { clip.vertical = out; toast('📱 Vertical clip ready'); } else clip.err = 'ffmpeg failed: ' + errTail.split('\n').filter(Boolean).pop();
    saveClips(); broadcast();
  });
}

// ---------- web + phone socket ----------
const page = fs.readFileSync(path.join(HERE, 'deck.html'), 'utf8');
const MEET = require('./meet.js');
const PIT = require('./pitpass.js');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('t') !== TOKEN) { res.writeHead(403); return res.end('Hope Studio: open the link from the QR code.'); }
  if (u.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page); }
  if (u.pathname === '/pit') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(HERE, 'pit.html'), 'utf8')); }
  if (u.pathname === '/meet' || u.pathname === '/overlay') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(HERE, u.pathname === '/meet' ? 'meet.html' : 'overlay.html'), 'utf8'));
  }
  if (u.pathname === '/clip') {
    const c = state.clips.find((x) => x.id === u.searchParams.get('id'));
    const f = c && (u.searchParams.get('v') === '1' ? c.vertical : c.src);
    if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    const size = fs.statSync(f).size, range = req.headers.range;
    const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename="${path.basename(f)}"` };
    if (range) {
      const [a, b] = range.replace('bytes=', '').split('-'); const start = +a, end = b ? +b : size - 1;
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': size }); return fs.createReadStream(f).pipe(res);
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, verifyClient: (info) => new URL(info.req.url, 'http://x').searchParams.get('t') === TOKEN });
let toasts = [];
function toast(t) { toasts.push({ t, at: Date.now() }); toasts = toasts.slice(-5); broadcast(); }
function snapshot() {
  return JSON.stringify({ obsReady, lastErr, ...state, clips: state.clips.slice(0, 25).map((c) => ({ id: c.id, name: path.basename(c.src), at: c.at, vertical: !!c.vertical, busy: c.busy, err: c.err })), toasts, now: Date.now(), ...MEET.view(), ...PIT.view() });
}
function broadcast() { const s = snapshot(); wss.clients.forEach((c) => c.readyState === 1 && c.send(s)); }
wss.on('connection', (ws) => {
  ws.send(snapshot());
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = (x) => { if (x?.requestStatus?.result === false) toast('⚠️ ' + (x.requestStatus.comment || 'OBS said no')); };
    switch (m.a) {
      case 'scene': if (state.scenes.includes(m.v)) r(await call('SetCurrentProgramScene', { sceneName: m.v })); break;
      case 'mute': if (state.mics.some((x) => x.name === m.v)) r(await call('ToggleInputMute', { inputName: m.v })); break;
      case 'stream': r(await call(state.streaming ? 'StopStream' : 'StartStream')); break;
      case 'record': r(await call(state.recording ? 'StopRecord' : 'StartRecord')); break;
      case 'replay': r(await call(state.replay ? 'StopReplayBuffer' : 'StartReplayBuffer')); break;
      case 'clipit': {
        if (!state.replay) { const s = await call('StartReplayBuffer'); if (s.requestStatus?.result === false) { r(s); break; } toast('Replay buffer was off → turned it ON. Next CLIP IT will save.'); break; }
        r(await call('SaveReplayBuffer')); break;
      }
      case 'vertical': { const c = state.clips.find((x) => x.id === m.id); if (c && !c.busy) makeVertical(c, m.mode === 'crop' ? 'crop' : 'blur'); break; }
      case 'folder': spawn('explorer.exe', [VERT_DIR], { detached: true }); break;
      case 'preflight': preflight(); break;
      case 'refresh': refresh(); break;
      default:
        if (typeof m.a === 'string' && m.a.startsWith('meet:') && MEET.handle(m)) broadcast();
        else if (typeof m.a === 'string' && m.a.startsWith('pit:')) { const r = PIT.handle(m); if (r.err) toast('⚠️ ' + r.err); else { broadcast(); if (m.a === 'pit:verdict') setTimeout(broadcast, 6200); } }
    }
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`\n  ⚠️ Port ${PORT} is already in use (Hope Studio already open in another window, or another app took it).\n  Close the other window, or restart the PC, then open Hope Studio again.\n`);
  else console.log('Hope Studio error:', e.message);
});
server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n  🎛️  HOPE STUDIO is running');
  console.log('  Phone (same Wi-Fi): ' + URL_);
  try { console.log(await QR.toString(URL_, { type: 'terminal', small: true })); await QR.toFile(path.join(HERE, 'qr.png'), URL_); } catch {}
  console.log('  🏁 Car Meet on the phone:  ' + URL_.replace('/?', '/meet?'));
  console.log('  🎟️ Pit Pass on the phone:  ' + URL_.replace('/?', '/pit?'));
  console.log('  🏁 OBS Browser Source (1920x1080, overlay):  http://127.0.0.1:' + PORT + '/overlay?t=' + TOKEN);
  try { fs.writeFileSync(path.join(HERE, 'OBS_OVERLAY_URL.txt'), 'http://127.0.0.1:' + PORT + '/overlay?t=' + TOKEN + '\n'); } catch {}
  console.log('  Keep this window open while you stream. Close it to stop.\n');
  connectObs();
  setInterval(() => obsReady && refresh(), 15000);
});
