require('dotenv').config();
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const Stripe = require('stripe');
const { PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const secretKey = (process.env.secretKey);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const s3Client = require('../integrations/r2');
const User = require('../models/User');
const MerchantPubKey = require('../models/MerchantPubKey');
const PlatformAnalytics = require('../models/PlatformAnalytics');
const PlatformWallet = require('../models/PlatformWallet');
const RewardSpend = require('../models/RewardSpend');
const BitcoinPurchase = require('../models/BitcoinPurchase');
const MoonPayPurchase = require('../models/MoonPayPurchase');
const userAuthMiddleware = require('../middlewares/userAuthMiddleware');
const userRewardSpendFunction = require('../rewards/userRewardSpendFunction');
const sessionHelper = require('../auth/sessionHelper');
const {
  buildMoonPayReturnUrl,
  chooseSingleMoonPayRewardMatch,
  createMoonPayStateToken,
  verifyMoonPayStateToken,
} = require('../payments/moonPayHelpers');
const breezApiKey = process.env.BREEZ_API_KEY;
const upload = multer({
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

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

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function formatUsdCents(amountCents) {
  const dollars = Number(amountCents || 0) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

function getExternalBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const host = forwardedHost || req.get('host');

  if (!host) {
    throw new Error('Unable to determine public host for MoonPay redirect URL');
  }

  return `${protocol}://${host}`;
}

router.get('/rewards-version-check', async (req, res) => {
  try {
      const requestedPlatform = String(req.query.platform || '').trim().toLowerCase();

      // Keep missing platform mapped to iOS so already-released iOS builds
      // continue receiving the correct minimum version until they start
      // sending platform=ios explicitly.
      const minimumVersion = requestedPlatform === 'android'
        ? "0.1.1"
        : "3.6.1";

      return res.status(200).json({ minimumVersion });
  } catch (error) {
      console.error("Version check error:", error);
      return res.status(500).json({ error: "Server error" });
  }
});

router.get('/breez-api-key', async (req, res) => {
  try {
      if (!breezApiKey) {
          console.error("Missing BREEZ_API_KEY in environment");
          return res.status(500).json({ error: "Server misconfiguration" });
      }

      return res.status(200).json({ apiKey: breezApiKey });
  } catch (error) {
      console.error("Breez API key route error:", error);
      return res.status(500).json({ error: "Server error" });
  }
});

// ------------------------------------------------------
//  POST /auth/nonce
//  Returns a short-lived nonce + canonical messageToSign.
// ------------------------------------------------------
router.post('/auth/nonce', async (req, res) => {
  try {
    // domain separation helps prevent signatures being reused elsewhere
    const domain = process.env.WALLET_AUTH_DOMAIN || 'example.invalid';

    const { nonce, expiresAt, messageToSign } = sessionHelper.issueNonce({ domain });

    return res.status(200).json({ nonce, expiresAt, messageToSign });
  } catch (error) {
    console.error('Error generating nonce:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ------------------------------------------------------
//  POST /auth/wallet-login
//  Verifies signature over server-canonical messageToSign,
//  then consumes nonce (single-use).
//  Also receives sparkAddress and stores it on the user.
// ------------------------------------------------------
router.post('/auth/wallet-login', async (req, res) => {
  try {
    const { pubkey, nonce, signature, iat, sparkAddress } = req.body || {};

    // 🔎 DEBUG: log what actually arrived over the wire (no base64 guessing)
    const sigStr = String(signature ?? '');
    const sigTrim = sigStr.trim();
    const sigBuf = sessionHelper.decodeHexStrict ? sessionHelper.decodeHexStrict(sigTrim) : null;

    const errors = [];
    if (!pubkey || typeof pubkey !== 'string') errors.push('pubkey is required');
    if (!nonce || typeof nonce !== 'string') errors.push('nonce is required');
    if (!signature || typeof signature !== 'string') errors.push('signature is required');
    if (iat !== undefined && iat !== null && Number.isNaN(Number(iat))) errors.push('iat must be a number if provided');

    // sparkAddress is required in your new flow (since iOS now always fetches it).
    // If you want a gradual rollout, change this to optional.
    if (!sparkAddress || typeof sparkAddress !== 'string') errors.push('sparkAddress is required');

    // Minimal sanity check — avoids storing obviously bogus values.
    // Keep this loose to avoid false negatives across prefixes/networks.
    if (typeof sparkAddress === 'string') {
      const addr = sparkAddress.trim();
      if (addr.length < 10 || addr.length > 200) errors.push('sparkAddress looks invalid');
      // Optional: basic bech32-ish shape (lowercase + "1" separator)
      // Comment out if you want absolutely no constraints.
      if (!/[a-z0-9]+1[a-z0-9]+/.test(addr)) errors.push('sparkAddress format is invalid');
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const sparkAddrTrim = String(sparkAddress).trim();

    // ✅ Check nonce without consuming it yet
    const nonceRecord = sessionHelper.peekNonce(nonce);
    if (!nonceRecord) {
      return res.status(401).json({ error: 'Invalid or expired nonce' });
    }

    const { messageToSign } = nonceRecord;

    // ✅ Verify signature over the canonical server message
    let isValid = false;
    try {
      isValid = sessionHelper.verifyBreezSignedMessage({
        message: messageToSign,
        pubkey,
        signature,
      });
    } catch (e) {
      console.error('Signature verify error:', e);
      return res.status(500).json({
        error: 'Signature verification unavailable',
        details: String(e.message || e),
      });
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ✅ Consume nonce only after successful verification
    sessionHelper.consumeNonce(nonce);

    // ✅ Find or create user, and backfill sparkAddress if missing
    let user = await User.findOne({ walletPubkey: pubkey });

    if (!user) {
      user = await User.create({
        walletPubkey: pubkey,     // ✅ required field satisfied
        sparkAddress: sparkAddrTrim,
      });
      console.log('New Wallet Linked');
    } else if (!user.sparkAddress) {
      // Only set if missing (do not overwrite existing)
      user.sparkAddress = sparkAddrTrim;
      await user.save();
    } else if (user.sparkAddress !== sparkAddrTrim) {
      // Skeptical safety: log divergence so you can investigate.
      // You might later decide to reject, rotate, or allow updates.
      console.warn('sparkAddress mismatch for pubkey:', pubkey, {
        existing: user.sparkAddress,
        incoming: sparkAddrTrim,
      });
    }

    // Mint 1-hour JWT cookie
    const token = jwt.sign(
      { userId: String(user._id), pubkey: pubkey },
      secretKey,
      { expiresIn: '1h' }
    );

    res.cookie('jwtToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000,
    });

    return res.status(200).json({
      ok: true,
      userId: String(user._id),
      pubkey: pubkey,
    });
  } catch (error) {
    console.error('Error in wallet-login:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ------------------------------------------------------
//  GET /session
// ------------------------------------------------------
router.get('/session', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select('_id walletPubkey');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      ok: true,
      userId: String(user._id),
      pubkey: user.walletPubkey,
    });
  } catch (error) {
    console.error('Error checking session:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/Profile_Pic', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select('_id profilePicUrl');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      profilePicUrl: user.profilePicUrl || null,
    });
  } catch (error) {
    console.error('Error fetching profile picture:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/Upload_Profile_Pic', userAuthMiddleware, upload.single('profilePic'), async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'profilePic file is required' });
    }

    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'profilePic must be an image file' });
    }

    if (user.profilePicUrl) {
      const previousKey = user.profilePicUrl.split('?')[0].split('/').pop();

      if (previousKey) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: previousKey,
          }));
        } catch (deleteErr) {
          console.warn('Failed to delete previous profile picture:', deleteErr.message);
        }
      }
    }

    const fileName = `${crypto.randomUUID()}.png`;

    const resizedBuffer = await sharp(file.buffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .png()
      .toBuffer();

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: resizedBuffer,
      ContentType: 'image/png',
      ACL: 'public-read',
    }));

    const publicCdnBaseUrl = process.env.PUBLIC_CDN_BASE_URL || 'https://cdn.example.invalid';
    const publicUrl = `${publicCdnBaseUrl}/${fileName}`;
    user.profilePicUrl = publicUrl;
    await user.save();

    return res.status(200).json({
      ok: true,
      profilePicUrl: user.profilePicUrl,
    });
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/lightning-address', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { lightningAddress } = req.body || {};

    if (!lightningAddress || typeof lightningAddress !== 'string') {
      return res.status(400).json({ error: 'lightningAddress is required' });
    }

    const trimmedLightningAddress = lightningAddress.trim().toLowerCase();

    if (trimmedLightningAddress.length < 3 || trimmedLightningAddress.length > 320) {
      return res.status(400).json({ error: 'lightningAddress looks invalid' });
    }

    // basic sanity check for user@domain format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedLightningAddress)) {
      return res.status(400).json({ error: 'lightningAddress format is invalid' });
    }

    const user = await User.findById(userId).select('_id lightningAddress');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // no-op if already set
    if (user.lightningAddress) {
      return res.status(200).json({
        ok: true,
        didUpdate: false,
        lightningAddress: user.lightningAddress,
      });
    }

    user.lightningAddress = trimmedLightningAddress;
    await user.save();

    return res.status(200).json({
      ok: true,
      didUpdate: true,
      lightningAddress: user.lightningAddress,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'lightningAddress already exists on another user' });
    }

    console.error('Error saving lightningAddress:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/LogRewardSpend', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // Basic auth guard: user from JWT must exist
    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      direction,
      usdAmountCents,
      btcAmountSats,
      destinationPubkey,
      network,
      status,
    } = req.body || {};

    // ---- Basic validation (only what reward spend needs) ----
    const errors = [];

    if (!direction || !['sent', 'received'].includes(direction)) {
      errors.push('direction must be "sent" or "received"');
    }

    if (
      usdAmountCents === undefined ||
      usdAmountCents === null ||
      Number.isNaN(Number(usdAmountCents))
    ) {
      errors.push('usdAmountCents is required and must be a number');
    }

    if (
      btcAmountSats === undefined ||
      btcAmountSats === null ||
      Number.isNaN(Number(btcAmountSats))
    ) {
      errors.push('btcAmountSats is required and must be a number');
    }

    if (!network || !['lightning', 'onchain', 'swap'].includes(network)) {
      errors.push('network must be "lightning", "onchain", or "swap"');
    }

    const finalStatus = status || 'Completed';
    if (!['Pending', 'Completed', 'Failed'].includes(finalStatus)) {
      errors.push('status must be "Pending", "Completed", or "Failed"');
    }

    if (
      destinationPubkey !== undefined &&
      destinationPubkey !== null &&
      typeof destinationPubkey !== 'string'
    ) {
      errors.push('destinationPubkey must be a string if provided');
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const usdAmountCentsNum = Number(usdAmountCents);
    const btcAmountSatsNum = Number(btcAmountSats);

    if (!Number.isFinite(usdAmountCentsNum) || usdAmountCentsNum <= 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: ['usdAmountCents must be a positive number'],
      });
    }

    if (!Number.isInteger(btcAmountSatsNum) || btcAmountSatsNum <= 0) {
      return res.status(400).json({
        error: 'Invalid request',
        details: ['btcAmountSats must be a positive integer (sats)'],
      });
    }

    // Only apply reward spend when status is Completed.
    if (finalStatus === 'Completed') {
      await userRewardSpendFunction({
        User,
        RewardSpend, // ✅ NEW: monthly per-user spend + tx count
        MerchantPubKey,
        PlatformAnalytics,
        userId,
        usdAmountCentsNum,
        btcAmountSatsNum,
        destinationPubkey: destinationPubkey || null,
        network,
        direction,
        finalStatus,
      });
    }

    return res.status(200).json({
      ok: true,
      rewardSpendApplied: finalStatus === 'Completed',
    });
  } catch (error) {
    console.error('Error logging reward spend:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/ReportMerchantPubkey', userAuthMiddleware, async (req, res) => {
  try {
    const {
      merchantName,
      merchantAddress,
      destinationPubkey,
      transactionId,
      amountSats,
      status,
      network,
      method,
      note,
      transactionDate,
    } = req.body || {};

    const trimmedMerchantName = String(merchantName || '').trim();
    const trimmedMerchantAddress = String(merchantAddress || '').trim();
    const trimmedDestinationPubkey = String(destinationPubkey || '').trim();

    if (!trimmedMerchantName || !trimmedMerchantAddress || !trimmedDestinationPubkey) {
      return res.status(400).json({
        ok: false,
        error: 'merchantName, merchantAddress, and destinationPubkey are required',
      });
    }

    const reporter = await User.findById(req.userId)
      .select('lightningAddress pubkey')
      .lean();
    const merchantPubkeyMatch = await MerchantPubKey.findOne({ pubkey: trimmedDestinationPubkey })
      .select('_id')
      .lean();

    console.log('=== MERCHANT PUBKEY REPORT START ===');
    console.log(
      JSON.stringify(
        {
          reportedAt: new Date().toISOString(),
          reporterUserId: req.userId,
          reporterWalletPubkey: req.pubkey || reporter?.pubkey || null,
          reporterLightningAddress: reporter?.lightningAddress || null,
          merchantName: trimmedMerchantName,
          merchantAddress: trimmedMerchantAddress,
          destinationPubkey: trimmedDestinationPubkey,
          merchantPubkeyDatabaseMatch: merchantPubkeyMatch ? 'positive' : 'negative',
          transactionId: transactionId || null,
          amountSats: amountSats ?? null,
          status: status || null,
          network: network || null,
          method: method || null,
          note: note || null,
          transactionDate: transactionDate || null,
        },
        null,
        2
      )
    );
    console.log('=== MERCHANT PUBKEY REPORT END ===');

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Merchant pubkey report error:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /RewardStats
router.get('/v1/RewardStats', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // Auth guard: ensure user from JWT exists
    const user = await User.findById(userId).select('_id');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Current monthKey in UTC (YYYY-MM)
    const monthKey = new Date().toISOString().slice(0, 7);

    // -----------------------------
    // 1) Fetch monthly pot (platform wallet balance) FROM DB
    // -----------------------------
    const platformWallet = await PlatformWallet.findOne({})
      .select('balanceSats')
      .lean();

    if (!platformWallet) {
      return res.status(500).json({ error: 'PlatformWallet not found' });
    }

    const potSats = Number(platformWallet.balanceSats ?? 0);

    if (!Number.isInteger(potSats) || potSats < 0) {
      return res.status(500).json({
        error: 'Invalid PlatformWallet.balanceSats in database',
        details: { balanceSats: platformWallet.balanceSats },
      });
    }

    // -----------------------------
    // 2) Platform totals for month
    //    rewardSpendCents = merchantSpend + purchaseSpend
    // -----------------------------
    const platformAgg = await RewardSpend.aggregate([
      { $match: { monthKey } },
      {
        $group: {
          _id: '$monthKey',
          merchantSpendCents: { $sum: '$merchantSpend' },
          purchaseSpendCents: { $sum: '$purchaseSpend' },
          transactions: { $sum: '$transactions' }, // merchant tx only
        },
      },
    ]);

    const platformMerchantSpendCents = Number(platformAgg?.[0]?.merchantSpendCents ?? 0);
    const platformPurchaseSpendCents = Number(platformAgg?.[0]?.purchaseSpendCents ?? 0);
    const platformRewardSpendCents = platformMerchantSpendCents + platformPurchaseSpendCents;
    const platformTransactions = Number(platformAgg?.[0]?.transactions ?? 0);

    // -----------------------------
    // 3) User totals for month
    //    rewardSpendCents = merchantSpend + purchaseSpend
    // -----------------------------
    const userDoc = await RewardSpend.findOne({ monthKey, userId })
      .select('merchantSpend purchaseSpend transactions')
      .lean();

    const userMerchantSpendCents = Number(userDoc?.merchantSpend ?? 0);
    const userPurchaseSpendCents = Number(userDoc?.purchaseSpend ?? 0);
    const userRewardSpendCents = userMerchantSpendCents + userPurchaseSpendCents;
    const userTransactions = Number(userDoc?.transactions ?? 0);

    // -----------------------------
    // 4) Share % + projected earnings (no rank)
    //    Use rewardSpendCents (merchantSpend + purchaseSpend)
    // -----------------------------
    let shareBps = 0; // basis points: 100 = 1.00%
    let projectedEarningsSats = 0;

    if (platformRewardSpendCents > 0 && userRewardSpendCents > 0) {
      // Share in basis points (floored)
      shareBps = Math.floor((userRewardSpendCents * 10000) / platformRewardSpendCents);

      // Projected earnings sats using integer math (floored)
      const pot = BigInt(potSats);
      const userSpend = BigInt(userRewardSpendCents);
      const platformSpend = BigInt(platformRewardSpendCents);

      projectedEarningsSats = Number((pot * userSpend) / platformSpend);
    } else {
      shareBps = 0;
      projectedEarningsSats = 0;
    }

    // -----------------------------
    // 5) Lifetime earnings (PAID ONLY)
    //    Sum final.rewardSats where final.paid === true
    // -----------------------------
    const lifetimeAgg = await RewardSpend.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          'final.paid': true,
        },
      },
      {
        $group: {
          _id: null,
          lifetimeEarningsSats: { $sum: '$final.rewardSats' },
        },
      },
    ]);

    const lifetimeEarningsSats = Number(lifetimeAgg?.[0]?.lifetimeEarningsSats ?? 0);

    return res.status(200).json({
      monthKey,
      monthlyPot: { sats: potSats },
      platform: {
        rewardSpendCents: platformRewardSpendCents,
        transactions: platformTransactions,
      },
      user: {
        rewardSpendCents: userRewardSpendCents,
        transactions: userTransactions,
      },
      stats: {
        shareBps,
        projectedEarningsSats,
        lifetimeEarningsSats, // NEW
      },
    });
  } catch (err) {
    console.error('Error in /RewardStats:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /BuyRamp
// Creates a Stripe crypto onramp session and returns the hosted redirect_url
router.post('/BuyRamp', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select('_id walletPubkey');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!user.walletPubkey) return res.status(400).json({ error: 'Missing wallet pubkey for user' });

    const { btcAddress } = req.body || {};
    if (!btcAddress || typeof btcAddress !== 'string') {
      return res.status(400).json({ error: 'btcAddress is required' });
    }

    if (!process.env.stripe_testing_secret) {
      return res.status(500).json({ error: 'Missing stripe_testing_secret env var' });
    }

    // Stripe requires application/x-www-form-urlencoded for many API endpoints
    const params = new URLSearchParams();
    params.append('source_currency', 'usd');
    params.append('destination_currencies[]', 'btc');
    params.append('destination_networks[]', 'bitcoin');

    // Wallet address mapping for the destination network
    params.append('wallet_addresses[bitcoin]', btcAddress);
    params.append('lock_wallet_address', 'true');

    // Optional metadata
    params.append('metadata[user_id]', String(userId));
    params.append('metadata[wallet_pubkey]', String(user.walletPubkey));

    const resp = await fetch('https://api.stripe.com/v1/crypto/onramp_sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.stripe_testing_secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await resp.json();

    if (!resp.ok) {
      // Stripe errors are usually { error: { message, type, code, param } }
      return res.status(500).json({
        error: data?.error?.message || 'Stripe error',
        type: data?.error?.type,
        code: data?.error?.code,
        param: data?.error?.param,
      });
    }

    return res.status(200).json({
      onrampSessionId: data.id ?? null,
      redirectUrl: data.redirect_url ?? null,   // <- hosted flow uses this
      status: data.status ?? null,
    });
  } catch (err) {
    console.error('BuyRamp error:', err);
    return res.status(500).json({ error: err?.message || 'Internal Server Error' });
  }
});

router.post('/moonpay/prepare-buy', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const lockedAmountSats = parsePositiveInteger(req.body?.lockedAmountSats);
    const estimatedSpendAmountCents = parsePositiveInteger(req.body?.estimatedSpendAmountCents);

    if (!lockedAmountSats) {
      return res.status(400).json({ error: 'lockedAmountSats is required' });
    }

    if (!estimatedSpendAmountCents) {
      return res.status(400).json({ error: 'estimatedSpendAmountCents is required' });
    }

    const user = await User.findById(userId).select('_id walletPubkey');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!user.walletPubkey) return res.status(400).json({ error: 'Missing wallet pubkey for user' });

    const { token, expiresAtMs } = createMoonPayStateToken({
      walletPubkey: String(user.walletPubkey),
      lockedAmountSats,
      estimatedSpendAmountCents,
    });

    const redirectUrl = buildMoonPayReturnUrl({
      baseUrl: getExternalBaseUrl(req),
      stateToken: token,
    });

    return res.status(200).json({
      redirectUrl,
      lockedAmountSats,
      estimatedSpendAmountCents,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  } catch (error) {
    console.error('moonpay/prepare-buy error:', error);
    return res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
});

router.get('/moonpay-return', async (req, res) => {
  try {
    const stateToken = String(req.query.state || '');
    const moonpayTransactionId = String(req.query.transactionId || '').trim();
    const transactionStatus = String(req.query.transactionStatus || 'pending').trim().toLowerCase() || 'pending';

    const verifiedState = verifyMoonPayStateToken(stateToken);
    if (!verifiedState) {
      return res.status(400).json({
        ok: false,
        didLogPurchase: false,
        errorMessage: 'This MoonPay return link is invalid or has expired.',
        estimatedUsdAmount: null,
        lockedAmountSats: null,
        moonpayTransactionId: null,
        transactionStatus: null,
      });
    }

    let didLogPurchase = false;
    let errorMessage = null;

    if (!moonpayTransactionId) {
      errorMessage = 'MoonPay did not return a transaction ID for this purchase.';
    } else {
      const rewardAmountCents = Math.floor(verifiedState.estimatedSpendAmountCents * 0.1);

      await MoonPayPurchase.findOneAndUpdate(
        { moonpayTransactionId },
        {
          $setOnInsert: {
            walletPubkey: verifiedState.walletPubkey,
            lockedAmountSats: verifiedState.lockedAmountSats,
            estimatedSpendAmountCents: verifiedState.estimatedSpendAmountCents,
            rewardAmountCents,
          },
          $set: {
            transactionStatus,
          },
        },
        { upsert: true, new: true }
      );

      didLogPurchase = true;
    }

    return res.status(didLogPurchase ? 200 : 400).json({
      ok: didLogPurchase,
      didLogPurchase,
      errorMessage,
      estimatedUsdAmount: formatUsdCents(verifiedState.estimatedSpendAmountCents),
      lockedAmountSats: verifiedState.lockedAmountSats,
      moonpayTransactionId: moonpayTransactionId || null,
      transactionStatus,
    });
  } catch (error) {
    console.error('moonpay-return error:', error);
    return res.status(500).json({
      ok: false,
      didLogPurchase: false,
      errorMessage: 'Something went wrong while processing your MoonPay return.',
      estimatedUsdAmount: null,
      lockedAmountSats: null,
      moonpayTransactionId: null,
      transactionStatus: null,
    });
  }
});

// ------------------------------------------------------
//  POST /reward_onRamp_buy
//  Body: { txid: string, depositAmountSats?: number }
//  - Finds BitcoinPurchase by txid (created by Stripe webhook)
//  - Or falls back to a single matching MoonPay purchase by lockedAmountSats
//  - Verifies it belongs to the authenticated user (pubkey match)
//  - Applies rewardAmountCents to this month's RewardSpend.merchantSpend
//  - Increments RewardSpend.transactions by 1
//  - Deletes the BitcoinPurchase so it can't be applied twice
// ------------------------------------------------------
router.post('/reward_onRamp_buy', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { txid } = req.body || {};
    const depositAmountSats = parsePositiveInteger(req.body?.depositAmountSats);

    if (!txid || typeof txid !== 'string') {
      return res.status(400).json({ error: 'txid is required' });
    }

    const user = await User.findById(userId).select('_id walletPubkey');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!user.walletPubkey) return res.status(400).json({ error: 'Missing wallet pubkey for user' });

    const stripePurchase = await BitcoinPurchase.findOne({ txid }).select('walletPubkey rewardAmountCents').lean();
    if (stripePurchase && stripePurchase.walletPubkey !== user.walletPubkey) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let rewardAmountCents = 0;
    let rewardSource = null;

    if (stripePurchase) {
      const consumedStripePurchase = await BitcoinPurchase.findOneAndDelete({ txid, walletPubkey: user.walletPubkey }).lean();
      if (!consumedStripePurchase) {
        return res.status(200).json({ ok: true, rewardSpendApplied: false, reason: 'already_applied' });
      }

      rewardAmountCents = Number(consumedStripePurchase.rewardAmountCents || 0);
      rewardSource = 'stripe';
    } else if (depositAmountSats) {
      const moonPayCandidates = await MoonPayPurchase.find({
        walletPubkey: user.walletPubkey,
        lockedAmountSats: depositAmountSats,
        consumedAt: null,
      })
        .sort({ createdAt: -1 })
        .limit(2)
        .lean();

      const moonPayMatch = chooseSingleMoonPayRewardMatch(moonPayCandidates);
      if (moonPayMatch.status === 'none') {
        return res.status(200).json({ ok: true, rewardSpendApplied: false, reason: 'txid_not_found' });
      }

      if (moonPayMatch.status === 'ambiguous') {
        return res.status(200).json({ ok: true, rewardSpendApplied: false, reason: 'ambiguous_moonpay_match' });
      }

      const consumedMoonPayPurchase = await MoonPayPurchase.findOneAndUpdate(
        {
          _id: moonPayMatch.purchase._id,
          walletPubkey: user.walletPubkey,
          consumedAt: null,
        },
        {
          $set: {
            consumedAt: new Date(),
            matchedClaimTxid: txid,
            transactionStatus: 'claimed',
          },
        },
        { new: true }
      ).lean();

      if (!consumedMoonPayPurchase) {
        return res.status(200).json({ ok: true, rewardSpendApplied: false, reason: 'already_applied' });
      }

      rewardAmountCents = Number(consumedMoonPayPurchase.rewardAmountCents || 0);
      rewardSource = 'moonpay';
    } else {
      return res.status(200).json({ ok: true, rewardSpendApplied: false, reason: 'txid_not_found' });
    }

    if (!Number.isFinite(rewardAmountCents) || rewardAmountCents <= 0) {
      return res.status(200).json({ ok: true, rewardSpendApplied: false, reason: 'invalid_reward_amount' });
    }

    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)

    await RewardSpend.findOneAndUpdate(
      { userId, monthKey },
      {
        $setOnInsert: {
          userId,
          monthKey,
        },
        $inc: {
          purchaseSpend: rewardAmountCents,
        },
      },
      { upsert: true }
    );

    return res.status(200).json({
      ok: true,
      rewardSpendApplied: true,
      rewardSource,
      rewardAmountCents,
      monthKey,
    });
  } catch (error) {
    console.error('reward_onRamp_buy error:', error);
    return res.status(500).json({ error: error?.message || 'Internal Server Error' });
  }
});

router.post('/iOS-delete-account', async (req, res) => {
    try {

        // Expect the userId to be sent in the body of the request
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'Bad Request: No userId provided' });
        }

        // Fetch user from the database using the userId
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Delete the Stripe customer object if it exists
        if (user.stripeCustomerId) {
            try {
                const stripe = getStripeClient();
                if (!stripe) {
                    return res.status(500).json({ error: 'Missing stripe_testing_secret env var' });
                }

                await stripe.customers.del(user.stripeCustomerId);
                console.log(`Stripe customer ${user.stripeCustomerId} deleted successfully`);
            } catch (err) {
                console.error('Error deleting Stripe customer:', err);
                return res.status(500).json({ error: 'Failed to delete Stripe customer' });
            }
        } else {
            console.log('No Stripe customer ID found for user');
        }

        // Delete the user account from MongoDB
        await user.deleteOne();
        console.log(`User with ID ${userId} deleted from MongoDB`);

        // Send a success response
        return res.status(200).json({ message: 'Account deleted successfully' });
    } catch (err) {
        console.error('Error in delete account endpoint:', err);
        return res.status(500).json({ error: 'An error occurred while processing the request' });
    }
});

module.exports = router;
