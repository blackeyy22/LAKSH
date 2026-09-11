import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'rewardtree.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 referral_code TEXT NOT NULL UNIQUE,
 referred_by_user_id INTEGER,
 membership_status TEXT NOT NULL DEFAULT 'PENDING',
 membership_paid INTEGER NOT NULL DEFAULT 0,
 role TEXT NOT NULL DEFAULT 'MEMBER',
 email_verified INTEGER NOT NULL DEFAULT 0,
 whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
 network_count INTEGER NOT NULL DEFAULT 0,
 onboarding_complete INTEGER NOT NULL DEFAULT 0,
 auto_pool_status TEXT NOT NULL DEFAULT 'NOT_ELIGIBLE',
 auto_pool_position INTEGER,
 auto_pool_parent_id INTEGER,
 auto_pool_slot INTEGER,
 auto_pool_depth INTEGER,
 auto_pool_joined_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_login_at TEXT,
 FOREIGN KEY(referred_by_user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS otp_codes(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, email TEXT NOT NULL,
 purpose TEXT NOT NULL, otp_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf_token TEXT NOT NULL,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS rate_limits(
 id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, key TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL,
 UNIQUE(bucket,key)
);
CREATE TABLE IF NOT EXISTS referrals(
 id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER NOT NULL,
 referred_user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, verified_at TEXT,
 FOREIGN KEY(referrer_id) REFERENCES users(id), FOREIGN KEY(referred_user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS memberships(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount INTEGER NOT NULL,
 status TEXT NOT NULL, transaction_id TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 paid_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS rewards(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
 image_url TEXT, required_referrals INTEGER NOT NULL DEFAULT 5, active INTEGER NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_rewards(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, reward_id INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'UNLOCKED', unlocked_at TEXT,
 claimed_at TEXT, shipped_at TEXT, delivered_at TEXT,
 UNIQUE(user_id,reward_id), FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(reward_id) REFERENCES rewards(id)
);
CREATE TABLE IF NOT EXISTS store_products(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, image_url TEXT, badge TEXT,
 active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notifications(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
 read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS activity_events(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
 title TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs(
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, action TEXT NOT NULL, entity_type TEXT,
 entity_id INTEGER, metadata TEXT, ip_address TEXT, user_agent TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_submissions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 amount INTEGER NOT NULL DEFAULT 250,
 phone TEXT NOT NULL,
 proof_path TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
 submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewed_at TEXT,
 reviewed_by INTEGER,
 review_note TEXT,
 whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(reviewed_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_payment_submissions_status ON payment_submissions(status);
CREATE INDEX IF NOT EXISTS idx_payment_submissions_user ON payment_submissions(user_id);
`);

// Lightweight schema upgrade for existing prototype databases.
try { db.exec("ALTER TABLE rewards ADD COLUMN image_url TEXT"); } catch {}
try { db.exec("UPDATE users SET referral_code=\'PENDING-\' || lower(hex(randomblob(12))) WHERE membership_paid=0 AND referral_code NOT LIKE \'PENDING-%\'"); } catch {}
for (const stmt of [
  "ALTER TABLE users ADD COLUMN auto_pool_status TEXT NOT NULL DEFAULT 'NOT_ELIGIBLE'",
  "ALTER TABLE users ADD COLUMN auto_pool_position INTEGER",
  "ALTER TABLE users ADD COLUMN auto_pool_parent_id INTEGER",
  "ALTER TABLE users ADD COLUMN auto_pool_slot INTEGER",
  "ALTER TABLE users ADD COLUMN auto_pool_depth INTEGER",
  "ALTER TABLE users ADD COLUMN auto_pool_joined_at TEXT"
]) { try { db.exec(stmt); } catch {} }
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auto_pool_position ON users(auto_pool_position) WHERE auto_pool_position IS NOT NULL"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_auto_pool_parent ON users(auto_pool_parent_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_auto_pool_status ON users(auto_pool_status)"); } catch {}
for (const stmt of [
  "ALTER TABLE users ADD COLUMN phone TEXT",
  "ALTER TABLE users ADD COLUMN is_offline INTEGER NOT NULL DEFAULT 0"
]) { try { db.exec(stmt); } catch {} }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)"); } catch {}

const APP_NAME = process.env.APP_NAME || 'Laksh';
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
if (!existsSync(UPLOAD_DIR)) await mkdir(UPLOAD_DIR, { recursive: true });
const AUTO_POOL_TRIGGER = 5;
const AUTO_POOL_WIDTH = 5;
const AUTO_POOL_REWARDED_DEPTHS = 3;

const smtpConfigured = Boolean(process.env.COMPANY_EMAIL && process.env.COMPANY_EMAIL_PASSWORD && process.env.SMTP_HOST);
const transporter = smtpConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: { user: process.env.COMPANY_EMAIL, pass: process.env.COMPANY_EMAIL_PASSWORD }
}) : null;

function now() { return Date.now(); }
function isoNow() { return new Date().toISOString(); }
function randCode() { return `RT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function randomOtp() { return String(crypto.randomInt(100000, 1000000)); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function verifyPassword(password, stored) {
  try { const [salt, key] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(key, 'hex'), crypto.scryptSync(password, salt, 64)); }
  catch { return false; }
}
function hashOtp(otp) { return crypto.createHash('sha256').update(otp).digest('hex'); }
function safeEmail(e) { return String(e || '').trim().toLowerCase(); }
function cookie(name, value, maxAge = SESSION_DAYS * 86400000, httpOnly = true) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}`];
  if (httpOnly) parts.push('HttpOnly');
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}
function clearCookie(name) { return cookie(name, '', 0); }
function parseCookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function redirect(res, to, headers = {}) { res.writeHead(302, { Location: to, ...headers }); res.end(); }
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8' })[ext] || 'application/octet-stream';
}
async function serveFile(res, file) {
  try {
    const safeRoot = path.resolve(PUBLIC_DIR);
    const safeFile = path.resolve(file);
    if (!safeFile.startsWith(safeRoot + path.sep) && safeFile !== safeRoot) return json(res, { error: 'Not found' }, 404);
    const buf = await readFile(safeFile);
    res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch { json(res, { error: 'Not found' }, 404); }
}
async function body(req, limit = MAX_BODY_BYTES) {
  let d = '';
  for await (const c of req) {
    d += c;
    if (Buffer.byteLength(d) > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  if (!d) return {};
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(d); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  return Object.fromEntries(new URLSearchParams(d));
}
function userById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(Number(id)); }
function userByEmail(email) { return db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email); }
function reward() { return db.prepare('SELECT * FROM rewards WHERE active=1 ORDER BY sort_order, required_referrals, id LIMIT 1').get(); }
function verifiedCount(id) { return Number(db.prepare("SELECT COUNT(*) AS c FROM referrals WHERE referrer_id=? AND status='VERIFIED'").get(id).c); }
function networkCount(id) {
  return Number(db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM users WHERE referred_by_user_id=? AND membership_paid=1
    UNION ALL SELECT u.id FROM users u JOIN tree t ON u.referred_by_user_id=t.id WHERE u.membership_paid=1
  ) SELECT COUNT(*) AS c FROM tree`).get(id).c);
}
function refreshNetworkCountsFrom(id) {
  let current = Number(id);
  while (current) {
    const count = networkCount(current);
    db.prepare('UPDATE users SET network_count=? WHERE id=?').run(count, current);
    current = Number(db.prepare('SELECT referred_by_user_id FROM users WHERE id=?').get(current)?.referred_by_user_id || 0);
  }
}

function autoPoolStageCounts(id, maxDepth = AUTO_POOL_REWARDED_DEPTHS) {
  const rows = db.prepare(`WITH RECURSIVE tree(id, depth) AS (
    SELECT id,0 FROM users WHERE id=? AND auto_pool_status='ACTIVE'
    UNION ALL
    SELECT u.id,t.depth+1
    FROM users u JOIN tree t ON u.auto_pool_parent_id=t.id
    WHERE t.depth < ? AND u.auto_pool_status='ACTIVE'
  ) SELECT depth, COUNT(*) AS count FROM tree WHERE depth BETWEEN 1 AND ? GROUP BY depth ORDER BY depth`).all(Number(id), maxDepth, maxDepth);
  const counts = {1:0,2:0,3:0};
  for (const r of rows) counts[r.depth] = Number(r.count);
  return counts;
}

function autoPoolPositionForNext() {
  return Number(db.prepare("SELECT COALESCE(MAX(auto_pool_position),0)+1 AS next FROM users").get().next);
}

function placeIntoAutoPool(userId) {
  const user = userById(userId);
  if (!user || !user.membership_paid || user.auto_pool_position) return null;
  if (verifiedCount(userId) < AUTO_POOL_TRIGGER) return null;
  const position = autoPoolPositionForNext();
  let parent = null;
  let slot = null;
  let depth = 0;
  if (position > 1) {
    const parentPosition = Math.floor((position - 2) / AUTO_POOL_WIDTH) + 1;
    slot = ((position - 2) % AUTO_POOL_WIDTH) + 1;
    parent = db.prepare("SELECT id,auto_pool_position,auto_pool_depth FROM users WHERE auto_pool_position=? AND auto_pool_status='ACTIVE'").get(parentPosition);
    if (!parent) throw new Error(`Auto Pool parent ${parentPosition} is missing for position ${position}.`);
    depth = Number(parent.auto_pool_depth || 0) + 1;
  }
  db.prepare(`UPDATE users SET auto_pool_status='ACTIVE', auto_pool_position=?, auto_pool_parent_id=?, auto_pool_slot=?, auto_pool_depth=?, auto_pool_joined_at=CURRENT_TIMESTAMP WHERE id=?`).run(position, parent?.id || null, slot, depth, userId);
  addActivity(userId, 'AUTO_POOL', 'Auto Pool unlocked', position === 1 ? 'You are the first position in the shared 5-wide Auto Pool.' : `You entered the shared 5-wide Auto Pool at position ${position}, slot ${slot}.`);
  addNotify(userId, 'Auto Pool unlocked', position === 1 ? 'You are the first position in the shared 5-wide Auto Pool.' : `You entered the shared 5-wide Auto Pool at position ${position}.`);
  return {
    position,
    parentPosition: parent?.auto_pool_position || null,
    slot,
    depth,
    stageCounts: autoPoolStageCounts(userId)
  };
}

function ensureAutoPoolForEligibleUsers() {
  const eligible = db.prepare(`
    SELECT u.id,
      COALESCE(MAX(r.verified_at), u.created_at) AS qualified_at
    FROM users u
    LEFT JOIN referrals r ON r.referrer_id=u.id AND r.status='VERIFIED'
    WHERE u.role='MEMBER' AND u.membership_paid=1 AND u.auto_pool_position IS NULL
    GROUP BY u.id
    HAVING COUNT(CASE WHEN r.status='VERIFIED' THEN 1 END) >= ?
    ORDER BY qualified_at, u.id
  `).all(AUTO_POOL_TRIGGER);
  if (!eligible.length) return;
  inTransaction(() => { for (const row of eligible) placeIntoAutoPool(row.id); });
}

function memberAutoPoolSnapshot(id, visibility = 'member', maxDepth = AUTO_POOL_REWARDED_DEPTHS) {
  const user = userById(id);
  if (!user || !user.auto_pool_position) return { active:false, nodes:[], stageCounts:{1:0,2:0,3:0} };
  const depth = Math.max(1, Math.min(AUTO_POOL_REWARDED_DEPTHS, Number(maxDepth || AUTO_POOL_REWARDED_DEPTHS)));
  const rows = db.prepare(`WITH RECURSIVE tree(id, relative_depth) AS (
    SELECT id,0 FROM users WHERE id=? AND auto_pool_status='ACTIVE'
    UNION ALL
    SELECT u.id,t.relative_depth+1
    FROM users u JOIN tree t ON u.auto_pool_parent_id=t.id
    WHERE t.relative_depth < ? AND u.auto_pool_status='ACTIVE'
  ) SELECT u.id,u.name,u.email,u.referral_code,u.auto_pool_position,u.auto_pool_parent_id,u.auto_pool_slot,u.auto_pool_depth,u.membership_status,t.relative_depth
    FROM users u JOIN tree t ON t.id=u.id ORDER BY t.relative_depth,u.auto_pool_position`).all(id, depth);
  const nodes = rows.map(r => visibility === 'member'
    ? { position:Number(r.auto_pool_position), parentPosition: Number(db.prepare('SELECT auto_pool_position FROM users WHERE id=?').get(r.auto_pool_parent_id)?.auto_pool_position || 0) || null, slot:r.auto_pool_slot, relativeDepth:r.relative_depth }
    : { id:r.id,name:r.name,email:r.email,referral_code:r.referral_code,position:Number(r.auto_pool_position),parentPosition:r.auto_pool_parent_id ? Number(db.prepare('SELECT auto_pool_position FROM users WHERE id=?').get(r.auto_pool_parent_id)?.auto_pool_position || 0) || null : null,slot:r.auto_pool_slot,relativeDepth:r.relative_depth,membership_status:r.membership_status });
  return {
    active:true,
    position:Number(user.auto_pool_position),
    parentPosition:user.auto_pool_parent_id ? Number(db.prepare('SELECT auto_pool_position FROM users WHERE id=?').get(user.auto_pool_parent_id)?.auto_pool_position || 0) || null : null,
    slot:user.auto_pool_slot,
    depth:Number(user.auto_pool_depth || 0),
    width:AUTO_POOL_WIDTH,
    maxRewardDepth:AUTO_POOL_REWARDED_DEPTHS,
    stageCounts:autoPoolStageCounts(id),
    nodes
  };
}

function phoneDigits(value) { return String(value || '').replace(/\D/g, '').slice(0, 15); }
function validPhone(value) { const p = phoneDigits(value); return p.length >= 8 && p.length <= 15; }
function imageDataUrlToFile(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) throw Object.assign(new Error('Please upload a PNG, JPG or WEBP image.'), { status: 400 });
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > UPLOAD_MAX_BYTES) throw Object.assign(new Error('Image is too large. Maximum 8 MB.'), { status: 413 });
  return { ext, buf };
}
async function saveUploadedImage(dataUrl, prefix='upload') {
  const { ext, buf } = imageDataUrlToFile(dataUrl);
  const filename = `${prefix}-${crypto.randomUUID()}.${ext}`;
  await import('node:fs/promises').then(fs => fs.writeFile(path.join(UPLOAD_DIR, filename), buf));
  return `/uploads/${filename}`;
}
function paymentConfig() {
  const num = phoneDigits(process.env.WHATSAPP_NUMBER || '');
  const paymentData = process.env.PAYMENT_UPI_ID ? `upi://pay?pa=${process.env.PAYMENT_UPI_ID}&pn=${encodeURIComponent(process.env.COMPANY_NAME || APP_NAME)}&am=250&cu=INR` : '';
  const paymentQr = process.env.PAYMENT_QR_IMAGE || (paymentData ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(paymentData)}` : '');
  const whatsappQr = num ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(`https://wa.me/${num}`)}` : '';
  return { whatsappNumber: num, paymentQr, whatsappQr, companyName: process.env.COMPANY_NAME || APP_NAME };
}

function activateMemberAfterPayment(userId, paymentSubmissionId = null, reviewerId = null) {
  const currentUser = userById(userId);
  if (!currentUser) throw new Error('Member not found.');
  if (currentUser.membership_paid) return { alreadyActive: true, referralCode: currentUser.referral_code };
  const tx = `MANUAL-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const result = inTransaction(() => {
    const usableCode = String(currentUser.referral_code || '').startsWith('PENDING-') ? randCode() : currentUser.referral_code;
    db.prepare('INSERT INTO memberships(user_id,amount,status,transaction_id,paid_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)').run(userId,250,'PAID',tx);
    db.prepare("UPDATE users SET membership_status='ACTIVE',membership_paid=1,referral_code=? WHERE id=?").run(usableCode,userId);
    if (paymentSubmissionId) db.prepare("UPDATE payment_submissions SET status='APPROVED', reviewed_at=CURRENT_TIMESTAMP, reviewed_by=?, review_note=? WHERE id=?").run(reviewerId || null, 'Payment approved by admin.', paymentSubmissionId);
    const pendingRef = db.prepare("SELECT * FROM referrals WHERE referred_user_id=? AND status='PENDING'").get(userId);
    let referrerEmail = null, verifiedCountForReferrer = 0, rewardUnlocked = false;
    if (pendingRef) {
      db.prepare("UPDATE referrals SET status='VERIFIED',verified_at=CURRENT_TIMESTAMP WHERE id=?").run(pendingRef.id);
      verifiedCountForReferrer = verifiedCount(pendingRef.referrer_id);
      refreshNetworkCountsFrom(pendingRef.referrer_id);
      addNotify(pendingRef.referrer_id,'Referral verified',`${currentUser.name} completed the membership payment. Your verified referral total is now ${verifiedCountForReferrer}.`);
      addActivity(pendingRef.referrer_id,'REFERRAL','Referral verified',`${currentUser.name} is now a verified referral.`);
      const refUser = userById(pendingRef.referrer_id);
      referrerEmail = refUser?.email || null;
      const rr = reward();
      if (rr && verifiedCountForReferrer >= rr.required_referrals) {
        const existing = db.prepare('SELECT id FROM user_rewards WHERE user_id=? AND reward_id=?').get(pendingRef.referrer_id, rr.id);
        if (!existing) {
          db.prepare("INSERT INTO user_rewards(user_id,reward_id,status,unlocked_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").run(pendingRef.referrer_id, rr.id, 'UNLOCKED');
          addNotify(pendingRef.referrer_id,'Reward unlocked',`You completed ${rr.required_referrals} verified referrals and unlocked your reward.`);
          addActivity(pendingRef.referrer_id,'REWARD','Reward unlocked',rr.name);
          rewardUnlocked = true;
        }
      }
      if (verifiedCountForReferrer >= AUTO_POOL_TRIGGER) placeIntoAutoPool(pendingRef.referrer_id);
    }
    addNotify(userId,'Payment received',`Your ₹250 payment was approved. Membership is now active.`);
    addActivity(userId,'PAYMENT','Payment approved',`Manual payment approved. Transaction ${tx}.`);
    if (paymentSubmissionId) audit(reviewerId,'APPROVE_PAYMENT','PAYMENT',paymentSubmissionId,{userId,transactionId:tx},null);
    return { tx, referralCode: usableCode, referrerEmail, verifiedCountForReferrer, rewardUnlocked };
  });
  refreshNetworkCountsFrom(userId);
  ensureAutoPoolForEligibleUsers();
  if (result.referrerEmail) void sendBusinessEmail(result.referrerEmail,'Laksh referral verified','Your referral was verified',`${currentUser.name} completed the membership payment. Your verified referral total is now ${result.verifiedCountForReferrer}.`);
  if (validEmailForNotify(currentUser.email)) void sendBusinessEmail(currentUser.email,'Laksh payment approved','Membership activated','Your payment was approved and your Laksh membership is now active. Your referral tools are now available.');
  return result;
}
function validEmailForNotify(email) { return validateEmail(String(email || '')); }

function autoPoolChildren(parentId) {
  return db.prepare(`SELECT id,name,email,referral_code,auto_pool_position,auto_pool_parent_id,auto_pool_slot,auto_pool_depth,membership_status,network_count
    FROM users WHERE auto_pool_parent_id=? AND auto_pool_status='ACTIVE' ORDER BY auto_pool_slot`).all(Number(parentId)).map(r => ({
      ...r,
      position:Number(r.auto_pool_position),
      parentPosition:r.auto_pool_parent_id ? Number(db.prepare('SELECT auto_pool_position FROM users WHERE id=?').get(r.auto_pool_parent_id)?.auto_pool_position || 0) || null : null
    }));
}
function inTransaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } }
function addNotify(id, title, message) { db.prepare('INSERT INTO notifications(user_id,title,message) VALUES(?,?,?)').run(id, title, message); }
function addActivity(id, type, title, detail = '') { db.prepare('INSERT INTO activity_events(user_id,type,title,detail) VALUES(?,?,?,?)').run(id, type, title, detail); }
function audit(actor, action, type, id, meta = {}, req = null) {
  db.prepare('INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata,ip_address,user_agent) VALUES(?,?,?,?,?,?,?)').run(actor || null, action, type || null, id || null, JSON.stringify(meta), req?.socket?.remoteAddress || null, req?.headers?.['user-agent'] || null);
}
function rateLimit(bucket, key, max, windowMs) {
  const t = now();
  const row = db.prepare('SELECT * FROM rate_limits WHERE bucket=? AND key=?').get(bucket, key);
  if (!row || t - row.window_start >= windowMs) {
    db.prepare('INSERT INTO rate_limits(bucket,key,count,window_start) VALUES(?,?,1,?) ON CONFLICT(bucket,key) DO UPDATE SET count=1, window_start=excluded.window_start').run(bucket, key, t);
    return true;
  }
  if (row.count >= max) return false;
  db.prepare('UPDATE rate_limits SET count=count+1 WHERE id=?').run(row.id);
  return true;
}
function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function validatePassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 200; }
function otpIssue(userId, email, purpose) {
  const clean = safeEmail(email);
  const otp = randomOtp();
  db.prepare('INSERT INTO otp_codes(user_id,email,purpose,otp_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(userId || null, clean, purpose, hashOtp(otp), now() + OTP_TTL_MS, now());
  const subject = purpose === 'EMAIL_VERIFICATION' ? 'Verify your Laksh email' : purpose === 'LOGIN' ? 'Your Laksh login code' : 'Reset your Laksh password';
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#19211d"><div style="font-weight:900;letter-spacing:.12em;font-size:14px">LAKSH</div><h1 style="font-size:28px">${subject.replace('Laksh ','')}</h1><p>Your one-time verification code is:</p><div style="font-size:34px;font-weight:800;letter-spacing:.3em;padding:18px 20px;background:#f1f4f0;border-radius:14px;text-align:center">${otp}</div><p style="color:#66706a">This code expires in 10 minutes. If you did not request this, you can ignore this email.</p></div>`;
  if (transporter) {
    transporter.sendMail({ from: `${process.env.COMPANY_EMAIL_NAME || APP_NAME} <${process.env.COMPANY_EMAIL}>`, to: clean, subject, html }).catch(err => console.error('[EMAIL ERROR]', err.message));
  } else {
    console.log(`\n[DEV EMAIL OTP] ${clean} | ${purpose} | ${otp}\n`);
  }
}
function otpVerify(email, purpose, otp) {
  const row = db.prepare('SELECT * FROM otp_codes WHERE lower(email)=lower(?) AND purpose=? AND used_at IS NULL ORDER BY id DESC LIMIT 1').get(safeEmail(email), purpose);
  if (!row) return false;
  if (now() > row.expires_at || row.attempts >= 5) return false;
  db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
  if (hashOtp(String(otp || '')) !== row.otp_hash) return false;
  db.prepare('UPDATE otp_codes SET used_at=? WHERE id=?').run(now(), row.id);
  return true;
}
function createSession(userId) {
  const sid = crypto.randomUUID();
  const csrf = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(id,user_id,csrf_token,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(sid, userId, csrf, now() + SESSION_DAYS * 86400000, now(), now());
  return { sid, csrf };
}
function getSession(req) {
  const sid = parseCookies(req).rt_sid;
  if (!sid) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(sid);
  if (!row) return null;
  if (now() > row.expires_at) { db.prepare('DELETE FROM sessions WHERE id=?').run(sid); return null; }
  db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), sid);
  return row;
}
function getCurrentUser(req) { const s = getSession(req); return s ? userById(s.user_id) : null; }
function requireAuth(req, res) { const u = getCurrentUser(req); if (!u) { json(res, { error: 'Unauthorized' }, 401); return null; } return u; }
function requireCsrf(req, res, session) {
  if (!session) { json(res, { error: 'Unauthorized' }, 401); return false; }
  const token = req.headers['x-csrf-token'];
  if (!token || token !== session.csrf_token) { json(res, { error: 'Invalid CSRF token' }, 403); return false; }
  return true;
}
function requireAdmin(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (!['SUPER_ADMIN','ADMIN','MEMBER_ADMIN','PAYMENT_ADMIN','REWARD_ADMIN','CONTENT_ADMIN','CAMPAIGN_ADMIN'].includes(u.role)) { json(res, { error: 'Forbidden' }, 403); return null; }
  return u;
}
function requireRole(u, roles) { return roles.includes(u.role); }
async function sendBusinessEmail(to, subject, title, message) {
  if (!transporter || !to) return;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#19211d"><div style="font-weight:900;letter-spacing:.12em;font-size:14px">LAKSH</div><h1 style="font-size:28px;margin:28px 0 12px">${title}</h1><p style="line-height:1.65;color:#5f6962">${message}</p><div style="margin-top:28px;padding-top:18px;border-top:1px solid #e1e7e2;font-size:12px;color:#89918b">This is an automated message from ${APP_NAME}.</div></div>`;
  try { await transporter.sendMail({ from: `${process.env.COMPANY_EMAIL_NAME || APP_NAME} <${process.env.COMPANY_EMAIL}>`, to, subject, html }); }
  catch (err) { console.error('[EMAIL ERROR]', err.message); }
}

// Seed admin, reward and showcase products.
if (!userByEmail(process.env.ADMIN_EMAIL || 'admin@example.com')) {
  const email = safeEmail(process.env.ADMIN_EMAIL || 'admin@example.com');
  const pass = process.env.ADMIN_PASSWORD || 'Admin12345!';
  db.prepare("INSERT INTO users(name,email,password_hash,referral_code,membership_status,membership_paid,role,email_verified,onboarding_complete) VALUES(?,?,?,?,?,?,?,?,1)").run('Administrator', email, hashPassword(pass), randCode(), 'ACTIVE', 1, 'SUPER_ADMIN', 1);
  console.log(`Admin login: ${email} / ${pass}`);
}
const rewardImage='/assets/images/reward-mic-speaker.svg';
if (!reward()) db.prepare('INSERT INTO rewards(name,description,image_url,required_referrals,sort_order) VALUES(?,?,?,?,0)').run('Karaoke Mic + Speaker', 'Complete the referral milestone to unlock this reward.', rewardImage, 5);
else db.prepare("UPDATE rewards SET image_url=COALESCE(NULLIF(image_url,''),?) WHERE id=(SELECT id FROM rewards ORDER BY id LIMIT 1)").run(rewardImage);
if (db.prepare('SELECT COUNT(*) c FROM store_products').get().c === 0) {
  const ins = db.prepare('INSERT INTO store_products(name,description,image_url,badge,sort_order,active) VALUES(?,?,?,?,?,1)');
  ins.run('Wireless Karaoke Speaker', 'Powerful sound for parties, events and family entertainment.', 'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=900&q=80', 'NEW', 1);
  ins.run('Premium Karaoke Microphone', 'A clean, stage-ready microphone built for singing and events.', 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80', 'FEATURED', 2);
  ins.run('Party Audio System', 'A fuller setup for celebrations, gatherings and home entertainment.', 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?auto=format&fit=crop&w=900&q=80', 'POPULAR', 3);
  ins.run('New Store Drop', 'Explore the latest product arriving in the store.', 'https://images.unsplash.com/photo-1516707570266-9bc0f3f6b4dc?auto=format&fit=crop&w=900&q=80', 'JUST IN', 4);
}

// Backfill eligible members from older prototype databases into the global Auto Pool.
try { ensureAutoPoolForEligibleUsers(); } catch (e) { console.error('[AUTO POOL BACKFILL ERROR]', e.message); }

// Periodic cleanup.
setInterval(() => {
  const t = now();
  db.prepare('DELETE FROM otp_codes WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?').run(t, t - 86400000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(t - 86400000);
}, 60 * 60 * 1000).unref();

async function handle(req, res) {
  const method = req.method || 'GET';
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;
  const session = getSession(req);
  const current = session ? userById(session.user_id) : null;

  // Security headers.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (method === 'GET' && pathname === '/health') return json(res, { ok: true, app: APP_NAME, time: isoNow() });
  if (method === 'GET' && pathname === '/api/csrf') {
    if (!session) return json(res, { token: null });
    return json(res, { token: session.csrf_token }, 200, { 'Set-Cookie': cookie('rt_csrf', session.csrf_token, SESSION_DAYS * 86400000, false) });
  }

  // Public/static routes.
  const pageMap = {
    '/':'index.html','/signup':'signup.html','/login':'login.html','/verify':'verify.html','/forgot':'forgot.html',
    '/reset':'reset.html','/subscribe':'subscribe.html','/payment':'payment.html','/app':'app.html','/admin-ui':'admin.html','/how-it-works':'how.html'
  };
  if (method === 'GET' && pageMap[pathname]) { if (pathname === '/payment' && !current) return redirect(res, '/login?next=/payment'); return serveFile(res, path.join(PUBLIC_DIR, pageMap[pathname])); }
  if (method === 'GET' && pathname.startsWith('/assets/')) return serveFile(res, path.join(PUBLIC_DIR, pathname.slice('/assets/'.length)));
  if (method === 'GET' && pathname.startsWith('/uploads/')) return serveFile(res, path.join(PUBLIC_DIR, pathname.slice('/uploads/'.length)));
  if (method === 'GET' && pathname === '/api/payment-config') return json(res, paymentConfig());

  // Auth APIs (pre-auth endpoints do not require CSRF).
  if (method === 'POST' && pathname === '/api/auth/signup') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit('signup-ip', ip, 10, 60 * 60 * 1000)) return json(res, { error: 'Too many signup attempts. Try again later.' }, 429);
    const b = await body(req), name = String(b.name || '').trim(), email = safeEmail(b.email), password = String(b.password || '');
    if (name.length < 2 || name.length > 100 || !validateEmail(email) || !validatePassword(password)) return json(res, { error: 'Please enter a valid name, email and password (8+ characters).' }, 400);
    if (userByEmail(email)) return json(res, { error: 'Account already exists. Try signing in.' }, 409);
    // Referral attribution is intentionally attached after login, before membership activation.
    // A pre-membership placeholder keeps the DB unique without exposing a usable referral code.
    const referralCode = `PENDING-${crypto.randomUUID()}`;
    try {
      const tx = inTransaction(() => {
        const r = db.prepare('INSERT INTO users(name,email,password_hash,referral_code) VALUES(?,?,?,?)').run(name,email,hashPassword(password),referralCode);
        const id = Number(r.lastInsertRowid);
        addActivity(id, 'ACCOUNT', 'Account created', 'Your account was created. Add a referral code after login, or activate your membership directly.');
        return id;
      });
      otpIssue(tx, email, 'EMAIL_VERIFICATION');
      return json(res, { ok: true, email });
    } catch (e) {
      console.error(e);
      return json(res, { error: 'Unable to create the account. Please try again.' }, 500);
    }
  }
  if (method === 'POST' && pathname === '/api/auth/verify') {
    const b = await body(req), email = safeEmail(b.email), otp = String(b.otp || '');
    if (!rateLimit('otp-verify', `${req.socket.remoteAddress}|${email}`, 10, 30 * 60 * 1000)) return json(res, { error: 'Too many verification attempts.' }, 429);
    if (!validateEmail(email) || !/^\d{6}$/.test(otp) || !otpVerify(email,'EMAIL_VERIFICATION',otp)) return json(res,{error:'Invalid or expired OTP.'},400);
    const user = userByEmail(email); if (!user) return json(res,{error:'Account not found.'},404);
    db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(user.id); addActivity(user.id,'ACCOUNT','Email verified','Your email address has been verified.');
    const s = createSession(user.id); return json(res,{ok:true},200,{'Set-Cookie':[cookie('rt_sid',s.sid),cookie('rt_csrf',s.csrf,SESSION_DAYS*86400000,false)]});
  }
  if (method === 'POST' && pathname === '/api/auth/resend') {
    const b = await body(req), email = safeEmail(b.email), purpose = String(b.purpose || 'EMAIL_VERIFICATION');
    if (!['EMAIL_VERIFICATION','LOGIN','PASSWORD_RESET'].includes(purpose)) return json(res,{error:'Invalid OTP purpose.'},400);
    if (!rateLimit('otp-send', `${req.socket.remoteAddress}|${email}|${purpose}`, 5, 15 * 60 * 1000)) return json(res,{error:'Please wait before requesting another code.'},429);
    const usr = userByEmail(email); if (usr) otpIssue(usr.id,email,purpose);
    return json(res,{ok:true});
  }
  if (method === 'POST' && pathname === '/api/auth/login') {
    const b = await body(req), email=safeEmail(b.email), password=String(b.password||''), ip=req.socket.remoteAddress||'unknown';
    if (!rateLimit('login', `${ip}|${email}`, 10, 15*60*1000)) return json(res,{error:'Too many login attempts. Try again later.'},429);
    const usr=userByEmail(email); if(!usr || !verifyPassword(password,usr.password_hash)) return json(res,{error:'Invalid email or password.'},401);
    if(!usr.email_verified) return json(res,{needsVerification:true,email:usr.email},403);
    db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(usr.id); addActivity(usr.id,'LOGIN','Successful login','You signed in to Laksh.');
    void sendBusinessEmail(usr.email,'Successful Laksh login','You signed in successfully','Your Laksh account was just signed in successfully. If this was not you, reset your password and review your account.');
    const s=createSession(usr.id); return json(res,{ok:true,admin:['SUPER_ADMIN','ADMIN','MEMBER_ADMIN','PAYMENT_ADMIN','REWARD_ADMIN','CONTENT_ADMIN','CAMPAIGN_ADMIN'].includes(usr.role)},200,{'Set-Cookie':[cookie('rt_sid',s.sid),cookie('rt_csrf',s.csrf,SESSION_DAYS*86400000,false)]});
  }
  if (method === 'POST' && pathname === '/api/auth/login-otp/send') {
    const b=await body(req), email=safeEmail(b.email); if(!rateLimit('otp-send',`${req.socket.remoteAddress}|${email}|LOGIN`,5,15*60*1000))return json(res,{error:'Please wait before requesting another code.'},429); const usr=userByEmail(email);if(usr)otpIssue(usr.id,email,'LOGIN');return json(res,{ok:true});
  }
  if (method === 'POST' && pathname === '/api/auth/login-otp/verify') {
    const b=await body(req),email=safeEmail(b.email),otp=String(b.otp||'');if(!otpVerify(email,'LOGIN',otp))return json(res,{error:'Invalid or expired OTP.'},400);const usr=userByEmail(email);if(!usr)return json(res,{error:'Invalid login.'},401);db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(usr.id);addActivity(usr.id,'LOGIN','Successful OTP login','You signed in with a one-time code.');void sendBusinessEmail(usr.email,'Successful Laksh login','You signed in successfully','Your Laksh account was signed in using email OTP.');const s=createSession(usr.id);return json(res,{ok:true,admin:['SUPER_ADMIN','ADMIN','MEMBER_ADMIN','PAYMENT_ADMIN','REWARD_ADMIN','CONTENT_ADMIN','CAMPAIGN_ADMIN'].includes(usr.role)},200,{'Set-Cookie':[cookie('rt_sid',s.sid),cookie('rt_csrf',s.csrf,SESSION_DAYS*86400000,false)]});
  }
  if (method === 'POST' && pathname === '/api/auth/forgot') {
    const b=await body(req),email=safeEmail(b.email);if(!rateLimit('forgot',`${req.socket.remoteAddress}|${email}`,5,15*60*1000))return json(res,{error:'Please wait before requesting another code.'},429);const usr=userByEmail(email);if(usr)otpIssue(usr.id,email,'PASSWORD_RESET');return json(res,{ok:true});
  }
  if (method === 'POST' && pathname === '/api/auth/reset') {
    const b=await body(req),email=safeEmail(b.email),otp=String(b.otp||''),password=String(b.password||'');if(!validatePassword(password))return json(res,{error:'Password must be at least 8 characters.'},400);if(!otpVerify(email,'PASSWORD_RESET',otp))return json(res,{error:'Invalid or expired OTP.'},400);const usr=userByEmail(email);if(!usr)return json(res,{error:'Invalid request.'},400);db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password),usr.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(usr.id);addActivity(usr.id,'SECURITY','Password changed','Your password was successfully reset.');void sendBusinessEmail(usr.email,'Laksh password changed','Your password was changed','Your Laksh password was successfully changed.');return json(res,{ok:true});
  }
  if (method === 'POST' && pathname === '/api/logout') {
    if (session) { db.prepare('DELETE FROM sessions WHERE id=?').run(session.id); if(current) addActivity(current.id,'LOGIN','Signed out','You signed out of Laksh.'); }
    return json(res,{ok:true},200,{'Set-Cookie':[clearCookie('rt_sid'),clearCookie('rt_csrf',)]});
  }

  // Authenticated customer APIs.
  if (pathname.startsWith('/api/me') || pathname === '/api/membership/mock-pay') {
    if (!current) return json(res,{error:'Unauthorized'},401);
    if (method !== 'GET' && !requireCsrf(req,res,session)) return;
  }
  if (method === 'GET' && pathname === '/api/me') {
    const r=reward();const count=verifiedCount(current.id);const net=networkCount(current.id);const ur=r?db.prepare('SELECT * FROM user_rewards WHERE user_id=? AND reward_id=?').get(current.id,r.id):null;
    const autoPool=memberAutoPoolSnapshot(current.id,'member');
    const referralEnabled=!!current.membership_paid;
    const usableReferralCode=referralEnabled && !String(current.referral_code||'').startsWith('PENDING-') ? current.referral_code : null;
    const referralLink=usableReferralCode?`${req.headers['x-forwarded-proto']||'http'}://${req.headers.host||`localhost:${PORT}`}/signup?ref=${usableReferralCode}`:null;
    const latestPayment = db.prepare('SELECT * FROM payment_submissions WHERE user_id=? ORDER BY id DESC LIMIT 1').get(current.id);
    return json(res,{user:{id:current.id,name:current.name,email:current.email,phone:current.phone||'',role:current.role,referralCode:usableReferralCode,membershipStatus:current.membership_status,membershipPaid:!!current.membership_paid,whatsappOptIn:!!current.whatsapp_opt_in,onboardingComplete:!!current.onboarding_complete,autoPoolActive:!!current.auto_pool_position},referral:{enabled:referralEnabled,verified:count,required:r?.required_referrals||5,link:referralLink},network:{count:net},payment:{status:latestPayment?.status||null,submittedAt:latestPayment?.submitted_at||null,proofPath:latestPayment?.proof_path||null},autoPool, reward:r?{...r,unlocked:!!ur,status:ur?.status||'LOCKED'}:{},notifications:db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 8').all(current.id),activity:db.prepare('SELECT * FROM activity_events WHERE user_id=? ORDER BY id DESC LIMIT 10').all(current.id),products:db.prepare('SELECT * FROM store_products WHERE active=1 ORDER BY sort_order,id').all()});
  }
  if (method === 'GET' && pathname === '/api/me/network') return json(res,{count:networkCount(current.id),directReferrals:db.prepare('SELECT COUNT(*) c FROM referrals WHERE referrer_id=?').get(current.id).c});
  if (method === 'POST' && pathname === '/api/me/onboarding') {db.prepare('UPDATE users SET onboarding_complete=1 WHERE id=?').run(current.id);return json(res,{ok:true});}
  if (method === 'POST' && pathname === '/api/me/notifications/read') {db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=?').run(current.id);return json(res,{ok:true});}
  if (method === 'POST' && pathname === '/api/me/profile') {const b=await body(req),name=String(b.name||current.name).trim(),phone=String(b.phone||current.phone||'').trim();if(name.length<2)return json(res,{error:'Please enter a valid name.'},400);if(phone && !validPhone(phone))return json(res,{error:'Please enter a valid phone number.'},400);db.prepare('UPDATE users SET name=?,phone=?,whatsapp_opt_in=? WHERE id=?').run(name,phone||null,b.whatsapp_opt_in?1:0,current.id);addActivity(current.id,'PROFILE','Profile updated','Your profile details were updated.');return json(res,{ok:true});}
  if (method === 'GET' && pathname === '/api/products') return json(res,db.prepare('SELECT * FROM store_products WHERE active=1 ORDER BY sort_order,id').all());
  if (method === 'POST' && pathname === '/api/me/attach-referral') {
    if (current.membership_paid) return json(res,{error:'Referral code cannot be added after membership activation.'},400);
    if (current.referred_by_user_id) return json(res,{error:'A referral code has already been attached to your account.'},400);
    const b=await body(req), code=String(b.referralCode||b.ref||'').trim().toUpperCase();
    if (!code) return json(res,{error:'Enter a referral code.'},400);
    const parent=db.prepare("SELECT * FROM users WHERE referral_code=? AND membership_paid=1 AND role='MEMBER'").get(code);
    if (!parent) return json(res,{error:'Referral code not found or not active.'},400);
    if(parent.id===current.id)return json(res,{error:'You cannot use your own referral code.'},400);
    const exists=db.prepare('SELECT id FROM referrals WHERE referred_user_id=?').get(current.id);
    if(exists)return json(res,{error:'A referral is already attached to this account.'},400);
    inTransaction(()=>{
      db.prepare('UPDATE users SET referred_by_user_id=? WHERE id=?').run(parent.id,current.id);
      db.prepare("INSERT INTO referrals(referrer_id,referred_user_id,status) VALUES(?,?,?)").run(parent.id,current.id,'PENDING');
      addActivity(current.id,'REFERRAL','Referral code attached',`Your account is connected to ${parent.name}.`);
      addActivity(parent.id,'REFERRAL','New pending referral',`${current.name} attached your referral code.`);
      refreshNetworkCountsFrom(parent.id);
    });
    return json(res,{ok:true,referrer:parent.name});
  }
if (method === 'POST' && pathname === '/api/membership/payment-submit') {
  const b = await body(req, UPLOAD_MAX_BYTES + 512 * 1024);
  const phone = phoneDigits(b.phone || current.phone);
  const proofData = String(b.proofData || '');
  if (!validPhone(phone)) return json(res,{error:'Please enter a valid WhatsApp/mobile number.'},400);
  if (!proofData) return json(res,{error:'Please upload your payment proof.'},400);
  if (current.membership_paid) return json(res,{error:'Your membership is already active.'},400);
  const previous = db.prepare("SELECT id FROM payment_submissions WHERE user_id=? AND status='PENDING_REVIEW'").get(current.id);
  if (previous) return json(res,{error:'You already have a payment waiting for admin review.'},409);
  const proofPath = await saveUploadedImage(proofData, 'payment-proof');
  const result = inTransaction(() => {
    db.prepare('UPDATE users SET phone=?, whatsapp_opt_in=? WHERE id=?').run(phone, b.whatsappOptIn ? 1 : 0, current.id);
    const row = db.prepare('INSERT INTO payment_submissions(user_id,amount,phone,proof_path,status,whatsapp_opt_in) VALUES(?,?,?,?,?,?)').run(current.id,250,phone,proofPath,'PENDING_REVIEW',b.whatsappOptIn?1:0);
    addActivity(current.id,'PAYMENT','Payment proof submitted','Your ₹250 payment proof is waiting for admin review.');
    return Number(row.lastInsertRowid);
  });
  void sendBusinessEmail(current.email,'Laksh payment proof received','Payment proof received','We received your ₹250 payment proof. Our team will review it and process your membership within up to 2 hours. If you need help, please contact customer care.'); if (process.env.COMPANY_EMAIL) void sendBusinessEmail(process.env.COMPANY_EMAIL,'Laksh payment awaiting review','New payment proof awaiting review',`Member ${current.name} (${current.email}) submitted a ₹250 payment proof. Review it in the Admin Payments section.`); return json(res,{ok:true,submissionId:result,status:'PENDING_REVIEW',message:'Payment proof submitted. It may take up to 2 hours to process. Please contact customer care if it takes longer.'});
}

if (method === 'POST' && pathname === '/api/membership/mock-pay') {
  return json(res,{error:'The payment flow has changed. Please use the payment proof page.'},410);
}
  // Admin API. 
  if (pathname.startsWith('/api/admin/')) {
    const admin=requireAdmin(req,res);if(!admin)return;
    if(method!=='GET' && !requireCsrf(req,res,session))return;
    const can = roles => requireRole(admin, roles) || admin.role === 'SUPER_ADMIN' || admin.role === 'ADMIN';

if (method==='GET' && pathname==='/api/admin/payment-reviews') {
  if(!can(['PAYMENT_ADMIN']))return json(res,{error:'Forbidden'},403);
  const status=String(parsed.searchParams.get('status')||'PENDING_REVIEW').toUpperCase();
  const rows=db.prepare(`SELECT p.*,u.name,u.email,u.phone AS account_phone,u.membership_status FROM payment_submissions p JOIN users u ON u.id=p.user_id WHERE p.status=? ORDER BY p.id DESC LIMIT 200`).all(status);
  return json(res,rows);
}
if (method==='POST' && pathname.startsWith('/api/admin/payment-reviews/') && pathname.endsWith('/approve')) {
  if(!can(['PAYMENT_ADMIN']))return json(res,{error:'Forbidden'},403);
  const id=Number(pathname.split('/')[4]);
  const p=db.prepare('SELECT * FROM payment_submissions WHERE id=?').get(id);
  if(!p)return json(res,{error:'Payment submission not found.'},404);
  if(p.status==='APPROVED')return json(res,{ok:true,alreadyApproved:true});
  if(p.status!=='PENDING_REVIEW')return json(res,{error:'Payment is not pending review.'},400);
  const result=activateMemberAfterPayment(p.user_id,id,admin.id);
  audit(admin.id,'APPROVE_PAYMENT','PAYMENT',id,{memberId:p.user_id,transactionId:result.tx},req);
  return json(res,{ok:true,transactionId:result.tx,referralCode:result.referralCode});
}
if (method==='POST' && pathname.startsWith('/api/admin/payment-reviews/') && pathname.endsWith('/reject')) {
  if(!can(['PAYMENT_ADMIN']))return json(res,{error:'Forbidden'},403);
  const id=Number(pathname.split('/')[4]), b=await body(req), note=String(b.note||'Payment proof was rejected. Please submit a clearer proof.').trim();
  const p=db.prepare('SELECT * FROM payment_submissions WHERE id=?').get(id);
  if(!p)return json(res,{error:'Payment submission not found.'},404);
  db.prepare("UPDATE payment_submissions SET status='REJECTED', reviewed_at=CURRENT_TIMESTAMP, reviewed_by=?, review_note=? WHERE id=?").run(admin.id,note,id);
  addNotify(p.user_id,'Payment proof needs attention',note);
  addActivity(p.user_id,'PAYMENT','Payment proof rejected',note);
  audit(admin.id,'REJECT_PAYMENT','PAYMENT',id,{note,memberId:p.user_id},req);
  const u=userById(p.user_id); if(u && validEmailForNotify(u.email)) void sendBusinessEmail(u.email,'Laksh payment proof update','Payment proof needs attention',note);
  return json(res,{ok:true});
}
if (method==='POST' && pathname==='/api/admin/offline-member') {
  if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);
  const b=await body(req), name=String(b.name||'').trim(), emailInput=safeEmail(b.email), phone=phoneDigits(b.phone||'');
  if(name.length<2 || name.length>100)return json(res,{error:'Please enter a valid name.'},400);
  if(emailInput && !validateEmail(emailInput))return json(res,{error:'Please enter a valid email or leave it blank.'},400);
  const email=emailInput || `offline-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@offline.rewardtree`;
  if(userByEmail(emailInput))return json(res,{error:'An account with this email already exists.'},409);
  const sponsorCode=String(b.referralCode||'').trim().toUpperCase();
  const sponsor=sponsorCode?db.prepare("SELECT id,name FROM users WHERE referral_code=? AND membership_paid=1 AND role='MEMBER'").get(sponsorCode):null;
  if(sponsorCode && !sponsor)return json(res,{error:'Sponsor referral code not found or inactive.'},400);
  const newId=inTransaction(()=>{
    const code=randCode();
    const r=db.prepare("INSERT INTO users(name,email,password_hash,referral_code,referred_by_user_id,membership_status,membership_paid,role,email_verified,whatsapp_opt_in,is_offline) VALUES(?,?,?,?,?,?,?,?,?,?,1)").run(name,email,hashPassword(crypto.randomBytes(24).toString('hex')),code,sponsor?.id||null,'ACTIVE',1,'MEMBER',1,b.whatsappOptIn?1:0);
    const id=Number(r.lastInsertRowid);
    if(sponsor){db.prepare("INSERT INTO referrals(referrer_id,referred_user_id,status,verified_at) VALUES(?,?,?,CURRENT_TIMESTAMP)").run(sponsor.id,id,'VERIFIED');refreshNetworkCountsFrom(sponsor.id);const v=verifiedCount(sponsor.id);addNotify(sponsor.id,'Referral verified',`${name} was added by admin as a verified referral. Your verified referral total is now ${v}.`);addActivity(sponsor.id,'REFERRAL','Offline referral added',`${name} was added as a verified referral by admin.`);if(v>=AUTO_POOL_TRIGGER)placeIntoAutoPool(sponsor.id);}
    addActivity(id,'ACCOUNT','Offline member created','This member was entered by an administrator without online payment or email OTP.');
    audit(admin.id,'CREATE_OFFLINE_MEMBER','USER',id,{name,email,phone,sponsorId:sponsor?.id||null},req);
    return id;
  });
  if(phone)db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone,newId);
  ensureAutoPoolForEligibleUsers();
  return json(res,{ok:true,id:newId,email,referralCode:userById(newId).referral_code});
}
if (method==='POST' && pathname==='/api/admin/upload-image') {
  if(!can(['CONTENT_ADMIN','CAMPAIGN_ADMIN']))return json(res,{error:'Forbidden'},403);
  const b=await body(req, UPLOAD_MAX_BYTES + 512 * 1024);
  const kind=String(b.kind||'image').replace(/[^a-z0-9_-]/gi,'').slice(0,30)||'image';
  const image=await saveUploadedImage(String(b.dataUrl||''),kind);
  audit(admin.id,'UPLOAD_IMAGE','FILE',null,{path:image,kind},req);
  return json(res,{ok:true,url:image});
}
if (method==='GET' && pathname==='/api/admin/whatsapp-config') {
  if(!can(['CAMPAIGN_ADMIN']))return json(res,{error:'Forbidden'},403);
  return json(res,paymentConfig());
}
    if (method==='GET' && pathname==='/api/admin/dashboard') {
      const range=Math.min(365,Math.max(1,Number(parsed.searchParams.get('days')||30)));const since=new Date(Date.now()-range*86400000).toISOString();
      return json(res,{users:db.prepare("SELECT COUNT(*) c FROM users WHERE role='MEMBER'").get().c,active:db.prepare("SELECT COUNT(*) c FROM users WHERE role='MEMBER' AND membership_status='ACTIVE'").get().c,referrals:db.prepare("SELECT COUNT(*) c FROM referrals WHERE status='VERIFIED'").get().c,rewards:db.prepare('SELECT COUNT(*) c FROM user_rewards').get().c,revenue:db.prepare("SELECT COALESCE(SUM(amount),0) total FROM memberships WHERE status='PAID'").get().total,autoPoolMembers:db.prepare("SELECT COUNT(*) c FROM users WHERE auto_pool_position IS NOT NULL AND auto_pool_status='ACTIVE'").get().c,newMembers:db.prepare("SELECT COUNT(*) c FROM users WHERE role='MEMBER' AND created_at>=?").get(since).c,newReferrals:db.prepare("SELECT COUNT(*) c FROM referrals WHERE status='VERIFIED' AND verified_at>=?").get(since).c,range});
    }
    if (method==='GET' && pathname==='/api/admin/members') {
      if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const q=String(parsed.searchParams.get('q')||'').trim(),status=String(parsed.searchParams.get('status')||''),page=Math.max(1,Number(parsed.searchParams.get('page')||1)),limit=Math.min(100,Math.max(10,Number(parsed.searchParams.get('limit')||25))),offset=(page-1)*limit;const filters=["role='MEMBER'"];const args=[];if(q){filters.push('(name LIKE ? OR email LIKE ? OR referral_code LIKE ?)');args.push(`%${q}%`,`%${q}%`,`%${q}%`);}if(status){filters.push('membership_status=?');args.push(status);}const where=filters.join(' AND ');const total=Number(db.prepare(`SELECT COUNT(*) c FROM users WHERE ${where}`).get(...args).c);const rows=db.prepare(`SELECT id,name,email,referral_code,membership_status,email_verified,network_count,created_at,last_login_at FROM users WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);return json(res,{rows,total,page,limit});
    }
    if (method==='GET' && pathname==='/api/admin/hierarchy') {if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const rootId=Number(parsed.searchParams.get('rootId')||0);const depth=Math.min(3,Math.max(1,Number(parsed.searchParams.get('depth')||2)));const rows=rootId?db.prepare(`WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM users WHERE id=? UNION ALL SELECT u.id,t.depth+1 FROM users u JOIN tree t ON u.referred_by_user_id=t.id WHERE t.depth < ?) SELECT u.id,u.name,u.email,u.referral_code,u.referred_by_user_id,u.network_count,u.membership_status,u.role FROM users u JOIN tree t ON t.id=u.id WHERE u.role='MEMBER' OR u.id=? ORDER BY t.depth,u.id`).all(rootId,depth,rootId):db.prepare("SELECT id,name,email,referral_code,referred_by_user_id,network_count,membership_status,role FROM users WHERE role='MEMBER' AND referred_by_user_id IS NULL ORDER BY id").all();return json(res,rows);}
    if (method==='GET' && pathname==='/api/admin/hierarchy/children') {if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const parent=Number(parsed.searchParams.get('parentId'));if(!parent)return json(res,{error:'parentId required'},400);return json(res,db.prepare("SELECT id,name,email,referral_code,referred_by_user_id,network_count,membership_status,role FROM users WHERE referred_by_user_id=? ORDER BY id").all(parent));}
    if (method==='GET' && pathname==='/api/admin/auto-pool') {if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const rootId=Number(parsed.searchParams.get('rootId')||0);const depth=Math.min(AUTO_POOL_REWARDED_DEPTHS,Math.max(1,Number(parsed.searchParams.get('depth')||3)));let anchor=null;if(rootId)anchor=userById(rootId);else anchor=db.prepare("SELECT * FROM users WHERE auto_pool_position IS NOT NULL AND auto_pool_status='ACTIVE' ORDER BY auto_pool_position LIMIT 1").get();if(!anchor?.auto_pool_position)return json(res,{active:false,nodes:[],stageCounts:{1:0,2:0,3:0}});return json(res,memberAutoPoolSnapshot(anchor.id,'admin',depth));}
    if (method==='GET' && pathname==='/api/admin/auto-pool/children') {if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const parent=Number(parsed.searchParams.get('parentId'));if(!parent)return json(res,{error:'parentId required'},400);return json(res,autoPoolChildren(parent));}
    if (method==='GET' && pathname.startsWith('/api/admin/member/')) {if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const id=Number(pathname.split('/').pop()),member=userById(id);if(!member)return json(res,{error:'Not found'},404);audit(admin.id,'VIEW_MEMBER','USER',id,{},req);return json(res,{member:{...member,password_hash:undefined},verifiedReferrals:verifiedCount(id),network:networkCount(id),autoPool:memberAutoPoolSnapshot(id,'admin'),refs:db.prepare("SELECT u.id,u.name,u.email,u.referral_code,r.status FROM referrals r JOIN users u ON u.id=r.referred_user_id WHERE r.referrer_id=? ORDER BY r.id DESC").all(id),rewards:db.prepare('SELECT r.name,r.description,ur.status,ur.unlocked_at,ur.claimed_at,ur.shipped_at,ur.delivered_at FROM user_rewards ur JOIN rewards r ON r.id=ur.reward_id WHERE ur.user_id=?').all(id),activity:db.prepare('SELECT * FROM activity_events WHERE user_id=? ORDER BY id DESC LIMIT 30').all(id)});}
    if (method==='GET' && pathname==='/api/admin/rewards') {if(!can(['REWARD_ADMIN']))return json(res,{error:'Forbidden'},403);return json(res,db.prepare('SELECT * FROM rewards ORDER BY sort_order,id').all());}
    if (method==='GET' && pathname==='/api/admin/products') {if(!can(['CONTENT_ADMIN']))return json(res,{error:'Forbidden'},403);return json(res,db.prepare('SELECT * FROM store_products ORDER BY sort_order,id').all());}
    if (method==='GET' && pathname==='/api/admin/audit') {if(!can(['SUPER_ADMIN']))return json(res,{error:'Forbidden'},403);const limit=Math.min(100,Number(parsed.searchParams.get('limit')||50));return json(res,db.prepare('SELECT a.*,u.name actor_name,u.email actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.id DESC LIMIT ?').all(limit));}
    if (method==='GET' && pathname==='/api/admin/analytics') {if(!can(['SUPER_ADMIN','ADMIN']))return json(res,{error:'Forbidden'},403);const days=Math.min(365,Math.max(7,Number(parsed.searchParams.get('days')||30)));const labels=[],members=[],refs=[],payments=[];for(let i=days-1;i>=0;i--){const day=new Date(Date.now()-i*86400000);const key=day.toISOString().slice(0,10);labels.push(key);members.push(db.prepare("SELECT COUNT(*) c FROM users WHERE role='MEMBER' AND substr(created_at,1,10)=?").get(key).c);refs.push(db.prepare("SELECT COUNT(*) c FROM referrals WHERE status='VERIFIED' AND substr(verified_at,1,10)=?").get(key).c);payments.push(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM memberships WHERE status='PAID' AND substr(paid_at,1,10)=?").get(key).s);}return json(res,{labels,members,refs,payments});}
    if (method==='PATCH' && pathname.startsWith('/api/admin/members/')) {if(!can(['MEMBER_ADMIN']))return json(res,{error:'Forbidden'},403);const id=Number(pathname.split('/').pop()),b=await body(req),status=['ACTIVE','PENDING','DISABLED'].includes(b.status)?b.status:null;if(!status)return json(res,{error:'Invalid status'},400);db.prepare('UPDATE users SET membership_status=? WHERE id=? AND role=\'MEMBER\'').run(status,id);audit(admin.id,'UPDATE_MEMBER_STATUS','USER',id,{status},req);return json(res,{ok:true});}
    if (method==='PATCH' && pathname.startsWith('/api/admin/rewards/')) {if(!can(['REWARD_ADMIN']))return json(res,{error:'Forbidden'},403);const id=Number(pathname.split('/').pop()),b=await body(req);const name=String(b.name||'').trim();const reqs=Math.max(1,Math.min(100000,Number(b.required_referrals||5)));if(!name)return json(res,{error:'Reward name required'},400);db.prepare('UPDATE rewards SET name=?,description=?,image_url=?,required_referrals=?,active=? WHERE id=?').run(name,String(b.description||''),String(b.image_url||'/assets/images/reward-mic-speaker.svg'),reqs,b.active===false?0:1,id);audit(admin.id,'UPDATE_REWARD','REWARD',id,{name,required_referrals:reqs},req);return json(res,{ok:true});}
    if (method==='PATCH' && pathname.startsWith('/api/admin/products/')) {
      if(!can(['CONTENT_ADMIN']))return json(res,{error:'Forbidden'},403);
      const id=Number(pathname.split('/').pop());
      const b=await body(req, UPLOAD_MAX_BYTES + 512 * 512);
      const name=String(b.name||'').trim();
      if(!name)return json(res,{error:'Product name required.'},400);
      let imageUrl=String(b.image_url||'').trim();
      if(/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageUrl)) imageUrl=await saveUploadedImage(imageUrl,'product');
      db.prepare('UPDATE store_products SET name=?,description=?,image_url=?,badge=?,sort_order=?,active=? WHERE id=?').run(name,String(b.description||''),imageUrl,String(b.badge||''),Number(b.sort_order||0),b.active===false?0:1,id);
      audit(admin.id,'UPDATE_PRODUCT','PRODUCT',id,{name,description:String(b.description||''),image_url:imageUrl,badge:String(b.badge||''),sort_order:Number(b.sort_order||0),active:b.active===false?0:1},req);
      return json(res,{ok:true,imageUrl});
    }
    if (method==='POST' && pathname==='/api/admin/rewards') {if(!can(['REWARD_ADMIN']))return json(res,{error:'Forbidden'},403);const b=await body(req);const name=String(b.name||'').trim();const reqs=Math.max(1,Math.min(100000,Number(b.required_referrals||5)));if(!name)return json(res,{error:'Reward name required'},400);const r=db.prepare('INSERT INTO rewards(name,description,image_url,required_referrals,active) VALUES(?,?,?,?,1)').run(name,String(b.description||''),String(b.image_url||'/assets/images/reward-mic-speaker.svg'),reqs);audit(admin.id,'CREATE_REWARD','REWARD',Number(r.lastInsertRowid),b,req);return json(res,{ok:true});}
    if (method==='POST' && pathname==='/api/admin/products') {
      if(!can(['CONTENT_ADMIN']))return json(res,{error:'Forbidden'},403);
      const b=await body(req, UPLOAD_MAX_BYTES + 512 * 512);
      const name=String(b.name||'').trim();
      if(!name)return json(res,{error:'Product name required.'},400);
      let imageUrl=String(b.image_url||'').trim();
      if(/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageUrl)) imageUrl=await saveUploadedImage(imageUrl,'product');
      const description=String(b.description||''),badge=String(b.badge||''),sortOrder=Number(b.sort_order||0);
      const r=db.prepare('INSERT INTO store_products(name,description,image_url,badge,sort_order,active) VALUES(?,?,?,?,?,1)').run(name,description,imageUrl,badge,sortOrder);
      audit(admin.id,'CREATE_PRODUCT','PRODUCT',Number(r.lastInsertRowid),{name,description,image_url:imageUrl,badge,sort_order:sortOrder},req);
      return json(res,{ok:true,id:Number(r.lastInsertRowid),imageUrl});
    }
    if (method==='DELETE' && pathname.startsWith('/api/admin/products/')) {
      if(!can(['CONTENT_ADMIN']))return json(res,{error:'Forbidden'},403);
      const id=Number(pathname.split('/').pop());
      const p=db.prepare('SELECT * FROM store_products WHERE id=?').get(id);
      if(!p)return json(res,{error:'Product not found'},404);
      db.prepare('UPDATE store_products SET active=0 WHERE id=?').run(id);
      audit(admin.id,'REMOVE_FEATURED_PRODUCT','PRODUCT',id,{name:p.name},req);
      return json(res,{ok:true});
    }
    if (method==='POST' && pathname.startsWith('/api/admin/rewards/claim/')) {if(!can(['REWARD_ADMIN']))return json(res,{error:'Forbidden'},403);const id=Number(pathname.split('/').pop());db.prepare("UPDATE user_rewards SET status='CLAIMED',claimed_at=CURRENT_TIMESTAMP WHERE id=?").run(id);audit(admin.id,'CLAIM_REWARD','USER_REWARD',id,{},req);return json(res,{ok:true});}
    if (method==='POST' && pathname.startsWith('/api/admin/rewards/status/')) {
      if(!can(['REWARD_ADMIN']))return json(res,{error:'Forbidden'},403);
      const id=Number(pathname.split('/').pop()),b=await body(req),status=['UNLOCKED','CLAIMED','PROCESSING','SHIPPED','DELIVERED','CANCELLED'].includes(b.status)?b.status:null;
      if(!status)return json(res,{error:'Invalid reward status'},400);
      const cols={SHIPPED:'shipped_at',DELIVERED:'delivered_at'};
      db.prepare(`UPDATE user_rewards SET status=?${cols[status] ? `,${cols[status]}=CURRENT_TIMESTAMP` : ''} WHERE id=?`).run(status,id);
      const ur=db.prepare('SELECT ur.user_id,r.name FROM user_rewards ur JOIN rewards r ON r.id=ur.reward_id WHERE ur.id=?').get(id);
      audit(admin.id,'UPDATE_REWARD_STATUS','USER_REWARD',id,{status},req);
      if(ur){addNotify(ur.user_id,'Reward status updated',`Your reward is now marked ${status.toLowerCase()}.`);addActivity(ur.user_id,'REWARD','Reward status updated',`Your reward is now ${status.toLowerCase()}.`);const u2=userById(ur.user_id);if(u2)void sendBusinessEmail(u2.email,'Laksh reward update','Your reward status was updated',`Your ${ur.name} reward is now marked ${status.toLowerCase()}.`);}
      return json(res,{ok:true});
    }
    return json(res,{error:'Not found'},404);
  }

  return json(res,{error:'Not found'},404);
}

const server=http.createServer((req,res)=>handle(req,res).catch(e=>{console.error('[SERVER ERROR]',e);json(res,{error:e.status===413?'Request too large':'Server error'},e.status||500);}));
server.listen(PORT,()=>console.log(`${APP_NAME} running on http://localhost:${PORT}`));
