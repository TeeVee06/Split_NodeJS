// userRewardSpendFunction.js
/**
 * Records monthly merchant spend + tx count into RewardSpend for eligible lightning purchases,
 * and records transaction + volume into PlatformAnalytics (sats + cents).
 *
 * NOTE: Always increments platform-wide transactions/volume.
 *       Only increments RewardSpend + lifetimeMerchantSpendCents when eligible merchant.
 */
async function userRewardSpendFunction({
  User,
  RewardSpend,
  MerchantPubKey,
  PlatformAnalytics,
  userId,
  usdAmountCentsNum,
  btcAmountSatsNum,
  destinationPubkey,
  network,
  direction,
  finalStatus,
}) {
  try {
    // Guards for when this endpoint should apply
    if (finalStatus !== 'Completed') return;
    if (network !== 'lightning') return;
    if (direction !== 'sent') return;

    if (!Number.isFinite(usdAmountCentsNum) || usdAmountCentsNum <= 0) return;
    if (!Number.isInteger(btcAmountSatsNum) || btcAmountSatsNum <= 0) return;

    // Always update platform-wide totals
    const inc = {
      transactions: 1,
      'transactionVolume.btcSats': btcAmountSatsNum,
      'transactionVolume.usdCents': usdAmountCentsNum,
    };

    // Merchant attribution only if we have a destination and it matches an eligible merchant
    let eligible = null;
    if (destinationPubkey) {
      eligible = await MerchantPubKey.findOne({ pubkey: destinationPubkey })
        .select('_id')
        .lean();
    }

    if (eligible) {
      inc.merchantTransactions = 1;
      inc['merchantVolume.btcSats'] = btcAmountSatsNum;
      inc['merchantVolume.usdCents'] = usdAmountCentsNum;

      // Compute current monthKey in UTC (YYYY-MM)
      const monthKey = new Date().toISOString().slice(0, 7);

      // Increment monthly per-user spend + transaction count (create if missing)
      await RewardSpend.updateOne(
        { monthKey, userId },
        {
          $setOnInsert: { monthKey, userId },
          $inc: {
            merchantSpend: usdAmountCentsNum,
            transactions: 1,
          },
        },
        { upsert: true }
      );

      // Track lifetime merchant spend on user (no reward credits anymore)
      await User.updateOne(
        { _id: userId },
        { $inc: { lifetimeMerchantSpendCents: usdAmountCentsNum } }
      );
    }

    await PlatformAnalytics.updateOne(
      { _id: 'platform' },
      { $inc: inc },
      { upsert: true }
    );
  } catch (err) {
    console.error('userRewardSpendFunction error:', err);
  }
}

module.exports = userRewardSpendFunction;
