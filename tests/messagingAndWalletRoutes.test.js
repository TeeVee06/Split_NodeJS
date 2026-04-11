const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const mongoose = require('mongoose');

process.env.secretKey = process.env.secretKey || 'split-backend-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const UserBlock = require('../models/UserBlock');
const DirectMessage = require('../models/DirectMessage');
const MessageAttachment = require('../models/MessageAttachment');
const MessagingDeviceRegistration = require('../models/MessagingDeviceRegistration');
const BitcoinPurchase = require('../models/BitcoinPurchase');
const MoonPayPurchase = require('../models/MoonPayPurchase');
const POSFeedPost = require('../models/POSFeedPost');
const POSFeedPostReport = require('../models/POSFeedPostReport');
const RewardSpend = require('../models/RewardSpend');
const s3Client = require('../integrations/r2');
const sessionHelper = require('../auth/sessionHelper');
const { createMoonPayStateToken, verifyMoonPayStateToken } = require('../payments/moonPayHelpers');
const iOSEndPoints = require('../routes/iOSEndPoints');
const MessageEndPoints = require('../routes/MessageEndPoints');
const POSFeedEndpoints = require('../routes/POSFeedEndpoints');

function createJsonApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(iOSEndPoints);
  app.use(MessageEndPoints);
  app.use(POSFeedEndpoints);
  return app;
}

async function withServer(run) {
  const app = createJsonApp();
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a valid address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseUrl });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function maybeWithServer(t, run) {
  try {
    await withServer(run);
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('Local socket binding is not permitted in this environment.');
      return;
    }

    throw error;
  }
}

function authCookie(userId, pubkey = null) {
  const token = jwt.sign(
    pubkey ? { userId, pubkey } : { userId },
    process.env.secretKey,
    { expiresIn: '1h' }
  );

  return `jwtToken=${token}`;
}

function queryResult(value) {
  return {
    select: async () => value,
  };
}

function querySelectLeanResult(value) {
  return {
    select() {
      return {
        lean: async () => value,
      };
    },
  };
}

function queryLeanResult(value) {
  return {
    lean: async () => value,
  };
}

function buildUser(overrides = {}) {
  return {
    _id: 'user-1',
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lightningAddress: null,
    messagingPubkey: null,
    messagingIdentitySignature: null,
    messagingIdentitySignatureVersion: null,
    messagingIdentitySignedAt: null,
    messagingIdentityUpdatedAt: null,
    messagingPubkeyV2: null,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    ...overrides,
  };
}

function withPatchedMethods(patches, fn) {
  const originals = patches.map(({ target, key }) => ({
    target,
    key,
    value: target[key],
  }));

  patches.forEach(({ target, key, value }) => {
    target[key] = value;
  });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      originals.forEach(({ target, key, value }) => {
        target[key] = value;
      });
    });
}

function queryChainResult(value) {
  return {
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value,
  };
}

test('POST /lightning-address saves a normalized address for a user who does not have one yet', async (t) => {
  const user = buildUser();

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/lightning-address`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: '  Donate@Example.com ',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.lightningAddress, 'donate@example.com');
      assert.equal(user.lightningAddress, 'donate@example.com');
      assert.equal(user.saveCalls, 1);
    });
  });
});

test('POST /lightning-address is a no-op when the user already has one', async (t) => {
  const user = buildUser({
    lightningAddress: 'donate@example.com',
  });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/lightning-address`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: 'other@example.com',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.didUpdate, false);
      assert.equal(body.lightningAddress, 'donate@example.com');
      assert.equal(user.saveCalls, 0);
    });
  });
});

test('GET /rewards-version-check returns the enforced minimum version by default', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, '3.6.1');
  });
});

test('GET /rewards-version-check returns the enforced iOS minimum version when platform=ios', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check?platform=ios`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, '3.6.1');
  });
});

test('GET /rewards-version-check returns the enforced Android minimum version when platform=android', async (t) => {
  await maybeWithServer(t, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/rewards-version-check?platform=android`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.minimumVersion, '0.1.1');
  });
});

test('POST /messaging-key rejects an invalid wallet signature', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
  });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => false },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging-key`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          lightningAddress: user.lightningAddress,
          messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          messagingIdentitySignature: 'deadbeef',
          messagingIdentitySignatureVersion: 1,
          messagingIdentitySignedAt: 1_712_000_000,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 401);
      assert.equal(body.error, 'Invalid messaging key signature');
    });
  });
});

test('POST /moonpay/prepare-buy returns a signed redirect URL for the authenticated wallet', async (t) => {
  const user = buildUser();

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/moonpay/prepare-buy`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lockedAmountSats: 125000,
          estimatedSpendAmountCents: 8450,
        }),
      });

      const body = await response.json();
      const redirectUrl = new URL(body.redirectUrl);
      const state = redirectUrl.searchParams.get('state');
      const verified = verifyMoonPayStateToken(state, { secret: process.env.secretKey });

      assert.equal(response.status, 200);
      assert.equal(redirectUrl.pathname, '/moonpay-return');
      assert.equal(verified.walletPubkey, user.walletPubkey);
      assert.equal(verified.lockedAmountSats, 125000);
      assert.equal(verified.estimatedSpendAmountCents, 8450);
    });
  });
});

test('GET /moonpay-return logs a pending MoonPay purchase from a valid signed state', async (t) => {
  const user = buildUser();
  const loggedPurchases = [];
  const { token } = createMoonPayStateToken({
    walletPubkey: user.walletPubkey,
    lockedAmountSats: 75000,
    estimatedSpendAmountCents: 5100,
    secret: process.env.secretKey,
  });

  await withPatchedMethods([
    {
      target: MoonPayPurchase,
      key: 'findOneAndUpdate',
      value: async (filter, update) => {
        loggedPurchases.push({ filter, update });
        return { moonpayTransactionId: filter.moonpayTransactionId };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(
        `${baseUrl}/moonpay-return?state=${encodeURIComponent(token)}&transactionId=mp_tx_123&transactionStatus=pending`
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didLogPurchase, true);
      assert.equal(body.transactionStatus, 'pending');
      assert.equal(body.lockedAmountSats, 75000);
      assert.equal(loggedPurchases.length, 1);
      assert.equal(loggedPurchases[0].filter.moonpayTransactionId, 'mp_tx_123');
      assert.equal(loggedPurchases[0].update.$setOnInsert.walletPubkey, user.walletPubkey);
      assert.equal(loggedPurchases[0].update.$setOnInsert.lockedAmountSats, 75000);
      assert.equal(loggedPurchases[0].update.$setOnInsert.rewardAmountCents, 510);
    });
  });
});

test('POST /reward_onRamp_buy falls back to a single matching MoonPay purchase when no Stripe txid exists', async (t) => {
  const user = buildUser();
  const rewardUpdates = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: BitcoinPurchase, key: 'findOne', value: () => querySelectLeanResult(null) },
    {
      target: MoonPayPurchase,
      key: 'find',
      value: () => queryChainResult([{ _id: 'moonpay-1', rewardAmountCents: 875 }]),
    },
    {
      target: MoonPayPurchase,
      key: 'findOneAndUpdate',
      value: () => ({ lean: async () => ({ rewardAmountCents: 875 }) }),
    },
    {
      target: RewardSpend,
      key: 'findOneAndUpdate',
      value: async (filter, update) => {
        rewardUpdates.push({ filter, update });
        return {};
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/reward_onRamp_buy`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          txid: 'claim-tx-1',
          depositAmountSats: 75000,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.rewardSpendApplied, true);
      assert.equal(body.rewardSource, 'moonpay');
      assert.equal(body.rewardAmountCents, 875);
      assert.equal(rewardUpdates.length, 1);
      assert.equal(rewardUpdates[0].filter.userId, String(user._id));
      assert.equal(rewardUpdates[0].update.$inc.purchaseSpend, 875);
    });
  });
});

test('POST /messaging-key stores the legacy messaging identity when the signature is valid', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
  });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging-key`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          lightningAddress: user.lightningAddress,
          messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          messagingIdentitySignature: 'deadbeef',
          messagingIdentitySignatureVersion: 1,
          messagingIdentitySignedAt: 1_712_000_000,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.didRotate, false);
      assert.equal(user.messagingPubkey, '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      assert.equal(user.messagingIdentitySignature, 'deadbeef');
      assert.equal(user.messagingIdentitySignatureVersion, 1);
      assert.equal(Math.floor(user.messagingIdentitySignedAt.getTime() / 1000), 1_712_000_000);
      assert.equal(user.saveCalls, 1);
    });
  });
});

test('POST /messaging/resolve-recipient returns the signed recipient bundle when both sides are active', async (t) => {
  const sender = buildUser({
    _id: 'sender-1',
    lightningAddress: 'alice@example.com',
    messagingPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentitySignature: 'sender-signature',
    messagingIdentitySignatureVersion: 1,
    messagingIdentitySignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const recipient = buildUser({
    _id: 'recipient-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'bob@example.com',
    messagingPubkey: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    messagingIdentitySignature: 'recipient-signature',
    messagingIdentitySignatureVersion: 1,
    messagingIdentitySignedAt: new Date('2026-01-02T00:00:00.000Z'),
    profilePicUrl: 'https://cdn.example.invalid/bob.png',
  });

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: (id) => queryResult(String(id) === String(sender._id) ? sender : null),
    },
    {
      target: User,
      key: 'findOne',
      value: ({ lightningAddress }) => queryResult(
        lightningAddress === recipient.lightningAddress ? recipient : null
      ),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/resolve-recipient`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(sender._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: recipient.lightningAddress,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.recipient.walletPubkey, recipient.walletPubkey);
      assert.equal(body.recipient.lightningAddress, recipient.lightningAddress);
      assert.equal(body.recipient.messagingPubkey, recipient.messagingPubkey);
      assert.equal(body.recipient.profilePicUrl, recipient.profilePicUrl);
    });
  });
});

test('POST /messaging/blocks creates a block by lightningAddress and clears pending relay messages', async (t) => {
  const blocker = buildUser({
    _id: 'blocker-1',
    lightningAddress: 'alice@example.com',
  });
  const target = buildUser({
    _id: 'blocked-1',
    walletPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lightningAddress: 'bob@example.com',
    profilePicUrl: 'https://cdn.example.invalid/bob.png',
  });
  const deletedMessageFilters = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(blocker) },
    {
      target: User,
      key: 'findOne',
      value: ({ lightningAddress, walletPubkey }) => queryResult(
        lightningAddress === target.lightningAddress || walletPubkey === target.walletPubkey
          ? target
          : null
      ),
    },
    { target: UserBlock, key: 'findOne', value: () => null },
    {
      target: UserBlock,
      key: 'create',
      value: async (payload) => ({
        _id: 'block-1',
        createdAt: new Date('2026-04-08T12:00:00.000Z'),
        updatedAt: new Date('2026-04-08T12:00:00.000Z'),
        ...payload,
      }),
    },
    {
      target: DirectMessage,
      key: 'find',
      value: () => queryResult([{ _id: 'msg-1' }]),
    },
    {
      target: DirectMessage,
      key: 'deleteMany',
      value: async (filter) => {
        deletedMessageFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
    {
      target: MessageAttachment,
      key: 'find',
      value: () => queryResult([]),
    },
    {
      target: MessageAttachment,
      key: 'deleteMany',
      value: async () => ({ deletedCount: 0 }),
    },
    {
      target: s3Client,
      key: 'send',
      value: async () => ({}),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/blocks`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(blocker._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: target.lightningAddress,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.block.blockedWalletPubkey, target.walletPubkey);
      assert.equal(body.block.blockedLightningAddress, target.lightningAddress);
      assert.equal(body.block.blockedProfilePicUrl, target.profilePicUrl);
      assert.equal(deletedMessageFilters.length, 1);
      assert.equal(deletedMessageFilters[0].status, 'pending');
      assert.equal(deletedMessageFilters[0]._id.$in.length, 1);
    });
  });
});

test('GET /messaging/blocks returns the authenticated users block list', async (t) => {
  const blocker = buildUser({
    _id: 'blocker-1',
  });
  const storedBlocks = [
    {
      _id: 'block-1',
      blockerUserId: blocker._id,
      blockedUserId: 'blocked-1',
      blockedWalletPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      blockedLightningAddress: 'bob@example.com',
      blockedProfilePicUrl: 'https://cdn.example.invalid/bob.png',
      createdAt: new Date('2026-04-08T12:00:00.000Z'),
      updatedAt: new Date('2026-04-08T12:00:00.000Z'),
    },
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(blocker) },
    { target: UserBlock, key: 'find', value: () => queryChainResult(storedBlocks) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/blocks`, {
        headers: {
          Cookie: authCookie(String(blocker._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.blocks.length, 1);
      assert.equal(body.blocks[0].blockedWalletPubkey, storedBlocks[0].blockedWalletPubkey);
      assert.equal(body.blocks[0].blockedLightningAddress, storedBlocks[0].blockedLightningAddress);
    });
  });
});

test('DELETE /messaging/blocks/:blockedWalletPubkey removes a block idempotently', async (t) => {
  const blocker = buildUser({
    _id: 'blocker-1',
  });
  const deleteFilters = [];
  const blockedWalletPubkey = '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(blocker) },
    {
      target: UserBlock,
      key: 'deleteOne',
      value: async (filter) => {
        deleteFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/blocks/${blockedWalletPubkey}`, {
        method: 'DELETE',
        headers: {
          Cookie: authCookie(String(blocker._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didDelete, true);
      assert.equal(body.blockedWalletPubkey, blockedWalletPubkey);
      assert.equal(deleteFilters.length, 1);
      assert.equal(deleteFilters[0].blockerUserId, blocker._id);
      assert.equal(deleteFilters[0].blockedWalletPubkey, blockedWalletPubkey);
    });
  });
});

test('POST /messaging/v2/directory/lookup returns a generic unavailable error when the recipient blocked the sender', async (t) => {
  const sender = buildUser({
    _id: 'sender-1',
    lightningAddress: 'alice@example.com',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const recipient = buildUser({
    _id: 'recipient-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'bob@example.com',
    messagingPubkeyV2: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    messagingIdentityV2Signature: 'recipient-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult(sender),
    },
    {
      target: User,
      key: 'findOne',
      value: ({ lightningAddress }) => queryResult(
        lightningAddress === recipient.lightningAddress ? recipient : null
      ),
    },
    {
      target: UserBlock,
      key: 'findOne',
      value: ({ blockerUserId, blockedUserId }) => queryResult(
        String(blockerUserId) === String(recipient._id) &&
          String(blockedUserId) === String(sender._id)
          ? { _id: 'block-1' }
          : null
      ),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v2/directory/lookup`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(sender._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lightningAddress: recipient.lightningAddress,
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.error, 'Recipient is unavailable');
    });
  });
});

test('POST /messaging/v2/send rejects sends to a user the sender has blocked', async (t) => {
  const sender = buildUser({
    _id: 'sender-1',
    lightningAddress: 'alice@example.com',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const recipient = buildUser({
    _id: 'recipient-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'bob@example.com',
    messagingPubkeyV2: '02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    messagingIdentityV2Signature: 'recipient-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  await withPatchedMethods([
    {
      target: User,
      key: 'findById',
      value: () => queryResult(sender),
    },
    {
      target: User,
      key: 'findOne',
      value: ({ walletPubkey }) => queryResult(
        walletPubkey === recipient.walletPubkey ? recipient : null
      ),
    },
    {
      target: UserBlock,
      key: 'findOne',
      value: ({ blockerUserId, blockedUserId }) => queryResult(
        String(blockerUserId) === String(sender._id) &&
          String(blockedUserId) === String(recipient._id)
          ? { _id: 'block-1' }
          : null
      ),
    },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v2/send`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(sender._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientMessageId: 'client-message-1',
          recipient: {
            walletPubkey: recipient.walletPubkey,
            lightningAddress: recipient.lightningAddress,
            messagingPubkey: recipient.messagingPubkeyV2,
            messagingIdentitySignature: recipient.messagingIdentityV2Signature,
            messagingIdentitySignatureVersion: 2,
            messagingIdentitySignedAt: 1_704_153_600,
          },
          ciphertext: 'ciphertext',
          nonce: 'nonce',
          senderEphemeralPubkey: '02eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          createdAtClientMs: 1_712_000_000_000,
          envelopeVersion: 3,
          messageType: 'text',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.error, 'You have blocked this user');
    });
  });
});

test('POST /messaging/v3/device-registrations stores a registration for the active messaging pubkey', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messagingIdentityV2Signature: 'sender-v2-signature',
    messagingIdentityV2SignatureVersion: 2,
    messagingIdentityV2SignedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const staleRegistrationFilters = [];
  const storedRegistration = {
    _id: 'registration-1',
    userId: user._id,
    walletPubkey: user.walletPubkey,
    messagingPubkey: user.messagingPubkeyV2,
    deviceToken: 'a'.repeat(64),
    platform: 'apns',
    environment: 'dev',
    registrationSignedAt: new Date('2026-04-10T12:00:00.000Z'),
    appVersion: '3.7.0',
    bundleId: 'com.example.app',
    lastSeenAt: new Date('2026-04-10T12:00:00.000Z'),
    createdAt: new Date('2026-04-10T12:00:00.000Z'),
    updatedAt: new Date('2026-04-10T12:00:00.000Z'),
  };

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: sessionHelper, key: 'verifyBreezSignedMessage', value: () => true },
    { target: MessagingDeviceRegistration, key: 'findOne', value: async () => null },
    {
      target: MessagingDeviceRegistration,
      key: 'findOneAndUpdate',
      value: async () => storedRegistration,
    },
    {
      target: MessagingDeviceRegistration,
      key: 'deleteMany',
      value: async (filter) => {
        staleRegistrationFilters.push(filter);
        return { deletedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/device-registrations`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          walletPubkey: user.walletPubkey,
          messagingPubkey: user.messagingPubkeyV2,
          platform: 'apns',
          environment: 'dev',
          deviceToken: 'A'.repeat(64),
          registrationSignature: 'device-registration-signature',
          registrationSignatureVersion: 1,
          registrationSignedAt: 1_712_750_400,
          appVersion: '3.7.0',
          bundleId: 'com.example.app',
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.registration.messagingPubkey, user.messagingPubkeyV2);
      assert.equal(body.registration.environment, 'dev');
      assert.equal(body.registration.deviceToken, 'a'.repeat(64));
      assert.equal(staleRegistrationFilters.length, 1);
      assert.equal(staleRegistrationFilters[0].userId, user._id);
      assert.equal(staleRegistrationFilters[0].messagingPubkey.$ne, user.messagingPubkeyV2);
    });
  });
});

test('GET /messaging/v3/device-registrations returns active registrations for the current environment', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const registrations = [
    {
      _id: 'registration-1',
      walletPubkey: user.walletPubkey,
      messagingPubkey: user.messagingPubkeyV2,
      deviceToken: 'a'.repeat(64),
      platform: 'apns',
      environment: 'dev',
      registrationSignedAt: new Date('2026-04-10T12:00:00.000Z'),
      lastSeenAt: new Date('2026-04-10T12:01:00.000Z'),
      createdAt: new Date('2026-04-10T12:00:00.000Z'),
      updatedAt: new Date('2026-04-10T12:01:00.000Z'),
    },
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    { target: MessagingDeviceRegistration, key: 'find', value: () => queryChainResult(registrations) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/device-registrations`, {
        headers: {
          Cookie: authCookie(String(user._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.environment, 'dev');
      assert.equal(body.messagingPubkey, user.messagingPubkeyV2);
      assert.equal(body.registrations.length, 1);
      assert.equal(body.registrations[0].deviceToken, registrations[0].deviceToken);
    });
  });
});

test('POST /messaging/v3/ack marks pending messages delivered instead of deleting them', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
    messagingPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const updateCalls = [];
  const messageIds = [
    '507f1f77bcf86cd799439011',
    '507f1f77bcf86cd799439012',
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
      key: 'updateMany',
      value: async (filter, update) => {
        updateCalls.push({ filter, update });
        return { modifiedCount: 2 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/ack`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageIds }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.acknowledgedCount, 2);
      assert.equal(updateCalls.length, 1);
      assert.deepEqual(updateCalls[0].filter.recipientMessagingPubkey.$in, [
        user.messagingPubkeyV2,
        user.messagingPubkey,
      ]);
      assert.equal(updateCalls[0].update.$set.status, 'delivered');
      assert.ok(updateCalls[0].update.$set.deliveredAt instanceof Date);
      assert.equal(updateCalls[0].update.$unset.ciphertext, '');
    });
  });
});

test('POST /messaging/v3/rekey-required marks messages and reopens linked attachments for resend', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const messageIds = [
    '507f1f77bcf86cd799439021',
    '507f1f77bcf86cd799439022',
  ];
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
      key: 'find',
      value: () => queryResult(messageIds.map((_id) => ({ _id }))),
    },
    {
      target: DirectMessage,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 2 };
      },
    },
    {
      target: MessageAttachment,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/rekey-required`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messageIds }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.updatedCount, 2);
      assert.equal(body.resetAttachmentCount, 1);
      assert.equal(directMessageUpdateCalls.length, 1);
      assert.equal(directMessageUpdateCalls[0].update.$set.status, 'rekey_required');
      assert.ok(directMessageUpdateCalls[0].update.$set.rekeyRequiredAt instanceof Date);
      assert.equal(attachmentUpdateCalls.length, 1);
      assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
    });
  });
});

test('POST /messaging/v3/decrypt-failed requests one silent retry, then marks the next attempt terminal', async (t) => {
  const user = buildUser({
    lightningAddress: 'alice@example.com',
    messagingPubkeyV2: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const directMessageUpdateCalls = [];
  const attachmentUpdateCalls = [];
  const retryRequiredId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439031');
  const failedId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439032');

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
    {
      target: DirectMessage,
      key: 'find',
      value: () => queryResult([
        {
          _id: retryRequiredId,
          senderUserId: 'sender-1',
          recipientWalletPubkey: 'recipient-wallet-1',
          sameKeyRetryCount: 0,
        },
        {
          _id: failedId,
          senderUserId: 'sender-1',
          recipientWalletPubkey: 'recipient-wallet-1',
          sameKeyRetryCount: 1,
        },
      ]),
    },
    {
      target: DirectMessage,
      key: 'updateMany',
      value: async (filter, update) => {
        directMessageUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
    {
      target: MessageAttachment,
      key: 'updateMany',
      value: async (filter, update) => {
        attachmentUpdateCalls.push({ filter, update });
        return { modifiedCount: 1 };
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/messaging/v3/decrypt-failed`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messageIds: [String(retryRequiredId), String(failedId)],
        }),
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.retryRequiredCount, 1);
      assert.equal(body.failedCount, 1);
      assert.equal(body.resetAttachmentCount, 1);
      assert.equal(directMessageUpdateCalls.length, 2);
      assert.equal(directMessageUpdateCalls[0].update.$set.status, 'same_key_retry_required');
      assert.equal(directMessageUpdateCalls[0].update.$set.sameKeyRetryCount, 1);
      assert.ok(directMessageUpdateCalls[0].update.$set.sameKeyDecryptFailedAt instanceof Date);
      assert.equal(directMessageUpdateCalls[1].update.$set.status, 'failed_same_key');
      assert.ok(directMessageUpdateCalls[1].update.$set.failedAt instanceof Date);
      assert.equal(attachmentUpdateCalls.length, 1);
      assert.equal(attachmentUpdateCalls[0].update.$set.status, 'uploaded');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedMessageId, '');
      assert.equal(attachmentUpdateCalls[0].update.$unset.linkedClientMessageId, '');
    });
  });
});

test('GET /pos-feed/posts excludes posts from users the viewer has blocked', async (t) => {
  const viewer = buildUser({
    _id: 'viewer-1',
  });
  const blockedPosterUserId = 'blocked-poster-1';
  const postQueries = [];
  const returnedPosts = [
    {
      _id: 'post-visible-1',
      posterUserId: 'visible-poster-1',
      posterLightningAddress: 'visible@example.com',
      caption: 'Visible post',
    },
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(viewer) },
    {
      target: UserBlock,
      key: 'find',
      value: (query) => {
        return {
          select() {
            return {
              lean: async () => {
                return [{ blockedUserId: blockedPosterUserId }];
              },
            };
          },
        };
      },
    },
    {
      target: POSFeedPostReport,
      key: 'find',
      value: () => ({
        select() {
          return {
            lean: async () => [],
          };
        },
      }),
    },
    {
      target: POSFeedPost,
      key: 'find',
      value: (query) => {
        postQueries.push(query);
        return queryChainResult(returnedPosts);
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/pos-feed/posts?limit=10`, {
        headers: {
          Cookie: authCookie(String(viewer._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(postQueries, [
        { posterUserId: { $nin: [blockedPosterUserId] } },
      ]);
      assert.equal(body.posts.length, 1);
      assert.equal(body.posts[0]._id, returnedPosts[0]._id);
      assert.equal(body.posts[0].viewerHasReported, false);
      assert.equal(body.posts[0].isOwnPost, false);
    });
  });
});

test('GET /pos-feed/posts marks posts already reported by the viewer', async (t) => {
  const viewer = buildUser({
    _id: 'viewer-2',
  });
  const returnedPosts = [
    {
      _id: 'post-reported-1',
      posterUserId: 'poster-2',
      posterLightningAddress: 'poster@example.com',
      reportCount: 3,
      isFlagged: true,
    },
  ];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(viewer) },
    {
      target: UserBlock,
      key: 'find',
      value: () => ({
        select() {
          return {
            lean: async () => [],
          };
        },
      }),
    },
    {
      target: POSFeedPost,
      key: 'find',
      value: () => queryChainResult(returnedPosts),
    },
    {
      target: POSFeedPostReport,
      key: 'find',
      value: () => ({
        select() {
          return {
            lean: async () => [{ postId: returnedPosts[0]._id }],
          };
        },
      }),
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/pos-feed/posts`, {
        headers: {
          Cookie: authCookie(String(viewer._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.posts[0].viewerHasReported, true);
      assert.equal(body.posts[0].reportCount, 3);
      assert.equal(body.posts[0].isFlagged, true);
    });
  });
});

test('POST /pos-feed/posts/:id/report flags a post once and returns updated viewer report state', async (t) => {
  const reporter = buildUser({
    _id: 'reporter-1',
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lightningAddress: 'reporter@example.com',
  });
  const originalPost = {
    _id: 'post-flag-1',
    posterUserId: 'poster-flag-1',
    posterLightningAddress: 'poster@example.com',
    transactionId: 'tx-flag-1',
    amountSats: 2100,
    placeText: 'Coffee Shop',
    caption: 'Great espresso',
    imageUrl: 'https://cdn.example.invalid/post.jpg',
    reportCount: 0,
    isFlagged: false,
  };
  const updatedPost = {
    ...originalPost,
    reportCount: 1,
    isFlagged: true,
  };
  const createdReports = [];
  const updateCalls = [];
  const logLines = [];

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(reporter) },
    { target: POSFeedPost, key: 'findById', value: () => queryLeanResult(originalPost) },
    {
      target: POSFeedPostReport,
      key: 'findOne',
      value: () => queryResult(null),
    },
    {
      target: POSFeedPostReport,
      key: 'create',
      value: async (payload) => {
        createdReports.push(payload);
        return { _id: 'report-1', ...payload };
      },
    },
    {
      target: POSFeedPost,
      key: 'findByIdAndUpdate',
      value: (id, update) => {
        updateCalls.push({ id, update });
        return queryLeanResult(updatedPost);
      },
    },
    {
      target: console,
      key: 'log',
      value: (...args) => {
        logLines.push(args.join(' '));
      },
    },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/pos-feed/posts/${originalPost._id}/report`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(reporter._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.didUpdate, true);
      assert.equal(body.post._id, originalPost._id);
      assert.equal(body.post.viewerHasReported, true);
      assert.equal(body.post.reportCount, 1);
      assert.equal(body.post.isFlagged, true);
      assert.equal(createdReports.length, 1);
      assert.equal(createdReports[0].postId, originalPost._id);
      assert.equal(createdReports[0].reporterUserId, reporter._id);
      assert.equal(updateCalls.length, 1);
      assert.deepEqual(updateCalls[0].update.$inc, { reportCount: 1 });
      assert.equal(updateCalls[0].update.$set.isFlagged, true);
      assert.equal(logLines.some((line) => line.includes('POS FEED POST FLAG START')), true);
    });
  });
});

test('POST /pos-feed/posts requires a Lightning address before creating a Proof of Spend post', async (t) => {
  const user = buildUser({
    _id: 'poster-1',
    lightningAddress: null,
  });

  await withPatchedMethods([
    { target: User, key: 'findById', value: () => queryResult(user) },
  ], async () => {
    await maybeWithServer(t, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/pos-feed/posts`, {
        method: 'POST',
        headers: {
          Cookie: authCookie(String(user._id)),
        },
      });

      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.error, 'A Lightning address is required to create a Proof of Spend post.');
    });
  });
});
