/**
 * Plans (tiers) and what each one includes. Prices are monthly, AUD, per business, and can be
 * changed with environment variables (PRICE_BASIC, PRICE_PRO, PRICE_PREMIUM).
 *
 * Billing modes (BILLING_MODE):
 * - none       (default) no plans: everything unlimited, as before plans existed
 * - servicem8  ServiceM8 bills one monthly fee for the add-on; everyone gets SERVICEM8_PLAN (default "pro")
 * - stripe     Free / Basic / Pro / Premium, paid on Stripe's own page (outside ServiceM8)
 */
const n = (v, d) => (v === undefined || v === '' ? d : Number(v));

const FEATURES = {
  email_in: 'Your Job Costs email address (forward invoices to it)',
  auto_email: 'Read invoices straight from Outlook or Gmail',
  bills: 'Bills page: everything to pay, mark several paid',
  stock: 'Stock: invoices kept in stock and what’s left',
  export: 'Export everything (spreadsheets + files)',
  price_lists: 'Price lists: each invoice checked against your supplier’s prices',
  statement_check: 'Statement check: a supplier’s monthly statement checked line by line',
  reports: 'Reports across all jobs, screw-ups by reason',
  priority_support: 'Priority support and a setup call',
};

function plans(env = process.env) {
  return {
    free: {
      key: 'free', name: 'Free', price: 0,
      blurb: 'Upload invoices, put them on jobs, tick them paid, see each job’s costs and profit.',
      limits: { invoice_read: n(env.LIMIT_FREE_INVOICES, 10), price_check: 0, statement_check: 0 },
      features: [],
    },
    basic: {
      key: 'basic', name: 'Basic', price: n(env.PRICE_BASIC, 29),
      blurb: 'For a small team: email-in, bills to pay, stock and export.',
      limits: { invoice_read: n(env.LIMIT_BASIC_INVOICES, 150), price_check: 0, statement_check: 0 },
      features: ['email_in', 'bills', 'stock', 'export'],
    },
    pro: {
      key: 'pro', name: 'Pro', price: n(env.PRICE_PRO, 59),
      blurb: 'Invoices straight from your inbox, checked against your price lists.',
      limits: { invoice_read: n(env.LIMIT_PRO_INVOICES, 400), price_check: n(env.LIMIT_PRO_PRICE_CHECKS, 400), statement_check: n(env.LIMIT_PRO_STATEMENTS, 5) },
      features: ['email_in', 'auto_email', 'bills', 'stock', 'export', 'price_lists', 'statement_check', 'reports'],
    },
    premium: {
      key: 'premium', name: 'Premium', price: n(env.PRICE_PREMIUM, 99),
      blurb: 'For busy businesses: more invoices, unlimited statement checks, priority support.',
      limits: { invoice_read: n(env.LIMIT_PREMIUM_INVOICES, 1000), price_check: n(env.LIMIT_PREMIUM_PRICE_CHECKS, 1000), statement_check: n(env.LIMIT_PREMIUM_STATEMENTS, 1e9) },
      features: ['email_in', 'auto_email', 'bills', 'stock', 'export', 'price_lists', 'statement_check', 'reports', 'priority_support'],
    },
  };
}

/** No limits at all (billing off, or the owner's own business). */
const UNLIMITED = { key: 'unlimited', name: 'Unlimited', price: 0, limits: { invoice_read: 1e9, price_check: 1e9, statement_check: 1e9 }, features: Object.keys(FEATURES) };

module.exports = { plans, FEATURES, UNLIMITED };
