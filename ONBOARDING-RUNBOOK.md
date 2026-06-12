# Vyrrah Recaller — 15-Minute Client Onboarding Runbook

Godwin's script for onboarding a practice live on a call (or async via link). Target: under 15 minutes from "yes" to live.

## The 7 Steps

### 1. Fill the form together (3 min)
During or right after the sales call, open **https://vyrrahlabs.com/start** (screen-share or send them the link).
Fill Step 1 together:
- Practice name, owner name, owner email, **owner mobile** (this gets the "someone wants to book!" texts)
- **Practice main line** — the number patients actually call today
- Average customer value (default 500 — ask "what's a new patient worth to you, roughly?")
- Services (one line), booking link if they have one, preferred area code (3 digits, optional)

Hit submit. You'll land on Step 2 with their new Twilio number.

> If you see **"Number pending"** instead: the account is created, the number purchase soft-failed. See troubleshooting below — retry provision, then text them the forwarding code manually.

### 2. Walk the forwarding dial code live (3 min)
Have them pick up the phone that owns the main line and dial the GSM code shown on Step 2:

```
*004*<their new number>#     e.g.  *004*+15551234567#
```

This sets **conditional** forwarding (when-unanswered / when-busy) — answered calls are completely untouched. If the dial code doesn't take:
- iPhone/Android: Settings → Phone → Call Forwarding → conditional only
- VoIP/desk system (RingCentral, Weave, PBX): set **No-Answer forwarding** to the new number in the phone admin, or have them forward the page to their IT person

### 3. Run the "test it now" call together (2 min)
They call their main line **from another phone** (not the owner mobile — owner numbers are skipped by design) and let it ring out. Within 60 seconds the caller phone should get the text-back. Confirm it arrived out loud. This is the magic moment — let it land.

### 4. Send them their dashboard link (1 min)
Step 3 of /start links it, or grab it yourself: the magic token lives on the client record —

```
GET https://vyrrahlabs.com/api/tool/clients
```

→ find their client, copy `magic_token`, link is:

```
https://vyrrahlabs.com/recover?token=<magic_token>
```

Text/email it: "Bookmark this — every recovered call shows up here in real time."

### 5. Diary the day-7 results call (1 min)
Book it before you hang up: cal.com link or calendar invite, 7 days out. The weekly cron email (Mondays) backs this up, but the call is the close.

### 6. Day-7: walk the numbers, close $500/mo
Open their /recover dashboard on the call. Walk: missed calls caught → conversations recovered → bookings → estimated revenue saved. Then:

> "It saved you $X this week. It's $500/month to keep it running. Want me to send the payment link?"

- **Dodo connected:** `GET /api/tool/pay?client_id=<id>` → send the returned `link`.
- **Dodo not connected yet:** the endpoint returns `{ "manual": true }` — invoice manually, then mark them active in Supabase (`status='active'`). The Dodo webhook will handle this automatically once live.

### 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No text-back arriving | Forwarding not set (or set to "always" instead of conditional) | Re-dial `*004*<number>#` on the main-line phone; verify with another test call |
| No text-back arriving | Test caller is the **owner's phone or the main line itself** — skipped by design | Test from a third phone |
| No text-back arriving | Call never reached us | Check `GET /api/tool/report?client_id=<id>` — if no call rows, forwarding isn't reaching the Twilio number |
| Caller got no SMS but call logged | Caller is toll-free/short-code, or previously texted STOP | Expected behaviour — test from a normal mobile |
| "Number pending" on signup | Twilio provisioning soft-failed | Retry provision (curl below) |
| Lost the dashboard link | — | `GET /api/tool/clients` → `magic_token` → `/recover?token=<token>` |

**Provision retry curl:**

```bash
curl -X POST https://vyrrahlabs.com/api/tool/clients/provision \
  -H "Content-Type: application/json" \
  -d '{"client_id": "<CLIENT_ID>", "area_code": "415"}'
```

(`area_code` optional; response includes the new `twilio_number` and forwarding instructions.)

---
Vyrrah Recaller · a Vyrrah Labs product · godwin@vyrrahlabs.com
