const crypto = require('crypto');
const axios = require('axios');

const FCM_PROJECT_ID = String(process.env.FCM_PROJECT_ID || '').trim();
const FCM_CLIENT_EMAIL = String(process.env.FCM_CLIENT_EMAIL || '').trim();
const FCM_PRIVATE_KEY = String(process.env.FCM_PRIVATE_KEY || '').trim();

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let warnedMissingConfig = false;

function normalizePrivateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  let normalized = raw.replace(/\\n/g, '\n');
  normalized = normalized
    .replace(/-----BEGIN PRIVATE KEY-----\s*/g, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/\s*-----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----');

  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function hasFcmConfig() {
  return Boolean(
    FCM_PROJECT_ID &&
    FCM_CLIENT_EMAIL &&
    normalizePrivateKey(FCM_PRIVATE_KEY)
  );
}

function buildServiceAccountAssertion() {
  const privateKey = normalizePrivateKey(FCM_PRIVATE_KEY);
  if (!privateKey) {
    throw new Error('Missing FCM private key');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const payload = {
    iss: FCM_CLIENT_EMAIL,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function fetchAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const assertion = buildServiceAccountAssertion();
  const response = await axios.post(
    GOOGLE_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 15000,
    }
  );

  const accessToken = response?.data?.access_token;
  const expiresIn = Number(response?.data?.expires_in || 3600);
  if (!accessToken) {
    throw new Error('Google OAuth token response did not include access_token');
  }

  cachedAccessToken = accessToken;
  cachedAccessTokenExpiresAt = now + Math.max(60, expiresIn - 60) * 1000;
  return cachedAccessToken;
}

async function sendFcmSilentMessagePush({
  deviceToken,
  conversationId,
  messageId,
  pushType = 'messaging.new_message',
}) {
  const normalizedToken = String(deviceToken || '').trim();
  if (!normalizedToken) {
    return { ok: false, skipped: true, reason: 'missing-device-token' };
  }

  if (!hasFcmConfig()) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn('FCM not configured; Android silent messaging pushes are disabled.');
    }
    return { ok: false, skipped: true, reason: 'missing-fcm-config' };
  }

  try {
    const accessToken = await fetchAccessToken();
    const response = await axios.post(
      `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
      {
        message: {
          token: normalizedToken,
          data: {
            type: pushType,
            conversationId: String(conversationId || ''),
            messageId: String(messageId || ''),
          },
          android: {
            priority: 'high',
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    return {
      ok: true,
      statusCode: response.status,
      body: response.data,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: error?.response?.status || 0,
      body: error?.response?.data || null,
      error: error?.message || 'Unknown FCM error',
    };
  }
}

module.exports = {
  sendFcmSilentMessagePush,
};
