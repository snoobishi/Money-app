const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const MANAGER_USERNAME = process.env.MANAGER_USERNAME || "Elzakaryg";
const MANAGER_EMAIL = process.env.MANAGER_EMAIL || "elzakaryg@gmail.com";
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_FILES = new Set(["/", "/index.html", "/styles.css", "/app.js"]);

const milestones = [
  { clicks: 150000, reward: 15 },
  { clicks: 200000, reward: 20 },
  { clicks: 1000000, reward: 100 }
];

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = loadDb();
const sessions = new Map();

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: {}, claims: [] };
  }

  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function isManager(user) {
  return user.username === MANAGER_USERNAME && normalize(user.email) === normalize(MANAGER_EMAIL);
}

function getUnlockedReward(user) {
  return milestones.reduce((best, milestone) => {
    return user.clicks >= milestone.clicks ? milestone.reward : best;
  }, 0);
}

function publicUser(user) {
  return {
    username: user.username,
    email: user.email,
    clicks: user.clicks,
    isManager: isManager(user)
  };
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(data));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").filter(Boolean).map((cookie) => {
    const [key, ...value] = cookie.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  const usernameKey = sessions.get(sid);
  return usernameKey ? db.users[usernameKey] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) {
        reject(new Error("Request too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
  });
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;

  if (!PUBLIC_FILES.has(requestPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const filePath = path.join(__dirname, requestPath.replace("/", ""));
  const ext = path.extname(filePath);
  const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";

  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/session") {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: "Not logged in." });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && req.url === "/api/register") {
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const key = normalize(username);

      if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
        return sendJson(res, 400, { error: "Username must be 3-32 letters, numbers, dashes, or underscores." });
      }
      if (!email.toLowerCase().endsWith("@gmail.com")) {
        return sendJson(res, 400, { error: "Please register with a Gmail address." });
      }
      if (password.length < 6) {
        return sendJson(res, 400, { error: "Password must be at least 6 characters." });
      }
      if (db.users[key]) {
        return sendJson(res, 409, { error: "That username already exists." });
      }

      db.users[key] = {
        username,
        email,
        passwordHash: hashPassword(password),
        clicks: 0,
        lastClickAt: 0,
        autoClickLevel: 0,
        clickMultiplier: 1
      };
      saveDb();

      const sid = crypto.randomBytes(32).toString("hex");
      sessions.set(sid, key);
      return sendJson(res, 201, { user: publicUser(db.users[key]) }, {
        "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
      });
    }

    if (req.method === "POST" && req.url === "/api/login") {
      const body = await readBody(req);
      const key = normalize(body.username);
      const user = db.users[key];

      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
        return sendJson(res, 401, { error: "Wrong username or password." });
      }

      const sid = crypto.randomBytes(32).toString("hex");
      sessions.set(sid, key);
      return sendJson(res, 200, { user: publicUser(user) }, {
        "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
      });
    }

    if (req.method === "POST" && req.url === "/api/logout") {
      const sid = parseCookies(req).sid;
      sessions.delete(sid);
      return sendJson(res, 200, { ok: true }, {
        "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
    }

    if (req.method === "POST" && req.url === "/api/click") {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: "Please login first." });

      const now = Date.now();
      if (now - user.lastClickAt < 65) {
        return sendJson(res, 429, { error: "Click a little slower." });
      }

      const multiplier = user.clickMultiplier || 1;
      user.clicks += multiplier;
      user.lastClickAt = now;
      saveDb();
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && req.url === "/api/autoclick") {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: "Please login first." });

      const body = await readBody(req);
      const amount = Number(body.amount || 0);

      if (amount > 0 && (user.autoClickLevel || 0) > 0) {
        user.clicks += amount;
        saveDb();
      }
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (req.method === "POST" && req.url === "/api/claims") {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: "Please login first." });

      const reward = getUnlockedReward(user);
      const body = await readBody(req);
      const walletType = String(body.walletType || "").trim();
      const walletAddress = String(body.walletAddress || "").trim();

      if (reward === 0) return sendJson(res, 400, { error: "Reach 150,000 clicks before requesting a transfer." });
      if (!walletType || !walletType.match(/^(Binance|Google Pay)$/)) return sendJson(res, 400, { error: "Choose Binance or Google Pay." });
      
      // Google Pay accepts phone numbers (7+ chars), Binance needs longer addresses (8+ chars)
      const minLength = walletType === "Google Pay" ? 7 : 8;
      if (walletAddress.length < minLength) return sendJson(res, 400, { error: `Enter a valid ${walletType} address.` });
      if (db.claims.some((claim) => claim.usernameKey === normalize(user.username) && claim.reward === reward)) {
        return sendJson(res, 409, { error: `You already requested the $${reward} reward.` });
      }

      const claim = {
        id: crypto.randomUUID(),
        usernameKey: normalize(user.username),
        username: user.username,
        reward,
        walletType,
        walletAddress,
        status: "pending_manager_review",
        createdAt: new Date().toISOString()
      };
      db.claims.push(claim);
      saveDb();
      return sendJson(res, 201, { claim, user: publicUser(user) });
    }

    if (req.method === "GET" && req.url === "/api/manager") {
      const user = currentUser(req);
      if (!user || !isManager(user)) return sendJson(res, 403, { error: "Manager access only." });

      return sendJson(res, 200, {
        users: Object.values(db.users)
          .sort((a, b) => b.clicks - a.clicks)
          .map((storedUser) => ({
            ...publicUser(storedUser),
            reward: getUnlockedReward(storedUser)
          })),
        claims: db.claims
      });
    }

    if (req.method === "POST" && req.url === "/api/upgrade") {
      const user = currentUser(req);
      if (!user) return sendJson(res, 401, { error: "Please login first." });

      const body = await readBody(req);
      const upgradeId = String(body.upgradeId || "").trim();

      const upgrades = [
        { id: "autoclick1", cost: 5000, type: "autoclick", level: 1 },
        { id: "autoclick2", cost: 10000, type: "autoclick", level: 2 },
        { id: "multiplier2", cost: 50000, type: "multiplier", value: 2 },
        { id: "multiplier4", cost: 75000, type: "multiplier", value: 4 },
        { id: "autoclick10", cost: 99000, type: "autoclick", level: 10 },
        { id: "autoclick15", cost: 1000, type: "autoclick", level: 15, adminOnly: true }
      ];

      const upgrade = upgrades.find((u) => u.id === upgradeId);
      if (!upgrade) return sendJson(res, 400, { error: "Invalid upgrade." });

      // Check if admin-only upgrade and user is not admin
      if (upgrade.adminOnly && !isManager(user)) {
        return sendJson(res, 403, { error: "This upgrade is admin only." });
      }

      if (user[upgradeId]) {
        return sendJson(res, 400, { error: "You already own this upgrade." });
      }

      if (user.clicks < upgrade.cost) {
        return sendJson(res, 400, { error: "Not enough clicks for this upgrade." });
      }

      user.clicks -= upgrade.cost;
      user[upgradeId] = true;

      if (upgrade.type === "autoclick") {
        user.autoClickLevel = (user.autoClickLevel || 0) + upgrade.level;
      } else if (upgrade.type === "multiplier") {
        user.clickMultiplier = (user.clickMultiplier || 1) * upgrade.value;
      }

      saveDb();
      return sendJson(res, 200, { user: publicUser(user) });
    }

    sendJson(res, 404, { error: "API route not found." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error." });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Real Earn Coin running at http://localhost:${PORT}`);
});
