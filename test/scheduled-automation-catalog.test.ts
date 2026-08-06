// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SCHEDULED_AUTOMATION_ACTIONS,
  SCHEDULED_AUTOMATION_CATALOG_READER,
} from 'aidcp-kernel/kernel/scheduled-automation-catalog.js';

test('api uses the closed kernel scheduled automation catalog', () => {
  assert.deepEqual(SCHEDULED_AUTOMATION_ACTIONS, [
    'post',
    'comment',
    'contact_comment',
    'join_group',
  ]);
  assert.deepEqual(
    SCHEDULED_AUTOMATION_CATALOG_READER
      .availableActions('xiaohongshu')
      .map((entry) => entry.action),
    ['post', 'comment', 'contact_comment'],
  );
  assert.deepEqual(
    SCHEDULED_AUTOMATION_CATALOG_READER.availableActions('future-platform'),
    [],
  );
});

test('api server and transport resolve one exact kernel catalog pin', async () => {
  const [serverSource, lockSource] = await Promise.all([
    readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
  ]);
  assert.match(
    serverSource,
    /scheduledAutomationCatalog:\s*SCHEDULED_AUTOMATION_CATALOG_READER/,
  );
  assert.doesNotMatch(
    serverSource,
    /scheduled_automation_catalog_unavailable_in_api_service/,
  );

  const lock = JSON.parse(lockSource) as {
    packages: Record<
      string,
      {
        dependencies?: Record<string, string>;
        resolved?: string;
      }
    >;
  };
  // Canonical pin form since invert-split-fact-source §2: git+ssh URL pinned at a version tag,
  // which the lockfile resolves to an exact commit sha.
  const directKernel = lock.packages[''].dependencies?.['aidcp-kernel'];
  assert.match(
    directKernel ?? '',
    /^git\+ssh:\/\/git@github\.com\/tommax-bai\/aidcp-kernel\.git#v\d+\.\d+\.\d+$/,
  );
  const kernelResolvedSha =
    lock.packages['node_modules/aidcp-kernel']?.resolved?.split('#').pop() ?? '';
  assert.match(kernelResolvedSha, /^[0-9a-f]{40}$/);
  // Transport's own kernel requirement must land on that same commit (same catalog content,
  // even when the pin spelling differs: tag vs raw sha), and dedupe to one installed instance.
  const transportKernelRef =
    lock.packages['node_modules/aidcp-transport']?.dependencies?.['aidcp-kernel']
      ?.split('#').pop() ?? '';
  if (/^[0-9a-f]{40}$/.test(transportKernelRef)) {
    assert.equal(transportKernelRef, kernelResolvedSha);
  }
  assert.deepEqual(
    Object.keys(lock.packages).filter((key) =>
      /(?:^|\/)node_modules\/aidcp-kernel$/.test(key)),
    ['node_modules/aidcp-kernel'],
  );
});
