const mongoose = require('mongoose');

const messagingDirectoryStateSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'messaging-v2-directory',
    },

    treeSize: {
      type: Number,
      required: true,
      default: 0,
    },

    lastLeafIndex: {
      type: Number,
      required: true,
      default: -1,
    },

    rootHash: {
      type: String,
      required: true,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessagingDirectoryState', messagingDirectoryStateSchema);
