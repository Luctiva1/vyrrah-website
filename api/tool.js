// Vyrrah Recaller — missed-call recovery engine for local practices
// All routes under /api/tool/... (see vercel.json: tool route ABOVE index catch-all)

const crypto = require('crypto');
const twilio = require('twilio');
const { getSupabase } = require('./_lib/supabase');
const { requireAuth, cors } = require('./_lib/auth');

const BRAND = { name: 'Vyrrah Recaller', from: 'Vyrrah Labs' }; // single place to rename later

const VOICE_URL = 'https://vyrrahlabs.com/api/tool/voice';
const SMS_URL = 'https://vyrrahlabs.com/api/tool/sms';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTwilioClient() {
  return new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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

// AI message generation — Anthropic (Claude) preferred, OpenAI fallback, templates if neither
function aiAvailable() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}
async function generateAiMessage({ client, history = [], purpose, fallback }) {
  if (!aiAvailable()) return fallback;
  const system =
    `You are the friendly front-desk assistant for ${client.practice_name}, a local practice. ` +
    `Services: ${client.services || 'general services'}. ` +
    `Business hours: ${client.business_hours || 'standard business hours'}. ` +
    (client.booking_link ? `Booking link: ${client.booking_link}. ` : '') +
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
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 100, system, messages: turns })
      });
      if (!r.ok) { console.error('Anthropic error', r.status, await r.text()); return fallback; }
      const data = await r.json();
      const text = (data?.content || []).map(b => b.text || '').join('').trim();
      return text || fallback;
    }
    // OpenAI fallback
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 100, messages: [{ role: 'system', content: system }, ...turns] })
    });
    if (!r.ok) { console.error('OpenAI error', r.status, await r.text()); return fallback; }
    const data = await r.json();
    return data?.choices?.[0]?.message?.content?.trim() || fallback;
  } catch (err) {
    console.error('AI call failed:', err);
    return fallback;
  }
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

async function sendSms(twilioClient, { from, to, body }) {
  const msg = await twilioClient.messages.create({ from, to, body });
  return msg;
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

async function provisionTwilioNumber(supabase, client, areaCode) {
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

function forwardingInstructions(number) {
  return `Have the practice set conditional call forwarding (no-answer/busy) to ${number}`;
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
      const {
        practice_name, owner_name, owner_email, owner_phone, real_line,
        avg_customer_value, business_hours, services, booking_link, area_code
      } = req.body || {};

      if (!practice_name || !real_line) {
        return res.status(400).json({ error: 'practice_name and real_line are required' });
      }

      const magicToken = crypto.randomBytes(24).toString('hex');
      const { data: client, error } = await supabase
        .from('tool_clients')
        .insert({
          practice_name,
          owner_name: owner_name || null,
          owner_email: owner_email || null,
          owner_phone: owner_phone || null,
          real_line,
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
        return res.status(200).json({
          client: updated,
          forwarding_instructions: forwardingInstructions(updated.twilio_number)
        });
      } catch (twErr) {
        console.error('Twilio provisioning failed:', twErr);
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
    const supabase = getSupabase();
    const to = (req.body && req.body.To) || '';

    const { data: client } = await supabase
      .from('tool_clients')
      .select('*')
      .eq('twilio_number', to)
      .single();

    if (!client || !client.real_line) {
      return twiml(res, '<Say voice="alice">This number is not configured.</Say><Hangup/>');
    }

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

    // Skip text-back for the practice's own numbers / non-textable callers / opt-outs
    const callerDigits = normalizePhone(caller);
    const skipSelf =
      callerDigits === normalizePhone(client.real_line) ||
      (client.owner_phone && callerDigits === normalizePhone(client.owner_phone));
    const optedOut = await callerOptedOut(supabase, client.id, caller);

    if (!skipSelf && !isNonTextableCaller(caller) && !optedOut && client.twilio_number) {
      const fallback =
        `Hi! This is ${client.practice_name}. Sorry we missed your call! ` +
        `Are you looking to book an appointment? Reply here and we'll get you sorted.` +
        (client.booking_link ? ` Or book directly: ${client.booking_link}` : '');

      const body = await generateAiMessage({
        client,
        purpose: 'The practice just missed this person\'s call. Apologize warmly for missing them and ask if they would like to book an appointment.',
        fallback
      });

      try {
        const msg = await sendSms(getTwilioClient(), {
          from: client.twilio_number,
          to: caller,
          body
        });
        await supabase.from('tool_messages').insert({
          client_id: client.id,
          call_id: callRow ? callRow.id : null,
          caller_phone: caller,
          direction: 'outbound',
          body,
          ai_generated: aiAvailable(),
          twilio_sid: msg.sid
        });
        if (callRow) {
          await supabase.from('tool_calls').update({ textback_sent: true }).eq('id', callRow.id);
        }
        return twiml(res, '<Say voice="alice">Sorry we missed you, we just sent you a text.</Say><Hangup/>');
      } catch (smsErr) {
        console.error('Text-back send failed:', smsErr);
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
    const supabase = getSupabase();
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

    // STOP handling: log only, never reply
    if (/^\s*(stop|unsubscribe)\s*$/i.test(body)) return twiml(res);

    // Suppress all outbound if caller previously opted out
    if (await callerOptedOut(supabase, client.id, caller)) return twiml(res);

    // Mark recovered
    if (callRow && !callRow.recovered) {
      await supabase.from('tool_calls').update({ recovered: true }).eq('id', callRow.id);
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

    const bookingIntent = /\b(yes|yeah|sure|book|appointment|ok|please)\b/i.test(body);
    let reply;

    if (bookingIntent) {
      if (callRow) {
        await supabase.from('tool_calls').update({ booked: true, recovered: true }).eq('id', callRow.id);
      }
      // Notify the practice owner
      if (client.owner_phone) {
        try {
          await sendSms(getTwilioClient(), {
            from: client.twilio_number,
            to: client.owner_phone,
            body: `${BRAND.name}: ${caller} wants to book! Their msg: "${body}". Reply to them directly or call back.`
          });
        } catch (notifyErr) {
          console.error('Owner notify SMS failed:', notifyErr);
        }
      }
      reply = await generateAiMessage({
        client,
        history,
        purpose: 'The person wants to book. Confirm warmly that someone from the practice will call them shortly to confirm a time.',
        fallback: `Great! Someone from ${client.practice_name} will call you shortly to confirm a time. Talk soon!`
      });
    } else {
      reply = await generateAiMessage({
        client,
        history,
        purpose: 'Reply helpfully to the person\'s latest message as the practice front desk. If appropriate, gently invite them to book.',
        fallback: `Thanks for your message! Someone from ${client.practice_name} will get back to you shortly. If you'd like to book, just reply YES.`
      });
    }

    try {
      const msg = await sendSms(getTwilioClient(), {
        from: client.twilio_number,
        to: caller,
        body: reply
      });
      await supabase.from('tool_messages').insert({
        client_id: client.id,
        call_id: callRow ? callRow.id : null,
        caller_phone: caller,
        direction: 'outbound',
        body: reply,
        ai_generated: aiAvailable(),
        twilio_sid: msg.sid
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
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const clientId = req.query.client_id;
    const days = parseInt(req.query.days) || 7;
    if (!clientId) return res.status(400).json({ error: 'client_id required' });

    const { data: client } = await supabase
      .from('tool_clients')
      .select('id, practice_name, status, avg_customer_value')
      .eq('id', clientId)
      .single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const stats = await computeStats(supabase, clientId, days);
    return res.status(200).json({ client, stats });
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
        .select('direction, body, created_at')
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
      stats,
      recovered_conversations: conversations
    });
  } catch (err) {
    console.error('tool/dashboard error:', err);
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
      return res.status(200).json({ ok: true, ignored: 'bad signature' });
    }

    const type = event.type || event.event_type || '';
    const data = event.data || {};
    const metadata = data.metadata || {};
    const email =
      (data.customer && data.customer.email) || data.customer_email || data.email || null;

    const activate = ['subscription.active', 'payment.succeeded'].includes(type);
    const churn = ['subscription.cancelled', 'subscription.expired'].includes(type);
    if (!activate && !churn) {
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

    const status = activate ? 'active' : 'churned';
    const { error } = await supabase
      .from('tool_clients')
      .update({ status })
      .eq('id', client.id);
    if (error) console.error('dodo-webhook: status update failed', error);

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

// ─── Router ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // vercel.json: { "src": "/api/tool/(.*)", "dest": "/api/tool?path=$1" }
  const pathStr = (req.query.path || '').replace(/^\/+/, '');
  const route = pathStr ? pathStr.split('/') : [];
  const seg0 = route[0];
  const seg1 = route[1];

  if (seg0 === 'clients' && seg1 === 'provision') return handleClientsProvision(req, res);
  if (seg0 === 'clients' && !seg1) return handleClients(req, res);
  if (seg0 === 'voice-status') return handleVoiceStatus(req, res);
  if (seg0 === 'voice') return handleVoice(req, res);
  if (seg0 === 'sms') return handleSms(req, res);
  if (seg0 === 'report') return handleReport(req, res);
  if (seg0 === 'cron-weekly') return handleCronWeekly(req, res);
  if (seg0 === 'dashboard') return handleDashboard(req, res);
  if (seg0 === 'dodo-webhook') return handleDodoWebhook(req, res);
  if (seg0 === 'pay') return handlePay(req, res);

  return res.status(404).json({ error: 'Route not found' });
};
