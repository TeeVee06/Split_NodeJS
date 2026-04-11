// models/MerchantPubKey.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const merchantPubKeySchema = new Schema(
  {
    /**
     * The lightning node public key associated with an eligible merchant flow.
     * Pubkeys should be unique in this collection, even if one pubkey may map
     * to many real-world merchants under a custodial processor.
     */
    pubkey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('MerchantPubKey', merchantPubKeySchema);
