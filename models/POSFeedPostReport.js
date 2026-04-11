const mongoose = require('mongoose');

const posFeedPostReportSchema = new mongoose.Schema(
  {
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'POSFeedPost',
      required: true,
      index: true,
    },

    reporterUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

posFeedPostReportSchema.index({ postId: 1, reporterUserId: 1 }, { unique: true });
posFeedPostReportSchema.index({ postId: 1, createdAt: -1 });

module.exports = mongoose.model('POSFeedPostReport', posFeedPostReportSchema);
