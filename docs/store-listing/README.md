# ServiceM8 Add-on Store: listing pack

Everything needed to submit the add-on to the ServiceM8 Add-on Store, based on ServiceM8's
[Add-on Store Requirements](https://developer.servicem8.com/docs/addon-store-requirements) and
[Platform Policy](https://developer.servicem8.com/page/platform-policy) (read November 2026).
Items marked **TO DO** need you.

## 1. Name (TO DO: choose)

ServiceM8's rules: unique, at most 30 characters, not a generic descriptor ("Job Costs" on its own is
too generic), no "ServiceM8", "M8", "Mate" or "SM8", no subtitle. A company name is allowed
("Task List by MyCompany"). Ideas:

- **Job Costs by Alpha** (18) – keeps the name your team knows
- **BillTrack Job Costs** (19)
- **CostLens** (8)
- **Tradie Bills** (12)

Set it with the `ADDON_NAME` environment variable: the manifest, help, privacy and terms pages use it.
(The page headings inside the app still say "Job Costs"; rename them in the same release if you choose
a different name.)

## 2. Short description (the line under the name)

> Supplier bills on the right job, paid or not, and what each job really cost – read automatically from your inbox.

## 3. Long description

> **Know what every job really cost.** {Name} reads your supplier and subcontractor invoices – from
> Outlook or Gmail, from an email address of its own, or a PDF or photo you drop on the job – and puts
> each one on the right ServiceM8 job. You see every job's costs, what's paid and what's still to pay,
> and profit so far against the job's price.
>
> **How it works**
> - Invoices are read automatically: supplier, number, lines, GST and totals. Each one waits in the
>   Inbox with a suggested job (from the job number, site address or customer name on it) for your OK.
> - Share an invoice across jobs (e.g. 3 of 10 openers), keep the rest in stock, and use it on later jobs.
> - Tick bills paid one at a time or many at once. The same bill sent twice is caught, so it isn't paid twice.
> - Upload a supplier's price list and each of their invoices is checked against it; record agreed
>   discounts and price rises as rules.
> - Check a supplier's monthly statement line by line against your invoices, jobs and price lists before you pay.
> - Tag costs caused by mistakes and see what screw-ups cost, by reason and supplier.
> - Optional: a short, up-to-date summary note in each job's diary – costs, paid, to pay and profit.
>
> **Where:** on every job card in the ServiceM8 online dashboard and the iPhone/iPad app, and from the
> Add-ons menu / the app's More tab for the business-wide Inbox, Bills, Stock and reports.
>
> **Your data:** mailboxes are only read, never changed. Invoice files are read by Anthropic's Claude
> (not used to train models). Export everything to spreadsheets at any time.
>
> Made by {Operator}. Help: {URL}/help · Privacy: {URL}/privacy

(If you charge outside ServiceM8 while listing as "Free", ServiceM8 requires the description to say so,
e.g. "Free plan included; paid plans from $29/month".)

## 4. Platforms, regions, audience

- Platforms: **Online Dashboard and the iPhone/iPad app** (job button, Add-ons menu, More tab).
- Regions: built and tested for **Australia** (AUD, GST). The `addonTargetAudience` in the manifest says so
  (`ADDON_AUDIENCE` to change it).

## 5. Pricing (TO DO: choose a billing mode)

| Mode | How | Pros | Cons |
|---|---|---|---|
| `BILLING_MODE=servicem8` | One monthly fee set in your ServiceM8 developer account; ServiceM8 adds it to the customer's ServiceM8 bill | Easiest; no card handling; free to try is simple | ServiceM8 keeps 10%; one price for everyone (no tiers); ServiceM8 can refund up to 90 days |
| `BILLING_MODE=stripe` | Free / Basic $29 / Pro $59 / Premium $99 (AUD/month), paid on Stripe's page | Tiers and a free plan; ~1.7% + 30c card fees | You run billing; listing must say paid plans are external; no payments inside the iPhone app (handled: plans change on a computer) |

Built-in limits (change with `LIMIT_*` and `PRICE_*` variables, see `src/plans.js`):

| | Free | Basic | Pro | Premium |
|---|---|---|---|---|
| Invoices read / month | 10 | 150 | 400 | 1,000 |
| Price checks / month | – | – | 400 | 1,000 |
| Statement checks / month | – | – | 5 | unlimited |
| Email-in address, Bills, Stock, Export | | ✓ | ✓ | ✓ |
| Outlook / Gmail auto-import, price lists, statement check, reports | | | ✓ | ✓ |
| Priority support | | | | ✓ |

New businesses get a 14-day Pro trial (`TRIAL_DAYS`). Your own business is never limited: businesses already
using the app when plans were switched on are marked "owner", and you can list more in `OWNER_ACCOUNTS`.

Before fixing prices, look at `/admin/usage?key=<ADMIN_KEY>`: what each business used and roughly cost in
Claude fees. Keep Pro comfortably above a busy business's cost.

Stripe setup (only for `stripe` mode): create the 3 monthly prices in Stripe, set `STRIPE_SECRET_KEY`,
`STRIPE_PRICE_BASIC/PRO/PREMIUM`, add a webhook to `{URL}/billing/stripe-webhook` for
`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, and set
`STRIPE_WEBHOOK_SECRET`. Turn on the Stripe customer portal.

## 6. Screenshots

In `screenshots/` (sample data only – no real business or personal information, as required):

1. `1-desktop-job-costs.png` – a job's costs, paid / to pay, profit, statement-check warning
2. `2-desktop-inbox.png` – invoices waiting with a suggested job
3. `3-desktop-statement-check.png` – a supplier statement checked
4. `4-desktop-bills.png` – every bill, paid or not
5. `5-iphone-job-summary.png` – the job window in the iPhone app
6. `6-iphone-home.png` – Job Costs home from the More tab
7. `7-iphone-job-costs.png` – a job's costs on the iPhone

**TO DO:** place the iPhone ones in an iPhone frame (ServiceM8 asks for app screenshots "in the relevant iOS
device"), and retake them after choosing the name. Re-create with `node` + Playwright from the sample data
(ask Claude to "retake the store screenshots").

## 7. Help, privacy, terms, support

- Help: `{URL}/help` (covers setup, settings, every screen and workflow – required for approval)
- Privacy policy: `{URL}/privacy` · Terms: `{URL}/terms`
- **TO DO:** set `OPERATOR_NAME`, `OPERATOR_ABN`, `SUPPORT_EMAIL` (a monitored address), `HOSTING_REGION`
  (your Render region), fill the "[date]" and "[State]" in `public/legal/*.html`, and **have the privacy
  policy and terms checked by a lawyer** – they are a starting point written from what the app does,
  not legal advice.

## 8. Setup changes for other businesses (TO DO)

- **Microsoft (Outlook):** in Entra → your app registration → Authentication, change "Supported account
  types" to **Accounts in any organizational directory**, and complete **publisher verification**
  (Microsoft Partner Network ID) so other companies' admins can approve it. Keep `MS_TENANT_ID=organizations`.
- **Gmail / other mailboxes:** nothing to set up – each business connects with an app password in Settings.
- **ServiceM8:** create the public add-on in your ServiceM8 developer account, set the Activation URL
  (`{URL}/servicem8/activate`), Return URL (`{URL}/servicem8/oauth/callback`) and callback URL
  (`{URL}/servicem8/addon`), paste the manifest from `{URL}/manifest.json`, and set the OAuth scopes to
  only what's needed: `read_jobs read_customers read_job_materials read_attachments manage_attachments
  read_job_notes publish_job_notes`. Check on a test account that the diary summary can **edit** its note
  with these scopes (if not, it replaces the note instead, which also works).
- **Render:** a bigger disk and plan as businesses join; consider a nightly backup of `/var/data`.

## 9. Pre-submission checklist (from ServiceM8's requirements)

- [ ] Name chosen and set (`ADDON_NAME`), unique, ≤ 30 characters
- [ ] Short and long descriptions pasted, spelling checked, platforms stated
- [ ] At least 3 screenshots, iPhone ones in a device frame, no real data
- [ ] Help, privacy and terms live with your details; support email monitored
- [ ] Billing mode chosen and set up (ServiceM8 billing or Stripe)
- [ ] Tested end to end on a separate ServiceM8 test account using the "Private Add-on Install URL":
      install, welcome page, Outlook and Gmail connect, an invoice through to paid, the iPhone app button,
      the More tab, Disconnect
- [ ] Microsoft app registration multi-tenant and verified
- [ ] Partner account contact details up to date
- [ ] Submit for review → Partner Preview → Public Release
