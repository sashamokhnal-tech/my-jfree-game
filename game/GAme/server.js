const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
// server.js — leaderboard with 30‑day reset + Telegram auth (America/Los_Angeles)
const express = require('express');
const { DateTime } = require('luxon');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// === Persistent Disk support ===
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_PATH = path.join(DATA_DIR, 'leaderboard.json');

function ensureLeaderboard() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      fs.writeFileSync(DATA_PATH, JSON.stringify({ updatedAt: Date.now(), scores: [] }, null, 2));
    }
  } catch (e) {
    console.error('Failed to init leaderboard file:', e);
  }
}
ensureLeaderboard();


const app = express();
app.use(compression());
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
const PORT = process.env.PORT || 3000;
let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let CFG_TZ = process.env.TIME_ZONE || '';
try{
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
  TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKEN || cfg.TELEGRAM_BOT_TOKEN || cfg.telegram_bot_token || '';
  CFG_TZ = CFG_TZ || cfg.TIME_ZONE || cfg.time_zone || '';
}catch(e){}
const TIME_ZONE = CFG_TZ || 'America/Los_Angeles';

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DATA_PATH = path.join(__dirname, 'leaderboard.json');

function loadData(){
  try { return JSON.parse(fs.readFileSync(DATA_PATH,'utf8')); }
  catch(e){ return { users:{}, scores:{}, lastReset:null, sessions:{} }; }
}
function saveData(obj){ fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2), 'utf8'); }

// === 30-day rolling reset ===
function ensure30DayBucket(data){
  const now = DateTime.now().setZone(TIME_ZONE);
  const nowISO = now.toISO();
  if (!data.lastReset) {
    data.lastReset = nowISO;
    if (!data.scores) data.scores = {};
    data.scores['active'] = {}; // current 30‑day bucket
    saveData(data);
    return;
  }
  const last = DateTime.fromISO(data.lastReset).setZone(TIME_ZONE);
  const diffDays = now.diff(last, 'days').days;
  if (diffDays >= 30) {
    data.lastReset = nowISO;
    data.scores['active'] = {}; // wipe scores
    saveData(data);
  }
}

// === Telegram auth verification (per docs) ===

function requireAuth(req,res,next){
  const auth = req.get('authorization')||'';
  const m = auth.match(/^Bearer\s+([A-Za-z0-9_-]{16,})$/);
  if (!m) return res.status(401).json({error:'Unauthorized'});
  const token = m[1];
  const data = loadData();
  const sess = data.sessions && data.sessions[token];
  if (!sess) return res.status(401).json({error:'Invalid session'});
  req.user = sess;
  next();
}

// === Routes ===
    const data = loadData(); ensure30DayBucket(data);
    const tgId = String(user.id);
    const username = user.username ? `@${user.username}` : (user.first_name || 'Player');
    // upsert user
    data.users[tgId] = { id: tgId, username, first_name: user.first_name||'', last_name: user.last_name||'' };
    // create short-lived token (rotate every login)
    const token = crypto.randomBytes(24).toString('base64url');
    if (!data.sessions) data.sessions = {};
    data.sessions[token] = { id: tgId, username };
    saveData(data);
    res.json({ ok:true, token, username });
  }catch(e){
    res.status(500).json({error:'server'});
  }
});


app.post('/api/guest_login', (req,res)=>{
  try{
    const { username } = req.body || {};
    let name = (username||'').toString().trim();
    if (!name) return res.status(400).json({error:'username required'});
    if (name.length > 24) name = name.slice(0,24);
    const data = loadData(); ensure30DayBucket(data);
    // Create or get user by normalized name (case-insensitive)
    const norm = name.toLowerCase();
    if (!data.usernames) data.usernames = {}; // map norm -> id
    let uid = data.usernames[norm];
    if (!uid) {
      uid = crypto.randomUUID();
      data.usernames[norm] = uid;
      data.users[uid] = { id: uid, username: name };
    } else {
      // update display name in case of changes
      data.users[uid] = { id: uid, username: name };
    }
    // issue a session token
    const token = crypto.randomBytes(24).toString('base64url');
    if (!data.sessions) data.sessions = {};
    data.sessions[token] = { id: uid, username: name };
    saveData(data);
    res.json({ ok:true, token, username: name, user_id: uid });
  }catch(e){
    console.error(e);
    res.status(500).json({error:'server'});
  }
});

// === Wallet-based unique login (Solana) ===

// Issue a one-time nonce for address
app.get('/api/nonce', (req, res)=>{
  try{
    const address = (req.query.address||'').toString();
    if(!address) return res.status(400).json({error:'address required'});
    const data = loadData(); ensure30DayBucket(data);
    if (!data.nonces) data.nonces = {};
    const nonce = crypto.randomBytes(24).toString('base64url');
    data.nonces[address] = { nonce, ts: Date.now() };
    saveData(data);
    res.json({ ok:true, nonce });
  }catch(e){
    console.error(e); res.status(500).json({error:'server'});
  }
});

// Verify signature and create session
app.post('/api/wallet_login', (req, res)=>{
  try{
    const { address, signature, nonce } = req.body || {};
    if (!address || !signature || !nonce) return res.status(400).json({error:'bad request'});
    const data = loadData(); ensure30DayBucket(data);
    if (!data.nonces || !data.nonces[address] || data.nonces[address].nonce !== nonce) {
      return res.status(401).json({error:'nonce mismatch'});
    }
    // Verify ed25519 signature of message `${address}:${nonce}` using Solana base58 pubkey (address)
    const message = Buffer.from(`${address}:${nonce}`);
    let pubKeyBytes;
    try{
      pubKeyBytes = bs58.decode(address);
    }catch(e){
      return res.status(400).json({error:'invalid address'});
    }
    let sigBytes;
    try{
      sigBytes = bs58.decode(signature);
    }catch(e){
      return res.status(400).json({error:'invalid signature'});
    }
    const ok = nacl.sign.detached.verify(new Uint8Array(message), new Uint8Array(sigBytes), new Uint8Array(pubKeyBytes));
    if (!ok) return res.status(401).json({error:'signature verify failed'});

    // Passed: upsert user by address
    if (!data.users[address]) data.users[address] = { id: address, username: address };
    // Issue session token
    const token = crypto.randomBytes(24).toString('base64url');
    if (!data.sessions) data.sessions = {};
    data.sessions[token] = { id: address, username: address };
    // Consume nonce
    delete data.nonces[address];
    saveData(data);
    res.json({ ok:true, token, user_id: address, username: address });
  }catch(e){
    console.error(e); res.status(500).json({error:'server'});
  }
});
app.post('/api/submit', requireAuth, (req,res)=>{
  const { score, duration_ms } = req.body || {};
  if (!Number.isFinite(score)) return res.status(400).json({error:'score required'});
  // Anti-cheat
  const MIN_MS_PER_POINT = Number(process.env.MIN_MS_PER_POINT || 30);
  const MAX_RATE_MS = Number(process.env.MAX_SUBMIT_RATE_MS || 3000);
  const now = Date.now();
  if (!Number.isFinite(duration_ms) || duration_ms < score * MIN_MS_PER_POINT){
    return res.status(400).json({error:'invalid duration'});
  }
  const token = (req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
  const last = submitLimiter.get(token) || 0;
  if (now - last < MAX_RATE_MS) return res.status(429).json({error:'too fast'});
  submitLimiter.set(token, now);

  const data = loadData(); ensure30DayBucket(data);
  const bucket = data.scores['active'] || (data.scores['active'] = {});
  const uid = req.user.id;
  const profile = data.users[uid] || { id: uid, username: req.user.username, display_name: '' };
  const name = profile.display_name || profile.username;
  const best = bucket[name] || 0;
  if (score > best) bucket[name] = score;
  saveData(data);
  res.json({ ok:true, best: bucket[name] });
});

app.get('/api/leaderboard', (req,res)=>{
  const data = loadData(); ensure30DayBucket(data);
  const entries = Object.entries(data.scores['active'] || {}).map(([username, score])=>({username, score}));
  entries.sort((a,b)=> b.score - a.score);
  res.json(entries.slice(0,10));
});
app.get('/api/leaderboard_all', (req,res)=>{
  const data = loadData(); ensure30DayBucket(data);
  const entries = Object.entries(data.scores['active'] || {}).map(([username, score])=>({username, score}));
  entries.sort((a,b)=> b.score - a.score);
  res.json(entries);
});

app.get('/api/status', (req,res)=>{
  const data = loadData(); ensure30DayBucket(data);
  res.json({ lastReset: data.lastReset, totalPlayers: Object.keys(data.users||{}).length });
});

app.listen(PORT, ()=>{ console.log(`$JFREE server at http://localhost:${PORT} (TZ=${TIME_ZONE})`); });

// Serve website at /
const WEBSITE_DIR = path.resolve(__dirname, '../../website');
app.use('/', express.static(WEBSITE_DIR, { extensions: ['html'] }));

app.get('/game', (req, res) => res.redirect(301, '/game/'));


// --- Health endpoints ---
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));
app.get('/api/status', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

