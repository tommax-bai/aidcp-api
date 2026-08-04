/**
 * AC-PERSONA-PARSE-* 人设解析**只许有一份**（本仓这一侧）。
 *
 * 背景（2026-08-04 dev 切流演练实测）：同步读 `account_persona` 流在同一个游标 902 上，
 * 本进程与单体发出的载荷摘要不同，消费方按「同游标必同载荷」整条拒收。
 * 根因是两个组装根各注入了一份不同的解析：单体用人设闭子集编解码器、失败回 null，
 * 本仓用自己的通用装载器、且不带兜底。**两侧各自的行为测试当时全绿** ——
 * 「第二份实现」在行为测试上原理不可见，故只能按引用共用 + 把摘要钉死在两个仓里。
 *
 * 本文件的摘要常量 MUST 与 `aidcp-cloud/test/acceptance/persona-soul-parse-single-source.test.ts`
 * 里的同名常量逐字相同。任一侧漂移，一侧当场红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { parseSyncReadPersonaSoul } from 'aidcp-kernel/kernel/persona-soul-parse.js';
import { syncReadPayloadDigest } from 'aidcp-kernel/kernel/sync-read-snapshot.js';

import { loadSoulFromYaml } from '../../src/soul/loader.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 与 aidcp-cloud 同名用例逐字相同的基准人设（带 api 段自管字段，当初分叉就分在这里）。 */
const REFERENCE_PERSONA = [
  'identity:',
  '  name: "小林"',
  '  role: "美食博主"',
  '  background: "在上海开过三年小面馆"',
  '  tone: "松弛、口语"',
  'writing_language: "zh-CN"',
  'interests:',
  '  primary:',
  '    - "家常菜"',
  '  secondary:',
  '    - "厨具"',
  '  seed_keywords:',
  '    - "一人食"',
  'behavior_guidelines:',
  '  style: "短句"',
  '  privacy: "不谈住址"',
  '  collection_principle: "只收自己做过的"',
  '  like_principle: "真觉得好才点"',
  '  like_affinity: "like_more"',
  'engagement_rules:',
  '  like:',
  '    - "家常菜"',
  '  skip:',
  '    - "营销号"',
  '  comment_trigger:',
  '    - "问做法"',
  '',
].join('\n');

/** MUST 与 aidcp-cloud 同名常量逐字相同（改它等于改跨进程契约）。 */
const REFERENCE_PAYLOAD_DIGEST =
  'sha256:4656ea2c31b128c69cf172718b36061c05dbe1e92380072d9b541691ab971b07';

test('AC-PERSONA-PARSE-04 载荷摘要钉死（跨仓同值）', () => {
  const digest = syncReadPayloadDigest({
    accounts: [
      {
        accountId: 'acct-reference',
        personaText: REFERENCE_PERSONA,
        soul: parseSyncReadPersonaSoul(REFERENCE_PERSONA),
      },
    ],
  });
  assert.equal(digest, REFERENCE_PAYLOAD_DIGEST);
});

test('AC-PERSONA-PARSE-05 组装根 MUST 按引用注入，MUST NOT 就地再写一份', () => {
  const source = readFileSync(join(REPO_ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(
    source,
    /parseSoul:\s*parseSyncReadPersonaSoul,/,
    '本仓组装根必须直接把共享包那一份传下去',
  );
  assert.doesNotMatch(
    source,
    /parseSoul:\s*(?:\(|async|function)/,
    '组装根里出现就地实现的 parseSoul —— 那正是两侧分叉的形态',
  );
});

test('AC-PERSONA-PARSE-06 本仓通用装载器与同步读那一份**本来就不等价**（钉住分叉判据）', () => {
  // 这条不是回归，是判据：留着通用装载器给本仓自己的人设面用没问题，
  // 但它 MUST NOT 再被塞进同步读 —— 两者对同一份文本本来就解出不同结构。
  const viaLoader = JSON.parse(JSON.stringify(loadSoulFromYaml(REFERENCE_PERSONA)));
  const viaSyncRead = parseSyncReadPersonaSoul(REFERENCE_PERSONA);
  assert.notDeepEqual(viaLoader, viaSyncRead);
  assert.ok(Object.keys(viaLoader).includes('engagement_rules'));
  assert.ok(
    !Object.keys(viaSyncRead as Record<string, unknown>).includes('engagement_rules'),
  );
});
