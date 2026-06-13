// Vyrrah Recaller — missed-call recovery engine for local practices
// All routes under /api/tool/... (see vercel.json: tool route ABOVE index catch-all)

const crypto = require('crypto');
const twilio = require('twilio');
const { getSupabase } = require('./_lib/supabase');
const { requireAuth, cors } = require('./_lib/auth');

const BRAND = { name: 'Vyrrah Recaller', from: 'Vyrrah Labs' }; // single place to rename later

const VOICE_URL = 'https://vyrrahlabs.com/api/tool/voice';
const SMS_URL = 'https://vyrrahlabs.com/api/tool/sms';
const PUBLIC_BASE = 'https://vyrrahlabs.com';
const SMS_STATUS_CALLBACK = 'https://vyrrahlabs.com/api/tool/sms-status';

// Twilio status callback path used when creating outbound messages
const SMS_STATUS_PATH = '/api/tool/sms-status';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTwilioClient() {
  return new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Best-effort in-memory rate limiter (per serverless instance). Map<ip, ts[]>.
const _rateBuckets = new Map();
function rateLimit(req, { max = 10, windowMs = 60000 } = {}) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim() ||
    req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const hits = (_rateBuckets.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  _rateBuckets.set(ip, hits);
  return hits.length <= max;
}

function twiml(res, xmlInner = '') {
  res.setHeader('Content-Type', 'text/xml');
  return res
    .status(200)
    .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xmlInner}</Response>`);
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 7) return s;
  return s.slice(0, 5) + '•••' + s.slice(-4);
}

// Toll-free / short-code detection — skip text-backs to these
function isNonTextableCaller(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return true;
  if (digits.length <= 7) return true; // short code
  const tollFree = ['800', '888', '877', '866', '855', '844', '833'];
  // US numbers: 1NXXNXXXXXX or NXXNXXXXXX
  const area = digits.length === 11 && digits.startsWith('1') ? digits.slice(1, 4) : digits.slice(0, 3);
  return tollFree.includes(area);
}

// ─── #3 Spam / robocall detection ────────────────────────────────────────────
// Conservative pattern check on the raw digits (no DB). Returns true only on
// clearly-bogus shapes to avoid false positives on real callers.
function looksLikeSpamNumber(phone) {
  let d = normalizePhone(phone);
  if (!d) return true;
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return false; // unusual length — let other checks decide
  // All-same digits e.g. 1111111111.
  if (/^(\d)\1{9}$/.test(d)) return true;
  // Strictly sequential ascending/descending (e.g. 1234567890 / 0123456789).
  if (d === '1234567890' || d === '0123456789' || d === '9876543210') return true;
  // Obvious test/fake ranges.
  if (/^555555/.test(d)) return true;
  return false;
}

// Full spam check (DB-aware). Returns true if the caller should NOT get a textback.
async function isLikelySpam(supabase, client, callerPhone) {
  try {
    const digits = normalizePhone(callerPhone);
    // 1) Blocklist for this client.
    try {
      const { data: blocked } = await supabase
        .from('tool_blocklist')
        .select('id')
        .eq('client_id', client.id)
        .eq('phone', digits)
        .limit(1);
      if (blocked && blocked[0]) return true;
    } catch (e) { /* ignore */ }
    // 2) Non-textable (toll-free / short code).
    if (isNonTextableCaller(callerPhone)) return true;
    // 3) Obvious bogus number shapes.
    if (looksLikeSpamNumber(callerPhone)) return true;
    // 4) Repeat-no-engagement robocaller: >=4 missed calls AND zero inbound messages ever.
    try {
      const missedOutcomes = ['missed', 'busy', 'failed', 'voicemail'];
      const { data: priorCalls } = await supabase
        .from('tool_calls')
        .select('outcome')
        .eq('client_id', client.id)
        .eq('caller_phone', callerPhone)
        .limit(50);
      const missedCount = (priorCalls || []).filter((c) => missedOutcomes.includes(c.outcome)).length;
      if (missedCount >= 4) {
        const { data: inbound } = await supabase
          .from('tool_messages')
          .select('id')
          .eq('client_id', client.id)
          .eq('caller_phone', callerPhone)
          .eq('direction', 'inbound')
          .limit(1);
        if (!inbound || !inbound[0]) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  } catch (e) {
    console.error('isLikelySpam error:', e);
    return false; // fail-open: never block a real caller on error
  }
}

async function sendEmail({ to, toName, subject, body }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'godwin@vyrrahlabs.com';
  if (!apiKey) throw new Error('SENDGRID_API_KEY not configured');

  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: toName || '' }] }],
      from: { email: fromEmail, name: BRAND.from },
      subject,
      content: [{ type: 'text/plain', value: body }]
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`SendGrid error ${r.status}: ${err}`);
  }
  return { status: r.status };
}

// AI message generation — OpenAI gpt-5-nano preferred, Anthropic (Claude) fallback, templates if neither
function aiAvailable() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}
async function generateAiMessage({ client, history = [], purpose, fallback, contactName = null }) {
  if (!aiAvailable()) return fallback;
  let system =
    `You are the friendly front-desk assistant for ${client.practice_name}, a local practice. ` +
    `Services: ${client.services || 'general services'}. ` +
    `Business hours: ${client.business_hours || 'standard business hours'}. ` +
    (client.booking_link ? `Booking link: ${client.booking_link}. ` : '');
  if (contactName) {
    system += `The caller's name is ${contactName}, use it naturally. `;
  }
  system +=
    `Write as the practice itself in a warm, human tone. ${purpose} ` +
    `Keep it to 1-2 short sentences suitable for SMS. No emojis, no sign-offs.`;

  const turns = [];
  for (const m of history) {
    turns.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body || '' });
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    turns.push({ role: 'user', content: 'Write the SMS now.' });
  }

  try {
    if (process.env.OPENAI_API_KEY) {
      // Primary: OpenAI gpt-5-nano (standard /v1/chat/completions shape).
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-nano', max_tokens: 120, messages: [{ role: 'system', content: system }, ...turns] })
      });
      if (!r.ok) { console.error('OpenAI error', r.status, await r.text()); return fallback; }
      const data = await r.json();
      return data?.choices?.[0]?.message?.content?.trim() || fallback;
    }
    // Secondary fallback: Anthropic Claude.
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 120, system, messages: turns })
    });
    if (!r.ok) { console.error('Anthropic error', r.status, await r.text()); return fallback; }
    const data = await r.json();
    const text = (data?.content || []).map(b => b.text || '').join('').trim();
    return text || fallback;
  } catch (err) {
    console.error('AI call failed:', err);
    return fallback;
  }
}

// ─── #2 Contact name capture ─────────────────────────────────────────────────
async function getContactName(supabase, clientId, phone) {
  try {
    const digits = normalizePhone(phone);
    if (!digits) return null;
    const { data } = await supabase
      .from('tool_contacts')
      .select('name')
      .eq('client_id', clientId)
      .eq('phone', digits)
      .limit(1);
    const row = data && data[0];
    return (row && row.name) ? row.name : null;
  } catch (e) {
    console.error('getContactName error:', e);
    return null;
  }
}

async function saveContactName(supabase, clientId, phone, name) {
  try {
    const digits = normalizePhone(phone);
    const clean = (name || '').trim().slice(0, 80);
    if (!digits || !clean) return;
    await supabase.from('tool_contacts').upsert({
      client_id: clientId,
      phone: digits,
      name: clean,
      first_seen: new Date().toISOString()
    }, { onConflict: 'client_id,phone' });
  } catch (e) {
    console.error('saveContactName error:', e);
  }
}

// Heuristic name extraction from an inbound reply. Returns a name string or null.
// `askedForName` should be true if our last outbound asked for the caller's name.
const _BOOKING_WORDS = /\b(yes|yeah|yep|sure|ok|okay|book|booking|appointment|appt|schedule|reschedule|cancel|availab|slot|time|today|tomorrow|morning|afternoon|evening|stop|help|call|details)\b/i;
function extractName(body, askedForName) {
  const raw = (body || '').trim();
  if (!raw) return null;
  // Explicit patterns first: "it's John", "this is John", "I'm John", "my name is John".
  const m = /\b(?:it'?s|this is|i'?m|i am|my name is|name'?s)\s+([A-Za-z][A-Za-z'-]{1,30})(?:\s+([A-Za-z][A-Za-z'-]{1,30}))?/i.exec(raw);
  if (m) {
    const name = [m[1], m[2]].filter(Boolean).join(' ');
    if (!_BOOKING_WORDS.test(name)) return titleCaseName(name);
  }
  // If we just asked for the name and the reply is short & not a command/booking word.
  if (askedForName) {
    const words = raw.split(/\s+/);
    if (words.length <= 4 && !_BOOKING_WORDS.test(raw) && !/\d/.test(raw) && /[A-Za-z]/.test(raw)) {
      const cleaned = raw.replace(/[^A-Za-z'\- ]/g, '').trim();
      if (cleaned && cleaned.length <= 40) return titleCaseName(cleaned);
    }
  }
  return null;
}
function titleCaseName(s) {
  return s.split(/\s+/).map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ').slice(0, 80);
}

// Has this caller opted out (STOP) for this client?
async function callerOptedOut(supabase, clientId, callerPhone) {
  const { data } = await supabase
    .from('tool_messages')
    .select('body')
    .eq('client_id', clientId)
    .eq('caller_phone', callerPhone)
    .eq('direction', 'inbound');
  return (data || []).some((m) => /^\s*(stop|unsubscribe)\s*$/i.test(m.body || ''));
}

// ─── #10 Error alerting to Godwin (throttled) ────────────────────────────────
const GODWIN_EMAIL = 'godwin@vyrrahlabs.com';
async function alertGodwin(supabase, kind, detail) {
  try {
    const detailStr = (typeof detail === 'string' ? detail : (detail && detail.message) || JSON.stringify(detail || {})).slice(0, 500);
    // Throttle: max 1 alert per kind per 60 min.
    try {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: recent } = await supabase
        .from('tool_alerts')
        .select('id')
        .eq('kind', kind)
        .gte('created_at', cutoff)
        .limit(1);
      if (recent && recent[0]) return; // already alerted recently
    } catch (e) { /* if throttle check fails, still try to alert once */ }

    // Record the alert first so concurrent calls throttle.
    try {
      await supabase.from('tool_alerts').insert({ kind, detail: detailStr, created_at: new Date().toISOString() });
    } catch (e) { console.error('alertGodwin insert error:', e); }

    const godwinPhone = process.env.GODWIN_PHONE || '+918778974646';
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    if (fromNumber && godwinPhone) {
      try {
        await getTwilioClient().messages.create({
          from: fromNumber,
          to: godwinPhone,
          body: `Vyrrah alert [${kind}]: ${detailStr}`
        });
      } catch (e) { console.error('alertGodwin SMS failed:', e); }
    }
    try {
      await sendEmail({
        to: GODWIN_EMAIL,
        toName: 'Godwin',
        subject: `Vyrrah Recaller alert: ${kind}`,
        body: `Kind: ${kind}\n\nDetail:\n${detailStr}\n\nTime: ${new Date().toISOString()}`
      });
    } catch (e) { console.error('alertGodwin email failed:', e); }
  } catch (err) {
    console.error('alertGodwin fatal (ignored):', err);
  }
}

// Detect a systemic (account-level) Twilio failure vs a per-number issue.
function isSystemicTwilioError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return /authenticate|not enabled|unverified|permission|forbidden|credentials/.test(msg);
}

async function sendSms(twilioClient, { from, to, body }) {
  const msg = await twilioClient.messages.create({
    from,
    to,
    body,
    statusCallback: SMS_STATUS_CALLBACK
  });
  return msg;
}

// ─── Twilio webhook signature validation ─────────────────────────────────────
// Matches api/index.js pattern: warn-and-continue, unless STRICT_TWILIO=1 -> 403.
// Returns true if the request should proceed, false if it was rejected (403 sent).
function validateTwilioWebhook(req, res) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  // Full URL must match what Twilio signed. We register webhooks against
  // https://vyrrahlabs.com + the request path (req.url includes ?path=... query
  // that Vercel rewrites add; strip our internal rewrite query for a clean URL).
  const fullUrl = PUBLIC_BASE + (req.url || '').split('?')[0];
  const params = req.body || {};
  let valid = false;
  try {
    valid = !!authToken && twilio.validateRequest(authToken, signature, fullUrl, params);
  } catch (e) {
    valid = false;
  }
  if (!valid) {
    console.warn('Invalid/missing Twilio signature on', req.url);
    if (process.env.STRICT_TWILIO === '1') {
      res.status(403).end();
      return false;
    }
  }
  return true;
}

// ─── TCPA quiet-hours guard ──────────────────────────────────────────────────
// Fixed UTC offsets for common US zones (DST ignored — "close enough" per spec).
const TZ_OFFSETS = {
  'America/New_York': -5,
  'America/Chicago': -6,
  'America/Denver': -7,
  'America/Los_Angeles': -8,
  'America/Phoenix': -7
};

// Returns the client's current local hour (0-23) and a helper to convert a
// local hour to a UTC Date. Tries Intl first, falls back to the offset map.
function clientLocalClock(client, now = new Date()) {
  const tz = client.timezone || 'America/New_York';
  // Try Intl.DateTimeFormat (honours real DST when the runtime has tz data).
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour');
    if (hourPart) {
      let hour = parseInt(hourPart.value, 10);
      if (hour === 24) hour = 0;
      if (!Number.isNaN(hour)) {
        return { hour, tz, usedIntl: true };
      }
    }
  } catch (e) {
    // fall through to offset map
  }
  const offset = TZ_OFFSETS[tz] != null ? TZ_OFFSETS[tz] : -5;
  const localMs = now.getTime() + offset * 3600 * 1000;
  const hour = new Date(localMs).getUTCHours();
  return { hour, tz, offset, usedIntl: false };
}

// quiet 21->8 means quiet hours are [21,24) ∪ [0,8) — i.e. 9pm to 8am.
function isQuietHour(hour, quietStart, quietEnd) {
  const qs = Number.isFinite(quietStart) ? quietStart : 21;
  const qe = Number.isFinite(quietEnd) ? quietEnd : 8;
  if (qs === qe) return false;
  if (qs < qe) return hour >= qs && hour < qe; // simple daytime window
  return hour >= qs || hour < qe;              // overnight wrap
}

// Compute the next allowed send time (UTC ISO) = upcoming quiet_end hour in
// client-local time. Returns an ISO string.
function nextAllowedSendUtc(client, now = new Date()) {
  const tz = client.timezone || 'America/New_York';
  const quietEnd = Number.isFinite(client.quiet_end) ? client.quiet_end : 8;
  const offset = TZ_OFFSETS[tz] != null ? TZ_OFFSETS[tz] : -5;
  // Build "today at quiet_end" in client local, expressed in UTC via offset.
  // local time T (client) corresponds to UTC = T - offset.
  const localNowMs = now.getTime() + offset * 3600 * 1000;
  const localNow = new Date(localNowMs);
  const target = new Date(Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    quietEnd, 0, 0, 0
  ));
  // Convert that client-local target back to real UTC.
  let targetUtcMs = target.getTime() - offset * 3600 * 1000;
  // If that moment is already in the past (or now), push to next day.
  if (targetUtcMs <= now.getTime()) targetUtcMs += 24 * 3600 * 1000;
  return new Date(targetUtcMs).toISOString();
}

// Send-or-defer wrapper. If currently in the client's quiet hours, persists the
// message as 'deferred' (no send) and returns { deferred: true }. Otherwise
// sends via Twilio, persists as queued with the twilio_sid, returns { sid }.
async function sendOrDefer(supabase, client, { call_id, caller, body, ai_generated }) {
  const { hour } = clientLocalClock(client);
  const quiet = isQuietHour(hour, client.quiet_start, client.quiet_end);
  if (quiet) {
    const deferred_until = nextAllowedSendUtc(client);
    const { error } = await supabase.from('tool_messages').insert({
      client_id: client.id,
      call_id: call_id || null,
      caller_phone: caller,
      direction: 'outbound',
      body,
      ai_generated: !!ai_generated,
      delivery_status: 'deferred',
      deferred_until
    });
    if (error) console.error('defer insert error:', error);
    return { deferred: true, deferred_until };
  }
  // Log the row FIRST so a send failure is always traceable, then send.
  const { data: row, error } = await supabase.from('tool_messages').insert({
    client_id: client.id,
    call_id: call_id || null,
    caller_phone: caller,
    direction: 'outbound',
    body,
    ai_generated: !!ai_generated,
    delivery_status: 'queued'
  }).select().single();
  if (error) console.error('outbound insert error:', error);
  try {
    const msg = await sendSms(getTwilioClient(), { from: client.twilio_number, to: caller, body });
    if (row) await supabase.from('tool_messages').update({ twilio_sid: msg.sid }).eq('id', row.id);
    return { sid: msg.sid };
  } catch (sendErr) {
    console.error('SMS send failed:', sendErr.message);
    if (row) await supabase.from('tool_messages').update({ delivery_status: 'failed' }).eq('id', row.id);
    return { error: sendErr.message };
  }
}

async function computeStats(supabase, clientId, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data: calls, error } = await supabase
    .from('tool_calls')
    .select('*')
    .eq('client_id', clientId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const all = calls || [];
  const missedOutcomes = ['missed', 'busy', 'failed', 'voicemail'];
  const missed = all.filter((c) => missedOutcomes.includes(c.outcome));
  const recovered = all.filter((c) => c.recovered);

  const perDay = {};
  for (const c of all) {
    const day = (c.created_at || '').slice(0, 10);
    if (!perDay[day]) perDay[day] = { total: 0, missed: 0, textbacks_sent: 0, recovered: 0, booked: 0 };
    perDay[day].total++;
    if (missedOutcomes.includes(c.outcome)) perDay[day].missed++;
    if (c.textback_sent) perDay[day].textbacks_sent++;
    if (c.recovered) perDay[day].recovered++;
    if (c.booked) perDay[day].booked++;
  }

  return {
    days,
    total_calls: all.length,
    missed: missed.length,
    textbacks_sent: all.filter((c) => c.textback_sent).length,
    recovered: recovered.length,
    booked: all.filter((c) => c.booked).length,
    est_revenue_saved: recovered.reduce((sum, c) => sum + (Number(c.est_value) || 0), 0),
    per_day: perDay
  };
}

// Try to assign an available number from number_pool instantly (no Twilio call).
// Prefers a matching area_code, else any available row. Returns the updated
// client on success, or null if the pool had nothing to give.
async function assignFromPool(supabase, client, areaCode) {
  try {
    let row = null;
    if (areaCode) {
      const { data } = await supabase
        .from('number_pool')
        .select('*')
        .eq('status', 'available')
        .eq('area_code', areaCode)
        .limit(1);
      row = data && data[0];
    }
    if (!row) {
      const { data } = await supabase
        .from('number_pool')
        .select('*')
        .eq('status', 'available')
        .limit(1);
      row = data && data[0];
    }
    if (!row) return null;

    // Claim the pool row (guard against double-assign via status filter).
    const { data: claimed, error: claimErr } = await supabase
      .from('number_pool')
      .update({ status: 'assigned', assigned_client_id: client.id })
      .eq('id', row.id)
      .eq('status', 'available')
      .select()
      .single();
    if (claimErr || !claimed) return null;

    const { data: updated, error } = await supabase
      .from('tool_clients')
      .update({ twilio_number: claimed.phone_number, twilio_number_sid: claimed.number_sid })
      .eq('id', client.id)
      .select()
      .single();
    if (error) {
      // Roll the pool row back so it isn't stranded.
      await supabase.from('number_pool')
        .update({ status: 'available', assigned_client_id: null })
        .eq('id', claimed.id);
      throw error;
    }
    return updated;
  } catch (e) {
    console.error('assignFromPool error:', e);
    return null;
  }
}

// ─── #9 Number-pool auto-refill ──────────────────────────────────────────────
// Buy `count` numbers (cap 10), wire webhooks, insert as available pool rows.
// Returns { added, numbers, errors }. Shared by handlePoolRefill + ensurePoolStock.
async function buyPoolNumbers(supabase, count, areaCode) {
  let n = parseInt(count, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > 10) n = 10; // hard cap — never buy more than 10 in one pass
  const tw = getTwilioClient();
  const bought = [];
  const errors = [];
  for (let i = 0; i < n; i++) {
    try {
      let avail = await tw
        .availablePhoneNumbers('US')
        .local.list(areaCode ? { areaCode, limit: 1 } : { limit: 1 });
      if ((!avail || !avail.length) && areaCode) {
        avail = await tw.availablePhoneNumbers('US').local.list({ limit: 1 });
      }
      if (!avail || !avail.length) { errors.push('no available numbers'); break; }

      const purchased = await tw.incomingPhoneNumbers.create({
        phoneNumber: avail[0].phoneNumber,
        voiceUrl: VOICE_URL,
        voiceMethod: 'POST',
        smsUrl: SMS_URL,
        smsMethod: 'POST'
      });

      const { data: row, error } = await supabase
        .from('number_pool')
        .insert({
          phone_number: purchased.phoneNumber,
          number_sid: purchased.sid,
          area_code: areaCode || null,
          status: 'available'
        })
        .select()
        .single();
      if (error) { errors.push(error.message); continue; }
      bought.push(row);
    } catch (e) {
      console.error('buyPoolNumbers buy error:', e);
      errors.push(e.message);
    }
  }
  return { added: bought.length, numbers: bought, errors };
}

// Top up the pool if available stock dips below `minAvailable`. Best-effort.
async function ensurePoolStock(supabase, minAvailable = 3, buyCount = 5) {
  try {
    const { data: rows, error } = await supabase
      .from('number_pool')
      .select('status')
      .eq('status', 'available');
    if (error) throw error;
    const available = (rows || []).length;
    if (available >= minAvailable) return { ok: true, available, bought: 0 };
    const result = await buyPoolNumbers(supabase, Math.min(buyCount, 10), null);
    if (result.errors && result.errors.length && result.added === 0) {
      await alertGodwin(supabase, 'pool_refill_failed', `ensurePoolStock bought 0; errors: ${result.errors.join('; ')}`);
    }
    return { ok: true, available, bought: result.added, errors: result.errors };
  } catch (e) {
    console.error('ensurePoolStock error:', e);
    await alertGodwin(supabase, 'pool_refill_failed', e);
    return { ok: false, error: e.message };
  }
}

async function provisionTwilioNumber(supabase, client, areaCode) {
  // Pool first — instant, no Twilio API call (webhooks already set at refill).
  const fromPool = await assignFromPool(supabase, client, areaCode);
  if (fromPool) {
    // #9 Proactively refill the pool (fire-and-forget) since we just consumed one.
    try { ensurePoolStock(supabase, 3, 5).catch((e) => console.error('proactive ensurePoolStock error:', e)); } catch (e) { /* ignore */ }
    return fromPool;
  }

  const tw = getTwilioClient();
  let numbers = [];
  try {
    numbers = await tw
      .availablePhoneNumbers('US')
      .local.list(areaCode ? { areaCode, limit: 1 } : { limit: 1 });
  } catch (e) {
    numbers = [];
  }
  if ((!numbers || !numbers.length) && areaCode) {
    numbers = await tw.availablePhoneNumbers('US').local.list({ limit: 1 });
  }
  if (!numbers || !numbers.length) throw new Error('No available phone numbers found');

  const purchased = await tw.incomingPhoneNumbers.create({
    phoneNumber: numbers[0].phoneNumber,
    voiceUrl: VOICE_URL,
    voiceMethod: 'POST',
    smsUrl: SMS_URL,
    smsMethod: 'POST'
  });

  const { data: updated, error } = await supabase
    .from('tool_clients')
    .update({ twilio_number: purchased.phoneNumber, twilio_number_sid: purchased.sid })
    .eq('id', client.id)
    .select()
    .single();
  if (error) throw error;
  return updated;
}

// Mark that an inbound call hit this client's tool number. First-ever inbound
// also proves call-forwarding works -> flip forwarding_verified true.
async function markInbound(supabase, client) {
  try {
    const now = new Date().toISOString();
    const patch = { last_inbound_at: now };
    if (!client.forwarding_verified) {
      patch.forwarding_verified = true;
      patch.verified_at = now;
    }
    await supabase.from('tool_clients').update(patch).eq('id', client.id);
  } catch (e) {
    console.error('markInbound error:', e);
  }
}

function forwardingInstructions(number) {
  return `Have the practice set conditional call forwarding (no-answer/busy) to ${number}`;
}

// Welcome email — fired once on successful client create. NEVER throws (so it
// can never fail the create request); flips welcome_sent=true on success.
async function sendWelcomeEmail(supabase, client) {
  try {
    if (!client || !client.owner_email || client.welcome_sent) return;
    const number = client.twilio_number || 'your Vyrrah number (being provisioned)';
    await sendEmail({
      to: client.owner_email,
      toName: client.owner_name,
      subject: 'Welcome to Vyrrah Recaller — save this email',
      body: [
        `Hi ${client.owner_name || 'there'},`,
        '',
        `Welcome to ${BRAND.name}! Here's everything you need.`,
        '',
        `Your Vyrrah number: ${number}`,
        `Set conditional call forwarding (no-answer/busy) on your line to that number, and we'll text back anyone you miss.`,
        '',
        `Your dashboard: ${PUBLIC_BASE}/recaller?token=${client.magic_token}`,
        '',
        'Questions? Just reply or reach Godwin at godwin@vyrrahlabs.com',
        '',
        `— ${BRAND.from}`
      ].join('\n')
    });
    await supabase.from('tool_clients').update({ welcome_sent: true }).eq('id', client.id);
  } catch (e) {
    console.error('sendWelcomeEmail error (non-fatal):', e);
  }
}

// ─── Booking / calendar helpers ──────────────────────────────────────────────

// Default availability if a client hasn't configured one (Mon-Fri 9-5 local).
const DEFAULT_AVAILABILITY = {
  mon: ['09:00', '17:00'],
  tue: ['09:00', '17:00'],
  wed: ['09:00', '17:00'],
  thu: ['09:00', '17:00'],
  fri: ['09:00', '17:00']
};
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Lead buffer before the first offered slot (don't offer "in 5 minutes").
const SLOT_LEAD_MS = 2 * 60 * 60 * 1000; // ~2h

// ── Timezone math (no external libs) ─────────────────────────────────────────
// We need two operations, both via Intl.DateTimeFormat with a timeZone:
//   1) Given a UTC instant, render a human label in the client's tz.
//   2) Given a desired wall-clock time in the client's tz on a given calendar
//      day, find the UTC instant for it.
// For (2) we derive the tz's UTC offset *at that instant* by formatting a probe
// Date in the tz and comparing the rendered wall-clock to the same fields read
// as UTC. This handles DST correctly because the offset is computed per-date.

// Offset (in minutes) of `tz` from UTC at the given instant. e.g. EST => -300.
function tzOffsetMinutes(tz, instant) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(instant).reduce((acc, p) => {
      acc[p.type] = p.value; return acc;
    }, {});
    let hour = parseInt(parts.hour, 10);
    if (hour === 24) hour = 0;
    // The wall-clock the tz shows, expressed as if it were UTC.
    const asUtc = Date.UTC(
      parseInt(parts.year, 10),
      parseInt(parts.month, 10) - 1,
      parseInt(parts.day, 10),
      hour,
      parseInt(parts.minute, 10),
      parseInt(parts.second, 10)
    );
    return Math.round((asUtc - instant.getTime()) / 60000);
  } catch (e) {
    // Fallback to the fixed offset map (DST ignored).
    const off = TZ_OFFSETS[tz] != null ? TZ_OFFSETS[tz] : -5;
    return off * 60;
  }
}

// Build the UTC Date for a given wall-clock (y,m,d,hh,mm) in `tz`.
// Two-pass: guess offset from a naive UTC build, then refine once (covers the
// rare case where the offset differs across a DST boundary near the target).
function wallClockToUtc(tz, year, monthIdx, day, hh, mm) {
  const naive = Date.UTC(year, monthIdx, day, hh, mm, 0);
  let offset = tzOffsetMinutes(tz, new Date(naive));
  let utcMs = naive - offset * 60000;
  const offset2 = tzOffsetMinutes(tz, new Date(utcMs));
  if (offset2 !== offset) utcMs = naive - offset2 * 60000;
  return new Date(utcMs);
}

// Human label like "Tomorrow 2:30 PM" / "Thu 10:00 AM" rendered in client's tz.
function slotLabel(startUtc, tz, now = new Date()) {
  try {
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    const timeFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
    });
    const ymdFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const keyOf = (d) => ymdFmt.format(d);
    const startKey = keyOf(startUtc);
    const todayKey = keyOf(now);
    const tomorrowKey = keyOf(new Date(now.getTime() + 24 * 3600 * 1000));
    let dayWord;
    if (startKey === todayKey) dayWord = 'Today';
    else if (startKey === tomorrowKey) dayWord = 'Tomorrow';
    else dayWord = dayFmt.format(startUtc);
    return `${dayWord} ${timeFmt.format(startUtc)}`;
  } catch (e) {
    return new Date(startUtc).toISOString();
  }
}

// The weekday key ('mon'...) for a UTC instant as seen in `tz`.
function weekdayKeyInTz(instant, tz) {
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .format(instant).toLowerCase().slice(0, 3);
    return wd;
  } catch (e) {
    return WEEKDAY_KEYS[instant.getUTCDay()];
  }
}

// Parse "HH:MM" -> {h,m}; null if malformed.
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

// ── Google Calendar (activates only when env creds + refresh token present) ──
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar';
const GOOGLE_REDIRECT_URI = `${PUBLIC_BASE}/api/tool/google/callback`;
const _googleTokenCache = new Map(); // client_id -> { token, exp }

function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Exchange a stored refresh token for a short-lived access token (cached).
async function googleAccessToken(client) {
  if (!googleConfigured() || !client || !client.google_refresh_token) return null;
  const cached = _googleTokenCache.get(client.id);
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: client.google_refresh_token,
        grant_type: 'refresh_token'
      }).toString()
    });
    if (!r.ok) { console.error('googleAccessToken error', r.status, await r.text()); return null; }
    const data = await r.json();
    if (!data.access_token) return null;
    const exp = Date.now() + ((data.expires_in || 3600) * 1000);
    _googleTokenCache.set(client.id, { token: data.access_token, exp });
    return data.access_token;
  } catch (e) {
    console.error('googleAccessToken failed:', e);
    return null;
  }
}

// Busy intervals from the client's Google calendar. Returns [{start,end}] (ISO).
async function googleFreeBusy(client, timeMinISO, timeMaxISO) {
  try {
    const token = await googleAccessToken(client);
    if (!token) return [];
    const calId = client.google_calendar_id || 'primary';
    const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: calId }] })
    });
    if (!r.ok) { console.error('googleFreeBusy error', r.status); return []; }
    const data = await r.json();
    const cal = (data.calendars && data.calendars[calId]) || {};
    return (cal.busy || []).map((b) => ({ start: b.start, end: b.end }));
  } catch (e) {
    console.error('googleFreeBusy failed:', e);
    return [];
  }
}

// Create an event; returns the Google event id or null on failure.
async function googleCreateEvent(client, { start, end, summary, description }) {
  try {
    const token = await googleAccessToken(client);
    if (!token) return null;
    const calId = client.google_calendar_id || 'primary';
    const tz = client.timezone || 'America/New_York';
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: summary || 'Appointment',
          description: description || '',
          start: { dateTime: start, timeZone: tz },
          end: { dateTime: end, timeZone: tz }
        })
      }
    );
    if (!r.ok) { console.error('googleCreateEvent error', r.status, await r.text()); return null; }
    const data = await r.json();
    return data.id || null;
  } catch (e) {
    console.error('googleCreateEvent failed:', e);
    return null;
  }
}

async function googleDeleteEvent(client, eventId) {
  try {
    if (!eventId) return;
    const token = await googleAccessToken(client);
    if (!token) return;
    const calId = client.google_calendar_id || 'primary';
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
    );
  } catch (e) {
    console.error('googleDeleteEvent failed:', e);
  }
}

// ── Slot computation ─────────────────────────────────────────────────────────
// Returns upcoming open slots as [{ start_at, end_at, label }].
// Approach: walk the next `days` calendar days; for each day look up the client's
// availability window for that weekday (in client tz); step slot_minutes from
// open to close, converting each wall-clock slot to a UTC instant via
// wallClockToUtc (DST-correct per-date). Keep only future slots beyond the lead
// buffer. Subtract overlapping existing appointments, and (google mode) Google
// busy intervals. Cap at maxSlots.
async function getOpenSlots(supabase, client, { days = 5, maxSlots = 3 } = {}) {
  const tz = client.timezone || 'America/New_York';
  const slotMin = Number(client.slot_minutes) > 0 ? Number(client.slot_minutes) : 30;
  const availability = (client.availability && typeof client.availability === 'object')
    ? client.availability : DEFAULT_AVAILABILITY;
  const now = new Date();
  const earliest = now.getTime() + SLOT_LEAD_MS;
  const windowEnd = new Date(now.getTime() + (days + 1) * 24 * 3600 * 1000);

  // Existing appts that block slots.
  let busy = [];
  try {
    const { data: appts } = await supabase
      .from('tool_appointments')
      .select('start_at, end_at, status')
      .eq('client_id', client.id)
      .in('status', ['booked', 'confirmed'])
      .gte('end_at', now.toISOString())
      .lte('start_at', windowEnd.toISOString());
    busy = (appts || []).map((a) => ({
      start: new Date(a.start_at).getTime(), end: new Date(a.end_at).getTime()
    }));
  } catch (e) {
    console.error('getOpenSlots appt lookup error:', e);
  }

  // Google busy (best-effort; failure falls back to native-only).
  if (client.booking_mode === 'google' && client.google_refresh_token) {
    try {
      const gb = await googleFreeBusy(client, now.toISOString(), windowEnd.toISOString());
      for (const b of gb) {
        busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
      }
    } catch (e) {
      console.error('getOpenSlots google freebusy error (ignored):', e);
    }
  }

  const overlaps = (s, e) => busy.some((b) => s < b.end && e > b.start);

  const slots = [];
  // Iterate calendar days starting today, using each day's date as seen in tz.
  for (let d = 0; d <= days && slots.length < maxSlots; d++) {
    const dayInstant = new Date(now.getTime() + d * 24 * 3600 * 1000);
    // Get the y/m/d for this day as seen in the client tz.
    let ymd;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(dayInstant).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
      ymd = { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10) - 1, d: parseInt(parts.day, 10) };
    } catch (e) {
      ymd = { y: dayInstant.getUTCFullYear(), m: dayInstant.getUTCMonth(), d: dayInstant.getUTCDate() };
    }
    // Weekday window. Use a noon-of-day probe instant to read the weekday safely.
    const probe = wallClockToUtc(tz, ymd.y, ymd.m, ymd.d, 12, 0);
    const wdKey = weekdayKeyInTz(probe, tz);
    const win = availability[wdKey];
    if (!Array.isArray(win) || win.length < 2) continue;
    const open = parseHM(win[0]);
    const close = parseHM(win[1]);
    if (!open || !close) continue;

    let cursorMin = open.h * 60 + open.m;
    const closeMin = close.h * 60 + close.m;
    for (; cursorMin + slotMin <= closeMin && slots.length < maxSlots; cursorMin += slotMin) {
      const hh = Math.floor(cursorMin / 60), mm = cursorMin % 60;
      const startUtc = wallClockToUtc(tz, ymd.y, ymd.m, ymd.d, hh, mm);
      const startMs = startUtc.getTime();
      if (startMs < earliest) continue;
      const endMs = startMs + slotMin * 60000;
      if (overlaps(startMs, endMs)) continue;
      slots.push({
        start_at: new Date(startMs).toISOString(),
        end_at: new Date(endMs).toISOString(),
        label: slotLabel(startUtc, tz, now)
      });
    }
  }
  return slots;
}

// ── Slot-offer tracking (dual approach) ──────────────────────────────────────
// Primary: an in-memory Map keyed `${client_id}:${caller}` -> { slots, ts }.
// Serverless instances are warm for minutes and the same caller usually reuses
// the same instance, so a numbered reply within minutes hits this cache.
// Fallback (cold start / evicted): when a caller replies with just a number and
// the cache is empty, we regenerate getOpenSlots and map the number to the Nth
// current slot. The offered set is stable over short windows, so this is robust.
const _offeredSlots = new Map();
const OFFER_TTL_MS = 30 * 60 * 1000;
function stashOffer(clientId, caller, slots) {
  _offeredSlots.set(`${clientId}:${caller}`, { slots, ts: Date.now() });
}
function getOfferedSlots(clientId, caller) {
  const v = _offeredSlots.get(`${clientId}:${caller}`);
  if (!v) return null;
  if (Date.now() - v.ts > OFFER_TTL_MS) { _offeredSlots.delete(`${clientId}:${caller}`); return null; }
  return v.slots;
}

// Resolve a client by magic token (?token=) or admin client_id (?client_id=).
// Magic token requires no header auth; client_id is admin-gated by caller.
async function resolveClient(supabase, { token, client_id }) {
  if (token) {
    const { data } = await supabase.from('tool_clients').select('*').eq('magic_token', token).single();
    return data || null;
  }
  if (client_id) {
    const { data } = await supabase.from('tool_clients').select('*').eq('id', client_id).single();
    return data || null;
  }
  return null;
}

// Shared: create an appointment + (google) event + confirmation SMS + owner alert.
async function createBooking(supabase, client, { caller_phone, caller_name, start_at, end_at, service, source }) {
  const tz = client.timezone || 'America/New_York';
  const slotMin = Number(client.slot_minutes) > 0 ? Number(client.slot_minutes) : 30;
  const startMs = new Date(start_at).getTime();
  const endMs = end_at ? new Date(end_at).getTime() : startMs + slotMin * 60000;
  const label = slotLabel(new Date(startMs), tz);

  let googleEventId = null;
  if (client.booking_mode === 'google' && client.google_refresh_token) {
    googleEventId = await googleCreateEvent(client, {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      summary: `${caller_name || 'Appointment'}${service ? ' — ' + service : ''}`,
      description: `Booked via ${BRAND.name}. Caller: ${caller_phone || 'unknown'}.`
    });
  }

  const { data: appt, error } = await supabase.from('tool_appointments').insert({
    client_id: client.id,
    caller_phone: caller_phone || null,
    caller_name: caller_name || null,
    start_at: new Date(startMs).toISOString(),
    end_at: new Date(endMs).toISOString(),
    service: service || null,
    status: 'booked',
    source: source || 'recaller_ai',
    google_event_id: googleEventId
  }).select().single();
  if (error) {
    // 23505 = unique violation on uniq_active_slot: slot was taken between offer and book.
    if (error.code === '23505' || /duplicate key|uniq_active_slot/i.test(error.message || '')) {
      if (googleEventId) { try { await googleDeleteEvent(client, googleEventId); } catch (e) {} }
      const e = new Error('slot_taken'); e.slotTaken = true; throw e;
    }
    throw error;
  }

  // Confirmation SMS to the caller (best-effort).
  if (caller_phone && client.twilio_number) {
    try {
      await sendSms(getTwilioClient(), {
        from: client.twilio_number,
        to: caller_phone,
        body: `You're booked for ${label}. See you then! Reply C to cancel.`
      });
    } catch (e) { console.error('booking confirm SMS failed:', e); }
  }
  // Owner alert (best-effort).
  if (client.owner_phone && client.twilio_number) {
    try {
      await sendSms(getTwilioClient(), {
        from: client.twilio_number,
        to: client.owner_phone,
        body: `${BRAND.name}: ${caller_name || maskPhone(caller_phone)} booked ${label}${service ? ' (' + service + ')' : ''}.`
      });
    } catch (e) { console.error('owner booking alert failed:', e); }
  }
  return { appointment: appt, label };
}

// Cancel an appointment row: status->cancelled + delete google event.
async function cancelBooking(supabase, client, appt) {
  if (!appt) return;
  if (appt.google_event_id && client.booking_mode === 'google') {
    await googleDeleteEvent(client, appt.google_event_id);
  }
  await supabase.from('tool_appointments').update({ status: 'cancelled' }).eq('id', appt.id);
}

// ─── 1 & 8. /api/tool/clients ────────────────────────────────────────────────

async function handleClients(req, res) {
  if (!requireAuth(req, res)) return;
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { data: clients, error } = await supabase
        .from('tool_clients')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const out = [];
      for (const c of clients || []) {
        let stats = null;
        try {
          stats = await computeStats(supabase, c.id, 7);
        } catch (e) {
          console.error('Stats error for client', c.id, e);
        }
        out.push({ ...c, stats_7d: stats });
      }
      return res.status(200).json({ clients: out });
    } catch (err) {
      console.error('GET tool/clients error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      if (!rateLimit(req, { max: 10, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Too many requests, slow down' });
      }

      const {
        practice_name, owner_name, owner_email, owner_phone, real_line,
        avg_customer_value, business_hours, services, booking_link, area_code
      } = req.body || {};

      // ─── Input validation ───
      const pn = typeof practice_name === 'string' ? practice_name.trim() : '';
      const rl = typeof real_line === 'string' ? real_line.trim() : '';
      if (!pn || !rl) {
        return res.status(400).json({ error: 'practice_name and real_line are required' });
      }
      if (pn.length > 120) {
        return res.status(400).json({ error: 'practice_name too long (max 120)' });
      }
      if (normalizePhone(rl).length < 10) {
        return res.status(400).json({ error: 'real_line does not look like a phone number' });
      }
      if (owner_email && (typeof owner_email !== 'string' || !owner_email.includes('@'))) {
        return res.status(400).json({ error: 'owner_email is not a valid email' });
      }
      if (services && typeof services === 'string' && services.length > 500) {
        return res.status(400).json({ error: 'services too long (max 500)' });
      }

      const magicToken = crypto.randomBytes(24).toString('hex');
      const { data: client, error } = await supabase
        .from('tool_clients')
        .insert({
          practice_name: pn,
          owner_name: owner_name || null,
          owner_email: owner_email || null,
          owner_phone: owner_phone || null,
          real_line: rl,
          avg_customer_value: avg_customer_value || 500,
          business_hours: business_hours || null,
          services: services || null,
          booking_link: booking_link || null,
          status: 'trial',
          trial_started_at: new Date().toISOString(),
          magic_token: magicToken
        })
        .select()
        .single();
      if (error) throw error;

      // Provision Twilio number — soft-fail so onboarding can retry later
      try {
        const updated = await provisionTwilioNumber(supabase, client, area_code);
        await sendWelcomeEmail(supabase, updated);
        return res.status(200).json({
          client: updated,
          forwarding_instructions: forwardingInstructions(updated.twilio_number)
        });
      } catch (twErr) {
        console.error('Twilio provisioning failed:', twErr);
        await sendWelcomeEmail(supabase, client);
        return res.status(200).json({
          client,
          twilio_error: twErr.message,
          forwarding_instructions: 'Number not provisioned yet — retry via POST /api/tool/clients/provision'
        });
      }
    } catch (err) {
      console.error('POST tool/clients error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// POST /api/tool/clients/provision { client_id } — retry number purchase
async function handleClientsProvision(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { client_id, area_code } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id required' });

    const { data: client, error } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('id', client_id)
      .single();
    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    if (client.twilio_number) {
      return res.status(200).json({
        client,
        forwarding_instructions: forwardingInstructions(client.twilio_number)
      });
    }

    const updated = await provisionTwilioNumber(supabase, client, area_code);
    return res.status(200).json({
      client: updated,
      forwarding_instructions: forwardingInstructions(updated.twilio_number)
    });
  } catch (err) {
    console.error('tool/clients/provision error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── 2. POST /api/tool/voice — inbound call webhook ──────────────────────────

async function handleVoice(req, res) {
  try {
    if (!validateTwilioWebhook(req, res)) return;
    const supabase = getSupabase();
    // Opportunistically deliver any due deferred messages on inbound traffic.
    try { await flushDeferred(getSupabase(), 5); } catch (e) {}
    const to = (req.body && req.body.To) || '';

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('twilio_number', to)
      .single();

    if (!client || !client.real_line) {
      return twiml(res, '<Say voice="alice">This number is not configured.</Say><Hangup/>');
    }

    // STATUS GUARD: churned/paused clients still get graceful forwarding, but no
    // verification tracking and no downstream text-back service.
    if (client.status === 'churned' || client.status === 'paused') {
      return twiml(
        res,
        `<Dial timeout="25">${xmlEscape(client.real_line)}</Dial>`
      );
    }

    // ANY inbound call proves forwarding works — record it.
    await markInbound(supabase, client);

    const action = `/api/tool/voice-status?client_id=${encodeURIComponent(client.id)}`;
    return twiml(
      res,
      `<Dial action="${xmlEscape(action)}" method="POST" timeout="25">${xmlEscape(client.real_line)}</Dial>`
    );
  } catch (err) {
    console.error('tool/voice error:', err);
    return twiml(res); // always 200 TwiML for webhooks
  }
}

// ─── 3. POST /api/tool/voice-status — dial action callback ───────────────────

async function handleVoiceStatus(req, res) {
  try {
    if (!validateTwilioWebhook(req, res)) return;
    const supabase = getSupabase();
    const clientId = req.query.client_id;
    const dialStatus = (req.body && req.body.DialCallStatus) || '';
    const caller = (req.body && req.body.From) || '';
    const callSid = (req.body && req.body.CallSid) || null;

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('id', clientId)
      .single();
    if (!client) return twiml(res);

    if (dialStatus === 'answered' || dialStatus === 'completed') {
      await supabase.from('tool_calls').insert({
        client_id: client.id,
        caller_phone: caller,
        call_sid: callSid,
        outcome: 'answered'
      });
      return twiml(res);
    }

    if (!['no-answer', 'busy', 'failed'].includes(dialStatus)) return twiml(res);

    // MISSED CALL
    const outcome = dialStatus === 'busy' ? 'busy' : dialStatus === 'failed' ? 'failed' : 'missed';
    const { data: callRow, error: callErr } = await supabase
      .from('tool_calls')
      .insert({
        client_id: client.id,
        caller_phone: caller,
        call_sid: callSid,
        outcome,
        est_value: client.avg_customer_value || 500
      })
      .select()
      .single();
    if (callErr) console.error('tool_calls insert error:', callErr);

    // STATUS GUARD: churned/paused — row inserted above for data continuity, but
    // no text-back is sent.
    if (client.status === 'churned' || client.status === 'paused') {
      return twiml(res);
    }

    // Skip text-back for the practice's own numbers / non-textable callers / opt-outs
    const callerDigits = normalizePhone(caller);
    const skipSelf =
      callerDigits === normalizePhone(client.real_line) ||
      (client.owner_phone && callerDigits === normalizePhone(client.owner_phone));
    const optedOut = await callerOptedOut(supabase, client.id, caller);

    // #3 Spam / robocall filter — log the call (done above) but skip the textback,
    // and don't alert the owner. Tag the call row best-effort.
    let spam = false;
    if (!skipSelf) {
      spam = await isLikelySpam(supabase, client, caller);
      if (spam && callRow) {
        // Tag without altering `outcome` (keeps missed stats intact). `spam` column optional.
        try { await supabase.from('tool_calls').update({ spam: true }).eq('id', callRow.id); } catch (e) { /* column optional — ignore */ }
      }
    }

    if (!spam && !skipSelf && !isNonTextableCaller(caller) && !optedOut && client.twilio_number) {
      const fallback =
        `Hi! This is ${client.practice_name}. Sorry we missed your call! ` +
        `Are you looking to book an appointment? Reply here and we'll get you sorted.` +
        (client.booking_link ? ` Or book directly: ${client.booking_link}` : '');

      const knownName = await getContactName(supabase, client.id, caller);
      const body = await generateAiMessage({
        client,
        contactName: knownName,
        purpose: 'The practice just missed this person\'s call. Apologize warmly for missing them and ask if they would like to book an appointment.' +
          (knownName ? '' : " If it feels natural, ask for their name once (\"...and what's your name so I can note it for the doctor?\")."),
        fallback
      });

      try {
        const result = await sendOrDefer(supabase, client, {
          call_id: callRow ? callRow.id : null,
          caller,
          body,
          ai_generated: aiAvailable()
        });
        if (callRow) {
          await supabase.from('tool_calls').update({ textback_sent: true }).eq('id', callRow.id);
        }
        if (result.deferred) {
          return twiml(res, '<Say voice="alice">Sorry we missed you. We\'ll text you first thing in the morning.</Say><Hangup/>');
        }
        return twiml(res, '<Say voice="alice">Sorry we missed you, we just sent you a text.</Say><Hangup/>');
      } catch (smsErr) {
        console.error('Text-back send failed:', smsErr);
        if (isSystemicTwilioError(smsErr)) {
          await alertGodwin(supabase, 'twilio_send_systemic', `textback: ${smsErr.message}`);
        }
      }
    }

    return twiml(res);
  } catch (err) {
    console.error('tool/voice-status error:', err);
    return twiml(res);
  }
}

// ─── 4. POST /api/tool/sms — inbound SMS webhook ─────────────────────────────

async function handleSms(req, res) {
  try {
    if (!validateTwilioWebhook(req, res)) return;
    const supabase = getSupabase();
    // Opportunistically deliver any due deferred messages on inbound traffic.
    try { await flushDeferred(getSupabase(), 5); } catch (e) {}
    const to = (req.body && req.body.To) || '';
    const caller = (req.body && req.body.From) || '';
    const body = (req.body && req.body.Body) || '';
    const msgSid = (req.body && req.body.MessageSid) || null;

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('twilio_number', to)
      .single();
    if (!client) return twiml(res);

    // STATUS GUARD: churned/paused — log the inbound message for continuity, but
    // send NO outbound (no AI reply, no owner alert).
    if (client.status === 'churned' || client.status === 'paused') {
      await supabase.from('tool_messages').insert({
        client_id: client.id,
        caller_phone: caller,
        direction: 'inbound',
        body,
        ai_generated: false,
        twilio_sid: msgSid
      });
      return twiml(res);
    }

    // Find most recent call from this caller for this client
    const { data: recentCalls } = await supabase
      .from('tool_calls')
      .select('*')
      .eq('client_id', client.id)
      .eq('caller_phone', caller)
      .order('created_at', { ascending: false })
      .limit(1);
    const callRow = recentCalls && recentCalls[0];

    // Log inbound message
    await supabase.from('tool_messages').insert({
      client_id: client.id,
      call_id: callRow ? callRow.id : null,
      caller_phone: caller,
      direction: 'inbound',
      body,
      ai_generated: false,
      twilio_sid: msgSid
    });

    // STOP handling: log only, never reply (also opt out any matching patient).
    if (/^\s*(stop|unsubscribe)\s*$/i.test(body)) {
      await markPatientStatus(supabase, client.id, caller, 'opted_out');
      return twiml(res);
    }

    // ── #6 Owner commands: only the owner's own number, texting the tool number. ──
    // CALL → text owner the most recent lead's number + name. DETAILS → last inbound msg.
    if (client.owner_phone && normalizePhone(caller) === normalizePhone(client.owner_phone)) {
      const cmd = /^\s*(call|details)\s*$/i.exec(body || '');
      if (cmd) {
        try {
          const which = cmd[1].toLowerCase();
          // Most recent lead = most recent inbound message from a non-owner caller.
          const { data: recentInbound } = await supabase
            .from('tool_messages')
            .select('caller_phone, body, created_at')
            .eq('client_id', client.id)
            .eq('direction', 'inbound')
            .order('created_at', { ascending: false })
            .limit(50);
          const ownerDigits = normalizePhone(client.owner_phone);
          const lead = (recentInbound || []).find((m) => m.caller_phone && normalizePhone(m.caller_phone) !== ownerDigits);
          let replyBody;
          if (!lead) {
            replyBody = `${BRAND.name}: no recent leads to show yet.`;
          } else if (which === 'call') {
            const nm = await getContactName(supabase, client.id, lead.caller_phone);
            replyBody = `${BRAND.name}: most recent lead${nm ? ' ' + nm : ''} — ${lead.caller_phone}`;
          } else {
            const nm = await getContactName(supabase, client.id, lead.caller_phone);
            replyBody = `${BRAND.name}: last msg from ${nm || maskPhone(lead.caller_phone)}: "${(lead.body || '').slice(0, 300)}"`;
          }
          if (client.twilio_number) {
            try {
              await sendSms(getTwilioClient(), { from: client.twilio_number, to: client.owner_phone, body: replyBody });
            } catch (e) {
              console.error('owner command reply failed:', e);
              if (isSystemicTwilioError(e)) await alertGodwin(supabase, 'twilio_send_systemic', `owner cmd: ${e.message}`);
            }
          }
        } catch (e) { console.error('owner command error:', e); }
        return twiml(res);
      }
    }

    // Suppress all outbound if caller previously opted out
    if (await callerOptedOut(supabase, client.id, caller)) return twiml(res);

    // Mark recovered
    if (callRow && !callRow.recovered) {
      await supabase.from('tool_calls').update({ recovered: true }).eq('id', callRow.id);
    }

    // Reactivation: any inbound from a known patient counts as a reply.
    await markPatientStatus(supabase, client.id, caller, 'replied');

    // HUMAN TAKEOVER: if the owner has taken over this caller (active window),
    // skip the AI auto-reply — but still do booking marking + owner alert below.
    let humanTakeover = false;
    try {
      const { data: takeovers } = await supabase
        .from('tool_takeovers')
        .select('*')
        .eq('client_id', client.id)
        .eq('caller_phone', caller)
        .gt('until', new Date().toISOString())
        .limit(1);
      humanTakeover = !!(takeovers && takeovers[0]);
    } catch (e) {
      console.error('takeover lookup error:', e);
    }

    // Conversation history (last 6 messages)
    const { data: histDesc } = await supabase
      .from('tool_messages')
      .select('*')
      .eq('client_id', client.id)
      .eq('caller_phone', caller)
      .order('created_at', { ascending: false })
      .limit(6);
    const history = (histDesc || []).reverse();

    // ── #2 Caller name capture ──
    let contactName = await getContactName(supabase, client.id, caller);
    // Did our most recent outbound ask for the caller's name?
    const lastOutbound = [...history].reverse().find((m) => m.direction === 'outbound');
    const askedForName = !!(lastOutbound && /what'?s your name|your name so/i.test(lastOutbound.body || ''));
    if (!contactName) {
      const extracted = extractName(body, askedForName);
      if (extracted) {
        await saveContactName(supabase, client.id, caller, extracted);
        contactName = extracted;
      }
    }
    // If we still don't know the name, instruct the AI to ask for it once.
    const namePrompt = contactName
      ? ''
      : " If it feels natural, also ask for their name once (\"...and what's your name so I can note it for the doctor?\").";

    const trimmed = (body || '').trim();

    // ── Cancellation: "C" or "cancel" cancels the next upcoming appointment. ──
    if (/^\s*(c|cancel)\s*$/i.test(trimmed)) {
      try {
        const { data: upcoming } = await supabase
          .from('tool_appointments')
          .select('*')
          .eq('client_id', client.id)
          .eq('caller_phone', caller)
          .in('status', ['booked', 'confirmed'])
          .gte('start_at', new Date().toISOString())
          .order('start_at', { ascending: true })
          .limit(1);
        const appt = upcoming && upcoming[0];
        if (appt) {
          await cancelBooking(supabase, client, appt);
          const label = slotLabel(new Date(appt.start_at), client.timezone || 'America/New_York');
          if (!humanTakeover) {
            await sendOrDefer(supabase, client, {
              caller,
              body: `Your appointment for ${label} is cancelled. Reply anytime to rebook.`,
              ai_generated: false
            });
          }
          return twiml(res);
        }
        // No appointment to cancel — fall through to normal handling.
      } catch (e) {
        console.error('cancellation error:', e);
      }
    }

    // ── Slot selection: caller replies with just a number (1-9). ──
    const numMatch = /^\s*([1-9])\s*$/.exec(trimmed);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      try {
        let offered = getOfferedSlots(client.id, caller);
        // Cold-start fallback: regenerate current slots and map by index.
        if (!offered) {
          offered = await getOpenSlots(supabase, client, { days: 5, maxSlots: 3 });
        }
        const chosen = offered && offered[idx];
        if (chosen) {
          try {
            const { appointment, label } = await createBooking(supabase, client, {
              caller_phone: caller,
              caller_name: contactName,
              start_at: chosen.start_at,
              end_at: chosen.end_at,
              service: null,
              source: 'recaller_ai'
            });
            _offeredSlots.delete(`${client.id}:${caller}`);
            if (callRow) {
              await supabase.from('tool_calls').update({ booked: true, recovered: true }).eq('id', callRow.id);
            }
            await markPatientStatus(supabase, client.id, caller, 'rebooked');
            return twiml(res);
          } catch (bookErr) {
            if (bookErr.slotTaken) {
              // Slot got taken between offer and pick — re-offer fresh slots.
              const fresh = await getOpenSlots(supabase, client, { days: 5, maxSlots: 3 });
              if (fresh && fresh.length) {
                stashOffer(client.id, caller, fresh);
                const list = fresh.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
                await sendOrDefer(supabase, client, {
                  caller,
                  body: `Sorry, that time was just taken! Here's what's open now: ${list} — reply with the number.`,
                  ai_generated: false
                });
              }
              return twiml(res);
            }
            throw bookErr;
          }
        }
      } catch (e) {
        console.error('slot selection error:', e);
      }
      // If we couldn't map the number, fall through to normal AI handling.
    }

    // Broad booking-intent detection — catch natural phrasings, not just keywords.
    // Affirmatives, scheduling words, time references, and questions about availability.
    const bookingIntent = /\b(yes|yeah|yep|yup|sure|ok|okay|please|book|booking|appointment|appt|schedule|reschedule|opening|openings|available|availability|slot|slots|time|times|when|visit|come in|get in|see (you|the|dr|doctor)|interested|today|tomorrow|this week|next week|morning|afternoon|evening)\b/i.test(body)
      || /\?\s*$/.test((body || '').trim());  // any question defaults to helpful booking offer
    const mode = client.booking_mode || 'native';
    const offersSlots = (mode === 'native' || mode === 'google');

    if (bookingIntent) {
      if (callRow) {
        await supabase.from('tool_calls').update({ recovered: true }).eq('id', callRow.id);
        // Mark booked only for handoff/calcom (no in-SMS confirmation step).
        if (mode === 'handoff' || mode === 'calcom') {
          await supabase.from('tool_calls').update({ booked: true }).eq('id', callRow.id);
          await markPatientStatus(supabase, client.id, caller, 'rebooked');
        }
      }
      // Notify the practice owner (still fires under human takeover)
      if (client.owner_phone) {
        try {
          const who = contactName || maskPhone(caller);
          await sendSms(getTwilioClient(), {
            from: client.twilio_number,
            to: client.owner_phone,
            body: `${BRAND.name}: ${who} wants to book! Their msg: "${body}". Reply CALL to get their number texted to you, or DETAILS for the full conversation.`
          });
        } catch (notifyErr) {
          console.error('Owner notify SMS failed:', notifyErr);
          if (isSystemicTwilioError(notifyErr)) await alertGodwin(supabase, 'twilio_send_systemic', `owner notify: ${notifyErr.message}`);
        }
      }
    }

    // Under human takeover, the owner is handling the conversation — skip the AI auto-reply.
    if (humanTakeover) {
      return twiml(res);
    }

    let reply;
    if (bookingIntent && offersSlots) {
      // Native/Google: offer concrete open slots as a numbered list.
      let slots = [];
      try {
        slots = await getOpenSlots(supabase, client, { days: 5, maxSlots: 3 });
      } catch (e) {
        console.error('getOpenSlots error in handleSms:', e);
      }
      if (slots.length) {
        stashOffer(client.id, caller, slots);
        const list = slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ');
        reply = `Great! I can get you in: ${list} — just reply with the number.`;
        if (!contactName) reply += ` And what's your name so I can note it for the doctor?`;
      } else {
        // No open slots — fall back to a warm human-callback message.
        reply = await generateAiMessage({
          client,
          history,
          contactName,
          purpose: 'The person wants to book but we have no open slots in the next few days. Apologize warmly and say someone will call them shortly to find a time.' + namePrompt,
          fallback: `Thanks! We're fully booked for the next few days — someone from ${client.practice_name} will call you shortly to find a time.`
        });
        if (callRow) await supabase.from('tool_calls').update({ booked: true }).eq('id', callRow.id);
      }
    } else if (bookingIntent && (mode === 'handoff' || mode === 'calcom')) {
      // Handoff / cal.com: invite them to grab a time at the booking link.
      const link = client.booking_link;
      reply = await generateAiMessage({
        client,
        history,
        contactName,
        purpose: (link
          ? `The person wants to book. Warmly invite them to grab a time at this link: ${link}`
          : 'The person wants to book. Warmly confirm that someone will call them shortly to set a time.') + namePrompt,
        fallback: link
          ? `Great! Grab a time that works for you here: ${link}`
          : `Great! Someone from ${client.practice_name} will call you shortly to confirm a time. Talk soon!`
      });
    } else if (bookingIntent) {
      reply = await generateAiMessage({
        client,
        history,
        contactName,
        purpose: 'The person wants to book. Confirm warmly that someone from the practice will call them shortly to confirm a time.' + namePrompt,
        fallback: `Great! Someone from ${client.practice_name} will call you shortly to confirm a time. Talk soon!`
      });
    } else {
      reply = await generateAiMessage({
        client,
        history,
        contactName,
        purpose: 'Reply helpfully to the person\'s latest message as the practice front desk. If appropriate, gently invite them to book.' + namePrompt,
        fallback: `Thanks for your message! Someone from ${client.practice_name} will get back to you shortly. If you'd like to book, just reply YES.`
      });
    }

    try {
      await sendOrDefer(supabase, client, {
        call_id: callRow ? callRow.id : null,
        caller,
        body: reply,
        ai_generated: aiAvailable()
      });
    } catch (sendErr) {
      console.error('Reply SMS failed:', sendErr);
    }

    return twiml(res);
  } catch (err) {
    console.error('tool/sms error:', err);
    return twiml(res);
  }
}

// ─── 5. GET /api/tool/report ─────────────────────────────────────────────────

async function handleReport(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const token = req.query.token;
    const clientId = req.query.client_id;
    const days = parseInt(req.query.days) || 7;
    // Token (client portal) OR admin client_id
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id: clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const stats = await computeStats(supabase, client.id, days);
    return res.status(200).json({ client: { id: client.id, practice_name: client.practice_name, status: client.status, avg_customer_value: client.avg_customer_value }, stats });
  } catch (err) {
    console.error('tool/report error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── 6. GET /api/tool/cron-weekly ────────────────────────────────────────────

async function handleCronWeekly(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const { data: clients, error } = await supabase
      .from('tool_clients')
      .select('*')
      .in('status', ['trial', 'active']);
    if (error) throw error;

    const results = [];
    for (const client of clients || []) {
      if (!client.owner_email) {
        results.push({ client_id: client.id, skipped: 'no owner_email' });
        continue;
      }
      try {
        const stats = await computeStats(supabase, client.id, 7);
        const estSaved = stats.recovered * (Number(client.avg_customer_value) || 500);
        let insights = null;
        try { insights = await buildInsights(supabase, client, 7); } catch (e) { console.error('weekly insights error', client.id, e); }
        const lines = [
          `Hi ${client.owner_name || 'there'},`,
          '',
          `Here's what ${BRAND.name} did for ${client.practice_name} this week:`,
          '',
          `- Missed calls caught: ${stats.missed}`,
          `- Conversations recovered: ${stats.recovered}`,
          `- Bookings: ${stats.booked}`,
          `- Estimated revenue saved: $${estSaved}`,
          ''
        ];
        if (insights) {
          lines.push(`You recovered ~$${insights.headline_roi.revenue_saved} this week — that's ${insights.headline_roi.roi_multiple}x the $500 cost.`, '');
          const recs = (insights.recommendations || []).slice(0, 3);
          if (recs.length) {
            lines.push('A few things worth knowing:');
            for (const r of recs) lines.push(`- ${r}`);
            lines.push('');
          }
          if (insights.reactivation && insights.reactivation.rebooked > 0) {
            lines.push(`Reactivation rebooked ${insights.reactivation.rebooked} lapsed patient(s) (~$${insights.reactivation.est_revenue}).`, '');
          }
        }
        if (client.status === 'trial') {
          lines.push("Your free week ends soon — let's talk: cal.com/godwin-rayen/30min", '');
        }
        lines.push(`— ${BRAND.from}`);

        await sendEmail({
          to: client.owner_email,
          toName: client.owner_name,
          subject: `${client.practice_name}: your week with ${BRAND.name}`,
          body: lines.join('\n')
        });
        results.push({ client_id: client.id, emailed: true });
      } catch (e) {
        console.error('Weekly email failed for client', client.id, e);
        results.push({ client_id: client.id, error: e.message });
      }
    }
    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('tool/cron-weekly error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── 7. GET /api/tool/dashboard ──────────────────────────────────────────────

async function handleDashboard(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('magic_token', token)
      .single();
    if (!client) return res.status(404).json({ error: 'Invalid token' });

    const stats = await computeStats(supabase, client.id, 30);

    // Last 10 recovered calls with their messages, callers masked
    const { data: recoveredCalls } = await supabase
      .from('tool_calls')
      .select('*')
      .eq('client_id', client.id)
      .eq('recovered', true)
      .order('created_at', { ascending: false })
      .limit(10);

    const conversations = [];
    for (const call of recoveredCalls || []) {
      const { data: msgs } = await supabase
        .from('tool_messages')
        .select('direction, body, created_at, delivery_status, deferred_until')
        .eq('client_id', client.id)
        .eq('caller_phone', call.caller_phone)
        .order('created_at', { ascending: true });
      conversations.push({
        caller: maskPhone(call.caller_phone),
        outcome: call.outcome,
        booked: call.booked,
        est_value: call.est_value,
        created_at: call.created_at,
        messages: msgs || []
      });
    }

    return res.status(200).json({
      practice_name: client.practice_name,
      status: client.status,
      twilio_number: client.twilio_number || null,
      date_range_days: 30,
      stats,
      recovered_conversations: conversations
    });
  } catch (err) {
    console.error('tool/dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/tool/inbox?token=MAGIC — full conversation history ────────────
// No auth (magic token). Groups all calls + messages by caller_phone.
async function handleInbox(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('magic_token', token)
      .single();
    if (!client) return res.status(404).json({ error: 'Invalid token' });

    const { data: calls } = await supabase
      .from('tool_calls')
      .select('caller_phone, outcome, recovered, booked, est_value, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: true });

    const { data: messages } = await supabase
      .from('tool_messages')
      .select('caller_phone, direction, body, delivery_status, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: true });

    const callList = calls || [];
    const msgList = messages || [];

    // Group by caller_phone
    const groups = new Map();
    function group(phone) {
      if (!groups.has(phone)) {
        groups.set(phone, {
          caller_raw: phone,
          recovered: false,
          booked: false,
          call_count: 0,
          message_count: 0,
          timeline: []
        });
      }
      return groups.get(phone);
    }

    for (const c of callList) {
      if (!c.caller_phone) continue;
      const g = group(c.caller_phone);
      g.call_count++;
      if (c.recovered) g.recovered = true;
      if (c.booked) g.booked = true;
      g.timeline.push({ type: 'call', outcome: c.outcome, created_at: c.created_at });
    }
    for (const m of msgList) {
      if (!m.caller_phone) continue;
      const g = group(m.caller_phone);
      g.message_count++;
      g.timeline.push({
        type: 'message',
        direction: m.direction,
        body: m.body,
        delivery_status: m.delivery_status,
        created_at: m.created_at
      });
    }

    const conversations = [];
    for (const g of groups.values()) {
      g.timeline.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const first = g.timeline[0];
      const last = g.timeline[g.timeline.length - 1];
      const digits = normalizePhone(g.caller_raw);
      conversations.push({
        caller: maskPhone(g.caller_raw),
        caller_raw_last4: digits.slice(-4),
        first_contact: first ? first.created_at : null,
        last_contact: last ? last.created_at : null,
        recovered: g.recovered,
        booked: g.booked,
        call_count: g.call_count,
        message_count: g.message_count,
        timeline: g.timeline
      });
    }
    conversations.sort((a, b) => new Date(b.last_contact) - new Date(a.last_contact));

    const missedOutcomes = ['missed', 'busy', 'failed', 'voicemail'];
    const calls_summary = {
      total: callList.length,
      answered: callList.filter((c) => c.outcome === 'answered').length,
      missed: callList.filter((c) => missedOutcomes.includes(c.outcome)).length,
      recovered: callList.filter((c) => c.recovered).length,
      booked: callList.filter((c) => c.booked).length
    };

    return res.status(200).json({
      practice_name: client.practice_name,
      twilio_number: client.twilio_number || null,
      conversations: conversations.slice(0, 100),
      calls_summary
    });
  } catch (err) {
    console.error('tool/inbox error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/tool/checkout?client_id=X — self-serve subscription ────────────
// No auth. Degrades to trial mode if DODO is not configured.
async function handleCheckout(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!process.env.DODO_API_KEY) {
      return res.status(200).json({ mode: 'trial', message: 'Free trial active' });
    }

    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const supabase = getSupabase();
    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('id', clientId)
      .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
      const successUrl =
        `${PUBLIC_BASE}/recaller?token=${encodeURIComponent(client.magic_token || '')}&paid=1`;
      const r = await fetch('https://live.dodopayments.com/subscriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          product_id: process.env.DODO_PRODUCT_ID,
          quantity: 1,
          payment_link: true,
          return_url: successUrl,
          customer: {
            email: client.owner_email,
            name: client.owner_name || client.practice_name
          },
          billing: { country: 'US', state: '', city: '', street: '', zipcode: '' },
          metadata: { client_id: String(client.id) }
        })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(200).json({ mode: 'trial', error: `Dodo API ${r.status}` });
      }
      const checkout_url = body.payment_link || body.link || body.url || null;
      if (!checkout_url) {
        return res.status(200).json({ mode: 'trial', error: 'No checkout URL returned' });
      }
      return res.status(200).json({ mode: 'paid', checkout_url });
    } catch (apiErr) {
      console.error('tool/checkout Dodo API error:', apiErr);
      return res.status(200).json({ mode: 'trial', error: apiErr.message });
    }
  } catch (err) {
    console.error('tool/checkout error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/tool/sms-status — Twilio delivery status callback ─────────────
// No auth (Twilio webhook). Signature-validated. Always returns 200.
async function handleSmsStatus(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!validateTwilioWebhook(req, res)) return; // 403 only under STRICT_TWILIO
  try {
    const supabase = getSupabase();
    const sid = (req.body && req.body.MessageSid) || (req.body && req.body.SmsSid) || null;
    const status = (req.body && req.body.MessageStatus) || (req.body && req.body.SmsStatus) || '';
    if (!sid) return res.status(200).json({ ok: true, ignored: 'no sid' });

    // Locate the message row by twilio_sid
    const { data: rows } = await supabase
      .from('tool_messages')
      .select('*')
      .eq('twilio_sid', sid)
      .limit(1);
    const row = rows && rows[0];

    if (row) {
      await supabase
        .from('tool_messages')
        .update({ delivery_status: status || row.delivery_status })
        .eq('id', row.id);
    }

    // Auto-retry once on hard failure
    if ((status === 'failed' || status === 'undelivered') && row && (row.retry_count || 0) < 1) {
      try {
        const { data: client } = await supabase
          .from('tool_clients')
          .select('*')
          .eq('id', row.client_id)
          .single();
        if (client && client.twilio_number && row.caller_phone && row.body) {
          const msg = await sendSms(getTwilioClient(), {
            from: client.twilio_number,
            to: row.caller_phone,
            body: row.body
          });
          await supabase
            .from('tool_messages')
            .update({
              twilio_sid: msg.sid,
              delivery_status: 'queued',
              retry_count: (row.retry_count || 0) + 1
            })
            .eq('id', row.id);
        }
      } catch (retryErr) {
        console.error('sms-status retry failed:', retryErr);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('tool/sms-status error:', err);
    return res.status(200).json({ ok: true, error: err.message });
  }
}

// ─── Reusable deferred-message flush ─────────────────────────────────────────
// Single indexed query for due deferred rows (send-time <= now), sends each, and
// clears them. Used by cron-flush (limit 200) and opportunistically by inbound
// traffic (limit 5). Returns the per-row results array.
async function flushDeferred(supabase, limit = 10) {
  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase
    .from('tool_messages')
    .select('*')
    .eq('delivery_status', 'deferred')
    .lte('deferred_until', nowIso)
    .limit(limit);
  if (error) throw error;

  const results = [];
  for (const row of due || []) {
    try {
      const { data: client } = await supabase
        .from('tool_clients')
        .select('*')
        .eq('id', row.client_id)
        .single();
      if (!client || !client.twilio_number || !row.caller_phone) {
        results.push({ id: row.id, skipped: 'missing client/number' });
        continue;
      }
      const msg = await sendSms(getTwilioClient(), {
        from: client.twilio_number,
        to: row.caller_phone,
        body: row.body
      });
      await supabase
        .from('tool_messages')
        .update({ twilio_sid: msg.sid, delivery_status: 'sent', deferred_until: null })
        .eq('id', row.id);
      results.push({ id: row.id, sent: true });
    } catch (e) {
      console.error('flushDeferred send error for msg', row.id, e);
      results.push({ id: row.id, error: e.message });
    }
  }
  return results;
}

// ─── GET /api/tool/cron-flush — send deferred (quiet-hours) messages ─────────
// No auth, safe to call anytime. Sends due deferred messages and clears them.
// Also runs daily at 13:00 UTC to drive trial lifecycle automation.
async function handleCronFlush(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();

    const results = await flushDeferred(supabase, 200);

    // ── Trial lifecycle automation ──
    const trial_lifecycle = [];
    try {
      const { data: trials } = await supabase
        .from('tool_clients')
        .select('*')
        .eq('status', 'trial');
      for (const client of trials || []) {
        try {
          if (!client.trial_started_at) continue;
          const days = Math.floor((Date.now() - new Date(client.trial_started_at).getTime()) / 86400000);

          // Day 10+: pause
          if (days >= 10 && client.status === 'trial') {
            await supabase.from('tool_clients').update({ status: 'paused' }).eq('id', client.id);
            if (client.owner_email) {
              await sendEmail({
                to: client.owner_email,
                toName: client.owner_name,
                subject: "We've paused your Vyrrah Recaller account",
                body: [
                  `Hi ${client.owner_name || 'there'},`,
                  '',
                  `We've paused your ${BRAND.name} account. Your number still forwards to your line, but we're no longer texting your missed callers.`,
                  '',
                  'Want it back on? Just reply to this email, or grab 15 minutes with Godwin: cal.com/godwin-rayen/30min',
                  '',
                  `— ${BRAND.from}`
                ].join('\n')
              });
            }
            trial_lifecycle.push({ client_id: client.id, action: 'paused', days });
            continue;
          }

          // Day 7+: full week recap
          if (days >= 7 && !client.day7_sent && client.owner_email) {
            const stats = await computeStats(supabase, client.id, 7);
            await sendEmail({
              to: client.owner_email,
              toName: client.owner_name,
              subject: 'Your week with Vyrrah Recaller — here are the numbers',
              body: [
                `Hi ${client.owner_name || 'there'},`,
                '',
                `Here's your full first week with ${BRAND.name} for ${client.practice_name}:`,
                '',
                `- Missed calls caught: ${stats.missed}`,
                `- Conversations recovered: ${stats.recovered}`,
                `- Bookings: ${stats.booked}`,
                `- Estimated revenue saved: $${stats.est_revenue_saved}`,
                '',
                `In short: you recovered ~$${stats.est_revenue_saved} in bookings. The tool is $500/month.`,
                '',
                `Keep it running: ${PUBLIC_BASE}/recaller?token=${client.magic_token}`,
                'or grab 15 min with Godwin: cal.com/godwin-rayen/30min',
                '',
                `— ${BRAND.from}`
              ].join('\n')
            });
            await supabase.from('tool_clients').update({ day7_sent: true }).eq('id', client.id);
            trial_lifecycle.push({ client_id: client.id, action: 'day7_email', days });
            continue;
          }

          // Day 5+: 5-day check-in
          if (days >= 5 && !client.day5_sent && client.owner_email) {
            const stats = await computeStats(supabase, client.id, 7);
            await sendEmail({
              to: client.owner_email,
              toName: client.owner_name,
              subject: 'Your first 5 days with Vyrrah Recaller',
              body: [
                `Hi ${client.owner_name || 'there'},`,
                '',
                `Here's what ${BRAND.name} has done for ${client.practice_name} so far:`,
                '',
                `- Missed calls caught: ${stats.missed}`,
                `- Conversations recovered: ${stats.recovered}`,
                `- Bookings: ${stats.booked}`,
                `- Estimated revenue saved: $${stats.est_revenue_saved}`,
                '',
                'Your free week ends in about 2 days. Keep it running for $500/month, cancel anytime:',
                `${PUBLIC_BASE}/recaller?token=${client.magic_token}`,
                '',
                `— ${BRAND.from}`
              ].join('\n')
            });
            await supabase.from('tool_clients').update({ day5_sent: true }).eq('id', client.id);
            trial_lifecycle.push({ client_id: client.id, action: 'day5_email', days });
          }
        } catch (e) {
          console.error('trial lifecycle error for client', client.id, e);
          trial_lifecycle.push({ client_id: client.id, error: e.message });
        }
      }
    } catch (e) {
      console.error('trial lifecycle query error:', e);
    }

    // ── Appointment reminders: booked/confirmed starting within next 24h ──
    const reminders = [];
    try {
      const nowIso = new Date().toISOString();
      const in24h = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const { data: appts } = await supabase
        .from('tool_appointments')
        .select('*')
        .in('status', ['booked', 'confirmed'])
        .eq('reminder_sent', false)
        .gte('start_at', nowIso)
        .lte('start_at', in24h);
      // Cache clients across appts to avoid repeat lookups.
      const clientCache = new Map();
      for (const appt of appts || []) {
        try {
          if (!appt.caller_phone) continue;
          let client = clientCache.get(appt.client_id);
          if (!client) {
            const { data: c } = await supabase
              .from('tool_clients').select('*').eq('id', appt.client_id).single();
            client = c; clientCache.set(appt.client_id, c);
          }
          if (!client || !client.twilio_number) continue;
          const label = slotLabel(new Date(appt.start_at), client.timezone || 'America/New_York');
          await sendOrDefer(supabase, client, {
            caller: appt.caller_phone,
            body: `Reminder: your appointment with ${client.practice_name} is ${label}. Reply C to cancel.`,
            ai_generated: false
          });
          await supabase.from('tool_appointments').update({ reminder_sent: true }).eq('id', appt.id);
          reminders.push({ appointment_id: appt.id, sent: true });
        } catch (e) {
          console.error('reminder error for appt', appt.id, e);
          reminders.push({ appointment_id: appt.id, error: e.message });
        }
      }
    } catch (e) {
      console.error('appointment reminders query error:', e);
    }

    // ── Engine 2: review-request loop ──
    let reviews = [];
    try {
      reviews = await reviewLoopPass(supabase);
    } catch (e) {
      console.error('review loop error:', e);
    }

    // ── Engine 1: reactivation drip pass per active/trial client ──
    const reactivation = [];
    try {
      const { data: reactClients } = await supabase
        .from('tool_clients')
        .select('*')
        .in('status', ['trial', 'active'])
        .eq('reactivation_enabled', true);
      for (const client of reactClients || []) {
        try {
          const r = await reactivationPass(supabase, client, { limit: 25 });
          reactivation.push({ client_id: client.id, ...r });
        } catch (e) {
          console.error('reactivationPass error for client', client.id, e);
          reactivation.push({ client_id: client.id, error: e.message });
        }
      }
    } catch (e) {
      console.error('reactivation cron query error:', e);
    }

    // ── #4 Monthly ROI email (anti-churn) ──
    const monthly_reports = [];
    try {
      const { data: monClients } = await supabase
        .from('tool_clients')
        .select('*')
        .in('status', ['trial', 'active']);
      for (const client of monClients || []) {
        try {
          if (!client.owner_email) continue;
          // Need >=14 days of history (use trial_started_at or created_at as the start).
          const startTs = new Date(client.trial_started_at || client.created_at || Date.now()).getTime();
          const daysOfHistory = (Date.now() - startTs) / 86400000;
          if (daysOfHistory < 14) continue;
          // Due if never sent OR >=28 days ago.
          const last = client.last_monthly_report ? new Date(client.last_monthly_report).getTime() : 0;
          const daysSince = last ? (Date.now() - last) / 86400000 : Infinity;
          if (daysSince < 28) continue;

          const insights = await buildInsights(supabase, client, 30);
          const roi = insights.headline_roi;
          const lines = [
            `Hi ${client.owner_name || 'there'},`,
            '',
            `We recovered ~$${roi.revenue_saved} this month. Your invoice was $500. That's ${roi.roi_multiple}x your money.`,
            '',
            `- Calls caught: ${insights.peak_missed ? 'peak ' + insights.peak_missed.label : 'tracked all month'}`,
            `- Conversations recovered: ${insights.recovery_rate.current_pct}% recovery rate`,
            `- Bookings: ${insights.booking_rate.booked}`,
            `- Lapsed patients rebooked: ${insights.reactivation.rebooked} (~$${insights.reactivation.est_revenue})`,
            ''
          ];
          const topRec = (insights.recommendations || [])[0];
          if (topRec) lines.push(`Top recommendation: ${topRec}`, '');
          lines.push(`Keep it running: ${PUBLIC_BASE}/recaller?token=${client.magic_token}`, '', `— ${BRAND.from}`);

          await sendEmail({
            to: client.owner_email,
            toName: client.owner_name,
            subject: `${client.practice_name}: what ${BRAND.name} made you this month`,
            body: lines.join('\n')
          });
          await supabase.from('tool_clients')
            .update({ last_monthly_report: new Date().toISOString().slice(0, 10) })
            .eq('id', client.id);
          monthly_reports.push({ client_id: client.id, sent: true, roi_multiple: roi.roi_multiple });
        } catch (e) {
          console.error('monthly report error for client', client.id, e);
          monthly_reports.push({ client_id: client.id, error: e.message });
        }
      }
    } catch (e) {
      console.error('monthly report query error:', e);
    }

    // ── #9 Daily pool top-up ──
    let pool_refill = null;
    try {
      pool_refill = await ensurePoolStock(supabase, 3, 5);
    } catch (e) {
      console.error('cron ensurePoolStock error:', e);
    }

    return res.status(200).json({ ok: true, flushed: results.length, results, trial_lifecycle, reminders, reviews, reactivation, monthly_reports, pool_refill });
  } catch (err) {
    console.error('tool/cron-flush error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── 9. POST /api/tool/dodo-webhook — Dodo Payments events ──────────────────

// Standard Webhooks spec: signature = base64(HMAC-SHA256(secret, `${id}.${timestamp}.${rawBody}`))
function verifyDodoSignature(req, rawBody) {
  const secret = process.env.DODO_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('dodo-webhook: DODO_WEBHOOK_SECRET not set — accepting unverified');
    return true;
  }
  try {
    const id = req.headers['webhook-id'] || '';
    const timestamp = req.headers['webhook-timestamp'] || '';
    const sigHeader = req.headers['webhook-signature'] || '';
    if (!id || !timestamp || !sigHeader) return false;

    // Standard Webhooks secrets are often prefixed "whsec_" and base64-encoded
    let key;
    if (secret.startsWith('whsec_')) {
      key = Buffer.from(secret.slice(6), 'base64');
    } else {
      key = Buffer.from(secret, 'utf8');
    }
    const expected = crypto
      .createHmac('sha256', key)
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest('base64');

    // Header may contain space-separated, version-prefixed signatures: "v1,<base64>"
    return sigHeader.split(' ').some((part) => {
      const sig = part.includes(',') ? part.split(',')[1] : part;
      try {
        return crypto.timingSafeEqual(Buffer.from(sig || '', 'utf8'), Buffer.from(expected, 'utf8'));
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    console.error('dodo-webhook signature check error:', e);
    return false;
  }
}

async function handleDodoWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // Vercel parses JSON bodies; reconstruct raw body best-effort for HMAC
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const event = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (!verifyDodoSignature(req, rawBody)) {
      console.error('dodo-webhook: signature verification failed');
      try { await alertGodwin(getSupabase(), 'dodo_signature_fail', `webhook-id=${req.headers['webhook-id'] || 'none'}`); } catch (e) { /* ignore */ }
      return res.status(200).json({ ok: true, ignored: 'bad signature' });
    }

    const type = event.type || event.event_type || '';
    const data = event.data || {};
    const metadata = data.metadata || {};
    const email =
      (data.customer && data.customer.email) || data.customer_email || data.email || null;

    const activate = ['subscription.active', 'payment.succeeded'].includes(type);
    const churn = ['subscription.cancelled', 'subscription.expired'].includes(type);
    const failed = ['payment.failed', 'subscription.payment_failed'].includes(type);
    if (!activate && !churn && !failed) {
      return res.status(200).json({ ok: true, ignored: type || 'unknown event' });
    }

    const supabase = getSupabase();
    let client = null;

    if (metadata.client_id) {
      const { data: byId } = await supabase
        .from('tool_clients')
        .select('*')
        .eq('id', metadata.client_id)
        .single();
      client = byId || null;
    }
    if (!client && email) {
      const { data: byEmail } = await supabase
        .from('tool_clients')
        .select('*')
        .eq('owner_email', email)
        .limit(1);
      client = (byEmail && byEmail[0]) || null;
    }
    if (!client) {
      console.error('dodo-webhook: no matching client for event', type, metadata.client_id, email);
      return res.status(200).json({ ok: true, matched: false });
    }

    const status = activate ? 'active' : failed ? 'past_due' : 'churned';
    const { error } = await supabase
      .from('tool_clients')
      .update({ status })
      .eq('id', client.id);
    if (error) console.error('dodo-webhook: status update failed', error);

    // On payment failure: enter dunning — service continues, email the owner.
    if (failed && client.owner_email) {
      try {
        await sendEmail({
          to: client.owner_email,
          toName: client.owner_name,
          subject: 'Payment issue with Vyrrah Recaller',
          body: [
            `Hi ${client.owner_name || 'there'},`,
            '',
            `Your payment for ${BRAND.name} didn't go through. No need to worry — your service continues for now.`,
            '',
            `Update your card here: ${PUBLIC_BASE}/recaller?token=${client.magic_token}`,
            'Or grab 15 min with Godwin if you need a hand: cal.com/godwin-rayen/30min',
            '',
            `— ${BRAND.from}`
          ].join('\n')
        });
      } catch (mailErr) {
        console.error('dodo-webhook: dunning email failed', mailErr);
      }
    }

    // On churn, best-effort release any pooled number back to availability.
    if (churn) {
      try {
        await supabase.from('number_pool')
          .update({ status: 'available', assigned_client_id: null })
          .eq('assigned_client_id', client.id);
      } catch (relErr) {
        console.error('dodo-webhook: pool release failed', relErr);
      }
    }

    return res.status(200).json({ ok: true, client_id: client.id, status });
  } catch (err) {
    console.error('tool/dodo-webhook error:', err);
    return res.status(200).json({ ok: true, error: err.message }); // always 200
  }
}

// ─── 10. GET /api/tool/pay?client_id=X — create Dodo checkout link (admin) ──

async function handlePay(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!process.env.DODO_API_KEY) {
      return res.status(200).json({ manual: true, message: 'Dodo not connected — invoice manually' });
    }
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const supabase = getSupabase();
    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('id', clientId)
      .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    try {
      const r = await fetch('https://live.dodopayments.com/subscriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DODO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          product_id: process.env.DODO_PRODUCT_ID,
          quantity: 1,
          payment_link: true,
          customer: {
            email: client.owner_email,
            name: client.owner_name || client.practice_name
          },
          billing: { country: 'US', state: '', city: '', street: '', zipcode: '' },
          metadata: { client_id: String(client.id) }
        })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(200).json({ error: `Dodo API ${r.status}`, detail: body });
      }
      return res.status(200).json({
        link: body.payment_link || body.link || body.url || null,
        subscription_id: body.subscription_id || body.id || null,
        raw: body
      });
    } catch (apiErr) {
      console.error('tool/pay Dodo API error:', apiErr);
      return res.status(200).json({ error: apiErr.message });
    }
  } catch (err) {
    console.error('tool/pay error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/tool/verify-status?token=MAGIC — live forwarding check ─────────
// No auth (magic token). Polled by start.html during onboarding.
async function handleVerifyStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });

    const { data: client } = await supabase
      .from('tool_clients')
      .select('forwarding_verified, verified_at, twilio_number, last_inbound_at')
      .eq('magic_token', token)
      .single();
    if (!client) return res.status(404).json({ error: 'Invalid token' });

    return res.status(200).json({
      verified: !!client.forwarding_verified,
      verified_at: client.verified_at || null,
      twilio_number: client.twilio_number || null,
      last_inbound_at: client.last_inbound_at || null
    });
  } catch (err) {
    console.error('tool/verify-status error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Number pool ─────────────────────────────────────────────────────────────

// GET /api/tool/pool — counts + list (admin)
async function handlePool(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const { data: rows, error } = await supabase
      .from('number_pool')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const list = rows || [];
    const available = list.filter((r) => r.status === 'available').length;
    const assigned = list.filter((r) => r.status === 'assigned').length;
    return res.status(200).json({ available, assigned, total: list.length, numbers: list });
  } catch (err) {
    console.error('tool/pool error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/tool/pool/refill { count, area_code } — buy & stock numbers (admin)
async function handlePoolRefill(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const count = (req.body && req.body.count) || 1;
    const areaCode = (req.body && req.body.area_code) || null;
    const { added, numbers, errors } = await buyPoolNumbers(supabase, count, areaCode);
    return res.status(200).json({ ok: true, added, numbers, errors });
  } catch (err) {
    console.error('tool/pool/refill error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── #3 POST /api/tool/block & /unblock — caller blocklist (magic OR admin) ──
async function handleBlock(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { token, client_id, phone, reason } = req.body || {};
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const digits = normalizePhone(phone);
    if (!digits) return res.status(400).json({ error: 'phone required' });
    const { error } = await supabase.from('tool_blocklist').insert({
      client_id: client.id,
      phone: digits,
      reason: (reason && String(reason).slice(0, 200)) || null,
      created_at: new Date().toISOString()
    });
    if (error) throw error;
    return res.status(200).json({ ok: true, blocked: maskPhone(digits) });
  } catch (err) {
    console.error('tool/block error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleUnblock(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { token, client_id, phone } = req.body || {};
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const digits = normalizePhone(phone);
    if (!digits) return res.status(400).json({ error: 'phone required' });
    const { error } = await supabase
      .from('tool_blocklist')
      .delete()
      .eq('client_id', client.id)
      .eq('phone', digits);
    if (error) throw error;
    return res.status(200).json({ ok: true, unblocked: maskPhone(digits) });
  } catch (err) {
    console.error('tool/unblock error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/tool/admin-overview — command center data (admin) ──────────────
async function handleAdminOverview(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const { data: clients, error } = await supabase
      .from('tool_clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const out = [];
    for (const c of clients || []) {
      let s7 = null, s30 = null;
      try { s7 = await computeStats(supabase, c.id, 7); } catch (e) { console.error('overview s7', c.id, e); }
      try { s30 = await computeStats(supabase, c.id, 30); } catch (e) { console.error('overview s30', c.id, e); }

      const lastIn = c.last_inbound_at ? new Date(c.last_inbound_at).getTime() : 0;
      const sinceIn = lastIn ? now - lastIn : Infinity;
      const trialMs = c.trial_started_at ? new Date(c.trial_started_at).getTime() : 0;
      const trialEndsMs = trialMs ? trialMs + 7 * DAY : 0;
      const trialDaysLeft = trialEndsMs ? Math.ceil((trialEndsMs - now) / DAY) : null;

      let health;
      if (!c.forwarding_verified) health = 'unverified';
      else if (sinceIn <= 7 * DAY) health = 'healthy';
      else if (sinceIn <= 14 * DAY) health = 'quiet';
      else health = 'at_risk';
      if (c.status === 'trial' && trialDaysLeft != null && trialDaysLeft < 2) health = 'at_risk';
      if (c.status === 'past_due') health = 'at_risk';

      const slim = (s) => s ? {
        calls: s.total_calls, missed: s.missed, recovered: s.recovered,
        booked: s.booked, est_revenue_saved: s.est_revenue_saved
      } : null;

      out.push({
        id: c.id,
        practice_name: c.practice_name,
        status: c.status,
        twilio_number: c.twilio_number || null,
        magic_token: c.magic_token || null,
        forwarding_verified: !!c.forwarding_verified,
        created_at: c.created_at,
        trial_started_at: c.trial_started_at || null,
        trial_days_left: c.status === 'trial' ? trialDaysLeft : null,
        last_inbound_at: c.last_inbound_at || null,
        health,
        stats_7d: slim(s7),
        stats_30d: slim(s30)
      });
    }

    // sort: at_risk + unverified float to top
    const prio = { at_risk: 0, unverified: 1, quiet: 2, healthy: 3 };
    out.sort((a, b) => (prio[a.health] - prio[b.health]) || (new Date(b.created_at) - new Date(a.created_at)));

    let pool = { available: 0, assigned: 0, total: 0 };
    try {
      const { data: prows } = await supabase.from('number_pool').select('status');
      const pl = prows || [];
      pool = {
        available: pl.filter((r) => r.status === 'available').length,
        assigned: pl.filter((r) => r.status === 'assigned').length,
        total: pl.length
      };
    } catch (e) { console.error('overview pool', e); }

    const active = out.filter((c) => c.status === 'active').length;
    const trial = out.filter((c) => c.status === 'trial').length;
    const totals = {
      total_clients: out.length,
      active,
      trial,
      mrr: active * 500 + trial * 0,
      total_revenue_recovered: out.reduce((sum, c) => sum + ((c.stats_30d && c.stats_30d.est_revenue_saved) || 0), 0),
      pool_available: pool.available
    };

    return res.status(200).json({ totals, pool, clients: out });
  } catch (err) {
    console.error('tool/admin-overview error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/tool/reply — owner portal reply + human takeover ──────────────
// Magic-token auth. Sends an owner-authored SMS to a caller (identified by last4),
// then opens a 24h human-takeover window suppressing AI auto-replies.
async function handleReply(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const { token, last4, body } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    if (!last4) return res.status(400).json({ error: 'last4 required' });
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) return res.status(400).json({ error: 'body required' });

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('magic_token', token)
      .single();
    if (!client) return res.status(404).json({ error: 'Invalid token' });
    if (!client.twilio_number) return res.status(400).json({ error: 'No Vyrrah number provisioned' });

    const last4Digits = normalizePhone(last4).slice(-4);

    // Find caller_phone: most recent message or call whose number ends in last4.
    let caller = null;
    let latestTs = 0;
    const { data: msgs } = await supabase
      .from('tool_messages')
      .select('caller_phone, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(200);
    for (const m of msgs || []) {
      if (m.caller_phone && normalizePhone(m.caller_phone).slice(-4) === last4Digits) {
        const ts = new Date(m.created_at).getTime();
        if (ts >= latestTs) { latestTs = ts; caller = m.caller_phone; }
      }
    }
    const { data: calls } = await supabase
      .from('tool_calls')
      .select('caller_phone, created_at')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .limit(200);
    for (const c of calls || []) {
      if (c.caller_phone && normalizePhone(c.caller_phone).slice(-4) === last4Digits) {
        const ts = new Date(c.created_at).getTime();
        if (ts >= latestTs) { latestTs = ts; caller = c.caller_phone; }
      }
    }
    if (!caller) return res.status(404).json({ error: 'No caller found matching last4' });

    // Register the 24h takeover FIRST — the owner has taken over this thread,
    // and that intent must hold even if this one SMS fails to deliver.
    let takeoverOk = false;
    try {
      await supabase.from('tool_takeovers')
        .delete()
        .eq('client_id', client.id)
        .eq('caller_phone', caller);
      await supabase.from('tool_takeovers').insert({
        client_id: client.id,
        caller_phone: caller,
        until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
      takeoverOk = true;
    } catch (e) { console.error('takeover insert failed:', e); }

    // Send immediately (owner-initiated — bypass quiet hours), logging an
    // outbound row with ai_generated=false.
    const { data: row } = await supabase.from('tool_messages').insert({
      client_id: client.id,
      caller_phone: caller,
      direction: 'outbound',
      body: text,
      ai_generated: false,
      delivery_status: 'queued'
    }).select().single();
    try {
      const msg = await sendSms(getTwilioClient(), { from: client.twilio_number, to: caller, body: text });
      if (row) await supabase.from('tool_messages').update({ twilio_sid: msg.sid }).eq('id', row.id);
    } catch (sendErr) {
      console.error('handleReply send failed:', sendErr);
      if (row) await supabase.from('tool_messages').update({ delivery_status: 'failed' }).eq('id', row.id);
      // Takeover is already set; report partial success so the UI can show "couldn't deliver".
      return res.status(200).json({ ok: false, takeover: takeoverOk, sent: false, sent_to: maskPhone(caller), error: 'message could not be delivered, but you have the conversation' });
    }

    // (legacy block retained below as no-op safety; takeover already set above)
    if (false) try {
      await supabase.from('tool_takeovers').insert({
        client_id: client.id,
        caller_phone: caller,
        until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
    } catch (toErr) {
      console.error('handleReply takeover upsert error:', toErr);
    }

    return res.status(200).json({ ok: true, sent_to: maskPhone(caller) });
  } catch (err) {
    console.error('tool/reply error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/tool/admin-action — admin lifecycle controls ──────────────────
async function handleAdminAction(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const { client_id, action, value } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'client_id required' });
    if (!action) return res.status(400).json({ error: 'action required' });

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('id', client_id)
      .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    let patch = {};
    switch (action) {
      case 'pause':
        patch = { status: 'paused' };
        break;
      case 'resume':
        patch = { status: 'active' };
        break;
      case 'churn':
        patch = { status: 'churned' };
        break;
      case 'set_value':
        patch = { avg_customer_value: Number(value) };
        break;
      case 'reactivate_trial':
        patch = {
          status: 'trial',
          trial_started_at: new Date().toISOString(),
          day5_sent: false,
          day7_sent: false
        };
        break;
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    const { data: updated, error } = await supabase
      .from('tool_clients')
      .update(patch)
      .eq('id', client.id)
      .select()
      .single();
    if (error) throw error;

    // On churn, best-effort release any pooled number (same pattern as dodo-webhook).
    if (action === 'churn') {
      try {
        await supabase.from('number_pool')
          .update({ status: 'available', assigned_client_id: null })
          .eq('assigned_client_id', client.id);
      } catch (relErr) {
        console.error('admin-action: pool release failed', relErr);
      }
    }

    return res.status(200).json({ ok: true, client: updated });
  } catch (err) {
    console.error('tool/admin-action error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Booking endpoints ───────────────────────────────────────────────────────

// GET /api/tool/availability?token=MAGIC&date=YYYY-MM-DD — open slots for a day.
// Magic-token auth (client-facing portal). If no date, returns next-5-day slots.
async function handleAvailability(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    const client = await resolveClient(supabase, { token });
    if (!client) return res.status(404).json({ error: 'Invalid token' });

    const date = req.query.date;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // Slots for a single day: generate a wide window then filter to that date.
      const all = await getOpenSlots(supabase, client, { days: 14, maxSlots: 200 });
      const tz = client.timezone || 'America/New_York';
      const ymdFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      });
      const slots = all.filter((s) => {
        try { return ymdFmt.format(new Date(s.start_at)) === date; } catch (e) { return false; }
      });
      return res.status(200).json({ slots });
    }

    const slots = await getOpenSlots(supabase, client, { days: 5, maxSlots: 50 });
    return res.status(200).json({ slots });
  } catch (err) {
    console.error('tool/availability error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// /api/tool/appointments
//   GET  ?token=MAGIC | ?client_id (admin) — list upcoming appointments.
//   POST { token|client_id, caller_phone, caller_name, start_at, service } — manual booking.
async function handleAppointments(req, res) {
  const supabase = getSupabase();
  try {
    if (req.method === 'GET') {
      const token = req.query.token;
      const client_id = req.query.client_id;
      if (!token && !requireAuth(req, res)) return; // client_id path is admin-gated
      const client = await resolveClient(supabase, { token, client_id });
      if (!client) return res.status(404).json({ error: 'Client not found' });

      const { data: appts } = await supabase
        .from('tool_appointments')
        .select('*')
        .eq('client_id', client.id)
        .in('status', ['booked', 'confirmed'])
        .gte('start_at', new Date().toISOString())
        .order('start_at', { ascending: true })
        .limit(100);
      const tz = client.timezone || 'America/New_York';
      const out = (appts || []).map((a) => ({
        id: a.id,
        caller: maskPhone(a.caller_phone),
        caller_name: a.caller_name || null,
        start_at: a.start_at,
        end_at: a.end_at,
        label: slotLabel(new Date(a.start_at), tz),
        service: a.service || null,
        status: a.status
      }));
      return res.status(200).json({ appointments: out });
    }

    if (req.method === 'POST') {
      const { token, client_id, caller_phone, caller_name, start_at, service } = req.body || {};
      if (!token && !requireAuth(req, res)) return;
      const client = await resolveClient(supabase, { token, client_id });
      if (!client) return res.status(404).json({ error: 'Client not found' });
      if (!start_at || isNaN(new Date(start_at).getTime())) {
        return res.status(400).json({ error: 'valid start_at (ISO) required' });
      }
      try {
        const { appointment, label } = await createBooking(supabase, client, {
          caller_phone: caller_phone || null,
          caller_name: caller_name || null,
          start_at,
          service: service || null,
          source: 'manual'
        });
        return res.status(200).json({ ok: true, appointment, label });
      } catch (bookErr) {
        if (bookErr.slotTaken) return res.status(409).json({ error: 'That time is already booked. Pick another slot.' });
        throw bookErr;
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('tool/appointments error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/tool/appointments/cancel { token|client_id, appointment_id }
async function handleAppointmentsCancel(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { token, client_id, appointment_id } = req.body || {};
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' });

    const { data: appt } = await supabase
      .from('tool_appointments')
      .select('*')
      .eq('id', appointment_id)
      .eq('client_id', client.id)
      .single();
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    await cancelBooking(supabase, client, appt);
    const label = slotLabel(new Date(appt.start_at), client.timezone || 'America/New_York');
    if (appt.caller_phone && client.twilio_number) {
      try {
        await sendSms(getTwilioClient(), {
          from: client.twilio_number,
          to: appt.caller_phone,
          body: `Your appointment for ${label} has been cancelled. Reply anytime to rebook.`
        });
      } catch (e) { console.error('cancel SMS failed:', e); }
    }
    return res.status(200).json({ ok: true, cancelled: appt.id });
  } catch (err) {
    console.error('tool/appointments/cancel error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/tool/config { token|client_id, booking_mode, slot_minutes, timezone,
//   availability, booking_link, google_calendar_id } — update booking config.
async function handleConfig(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const b = req.body || {};
    const { token, client_id } = b;
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const patch = {};
    if (b.booking_mode !== undefined) {
      if (!['native', 'google', 'calcom', 'handoff'].includes(b.booking_mode)) {
        return res.status(400).json({ error: 'invalid booking_mode' });
      }
      patch.booking_mode = b.booking_mode;
    }
    if (b.slot_minutes !== undefined) {
      const n = parseInt(b.slot_minutes, 10);
      if (!Number.isFinite(n) || n < 5 || n > 480) {
        return res.status(400).json({ error: 'slot_minutes must be 5-480' });
      }
      patch.slot_minutes = n;
    }
    if (b.timezone !== undefined) patch.timezone = String(b.timezone);
    if (b.booking_link !== undefined) {
      let bl = (b.booking_link || '').trim();
      if (bl) {
        // Reject anything with HTML/script chars; require a plausible URL/domain.
        if (/[<>"'`]/.test(bl) || !/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(bl)) {
          return res.status(400).json({ error: 'booking_link must be a valid URL' });
        }
      }
      patch.booking_link = bl || null;
    }
    if (b.google_calendar_id !== undefined) patch.google_calendar_id = b.google_calendar_id || 'primary';
    if (b.availability !== undefined) {
      if (b.availability !== null && typeof b.availability !== 'object') {
        return res.status(400).json({ error: 'availability must be an object' });
      }
      // Light validation: each value should be [open, close] HH:MM strings.
      if (b.availability) {
        for (const k of Object.keys(b.availability)) {
          const v = b.availability[k];
          if (v != null && (!Array.isArray(v) || v.length < 2 || !parseHM(v[0]) || !parseHM(v[1]))) {
            return res.status(400).json({ error: `invalid availability for ${k} (expected ["HH:MM","HH:MM"])` });
          }
        }
      }
      patch.availability = b.availability;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });

    const { data: updated, error } = await supabase
      .from('tool_clients').update(patch).eq('id', client.id).select().single();
    if (error) throw error;
    return res.status(200).json({ ok: true, client: updated });
  } catch (err) {
    console.error('tool/config error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Google Calendar OAuth ───────────────────────────────────────────────────

// GET /api/tool/google/connect?token=MAGIC — redirect to Google consent.
async function handleGoogleConnect(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!googleConfigured()) return res.status(200).json({ error: 'Google not configured' });
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    const supabase = getSupabase();
    const client = await resolveClient(supabase, { token });
    if (!client) return res.status(404).json({ error: 'Invalid token' });

    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: GOOGLE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state: token
    }).toString();
    res.writeHead(302, { Location: url });
    return res.end();
  } catch (err) {
    console.error('tool/google/connect error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/tool/google/callback?code=&state= — exchange code, store refresh token.
async function handleGoogleCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!googleConfigured()) return res.status(200).json({ error: 'Google not configured' });
    const code = req.query.code;
    const state = req.query.state; // = magic token
    if (!code || !state) return res.status(400).json({ error: 'code and state required' });
    const supabase = getSupabase();
    const client = await resolveClient(supabase, { token: state });
    if (!client) return res.status(404).json({ error: 'Invalid state' });

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      }).toString()
    });
    if (!r.ok) {
      console.error('google token exchange failed', r.status, await r.text());
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send('<html><body><h2>Connection failed</h2><p>Please try again.</p></body></html>');
    }
    const data = await r.json();
    const refresh = data.refresh_token;
    if (!refresh) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send('<html><body><h2>Connection incomplete</h2><p>No refresh token returned — try again and approve offline access.</p></body></html>');
    }
    await supabase.from('tool_clients')
      .update({ google_refresh_token: refresh, booking_mode: 'google' })
      .eq('id', client.id);
    _googleTokenCache.delete(client.id);

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(
      '<html><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h2>Google Calendar connected</h2>' +
      '<p>You can close this tab.</p></body></html>'
    );
  } catch (err) {
    console.error('tool/google/callback error:', err);
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send('<html><body><h2>Something went wrong</h2></body></html>');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE 1 — REACTIVATION (win back lapsed patients)
// ═══════════════════════════════════════════════════════════════════════════

// Is this patient lapsed? (no visit within client.lapsed_months; null last_visit
// counts as lapsed/eligible — they're an 'idle' unknown.)
function isLapsed(patient, lapsedMonths) {
  if (!patient.last_visit) return true;
  const lv = new Date(patient.last_visit).getTime();
  if (Number.isNaN(lv)) return true;
  const months = Number.isFinite(lapsedMonths) ? lapsedMonths : 7;
  const cutoff = Date.now() - months * 30 * 24 * 3600 * 1000;
  return lv < cutoff;
}

// One reactivation drip pass for a single client. Returns { contacted, rebooked_pending }.
// Shared by the manual /reactivation/run endpoint and the daily cron.
async function reactivationPass(supabase, client, { limit = 25 } = {}) {
  const out = { contacted: 0, rebooked_pending: 0 };
  if (!client || !client.reactivation_enabled) return out;
  if (!['active', 'trial'].includes(client.status)) return out;
  if (!client.twilio_number) return out;

  const lapsedMonths = Number.isFinite(client.lapsed_months) ? client.lapsed_months : 7;
  const ownerDigits = normalizePhone(client.owner_phone);
  const lineDigits = normalizePhone(client.real_line);
  const bookingLink = client.booking_link || null;
  const offersSlots = (client.booking_mode === 'native' || client.booking_mode === 'google');

  // Eligible: not yet replied/rebooked/opted_out/unreachable, and not exhausted (step<3).
  const { data: patients, error } = await supabase
    .from('tool_patients')
    .select('*')
    .eq('client_id', client.id)
    .in('reactivation_status', ['idle', 'queued', 'contacted'])
    .lt('reactivation_step', 3)
    .order('est_value', { ascending: false, nullsFirst: false })
    .order('last_visit', { ascending: true })
    .limit(500);
  if (error) { console.error('reactivationPass query error:', error); return out; }

  let sent = 0;
  for (const p of patients || []) {
    if (sent >= limit) break;
    if (!p.phone) continue;
    if (!isLapsed(p, lapsedMonths)) continue;

    const pDigits = normalizePhone(p.phone);
    // Skip the practice's own lines.
    if (pDigits === ownerDigits || pDigits === lineDigits) continue;
    // Skip non-textable.
    if (isNonTextableCaller(p.phone)) continue;
    // Respect opt-out (STOP previously, or marked).
    if (await callerOptedOut(supabase, client.id, p.phone)) {
      await supabase.from('tool_patients')
        .update({ reactivation_status: 'opted_out' }).eq('id', p.id);
      continue;
    }

    const step = p.reactivation_step || 0;
    const lastContacted = p.last_contacted_at ? new Date(p.last_contacted_at).getTime() : 0;
    const ageDays = lastContacted ? (Date.now() - lastContacted) / 86400000 : Infinity;

    let nextStep = null;
    if (step === 0) nextStep = 1;
    else if (step === 1 && ageDays >= 3) nextStep = 2;
    else if (step === 2 && ageDays >= 4) nextStep = 3;
    if (nextStep === null) continue; // not due yet

    // Build the message for this step.
    const name = p.name || 'there';
    const practice = client.practice_name;
    let bookingTail = '';
    if (offersSlots) {
      try {
        const slots = await getOpenSlots(supabase, client, { days: 5, maxSlots: 3 });
        if (slots.length) {
          stashOffer(client.id, p.phone, slots);
          bookingTail = ' I can get you in: ' +
            slots.map((s, i) => `${i + 1}) ${s.label}`).join('  ') + ' — reply with the number.';
        } else if (bookingLink) {
          bookingTail = ` Book here: ${bookingLink}`;
        }
      } catch (e) { console.error('reactivation getOpenSlots error:', e); }
    } else if (bookingLink) {
      bookingTail = ` Book here: ${bookingLink}`;
    }

    let purpose, fallback;
    if (nextStep === 1) {
      purpose = `This is a former patient we haven't seen in a while. Warmly say we miss them and invite them to rebook.`;
      fallback = `Hi ${name}, it's ${practice} — it's been a while since your last visit! We'd love to get you back in. Want me to find you a time?`;
    } else if (nextStep === 2) {
      const incentive = /vip|loyal|premium|high.?value/i.test(String(p.tags || ''))
        ? ' As a valued patient, we\'d love to take care of you.' : '';
      purpose = `Light, friendly follow-up nudge to a former patient who didn't reply to our first message. Keep it brief and low-pressure.${incentive ? ' Mention we value them.' : ''}`;
      fallback = `Hi ${name}, just checking in from ${practice} — still happy to get you booked whenever suits.${incentive}`;
    } else {
      purpose = `Final, gentle message to a former patient. Say we'll stop reaching out but we're here whenever they're ready. Include the booking option.`;
      fallback = `Hi ${name}, we'll stop reaching out for now — but ${practice} is here whenever you're ready to come back.`;
    }

    let body = await generateAiMessage({ client, purpose, fallback });
    if (bookingTail && !body.includes(bookingTail.trim().slice(0, 12))) body = body + bookingTail;

    try {
      await sendOrDefer(supabase, client, { caller: p.phone, body, ai_generated: aiAvailable() });
    } catch (e) {
      console.error('reactivation send error:', e);
      continue;
    }
    // Tag the most recent outbound row for this caller as reactivation (best-effort).
    try {
      const { data: lastOut } = await supabase
        .from('tool_messages')
        .select('id')
        .eq('client_id', client.id)
        .eq('caller_phone', p.phone)
        .eq('direction', 'outbound')
        .order('created_at', { ascending: false })
        .limit(1);
      if (lastOut && lastOut[0]) {
        await supabase.from('tool_messages')
          .update({ reactivation: true }).eq('id', lastOut[0].id);
      }
    } catch (e) { /* column optional — ignore */ }

    await supabase.from('tool_patients').update({
      reactivation_status: 'contacted',
      reactivation_step: nextStep,
      last_contacted_at: new Date().toISOString()
    }).eq('id', p.id);

    out.contacted++;
    out.rebooked_pending++;
    sent++;
  }
  return out;
}

// POST /api/tool/patients/import { token|client_id, patients:[...] }
async function handlePatientsImport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const b = req.body || {};
    const { token, client_id } = b;
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    let rows = Array.isArray(b.patients) ? b.patients : [];
    if (rows.length > 2000) rows = rows.slice(0, 2000);

    let imported = 0, skipped = 0;
    for (const r of rows) {
      const phoneRaw = r && r.phone;
      const phone = normalizePhone(phoneRaw);
      if (!phone || phone.length < 10) { skipped++; continue; }
      let last_visit = null;
      if (r.last_visit) {
        const d = new Date(r.last_visit);
        if (!Number.isNaN(d.getTime())) last_visit = d.toISOString().slice(0, 10);
      }
      const record = {
        client_id: client.id,
        name: (r.name && String(r.name).slice(0, 120)) || null,
        phone,
        last_visit,
        tags: (r.tags && String(r.tags).slice(0, 200)) || null,
        est_value: (r.est_value != null && Number.isFinite(Number(r.est_value))) ? Number(r.est_value) : null
      };
      const { error } = await supabase
        .from('tool_patients')
        .upsert(record, { onConflict: 'client_id,phone' });
      if (error) { console.error('patient upsert error:', error); skipped++; continue; }
      imported++;
    }

    const { count } = await supabase
      .from('tool_patients')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', client.id);

    return res.status(200).json({ imported, skipped, total: count || null });
  } catch (err) {
    console.error('tool/patients/import error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/tool/patients?token|client_id&status= — list + counts by status.
async function handlePatients(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const token = req.query.token;
    const client_id = req.query.client_id;
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const isClientView = !!token;

    let q = supabase.from('tool_patients').select('*').eq('client_id', client.id);
    if (req.query.status) q = q.eq('reactivation_status', req.query.status);
    const { data: patients } = await q
      .order('est_value', { ascending: false, nullsFirst: false })
      .limit(500);

    const list = patients || [];
    const counts = {};
    for (const p of list) {
      counts[p.reactivation_status] = (counts[p.reactivation_status] || 0) + 1;
    }
    const out = list.map((p) => ({
      id: p.id,
      name: p.name || null,
      phone: isClientView ? maskPhone(p.phone) : p.phone,
      last_visit: p.last_visit,
      tags: p.tags,
      est_value: p.est_value,
      reactivation_status: p.reactivation_status,
      reactivation_step: p.reactivation_step,
      last_contacted_at: p.last_contacted_at
    }));
    return res.status(200).json({ counts, patients: out });
  } catch (err) {
    console.error('tool/patients error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/tool/reactivation/run { token|client_id } — manual one-pass trigger.
async function handleReactivationRun(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { token, client_id } = req.body || {};
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.reactivation_enabled) {
      return res.status(200).json({ contacted: 0, rebooked_pending: 0, disabled: true });
    }
    const result = await reactivationPass(supabase, client, { limit: 25 });
    return res.status(200).json(result);
  } catch (err) {
    console.error('tool/reactivation/run error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// POST /api/tool/reactivation/toggle { token|client_id, enabled }
async function handleReactivationToggle(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { token, client_id, enabled } = req.body || {};
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const { data: updated, error } = await supabase
      .from('tool_clients')
      .update({ reactivation_enabled: !!enabled })
      .eq('id', client.id)
      .select('id, reactivation_enabled')
      .single();
    if (error) throw error;
    return res.status(200).json({ ok: true, reactivation_enabled: updated.reactivation_enabled });
  } catch (err) {
    console.error('tool/reactivation/toggle error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Helper: if an inbound caller matches a tool_patients row, mark a new status
// (only "advancing" — never downgrade a rebooked/opted_out). Best-effort.
async function markPatientStatus(supabase, clientId, callerPhone, status) {
  try {
    const digits = normalizePhone(callerPhone);
    if (!digits) return;
    const { data: rows } = await supabase
      .from('tool_patients')
      .select('id, reactivation_status')
      .eq('client_id', clientId)
      .eq('phone', digits)
      .limit(1);
    const p = rows && rows[0];
    if (!p) return;
    // Ranking so we never regress: opted_out/rebooked are terminal-ish.
    const rank = { idle: 0, queued: 1, contacted: 2, replied: 3, rebooked: 4, opted_out: 5, unreachable: 1 };
    if ((rank[status] || 0) < (rank[p.reactivation_status] || 0) &&
        !(status === 'opted_out')) {
      return; // don't downgrade (except opt-out always wins)
    }
    await supabase.from('tool_patients')
      .update({ reactivation_status: status }).eq('id', p.id);
  } catch (e) {
    console.error('markPatientStatus error:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE 2 — REVIEW LOOP
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/tool/reviews/mark { token|client_id, caller_phone, status }
async function handleReviewsMark(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const { token, client_id, caller_phone, status } = req.body || {};
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!caller_phone) return res.status(400).json({ error: 'caller_phone required' });
    const allowed = ['requested', 'clicked', 'left', 'declined'];
    const st = allowed.includes(status) ? status : 'left';
    const digits = normalizePhone(caller_phone);

    const { data: rows } = await supabase
      .from('tool_reviews')
      .select('id')
      .eq('client_id', client.id)
      .eq('caller_phone', digits)
      .order('requested_at', { ascending: false })
      .limit(1);
    if (rows && rows[0]) {
      await supabase.from('tool_reviews').update({ status: st }).eq('id', rows[0].id);
    } else {
      await supabase.from('tool_reviews').insert({
        client_id: client.id, caller_phone: digits, status: st,
        requested_at: new Date().toISOString()
      });
    }
    return res.status(200).json({ ok: true, status: st });
  } catch (err) {
    console.error('tool/reviews/mark error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// GET /api/tool/reviews?token|client_id — counts + recent list.
async function handleReviews(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const token = req.query.token;
    const client_id = req.query.client_id;
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const isClientView = !!token;

    const { data: reviews } = await supabase
      .from('tool_reviews')
      .select('*')
      .eq('client_id', client.id)
      .order('requested_at', { ascending: false })
      .limit(100);
    const list = reviews || [];
    const counts = { requested: 0, clicked: 0, left: 0, declined: 0 };
    for (const r of list) counts[r.status] = (counts[r.status] || 0) + 1;
    const recent = list.slice(0, 25).map((r) => ({
      caller: isClientView ? maskPhone(r.caller_phone) : r.caller_phone,
      status: r.status,
      requested_at: r.requested_at
    }));
    return res.status(200).json({ counts, recent });
  } catch (err) {
    console.error('tool/reviews error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Cron sub-task: send review requests for recently-booked appointments whose
// start_at is in the past 1-3 days, for review-enabled clients with a url, and
// for which we have no tool_reviews row for that caller in the last 30 days.
async function reviewLoopPass(supabase) {
  const results = [];
  try {
    const now = Date.now();
    const from = new Date(now - 3 * 86400000).toISOString();
    const to = new Date(now - 1 * 86400000).toISOString();
    const { data: appts } = await supabase
      .from('tool_appointments')
      .select('*')
      .eq('status', 'booked')
      .gte('start_at', from)
      .lte('start_at', to)
      .limit(200);
    const clientCache = new Map();
    for (const appt of appts || []) {
      try {
        if (!appt.caller_phone) continue;
        let client = clientCache.get(appt.client_id);
        if (client === undefined) {
          const { data: c } = await supabase
            .from('tool_clients').select('*').eq('id', appt.client_id).single();
          client = c || null; clientCache.set(appt.client_id, client);
        }
        if (!client) continue;
        if (!client.review_requests_enabled || !client.google_review_url) continue;
        if (!client.twilio_number) continue;
        if (!['active', 'trial'].includes(client.status)) continue;

        const digits = normalizePhone(appt.caller_phone);
        // One per caller per 30 days.
        const since = new Date(now - 30 * 86400000).toISOString();
        const { data: existing } = await supabase
          .from('tool_reviews')
          .select('id')
          .eq('client_id', client.id)
          .eq('caller_phone', digits)
          .gte('requested_at', since)
          .limit(1);
        if (existing && existing[0]) continue;

        if (await callerOptedOut(supabase, client.id, appt.caller_phone)) continue;

        const body = `Hi! Thanks for choosing ${client.practice_name}. If you have 30 seconds, we'd love a quick review: ${client.google_review_url}`;
        await sendOrDefer(supabase, client, { caller: appt.caller_phone, body, ai_generated: false });
        await supabase.from('tool_reviews').insert({
          client_id: client.id,
          caller_phone: digits,
          call_id: null,
          status: 'requested',
          requested_at: new Date().toISOString()
        });
        results.push({ appointment_id: appt.id, requested: true });
      } catch (e) {
        console.error('reviewLoopPass appt error:', e);
        results.push({ appointment_id: appt.id, error: e.message });
      }
    }
  } catch (e) {
    console.error('reviewLoopPass error:', e);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE 3 — INTELLIGENCE REPORT v2
// ═══════════════════════════════════════════════════════════════════════════

const DOW_LABELS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
function hourBucketLabel(h) {
  const fmt = (x) => { const ap = x < 12 ? 'am' : 'pm'; let hr = x % 12; if (hr === 0) hr = 12; return `${hr}${ap}`; };
  const start = Math.floor(h / 2) * 2;
  return `${fmt(start)}-${fmt((start + 2) % 24)}`;
}

async function buildInsights(supabase, client, days = 30) {
  const tz = client.timezone || 'America/New_York';
  const avgValue = Number(client.avg_customer_value) || 500;
  const now = Date.now();
  const since = new Date(now - days * 86400000).toISOString();
  const priorSince = new Date(now - 2 * days * 86400000).toISOString();
  const missedOutcomes = ['missed', 'busy', 'failed', 'voicemail'];

  // Calls (current + prior window for trend).
  const { data: calls } = await supabase
    .from('tool_calls')
    .select('outcome, recovered, booked, created_at')
    .eq('client_id', client.id)
    .gte('created_at', priorSince)
    .order('created_at', { ascending: true });
  const all = calls || [];
  const cur = all.filter((c) => c.created_at >= since);
  const prior = all.filter((c) => c.created_at < since);

  const curMissed = cur.filter((c) => missedOutcomes.includes(c.outcome));
  const curRecovered = cur.filter((c) => c.recovered);
  const curBooked = cur.filter((c) => c.booked);
  const priorMissed = prior.filter((c) => missedOutcomes.includes(c.outcome));
  const priorRecovered = prior.filter((c) => c.recovered);

  // Peak missed-call window: day-of-week + 2h bucket (in client tz).
  const heat = {};
  let peakKey = null, peakCount = 0;
  for (const c of curMissed) {
    try {
      const d = new Date(c.created_at);
      const dow = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'numeric' }).format(d), 10);
      // weekday 'numeric' isn't standard; derive via short name instead.
      const wdShort = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d).toLowerCase().slice(0, 3);
      const dowIdx = WEEKDAY_KEYS.indexOf(wdShort);
      const hr = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d), 10) % 24;
      const key = `${dowIdx}:${Math.floor(hr / 2) * 2}`;
      heat[key] = (heat[key] || 0) + 1;
      if (heat[key] > peakCount) { peakCount = heat[key]; peakKey = key; }
    } catch (e) { /* ignore */ }
  }
  let peak_missed = null;
  if (peakKey && peakCount > 0) {
    const [dowIdx, hr] = peakKey.split(':').map((x) => parseInt(x, 10));
    peak_missed = {
      label: `${DOW_LABELS[dowIdx] || 'weekdays'} ${hourBucketLabel(hr)}`,
      count: peakCount
    };
  }

  // Recovery-rate trend.
  const curRate = curMissed.length ? curRecovered.length / curMissed.length : 0;
  const priorRate = priorMissed.length ? priorRecovered.length / priorMissed.length : 0;
  const trendPct = priorRate > 0 ? Math.round(((curRate - priorRate) / priorRate) * 100)
    : (curRate > 0 ? 100 : 0);
  const recovery_rate = {
    current_pct: Math.round(curRate * 100),
    prior_pct: Math.round(priorRate * 100),
    trend_pct: trendPct,
    direction: trendPct > 0 ? 'up' : trendPct < 0 ? 'down' : 'flat'
  };

  const booking_rate = {
    booked: curBooked.length,
    recovered: curRecovered.length,
    pct: curRecovered.length ? Math.round((curBooked.length / curRecovered.length) * 100) : 0
  };

  // Top enquiry themes from inbound messages.
  const { data: inbound } = await supabase
    .from('tool_messages')
    .select('body')
    .eq('client_id', client.id)
    .eq('direction', 'inbound')
    .gte('created_at', since)
    .limit(500);
  const inboundBodies = (inbound || []).map((m) => m.body || '').filter(Boolean);
  const themes = keywordThemes(inboundBodies);

  // Reactivation results.
  const { data: patients } = await supabase
    .from('tool_patients')
    .select('reactivation_status, est_value')
    .eq('client_id', client.id);
  const pList = patients || [];
  const contacted = pList.filter((p) => ['contacted', 'replied', 'rebooked'].includes(p.reactivation_status)).length;
  const rebookedRows = pList.filter((p) => p.reactivation_status === 'rebooked');
  const rebooked = rebookedRows.length;
  const reactRevenue = rebookedRows.reduce((s, p) => s + (Number(p.est_value) || avgValue), 0);
  const reactivation = { contacted, rebooked, est_revenue: reactRevenue };

  // ROI: revenue saved (recovered missed calls + reactivation) vs $500 cost.
  const recoveredRevenue = curRecovered.length * avgValue;
  const totalSaved = recoveredRevenue + reactRevenue;
  const cost = 500;
  const roiMultiple = Math.round((totalSaved / cost) * 10) / 10;
  const headline_roi = {
    revenue_saved: totalSaved,
    recovered_revenue: recoveredRevenue,
    reactivation_revenue: reactRevenue,
    cost,
    roi_multiple: roiMultiple
  };

  // Recommendations.
  const recommendations = [];
  if (peak_missed) {
    recommendations.push(`Most missed calls: ${peak_missed.label}. Consider phone coverage then.`);
  }
  if (recovery_rate.direction === 'down') {
    recommendations.push(`Recovery rate dropped ${Math.abs(trendPct)}% vs the prior period — review response times.`);
  }
  if (booking_rate.pct < 30 && booking_rate.recovered > 0) {
    recommendations.push(`Only ${booking_rate.pct}% of recovered conversations booked — tightening the booking ask could lift this.`);
  }
  if (client.reactivation_enabled && rebooked > 0) {
    recommendations.push(`Reactivation rebooked ${rebooked} lapsed patient(s) (~$${reactRevenue}). Keep the list fresh by re-importing monthly.`);
  }
  if (!recommendations.length) {
    recommendations.push('Everything is running smoothly — keep the line forwarded and the patient list current.');
  }

  return { days, headline_roi, peak_missed, recovery_rate, booking_rate, themes, reactivation, recommendations };
}

// Simple keyword tally fallback for enquiry themes.
function keywordThemes(bodies) {
  const buckets = {
    insurance: /\b(insurance|insur|cover|hicaps|medicare|claim)\b/i,
    hours: /\b(hours|open|close|closing|opening|today|tomorrow|weekend)\b/i,
    pricing: /\b(price|cost|how much|fee|quote|charge|expensive)\b/i,
    cancel: /\b(cancel|resched|reschedule|move|change my)\b/i,
    booking: /\b(book|appointment|appt|availab|slot|time)\b/i
  };
  const counts = {};
  for (const b of bodies) {
    for (const [k, re] of Object.entries(buckets)) {
      if (re.test(b)) counts[k] = (counts[k] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([theme, count]) => ({ theme, count }));
}

// GET /api/tool/insights?token|client_id&days=30
async function handleInsights(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const token = req.query.token;
    const client_id = req.query.client_id;
    if (!token && !requireAuth(req, res)) return;
    const client = await resolveClient(supabase, { token, client_id });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const days = parseInt(req.query.days, 10) || 30;
    const insights = await buildInsights(supabase, client, days);
    return res.status(200).json({ practice_name: client.practice_name, insights });
  } catch (err) {
    console.error('tool/insights error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── #7 Live demo (public, abuse-guarded) ─────────────────────────────────────
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim() ||
    req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

const DEMO_BODY = "👋 This is a demo from Vyrrah Recaller. THIS is the text your missed callers would get within 60 seconds — except it'd be from YOUR number, booking them in. Imagine never losing a patient to voicemail again. — Godwin, vyrrahlabs.com";

// POST /api/tool/demo  { phone }  — NO auth. Sends ONE demo SMS. Always 200.
async function handleDemo(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const supabase = getSupabase();
  try {
    const digits = normalizePhone((req.body || {}).phone);
    if (!digits || digits.length < 10) {
      return res.status(200).json({ ok: false, error: 'Please enter a valid phone number with area code.' });
    }
    if (isNonTextableCaller(digits)) {
      return res.status(200).json({ ok: false, error: "That number can't receive texts. Try a mobile number." });
    }
    const ip = clientIp(req);
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
    const hourAgo = new Date(now - 3600 * 1000).toISOString();
    const startOfDay = new Date(now - 24 * 3600 * 1000).toISOString();

    // Guard 1: max 1 send per phone per 24h.
    const { data: phoneHits } = await supabase
      .from('tool_demo_log').select('id').eq('phone', digits).gte('created_at', dayAgo).limit(1);
    if (phoneHits && phoneHits[0]) {
      return res.status(200).json({ ok: false, error: "We already texted this number today. Check your phone 📲" });
    }
    // Guard 2: max 5 per IP / hour.
    const { data: ipHour } = await supabase
      .from('tool_demo_log').select('id').eq('ip', ip).gte('created_at', hourAgo);
    if ((ipHour || []).length >= 5) {
      return res.status(200).json({ ok: false, error: 'Too many demo requests right now. Try again later.' });
    }
    // Guard 3: max 20 per IP / day.
    const { data: ipDay } = await supabase
      .from('tool_demo_log').select('id').eq('ip', ip).gte('created_at', dayAgo);
    if ((ipDay || []).length >= 20) {
      return res.status(200).json({ ok: false, error: 'Daily demo limit reached. Try again tomorrow.' });
    }
    // Guard 4: global cap 200/day — protect the Twilio bill.
    const { count: globalCount } = await supabase
      .from('tool_demo_log').select('id', { count: 'exact', head: true }).gte('created_at', startOfDay);
    if ((globalCount || 0) >= 200) {
      return res.status(200).json({ ok: false, error: 'Demo line is busy today. Please reach out and we’ll show you live.' });
    }

    const from = process.env.DEMO_NUMBER || '+15108519627';
    const to = '+' + (digits.length === 10 ? '1' + digits : digits);
    const client = getTwilioClient();
    await sendSms(client, { from, to, body: DEMO_BODY });

    try {
      await supabase.from('tool_demo_log').insert({ phone: digits, ip, created_at: new Date().toISOString() });
    } catch (e) { console.error('demo log insert error', e); }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('tool/demo error:', err);
    return res.status(200).json({ ok: false, error: 'Could not send the demo just now. Please try again.' });
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // vercel.json: { "src": "/api/tool/(.*)", "dest": "/api/tool?path=$1" }
  const pathStr = (req.query.path || '').replace(/^\/+/, '');
  const route = pathStr ? pathStr.split('/') : [];
  const seg0 = route[0];
  const seg1 = route[1];

  try {
  if (seg0 === 'clients' && seg1 === 'provision') return await handleClientsProvision(req, res);
  if (seg0 === 'clients' && !seg1) return await handleClients(req, res);
  if (seg0 === 'verify-status') return await handleVerifyStatus(req, res);
  if (seg0 === 'pool' && seg1 === 'refill') return await handlePoolRefill(req, res);
  if (seg0 === 'pool' && !seg1) return await handlePool(req, res);
  if (seg0 === 'block') return await handleBlock(req, res);
  if (seg0 === 'unblock') return await handleUnblock(req, res);
  if (seg0 === 'admin-overview') return await handleAdminOverview(req, res);
  if (seg0 === 'voice-status') return await handleVoiceStatus(req, res);
  if (seg0 === 'voice') return await handleVoice(req, res);
  if (seg0 === 'sms-status') return await handleSmsStatus(req, res);
  if (seg0 === 'sms') return await handleSms(req, res);
  if (seg0 === 'report') return await handleReport(req, res);
  if (seg0 === 'cron-weekly') return await handleCronWeekly(req, res);
  if (seg0 === 'cron-flush') return await handleCronFlush(req, res);
  if (seg0 === 'dashboard') return await handleDashboard(req, res);
  if (seg0 === 'inbox') return await handleInbox(req, res);
  if (seg0 === 'checkout') return await handleCheckout(req, res);
  if (seg0 === 'dodo-webhook') return await handleDodoWebhook(req, res);
  if (seg0 === 'pay') return await handlePay(req, res);
  if (seg0 === 'reply') return await handleReply(req, res);
  if (seg0 === 'admin-action') return await handleAdminAction(req, res);
  if (seg0 === 'availability') return await handleAvailability(req, res);
  if (seg0 === 'appointments' && seg1 === 'cancel') return await handleAppointmentsCancel(req, res);
  if (seg0 === 'appointments') return await handleAppointments(req, res);
  if (seg0 === 'config') return await handleConfig(req, res);
  if (seg0 === 'google' && seg1 === 'connect') return await handleGoogleConnect(req, res);
  if (seg0 === 'google' && seg1 === 'callback') return await handleGoogleCallback(req, res);
  if (seg0 === 'patients' && seg1 === 'import') return await handlePatientsImport(req, res);
  if (seg0 === 'patients' && !seg1) return await handlePatients(req, res);
  if (seg0 === 'reactivation' && seg1 === 'run') return await handleReactivationRun(req, res);
  if (seg0 === 'reactivation' && seg1 === 'toggle') return await handleReactivationToggle(req, res);
  if (seg0 === 'reviews' && seg1 === 'mark') return await handleReviewsMark(req, res);
  if (seg0 === 'reviews' && !seg1) return await handleReviews(req, res);
  if (seg0 === 'insights') return await handleInsights(req, res);
  if (seg0 === 'demo') return await handleDemo(req, res);

  return res.status(404).json({ error: 'Route not found' });
  } catch (err) {
    console.error('router unhandled error:', err);
    try { await alertGodwin(getSupabase(), 'router_500', err); } catch (e) { /* ignore */ }
    if (!res.headersSent) {
      // Webhook routes expect TwiML/200; everything else gets a JSON 500.
      if (seg0 === 'voice' || seg0 === 'voice-status' || seg0 === 'sms') return twiml(res);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};
