const mongoose = require("mongoose");

const PlatformWalletSchema = new mongoose.Schema(
  {
    balanceSats: {
      type: Number,   // integer sats
      default: 0,
      min: 0
    },

    encryptedSeed: {
      type: String,
      required: true,
    },

    lastUsedAt: {
      type: Date,
    },

    lightningAddress: {
      type: String,
      trim: true,
      lowercase: true,
    },

    lightningAddressUsername: {
      type: String,
      trim: true,
      lowercase: true,
    },

    lightningAddressDescription: {
      type: String,
      trim: true,
    },

    lightningAddressLnurlUrl: {
      type: String,
      trim: true,
    },

    lightningAddressLnurlBech32: {
      type: String,
      trim: true,
    },

    lightningAddressSyncedAt: {
      type: Date,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model("PlatformWallet", PlatformWalletSchema);
