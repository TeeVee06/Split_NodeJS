const crypto = require('crypto');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function hashHexToBuffer(hex) {
  const normalized = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Invalid merkle hash hex');
  }

  return Buffer.from(normalized, 'hex');
}

function bufferToHex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

function canonicalizeBinding(binding) {
  return {
    walletPubkey: String(binding.walletPubkey || '').trim(),
    lightningAddress: String(binding.lightningAddress || '').trim().toLowerCase(),
    messagingPubkey: String(binding.messagingPubkey || '').trim(),
    messagingIdentitySignature: String(binding.messagingIdentitySignature || '').trim(),
    messagingIdentitySignatureVersion: Number(binding.messagingIdentitySignatureVersion || 0),
    messagingIdentitySignedAt: Number(binding.messagingIdentitySignedAt || 0),
  };
}

function buildBindingLeafMessage(binding) {
  const normalized = canonicalizeBinding(binding);

  return `SplitRewards Messaging Directory Leaf
version=${normalized.messagingIdentitySignatureVersion}
walletPubkey=${normalized.walletPubkey}
lightningAddress=${normalized.lightningAddress}
messagingPubkey=${normalized.messagingPubkey}
signature=${normalized.messagingIdentitySignature}
signedAt=${normalized.messagingIdentitySignedAt}`;
}

function buildBindingLeafHash(binding) {
  return bufferToHex(sha256(Buffer.from(buildBindingLeafMessage(binding), 'utf8')));
}

function emptyRootHash() {
  return bufferToHex(sha256(Buffer.from('SplitRewards Messaging Directory Empty', 'utf8')));
}

function combineMerkleHashes(leftHex, rightHex) {
  return bufferToHex(sha256(Buffer.concat([
    hashHexToBuffer(leftHex),
    hashHexToBuffer(rightHex),
  ])));
}

function computeMerkleRoot(leafHashes) {
  if (!Array.isArray(leafHashes) || !leafHashes.length) {
    return emptyRootHash();
  }

  let level = leafHashes.map((entry) => String(entry).trim().toLowerCase());

  while (level.length > 1) {
    const nextLevel = [];

    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      nextLevel.push(combineMerkleHashes(left, right));
    }

    level = nextLevel;
  }

  return level[0];
}

function buildMerkleProof(leafHashes, leafIndex) {
  if (!Array.isArray(leafHashes) || !leafHashes.length) {
    return [];
  }

  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new Error('Invalid merkle proof leaf index');
  }

  let level = leafHashes.map((entry) => String(entry).trim().toLowerCase());
  let cursor = leafIndex;
  const proof = [];

  while (level.length > 1) {
    const isRightNode = cursor % 2 === 1;
    const siblingIndex = isRightNode ? cursor - 1 : cursor + 1;
    const siblingHash = level[siblingIndex] || level[cursor];

    proof.push({
      position: isRightNode ? 'left' : 'right',
      hash: siblingHash,
    });

    const nextLevel = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      nextLevel.push(combineMerkleHashes(left, right));
    }

    cursor = Math.floor(cursor / 2);
    level = nextLevel;
  }

  return proof;
}

module.exports = {
  buildBindingLeafHash,
  buildBindingLeafMessage,
  buildMerkleProof,
  canonicalizeBinding,
  computeMerkleRoot,
  emptyRootHash,
};
