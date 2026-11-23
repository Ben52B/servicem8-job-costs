/* 💳 Pay: the confirm box (every detail, the bank-detail check against the invoice), then the bank file to upload.
 * Used by the job card and Bills: openPay([invoice ids], { onDone }) */
(function () {
  const css = `
  .pay-bg { position: fixed; inset: 0; background: rgba(15, 30, 26, .5); display: flex; align-items: flex-start; justify-content: center; padding: 24px 12px; z-index: 80; overflow-y: auto; }
  .pay { background: #fff; border-radius: 18px; width: min(620px, 100%); padding: 18px 18px 16px; box-shadow: 0 20px 60px rgba(0,0,0,.3); font-size: 14px; }
  .pay h3 { margin: 0 0 4px; font-size: 18px; } .pay .muted { color: #6b8a82; }
  .pay .p-row { border: 1px solid #e3ece9; border-radius: 14px; padding: 12px; margin-top: 10px; }
  .pay .p-row.blocked { border-color: #f5c2c0; background: #fff7f7; }
  .pay .p-top { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; } .pay .p-amt { font-size: 20px; font-weight: 800; white-space: nowrap; }
  .pay dl { display: grid; grid-template-columns: 110px 1fr; gap: 3px 10px; margin: 8px 0 0; } .pay dt { color: #6b8a82; } .pay dd { margin: 0; font-weight: 600; word-break: break-word; }
  .pay .ok { color: #0f7a4f; font-weight: 700; } .pay .warn { color: #92400e; } .pay .bad { color: #b42318; font-weight: 700; }
  .pay .p-check { margin-top: 8px; padding: 7px 9px; border-radius: 10px; font-size: 13px; }
  .pay .p-check.ok { background: #e8f8ef; } .pay .p-check.warn { background: #fef3c7; } .pay .p-check.bad { background: #fde8e8; }
  .pay .p-form { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; } .pay .p-form input { font: inherit; border: 1px solid #d6e2de; border-radius: 9px; padding: 7px 8px; min-width: 0; }
  .pay .p-form .full { grid-column: 1 / -1; }
  .pay .p-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid #e3ece9; }
  .pay .p-foot .sp { flex: 1; }
  .pay button, .pay .pbtn { font: inherit; font-weight: 700; border: 1px solid #d6e2de; background: #fff; border-radius: 10px; padding: 8px 14px; cursor: pointer; color: inherit; text-decoration: none; display: inline-block; white-space: normal; text-align: left; max-width: 100%; }
  .pay .go { background: #10b981; border-color: #10b981; color: #fff; } .pay .go:disabled { opacity: .5; cursor: default; }
  .pay .cp { display: flex; gap: 8px; align-items: center; } .pay .cp span { flex: 1; min-width: 0; }
  .pay .cpb { padding: 3px 10px; font-size: 12px; border-radius: 8px; flex: none; } .pay .cpb.done { background: #e8f8ef; border-color: #a7e3c4; }
  .pay .p-row.paid { border-color: #a7e3c4; background: #f3fbf7; }
  .pay ol { margin: 8px 0 0 18px; padding: 0; } .pay li { margin: 4px 0; }
  @media (max-width: 560px) { .pay dl { grid-template-columns: 1fr; } .pay dt { margin-top: 4px; } .pay .p-form { grid-template-columns: 1fr; } }`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (Number(n) || 0).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
  // the page's session (each page keeps it in its own BOOT, which isn't on window)
  // eslint-disable-next-line no-undef
  const tok = () => { try { return (typeof BOOT !== 'undefined' && BOOT && BOOT.token) || ''; } catch (e) { return ''; } };
  async function call(path, opts = {}) {
    const res = await fetch('/api' + path, { ...opts, headers: { Authorization: 'Bearer ' + tok(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (typeof noteToken === 'function') noteToken(res);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || 'Something went wrong'); e.body = body; e.status = res.status; throw e; }
    return body;
  }
  const acct = (p) => `${esc(p.bsb)} ${esc(p.account_number)}`;

  window.openPay = async function openPay(ids, { onDone } = {}) {
    const bg = document.createElement('div'); bg.className = 'pay-bg';
    bg.innerHTML = '<div class="pay"><div class="muted">Getting the details…</div></div>';
    document.body.appendChild(bg);
    const box = bg.firstChild;
    let data = null; let busy = false; let paid = null;
    const paidNow = new Map(); // invoice id → payment (marked "I've paid it" in this box)
    // copy a detail for pasting into the banking app (works inside ServiceM8's window too)
    async function copy(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
        let ok = false; try { ok = document.execCommand('copy'); } catch (x) { ok = false; } ta.remove(); return ok;
      }
    }
    const cp = (label, value, shown) => `<dt>${label}</dt><dd class="cp"><span>${esc(shown ?? value)}</span><button class="cpb" data-copy="${esc(value)}">Copy</button></dd>`;
    const close = () => { bg.remove(); if (paid && onDone) onDone(); };
    bg.addEventListener('click', (e) => { if (e.target === bg && !busy) close(); });

    async function load() {
      try { data = await call('/pay/preview?ids=' + ids.join(',')); render(); } catch (e) { box.innerHTML = `<div class="bad">${esc(e.message)}</div><div class="p-foot"><span class="sp"></span><button data-x>Close</button></div>`; }
    }
    function checkHtml(p) {
      if (p.check === 'match') return '<div class="p-check ok">✓ Same BSB and account number as printed on the invoice</div>';
      if (p.check === 'mismatch') return `<div class="p-check bad">✗ The invoice says to pay <b>${acct(p.printed)}</b>${p.printed.account_name ? ' (' + esc(p.printed.account_name) + ')' : ''},
        but you've paid ${esc(p.supplier)} to <b>${acct(p.payee)}</b> before.<br>Changed bank details are a common scam. Call ${esc(p.supplier)} on a number you already have (not one on this invoice or email) before changing them.
        <div style="margin-top:6px"><button data-trust="${p.id}">The invoice's details are right – I've checked with ${esc(p.supplier)}</button></div></div>`;
      if (p.check === 'not_printed') return '<div class="p-check warn">⚠ The invoice doesn’t print bank details, so they couldn’t be checked against it</div>';
      return '';
    }
    function rowHtml(p) {
      const needDetails = !p.payee && !p.bpay && p.blocked && /No bank details/.test(p.blocked);
      return `<div class="p-row ${p.blocked ? 'blocked' : ''}">
        <div class="p-top"><div><b>${esc(p.supplier || 'Unknown supplier')}</b><div class="muted">Invoice ${esc(p.invoice_number || '(no number)')}${p.jobs.length ? ' · job #' + p.jobs.map(esc).join(', #') : ''}${p.due_date ? ' · due ' + esc(p.due_date.split('-').reverse().join('/')) : ''}</div></div>
          <div class="p-amt">${money(p.amount)}</div></div>
        ${p.payee && data.mode === 'manual' && !p.blocked ? `<dl>${cp('Account name', p.payee.account_name || p.supplier || '')}${cp('BSB', String(p.payee.bsb).replace('-', ''), p.payee.bsb)}${cp('Account', p.payee.account_number)}
          ${cp('Amount', (p.amount_cents / 100).toFixed(2), money(p.amount))}${cp('Reference', p.reference)}${data.payer.remitter ? cp('From', data.payer.remitter) : ''}</dl>`
          : p.payee ? `<dl><dt>Pay to</dt><dd>${esc(p.payee.account_name || p.supplier)}</dd><dt>BSB / account</dt><dd>${acct(p.payee)}</dd><dt>Reference</dt><dd>${esc(p.reference)}</dd>
          <dt>From</dt><dd>${esc(data.payer.remitter || '')}</dd></dl>` : ''}
        ${p.payee || p.printed ? checkHtml(p) : ''}
        ${p.blocked && !(p.check === 'mismatch') ? `<div class="p-check bad">Not paid: ${esc(p.blocked)}</div>` : ''}
        ${p.bpay && !p.payee ? `<div class="muted" style="margin-top:6px">BPAY biller ${esc(p.bpay.biller)}${p.bpay.ref ? ', ref ' + esc(p.bpay.ref) : ''}</div>` : ''}
        ${needDetails ? `<div class="p-form" data-form="${p.id}"><input name="bsb" placeholder="BSB" inputmode="numeric"><input name="account_number" placeholder="Account number" inputmode="numeric">
          <input class="full" name="account_name" placeholder="Account name" value="${esc(p.supplier || '')}"><button class="full" data-save-payee="${p.id}">Save ${esc(p.supplier || '')}'s bank details</button></div>
          <div class="muted" style="font-size:12px;margin-top:4px">Take them from a statement or a call to the supplier – they're checked against every invoice from them after this.</div>` : ''}
        ${p.warnings.filter((w) => !/couldn.t be checked/.test(w)).map((w) => `<div class="warn" style="margin-top:6px;font-size:13px">⚠ ${esc(w)}</div>`).join('')}
        ${data.mode === 'manual' && !p.blocked ? `<div style="margin-top:10px;display:flex;justify-content:flex-end"><button class="go" data-paid-one="${p.id}">✓ I've paid it</button></div>` : ''}
      </div>`;
    }
    const EMAIL = { done: (i) => `✓ email moved to ${esc(i.email_note || '')}`, waiting: () => 'filing the email…', not_found: (i) => `⚠ ${esc(i.email_note || 'email not found')}`, needs_reconnect: (i) => `⚠ ${esc(i.email_note)}`,
      no_email: () => 'no email to file', no_mailbox: (i) => esc(i.email_note || 'no mailbox connected'), off: () => 'email left as it is', error: (i) => `⚠ email: ${esc(i.email_note || 'couldn\u2019t file it')}` };
    function paidRowHtml(p, pay) {
      const it = (pay.items || []).find((i) => i.invoice_id === p.id) || {};
      return `<div class="p-row paid"><div class="p-top"><div><b>✓ ${esc(p.supplier || '')}</b><div class="muted">Invoice ${esc(p.invoice_number || '')} · marked paid in Job Costs · ${(EMAIL[it.email_status] || EMAIL.waiting)(it)}</div></div>
        <div class="p-amt">${money(p.amount)}</div></div>
        <div style="margin-top:6px"><button data-undo-one="${pay.id}" data-inv="${p.id}">↶ Undo – not paid</button></div></div>`;
    }
    function renderManual() {
      const open = data.plans.filter((p) => !p.blocked && !paidNow.has(p.id));
      box.innerHTML = `<h3>💳 Pay ${data.plans.length === 1 ? 'this invoice' : data.plans.length + ' invoices'}</h3>
        <div class="muted">Check the details, pay ${data.plans.length === 1 ? 'it' : 'each one'} in your own banking app (Copy fills each box), then press <b>✓ I've paid it</b>.
          Job Costs never connects to your bank.</div>
        ${data.plans.map((p) => (paidNow.has(p.id) ? paidRowHtml(p, paidNow.get(p.id)) : rowHtml(p))).join('')}
        ${data.moveEmail ? `<div style="margin-top:10px;font-size:13px" class="muted">When you press ✓ I've paid it: marked paid in Job Costs, and the invoice email is marked read and moved to <b>${esc(data.folder)} / <i>supplier</i></b>.</div>` : ''}
        <div class="p-foot"><b>${open.length ? `${open.length} to pay · ${money(open.reduce((s, p) => s + p.amount_cents, 0) / 100)}` : paidNow.size ? '✓ All done' : 'Nothing can be paid yet'}</b><span class="sp"></span>
          ${open.length > 1 ? `<button data-paid-all>✓ I've paid all ${open.length}</button>` : ''}<button ${paidNow.size && !open.length ? 'class="go"' : ''} data-x>${paidNow.size ? 'Done' : 'Close'}</button></div>`;
      const waiting = [...paidNow.values()].some((pay) => (pay.items || []).some((i) => i.email_status === 'waiting'));
      if (waiting) setTimeout(async () => {
        if (!bg.isConnected) return;
        for (const [id, pay] of paidNow) { try { paidNow.set(id, await call('/pay/' + pay.id)); } catch (e) { /* fine */ } }
        renderManual();
      }, 1500);
    }
    // each invoice on its own, so "Undo" on one leaves the others paid
    async function markPaid(plans) {
      for (const p of plans) {
        const confirm = { [p.id]: { amount_cents: p.amount_cents, bsb: p.payee.bsb, account_number: p.payee.account_number } };
        const r = await call('/pay', { method: 'POST', body: JSON.stringify({ ids: [p.id], confirm }) });
        paidNow.set(p.id, await call('/pay/' + r.id));
        paid = r.id;
      }
      renderManual();
    }
    function render() {
      if (data.mode === 'manual') return renderManual();
      const payer = data.payer; const ok = data.plans.filter((p) => !p.blocked);
      const missing = payer.missing.length;
      box.innerHTML = `<h3>💳 Pay ${data.plans.length === 1 ? 'this invoice' : data.plans.length + ' invoices'}</h3>
        <div class="muted">Check every line. The amount is the invoice total. Nothing is sent until you upload the file at ${esc(payer.bankName || 'your bank')} and approve it there.</div>
        ${missing ? `<div class="p-check bad" style="margin-top:10px">Fill in ${esc(payer.missing.join(', '))} in <a href="/settings?t=${encodeURIComponent(tok())}" target="_blank" rel="noopener">⚙ Settings → Paying suppliers</a> first.</div>` : ''}
        ${data.plans.map(rowHtml).join('')}
        ${ok.length ? `<div style="margin-top:10px;font-size:13px">From <b>${esc(payer.name || '')}</b> ${esc(payer.bsb || '')} ${esc(payer.account || '')}${data.moveEmail ? ` · each email is marked read and moved to <b>${esc(data.folder)} / <i>supplier</i></b>` : ''} · marked paid in Job Costs</div>` : ''}
        <div class="p-foot"><b>${ok.length ? `${ok.length} payment${ok.length === 1 ? '' : 's'} · ${money(data.total)}` : 'Nothing can be paid yet'}</b><span class="sp"></span>
          <button data-x>Cancel</button><button class="go" data-go ${!ok.length || missing ? 'disabled' : ''}>✓ Confirm and make the payment file</button></div>`;
    }
    function doneHtml(p) {
      const stat = { done: (i) => `✓ moved to ${esc(i.email_note || '')}`, waiting: () => 'filing…', not_found: (i) => `⚠ ${esc(i.email_note || 'email not found')}`, needs_reconnect: (i) => `⚠ ${esc(i.email_note)}`,
        no_email: () => 'no email to file', no_mailbox: (i) => esc(i.email_note || 'no mailbox connected'), off: () => 'email left as it is', error: (i) => `⚠ ${esc(i.email_note || 'couldn’t file it')}` };
      box.innerHTML = `<h3>✅ Payment file ready – ${money(p.total_cents / 100)}</h3>
        <div class="muted">${p.count} payment${p.count === 1 ? '' : 's'}, marked paid in Job Costs.</div>
        <ol><li><a class="pbtn go" href="/api/pay/${p.id}/file?t=${encodeURIComponent(tok())}" download>⬇ Download the bank file</a></li>
          <li>Open ${esc(data.payer.bankName || 'your bank')}'s business online banking → import a payment file, choose it, check the total is <b>${money(p.total_cents / 100)}</b>, and approve it.</li></ol>
        <div style="margin-top:10px">${p.items.map((i) => `<div style="margin-top:4px;font-size:13px"><b>${esc(i.supplier || '')}</b> ${esc(i.invoice_number || '')} · ${money(i.amount_cents / 100)} · <span class="muted">email: ${(stat[i.email_status] || stat.waiting)(i)}</span></div>`).join('')}</div>
        <div class="p-foot"><button data-undo="${p.id}" title="Didn't use the file: back to unpaid">↶ Didn't use it – undo</button><span class="sp"></span><button class="go" data-x>Done</button></div>`;
      if (p.items.some((i) => i.email_status === 'waiting')) setTimeout(async () => { if (!bg.isConnected) return; try { doneHtml(await call('/pay/' + p.id)); } catch (e) { /* fine */ } }, 1500);
    }
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const d = b.dataset;
      try {
        if (d.x !== undefined) return close();
        if (d.copy !== undefined) { const ok = await copy(d.copy); b.textContent = ok ? '✓ Copied' : 'Select it'; b.classList.toggle('done', ok); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500); return; }
        if (d.paidOne) {
          const p = data.plans.find((x) => String(x.id) === d.paidOne);
          if (!d.sure) { d.sure = '1'; b.textContent = `Sure? ${money(p.amount)} to ${p.payee.bsb} ${p.payee.account_number} is paid`; return; }
          b.disabled = true; return markPaid([p]);
        }
        if (d.paidAll !== undefined) {
          const open = data.plans.filter((p) => !p.blocked && !paidNow.has(p.id));
          if (!d.sure) { d.sure = '1'; b.textContent = `Sure? All ${open.length} paid (${money(open.reduce((s, p) => s + p.amount_cents, 0) / 100)})`; return; }
          b.disabled = true; return markPaid(open);
        }
        if (d.undoOne) {
          if (!d.sure) { d.sure = '1'; b.textContent = 'Sure? Mark it unpaid again'; return; }
          await call(`/pay/${d.undoOne}/cancel`, { method: 'POST' });
          for (const [id, pay] of [...paidNow]) if (String(pay.id) === d.undoOne) paidNow.delete(id);
          return load();
        }
        if (d.savePayee) {
          const f = box.querySelector(`[data-form="${d.savePayee}"]`);
          const v = (n) => f.querySelector(`[name=${n}]`).value;
          await call('/pay/payee', { method: 'PUT', body: JSON.stringify({ invoice_id: Number(d.savePayee), bsb: v('bsb'), account_number: v('account_number'), account_name: v('account_name') }) });
          return load();
        }
        if (d.trust) {
          const p = data.plans.find((x) => String(x.id) === d.trust);
          if (!d.sure) { d.sure = '1'; b.textContent = `Sure? From now on ${p.supplier} is paid to ${p.printed.bsb} ${p.printed.account_number}`; return; }
          await call('/pay/payee', { method: 'PUT', body: JSON.stringify({ invoice_id: p.id, bsb: p.printed.bsb, account_number: p.printed.account_number, account_name: p.printed.account_name || p.supplier, confirm_change: true }) });
          return load();
        }
        if (d.go !== undefined) {
          const ok = data.plans.filter((p) => !p.blocked);
          busy = true; b.disabled = true; b.textContent = 'Making the file…';
          const confirm = Object.fromEntries(ok.map((p) => [p.id, { amount_cents: p.amount_cents, bsb: p.payee.bsb, account_number: p.payee.account_number }]));
          const r = await call('/pay', { method: 'POST', body: JSON.stringify({ ids: ok.map((p) => p.id), confirm }) });
          paid = r.id; busy = false;
          return doneHtml(await call('/pay/' + r.id));
        }
        if (d.undo) {
          if (!d.sure) { d.sure = '1'; b.textContent = 'Sure? Mark them unpaid again'; return; }
          await call(`/pay/${d.undo}/cancel`, { method: 'POST' });
          paid = paid || true; return close();
        }
      } catch (x) {
        busy = false;
        const t = document.createElement('div'); t.className = 'p-check bad'; t.textContent = x.message; box.appendChild(t);
        if (x.body && x.body.changed) load(); else if (d.go !== undefined) { b.disabled = false; b.textContent = '✓ Confirm and make the payment file'; }
      }
    });
    load();
  };
})();
