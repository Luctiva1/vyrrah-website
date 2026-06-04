const { getTwilio } = require('../_lib/twilio');
const { getSupabase } = require('../_lib/supabase');
const { cors } = require('../_lib/auth');

// Interpolate template variables
function interpolate(template, lead) {
  if (!template) return '';
  return template
    .replace(/\{first_name\}/g, lead.first_name || '')
    .replace(/\{last_name\}/g, lead.last_name || '')
    .replace(/\{company\}/g, lead.company || 'your company')
    .replace(/\{name\}/g, `${lead.first_name || ''} ${lead.last_name || ''}`.trim());
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Allow both GET (cron) and POST (manual trigger with auth)
  // Cron calls GET without auth header — that's fine for a processing job

  try {
    const supabase = getSupabase();
    const now = new Date().toISOString();

    // Fetch pending sequences due now
    const { data: pending, error } = await supabase
      .from('sequences')
      .select('*, leads(id, first_name, last_name, company, phone)')
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .limit(50);

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return res.status(200).json({ processed: 0, message: 'No pending sequences' });
    }

    const twilio = getTwilio();
    const results = [];

    for (const seq of pending) {
      const lead = seq.leads;
      if (!lead) {
        await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
        results.push({ id: seq.id, status: 'skipped', reason: 'lead not found' });
        continue;
      }

      // Check opt-out
      const { data: optOut } = await supabase
        .from('opt_outs')
        .select('id')
        .eq('phone', lead.phone)
        .maybeSingle();

      if (optOut) {
        await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
        results.push({ id: seq.id, status: 'skipped', reason: 'opted out' });
        continue;
      }

      const body = interpolate(seq.message_body, lead);
      if (!body) {
        await supabase.from('sequences').update({ status: 'skipped' }).eq('id', seq.id);
        results.push({ id: seq.id, status: 'skipped', reason: 'empty message' });
        continue;
      }

      try {
        const message = await twilio.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: lead.phone,
          body
        });

        // Log SMS
        await supabase.from('sms_messages').insert([{
          lead_id: lead.id,
          phone: lead.phone,
          direction: 'outbound',
          body,
          twilio_sid: message.sid,
          status: message.status
        }]);

        // Mark sequence step sent
        await supabase
          .from('sequences')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', seq.id);

        // Update lead status
        await supabase
          .from('leads')
          .update({ status: 'contacted' })
          .eq('id', lead.id)
          .eq('status', 'new');

        results.push({ id: seq.id, status: 'sent', sid: message.sid });
      } catch (sendErr) {
        console.error(`Failed to send sequence ${seq.id}:`, sendErr);
        results.push({ id: seq.id, status: 'error', error: sendErr.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('Sequence process error:', err);
    return res.status(500).json({ error: err.message });
  }
};
