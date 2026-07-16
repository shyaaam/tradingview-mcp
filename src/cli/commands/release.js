import { register } from '../router.js';
import { buildObserverContract } from '../../release/identity.js';

register('version', {
  description: 'Print the server version, release commit, and observer manifest hash',
  handler: () => {
    const contract = buildObserverContract();
    return {
      server_name: contract.serverName,
      server_version: contract.serverVersion,
      node_version: contract.nodeVersion,
      expected_commit: contract.expectedCommit,
      observed_commit: contract.observedCommit,
      release_commit: contract.releaseCommit,
      release_commit_source: contract.releaseCommitSource,
      release_commit_match: contract.releaseCommitMatch,
      release_dirty: contract.releaseDirty,
      release_ready: contract.releaseReady,
      observer_contract_id: contract.contractId,
      observer_manifest_hash: contract.manifestHash,
    };
  },
});

register('contract', {
  description: 'Print the full tv-observer-v1 capability and lifecycle contract',
  handler: () => buildObserverContract(),
});
