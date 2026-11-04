# Job Costs: a ServiceM8 add-on

One place for every supplier invoice, matched to your ServiceM8 jobs. For a garage door job, that's the door, motor, posts, cover and the install subbie.

**How it works, in one path:**

1. **One email address for the business.** Send or forward every supplier invoice there, or ask suppliers to. Claude reads each one: supplier, invoice number, dates, every line, GST and total.
2. **Suggested job, one click.** If the invoice or email mentions a job number (e.g. "PO 208126", "Alpha GD 208126") or the job's site address, the invoice shows at the top of that job's **Job Costs** window: **✓ Add to this job** or **Not this job**. Everything else waits in the **Inbox**.
3. **＋ Add costs** on any job opens one window:
   - **Not assigned yet:** whole invoices, or part of a line (e.g. 1 of 10 motors). Pick the type (Materials, Subcontractor…) and screw-up reason as you add. What you don't take stays there for other jobs; that's your stock.
   - **Upload a file:** dropped files go straight onto this job.
   - **Type it in:** for lost paperwork. Attach the real file later and it replaces the typed details.

**On each job:**
- Profit against the quoted price (taken from ServiceM8, or typed in), costs by type, paid / still to pay, and screw-ups.
- The invoice list, the selected invoice's lines, and the original invoice side by side.
- Every line shows **where it went**: "#208126 ×1 (this job) · #208090 ×2 · #208117 ×3 · 4 of 10 left".
- **Paid** is one tick per invoice (it's one bill from the supplier), shared by every job using it.
- **Screw-up tags** per line or per invoice, with a fixed reason list (`src/mistakes.js`). Each job shows actual numbers and "without screw-ups" numbers.
- **Duplicates** are caught and counted once. Anything the reader got wrong can be fixed.

**Ex GST:** all costs, prices, profit and reports are ex GST, like ServiceM8's prices. Each invoice line is charged at its share of the invoice total without GST.

**Split jobs:** when ServiceM8 partial invoicing splits a job into #207974, #207974A, #207974B…, they're one job in Job Costs. Clicking Job Costs on any of them opens the main job. Its price is all its lines except the "Partial invoice" lines (the full job, ex GST). Invoices mentioning any of the numbers are suggested for the main job.

**Suggestions:** every suggestion can be confirmed with one click, moved to the right job with **Change job…**, or sent to stock with **📦 Send to stock** (or left in the Inbox).

**Stock order jobs:** if you open a ServiceM8 job for each stock order (because ServiceM8 has no purchase orders), invoices with that job number go into **stock** instead of becoming that job's costs. A job counts as a stock order job when its client name contains "Door Image" or its category contains "Internal" (change with `STOCK_JOB_CLIENTS` / `STOCK_JOB_CATEGORIES`). Every job also has a **📦 Stock order job** switch to correct it. A stock order job's window shows what was bought, which jobs took each item, and what's still in stock; reports leave stock order jobs out of profit.

**Inbox page:** everything not on a job yet, with its suggested job; add to any job, or **Keep as stock**. Below that, stock and leftovers with where each item went.

**Reports page:** any date range. Total costs, screw-ups ($ and % of costs), real profit vs profit without screw-ups, screw-ups by reason and by supplier, every job, every screw-up line (CSV download), and the value not on any job yet.

## The ServiceM8 job diary

- **Copied to the diary:** an invoice that is wholly on one job is attached to that job's diary in ServiceM8, with a short note (supplier, invoice number, amount ex GST). Shared invoices (e.g. 1 of 10 motors) and stock stay in Job Costs only. Typed-in invoices get the note; the file follows if you attach it later.
- **Pulled from the diary:** ＋ Add costs → **📎 From ServiceM8 diary** lists the job's PDFs and photos; click **Add** and it's read like an upload. Files already in Job Costs show **✓ Added**, and nothing is ever copied back.
- **Removing:** taking an invoice off a job in Job Costs offers *Also remove it from the ServiceM8 job diary*. If a file is deleted in the diary, the next time the card opens it asks whether to remove it from Job Costs too.
- Needs the attachment and note permissions in `SERVICEM8_SCOPES` (`manage_attachments read_job_attachments publish_job_attachments read_job_notes publish_job_notes`). After upgrading, open the add-on's install link once and approve again.

## How it fits together

```
Suppliers / you ──email──► Postmark inbound ──► this app ──► Claude reads invoice ──► Inbox (+ suggested job)
ServiceM8 job card ──(Job Costs button)──► this app ──► Job Costs window ──＋ Add costs──► invoice lines on the job
```

How costs are counted: invoices belong to the business; each line is shared out to jobs (all of it, or e.g. 1 of 10). A line's cost is its share of the invoice total, so GST, rounding and discounts are spread across the lines and everything adds up to what you owe.

## Setup

### 1. Host the app (Render)

The repo includes `render.yaml`, so Render sets everything up:

1. Sign up at <https://render.com> with your GitHub account and allow it to see the `servicem8-job-costs` repo.
2. **New → Blueprint**, pick the repo. Render reads `render.yaml`: an always-on Node server in Singapore with a 1 GB disk for the database and invoice files.
3. Paste in `ANTHROPIC_API_KEY`. `SERVICEM8_APP_SECRET` and `INBOUND_BASE_ADDRESS` can be left empty and filled in later (Dashboard → job-costs → Environment). The session and email secrets are generated for you.
4. Click **Apply**. After a few minutes, `https://<name>.onrender.com` shows "Job Costs add-on for ServiceM8 is running."

Every push to `main` on GitHub redeploys automatically. The app uses Render's address automatically, so `PUBLIC_URL` isn't needed.

Running it anywhere else: any Node.js 22.13+ host with HTTPS and a persistent disk; set `DATA_DIR` to the disk and `PUBLIC_URL` to the app's address, then `npm ci && npm start`.

### 2. Get a Claude API key

Create a key at <https://console.anthropic.com> and set `ANTHROPIC_API_KEY`.

### 3. Create the ServiceM8 add-on

1. Sign up for a ServiceM8 developer account (developer.servicem8.com) and create a new add-on of type **Web Service Hosted**.
2. Set the **Callback URL** to `https://<your-app>/servicem8/addon`.
3. Paste the manifest from `https://<your-app>/manifest.json`. It adds a "Job Costs" button to the job card.
4. Copy the add-on's **App ID** into `SERVICEM8_APP_ID` and its **App Secret** into `SERVICEM8_APP_SECRET`.
   Set the **Activation URL** to `https://<your-app>/servicem8/activate` and the **Return URL** to `https://<your-app>/servicem8/oauth/callback`. When you install the add-on, ServiceM8 asks you to approve it once; that lets the app read job numbers, addresses, quotes and the job list.
5. Give it the `read_jobs`, `read_customers` and `read_job_materials` scopes (job lines, for the full job price), so the window can show the job number, address and quoted price, emailed invoices can be matched to your active jobs, and stock order jobs can be recognised by client and category.
6. Install the add-on on your own ServiceM8 account. A private add-on doesn't need to be published to the store.

### 4. Set up the email address

**Free option (recommended): a normal mailbox the app checks.** Create a mailbox just for invoices, on your own domain (e.g. `invoices@yourbusiness.com.au`) or a free Gmail account. In Render → Environment set:

- `IMAP_HOST`: your provider's incoming mail server (`imap.gmail.com` for Gmail / Google Workspace, `imap.zoho.com` for Zoho, usually `mail.yourdomain.com.au` for web hosts)
- `IMAP_USER`: the mailbox address
- `IMAP_PASSWORD`: its password. Gmail / Google Workspace need an **app password** (Google Account → Security → 2-Step Verification → App passwords)

The app checks the mailbox every 2 minutes and reads emails from the last 2 weeks it hasn't seen. It never deletes, moves or marks anything, so you can still open the mailbox normally. Microsoft 365 / Outlook mailboxes don't allow this kind of password login, so use another provider or Postmark.

**Or Postmark** (a service that forwards emails to the app; paid above its free limit):


**Easiest option (no domain needed): Postmark**

1. Create a Postmark account and server. Open the **Inbound** stream.
2. Copy your inbound address (looks like `abc123@inbound.postmarkapp.com`) into `INBOUND_BASE_ADDRESS`.
3. Set the inbound webhook URL to `https://<your-app>/inbound/email?key=<INBOUND_SECRET>`.

Your business then gets one address like `abc123+k3x9m2pq@inbound.postmarkapp.com`, shown in the Job Costs window and the Inbox with a Copy button.

**Your own domain:** point a subdomain's MX record (e.g. `jobs.yourbusiness.com.au`) at Postmark, SendGrid Inbound Parse or Mailgun, and set `INBOUND_DOMAIN`. The address is then `invoices-k3x9m2pq@jobs.yourbusiness.com.au`. All three providers' webhook formats work.

**Tip:** put the job number on your purchase orders. Suppliers usually copy it onto the invoice, and the invoice is then suggested for the right job automatically.

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
| `src/db.js` | SQLite storage (built into Node): invoices, lines shared out to jobs, suggestions, totals, reports. Upgrades older databases automatically |
| `src/inbound.js` | The business email address; Postmark / SendGrid / Mailgun parsing |
| `src/servicem8.js` | Verifies ServiceM8's signed request; looks up the job and the list of active jobs |
| `public/card.html` | The Job Costs window shown inside ServiceM8 |
| `public/inbox.html`, `public/report.html` | Inbox and Reports pages |

## Later (not built yet)

Paid status is ticked by hand on purpose for now.

- Pull **paid status from Xero/MYOB** instead of ticking it by hand.
- Copy each invoice into the job's **Attachments** in ServiceM8, and post the cost total as a job note.
- Show the **Job Costs button in the ServiceM8 phone app** too.
