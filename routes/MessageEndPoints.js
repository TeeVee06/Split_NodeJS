require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const User = require('../models/User');
const UserBlock = require('../models/UserBlock');
const DirectMessage = require('../models/DirectMessage');
const MessageAttachment = require('../models/MessageAttachment');
const MessagingBindingLog = require('../models/MessagingBindingLog');
const MessagingDirectoryState = require('../models/MessagingDirectoryState');
const MessagingDeviceRegistration = require('../models/MessagingDeviceRegistration');
const userAuthMiddleware = require('../middlewares/userAuthMiddleware');
const sessionHelper = require('../auth/sessionHelper');
const { sendSilentMessagePush } = require('../messaging/apnsSilentPush');
const { sendFcmSilentMessagePush } = require('../messaging/fcmSilentPush');
const s3Client = require('../integrations/r2');
const {
  buildBindingLeafHash,
  buildMerkleProof,
  computeMerkleRoot,
  emptyRootHash,
} = require('../messaging/messagingDirectory');

const MESSAGE_TTL_HOURS = 24 * 30;
const MESSAGING_IDENTITY_SIGNATURE_VERSION = 1;
const MESSAGING_IDENTITY_V2_SIGNATURE_VERSION = 2;
const MESSAGING_ENVELOPE_SIGNATURE_VERSION = 1;
const MESSAGING_DEVICE_REGISTRATION_SIGNATURE_VERSION = 1;
const MESSAGING_IDENTITY_DOMAIN = process.env.MESSAGING_IDENTITY_DOMAIN || 'example.invalid';
const MESSAGING_DIRECTORY_STATE_KEY = 'messaging-v2-directory';
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const attachmentUpload = multer({
  limits: {
    fileSize: ATTACHMENT_MAX_BYTES,
  },
});

function stripDirectMessagePayload(messageDoc) {
  return {
    messageId: String(messageDoc._id),
    clientMessageId: messageDoc.clientMessageId,
    senderWalletPubkey: messageDoc.senderWalletPubkey,
    senderMessagingPubkey: messageDoc.senderMessagingPubkey,
    senderLightningAddress: messageDoc.senderLightningAddress || null,
    senderMessagingIdentitySignature: messageDoc.senderMessagingIdentitySignature || null,
    senderMessagingIdentitySignatureVersion: messageDoc.senderMessagingIdentitySignatureVersion || null,
    senderMessagingIdentitySignedAt: messageDoc.senderMessagingIdentitySignedAt || null,
    senderEnvelopeSignature: messageDoc.senderEnvelopeSignature || null,
    senderEnvelopeSignatureVersion: messageDoc.senderEnvelopeSignatureVersion || null,
    recipientWalletPubkey: messageDoc.recipientWalletPubkey,
    recipientMessagingPubkey: messageDoc.recipientMessagingPubkey,
    recipientLightningAddress: messageDoc.recipientLightningAddress,
    messageType: messageDoc.messageType,
    envelopeVersion: messageDoc.envelopeVersion,
    ciphertext: messageDoc.ciphertext,
    nonce: messageDoc.nonce,
    senderEphemeralPubkey: messageDoc.senderEphemeralPubkey,
    status: messageDoc.status,
    sameKeyRetryCount: Number(messageDoc.sameKeyRetryCount || 0),
    createdAt: messageDoc.createdAt,
    createdAtClient: messageDoc.createdAtClient,
    expiresAt: messageDoc.expiresAt,
    deliveredAt: messageDoc.deliveredAt,
    rekeyRequiredAt: messageDoc.rekeyRequiredAt,
    sameKeyDecryptFailedAt: messageDoc.sameKeyDecryptFailedAt,
    failedAt: messageDoc.failedAt,
    expiredAt: messageDoc.expiredAt,
  };
}

function normalizeLightningAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeWalletPubkey(value) {
  return String(value || '').trim();
}

function normalizeMessagingPubkey(value) {
  return String(value || '').trim();
}

function normalizeSignature(value) {
  return String(value || '').trim();
}

function parseSignedAtSeconds(value) {
  return parseIntegerValue(value);
}

function parseIntegerValue(value) {
  if (Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseClientTimestampMs(value) {
  const parsedInteger = parseIntegerValue(value);
  if (parsedInteger != null) {
    return parsedInteger;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsedDate = Date.parse(value.trim());
    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }
  }

  return null;
}

function isValidWalletPubkey(value) {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(value) || /^(04)?[0-9a-fA-F]{128}$/.test(value);
}

function isValidMessagingPubkey(value) {
  return /^(02|03)[0-9a-fA-F]{64}$/.test(value) || /^[0-9a-fA-F]{64}$/.test(value);
}

function isValidLightningAddress(value) {
  return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === 'string' && mongoose.Types.ObjectId.isValid(entry))
    .map((entry) => entry.trim());
}

function buildAttachmentObjectKey({ senderUserId }) {
  const randomId = crypto.randomUUID();
  return `messaging-attachments/${String(senderUserId)}/${Date.now()}-${randomId}.bin`;
}

function stripAttachmentPayload(attachmentDoc) {
  return {
    attachmentId: String(attachmentDoc._id),
    recipientLightningAddress: attachmentDoc.recipientLightningAddress,
    sizeBytes: attachmentDoc.sizeBytes,
    uploadContentType: attachmentDoc.uploadContentType,
    status: attachmentDoc.status,
    expiresAt: attachmentDoc.expiresAt,
    linkedMessageId: attachmentDoc.linkedMessageId ? String(attachmentDoc.linkedMessageId) : null,
    receivedAt: attachmentDoc.receivedAt,
    deletedAt: attachmentDoc.deletedAt,
  };
}

function stripUserBlockPayload(blockDoc) {
  return {
    blockId: String(blockDoc._id),
    blockedUserId: String(blockDoc.blockedUserId),
    blockedWalletPubkey: blockDoc.blockedWalletPubkey,
    blockedLightningAddress: blockDoc.blockedLightningAddress || null,
    blockedProfilePicUrl: blockDoc.blockedProfilePicUrl || null,
    createdAt: blockDoc.createdAt,
    updatedAt: blockDoc.updatedAt,
  };
}

async function resolveMessagingBlockTarget({ walletPubkey, lightningAddress }) {
  const normalizedWalletPubkey = normalizeWalletPubkey(walletPubkey);
  const normalizedLightningAddress = normalizeLightningAddress(lightningAddress);
  const hasWalletPubkey = !!normalizedWalletPubkey;
  const hasLightningAddress = !!normalizedLightningAddress;

  if (!hasWalletPubkey && !hasLightningAddress) {
    return {
      error: {
        status: 400,
        error: 'walletPubkey or lightningAddress is required',
      },
    };
  }

  if (hasWalletPubkey && !isValidWalletPubkey(normalizedWalletPubkey)) {
    return {
      error: {
        status: 400,
        error: 'walletPubkey format is invalid',
      },
    };
  }

  if (hasLightningAddress && !isValidLightningAddress(normalizedLightningAddress)) {
    return {
      error: {
        status: 400,
        error: 'lightningAddress format is invalid',
      },
    };
  }

  const [walletUser, lightningUser] = await Promise.all([
    hasWalletPubkey
      ? User.findOne({ walletPubkey: normalizedWalletPubkey })
        .select('_id walletPubkey lightningAddress profilePicUrl')
      : null,
    hasLightningAddress
      ? User.findOne({ lightningAddress: normalizedLightningAddress })
        .select('_id walletPubkey lightningAddress profilePicUrl')
      : null,
  ]);

  if (walletUser && lightningUser && String(walletUser._id) !== String(lightningUser._id)) {
    return {
      error: {
        status: 409,
        error: 'walletPubkey and lightningAddress refer to different users',
      },
    };
  }

  const target = walletUser || lightningUser;
  if (!target) {
    return {
      error: {
        status: 404,
        error: 'Block target not found',
      },
    };
  }

  return {
    target,
  };
}

async function getMessagingBlockState({ requesterUserId, targetUserId }) {
  try {
    const [requesterBlock, targetBlock] = await Promise.all([
      UserBlock.findOne({
        blockerUserId: requesterUserId,
        blockedUserId: targetUserId,
      }).select('_id'),
      UserBlock.findOne({
        blockerUserId: targetUserId,
        blockedUserId: requesterUserId,
      }).select('_id'),
    ]);

    return {
      blockedByRequester: !!requesterBlock,
      blockedByTarget: !!targetBlock,
    };
  } catch (error) {
    if (error?.name === 'CastError') {
      return {
        blockedByRequester: false,
        blockedByTarget: false,
      };
    }

    throw error;
  }
}

function buildMessagingBlockError(blockState) {
  if (blockState.blockedByRequester) {
    return {
      status: 409,
      error: 'You have blocked this user',
    };
  }

  if (blockState.blockedByTarget) {
    return {
      status: 409,
      error: 'Recipient is unavailable',
    };
  }

  return null;
}

async function deleteMessagingAttachmentObjects(attachments) {
  for (const attachment of attachments) {
    if (!attachment.objectKey) {
      continue;
    }

    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: attachment.objectKey,
      }));
    } catch (deleteError) {
      console.warn('Failed to delete blocked messaging attachment object:', deleteError);
    }
  }
}

async function cleanupBlockedConversationRelayData({ blockerUserId, blockedUserId }) {
  const participantPairs = [
    { senderUserId: blockedUserId, recipientUserId: blockerUserId },
    { senderUserId: blockerUserId, recipientUserId: blockedUserId },
  ];

  const [pendingMessages, attachments] = await Promise.all([
    DirectMessage.find({
      $or: participantPairs,
      status: 'pending',
    }).select('_id'),
    MessageAttachment.find({
      $or: participantPairs,
      status: { $in: ['uploaded', 'linked'] },
    }).select('_id objectKey'),
  ]);

  if (attachments.length) {
    await deleteMessagingAttachmentObjects(attachments);
    await MessageAttachment.deleteMany({
      _id: { $in: attachments.map((attachment) => attachment._id) },
      status: { $in: ['uploaded', 'linked'] },
    });
  }

  if (pendingMessages.length) {
    await DirectMessage.deleteMany({
      _id: { $in: pendingMessages.map((message) => message._id) },
      status: 'pending',
    });
  }
}

function buildMessagingIdentityBindingMessage({
  walletPubkey,
  lightningAddress,
  messagingPubkey,
  signedAt,
  version = MESSAGING_IDENTITY_SIGNATURE_VERSION,
  domain = MESSAGING_IDENTITY_DOMAIN,
}) {
  return `SplitRewards Messaging Identity Authorization
version=${version}
domain=${domain}
walletPubkey=${walletPubkey}
lightningAddress=${lightningAddress}
messagingPubkey=${messagingPubkey}
signedAt=${signedAt}`;
}

function buildMessagingEnvelopeSignatureMessage({
  clientMessageId,
  senderBinding,
  recipientBinding,
  ciphertext,
  nonce,
  senderEphemeralPubkey,
  createdAtClientMs,
  envelopeVersion,
  messageType,
  version = MESSAGING_ENVELOPE_SIGNATURE_VERSION,
  domain = MESSAGING_IDENTITY_DOMAIN,
}) {
  return `SplitRewards Messaging Envelope Authorization
version=${version}
domain=${domain}
clientMessageId=${clientMessageId}
senderWalletPubkey=${senderBinding.walletPubkey}
senderLightningAddress=${senderBinding.lightningAddress}
senderMessagingPubkey=${senderBinding.messagingPubkey}
recipientWalletPubkey=${recipientBinding.walletPubkey}
recipientLightningAddress=${recipientBinding.lightningAddress}
recipientMessagingPubkey=${recipientBinding.messagingPubkey}
messageType=${messageType}
ciphertext=${ciphertext}
nonce=${nonce}
senderEphemeralPubkey=${senderEphemeralPubkey}
createdAtClientMs=${createdAtClientMs}
envelopeVersion=${envelopeVersion}`;
}

function buildMessagingDeviceRegistrationMessage({
  walletPubkey,
  messagingPubkey,
  platform,
  environment,
  deviceToken,
  signedAt,
  version = MESSAGING_DEVICE_REGISTRATION_SIGNATURE_VERSION,
  domain = MESSAGING_IDENTITY_DOMAIN,
}) {
  return `SplitRewards Messaging Device Registration
version=${version}
domain=${domain}
walletPubkey=${walletPubkey}
messagingPubkey=${messagingPubkey}
platform=${platform}
environment=${environment}
deviceToken=${deviceToken}
signedAt=${signedAt}`;
}

function normalizeMessagingEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return ['dev', 'prod'].includes(normalized)
    ? normalized
    : null;
}

function currentMessagingPushEnvironment() {
  const configured = normalizeMessagingEnvironment(process.env.MESSAGING_PUSH_ENV);
  if (configured) {
    return configured;
  }

  const gitBranch = String(process.env.RENDER_GIT_BRANCH || '').trim().toLowerCase();
  if (gitBranch) {
    return gitBranch === 'main'
      ? 'prod'
      : 'dev';
  }

  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    ? 'prod'
    : 'dev';
}

function normalizeDeviceTokenForPlatform({ deviceToken, platform }) {
  const trimmedToken = typeof deviceToken === 'string'
    ? deviceToken.trim()
    : '';

  if (!trimmedToken) {
    return null;
  }

  return platform === 'apns'
    ? trimmedToken.toLowerCase()
    : trimmedToken;
}

function isValidDeviceTokenForPlatform({ deviceToken, platform }) {
  if (!deviceToken) {
    return false;
  }

  if (platform === 'apns') {
    return /^[0-9a-f]{64,200}$/.test(deviceToken);
  }

  if (platform === 'fcm') {
    return /^\S{32,4096}$/.test(deviceToken);
  }

  return false;
}

function normalizeAndValidateMessagingDeviceRegistration(payload) {
  const errors = [];
  const walletPubkey = normalizeWalletPubkey(payload?.walletPubkey);
  const messagingPubkey = normalizeMessagingPubkey(payload?.messagingPubkey);
  const platform = typeof payload?.platform === 'string'
    ? payload.platform.trim().toLowerCase()
    : '';
  const environment = normalizeMessagingEnvironment(payload?.environment);
  const deviceToken = normalizeDeviceTokenForPlatform({
    deviceToken: payload?.deviceToken,
    platform,
  });
  const registrationSignature = normalizeSignature(payload?.registrationSignature);
  const registrationSignatureVersion = parseIntegerValue(payload?.registrationSignatureVersion);
  const registrationSignedAt = parseSignedAtSeconds(payload?.registrationSignedAt);
  const appVersion = typeof payload?.appVersion === 'string'
    ? payload.appVersion.trim()
    : '';
  const bundleId = typeof payload?.bundleId === 'string'
    ? payload.bundleId.trim()
    : '';

  if (!walletPubkey) errors.push('walletPubkey is required');
  if (!messagingPubkey) errors.push('messagingPubkey is required');
  if (!platform) errors.push('platform is required');
  if (!environment) errors.push('environment is required');
  if (!deviceToken) errors.push('deviceToken is required');
  if (!registrationSignature) errors.push('registrationSignature is required');
  if (!Number.isInteger(registrationSignatureVersion)) {
    errors.push('registrationSignatureVersion must be an integer');
  }
  if (!Number.isInteger(registrationSignedAt)) {
    errors.push('registrationSignedAt must be a unix timestamp in seconds');
  }

  if (walletPubkey && !isValidWalletPubkey(walletPubkey)) {
    errors.push('walletPubkey format is invalid');
  }

  if (messagingPubkey && !isValidMessagingPubkey(messagingPubkey)) {
    errors.push('messagingPubkey format is invalid');
  }

  if (platform && !['apns', 'fcm'].includes(platform)) {
    errors.push('platform must be apns or fcm');
  }

  if (platform && deviceToken && !isValidDeviceTokenForPlatform({ deviceToken, platform })) {
    errors.push('deviceToken format is invalid');
  }

  if (Number.isInteger(registrationSignatureVersion) &&
      registrationSignatureVersion !== MESSAGING_DEVICE_REGISTRATION_SIGNATURE_VERSION) {
    errors.push(
      `registrationSignatureVersion must be ${MESSAGING_DEVICE_REGISTRATION_SIGNATURE_VERSION}`
    );
  }

  const signedAtMs = Number.isInteger(registrationSignedAt)
    ? registrationSignedAt * 1000
    : null;
  if (signedAtMs != null && (!Number.isFinite(signedAtMs) || signedAtMs <= 0)) {
    errors.push('registrationSignedAt is invalid');
  }

  if (errors.length) {
    return { errors };
  }

  return {
    errors: [],
    registration: {
      walletPubkey,
      messagingPubkey,
      platform,
      environment,
      deviceToken,
      registrationSignature,
      registrationSignatureVersion,
      registrationSignedAt,
      registrationSignedAtDate: new Date(signedAtMs),
      appVersion: appVersion || null,
      bundleId: bundleId || null,
    },
  };
}

function buildResolvedMessagingIdentityBinding(user, { version = MESSAGING_IDENTITY_SIGNATURE_VERSION } = {}) {
  const isV2 = version === MESSAGING_IDENTITY_V2_SIGNATURE_VERSION;

  return {
    walletPubkey: user.walletPubkey,
    lightningAddress: user.lightningAddress || null,
    messagingPubkey: isV2
      ? (user.messagingPubkeyV2 || null)
      : (user.messagingPubkey || null),
    messagingIdentitySignature: isV2
      ? (user.messagingIdentityV2Signature || null)
      : (user.messagingIdentitySignature || null),
    messagingIdentitySignatureVersion: isV2
      ? (user.messagingIdentityV2SignatureVersion || null)
      : (user.messagingIdentitySignatureVersion || null),
    messagingIdentitySignedAt: isV2
      ? (user.messagingIdentityV2SignedAt || null)
      : (user.messagingIdentitySignedAt || null),
    messagingIdentityUpdatedAt: isV2
      ? (user.messagingIdentityV2UpdatedAt || null)
      : (user.messagingIdentityUpdatedAt || null),
  };
}

function hasResolvedMessagingIdentityBinding(user, { version = MESSAGING_IDENTITY_SIGNATURE_VERSION } = {}) {
  const binding = buildResolvedMessagingIdentityBinding(user, { version });

  return !!(
    binding.walletPubkey &&
    binding.lightningAddress &&
    binding.messagingPubkey &&
    binding.messagingIdentitySignature &&
    Number.isInteger(binding.messagingIdentitySignatureVersion) &&
    binding.messagingIdentitySignedAt
  );
}

function bindingSignedAtSeconds(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

function normalizeAndValidateMessagingIdentityBinding(
  payload,
  { expectedVersion = MESSAGING_IDENTITY_V2_SIGNATURE_VERSION } = {}
) {
  const errors = [];

  const walletPubkey = normalizeWalletPubkey(payload?.walletPubkey);
  const lightningAddress = normalizeLightningAddress(payload?.lightningAddress);
  const messagingPubkey = normalizeMessagingPubkey(payload?.messagingPubkey);
  const messagingIdentitySignature = normalizeSignature(payload?.messagingIdentitySignature);
  const messagingIdentitySignatureVersion = parseSignedAtSeconds(payload?.messagingIdentitySignatureVersion);
  const messagingIdentitySignedAt = parseSignedAtSeconds(payload?.messagingIdentitySignedAt);

  if (!walletPubkey) errors.push('walletPubkey is required');
  if (!lightningAddress) errors.push('lightningAddress is required');
  if (!messagingPubkey) errors.push('messagingPubkey is required');
  if (!messagingIdentitySignature) errors.push('messagingIdentitySignature is required');
  if (!Number.isInteger(messagingIdentitySignatureVersion)) {
    errors.push('messagingIdentitySignatureVersion must be an integer');
  }
  if (!Number.isInteger(messagingIdentitySignedAt)) {
    errors.push('messagingIdentitySignedAt must be a unix timestamp in seconds');
  }

  if (walletPubkey && !isValidWalletPubkey(walletPubkey)) {
    errors.push('walletPubkey format is invalid');
  }

  if (lightningAddress && !isValidLightningAddress(lightningAddress)) {
    errors.push('lightningAddress format is invalid');
  }

  if (messagingPubkey && !isValidMessagingPubkey(messagingPubkey)) {
    errors.push('messagingPubkey format is invalid');
  }

  if (Number.isInteger(messagingIdentitySignatureVersion) &&
      messagingIdentitySignatureVersion !== expectedVersion) {
    errors.push(`Unsupported messagingIdentitySignatureVersion (expected ${expectedVersion})`);
  }

  const signedAtMs = Number.isInteger(messagingIdentitySignedAt)
    ? messagingIdentitySignedAt * 1000
    : null;

  if (signedAtMs != null && (!Number.isFinite(signedAtMs) || signedAtMs <= 0)) {
    errors.push('messagingIdentitySignedAt is invalid');
  }

  if (errors.length) {
    return { errors };
  }

  return {
    errors: [],
    binding: {
      walletPubkey,
      lightningAddress,
      messagingPubkey,
      messagingIdentitySignature,
      messagingIdentitySignatureVersion,
      messagingIdentitySignedAt,
      messagingIdentitySignedAtDate: new Date(signedAtMs),
    },
  };
}

function verifyMessagingIdentityBinding(binding) {
  const canonicalMessage = buildMessagingIdentityBindingMessage({
    walletPubkey: binding.walletPubkey,
    lightningAddress: binding.lightningAddress,
    messagingPubkey: binding.messagingPubkey,
    signedAt: binding.messagingIdentitySignedAt,
    version: binding.messagingIdentitySignatureVersion,
  });

  return sessionHelper.verifyBreezSignedMessage({
    message: canonicalMessage,
    pubkey: binding.walletPubkey,
    signature: binding.messagingIdentitySignature,
  });
}

function verifyMessagingEnvelopeSignature({
  senderBinding,
  recipientBinding,
  clientMessageId,
  ciphertext,
  nonce,
  senderEphemeralPubkey,
  createdAtClientMs,
  envelopeVersion,
  messageType,
  senderEnvelopeSignature,
  senderEnvelopeSignatureVersion,
}) {
  const canonicalMessage = buildMessagingEnvelopeSignatureMessage({
    clientMessageId,
    senderBinding,
    recipientBinding,
    ciphertext,
    nonce,
    senderEphemeralPubkey,
    createdAtClientMs,
    envelopeVersion,
    messageType,
    version: senderEnvelopeSignatureVersion,
  });

  return sessionHelper.verifyBreezSignedMessage({
    message: canonicalMessage,
    pubkey: senderBinding.walletPubkey,
    signature: senderEnvelopeSignature,
  });
}

function verifyMessagingDeviceRegistration(registration) {
  const canonicalMessage = buildMessagingDeviceRegistrationMessage({
    walletPubkey: registration.walletPubkey,
    messagingPubkey: registration.messagingPubkey,
    platform: registration.platform,
    environment: registration.environment,
    deviceToken: registration.deviceToken,
    signedAt: registration.registrationSignedAt,
    version: registration.registrationSignatureVersion,
  });

  return sessionHelper.verifyBreezSignedMessage({
    message: canonicalMessage,
    pubkey: registration.walletPubkey,
    signature: registration.registrationSignature,
  });
}

function resolvedBindingMatchesUser(user, binding, { version = MESSAGING_IDENTITY_V2_SIGNATURE_VERSION } = {}) {
  const snapshot = buildResolvedMessagingIdentityBinding(user, { version });

  return (
    normalizeWalletPubkey(snapshot.walletPubkey).toLowerCase() === binding.walletPubkey.toLowerCase() &&
    normalizeLightningAddress(snapshot.lightningAddress) === binding.lightningAddress &&
    normalizeMessagingPubkey(snapshot.messagingPubkey) === binding.messagingPubkey &&
    normalizeSignature(snapshot.messagingIdentitySignature) === binding.messagingIdentitySignature &&
    Number(snapshot.messagingIdentitySignatureVersion) === binding.messagingIdentitySignatureVersion &&
    bindingSignedAtSeconds(snapshot.messagingIdentitySignedAt) === binding.messagingIdentitySignedAt
  );
}

function stripMessagingIdentityBinding(user) {
  return {
    walletPubkey: user.walletPubkey,
    lightningAddress: user.lightningAddress || null,
    messagingPubkey: user.messagingPubkey || null,
    messagingIdentitySignature: user.messagingIdentitySignature || null,
    messagingIdentitySignatureVersion: user.messagingIdentitySignatureVersion || null,
    messagingIdentitySignedAt: user.messagingIdentitySignedAt || null,
    messagingIdentityUpdatedAt: user.messagingIdentityUpdatedAt || null,
  };
}

function stripMessagingIdentityBindingV2(user) {
  return buildResolvedMessagingIdentityBinding(user, {
    version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
  });
}

function stripMessagingDeviceRegistration(registration) {
  return {
    registrationId: String(registration._id),
    walletPubkey: registration.walletPubkey,
    messagingPubkey: registration.messagingPubkey,
    deviceToken: registration.deviceToken,
    platform: registration.platform,
    environment: registration.environment,
    appVersion: registration.appVersion || null,
    bundleId: registration.bundleId || null,
    registrationSignedAt: registration.registrationSignedAt || null,
    lastSeenAt: registration.lastSeenAt || null,
    createdAt: registration.createdAt || null,
    updatedAt: registration.updatedAt || null,
  };
}

function buildResolvedMessagingIdentityBindingRecord(
  user,
  { version = MESSAGING_IDENTITY_V2_SIGNATURE_VERSION } = {}
) {
  const snapshot = buildResolvedMessagingIdentityBinding(user, { version });
  const signedAtSeconds = bindingSignedAtSeconds(snapshot.messagingIdentitySignedAt);

  return {
    ...snapshot,
    messagingIdentitySignedAt: signedAtSeconds,
    messagingIdentitySignedAtDate: signedAtSeconds
      ? new Date(signedAtSeconds * 1000)
      : null,
  };
}

async function deleteStaleMessagingDeviceRegistrations({ userId, activeMessagingPubkey }) {
  const normalizedActiveMessagingPubkey = normalizeMessagingPubkey(activeMessagingPubkey);
  if (!userId || !normalizedActiveMessagingPubkey) {
    return;
  }

  await MessagingDeviceRegistration.deleteMany({
    userId,
    messagingPubkey: { $ne: normalizedActiveMessagingPubkey },
  });
}

function shouldDeleteMessagingDeviceRegistrationForPushResult({ platform, pushResult }) {
  if (!pushResult || pushResult.ok || pushResult.skipped) {
    return false;
  }

  const statusCode = Number(pushResult.statusCode || 0);
  if (platform === 'apns') {
    if (![400, 404, 410].includes(statusCode)) {
      return false;
    }

    let reason = '';
    try {
      const parsed = typeof pushResult.body === 'string'
        ? JSON.parse(pushResult.body)
        : pushResult.body;
      reason = String(parsed?.reason || '').trim();
    } catch (_error) {
      reason = '';
    }

    return ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason) ||
      statusCode === 410;
  }

  if (platform === 'fcm') {
    if (statusCode === 404) {
      return true;
    }

    const serializedBody = JSON.stringify(pushResult.body || {});
    return /UNREGISTERED|registration-token-not-registered|Requested entity was not found/i
      .test(`${serializedBody} ${pushResult.error || ''}`);
  }

  return false;
}

async function sendPushNotificationsForDirectMessage({ directMessage, recipientUserId }) {
  return sendMessagingPushNotifications({
    userId: recipientUserId,
    messagingPubkeys: [directMessage.recipientMessagingPubkey],
    pushType: 'messaging.new_message',
    conversationId: directMessage.senderWalletPubkey,
    messageId: String(directMessage._id),
  });
}

async function sendMessagingPushNotifications({
  userId,
  messagingPubkeys,
  pushType,
  conversationId,
  messageId,
}) {
  const activeEnvironment = currentMessagingPushEnvironment();
  const normalizedMessagingPubkeys = Array.isArray(messagingPubkeys)
    ? messagingPubkeys
      .map(normalizeMessagingPubkey)
      .filter((value, index, array) => value && array.indexOf(value) === index)
    : [];

  const registrationFilter = {
    userId,
    environment: activeEnvironment,
  };

  if (normalizedMessagingPubkeys.length) {
    registrationFilter.messagingPubkey = { $in: normalizedMessagingPubkeys };
  }

  const registrations = await MessagingDeviceRegistration.find(registrationFilter)
    .select('_id deviceToken platform');

  if (!registrations.length) {
    return { attemptedCount: 0, prunedCount: 0 };
  }

  const staleRegistrationIds = [];

  for (const registration of registrations) {
    const pushPayload = {
      deviceToken: registration.deviceToken,
      pushType,
      conversationId,
      messageId,
    };

    let pushResult = null;
    if (registration.platform === 'fcm') {
      pushResult = await sendFcmSilentMessagePush(pushPayload).catch((pushError) => {
        console.warn('Failed to send FCM silent message push:', pushError);
        return null;
      });
    } else {
      pushResult = await sendSilentMessagePush(pushPayload).catch((pushError) => {
        console.warn('Failed to send APNs silent message push:', pushError);
        return null;
      });
    }

    if (shouldDeleteMessagingDeviceRegistrationForPushResult({
      platform: registration.platform,
      pushResult,
    })) {
      staleRegistrationIds.push(registration._id);
    }
  }

  if (staleRegistrationIds.length) {
    await MessagingDeviceRegistration.deleteMany({
      _id: { $in: staleRegistrationIds },
    });
  }

  return {
    attemptedCount: registrations.length,
    prunedCount: staleRegistrationIds.length,
  };
}

async function sendRekeyRequiredPushNotifications({ directMessages }) {
  return sendOutgoingStatusPushNotifications({ directMessages });
}

async function sendOutgoingStatusPushNotifications({ directMessages }) {
  if (!Array.isArray(directMessages) || !directMessages.length) {
    return { attemptedCount: 0, prunedCount: 0 };
  }

  const dedupedMessages = [];
  const seenKeys = new Set();
  for (const directMessage of directMessages) {
    const dedupeKey = `${String(directMessage.senderUserId)}:${directMessage.recipientWalletPubkey}`;
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    seenKeys.add(dedupeKey);
    dedupedMessages.push(directMessage);
  }

  const senderUserIds = dedupedMessages
    .map((message) => String(message?.senderUserId || '').trim())
    .filter((value, index, array) => value && array.indexOf(value) === index)
    .filter((value) => mongoose.Types.ObjectId.isValid(value))
    .map((value) => new mongoose.Types.ObjectId(value));

  if (!senderUserIds.length) {
    return { attemptedCount: 0, prunedCount: 0 };
  }

  const senderUsers = await User.find({
    _id: { $in: senderUserIds },
  })
    .select('_id messagingPubkey messagingPubkeyV2')
    .lean();
  const senderUserById = new Map(senderUsers.map((user) => [String(user._id), user]));

  let attemptedCount = 0;
  let prunedCount = 0;

  for (const directMessage of dedupedMessages) {
    const senderUser = senderUserById.get(String(directMessage.senderUserId));
    if (!senderUser) {
      continue;
    }

    const activeSenderMessagingPubkeys = buildAcceptedRecipientMessagingPubkeys(senderUser, {
      requireV2: true,
    });
    if (!activeSenderMessagingPubkeys.length) {
      continue;
    }

    const result = await sendMessagingPushNotifications({
      userId: directMessage.senderUserId,
      messagingPubkeys: activeSenderMessagingPubkeys,
      pushType: 'messaging.outgoing_status',
      conversationId: directMessage.recipientWalletPubkey,
      messageId: String(directMessage._id),
    });

    attemptedCount += result.attemptedCount || 0;
    prunedCount += result.prunedCount || 0;
  }

  return {
    attemptedCount,
    prunedCount,
  };
}

function buildAcceptedRecipientMessagingPubkeys(user, { requireV2 = false } = {}) {
  const normalizedV2MessagingPubkey = normalizeMessagingPubkey(user?.messagingPubkeyV2);
  if (requireV2 && !normalizedV2MessagingPubkey) {
    return [];
  }

  return [
    normalizedV2MessagingPubkey,
    normalizeMessagingPubkey(user?.messagingPubkey),
  ].filter((value, index, array) => value && array.indexOf(value) === index);
}

function normalizeDirectMessageObjectIds(messageIds) {
  if (!Array.isArray(messageIds)) {
    return [];
  }

  return messageIds
    .filter((entry) => typeof entry === 'string' && mongoose.Types.ObjectId.isValid(entry))
    .map((entry) => new mongoose.Types.ObjectId(entry));
}

function stripOutgoingDirectMessageStatus(message) {
  return {
    messageId: String(message._id),
    clientMessageId: message.clientMessageId,
    recipientLightningAddress: message.recipientLightningAddress,
    recipientWalletPubkey: message.recipientWalletPubkey,
    status: message.status,
    sameKeyRetryCount: Number(message.sameKeyRetryCount || 0),
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt,
    rekeyRequiredAt: message.rekeyRequiredAt,
    sameKeyDecryptFailedAt: message.sameKeyDecryptFailedAt,
    failedAt: message.failedAt,
    expiredAt: message.expiredAt,
  };
}

function stripDirectoryCheckpoint(checkpoint) {
  return {
    rootHash: checkpoint.rootHash,
    treeSize: checkpoint.treeSize,
    issuedAt: checkpoint.issuedAt,
  };
}

function stripDirectoryProofPayload({ bindingLogEntry, checkpoint, proof }) {
  return {
    leafIndex: bindingLogEntry.leafIndex,
    leafHash: bindingLogEntry.leafHash,
    proof,
    checkpoint: stripDirectoryCheckpoint(checkpoint),
  };
}

function buildBindingLogLookupFilter(binding) {
  return {
    walletPubkey: binding.walletPubkey,
    lightningAddress: binding.lightningAddress,
    messagingPubkey: binding.messagingPubkey,
    messagingIdentitySignature: binding.messagingIdentitySignature,
    messagingIdentitySignatureVersion: binding.messagingIdentitySignatureVersion,
    messagingIdentitySignedAt: binding.messagingIdentitySignedAtDate,
  };
}

async function reserveMessagingDirectoryLeafIndex() {
  await MessagingDirectoryState.findOneAndUpdate(
    { key: MESSAGING_DIRECTORY_STATE_KEY },
    {
      $setOnInsert: {
        key: MESSAGING_DIRECTORY_STATE_KEY,
        lastLeafIndex: -1,
        treeSize: 0,
        rootHash: emptyRootHash(),
      },
    },
    {
      upsert: true,
    }
  );

  const directoryState = await MessagingDirectoryState.findOneAndUpdate(
    { key: MESSAGING_DIRECTORY_STATE_KEY },
    {
      $inc: { lastLeafIndex: 1 },
    },
    {
      new: true,
    }
  );

  return Number(directoryState.lastLeafIndex);
}

async function appendMessagingBindingLogEntry({ userId, binding }) {
  const existing = await MessagingBindingLog.findOne(buildBindingLogLookupFilter(binding))
    .sort({ leafIndex: -1 });

  if (existing) {
    return existing;
  }

  const leafIndex = await reserveMessagingDirectoryLeafIndex();
  const leafHash = buildBindingLeafHash(binding);

  return MessagingBindingLog.create({
    userId,
    walletPubkey: binding.walletPubkey,
    lightningAddress: binding.lightningAddress,
    messagingPubkey: binding.messagingPubkey,
    messagingIdentitySignature: binding.messagingIdentitySignature,
    messagingIdentitySignatureVersion: binding.messagingIdentitySignatureVersion,
    messagingIdentitySignedAt: binding.messagingIdentitySignedAtDate,
    leafIndex,
    leafHash,
  });
}

async function loadMessagingDirectorySnapshot() {
  const entries = await MessagingBindingLog.find({})
    .sort({ leafIndex: 1 })
    .select('_id leafIndex leafHash createdAt');

  const leafHashes = entries.map((entry) => entry.leafHash);
  const checkpoint = {
    rootHash: computeMerkleRoot(leafHashes),
    treeSize: leafHashes.length,
    issuedAt: entries.length
      ? entries[entries.length - 1].createdAt
      : new Date(0),
  };

  await MessagingDirectoryState.findOneAndUpdate(
    { key: MESSAGING_DIRECTORY_STATE_KEY },
    {
      $setOnInsert: { key: MESSAGING_DIRECTORY_STATE_KEY, lastLeafIndex: -1 },
      $set: {
        rootHash: checkpoint.rootHash,
        treeSize: checkpoint.treeSize,
      },
    },
    { upsert: true }
  );

  return {
    entries,
    leafHashes,
    checkpoint,
  };
}

async function buildDirectoryProofForBinding(binding) {
  const bindingLogEntry = await MessagingBindingLog.findOne(buildBindingLogLookupFilter(binding))
    .sort({ leafIndex: -1 })
    .select('_id leafIndex leafHash');

  if (!bindingLogEntry) {
    throw new Error('Messaging directory entry was not found for the binding');
  }

  const snapshot = await loadMessagingDirectorySnapshot();
  const leafPosition = snapshot.entries.findIndex(
    (entry) => String(entry._id) === String(bindingLogEntry._id)
  );

  if (leafPosition < 0) {
    throw new Error('Messaging directory entry was not present in the current snapshot');
  }

  const proof = buildMerkleProof(snapshot.leafHashes, leafPosition);

  return stripDirectoryProofPayload({
    bindingLogEntry,
    checkpoint: snapshot.checkpoint,
    proof,
  });
}

router.get('/messaging-key', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await User.findById(userId).select(
      '_id walletPubkey lightningAddress messagingPubkey messagingIdentitySignature messagingIdentitySignatureVersion messagingIdentitySignedAt messagingIdentityUpdatedAt'
    );
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.status(200).json({
      ok: true,
      ...stripMessagingIdentityBinding(user),
    });
  } catch (error) {
    console.error('Error fetching messaging key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging-key', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const {
      walletPubkey,
      lightningAddress,
      messagingPubkey,
      messagingIdentitySignature,
      messagingIdentitySignatureVersion,
      messagingIdentitySignedAt,
    } = req.body || {};

    const errors = [];
    if (!walletPubkey || typeof walletPubkey !== 'string') errors.push('walletPubkey is required');
    if (!lightningAddress || typeof lightningAddress !== 'string') errors.push('lightningAddress is required');
    if (!messagingPubkey || typeof messagingPubkey !== 'string') errors.push('messagingPubkey is required');
    if (!messagingIdentitySignature || typeof messagingIdentitySignature !== 'string') errors.push('messagingIdentitySignature is required');
    if (!Number.isInteger(messagingIdentitySignatureVersion)) errors.push('messagingIdentitySignatureVersion must be an integer');
    if (!Number.isInteger(messagingIdentitySignedAt)) errors.push('messagingIdentitySignedAt must be a unix timestamp in seconds');

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const trimmedWalletPubkey = walletPubkey.trim();
    const normalizedLightningAddress = normalizeLightningAddress(lightningAddress);
    const trimmedMessagingPubkey = messagingPubkey.trim();
    const trimmedSignature = messagingIdentitySignature.trim();

    if (!(/^(02|03)[0-9a-fA-F]{64}$/.test(trimmedWalletPubkey) || /^(04)?[0-9a-fA-F]{128}$/.test(trimmedWalletPubkey))) {
      return res.status(400).json({ error: 'walletPubkey format is invalid' });
    }

    if (!normalizedLightningAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedLightningAddress)) {
      return res.status(400).json({ error: 'lightningAddress format is invalid' });
    }

    if (!(/^(02|03)[0-9a-fA-F]{64}$/.test(trimmedMessagingPubkey) || /^[0-9a-fA-F]{64}$/.test(trimmedMessagingPubkey))) {
      return res.status(400).json({ error: 'messagingPubkey format is invalid' });
    }

    if (messagingIdentitySignatureVersion !== MESSAGING_IDENTITY_SIGNATURE_VERSION) {
      return res.status(400).json({ error: 'Unsupported messagingIdentitySignatureVersion' });
    }

    const signedAtMs = messagingIdentitySignedAt * 1000;
    if (!Number.isFinite(signedAtMs) || signedAtMs <= 0) {
      return res.status(400).json({ error: 'messagingIdentitySignedAt is invalid' });
    }

    const user = await User.findById(userId).select(
      '_id walletPubkey lightningAddress messagingPubkey messagingIdentitySignature messagingIdentitySignatureVersion messagingIdentitySignedAt messagingIdentityUpdatedAt'
    );
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (String(user.walletPubkey).trim().toLowerCase() !== trimmedWalletPubkey.toLowerCase()) {
      return res.status(403).json({ error: 'walletPubkey does not match the authenticated user' });
    }

    if (!user.lightningAddress) {
      return res.status(409).json({ error: 'lightningAddress must exist before messaging can be activated' });
    }

    if (normalizeLightningAddress(user.lightningAddress) !== normalizedLightningAddress) {
      return res.status(403).json({ error: 'lightningAddress does not match the authenticated user' });
    }

    const canonicalMessage = buildMessagingIdentityBindingMessage({
      walletPubkey: trimmedWalletPubkey,
      lightningAddress: normalizedLightningAddress,
      messagingPubkey: trimmedMessagingPubkey,
      signedAt: messagingIdentitySignedAt,
      version: messagingIdentitySignatureVersion,
    });

    const isValidSignature = sessionHelper.verifyBreezSignedMessage({
      message: canonicalMessage,
      pubkey: trimmedWalletPubkey,
      signature: trimmedSignature,
    });

    if (!isValidSignature) {
      return res.status(401).json({ error: 'Invalid messaging key signature' });
    }

    const didRotate = !!user.messagingPubkey && user.messagingPubkey !== trimmedMessagingPubkey;
    const didUpdate =
      user.messagingPubkey !== trimmedMessagingPubkey ||
      user.messagingIdentitySignature !== trimmedSignature ||
      user.messagingIdentitySignatureVersion !== messagingIdentitySignatureVersion ||
      String(user.messagingIdentitySignedAt ? user.messagingIdentitySignedAt.getTime() : '') !== String(signedAtMs);

    if (didUpdate) {
      user.messagingPubkey = trimmedMessagingPubkey;
      user.messagingIdentitySignature = trimmedSignature;
      user.messagingIdentitySignatureVersion = messagingIdentitySignatureVersion;
      user.messagingIdentitySignedAt = new Date(signedAtMs);
      user.messagingIdentityUpdatedAt = new Date();
      await user.save();
    }

    return res.status(200).json({
      ok: true,
      didUpdate,
      didRotate,
      ...stripMessagingIdentityBinding(user),
    });
  } catch (error) {
    console.error('Error registering messaging key:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function handleMessagingV2LikeIdentityGet(req, res) {
  try {
    const user = await User.findById(req.userId).select(
      '_id walletPubkey lightningAddress messagingPubkeyV2 messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt messagingIdentityV2UpdatedAt'
    );

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let directory = null;
    if (hasResolvedMessagingIdentityBinding(user, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      const binding = buildResolvedMessagingIdentityBindingRecord(user, {
        version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
      });
      await appendMessagingBindingLogEntry({
        userId: user._id,
        binding,
      });
      directory = await buildDirectoryProofForBinding(binding);
    }

    return res.status(200).json({
      ok: true,
      ...stripMessagingIdentityBindingV2(user),
      directory,
    });
  } catch (error) {
    console.error('Error fetching messaging v2 identity:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleMessagingV2LikeIdentityPost(req, res) {
  try {
    const userId = req.userId;
    const normalized = normalizeAndValidateMessagingIdentityBinding(req.body, {
      expectedVersion: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    });

    if (normalized.errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: normalized.errors });
    }

    const binding = normalized.binding;
    const user = await User.findById(userId).select(
      '_id walletPubkey lightningAddress messagingPubkeyV2 messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt messagingIdentityV2UpdatedAt'
    );

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (normalizeWalletPubkey(user.walletPubkey).toLowerCase() !== binding.walletPubkey.toLowerCase()) {
      return res.status(403).json({ error: 'walletPubkey does not match the authenticated user' });
    }

    if (!verifyMessagingIdentityBinding(binding)) {
      return res.status(401).json({ error: 'Invalid messaging v2 identity signature' });
    }

    const didRotate = !!user.messagingPubkeyV2 && user.messagingPubkeyV2 !== binding.messagingPubkey;
    const didUpdate =
      normalizeLightningAddress(user.lightningAddress) !== binding.lightningAddress ||
      normalizeMessagingPubkey(user.messagingPubkeyV2) !== binding.messagingPubkey ||
      normalizeSignature(user.messagingIdentityV2Signature) !== binding.messagingIdentitySignature ||
      Number(user.messagingIdentityV2SignatureVersion) !== binding.messagingIdentitySignatureVersion ||
      bindingSignedAtSeconds(user.messagingIdentityV2SignedAt) !== binding.messagingIdentitySignedAt;

    if (didUpdate) {
      user.lightningAddress = binding.lightningAddress;
      user.messagingPubkeyV2 = binding.messagingPubkey;
      user.messagingIdentityV2Signature = binding.messagingIdentitySignature;
      user.messagingIdentityV2SignatureVersion = binding.messagingIdentitySignatureVersion;
      user.messagingIdentityV2SignedAt = binding.messagingIdentitySignedAtDate;
      user.messagingIdentityV2UpdatedAt = new Date();
      await user.save();
    }

    await deleteStaleMessagingDeviceRegistrations({
      userId: user._id,
      activeMessagingPubkey: binding.messagingPubkey,
    });

    await appendMessagingBindingLogEntry({
      userId: user._id,
      binding,
    });
    const directory = await buildDirectoryProofForBinding(binding);

    return res.status(200).json({
      ok: true,
      didUpdate,
      didRotate,
      ...stripMessagingIdentityBindingV2(user),
      directory,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: 'lightningAddress already exists on another user' });
    }

    console.error('Error registering messaging v2 identity:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.get('/messaging/v2/identity', userAuthMiddleware, handleMessagingV2LikeIdentityGet);
router.post('/messaging/v2/identity', userAuthMiddleware, handleMessagingV2LikeIdentityPost);
router.get('/messaging/v3/identity', userAuthMiddleware, handleMessagingV2LikeIdentityGet);
router.post('/messaging/v3/identity', userAuthMiddleware, handleMessagingV2LikeIdentityPost);

router.get('/messaging/device-token', userAuthMiddleware, async (req, res) => {
  return res.status(410).json({
    error: 'Deprecated. Use /messaging/v3/device-registrations',
  });
});

router.post('/messaging/device-token', userAuthMiddleware, async (req, res) => {
  return res.status(410).json({
    error: 'Deprecated. Use /messaging/v3/device-registrations',
  });
});

router.get('/messaging/blocks', userAuthMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('_id');

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const blocks = await UserBlock.find({ blockerUserId: user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      ok: true,
      blocks: blocks.map(stripUserBlockPayload),
    });
  } catch (error) {
    console.error('Error fetching messaging blocks:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/blocks', userAuthMiddleware, async (req, res) => {
  try {
    const blocker = await User.findById(req.userId).select('_id walletPubkey lightningAddress');

    if (!blocker) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const resolvedTarget = await resolveMessagingBlockTarget(req.body || {});
    if (resolvedTarget.error) {
      return res.status(resolvedTarget.error.status).json({ error: resolvedTarget.error.error });
    }

    const { target } = resolvedTarget;
    if (String(target._id) === String(blocker._id)) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    const existing = await UserBlock.findOne({
      blockerUserId: blocker._id,
      blockedUserId: target._id,
    });

    if (existing) {
      try {
        await cleanupBlockedConversationRelayData({
          blockerUserId: blocker._id,
          blockedUserId: target._id,
        });
      } catch (cleanupError) {
        console.warn('Failed to cleanup pending relay data for existing block:', cleanupError);
      }

      return res.status(200).json({
        ok: true,
        didUpdate: false,
        block: stripUserBlockPayload(existing),
      });
    }

    const block = await UserBlock.create({
      blockerUserId: blocker._id,
      blockedUserId: target._id,
      blockedWalletPubkey: target.walletPubkey,
      blockedLightningAddress: target.lightningAddress || null,
      blockedProfilePicUrl: target.profilePicUrl || null,
    });

    try {
      await cleanupBlockedConversationRelayData({
        blockerUserId: blocker._id,
        blockedUserId: target._id,
      });
    } catch (cleanupError) {
      console.warn('Failed to cleanup pending relay data after block:', cleanupError);
    }

    return res.status(200).json({
      ok: true,
      didUpdate: true,
      block: stripUserBlockPayload(block),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const resolvedTarget = await resolveMessagingBlockTarget(req.body || {});
      if (!resolvedTarget.error) {
        const existing = await UserBlock.findOne({
          blockerUserId: req.userId,
          blockedUserId: resolvedTarget.target._id,
        });

        if (existing) {
          return res.status(200).json({
            ok: true,
            didUpdate: false,
            block: stripUserBlockPayload(existing),
          });
        }
      }
    }

    console.error('Error creating messaging block:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.delete('/messaging/blocks/:blockedWalletPubkey', userAuthMiddleware, async (req, res) => {
  try {
    const blocker = await User.findById(req.userId).select('_id');

    if (!blocker) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const blockedWalletPubkey = normalizeWalletPubkey(req.params?.blockedWalletPubkey);
    if (!blockedWalletPubkey || !isValidWalletPubkey(blockedWalletPubkey)) {
      return res.status(400).json({ error: 'blockedWalletPubkey is invalid' });
    }

    const result = await UserBlock.deleteOne({
      blockerUserId: blocker._id,
      blockedWalletPubkey,
    });

    return res.status(200).json({
      ok: true,
      didDelete: !!result.deletedCount,
      blockedWalletPubkey,
    });
  } catch (error) {
    console.error('Error deleting messaging block:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/resolve-recipient', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { lightningAddress } = req.body || {};

    const normalizedLightningAddress = normalizeLightningAddress(lightningAddress);
    if (!normalizedLightningAddress) {
      return res.status(400).json({ error: 'lightningAddress is required' });
    }

    const sender = await User.findById(userId).select(
      '_id walletPubkey messagingPubkey lightningAddress messagingIdentitySignature messagingIdentitySignatureVersion messagingIdentitySignedAt'
    );
    if (!sender) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sender.lightningAddress) {
      return res.status(409).json({ error: 'Sender lightningAddress is not set' });
    }

    if (!sender.messagingPubkey || !sender.messagingIdentitySignature || !sender.messagingIdentitySignatureVersion || !sender.messagingIdentitySignedAt) {
      return res.status(409).json({ error: 'Sender messaging identity is not registered' });
    }

    const recipient = await User.findOne({ lightningAddress: normalizedLightningAddress })
      .select('_id walletPubkey lightningAddress messagingPubkey messagingIdentitySignature messagingIdentitySignatureVersion messagingIdentitySignedAt profilePicUrl');

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipient._id) === String(sender._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockState({
      requesterUserId: sender._id,
      targetUserId: recipient._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    if (!recipient.messagingPubkey) {
      return res.status(409).json({ error: 'Recipient messaging is not active' });
    }

    if (!recipient.messagingIdentitySignature || !recipient.messagingIdentitySignatureVersion || !recipient.messagingIdentitySignedAt) {
      return res.status(409).json({ error: 'Recipient messaging identity is not signed yet' });
    }

    return res.status(200).json({
      ok: true,
      recipient: {
        walletPubkey: recipient.walletPubkey,
        lightningAddress: recipient.lightningAddress,
        messagingPubkey: recipient.messagingPubkey,
        messagingIdentitySignature: recipient.messagingIdentitySignature,
        messagingIdentitySignatureVersion: recipient.messagingIdentitySignatureVersion,
        messagingIdentitySignedAt: recipient.messagingIdentitySignedAt,
        profilePicUrl: recipient.profilePicUrl || null,
      },
    });
  } catch (error) {
    console.error('Error resolving messaging recipient:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function handleMessagingV2DirectoryLookup(req, res) {
  try {
    const userId = req.userId;
    const normalizedLightningAddress = normalizeLightningAddress(req.body?.lightningAddress);

    if (!normalizedLightningAddress) {
      return res.status(400).json({ error: 'lightningAddress is required' });
    }

    const sender = await User.findById(userId).select(
      '_id walletPubkey messagingPubkeyV2 lightningAddress messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt'
    );

    if (!sender) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sender.lightningAddress) {
      return res.status(409).json({ error: 'Sender lightningAddress is not set' });
    }

    if (!hasResolvedMessagingIdentityBinding(sender, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Sender messaging v2 identity is not registered' });
    }

    const recipient = await User.findOne({ lightningAddress: normalizedLightningAddress }).select(
      '_id walletPubkey lightningAddress messagingPubkeyV2 messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt messagingIdentityV2UpdatedAt profilePicUrl'
    );

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipient._id) === String(sender._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockState({
      requesterUserId: sender._id,
      targetUserId: recipient._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    if (!hasResolvedMessagingIdentityBinding(recipient, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Recipient messaging v2 is not active' });
    }

    const recipientBinding = buildResolvedMessagingIdentityBindingRecord(recipient, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    });
    await appendMessagingBindingLogEntry({
      userId: recipient._id,
      binding: recipientBinding,
    });
    const directory = await buildDirectoryProofForBinding(recipientBinding);

    return res.status(200).json({
      ok: true,
      recipient: {
        ...stripMessagingIdentityBindingV2(recipient),
        profilePicUrl: recipient.profilePicUrl || null,
      },
      directory,
    });
  } catch (error) {
    console.error('Error resolving messaging v2 recipient:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.post('/messaging/v2/resolve-recipient', userAuthMiddleware, handleMessagingV2DirectoryLookup);
router.post('/messaging/v2/directory/lookup', userAuthMiddleware, handleMessagingV2DirectoryLookup);
router.post('/messaging/v3/directory/lookup', userAuthMiddleware, handleMessagingV2DirectoryLookup);

router.get('/messaging/v3/device-registrations', userAuthMiddleware, async (req, res) => {
  try {
    const requestedEnvironment = req.query?.environment;
    const hasRequestedEnvironment = requestedEnvironment !== undefined &&
      requestedEnvironment !== null &&
      String(requestedEnvironment).trim() !== '';
    const environment = hasRequestedEnvironment
      ? normalizeMessagingEnvironment(requestedEnvironment)
      : currentMessagingPushEnvironment();

    if (!environment) {
      return res.status(400).json({ error: 'environment must be dev or prod' });
    }

    const user = await User.findById(req.userId).select('_id walletPubkey messagingPubkeyV2');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const activeMessagingPubkey = normalizeMessagingPubkey(user.messagingPubkeyV2);
    if (!activeMessagingPubkey) {
      return res.status(409).json({ error: 'Messaging v3 identity is not registered' });
    }

    const registrations = await MessagingDeviceRegistration.find({
      userId: user._id,
      messagingPubkey: activeMessagingPubkey,
      environment,
    })
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      ok: true,
      walletPubkey: user.walletPubkey,
      messagingPubkey: activeMessagingPubkey,
      environment,
      registrations: registrations.map(stripMessagingDeviceRegistration),
    });
  } catch (error) {
    console.error('Error fetching messaging v3 device registrations:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/v3/device-registrations', userAuthMiddleware, async (req, res) => {
  try {
    const normalized = normalizeAndValidateMessagingDeviceRegistration(req.body);
    if (normalized.errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: normalized.errors });
    }

    const registration = normalized.registration;
    const activeEnvironment = currentMessagingPushEnvironment();
    if (registration.environment !== activeEnvironment) {
      return res.status(409).json({
        error: `device registration environment mismatch (expected ${activeEnvironment})`,
      });
    }

    const user = await User.findById(req.userId).select(
      '_id walletPubkey lightningAddress messagingPubkeyV2 messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt'
    );
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!hasResolvedMessagingIdentityBinding(user, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Messaging v3 identity is not registered' });
    }

    if (normalizeWalletPubkey(user.walletPubkey).toLowerCase() !== registration.walletPubkey.toLowerCase()) {
      return res.status(403).json({ error: 'walletPubkey does not match the authenticated user' });
    }

    const activeMessagingPubkey = normalizeMessagingPubkey(user.messagingPubkeyV2);
    if (registration.messagingPubkey !== activeMessagingPubkey) {
      return res.status(409).json({ error: 'messagingPubkey does not match the active messaging identity' });
    }

    if (!verifyMessagingDeviceRegistration(registration)) {
      return res.status(401).json({ error: 'Invalid messaging device registration signature' });
    }

    const existing = await MessagingDeviceRegistration.findOne({
      environment: registration.environment,
      deviceToken: registration.deviceToken,
    });
    const now = new Date();
    const didUpdate = !existing ||
      String(existing.userId) !== String(user._id) ||
      existing.walletPubkey !== user.walletPubkey ||
      existing.messagingPubkey !== activeMessagingPubkey ||
      existing.platform !== registration.platform ||
      existing.registrationSignature !== registration.registrationSignature ||
      Number(existing.registrationSignatureVersion) !== registration.registrationSignatureVersion ||
      bindingSignedAtSeconds(existing.registrationSignedAt) !== registration.registrationSignedAt ||
      (existing.appVersion || null) !== registration.appVersion ||
      (existing.bundleId || null) !== registration.bundleId;

    const storedRegistration = await MessagingDeviceRegistration.findOneAndUpdate(
      {
        environment: registration.environment,
        deviceToken: registration.deviceToken,
      },
      {
        $set: {
          userId: user._id,
          walletPubkey: user.walletPubkey,
          messagingPubkey: activeMessagingPubkey,
          deviceToken: registration.deviceToken,
          platform: registration.platform,
          environment: registration.environment,
          registrationSignature: registration.registrationSignature,
          registrationSignatureVersion: registration.registrationSignatureVersion,
          registrationSignedAt: registration.registrationSignedAtDate,
          appVersion: registration.appVersion,
          bundleId: registration.bundleId,
          lastSeenAt: now,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    await deleteStaleMessagingDeviceRegistrations({
      userId: user._id,
      activeMessagingPubkey,
    });

    return res.status(200).json({
      ok: true,
      didUpdate,
      registration: stripMessagingDeviceRegistration(storedRegistration),
    });
  } catch (error) {
    console.error('Error registering messaging v3 device registration:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/v2/attachments/upload', userAuthMiddleware, attachmentUpload.single('attachment'), async (req, res) => {
  try {
    const file = req.file;

    if (!file || !file.buffer || !file.size) {
      return res.status(400).json({ error: 'attachment file is required' });
    }

    const sender = await User.findById(req.userId).select(
      '_id walletPubkey messagingPubkeyV2 lightningAddress messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt'
    );
    if (!sender) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!hasResolvedMessagingIdentityBinding(sender, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Sender messaging v2 identity is not registered' });
    }

    const normalized = normalizeAndValidateMessagingIdentityBinding(req.body, {
      expectedVersion: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    });

    if (normalized.errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: normalized.errors });
    }

    const recipientBinding = normalized.binding;
    if (!verifyMessagingIdentityBinding(recipientBinding)) {
      return res.status(401).json({ error: 'Recipient messaging v2 binding is invalid' });
    }

    const recipient = await User.findOne({ walletPubkey: recipientBinding.walletPubkey }).select(
      '_id walletPubkey lightningAddress messagingPubkeyV2 messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt'
    );

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipient._id) === String(sender._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockState({
      requesterUserId: sender._id,
      targetUserId: recipient._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    if (!hasResolvedMessagingIdentityBinding(recipient, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Recipient messaging v2 is not active' });
    }

    if (!resolvedBindingMatchesUser(recipient, recipientBinding, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Recipient messaging v2 binding is stale, resolve again' });
    }

    const objectKey = buildAttachmentObjectKey({ senderUserId: sender._id });

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/octet-stream',
    }));

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_HOURS * 60 * 60 * 1000);

    const attachment = await MessageAttachment.create({
      senderUserId: sender._id,
      recipientUserId: recipient._id,
      recipientLightningAddress: recipient.lightningAddress,
      objectKey,
      uploadContentType: file.mimetype || 'application/octet-stream',
      sizeBytes: file.size,
      status: 'uploaded',
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      attachment: stripAttachmentPayload(attachment),
    });
  } catch (error) {
    console.error('Error uploading messaging v2 attachment:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/attachments/upload', userAuthMiddleware, attachmentUpload.single('attachment'), async (req, res) => {
  try {
    const userId = req.userId;
    const normalizedRecipientAddress = normalizeLightningAddress(req.body?.recipientLightningAddress);
    const file = req.file;

    if (!normalizedRecipientAddress) {
      return res.status(400).json({ error: 'recipientLightningAddress is required' });
    }

    if (!file || !file.buffer || !file.size) {
      return res.status(400).json({ error: 'attachment file is required' });
    }

    const sender = await User.findById(userId).select('_id walletPubkey messagingPubkey lightningAddress');
    if (!sender) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sender.messagingPubkey) {
      return res.status(409).json({ error: 'Sender messaging identity is not registered' });
    }

    if (!sender.lightningAddress) {
      return res.status(409).json({ error: 'Sender lightningAddress is not set' });
    }

    const recipient = await User.findOne({ lightningAddress: normalizedRecipientAddress })
      .select('_id walletPubkey lightningAddress messagingPubkey');

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipient._id) === String(sender._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockState({
      requesterUserId: sender._id,
      targetUserId: recipient._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    if (!recipient.messagingPubkey) {
      return res.status(409).json({ error: 'Recipient messaging is not active' });
    }

    const objectKey = buildAttachmentObjectKey({ senderUserId: sender._id });

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'application/octet-stream',
    }));

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_HOURS * 60 * 60 * 1000);

    const attachment = await MessageAttachment.create({
      senderUserId: sender._id,
      recipientUserId: recipient._id,
      recipientLightningAddress: recipient.lightningAddress,
      objectKey,
      uploadContentType: file.mimetype || 'application/octet-stream',
      sizeBytes: file.size,
      status: 'uploaded',
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      attachment: stripAttachmentPayload(attachment),
    });
  } catch (error) {
    console.error('Error uploading messaging attachment:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/messaging/attachments/:attachmentId/download', userAuthMiddleware, async (req, res) => {
  try {
    const { attachmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(400).json({ error: 'attachmentId is invalid' });
    }

    const attachment = await MessageAttachment.findById(attachmentId).select(
      '_id senderUserId recipientUserId objectKey uploadContentType status linkedMessageId expiresAt deletedAt'
    );

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const isSender = String(attachment.senderUserId) === String(req.userId);
    const isRecipient = String(attachment.recipientUserId) === String(req.userId);

    if (!isSender && !isRecipient) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (isRecipient && !attachment.linkedMessageId) {
      return res.status(404).json({ error: 'Attachment is not available yet' });
    }

    if (attachment.deletedAt || attachment.status === 'deleted' || attachment.status === 'expired') {
      return res.status(410).json({ error: 'Attachment is no longer available' });
    }

    if (attachment.expiresAt && attachment.expiresAt <= new Date()) {
      if (attachment.objectKey) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: attachment.objectKey,
          }));
        } catch (cleanupError) {
          console.warn('Failed to cleanup expired attachment object:', cleanupError);
        }
      }

      attachment.status = 'expired';
      attachment.deletedAt = new Date();
      await attachment.save();
      return res.status(410).json({ error: 'Attachment has expired' });
    }

    const result = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: attachment.objectKey,
    }));

    res.setHeader('Content-Type', result.ContentType || attachment.uploadContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');

    if (result.ContentLength) {
      res.setHeader('Content-Length', String(result.ContentLength));
    }

    if (result.Body && typeof result.Body.pipe === 'function') {
      result.Body.pipe(res);
      return;
    }

    if (result.Body && typeof result.Body.transformToByteArray === 'function') {
      const bytes = await result.Body.transformToByteArray();
      return res.status(200).send(Buffer.from(bytes));
    }

    return res.status(500).json({ error: 'Attachment stream was unavailable' });
  } catch (error) {
    console.error('Error downloading messaging attachment:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/attachments/mark-received', userAuthMiddleware, async (req, res) => {
  try {
    const attachmentIds = normalizeAttachmentIds(req.body?.attachmentIds);

    if (!attachmentIds.length) {
      return res.status(400).json({ error: 'attachmentIds is required' });
    }

    const attachments = await MessageAttachment.find({
      _id: { $in: attachmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
      recipientUserId: req.userId,
      status: { $in: ['linked', 'uploaded'] },
    }).select('_id objectKey status receivedAt deletedAt');

    if (!attachments.length) {
      return res.status(200).json({ ok: true, updatedCount: 0 });
    }

    let updatedCount = 0;
    const now = new Date();

    for (const attachment of attachments) {
      if (attachment.objectKey) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: attachment.objectKey,
          }));
        } catch (deleteError) {
          console.warn('Failed to delete received attachment object:', deleteError);
        }
      }

      attachment.status = 'received';
      attachment.receivedAt = attachment.receivedAt || now;
      attachment.deletedAt = now;
      await attachment.save();
      updatedCount += 1;
    }

    return res.status(200).json({
      ok: true,
      updatedCount,
    });
  } catch (error) {
    console.error('Error marking messaging attachments received:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function handleMessagingV2LikeSend(req, res) {
  try {
    const userId = req.userId;
    const {
      clientMessageId,
      sender: senderIdentity,
      recipient,
      ciphertext,
      nonce,
      senderEphemeralPubkey,
      createdAtClient,
      createdAtClientMs,
      envelopeVersion,
      messageType,
      attachmentIds,
      senderEnvelopeSignature,
      senderEnvelopeSignatureVersion,
      sameKeyRetryCount,
    } = req.body || {};

    const sender = await User.findById(userId).select(
      '_id walletPubkey messagingPubkeyV2 lightningAddress messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt'
    );
    if (!sender) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!hasResolvedMessagingIdentityBinding(sender, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Sender messaging v2 identity is not registered' });
    }

    const errors = [];
    if (!clientMessageId || typeof clientMessageId !== 'string') errors.push('clientMessageId is required');
    if (!ciphertext || typeof ciphertext !== 'string') errors.push('ciphertext is required');
    if (!nonce || typeof nonce !== 'string') errors.push('nonce is required');
    if (!senderEphemeralPubkey || typeof senderEphemeralPubkey !== 'string') errors.push('senderEphemeralPubkey is required');
    const normalizedEnvelopeVersion = Number.isInteger(envelopeVersion) ? envelopeVersion : 1;
    const isSealedSenderEnvelope = normalizedEnvelopeVersion >= 3;
    const normalizedSenderEnvelopeSignature = normalizeSignature(senderEnvelopeSignature);
    const normalizedSenderEnvelopeSignatureVersion = parseIntegerValue(senderEnvelopeSignatureVersion);
    const normalizedCreatedAtClientMs = parseClientTimestampMs(createdAtClientMs ?? createdAtClient);
    if (!Number.isInteger(normalizedCreatedAtClientMs) || normalizedCreatedAtClientMs <= 0) {
      errors.push('createdAtClientMs is required');
    }
    const normalizedMessageType = typeof messageType === 'string'
      ? messageType.trim().toLowerCase()
      : 'text';
    if (!['text', 'payment_request', 'payment_request_paid', 'attachment', 'reaction'].includes(normalizedMessageType)) {
      errors.push('messageType must be text, payment_request, payment_request_paid, attachment, or reaction');
    }
    const normalizedAttachmentIds = normalizeAttachmentIds(attachmentIds);
    const normalizedSameKeyRetryCount = parseIntegerValue(sameKeyRetryCount);
    if (normalizedMessageType === 'attachment' && !normalizedAttachmentIds.length) {
      errors.push('attachmentIds is required for attachment messages');
    }
    if (normalizedMessageType !== 'attachment' && normalizedAttachmentIds.length) {
      errors.push('attachmentIds can only be provided for attachment messages');
    }
    if (normalizedSameKeyRetryCount != null &&
        (normalizedSameKeyRetryCount < 0 || normalizedSameKeyRetryCount > 1)) {
      errors.push('sameKeyRetryCount must be 0 or 1');
    }

    const normalizedRecipient = normalizeAndValidateMessagingIdentityBinding(recipient, {
      expectedVersion: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    });

    if (normalizedRecipient.errors.length) {
      errors.push(...normalizedRecipient.errors.map((entry) => `recipient.${entry}`));
    }

    let normalizedSender = null;
    if (!isSealedSenderEnvelope) {
      if (!normalizedSenderEnvelopeSignature) errors.push('senderEnvelopeSignature is required');
      if (normalizedSenderEnvelopeSignatureVersion !== MESSAGING_ENVELOPE_SIGNATURE_VERSION) {
        errors.push(`senderEnvelopeSignatureVersion must be ${MESSAGING_ENVELOPE_SIGNATURE_VERSION}`);
      }

      normalizedSender = normalizeAndValidateMessagingIdentityBinding(senderIdentity, {
        expectedVersion: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
      });

      if (normalizedSender.errors.length) {
        errors.push(...normalizedSender.errors.map((entry) => `sender.${entry}`));
      }
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const recipientBinding = normalizedRecipient.binding;
    if (!verifyMessagingIdentityBinding(recipientBinding)) {
      return res.status(401).json({ error: 'Recipient messaging v2 binding is invalid' });
    }

    const senderBinding = buildResolvedMessagingIdentityBindingRecord(sender, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    });

    if (!isSealedSenderEnvelope) {
      if (!verifyMessagingIdentityBinding(normalizedSender.binding)) {
        return res.status(401).json({ error: 'Sender messaging v2 binding is invalid' });
      }

      if (!resolvedBindingMatchesUser(sender, normalizedSender.binding, {
        version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
      })) {
        return res.status(409).json({ error: 'Sender messaging v2 binding is stale, register again' });
      }
    }

    const recipientUser = await User.findOne({ walletPubkey: recipientBinding.walletPubkey }).select(
      '_id walletPubkey lightningAddress messagingPubkeyV2 messagingIdentityV2Signature messagingIdentityV2SignatureVersion messagingIdentityV2SignedAt'
    );

    if (!recipientUser) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipientUser._id) === String(sender._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockState({
      requesterUserId: sender._id,
      targetUserId: recipientUser._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    if (!hasResolvedMessagingIdentityBinding(recipientUser, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Recipient messaging v2 is not active' });
    }

    if (!resolvedBindingMatchesUser(recipientUser, recipientBinding, {
      version: MESSAGING_IDENTITY_V2_SIGNATURE_VERSION,
    })) {
      return res.status(409).json({ error: 'Recipient messaging v2 binding is stale, resolve again' });
    }

    if (!isSealedSenderEnvelope) {
      if (!verifyMessagingEnvelopeSignature({
        senderBinding: normalizedSender.binding,
        recipientBinding,
        clientMessageId: clientMessageId.trim(),
        ciphertext: ciphertext.trim(),
        nonce: nonce.trim(),
        senderEphemeralPubkey: senderEphemeralPubkey.trim(),
        createdAtClientMs: normalizedCreatedAtClientMs,
        envelopeVersion: normalizedEnvelopeVersion,
        messageType: normalizedMessageType,
        senderEnvelopeSignature: normalizedSenderEnvelopeSignature,
        senderEnvelopeSignatureVersion: normalizedSenderEnvelopeSignatureVersion,
      })) {
        return res.status(401).json({ error: 'Sender message envelope signature is invalid' });
      }
    }

    let attachmentsToLink = [];
    if (normalizedAttachmentIds.length) {
      attachmentsToLink = await MessageAttachment.find({
        _id: { $in: normalizedAttachmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
        senderUserId: sender._id,
        recipientUserId: recipientUser._id,
        recipientLightningAddress: recipientUser.lightningAddress,
        status: 'uploaded',
      }).select('_id');

      if (attachmentsToLink.length !== normalizedAttachmentIds.length) {
        return res.status(409).json({ error: 'One or more attachments are invalid, stale, or already linked' });
      }
    }

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_HOURS * 60 * 60 * 1000);

    const directMessage = await DirectMessage.create({
      senderUserId: sender._id,
      senderWalletPubkey: senderBinding.walletPubkey,
      senderMessagingPubkey: senderBinding.messagingPubkey,
      senderLightningAddress: senderBinding.lightningAddress,
      senderMessagingIdentitySignature: isSealedSenderEnvelope ? null : normalizedSender.binding.messagingIdentitySignature,
      senderMessagingIdentitySignatureVersion: isSealedSenderEnvelope ? null : normalizedSender.binding.messagingIdentitySignatureVersion,
      senderMessagingIdentitySignedAt: isSealedSenderEnvelope ? null : normalizedSender.binding.messagingIdentitySignedAtDate,
      senderEnvelopeSignature: isSealedSenderEnvelope ? null : normalizedSenderEnvelopeSignature,
      senderEnvelopeSignatureVersion: isSealedSenderEnvelope ? null : normalizedSenderEnvelopeSignatureVersion,
      recipientUserId: recipientUser._id,
      recipientWalletPubkey: recipientUser.walletPubkey,
      recipientLightningAddress: recipientUser.lightningAddress,
      recipientMessagingPubkey: recipientUser.messagingPubkeyV2,
      clientMessageId: clientMessageId.trim(),
      messageType: normalizedMessageType,
      status: 'pending',
      sameKeyRetryCount: normalizedSameKeyRetryCount ?? 0,
      envelopeVersion: normalizedEnvelopeVersion,
      ciphertext: ciphertext.trim(),
      nonce: nonce.trim(),
      senderEphemeralPubkey: senderEphemeralPubkey.trim(),
      createdAtClient: new Date(normalizedCreatedAtClientMs),
      expiresAt,
    });

    if (attachmentsToLink.length) {
      const directMessageId = directMessage._id;
      await MessageAttachment.updateMany(
        { _id: { $in: attachmentsToLink.map((attachment) => attachment._id) } },
        {
          $set: {
            status: 'linked',
            linkedMessageId: directMessageId,
            linkedClientMessageId: directMessage.clientMessageId,
          },
        }
      );
    }

    await sendPushNotificationsForDirectMessage({
      directMessage,
      recipientUserId: recipientUser._id,
    });

    return res.status(200).json({
      ok: true,
      message: {
        messageId: String(directMessage._id),
        clientMessageId: directMessage.clientMessageId,
        recipientWalletPubkey: directMessage.recipientWalletPubkey,
        recipientMessagingPubkey: directMessage.recipientMessagingPubkey,
        recipientLightningAddress: directMessage.recipientLightningAddress,
        status: directMessage.status,
        createdAt: directMessage.createdAt,
        createdAtClient: directMessage.createdAtClient,
      },
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const existing = await DirectMessage.findOne({
        senderUserId: req.userId,
        clientMessageId: req.body?.clientMessageId,
      }).lean();

      if (existing) {
        return res.status(200).json({
          ok: true,
          deduped: true,
          message: {
            messageId: String(existing._id),
            clientMessageId: existing.clientMessageId,
            recipientWalletPubkey: existing.recipientWalletPubkey,
            recipientMessagingPubkey: existing.recipientMessagingPubkey,
            recipientLightningAddress: existing.recipientLightningAddress,
            status: existing.status,
            createdAt: existing.createdAt,
            createdAtClient: existing.createdAtClient,
          },
        });
      }
    }

    console.error('Error sending messaging v2 message:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.post('/messaging/v2/send', userAuthMiddleware, handleMessagingV2LikeSend);
router.post('/messaging/v3/send', userAuthMiddleware, handleMessagingV2LikeSend);

router.post('/messaging/send', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const {
      clientMessageId,
      recipientLightningAddress,
      recipientMessagingPubkey,
      ciphertext,
      nonce,
      senderEphemeralPubkey,
      createdAtClient,
      envelopeVersion,
      messageType,
      attachmentIds,
      sameKeyRetryCount,
    } = req.body || {};

    const sender = await User.findById(userId).select('_id walletPubkey messagingPubkey lightningAddress');
    if (!sender) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sender.messagingPubkey) {
      return res.status(409).json({ error: 'Sender messaging identity is not registered' });
    }

    if (!sender.lightningAddress) {
      return res.status(409).json({ error: 'Sender lightningAddress is not set' });
    }

    const normalizedRecipientAddress = normalizeLightningAddress(recipientLightningAddress);

    const errors = [];
    if (!clientMessageId || typeof clientMessageId !== 'string') errors.push('clientMessageId is required');
    if (!normalizedRecipientAddress) errors.push('recipientLightningAddress is required');
    if (!recipientMessagingPubkey || typeof recipientMessagingPubkey !== 'string') errors.push('recipientMessagingPubkey is required');
    if (!ciphertext || typeof ciphertext !== 'string') errors.push('ciphertext is required');
    if (!nonce || typeof nonce !== 'string') errors.push('nonce is required');
    if (!senderEphemeralPubkey || typeof senderEphemeralPubkey !== 'string') errors.push('senderEphemeralPubkey is required');
    const normalizedMessageType = typeof messageType === 'string'
      ? messageType.trim().toLowerCase()
      : 'text';
    if (!['text', 'payment_request', 'payment_request_paid', 'attachment', 'reaction'].includes(normalizedMessageType)) {
      errors.push('messageType must be text, payment_request, payment_request_paid, attachment, or reaction');
    }
    const normalizedAttachmentIds = normalizeAttachmentIds(attachmentIds);
    const normalizedSameKeyRetryCount = parseIntegerValue(sameKeyRetryCount);
    if (normalizedMessageType === 'attachment' && !normalizedAttachmentIds.length) {
      errors.push('attachmentIds is required for attachment messages');
    }
    if (normalizedMessageType !== 'attachment' && normalizedAttachmentIds.length) {
      errors.push('attachmentIds can only be provided for attachment messages');
    }
    if (normalizedSameKeyRetryCount != null &&
        (normalizedSameKeyRetryCount < 0 || normalizedSameKeyRetryCount > 1)) {
      errors.push('sameKeyRetryCount must be 0 or 1');
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Invalid request', details: errors });
    }

    const recipient = await User.findOne({ lightningAddress: normalizedRecipientAddress })
      .select('_id walletPubkey lightningAddress messagingPubkey');

    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (String(recipient._id) === String(sender._id)) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const blockError = buildMessagingBlockError(await getMessagingBlockState({
      requesterUserId: sender._id,
      targetUserId: recipient._id,
    }));
    if (blockError) {
      return res.status(blockError.status).json({ error: blockError.error });
    }

    if (!recipient.messagingPubkey) {
      return res.status(409).json({ error: 'Recipient messaging is not active' });
    }

    if (recipient.messagingPubkey !== recipientMessagingPubkey.trim()) {
      return res.status(409).json({ error: 'Recipient messaging key is stale, resolve again' });
    }

    let attachmentsToLink = [];
    if (normalizedAttachmentIds.length) {
      attachmentsToLink = await MessageAttachment.find({
        _id: { $in: normalizedAttachmentIds.map((id) => new mongoose.Types.ObjectId(id)) },
        senderUserId: sender._id,
        recipientUserId: recipient._id,
        recipientLightningAddress: recipient.lightningAddress,
        status: 'uploaded',
      }).select('_id');

      if (attachmentsToLink.length !== normalizedAttachmentIds.length) {
        return res.status(409).json({ error: 'One or more attachments are invalid, stale, or already linked' });
      }
    }

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_HOURS * 60 * 60 * 1000);

    const directMessage = await DirectMessage.create({
      senderUserId: sender._id,
      senderWalletPubkey: sender.walletPubkey,
      senderMessagingPubkey: sender.messagingPubkey,
      senderLightningAddress: sender.lightningAddress || null,
      recipientUserId: recipient._id,
      recipientWalletPubkey: recipient.walletPubkey,
      recipientLightningAddress: recipient.lightningAddress,
      recipientMessagingPubkey: recipient.messagingPubkey,
      clientMessageId: clientMessageId.trim(),
      messageType: normalizedMessageType,
      status: 'pending',
      sameKeyRetryCount: normalizedSameKeyRetryCount ?? 0,
      envelopeVersion: Number.isInteger(envelopeVersion) ? envelopeVersion : 1,
      ciphertext: ciphertext.trim(),
      nonce: nonce.trim(),
      senderEphemeralPubkey: senderEphemeralPubkey.trim(),
      createdAtClient: createdAtClient ? new Date(createdAtClient) : null,
      expiresAt,
    });

    if (attachmentsToLink.length) {
      await MessageAttachment.updateMany(
        {
          _id: { $in: attachmentsToLink.map((attachment) => attachment._id) },
        },
        {
          $set: {
            status: 'linked',
            linkedMessageId: directMessage._id,
            linkedClientMessageId: clientMessageId.trim(),
          },
        }
      );
    }

    void sendPushNotificationsForDirectMessage({
      directMessage,
      recipientUserId: recipient._id,
    });

    return res.status(200).json({
      ok: true,
      message: stripDirectMessagePayload(directMessage),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const existing = await DirectMessage.findOne({
        senderUserId: req.userId,
        clientMessageId: String(req.body?.clientMessageId || '').trim(),
      });

      return res.status(200).json({
        ok: true,
        message: existing ? stripDirectMessagePayload(existing) : null,
        deduped: true,
      });
    }

    console.error('Error sending direct message:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/messaging/inbox', userAuthMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findById(userId).select('_id messagingPubkey');

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!user.messagingPubkey) {
      return res.status(409).json({ error: 'Messaging identity is not registered' });
    }

    const messages = await DirectMessage.find({
      recipientUserId: user._id,
      recipientMessagingPubkey: user.messagingPubkey,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      ok: true,
      messages: messages.map(stripDirectMessagePayload),
    });
  } catch (error) {
    console.error('Error fetching messaging inbox:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function handleMessagingV2LikeInbox(req, res) {
  try {
    const user = await User.findById(req.userId).select('_id messagingPubkey messagingPubkeyV2');

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const acceptedRecipientMessagingPubkeys = buildAcceptedRecipientMessagingPubkeys(user, {
      requireV2: true,
    });
    if (!acceptedRecipientMessagingPubkeys.length) {
      return res.status(409).json({ error: 'Messaging v2 identity is not registered' });
    }

    const messages = await DirectMessage.find({
      recipientUserId: user._id,
      recipientMessagingPubkey: { $in: acceptedRecipientMessagingPubkeys },
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      ok: true,
      messages: messages.map(stripDirectMessagePayload),
    });
  } catch (error) {
    console.error('Error fetching messaging v2 inbox:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.get('/messaging/v2/inbox', userAuthMiddleware, handleMessagingV2LikeInbox);
router.get('/messaging/v3/inbox', userAuthMiddleware, handleMessagingV2LikeInbox);

async function handleLegacyMessagingAck(req, res) {
  try {
    const user = await User.findById(req.userId).select('_id messagingPubkey');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!user.messagingPubkey) {
      return res.status(409).json({ error: 'Messaging identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const now = new Date();
    const result = await DirectMessage.updateMany(
      {
        _id: { $in: objectIds },
        recipientUserId: user._id,
        recipientMessagingPubkey: user.messagingPubkey,
        status: 'pending',
      },
      {
        $set: {
          status: 'delivered',
          deliveredAt: now,
        },
        $unset: {
          ciphertext: '',
          nonce: '',
          senderEphemeralPubkey: '',
        },
      }
    );

    return res.status(200).json({
      ok: true,
      acknowledgedCount: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error('Error acknowledging direct messages:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.post('/messaging/ack', userAuthMiddleware, handleLegacyMessagingAck);

async function handleMessagingV2LikeAck(req, res) {
  try {
    const user = await User.findById(req.userId).select('_id messagingPubkey messagingPubkeyV2');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const acceptedRecipientMessagingPubkeys = buildAcceptedRecipientMessagingPubkeys(user, {
      requireV2: true,
    });
    if (!acceptedRecipientMessagingPubkeys.length) {
      return res.status(409).json({ error: 'Messaging v2 identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const now = new Date();
    const result = await DirectMessage.updateMany(
      {
        _id: { $in: objectIds },
        recipientUserId: user._id,
        recipientMessagingPubkey: { $in: acceptedRecipientMessagingPubkeys },
        status: 'pending',
      },
      {
        $set: {
          status: 'delivered',
          deliveredAt: now,
        },
        $unset: {
          ciphertext: '',
          nonce: '',
          senderEphemeralPubkey: '',
        },
      }
    );

    return res.status(200).json({
      ok: true,
      acknowledgedCount: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error('Error acknowledging direct v2 messages:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.post('/messaging/v2/ack', userAuthMiddleware, handleMessagingV2LikeAck);
router.post('/messaging/v3/ack', userAuthMiddleware, handleMessagingV2LikeAck);

router.post('/messaging/v3/rekey-required', userAuthMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('_id messagingPubkey messagingPubkeyV2');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const acceptedRecipientMessagingPubkeys = buildAcceptedRecipientMessagingPubkeys(user, {
      requireV2: true,
    });
    if (!acceptedRecipientMessagingPubkeys.length) {
      return res.status(409).json({ error: 'Messaging v2 identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const now = new Date();
    const pendingMessages = await DirectMessage.find({
      _id: { $in: objectIds },
      recipientUserId: user._id,
      recipientMessagingPubkey: { $in: acceptedRecipientMessagingPubkeys },
      status: 'pending',
    }).select('_id senderUserId recipientWalletPubkey');

    if (!pendingMessages.length) {
      return res.status(200).json({
        ok: true,
        updatedCount: 0,
        resetAttachmentCount: 0,
      });
    }

    const messageIdsToUpdate = pendingMessages.map((message) => message._id);
    const [messageUpdateResult, attachmentResetResult] = await Promise.all([
      DirectMessage.updateMany(
        {
          _id: { $in: messageIdsToUpdate },
          status: 'pending',
        },
        {
          $set: {
            status: 'rekey_required',
            rekeyRequiredAt: now,
          },
          $unset: {
            ciphertext: '',
            nonce: '',
            senderEphemeralPubkey: '',
          },
        }
      ),
      MessageAttachment.updateMany(
        {
          linkedMessageId: { $in: messageIdsToUpdate },
          recipientUserId: user._id,
          status: 'linked',
        },
        {
          $set: {
            status: 'uploaded',
          },
          $unset: {
            linkedMessageId: '',
            linkedClientMessageId: '',
          },
        }
      ),
    ]);

    void sendOutgoingStatusPushNotifications({
      directMessages: pendingMessages,
    }).catch((pushError) => {
      console.warn('Failed to send messaging rekey-required push notifications:', pushError);
    });

    return res.status(200).json({
      ok: true,
      updatedCount: messageUpdateResult.modifiedCount || 0,
      resetAttachmentCount: attachmentResetResult.modifiedCount || 0,
    });
  } catch (error) {
    console.error('Error marking messaging messages rekey-required:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/messaging/v3/decrypt-failed', userAuthMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('_id messagingPubkey messagingPubkeyV2');
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const acceptedRecipientMessagingPubkeys = buildAcceptedRecipientMessagingPubkeys(user, {
      requireV2: true,
    });
    if (!acceptedRecipientMessagingPubkeys.length) {
      return res.status(409).json({ error: 'Messaging v2 identity is not registered' });
    }

    const objectIds = normalizeDirectMessageObjectIds(req.body?.messageIds);
    if (!objectIds.length) {
      return res.status(400).json({ error: 'No valid messageIds were provided' });
    }

    const now = new Date();
    const pendingMessages = await DirectMessage.find({
      _id: { $in: objectIds },
      recipientUserId: user._id,
      recipientMessagingPubkey: { $in: acceptedRecipientMessagingPubkeys },
      status: 'pending',
    }).select('_id senderUserId recipientWalletPubkey sameKeyRetryCount');

    if (!pendingMessages.length) {
      return res.status(200).json({
        ok: true,
        retryRequiredCount: 0,
        failedCount: 0,
        resetAttachmentCount: 0,
      });
    }

    const retryRequiredMessageIds = pendingMessages
      .filter((message) => Number(message.sameKeyRetryCount || 0) < 1)
      .map((message) => message._id);
    const failedMessageIds = pendingMessages
      .filter((message) => Number(message.sameKeyRetryCount || 0) >= 1)
      .map((message) => message._id);
    const allMessageIds = pendingMessages.map((message) => message._id);

    const updateOperations = [];

    if (retryRequiredMessageIds.length) {
      updateOperations.push(
        DirectMessage.updateMany(
          {
            _id: { $in: retryRequiredMessageIds },
            status: 'pending',
          },
          {
            $set: {
              status: 'same_key_retry_required',
              sameKeyRetryCount: 1,
              sameKeyDecryptFailedAt: now,
            },
            $unset: {
              ciphertext: '',
              nonce: '',
              senderEphemeralPubkey: '',
              deliveredAt: '',
              rekeyRequiredAt: '',
              failedAt: '',
              expiredAt: '',
            },
          }
        )
      );
    }

    if (failedMessageIds.length) {
      updateOperations.push(
        DirectMessage.updateMany(
          {
            _id: { $in: failedMessageIds },
            status: 'pending',
          },
          {
            $set: {
              status: 'failed_same_key',
              sameKeyDecryptFailedAt: now,
              failedAt: now,
            },
            $unset: {
              ciphertext: '',
              nonce: '',
              senderEphemeralPubkey: '',
              deliveredAt: '',
              rekeyRequiredAt: '',
              expiredAt: '',
            },
          }
        )
      );
    }

    updateOperations.push(
      MessageAttachment.updateMany(
        {
          linkedMessageId: { $in: allMessageIds },
          recipientUserId: user._id,
          status: 'linked',
        },
        {
          $set: {
            status: 'uploaded',
          },
          $unset: {
            linkedMessageId: '',
            linkedClientMessageId: '',
          },
        }
      )
    );

    const updateResults = await Promise.all(updateOperations);
    const attachmentResetResult = updateResults[updateResults.length - 1];

    void sendOutgoingStatusPushNotifications({
      directMessages: pendingMessages,
    }).catch((pushError) => {
      console.warn('Failed to send messaging outgoing-status push notifications:', pushError);
    });

    return res.status(200).json({
      ok: true,
      retryRequiredCount: retryRequiredMessageIds.length,
      failedCount: failedMessageIds.length,
      resetAttachmentCount: attachmentResetResult.modifiedCount || 0,
    });
  } catch (error) {
    console.error('Error marking messaging messages decrypt-failed:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function handleOutgoingMessagingStatuses(req, res) {
  try {
    const user = await User.findById(req.userId).select('_id');

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);

    const messages = await DirectMessage.find({ senderUserId: user._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      ok: true,
      messages: messages.map(stripOutgoingDirectMessageStatus),
    });
  } catch (error) {
    console.error('Error fetching outgoing messaging statuses:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

router.get('/messaging/outgoing-statuses', userAuthMiddleware, handleOutgoingMessagingStatuses);
router.get('/messaging/v3/outgoing-statuses', userAuthMiddleware, handleOutgoingMessagingStatuses);

module.exports = router;
