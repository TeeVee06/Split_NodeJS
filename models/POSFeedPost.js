const mongoose = require('mongoose');

const posFeedPostSchema = new mongoose.Schema(
  {
    posterUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    posterLightningAddress: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    posterProfilePicUrl: {
      type: String,
      default: null,
    },

    transactionId: {
      type: String,
      required: true,
      trim: true,
    },

    amountSats: {
      type: Number,
      required: true,
      min: 1,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    placeText: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },

    caption: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    reportCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    isFlagged: {
      type: Boolean,
      default: false,
      index: true,
    },

    lastReportedAt: {
      type: Date,
      default: null,
    },

    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },

    imageUrls: {
      type: [String],
      default: [],
      validate: {
        validator: (value) => !Array.isArray(value) || value.length <= 4,
        message: 'A Proof of Spend post can include at most 4 images.',
      },
    },

    imageObjectKey: {
      type: String,
      required: true,
      trim: true,
    },

    imageObjectKeys: {
      type: [String],
      default: [],
      validate: {
        validator: (value) => !Array.isArray(value) || value.length <= 4,
        message: 'A Proof of Spend post can include at most 4 image object keys.',
      },
    },
  },
  { timestamps: true }
);

posFeedPostSchema.index({ createdAt: -1 });
posFeedPostSchema.index({ posterUserId: 1, transactionId: 1 }, { unique: true });
posFeedPostSchema.index({ isFlagged: 1, lastReportedAt: -1 });

module.exports = mongoose.model('POSFeedPost', posFeedPostSchema);
