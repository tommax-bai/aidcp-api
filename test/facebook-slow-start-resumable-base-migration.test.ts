import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

/**
 * change default-consumption-after-slow-start —— 迁移 0117 的取值方向。
 *
 * 与 `facebook-global-policy-merge-migration.test.ts` 同一写法：读 SQL 文本、只守方向。
 * 这条迁移里真正会造成损失的错法都是范围划错：
 *   - 把 rule 基线也翻掉 ⇒ 撕毁「legacy 规则模式保留为回落模式」的既有保证；
 *   - 把已毕业 / 未开慢启动的环境也翻掉 ⇒ 改写正在按现模式运行的环境；
 *   - 不发新 revision ⇒ 违反「模式变更必须成新修订」；
 *   - 不推镜像版本 ⇒ 消费方重启后同游标载荷漂移被拒（0108 的事故形态）。
 */

const MIGRATION = new URL(
  '../migrations/0117_slow_start_resumable_base_consumption.sql',
  import.meta.url,
);

/** 只留可执行 SQL：注释里为了讲清「刻意不动 rule」必然要点名 rule，不能让它污染反向断言。 */
async function executableSql(): Promise<string> {
  const raw = await readFile(MIGRATION, 'utf8');
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('0117 慢启动回落基线翻转范围', () => {
  test('只把 persona 翻成 consumption，绝不碰 rule', async () => {
    const sql = await executableSql();
    assert.match(sql, /SET base_mode = 'consumption'/);
    assert.match(sql, /p\.base_mode = 'persona'/);
    assert.doesNotMatch(sql, /base_mode\s*=\s*'rule'/);
  });

  test('只翻仍在 active 慢启动内的环境：要求起点在、无完成行、且未按天数推导毕业', async () => {
    const sql = await executableSql();
    assert.match(sql, /slow_start_since IS NOT NULL/);
    assert.match(
      sql,
      /NOT EXISTS \(\s*SELECT 1 FROM facebook_environment_slow_start_completion/,
    );
    // 按起点 + 全局总天数排除「推导已毕业但还没落完成行」的环境——它们正按现模式运行。
    assert.match(sql, /now\(\) < e\.slow_start_since \+ make_interval/);
    assert.match(sql, /slow_start_total_days/);
  });

  test('逐行发新 revision、写 audit，并推进 facebook_operation_policy 镜像版本', async () => {
    const sql = await executableSql();
    assert.match(
      sql,
      /policy_revision = nextval\('facebook_operation_policy_revision_seq'\)/,
    );
    assert.match(sql, /INSERT INTO facebook_operation_policy_audit/);
    assert.match(sql, /INSERT INTO config_mirror_version[\s\S]*'facebook_operation_policy'/);
    assert.match(sql, /version = config_mirror_version\.version \+ 1/);
  });
});
