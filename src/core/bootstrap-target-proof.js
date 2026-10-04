import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Process-local proof binds a bootstrap receipt without storing target IDs or a registry.
const PROOF_KEY = randomBytes(32);
const PROOF_CONTEXT = 'tv-observer-bootstrap-owned-target-v1';

export function createBootstrapTargetProof(profileName, profileId, targetId) {
  return sign(profileName, profileId, targetId);
}

export function verifyBootstrapTargetProof(profileName, profileId, targetId, proof) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/u.test(proof)) return false;
  const expected = Buffer.from(sign(profileName, profileId, targetId), 'hex');
  const supplied = Buffer.from(proof, 'hex');
  return timingSafeEqual(expected, supplied);
}

function sign(profileName, profileId, targetId) {
  return createHmac('sha256', PROOF_KEY)
    .update(`${PROOF_CONTEXT}\0${profileName}\0${profileId}\0${targetId}`)
    .digest('hex');
}
