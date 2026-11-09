const crypto = require('crypto');

/**
 * Stripe, for BILLING_MODE=stripe: Checkout (Stripe's own payment page, outside ServiceM8 – ServiceM8
 * doesn't allow card details inside its windows), the customer portal (change plan, card, cancel),
 * and the webhook that tells us what was paid. Plain HTTPS calls, no extra package.
 */
function stripeApi(secretKey, fetchImpl = fetch) {
  const form = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === 'object') return form(v, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(v)}`];
  });
  async function call(method, path, body) {
    if (!secretKey) throw new Error('Payments aren’t set up on this server (STRIPE_SECRET_KEY).');
    const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body ? form(body).join('&') : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `Stripe said ${res.status}`);
    return data;
  }
  return {
    /** A Checkout page for a monthly subscription to one price. */
    checkout: ({ price, accountKey, customer, email, successUrl, cancelUrl }) => call('POST', 'checkout/sessions', {
      mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': 1, client_reference_id: accountKey,
      'subscription_data[metadata][account_key]': accountKey, 'metadata[account_key]': accountKey,
      success_url: successUrl, cancel_url: cancelUrl, ...(customer ? { customer } : email ? { customer_email: email } : {}),
      allow_promotion_codes: 'true',
    }),
    /** Stripe's page to change plan or card, see invoices, or cancel. */
    portal: ({ customer, returnUrl }) => call('POST', 'billing_portal/sessions', { customer, return_url: returnUrl }),
    subscription: (id) => call('GET', `subscriptions/${encodeURIComponent(id)}`),
  };
}

/** Check a webhook really came from Stripe (Stripe-Signature header, HMAC-SHA256 of "t.payload"). */
function verifyStripeSignature(payload, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).map(([k, ...v]) => [k, v.join('=')]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** Which of our plans a Stripe price is (STRIPE_PRICE_BASIC / _PRO / _PREMIUM). */
function planOfPrice(priceId, config) {
  const p = config.stripePrices || {};
  return Object.keys(p).find((k) => p[k] && p[k] === priceId) || null;
}

module.exports = { stripeApi, verifyStripeSignature, planOfPrice };
