const crypto = require('crypto');

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const normalized = String(input || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

function signStatePayload(payload, secret) {
  return toBase64Url(
    crypto.createHmac('sha256', secret).update(payload).digest()
  );
}

function createMoonPayStateToken({
  walletPubkey,
  lockedAmountSats,
  estimatedSpendAmountCents,
  ttlMs = 60 * 60 * 1000,
  secret = process.env.secretKey,
}) {
  if (!secret) {
    throw new Error('Missing secret for MoonPay state token');
  }

  if (!walletPubkey || typeof walletPubkey !== 'string') {
    throw new Error('walletPubkey is required');
  }

  if (!Number.isInteger(lockedAmountSats) || lockedAmountSats <= 0) {
    throw new Error('lockedAmountSats must be a positive integer');
  }

  if (!Number.isInteger(estimatedSpendAmountCents) || estimatedSpendAmountCents <= 0) {
    throw new Error('estimatedSpendAmountCents must be a positive integer');
  }

  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + ttlMs;

  const payload = JSON.stringify({
    walletPubkey,
    lockedAmountSats,
    estimatedSpendAmountCents,
    issuedAtMs,
    expiresAtMs,
  });

  const payloadPart = toBase64Url(payload);
  const signaturePart = signStatePayload(payloadPart, secret);

  return {
    token: `${payloadPart}.${signaturePart}`,
    expiresAtMs,
  };
}

function verifyMoonPayStateToken(token, { secret = process.env.secretKey, nowMs = Date.now() } = {}) {
  if (!secret) {
    throw new Error('Missing secret for MoonPay state token verification');
  }

  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payloadPart, signaturePart] = token.split('.', 2);
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSignature = signStatePayload(payloadPart, secret);

  const provided = Buffer.from(signaturePart);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadPart).toString('utf8'));

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (!Number.isInteger(parsed.lockedAmountSats) || parsed.lockedAmountSats <= 0) {
      return null;
    }

    if (!Number.isInteger(parsed.estimatedSpendAmountCents) || parsed.estimatedSpendAmountCents <= 0) {
      return null;
    }

    if (!Number.isInteger(parsed.expiresAtMs) || parsed.expiresAtMs < nowMs) {
      return null;
    }

    if (!parsed.walletPubkey || typeof parsed.walletPubkey !== 'string') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function buildMoonPayReturnUrl({ baseUrl, stateToken }) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('baseUrl is required');
  }

  if (!stateToken || typeof stateToken !== 'string') {
    throw new Error('stateToken is required');
  }

  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '');
  return `${trimmedBaseUrl}/moonpay-return?state=${encodeURIComponent(stateToken)}`;
}

function chooseSingleMoonPayRewardMatch(purchases) {
  if (!Array.isArray(purchases) || purchases.length === 0) {
    return { status: 'none', purchase: null };
  }

  if (purchases.length > 1) {
    return { status: 'ambiguous', purchase: null };
  }

  return { status: 'single', purchase: purchases[0] };
}

module.exports = {
  buildMoonPayReturnUrl,
  chooseSingleMoonPayRewardMatch,
  createMoonPayStateToken,
  verifyMoonPayStateToken,
};
