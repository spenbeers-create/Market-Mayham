const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  createInitialState,
  joinPlayer,
  handleAction,
  serializeState,
  awardAuction,
  auctionTick,
  ensureAuctionFeed,
  autoAdvanceTimedPhases
} = require("./game/rules");

const publicDir = path.join(__dirname, "public");
const gameDir = path.join(__dirname, "game");
const imagesDir = path.join(__dirname, "images");
const imageCacheDir = path.join(publicDir, "image-cache");
const savePath = path.join(__dirname, "market-mayhem-save.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
let state = createInitialState();
const clients = new Set();
let auctionTimer = null;
let phaseTimer = null;
let manifestCache = null;
let manifestCacheAt = 0;
let addressCache = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function token() {
  return crypto.randomBytes(18).toString("hex");
}

function playerByToken(playerToken) {
  if (!playerToken) return null;
  return state.players.find((player) => player.token === playerToken) || null;
}

function cleanDeviceId(deviceId) {
  return String(deviceId || "").replace(/[<>]/g, "").trim().slice(0, 80);
}

function playerByDeviceId(deviceId) {
  const clean = cleanDeviceId(deviceId);
  if (!clean) return null;
  return state.players.find((player) => player.deviceId === clean) || null;
}

function localAddresses() {
  if (addressCache) return addressCache;
  addressCache = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  return addressCache;
}

function imageManifest() {
  const now = Date.now();
  if (manifestCache && now - manifestCacheAt < 30_000) return manifestCache;
  const manifest = {};
  const sourceDir = fs.existsSync(imageCacheDir) ? imageCacheDir : imagesDir;
  const urlPrefix = sourceDir === imageCacheDir ? "/image-cache" : "/images";
  if (!fs.existsSync(sourceDir)) {
    manifestCache = manifest;
    manifestCacheAt = now;
    return manifest;
  }
  for (const group of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(sourceDir, group.name);
    manifest[group.name] = fs.readdirSync(groupPath, { withFileTypes: true })
      .filter((item) => item.isFile() && [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(item.name).toLowerCase()))
      .map((item) => `${urlPrefix}/${encodeURIComponent(group.name)}/${encodeURIComponent(item.name)}`);
  }
  manifestCache = manifest;
  manifestCacheAt = now;
  return manifestCache;
}

function stateFor(playerId) {
  const view = serializeState(state, playerId);
  view.server = {
    port,
    joinLinks: localAddresses().map((address) => `http://${address}:${port}/player.html`)
  };
  return view;
}

function pruneRuntimeState() {
  state.log = (state.log || []).slice(0, 16);
  state.pendingSellerResponses = (state.pendingSellerResponses || []).slice(-80);
  state.auctions = (state.auctions || [])
    .filter((auction) => auction && (!auction.sold || Date.now() - (auction.soldAt || 0) < 15_000))
    .slice(-16);
  if (state.messages) {
    for (const playerId of Object.keys(state.messages)) {
      state.messages[playerId] = (state.messages[playerId] || []).slice(0, 50);
    }
  }
  if (state.loans) {
    state.loans = state.loans
      .filter((loan) => loan.status === "active" || (state.week || 1) - (loan.collectedWeek || loan.paidWeek || loan.acceptedWeek || state.week || 1) <= 4)
      .slice(-80);
  }
}

function broadcast() {
  pruneRuntimeState();
  ensureAuctionFeed(state);
  const payloads = new Map();
  for (const client of clients) {
    const key = client.playerId || "__host__";
    if (!payloads.has(key)) payloads.set(key, `data: ${JSON.stringify(stateFor(client.playerId))}\n\n`);
    try {
      client.res.write(payloads.get(key));
    } catch (error) {
      clients.delete(client);
    }
  }
}

function scheduleAuctionTimer() {
  if (auctionTimer) clearTimeout(auctionTimer);
  ensureAuctionFeed(state);
  const auctions = (state.auctions && state.auctions.length ? state.auctions : state.auction ? [state.auction] : [])
    .filter((auction) => auction && !auction.sold);
  const times = auctions.flatMap((auction) => [auction.endsAt, auction.nextFakeBidAt]).filter(Boolean);
  if (!times.length) return;
  const delay = Math.max(0, Math.min(...times) - Date.now());
  auctionTimer = setTimeout(() => {
    auctionTick(state);
    broadcast();
    scheduleAuctionTimer();
    schedulePhaseTimer();
  }, delay + 50);
}

function schedulePhaseTimer() {
  if (phaseTimer) clearTimeout(phaseTimer);
  const deadline = state.phase === "actions"
    ? state.actionDeadline
    : state.phase === "bills"
      ? state.billsDeadline
      : null;
  if (!deadline) return;
  const delay = Math.max(0, deadline - Date.now());
  phaseTimer = setTimeout(() => {
    autoAdvanceTimedPhases(state);
    broadcast();
    scheduleAuctionTimer();
    schedulePhaseTimer();
  }, delay + 75);
}

function loadSavedState() {
  const loaded = JSON.parse(fs.readFileSync(savePath, "utf8"));
  loaded.players = (loaded.players || []).map((player) => ({
    ...player,
    token: "",
    deviceId: ""
  }));
  loaded.claimingProfiles = true;
  state = loaded;
  if (auctionTimer) clearTimeout(auctionTimer);
  if (phaseTimer) clearTimeout(phaseTimer);
  scheduleAuctionTimer();
  schedulePhaseTimer();
}

function claimProfile(playerId, playerToken) {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return { ok: false, message: "That saved profile was not found." };
  if (player.token && player.token !== playerToken) return { ok: false, message: "Someone already claimed that profile." };
  const assignedToken = playerToken || token();
  player.token = assignedToken;
  if ((state.players || []).every((item) => item.token)) {
    state.claimingProfiles = false;
  }
  return { ok: true, token: assignedToken, player: { id: player.id, name: player.name } };
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/host.html" : pathname;
  const baseDir = safePath.startsWith("/game/")
    ? gameDir
    : safePath.startsWith("/images/")
      ? imagesDir
      : publicDir;
  const relativePath = safePath.startsWith("/game/")
    ? safePath.replace(/^\/game\//, "/")
    : safePath.startsWith("/images/")
      ? decodeURIComponent(safePath.replace(/^\/images\//, "/"))
      : decodeURIComponent(safePath);
  const filePath = path.normalize(path.join(baseDir, relativePath));

  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const headers = { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" };
    if (safePath.startsWith("/image-cache/")) {
      headers["Cache-Control"] = "public, max-age=86400, immutable";
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    const player = playerByToken(url.searchParams.get("token")) || playerByDeviceId(url.searchParams.get("deviceId"));
    sendJson(res, 200, stateFor(player ? player.id : null));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/images") {
    sendJson(res, 200, { imageManifest: imageManifest() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const player = playerByToken(url.searchParams.get("token")) || playerByDeviceId(url.searchParams.get("deviceId"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const client = { res, playerId: player ? player.id : null };
    clients.add(client);
    res.write(`data: ${JSON.stringify(stateFor(client.playerId))}\n\n`);
    req.on("close", () => clients.delete(client));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const deviceId = cleanDeviceId(payload.deviceId);
      const existing = playerByToken(payload.token) || playerByDeviceId(deviceId);
      if (existing) {
        if (deviceId && !existing.deviceId) existing.deviceId = deviceId;
        if (!existing.token) existing.token = token();
        sendJson(res, 200, { ok: true, token: existing.token, player: { id: existing.id, name: existing.name } });
        return;
      }
      const playerToken = token();
      const result = joinPlayer(state, payload.name, playerToken, payload.avatar, deviceId);
      broadcast();
      sendJson(res, result.ok ? 200 : 400, {
        ok: result.ok,
        message: result.message,
        token: result.player ? result.player.token : null,
        player: result.player ? { id: result.player.id, name: result.player.name } : null
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/claim-profile") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const result = claimProfile(payload.playerId, payload.token || token());
      broadcast();
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/host-action") {
    try {
      const body = await readBody(req);
      const action = JSON.parse(body || "{}");
      if (action.type === "hostResetGame") {
        state = createInitialState();
        if (auctionTimer) clearTimeout(auctionTimer);
        if (phaseTimer) clearTimeout(phaseTimer);
        broadcast();
        sendJson(res, 200, { ok: true });
        return;
      }
      if (action.type === "hostSaveGame") {
        fs.writeFileSync(savePath, JSON.stringify(state, null, 2));
        sendJson(res, 200, { ok: true, message: "Game saved." });
        return;
      }
      if (action.type === "hostLoadGame") {
        if (!fs.existsSync(savePath)) {
          sendJson(res, 404, { ok: false, message: "No saved game yet." });
          return;
        }
        loadSavedState();
        broadcast();
        sendJson(res, 200, { ok: true, message: "Game loaded. Players should claim their saved profiles on their phones." });
        return;
      }
      const result = handleAction(state, { type: action.type, payload: action.payload || {} });
      scheduleAuctionTimer();
      schedulePhaseTimer();
      broadcast();
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/action") {
    try {
      const body = await readBody(req);
      const action = JSON.parse(body || "{}");
      const player = playerByToken(action.token);
      if (!player) {
        sendJson(res, 401, { ok: false, message: "Join the game first." });
        return;
      }
      const result = handleAction(state, {
        type: action.type,
        playerId: player.id,
        payload: action.payload || {}
      });
      scheduleAuctionTimer();
      schedulePhaseTimer();
      broadcast();
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, url.pathname);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(port, host, () => {
  console.log(`Market Mayhem running at http://127.0.0.1:${port}/host.html`);
  for (const address of localAddresses()) {
    console.log(`Same Wi-Fi link: http://${address}:${port}/host.html`);
  }
});
