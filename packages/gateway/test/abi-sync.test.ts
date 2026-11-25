import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { CLAUSE_ESCROW_ABI, SKIP_REASONS } from '@clause/core';
import { REPO_ROOT } from '../src/config.ts';

const ARTIFACT = join(REPO_ROOT, 'packages/contracts/artifacts/contracts/ClauseEscrow.sol/ClauseEscrow.json');

test('core ABI matches the compiled ClauseEscrow artifact', { skip: !existsSync(ARTIFACT) && 'compile contracts first' }, () => {
  const compiled = new Interface(JSON.parse(readFileSync(ARTIFACT, 'utf8')).abi);
  const core = new Interface(CLAUSE_ESCROW_ABI as unknown as string[]);
  core.forEachFunction((f) => {
    const c = compiled.getFunction(f.selector);
    assert.ok(c, `function ${f.format()} missing from artifact`);
    assert.equal(c!.format('sighash'), f.format('sighash'));
    assert.deepEqual(c!.outputs.map((o) => o.format('sighash')), f.outputs.map((o) => o.format('sighash')), `${f.name} outputs`);
    assert.equal(c!.stateMutability, f.stateMutability, `${f.name} mutability`);
  });
  core.forEachEvent((e) => {
    const c = compiled.getEvent(e.topicHash);
    assert.ok(c, `event ${e.format()} missing from artifact`);
  });
});

test('SKIP_REASONS mirrors the SkipReason enum order', { skip: !existsSync(ARTIFACT) && 'compile contracts first' }, () => {
  const src = readFileSync(join(REPO_ROOT, 'packages/contracts/contracts/ClauseEscrow.sol'), 'utf8');
  const body = src.match(/enum SkipReason \{([\s\S]*?)\}/)![1];
  const names = body.split(',').map((s) => s.trim()).filter(Boolean);
  const kebab = names.map((n) => n.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace('call-id', 'callid'));
  assert.deepEqual(kebab, [...SKIP_REASONS]);
});
