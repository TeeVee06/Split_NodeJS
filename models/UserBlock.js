const mongoose = require('mongoose');

const userBlockSchema = new mongoose.Schema(
  {
    blockerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    blockedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    blockedWalletPubkey: {
      type: String,
      required: true,
      index: true,
    },

    blockedLightningAddress: {
      type: String,
      default: null,
      index: true,
    },

    blockedProfilePicUrl: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

userBlockSchema.index({ blockerUserId: 1, blockedUserId: 1 }, { unique: true });
userBlockSchema.index({ blockerUserId: 1, createdAt: -1 });

module.exports = mongoose.model('UserBlock', userBlockSchema);
