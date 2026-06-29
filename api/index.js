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

async function sendEmail({ to, toName, subject, body, leadId }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'godwin@vyrrahlabs.com';
  const fromName = process.env.SENDGRID_FROM_NAME || 'Godwin Rayen';
  if (!apiKey) throw new Error('SENDGRID_API_KEY not configured');

  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: toName || '' }] }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: `godwin@in.vyrrahlabs.com`, name: fromName },
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

    // `kind:'admin'` is the claim requireAuth() checks (api/_lib/auth.js).
    // `role` kept for backwards-compat with any other consumer.
    const token = jwt.sign(
      { kind: 'admin', role: 'admin', username },
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

    // Accept both UI-normalized objects ({first_name, phone, ...}) and the raw
    // restoration CSV columns ("First Name", "Mobile Number", "Industry", ...)
    // so curl/Zapier/non-UI imports work too.
    const pick = (c, ...keys) => {
      for (const k of keys) {
        if (c[k] !== undefined && c[k] !== null && String(c[k]).trim() !== '') {
          return String(c[k]).trim();
        }
      }
      return null;
    };

    const seen = new Set();
    let skippedDupes = 0;

    const rows = contacts.map(c => {
      const phone = normalizePhone(
        pick(c, 'phone', 'Phone', 'mobile', 'Mobile', 'Mobile Number', 'mobile_number', 'Phone Number') || ''
      );
      const niche = pick(c, 'niche', 'Niche', 'industry', 'Industry');
      const cityState = [pick(c, 'city', 'City'), pick(c, 'state', 'State')].filter(Boolean).join(', ');
      const title = pick(c, 'title', 'Title');
      const notes = pick(c, 'notes', 'Notes')
        || [title, cityState].filter(Boolean).join(' — ')
        || null;
      return {
        first_name: pick(c, 'first_name', 'firstName', 'First Name') || '',
        last_name: pick(c, 'last_name', 'lastName', 'Last Name'),
        company: pick(c, 'company', 'Company'),
        phone,
        email: pick(c, 'email', 'Email'),
        country: pick(c, 'country', 'Country') || 'United States',
        niche,
        status: 'new',
        campaign: pick(c, 'campaign', 'Campaign') || 'USA Outreach',
        notes
      };
    }).filter(c => {
      if (!c.first_name || !c.phone) return false;
      // In-batch dedup: re-importing the same list twice in one payload
      if (seen.has(c.phone)) { skippedDupes++; return false; }
      seen.add(c.phone);
      return true;
    });

    if (rows.length === 0) {
      return res.status(200).json({ imported: 0, skipped: contacts.length, leads: [] });
    }

    const supabase = getSupabase();

    // Upsert on phone so re-importing a list updates instead of duplicating.
    // Requires the uniq_leads_phone index (migrations/2026-06-dialer-channel-dedup.sql).
    // Insert in chunks; if a chunk fails (e.g. one bad row), fall back to
    // per-row so a single bad record can't sink the whole import.
    const imported = [];
    const failed = [];

    const upsertRows = async (batch) => {
      const { data, error } = await supabase
        .from('leads')
        .upsert(batch, { onConflict: 'phone', ignoreDuplicates: false })
        .select();
      if (error) throw error;
      return data || [];
    };

    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      try {
        imported.push(...await upsertRows(batch));
      } catch (batchErr) {
        // Isolate the bad row(s): retry one at a time.
        for (const row of batch) {
          try {
            imported.push(...await upsertRows([row]));
          } catch (rowErr) {
            failed.push({ phone: row.phone, error: rowErr.message });
          }
        }
      }
    }

    return res.status(200).json({
      imported: imported.length,
      // rows dropped before insert: missing name/phone + in-batch duplicate phones
      skipped: contacts.length - rows.length,
      duplicates_in_payload: skippedDupes,
      failed,
      leads: imported
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

async function handleWebhookQuickmail(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Process sequentially then respond — sequential awaits are reliable,
  // Promise.all has issues with Supabase lazy query builders
  try {
    const payload = req.body || {};
    const supabase = getSupabase();
    console.log('Quickmail webhook:', JSON.stringify(payload).slice(0, 300));

    const event = payload.event || payload.type || payload.action || '';
    const isReply       = event.toLowerCase().includes('reply') || event.toLowerCase().includes('response');
    const isUnsubscribe = event.toLowerCase().includes('unsub') || event.toLowerCase().includes('optout');
    const isBounce      = event.toLowerCase().includes('bounce');

    const prospect = payload.prospect || payload.contact || payload.lead || {};
    const email = prospect.email || payload.email || payload.from || payload.prospect_email || '';
    if (!email) return res.status(200).json({ received: true, warning: 'no email in payload' });

    const replyRaw = payload.reply || payload.message || {};
    const body = (typeof replyRaw === 'string' ? replyRaw
      : replyRaw.body || replyRaw.text || replyRaw.content
      || payload.body || payload.text || '')
      || `[${event || 'Quickmail event'}]`;

    const campaignName = (payload.campaign || {}).name || payload.campaign_name
      || (typeof payload.campaign === 'string' ? payload.campaign : '') || 'Quickmail';

    const { data: lead } = await supabase
      .from('leads').select('id, status').eq('email', email).maybeSingle();

    if (isUnsubscribe) {
      await supabase.from('opt_outs').upsert([{ phone: email }], { onConflict: 'phone' });
      if (lead?.id) {
        await supabase.from('leads').update({ status: 'not_interested' }).eq('id', lead.id);
        await supabase.from('sequences').update({ status: 'skipped' })
          .eq('lead_id', lead.id).eq('status', 'pending');
      }
      console.log(`QM unsubscribe: ${email}`);
      return res.status(200).json({ received: true, action: 'unsubscribed' });
    }

    if (isBounce) {
      if (lead?.id) await supabase.from('leads').update({ status: 'not_interested' }).eq('id', lead.id);
      console.log(`QM bounce: ${email}`);
      return res.status(200).json({ received: true, action: 'bounced' });
    }

    if (isReply || body) {
      const { error: insertErr } = await supabase.from('sms_messages').insert([{
        lead_id: lead?.id || null,
        phone: email,
        direction: 'inbound',
        body: `📧 [Email reply via ${campaignName}]\n\n${body}`,
        channel: 'email',
        status: 'received',
        twilio_sid: `qm_${Date.now()}`
      }]);
      if (insertErr) console.error('QM insert error:', insertErr);

      if (lead?.id && ['new','contacted'].includes(lead.status)) {
        await supabase.from('leads').update({ status: 'replied' }).eq('id', lead.id);
        await supabase.from('sequences').update({ status: 'skipped' })
          .eq('lead_id', lead.id).eq('status', 'pending');
      }
      console.log(`QM reply: ${email}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Quickmail webhook error:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
}

// ─── Sequences handlers ──────────────────────────────────────────────────────

const EMAIL_SEQUENCE_TEMPLATES = [
  {
    subject: "{{firstname}}",
    body: `{{firstname}},

When a call comes into {{company}} after hours or while your crew's on a job, what happens to it? Most owners I talk to are quietly losing five-figure jobs to voicemail.

I put a recovery line on your existing number that texts every missed caller back in under 60 seconds and books them — 24/7. I'll run it on your line free for a week and show you the exact dollar value of the calls you've been missing.

No card, you keep your number. Worth a look?

cal.com/godwin-rayen/30min

Godwin
Vyrrah Labs`
  },
  {
    subject: "Re: {{firstname}}",
    body: `{{firstname}},

Tried calling earlier.

62% of calls to companies like {{company}} go unanswered. Every one is a job walking to whoever picks up first. The fix takes an afternoon and costs you nothing for a week.

At the end I show you your real numbers — most owners are surprised what they're leaking.

cal.com/godwin-rayen/30min

Godwin`
  },
  {
    subject: "Re: {{firstname}}",
    body: `{{firstname}},

Last one from me.

It sits behind your current number — normal calls ring like always. Only when one's missed does it text back, sound human, and book the job. Free for a week, no card, 3x the fee or it cancels.

If you ever want me running your whole growth, that's the retainer — but start with the free week and decide on the numbers.

cal.com/godwin-rayen/30min

Godwin`
  }
];

const SEQUENCE_DEFAULT_TEMPLATES = [
  // SMS 1 — Day 1 afternoon
  "Hey {first_name}, Godwin here — I put a line on {company}'s number that texts missed callers back in 60s and books the job. Free for a week, no card. Want yours set up? cal.com/godwin-rayen/30min (txt STOP to opt out)",
  // SMS 2 — Day 2 afternoon (after call attempt)
  "Hey {first_name}, tried calling. 62% of calls to shops like {company} go unanswered — that's jobs walking. A free week on your line shows you exactly what you're missing. cal.com/godwin-rayen/30min — Godwin",
  // SMS 3 — Day 3 close
  "{first_name}, last one. Free week of the missed-call tool, no card, 3x or it cancels — then I show you your numbers. cal.com/godwin-rayen/30min — Godwin"
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
    const H = 3600000;
    const steps = [
      // SMS 1: Day 1 afternoon (5hr after email)
      { step: 1, scheduled_at: new Date(now.getTime() + 5*H).toISOString(), message: step1_message || SEQUENCE_DEFAULT_TEMPLATES[0] },
      // SMS 2: Day 2 afternoon (30hr — after morning call attempt)
      { step: 2, scheduled_at: new Date(now.getTime() + 30*H).toISOString(), message: SEQUENCE_DEFAULT_TEMPLATES[1] },
      // SMS 3: Day 3 afternoon (54hr — close)
      { step: 3, scheduled_at: new Date(now.getTime() + 54*H).toISOString(), message: SEQUENCE_DEFAULT_TEMPLATES[2] }
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

      const H = 3600000;
      rows.push({ lead_id: lead.id, campaign, step: 1, scheduled_at: new Date(sendAt.getTime() + 5*H).toISOString(), status: 'pending', message_body: SEQUENCE_DEFAULT_TEMPLATES[0] });
      rows.push({ lead_id: lead.id, campaign, step: 2, scheduled_at: new Date(sendAt.getTime() + 30*H).toISOString(), status: 'pending', message_body: SEQUENCE_DEFAULT_TEMPLATES[1] });
      rows.push({ lead_id: lead.id, campaign, step: 3, scheduled_at: new Date(sendAt.getTime() + 54*H).toISOString(), status: 'pending', message_body: SEQUENCE_DEFAULT_TEMPLATES[2] });
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
    .replace(/\{\{firstname\}\}/gi, lead.first_name || '')
    .replace(/\{\{company\}\}/gi, lead.company || 'your company')
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
        .select('*, leads(id, first_name, last_name, company, phone, email)')
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
          if (seq.channel === 'email') {
            // Email send via SendGrid
            if (!lead.email) {
              await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
              allResults.push({ id: seq.id, status: 'skipped', reason: 'no email address' });
              continue;
            }
            let subject = 'Follow up';
            let emailBody = body;
            try {
              const parsed = JSON.parse(seq.message_body);
              subject = interpolate(parsed.subject, lead);
              emailBody = interpolate(parsed.body, lead);
            } catch { emailBody = body; }

            await sendEmail({ to: lead.email, toName: `${lead.first_name} ${lead.last_name || ''}`.trim(), subject, body: emailBody, leadId: lead.id });

            await supabase.from('sms_messages').insert([{
              lead_id: lead.id,
              phone: lead.email,
              direction: 'outbound',
              body: `📧 [Email - ${subject}]\n\n${emailBody.substring(0, 200)}`,
              channel: 'email',
              status: 'sent',
              twilio_sid: `sg_${Date.now()}`
            }]);
            await supabase.from('sequences').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', seq.id);
            await supabase.from('leads').update({ status: 'contacted' }).eq('id', lead.id).eq('status', 'new');
            allResults.push({ id: seq.id, status: 'sent', channel: 'email' });
          } else {
            // SMS via Twilio
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
          }
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

async function handleEmailSequencesTrigger(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { lead_id, campaign } = req.body;
    if (!lead_id || !campaign) return res.status(400).json({ error: 'lead_id and campaign required' });

    const supabase = getSupabase();
    const { data: lead } = await supabase.from('leads').select('id, email, status').eq('id', lead_id).single();
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Check email opt-out
    const { data: optOut } = await supabase.from('opt_outs').select('id').eq('phone', lead.email).maybeSingle();
    if (optOut) return res.status(400).json({ error: 'Lead has opted out' });

    // Cancel any existing pending email sequences
    await supabase.from('sequences').update({ status: 'skipped' })
      .eq('lead_id', lead_id).eq('campaign', campaign).eq('status', 'pending').eq('channel', 'email');

    const now = new Date();
    const H = 3600000;
    // Email 1: Day 1 morning (immediate)
    // Email 2: Day 2 morning (24hr)
    // Email 3: Day 3 morning (48hr — close)
    const emailDelays = [0, 24*H, 48*H];
    const emailRows = EMAIL_SEQUENCE_TEMPLATES.map((tpl, i) => ({
      lead_id,
      campaign,
      step: i + 1,
      scheduled_at: new Date(now.getTime() + emailDelays[i]).toISOString(),
      status: 'pending',
      channel: 'email',
      message_body: JSON.stringify({ subject: tpl.subject, body: tpl.body })
    }));

    const { data, error } = await supabase.from('sequences').insert(emailRows).select();
    if (error) throw error;
    return res.status(200).json({ success: true, sequences: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleEmailSequencesBulkTrigger(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { campaign = 'USA Outreach', status_filter = 'new', limit = 500 } = req.body;
    const supabase = getSupabase();

    const { data: leads, error: leadsErr } = await supabase
      .from('leads').select('id, email, phone, first_name, last_name, company')
      .eq('status', status_filter).not('email', 'is', null).neq('email', '').limit(limit);
    if (leadsErr) throw leadsErr;
    if (!leads?.length) return res.status(200).json({ enrolled: 0, skipped: 0, message: 'No leads found' });

    const { data: optOuts } = await supabase.from('opt_outs').select('phone');
    const optOutSet = new Set((optOuts || []).map(o => o.phone));

    const { data: existing } = await supabase.from('sequences').select('lead_id')
      .eq('campaign', campaign).eq('status', 'pending').eq('channel', 'email');
    const enrolledSet = new Set((existing || []).map(e => e.lead_id));

    const now = new Date();
    const rows = [];
    const enrolledIds = [];
    let skipped = 0;

    for (const lead of leads) {
      if (!lead.email || optOutSet.has(lead.email) || enrolledSet.has(lead.id)) { skipped++; continue; }
      const staggerMs = (rows.length / 3) * 4000;
      const sendAt = new Date(now.getTime() + staggerMs);
      enrolledIds.push(lead.id);
      const eH = 3600000;
      const emailDelays = [0, 24*eH, 48*eH];
      EMAIL_SEQUENCE_TEMPLATES.forEach((tpl, i) => {
        rows.push({
          lead_id: lead.id, campaign, step: i + 1, channel: 'email',
          scheduled_at: new Date(sendAt.getTime() + emailDelays[i]).toISOString(),
          status: 'pending',
          message_body: JSON.stringify({ subject: tpl.subject, body: tpl.body })
        });
      });
    }

    if (!rows.length) return res.status(200).json({ enrolled: 0, skipped, message: 'All leads enrolled or opted out' });

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('sequences').insert(rows.slice(i, i + 500));
      if (error) throw error;
    }
    if (enrolledIds.length) {
      await supabase.from('leads').update({ status: 'contacted' }).in('id', enrolledIds);
    }
    return res.status(200).json({ enrolled: enrolledIds.length, skipped, campaign, channel: 'email' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function handleWebhookSendgrid(req, res) {
  // SendGrid Inbound Parse sends multipart form data
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const body = req.body || {};
    const fromRaw = body.from || '';
    // Extract email from "Name <email>" format
    const emailMatch = fromRaw.match(/<([^>]+)>/) || [null, fromRaw];
    const fromEmail = emailMatch[1]?.trim() || fromRaw.trim();
    const replyText = body.text || (body.html || '').replace(/<[^>]*>/g, '') || '';
    const subject = body.subject || '';

    if (!fromEmail) return res.status(200).end();

    const supabase = getSupabase();
    const { data: lead } = await supabase.from('leads').select('id, status').eq('email', fromEmail).maybeSingle();

    // Log the reply
    await supabase.from('sms_messages').insert([{
      lead_id: lead?.id || null,
      phone: fromEmail,
      direction: 'inbound',
      body: `📧 [Email reply: ${subject}]\n\n${replyText.substring(0, 500)}`,
      channel: 'email',
      status: 'received',
      twilio_sid: `sg_inbound_${Date.now()}`
    }]);

    // Update lead status and stop sequences
    if (lead?.id) {
      if (['new','contacted'].includes(lead.status)) {
        await supabase.from('leads').update({ status: 'replied' }).eq('id', lead.id);
      }
      await supabase.from('sequences').update({ status: 'skipped' })
        .eq('lead_id', lead.id).eq('status', 'pending').eq('channel', 'email');
    }

    return res.status(200).end();
  } catch (err) {
    console.error('SendGrid inbound error:', err);
    return res.status(200).end();
  }
}

// ─── SendGrid event webhook (bounces, unsubscribes, opens) ───────────────────

async function handleWebhookSendgridEvents(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const supabase = getSupabase();

    for (const evt of events) {
      const email = evt.email || '';
      const event = evt.event || '';
      if (!email) continue;

      const { data: lead } = await supabase.from('leads')
        .select('id, status').eq('email', email).maybeSingle();

      if (event === 'bounce' || event === 'dropped') {
        if (lead?.id) await supabase.from('leads').update({ status: 'not_interested' }).eq('id', lead.id);
        await supabase.from('sequences').update({ status: 'skipped' })
          .eq('status', 'pending').eq('channel', 'email')
          .eq('lead_id', lead?.id || '00000000-0000-0000-0000-000000000000');
        console.log(`SendGrid bounce/drop: ${email}`);
      }

      if (event === 'unsubscribe' || event === 'group_unsubscribe' || event === 'spamreport') {
        await supabase.from('opt_outs').upsert([{ phone: email }], { onConflict: 'phone' });
        if (lead?.id) {
          await supabase.from('leads').update({ status: 'not_interested' }).eq('id', lead.id);
          await supabase.from('sequences').update({ status: 'skipped' })
            .eq('lead_id', lead.id).eq('status', 'pending').eq('channel', 'email');
        }
        console.log(`SendGrid unsubscribe: ${email}`);
      }

      if (event === 'open' && lead?.id) {
        // Log open as a touchpoint — don't change status
        console.log(`SendGrid open: ${email}`);
      }
    }
    return res.status(200).end();
  } catch (err) {
    console.error('SendGrid events error:', err);
    return res.status(200).end();
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
    const { status, channel, limit = 100, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('sequences')
      .select('*, leads(id, first_name, last_name, company, phone, email, status)', { count: 'exact' })
      .order('scheduled_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (status) query = query.eq('status', status);
    if (channel) query = query.eq('channel', channel);

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

  // /api/webhooks/sendgrid (inbound parse — email replies)
  if (seg0 === 'webhooks' && seg1 === 'sendgrid') {
    return handleWebhookSendgrid(req, res);
  }

  // /api/webhooks/sendgrid-events (bounces, unsubscribes, opens)
  if (seg0 === 'webhooks' && seg1 === 'sendgrid-events') {
    return handleWebhookSendgridEvents(req, res);
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

  // /api/sequences/email-trigger
  if (seg0 === 'sequences' && seg1 === 'email-trigger') {
    return handleEmailSequencesTrigger(req, res);
  }

  // /api/sequences/email-bulk-trigger
  if (seg0 === 'sequences' && seg1 === 'email-bulk-trigger') {
    return handleEmailSequencesBulkTrigger(req, res);
  }

  // /api/dashboard/stats
  if (seg0 === 'dashboard' && seg1 === 'stats') {
    return handleDashboardStats(req, res);
  }

  // /api/conversations
  if (seg0 === 'conversations' && !seg1) {
    return handleConversationsList(req, res);
  }

  // /api/contacts/newsletter-add — add lead to SendGrid newsletter
  if (seg0 === 'contacts' && seg1 === 'newsletter-add') {
    if (!requireAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { lead_id } = req.body;
      const supabase = getSupabase();
      const { data: lead } = await supabase.from('leads').select('email, first_name, last_name').eq('id', lead_id).single();
      if (!lead?.email) return res.status(400).json({ error: 'No email on lead' });
      const sgRes = await fetch('https://api.sendgrid.com/v3/marketing/contacts', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          list_ids: ['52013c2c-1c6f-4e21-9fe0-0e9940da8df1'],
          contacts: [{ email: lead.email, first_name: lead.first_name || '', last_name: lead.last_name || '' }]
        })
      });
      return res.status(200).json({ success: sgRes.ok, status: sgRes.status });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // /api/contacts/eod-stop — end of day call debrief: stop sequences for called leads
  if (seg0 === 'contacts' && seg1 === 'eod-stop') {
    if (!requireAuth(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { phones = [], outcome = 'contacted' } = req.body;
      if (!phones.length) return res.status(400).json({ error: 'phones array required' });
      const supabase = getSupabase();
      const results = { stopped: 0, not_found: [] };
      for (const phone of phones) {
        const normalized = phone.replace(/\D/g, '');
        const { data: lead } = await supabase.from('leads').select('id')
          .or(`phone.eq.+${normalized},phone.eq.${phone}`).maybeSingle();
        if (!lead) { results.not_found.push(phone); continue; }
        await supabase.from('sequences').update({ status: 'skipped' })
          .eq('lead_id', lead.id).eq('status', 'pending');
        const validOutcomes = ['contacted','replied','not_interested','booked','follow_up'];
        if (validOutcomes.includes(outcome)) {
          await supabase.from('leads').update({ status: outcome }).eq('id', lead.id);
        }
        results.stopped++;
      }
      return res.status(200).json({ success: true, ...results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return notFound(res);
};
