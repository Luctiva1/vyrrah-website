const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const twilio = require('twilio');
const { getSupabase } = require('./_lib/supabase');
const { getTwilio, getFromNumber } = require('./_lib/twilio');
const { verifyToken, requireAuth, cors } = require('./_lib/auth');

// ─── Helpers ────────────────────────────────────────────────────────────────

function notFound(res) {
  return res.status(404).json({ error: 'Route not found' });
}

// ─── Auth handlers ───────────────────────────────────────────────────────────

async function handleAuthLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const validUsername = username === process.env.ADMIN_USERNAME;
    const validPassword = password === process.env.ADMIN_PASSWORD;

    if (!validUsername || !validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { username, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(200).json({ token, username });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleAuthVerify(req, res) {
  const payload = verifyToken(req);
  if (!payload) {
    return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
  return res.status(200).json({ valid: true, username: payload.username });
}

// ─── Contacts handlers ───────────────────────────────────────────────────────

async function handleContactsList(req, res) {
  if (!requireAuth(req, res)) return;

  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { page = 1, limit = 50, search, status, niche, campaign } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let query = supabase
        .from('leads')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (search) {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,company.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`
        );
      }
      if (status) query = query.eq('status', status);
      if (niche) query = query.eq('niche', niche);
      if (campaign) query = query.eq('campaign', campaign);

      const { data, error, count } = await query;
      if (error) throw error;

      return res.status(200).json({
        leads: data,
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / parseInt(limit))
      });
    } catch (err) {
      console.error('GET contacts error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { first_name, last_name, company, phone, email, country, niche, status, campaign, notes } = req.body;

      if (!first_name || !phone) {
        return res.status(400).json({ error: 'first_name and phone are required' });
      }

      const { data, error } = await supabase
        .from('leads')
        .insert([{ first_name, last_name, company, phone, email, country, niche, status: status || 'new', campaign, notes }])
        .select()
        .single();

      if (error) throw error;
      return res.status(201).json(data);
    } catch (err) {
      console.error('POST contact error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleContactById(req, res, id) {
  if (!requireAuth(req, res)) return;
  if (!id) return res.status(400).json({ error: 'id required' });

  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select('*')
        .eq('id', id)
        .single();

      if (leadError) throw leadError;
      if (!lead) return res.status(404).json({ error: 'Lead not found' });

      const [{ data: sms }, { data: calls }, { data: sequences }] = await Promise.all([
        supabase.from('sms_messages').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('calls').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
        supabase.from('sequences').select('*').eq('lead_id', id).order('step', { ascending: true })
      ]);

      return res.status(200).json({ lead, sms: sms || [], calls: calls || [], sequences: sequences || [] });
    } catch (err) {
      console.error('GET contact error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { status, notes, company, email, niche, campaign } = req.body;
      const updates = {};
      if (status !== undefined) updates.status = status;
      if (notes !== undefined) updates.notes = notes;
      if (company !== undefined) updates.company = company;
      if (email !== undefined) updates.email = email;
      if (niche !== undefined) updates.niche = niche;
      if (campaign !== undefined) updates.campaign = campaign;

      const { data, error } = await supabase
        .from('leads')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    } catch (err) {
      console.error('PUT contact error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleContactsImport(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { contacts } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts must be a non-empty array' });
    }

    if (contacts.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 contacts per import' });
    }

    function normalizePhone(raw) {
      if (!raw) return '';
      const digits = String(raw).replace(/\D/g, '');
      if (!digits || digits.length < 7) return '';
      if (digits.length === 10) return '+1' + digits;
      if (digits.length === 11 && digits[0] === '1') return '+' + digits;
      if (String(raw).trim().startsWith('+')) return '+' + digits;
      return '+' + digits;
    }

    const rows = contacts.map(c => {
      const phone = normalizePhone(c.phone || c.Phone || c.mobile || '');
      return {
        first_name: (c.first_name || c.firstName || c['First Name'] || '').trim(),
        last_name: (c.last_name || c.lastName || c['Last Name'] || null),
        company: c.company || c.Company || null,
        phone,
        email: c.email || c.Email || null,
        country: c.country || c.Country || 'United States',
        niche: c.niche || c.Niche || null,
        status: 'new',
        campaign: c.campaign || c.Campaign || 'USA Outreach',
        notes: c.notes || c.Notes || null
      };
    }).filter(c => c.first_name && c.phone);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('leads')
      .insert(rows)
      .select();

    if (error) throw error;

    return res.status(200).json({
      imported: data.length,
      skipped: contacts.length - rows.length,
      leads: data
    });
  } catch (err) {
    console.error('Import error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── SMS handlers ────────────────────────────────────────────────────────────

async function handleSmsSend(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { to, body, lead_id } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: 'to and body are required' });
    }

    const supabase = getSupabase();

    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('id')
      .eq('phone', to)
      .maybeSingle();

    if (optOut) {
      return res.status(400).json({ error: 'This number has opted out' });
    }

    const twilioClient = getTwilio();
    const message = await twilioClient.messages.create({
      from: getFromNumber(to),
      to,
      body
    });

    const { data: smsRecord, error: dbError } = await supabase
      .from('sms_messages')
      .insert([{
        lead_id: lead_id || null,
        phone: to,
        direction: 'outbound',
        body,
        twilio_sid: message.sid,
        status: message.status
      }])
      .select()
      .single();

    if (dbError) console.error('DB log error:', dbError);

    if (lead_id) {
      await supabase
        .from('leads')
        .update({ status: 'contacted' })
        .eq('id', lead_id)
        .eq('status', 'new');
    }

    return res.status(200).json({ success: true, sid: message.sid, record: smsRecord });
  } catch (err) {
    console.error('SMS send error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSmsConversation(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone query param required' });

    const supabase = getSupabase();

    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: true });

    if (error) throw error;

    const { data: lead } = await supabase
      .from('leads')
      .select('id, first_name, last_name, company, status')
      .eq('phone', phone)
      .maybeSingle();

    return res.status(200).json({ messages: messages || [], lead });
  } catch (err) {
    console.error('Conversation error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Calls handlers ──────────────────────────────────────────────────────────

async function handleCallsDial(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { to, lead_id } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const supabase = getSupabase();

    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('id')
      .eq('phone', to)
      .maybeSingle();

    if (optOut) {
      return res.status(400).json({ error: 'This number has opted out' });
    }

    const twilioClient = getTwilio();
    const baseUrl = `https://vyrrahlabs.com`;
    const forwardTo = process.env.FORWARD_TO_MOBILE || '+918778974646';

    // Power dialer: call GODWIN first, then when he answers, bridge to LEAD
    // This way Godwin is live before the lead picks up — standard power dialer UX
    const call = await twilioClient.calls.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: forwardTo,
      url: `${baseUrl}/api/calls/bridge?to=${encodeURIComponent(to)}`,
      statusCallback: `${baseUrl}/api/webhooks/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: true,
      recordingStatusCallback: `${baseUrl}/api/webhooks/recording`
    });

    const { data: callRecord, error: dbError } = await supabase
      .from('calls')
      .insert([{
        lead_id: lead_id || null,
        phone: to,
        direction: 'outbound',
        call_sid: call.sid,
        outcome: null
      }])
      .select()
      .single();

    if (dbError) console.error('DB log error:', dbError);

    if (lead_id) {
      await supabase
        .from('leads')
        .update({ status: 'contacted' })
        .eq('id', lead_id)
        .eq('status', 'new');
    }

    return res.status(200).json({ success: true, call_sid: call.sid, record: callRecord });
  } catch (err) {
    console.error('Dial error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleCallById(req, res, id) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!id) return res.status(400).json({ error: 'id required' });

    const { outcome, notes, duration_seconds } = req.body;
    const updates = {};
    if (outcome !== undefined) updates.outcome = outcome;
    if (notes !== undefined) updates.notes = notes;
    if (duration_seconds !== undefined) updates.duration_seconds = duration_seconds;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('calls')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Call not found' });

    if (data.lead_id && outcome) {
      let leadStatus = null;
      if (outcome === 'interested') leadStatus = 'replied';
      else if (outcome === 'not_interested') leadStatus = 'not_interested';
      else if (outcome === 'callback') leadStatus = 'follow_up';

      if (leadStatus) {
        await supabase
          .from('leads')
          .update({ status: leadStatus })
          .eq('id', data.lead_id);
      }
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('PUT call error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Webhook handlers ────────────────────────────────────────────────────────

async function handleWebhookSms(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!twilio.validateRequest(authToken, twilioSignature, url, params)) {
    console.warn('Invalid Twilio signature on SMS webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const { From: from, Body: body, MessageSid: messageSid } = req.body;
  const supabase = getSupabase();

  try {
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('phone', from)
      .maybeSingle();

    await supabase.from('sms_messages').insert([{
      lead_id: lead?.id || null,
      phone: from,
      direction: 'inbound',
      body: body || '',
      twilio_sid: messageSid,
      status: 'received'
    }]);

    const trimmed = (body || '').trim().toUpperCase();
    const stopKeywords = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];

    if (stopKeywords.includes(trimmed)) {
      await supabase
        .from('opt_outs')
        .upsert([{ phone: from }], { onConflict: 'phone' });

      if (lead?.id) {
        await supabase
          .from('sequences')
          .update({ status: 'skipped' })
          .eq('lead_id', lead.id)
          .eq('status', 'pending');

        await supabase
          .from('leads')
          .update({ status: 'not_interested' })
          .eq('id', lead.id);
      }
    } else {
      if (lead?.id) {
        await supabase
          .from('leads')
          .update({ status: 'replied' })
          .eq('id', lead.id)
          .in('status', ['new', 'contacted']);
      }
    }
  } catch (err) {
    console.error('SMS webhook error:', err);
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

async function handleWebhookVoice(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const FORWARD_TO = process.env.FORWARD_TO_MOBILE || '+918778974646';

  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!twilio.validateRequest(authToken, twilioSignature, url, params)) {
    console.warn('Invalid Twilio signature on voice webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const { From: from, CallSid: callSid, Direction: direction } = req.body;
  const supabase = getSupabase();

  try {
    if (direction === 'inbound') {
      const { data: lead } = await supabase
        .from('leads')
        .select('id')
        .eq('phone', from)
        .maybeSingle();

      await supabase.from('calls').insert([{
        lead_id: lead?.id || null,
        phone: from,
        direction: 'inbound',
        call_sid: callSid
      }]);
    }
  } catch (err) {
    console.error('Voice webhook error:', err);
  }

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  if (FORWARD_TO && FORWARD_TO !== process.env.TWILIO_PHONE_NUMBER) {
    twiml.dial(FORWARD_TO);
  } else {
    twiml.say(
      { voice: 'alice' },
      "Hi, you've reached Vyrrah Labs. Please leave a message after the tone or send us an SMS."
    );
    twiml.record({
      maxLength: 120,
      playBeep: true,
      transcribe: false
    });
  }

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
}

async function handleWebhookStatus(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!twilio.validateRequest(authToken, twilioSignature, url, params)) {
    console.warn('Invalid Twilio signature on status webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const { CallSid: callSid, CallStatus: callStatus, CallDuration: callDuration } = req.body;

  try {
    const supabase = getSupabase();
    const updates = {};

    if (callDuration) updates.duration_seconds = parseInt(callDuration);

    if (callStatus === 'completed' && parseInt(callDuration || 0) === 0) {
      updates.outcome = 'no_answer';
    } else if (callStatus === 'no-answer') {
      updates.outcome = 'no_answer';
    } else if (callStatus === 'busy') {
      updates.outcome = 'no_answer';
    } else if (callStatus === 'failed') {
      updates.outcome = 'no_answer';
    }

    if (Object.keys(updates).length > 0) {
      await supabase
        .from('calls')
        .update(updates)
        .eq('call_sid', callSid);
    }
  } catch (err) {
    console.error('Status webhook error:', err);
  }

  return res.status(200).end();
}

async function handleWebhookRecording(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://${req.headers.host}${req.url}`;
  const params = req.body || {};
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!twilio.validateRequest(authToken, twilioSignature, url, params)) {
    console.warn('Invalid Twilio signature on recording webhook');
    // In production, uncomment the next line:
    // return res.status(403).end();
  }

  const {
    CallSid: callSid,
    RecordingUrl: recordingUrl,
    RecordingStatus: recordingStatus
  } = req.body;

  if (recordingStatus !== 'completed' || !recordingUrl) {
    return res.status(200).end();
  }

  try {
    const supabase = getSupabase();
    const mp3Url = `${recordingUrl}.mp3`;

    await supabase
      .from('calls')
      .update({ recording_url: mp3Url })
      .eq('call_sid', callSid);
  } catch (err) {
    console.error('Recording webhook error:', err);
  }

  return res.status(200).end();
}

// ─── Quickmail webhook handler ───────────────────────────────────────────────

async function processQuickmailPayload(payload) {
  const supabase = getSupabase();
  console.log('Quickmail payload:', JSON.stringify(payload).slice(0, 500));

  const event = payload.event || payload.type || payload.action || '';
  const isReply       = event.toLowerCase().includes('reply') || event.toLowerCase().includes('response');
  const isUnsubscribe = event.toLowerCase().includes('unsub') || event.toLowerCase().includes('optout');
  const isBounce      = event.toLowerCase().includes('bounce');

  const prospect = payload.prospect || payload.contact || payload.lead || {};
  const email = prospect.email || payload.email || payload.from || payload.prospect_email || '';
  if (!email) { console.warn('Quickmail webhook: no email in payload'); return; }

  const replyRaw = payload.reply || payload.message || {};
  const body = (typeof replyRaw === 'string' ? replyRaw
    : replyRaw.body || replyRaw.text || replyRaw.content
    || payload.body || payload.text || '')
    || `[${event || 'Quickmail event'} — see Quickmail for details]`;

  const campaignName = (payload.campaign || {}).name || payload.campaign_name || payload.campaign || 'Quickmail';

  const { data: lead } = await supabase
    .from('leads').select('id, status').eq('email', email).maybeSingle();

  if (isUnsubscribe) {
    await supabase.from('opt_outs').upsert([{ phone: email }], { onConflict: 'phone' });
    if (lead?.id) {
      await Promise.all([
        supabase.from('leads').update({ status: 'not_interested' }).eq('id', lead.id),
        supabase.from('sequences').update({ status: 'skipped' }).eq('lead_id', lead.id).eq('status', 'pending')
      ]);
    }
    console.log(`Quickmail unsubscribe: ${email}`);
    return;
  }

  if (isBounce) {
    if (lead?.id) await supabase.from('leads').update({ status: 'not_interested' }).eq('id', lead.id);
    console.log(`Quickmail bounce: ${email}`);
    return;
  }

  if (isReply || body) {
    const inserts = [supabase.from('sms_messages').insert([{
      lead_id: lead?.id || null,
      phone: email,
      direction: 'inbound',
      body: `📧 [Email reply via ${campaignName}]\n\n${body}`,
      channel: 'email',
      status: 'received',
      twilio_sid: `qm_${Date.now()}`
    }])];
    if (lead?.id && ['new','contacted'].includes(lead.status)) {
      inserts.push(supabase.from('leads').update({ status: 'replied' }).eq('id', lead.id));
      inserts.push(supabase.from('sequences').update({ status: 'skipped' }).eq('lead_id', lead.id).eq('status', 'pending'));
    }
    await Promise.all(inserts);
    console.log(`Quickmail reply: ${email} — ${body.slice(0, 80)}`);
  }
}

async function handleWebhookQuickmail(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Fire-and-await: start processing, respond immediately (< 100ms),
  // then await keeps the Vercel function alive until DB writes finish.
  const work = processQuickmailPayload(req.body || {});
  res.status(200).json({ received: true });
  try { await work; } catch (err) { console.error('Quickmail processing error:', err); }
}

// ─── Sequences handlers ──────────────────────────────────────────────────────

const SEQUENCE_DEFAULT_TEMPLATES = [
  // Step 1 — Day 1, send immediately
  "Hey {first_name}, Godwin here from Vyrrah Labs. Just ran a quick AI scan on {company} and found some specific gaps worth showing you. Offering a free week-long growth audit — $899 value, no strings. Claim it: cal.com/godwin-rayen/30min",
  // Step 2 — Day 2
  "Hey {first_name} — did my message land? Free week-long growth audit for {company}. Full AI analysis, competitor breakdown, every revenue leak identified. $899 value, nothing to pay. And if we execute — $20K revenue guaranteed or free. cal.com/godwin-rayen/30min — Godwin",
  // Step 3 — Day 3
  "{first_name}, last one. Free growth audit for {company} closes today — $899 value, no charge. If we execute after: $20K in new revenue guaranteed or you pay nothing. Whenever you're ready: cal.com/godwin-rayen/30min — Godwin @ Vyrrah Labs"
];

async function handleSequencesTrigger(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { lead_id, campaign, step1_message } = req.body;

    if (!lead_id || !campaign) {
      return res.status(400).json({ error: 'lead_id and campaign are required' });
    }

    const supabase = getSupabase();

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, phone')
      .eq('id', lead_id)
      .single();

    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('id')
      .eq('phone', lead.phone)
      .maybeSingle();

    if (optOut) {
      return res.status(400).json({ error: 'Lead has opted out' });
    }

    await supabase
      .from('sequences')
      .update({ status: 'skipped' })
      .eq('lead_id', lead_id)
      .eq('campaign', campaign)
      .eq('status', 'pending');

    const now = new Date();
    const steps = [
      { step: 1, scheduled_at: now.toISOString(), message: step1_message || SEQUENCE_DEFAULT_TEMPLATES[0] },
      { step: 2, scheduled_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), message: SEQUENCE_DEFAULT_TEMPLATES[1] },
      { step: 3, scheduled_at: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(), message: SEQUENCE_DEFAULT_TEMPLATES[2] }
    ];

    const rows = steps.map(s => ({
      lead_id,
      campaign,
      step: s.step,
      scheduled_at: s.scheduled_at,
      status: 'pending',
      message_body: s.message
    }));

    const { data, error } = await supabase
      .from('sequences')
      .insert(rows)
      .select();

    if (error) throw error;

    return res.status(200).json({ success: true, sequences: data });
  } catch (err) {
    console.error('Sequence trigger error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleSequencesBulkTrigger(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { campaign = 'USA Outreach', status_filter = 'new', limit = 500 } = req.body;
    const supabase = getSupabase();

    // Get all leads matching the filter that aren't already in a pending sequence
    const { data: leads, error: leadsErr } = await supabase
      .from('leads')
      .select('id, phone, first_name, last_name, company')
      .eq('status', status_filter)
      .limit(limit);

    if (leadsErr) throw leadsErr;
    if (!leads || leads.length === 0) {
      return res.status(200).json({ enrolled: 0, skipped: 0, message: 'No leads found' });
    }

    // Get opt-outs
    const { data: optOuts } = await supabase.from('opt_outs').select('phone');
    const optOutSet = new Set((optOuts || []).map(o => o.phone));

    // Get already-enrolled leads
    const { data: existing } = await supabase
      .from('sequences')
      .select('lead_id')
      .eq('campaign', campaign)
      .eq('status', 'pending');
    const enrolledSet = new Set((existing || []).map(e => e.lead_id));

    const now = new Date();
    const rows = [];
    let skipped = 0;

    for (const lead of leads) {
      if (optOutSet.has(lead.phone) || enrolledSet.has(lead.id)) {
        skipped++;
        continue;
      }
      // Stagger Day 1 sends — spread over 3 hours to avoid spam flags (1 per 4 seconds)
      const staggerMs = rows.length / 3 * 4000;
      const sendAt = new Date(now.getTime() + staggerMs);

      rows.push({ lead_id: lead.id, campaign, step: 1, scheduled_at: sendAt.toISOString(), status: 'pending', message_body: SEQUENCE_DEFAULT_TEMPLATES[0] });
      rows.push({ lead_id: lead.id, campaign, step: 2, scheduled_at: new Date(sendAt.getTime() + 86400000).toISOString(), status: 'pending', message_body: SEQUENCE_DEFAULT_TEMPLATES[1] });
      rows.push({ lead_id: lead.id, campaign, step: 3, scheduled_at: new Date(sendAt.getTime() + 172800000).toISOString(), status: 'pending', message_body: SEQUENCE_DEFAULT_TEMPLATES[2] });
    }

    if (rows.length === 0) {
      return res.status(200).json({ enrolled: 0, skipped, message: 'All leads already enrolled or opted out' });
    }

    // Insert in batches of 500
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('sequences').insert(rows.slice(i, i + 500));
      if (error) throw error;
      inserted += Math.min(500, rows.length - i);
    }

    const enrolled = inserted / 3; // 3 rows per lead

    // Mark enrolled leads as 'contacted' so next batch gets fresh leads
    const enrolledIds = leads.filter(l => !optOutSet.has(l.phone) && !enrolledSet.has(l.id)).map(l => l.id);
    if (enrolledIds.length > 0) {
      await supabase.from('leads').update({ status: 'contacted' }).in('id', enrolledIds);
    }

    return res.status(200).json({ enrolled, skipped, rows_inserted: inserted, campaign });
  } catch (err) {
    console.error('Bulk trigger error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function interpolate(template, lead) {
  if (!template) return '';
  return template
    .replace(/\{first_name\}/g, lead.first_name || '')
    .replace(/\{last_name\}/g, lead.last_name || '')
    .replace(/\{company\}/g, lead.company || 'your company')
    .replace(/\{name\}/g, `${lead.first_name || ''} ${lead.last_name || ''}`.trim());
}

async function handleSequencesProcess(req, res) {
  try {
    const supabase = getSupabase();
    const twilioClient = getTwilio();
    let totalProcessed = 0;
    const allResults = [];

    while (true) {
      const now = new Date().toISOString();
      const { data: pending, error } = await supabase
        .from('sequences')
        .select('*, leads(id, first_name, last_name, company, phone)')
        .eq('status', 'pending')
        .lte('scheduled_at', now)
        .limit(100);

      if (error) throw error;
      if (!pending || pending.length === 0) break;

      for (const seq of pending) {
        const lead = seq.leads;
        if (!lead) {
          await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
          allResults.push({ id: seq.id, status: 'skipped', reason: 'lead not found' });
          continue;
        }
        const { data: optOut } = await supabase.from('opt_outs').select('id').eq('phone', lead.phone).maybeSingle();
        if (optOut) {
          await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
          allResults.push({ id: seq.id, status: 'skipped', reason: 'opted out' });
          continue;
        }
        const body = interpolate(seq.message_body, lead);
        if (!body) {
          await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
          allResults.push({ id: seq.id, status: 'skipped', reason: 'empty message' });
          continue;
        }
        try {
          const message = await twilioClient.messages.create({
            from: getFromNumber(lead.phone),
            to: lead.phone,
            body
          });
          await supabase.from('sms_messages').insert([{
            lead_id: lead.id, phone: lead.phone, direction: 'outbound',
            body, twilio_sid: message.sid, status: message.status
          }]);
          await supabase.from('sequences').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', seq.id);
          await supabase.from('leads').update({ status: 'contacted' }).eq('id', lead.id).eq('status', 'new');
          allResults.push({ id: seq.id, status: 'sent', sid: message.sid });
        } catch (sendErr) {
          console.error('Failed to send sequence', seq.id, sendErr.message);
          allResults.push({ id: seq.id, status: 'error', error: sendErr.message });
        }
      }
      totalProcessed += pending.length;
      if (pending.length < 100) break; // No more pending
    }

    return res.status(200).json({ processed: totalProcessed, results: allResults });
  } catch (err) {
    console.error('Sequence process error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Dashboard handler ───────────────────────────────────────────────────────

async function handleDashboardStats(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getSupabase();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayISO = todayStart.toISOString();

    const [
      { count: callsToday },
      { count: smsSent },
      { count: totalLeads },
      { count: newLeads },
      { count: contacted },
      { count: replied },
      { count: booked },
      { count: notInterested },
      { count: followUp },
      { data: answeredCalls },
      { data: recentCalls },
      { data: recentSms }
    ] = await Promise.all([
      supabase.from('calls').select('*', { count: 'exact', head: true }).gte('created_at', todayISO),
      supabase.from('sms_messages').select('*', { count: 'exact', head: true }).eq('direction', 'outbound').gte('created_at', todayISO),
      supabase.from('leads').select('*', { count: 'exact', head: true }),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'new'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'contacted'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'replied'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'booked'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'not_interested'),
      supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'follow_up'),
      supabase.from('calls').select('id').eq('outcome', 'answered').gte('created_at', todayISO),
      supabase.from('calls').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('sms_messages').select('*').order('created_at', { ascending: false }).limit(10)
    ]);

    const answerRate = callsToday > 0
      ? Math.round(((answeredCalls?.length || 0) / callsToday) * 100)
      : 0;

    return res.status(200).json({
      today: {
        calls: callsToday || 0,
        sms_sent: smsSent || 0,
        answered: answeredCalls?.length || 0,
        answer_rate: answerRate
      },
      leads: {
        total: totalLeads || 0,
        new: newLeads || 0,
        contacted: contacted || 0,
        replied: replied || 0,
        booked: booked || 0,
        not_interested: notInterested || 0,
        follow_up: followUp || 0
      },
      recent_calls: recentCalls || [],
      recent_sms: recentSms || []
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Sequences list handler ──────────────────────────────────────────────────

async function handleSequencesList(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    const { status, limit = 100, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('sequences')
      .select('*, leads(id, first_name, last_name, company, phone, status)', { count: 'exact' })
      .order('scheduled_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;
    return res.status(200).json({ sequences: data || [], total: count || 0, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Sequences list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Calls bridge TwiML ──────────────────────────────────────────────────────

async function handleCallsBridge(req, res) {
  // Called when Godwin answers his phone — returns TwiML to bridge to lead
  const { to } = req.query;
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  if (to) {
    twiml.say({ voice: 'alice' }, 'Connecting to your lead now.');
    const dial = twiml.dial({ callerId: getFromNumber(to), record: 'record-from-answer', timeout: 30 });
    dial.number(to);
  } else {
    twiml.say({ voice: 'alice' }, 'No lead number configured. Goodbye.');
    twiml.hangup();
  }
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
}

// ─── Conversations handler ───────────────────────────────────────────────────

async function handleConversationsList(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = getSupabase();
    // Get last message per phone number, with unread count
    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) throw error;

    // Group by phone
    const byPhone = {};
    for (const msg of (messages || [])) {
      if (!byPhone[msg.phone]) {
        byPhone[msg.phone] = { phone: msg.phone, last_message: msg, unread: 0, lead: null };
      }
      if (msg.direction === 'inbound') byPhone[msg.phone].unread++;
    }

    // Enrich with lead info
    const phones = Object.keys(byPhone);
    if (phones.length > 0) {
      const { data: leads } = await supabase
        .from('leads')
        .select('id, first_name, last_name, company, phone, status')
        .in('phone', phones);
      for (const lead of (leads || [])) {
        if (byPhone[lead.phone]) byPhone[lead.phone].lead = lead;
      }
    }

    const conversations = Object.values(byPhone).sort((a, b) =>
      new Date(b.last_message.created_at) - new Date(a.last_message.created_at)
    );
    return res.status(200).json({ conversations });
  } catch (err) {
    console.error('Conversations list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Main catch-all router ───────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Set CORS headers on every response
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // req.query.path is the full path after /api/, e.g. 'auth/login'
  // passed via vercel.json: { "src": "/api/(.*)", "dest": "/api/index?path=$1" }
  const pathStr = (req.query.path || '').replace(/^\/+/, '');
  const route = pathStr ? pathStr.split('/') : [];

  const seg0 = route[0]; // e.g. 'auth', 'contacts', 'sms', 'calls', 'webhooks', 'sequences', 'dashboard'
  const seg1 = route[1]; // e.g. 'login', 'verify', ':id', 'import', 'send', etc.

  // /api/auth/login
  if (seg0 === 'auth' && seg1 === 'login') {
    return handleAuthLogin(req, res);
  }

  // /api/auth/verify
  if (seg0 === 'auth' && seg1 === 'verify') {
    return handleAuthVerify(req, res);
  }

  // /api/contacts/import  (must come before dynamic :id check)
  if (seg0 === 'contacts' && seg1 === 'import') {
    return handleContactsImport(req, res);
  }

  // /api/contacts/:id
  if (seg0 === 'contacts' && seg1) {
    return handleContactById(req, res, seg1);
  }

  // /api/contacts
  if (seg0 === 'contacts' && !seg1) {
    return handleContactsList(req, res);
  }

  // /api/sms/send
  if (seg0 === 'sms' && seg1 === 'send') {
    return handleSmsSend(req, res);
  }

  // /api/sms/conversation
  if (seg0 === 'sms' && seg1 === 'conversation') {
    return handleSmsConversation(req, res);
  }

  // /api/calls/dial
  if (seg0 === 'calls' && seg1 === 'dial') {
    return handleCallsDial(req, res);
  }

  // /api/calls/bridge (TwiML — called by Twilio when Godwin answers)
  if (seg0 === 'calls' && seg1 === 'bridge') {
    return handleCallsBridge(req, res);
  }

  // /api/calls/:id
  if (seg0 === 'calls' && seg1) {
    return handleCallById(req, res, seg1);
  }

  // /api/webhooks/sms
  if (seg0 === 'webhooks' && seg1 === 'sms') {
    return handleWebhookSms(req, res);
  }

  // /api/webhooks/voice
  if (seg0 === 'webhooks' && seg1 === 'voice') {
    return handleWebhookVoice(req, res);
  }

  // /api/webhooks/status
  if (seg0 === 'webhooks' && seg1 === 'status') {
    return handleWebhookStatus(req, res);
  }

  // /api/webhooks/recording
  if (seg0 === 'webhooks' && seg1 === 'recording') {
    return handleWebhookRecording(req, res);
  }

  // /api/webhooks/quickmail
  if (seg0 === 'webhooks' && seg1 === 'quickmail') {
    return handleWebhookQuickmail(req, res);
  }

  // /api/debug/qm-insert — temporary, diagnose sms_messages insert failure
  if (seg0 === 'debug' && seg1 === 'qm-insert') {
    try {
      const supabase = getSupabase();
      const { email = 'debug@test.com' } = req.query;
      const { data: lead } = await supabase.from('leads').select('id,status').eq('email', email).maybeSingle();
      const insertResult = await supabase.from('sms_messages').insert([{
        lead_id: lead?.id || null,
        phone: email,
        direction: 'inbound',
        body: '📧 [Email reply via Debug]\n\nTest body',
        channel: 'email',
        status: 'received',
        twilio_sid: `qm_debug_${Date.now()}`
      }]).select();
      return res.status(200).json({ lead, insertData: insertResult.data, insertError: insertResult.error });
    } catch (err) {
      return res.status(200).json({ caught: err.message });
    }
  }

  // /api/sequences (list)
  if (seg0 === 'sequences' && !seg1) {
    return handleSequencesList(req, res);
  }

  // /api/sequences/trigger
  if (seg0 === 'sequences' && seg1 === 'trigger') {
    return handleSequencesTrigger(req, res);
  }

  // /api/sequences/bulk-trigger
  if (seg0 === 'sequences' && seg1 === 'bulk-trigger') {
    return handleSequencesBulkTrigger(req, res);
  }

  // /api/sequences/process
  if (seg0 === 'sequences' && seg1 === 'process') {
    return handleSequencesProcess(req, res);
  }

  // /api/dashboard/stats
  if (seg0 === 'dashboard' && seg1 === 'stats') {
    return handleDashboardStats(req, res);
  }

  // /api/conversations
  if (seg0 === 'conversations' && !seg1) {
    return handleConversationsList(req, res);
  }

  return notFound(res);
};
