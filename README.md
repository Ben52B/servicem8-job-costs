# Job Costs: a ServiceM8 add-on

One place for every supplier invoice on a job. For a garage door job, that's the door, motor, posts, cover and the install subbie.

- Adds a **Job Costs** button to every ServiceM8 job card.
- Each job gets its **own email address**. Forward invoices to it, or give it to suppliers.
- You can also **drag and drop** PDFs or phone photos onto the card.
- Claude **reads each invoice**: supplier, invoice number, dates, line items, GST and total.
- Shows **total cost, paid, still to pay and GST** for the job, plus breakdowns by supplier and by type (materials, subcontractor, freight…).
- Tick a whole invoice or single lines as **paid**. Receipts and invoices stamped PAID are ticked automatically.
- Catches **duplicates**: if a supplier sends the same invoice twice, it's only counted once.
- You can fix anything the reader got wrong: description, type, amount, supplier or total.

## How it fits together

```
ServiceM8 job card ──(Job Costs button)──► this app ──► card with totals & invoices
Supplier / you ──email──► Postmark inbound ──webhook──► this app ──► Claude reads invoice
You ──drag & drop──────────────────────────────────────► this app ──► Claude reads invoice
```

How costs are counted: each line's **cost to job** is its share of the invoice total. GST, rounding and discounts are spread across the lines, so the lines always add up to what you actually owe.

## Setup

### 1. Host the app

You need any Node.js 22.13+ host with HTTPS and a **persistent disk**, for example Render, Railway, Fly.io or a small VPS. The database and invoice files live in `DATA_DIR`.

```bash
cd servicem8-job-costs
npm install
cp .env.example .env     # fill it in (see below)
npm start
```

### 2. Get a Claude API key

Create a key at <https://console.anthropic.com> and set `ANTHROPIC_API_KEY`.

### 3. Create the ServiceM8 add-on

1. Sign up for a ServiceM8 developer account (developer.servicem8.com) and create a new add-on of type **Web Service Hosted**.
2. Set the **Callback URL** to `https://<your-app>/servicem8/addon`.
3. Paste the manifest from `https://<your-app>/manifest.json`. It adds a "Job Costs" button to the job card.
4. Copy the add-on's **App Secret** into `SERVICEM8_APP_SECRET`.
5. Give it the `read_jobs` scope so the card can show the job number and address.
6. Install the add-on on your own ServiceM8 account. A private add-on doesn't need to be published to the store.

### 4. Set up email-to-job

**Easiest option (no domain needed): Postmark**

1. Create a Postmark account and server. Open the **Inbound** stream.
2. Copy your inbound address (looks like `abc123@inbound.postmarkapp.com`) into `INBOUND_BASE_ADDRESS`.
3. Set the inbound webhook URL to `https://<your-app>/inbound/email?key=<INBOUND_SECRET>`.

Each job then gets an address like `abc123+k3x9m2pq@inbound.postmarkapp.com`, shown on the card with a Copy button.

**Your own domain:** point a subdomain's MX record (e.g. `jobs.yourbusiness.com.au`) at Postmark, SendGrid Inbound Parse or Mailgun, and set `INBOUND_DOMAIN`. Jobs then get `job-k3x9m2pq@jobs.yourbusiness.com.au`. All three providers' webhook formats work.

What gets read from an email:
- **PDF attachments**, one invoice each.
- If there's no PDF, **photos** (small logo and signature images are skipped).
- If there are no attachments, the **email text itself**, for suppliers who put the invoice in the email body.

### 5. Try it without ServiceM8

Set `DEV_MODE=true`, run `npm start`, and open `http://localhost:3000/dev/job/test-1`.

To check how well a real invoice is read:

```bash
node scripts/try-invoice.js path/to/invoice.pdf
```

## Which Claude model?

Change it with `CLAUDE_MODEL`. Costs below are rough estimates for a typical 1–2 page invoice.

| Model | Accuracy on messy invoices | Approx. cost per invoice |
|---|---|---|
| `claude-opus-5-5` (default) | Best: handles faded scans, phone photos, handwritten dockets, multi-page statements | ~5c |
| `claude-sonnet-5-5` | Very good on clean PDFs from suppliers' accounting systems | ~2–3c |
| `claude-haiku-5-5` | Fine for simple, clean invoices; more likely to miss lines on hard ones | well under 1c |

At 50 invoices a month, even the default is only a few dollars. Start with Opus 5.5. Drop to Sonnet 5.5 only if your invoices are almost all clean PDFs.

`CLAUDE_EFFORT` (low / medium / high) trades thoroughness for cost. `medium` is a good default.

## Development

```bash
npm test         # API + email + totals tests (no API key needed; the invoice reader is faked)
npm run dev      # auto-restart on changes
```

| Path | What it does |
|---|---|
| `src/app.js` | Routes: ServiceM8 callback, card API, inbound email webhook |
| `src/analyzer.js` | Claude invoice reading (structured output) |
| `src/db.js` | SQLite storage (built into Node) and totals |
| `src/inbound.js` | Per-job email addresses; Postmark / SendGrid / Mailgun parsing |
| `src/servicem8.js` | Verifies ServiceM8's signed request; looks up the job number |
| `public/card.html` | The screen shown inside ServiceM8 |

## Possible next steps

- Copy each invoice into the job's **Attachments** in ServiceM8, and post the cost total as a job note. This needs ServiceM8 OAuth.
- Pull **paid status from Xero/MYOB** instead of ticking it by hand.
- Show **profit**: compare costs against the job's quoted/invoiced amount from ServiceM8.
