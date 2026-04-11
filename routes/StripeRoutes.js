require('dotenv').config();
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const BitcoinPurchase = require('../models/BitcoinPurchase');
const Big = require('big.js');

let stripeClient = null;

function getStripeClient() {
  if (!process.env.stripe_testing_secret) {
    return null;
  }

  if (!stripeClient) {
    stripeClient = Stripe(process.env.stripe_testing_secret);
  }

  return stripeClient;
}

/**
 * Convert a decimal USD amount string (e.g. "10.00") to integer cents (e.g. 1000).
 * Avoids float precision issues.
 */
function usdToCents(amountStr) {
  return Number(Big(amountStr).times(100).round(0, Big.roundHalfUp));
}

// ------------------------------------------------------
//  POST /onRamp_purchases (Stripe Onramp Webhook)
// ------------------------------------------------------
router.post('/onRamp_purchases', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  const stripe = getStripeClient();

  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Missing Stripe configuration');
  }

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe webhook signature verify failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  // Only handle the event type you're actually receiving
  if (event.type !== 'crypto.onramp_session.updated') {
    return res.json({ received: true });
  }

  try {
    const session = event.data?.object;

    if (!session || session.status !== 'fulfillment_complete') {
      return res.json({ received: true });
    }

    const walletPubkey = session.metadata?.wallet_pubkey;

    const td = session.transaction_details || {};
    const txid = td.transaction_id;

    if (!walletPubkey || !txid) {
      console.error('❌ Missing walletPubkey or txid', {
        sessionId: session?.id,
        status: session?.status,
        walletPubkey: walletPubkey ?? null,
        txid: txid ?? null,
        metadata: session?.metadata,
      });
      return res.json({ received: true });
    }

    const sourceCurrency = String(td.source_currency || '').toLowerCase();
    const sourceAmountStr = td.source_amount; // e.g. "10.00" (string)

    if (sourceCurrency !== 'usd' || typeof sourceAmountStr !== 'string') {
      console.error('❌ Missing/invalid source amount on session', {
        sessionId: session?.id,
        sourceCurrency: td.source_currency ?? null,
        sourceAmount: td.source_amount ?? null,
      });
      return res.json({ received: true });
    }

    let spendAmountCents;
    try {
      spendAmountCents = usdToCents(sourceAmountStr);
    } catch (parseErr) {
      console.error('❌ Failed to parse source_amount', {
        sessionId: session?.id,
        sourceAmountStr,
        error: String(parseErr?.message || parseErr),
      });
      return res.json({ received: true });
    }

    const rewardAmountCents = Math.floor(spendAmountCents * 0.1);

    try {
      await BitcoinPurchase.create({ walletPubkey, txid, spendAmountCents, rewardAmountCents });
      console.log('✅ Stored fulfilled onramp purchase', { walletPubkey, txid, spendAmountCents });
    } catch (dbErr) {
      if (dbErr && dbErr.code === 11000) {
        console.log('ℹ️ Duplicate txid, already stored', { txid });
      } else {
        console.error('❌ DB error storing BitcoinPurchase', dbErr);
        return res.status(500).send('DB error');
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Webhook handler failed:', err);
    return res.status(500).send('Webhook handler failed');
  }
});

module.exports = router;
