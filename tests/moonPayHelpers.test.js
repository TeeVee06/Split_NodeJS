const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMoonPayReturnUrl,
  chooseSingleMoonPayRewardMatch,
  createMoonPayStateToken,
  verifyMoonPayStateToken,
} = require('../payments/moonPayHelpers');

const SECRET = 'split-moonpay-test-secret';

test('MoonPay state token round-trips expected purchase fields', () => {
  const { token } = createMoonPayStateToken({
    walletPubkey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    lockedAmountSats: 125000,
    estimatedSpendAmountCents: 8450,
    secret: SECRET,
  });

  const verified = verifyMoonPayStateToken(token, { secret: SECRET });

  assert.equal(verified.walletPubkey, '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(verified.lockedAmountSats, 125000);
  assert.equal(verified.estimatedSpendAmountCents, 8450);
  assert.ok(Number.isInteger(verified.expiresAtMs));
});

test('MoonPay state token verification rejects a tampered token', () => {
  const { token } = createMoonPayStateToken({
    walletPubkey: '02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    lockedAmountSats: 75000,
    estimatedSpendAmountCents: 5000,
    secret: SECRET,
  });

  const tampered = `${token.slice(0, -1)}x`;

  assert.equal(verifyMoonPayStateToken(tampered, { secret: SECRET }), null);
});

test('MoonPay state token verification rejects expired tokens', () => {
  const { token } = createMoonPayStateToken({
    walletPubkey: '02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lockedAmountSats: 42000,
    estimatedSpendAmountCents: 2900,
    ttlMs: -1,
    secret: SECRET,
  });

  assert.equal(verifyMoonPayStateToken(token, { secret: SECRET }), null);
});

test('MoonPay return URLs embed the signed state token', () => {
  const url = buildMoonPayReturnUrl({
    baseUrl: 'https://example.invalid/',
    stateToken: 'signed-state-token',
  });

  assert.equal(
    url,
    'https://example.invalid/moonpay-return?state=signed-state-token'
  );
});

test('MoonPay reward match helper only accepts a single candidate', () => {
  assert.deepEqual(chooseSingleMoonPayRewardMatch([]), { status: 'none', purchase: null });

  const single = chooseSingleMoonPayRewardMatch([{ _id: 'purchase-1' }]);
  assert.equal(single.status, 'single');
  assert.deepEqual(single.purchase, { _id: 'purchase-1' });

  assert.deepEqual(
    chooseSingleMoonPayRewardMatch([{ _id: 'a' }, { _id: 'b' }]),
    { status: 'ambiguous', purchase: null }
  );
});
