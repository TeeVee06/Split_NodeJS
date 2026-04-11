const mongoose = require("mongoose");

const RewardSpendSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    monthKey: {
      type: String, // e.g. "2026-01"
      required: true,
      index: true,
    },

    // Total merchant spend for this user in this month (cents)
    merchantSpend: {
      type: Number,
      required: true,
      min: 0,
    },

    // this field is already calculated for 10% of all Bitcoin purchases via our on-ramp.
    purchaseSpend: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    transactions: {
      type: Number,
      default: 0,
    },

    /**
     * Final payout data for this month/user.
     * Populated by the "close month" script.
     * Used by the payout execution script.
     */
    final: {
      closed: {
        type: Boolean,
        default: false,
        index: true,
      },

      // Calculated reward amount for this user (sats)
      rewardSats: {
        type: Number,
        min: 0,
      },

      // Snapshot of user's spark address at close time
      sparkAddress: {
        type: String,
      },

      // Whether this payout has been completed
      paid: {
        type: Boolean,
        default: false,
        index: true,
      },
    },
  },
  {
    timestamps: true,
  }
);

// One row per user per month
RewardSpendSchema.index({ userId: 1, monthKey: 1 }, { unique: true });

module.exports = mongoose.model("RewardSpend", RewardSpendSchema);
