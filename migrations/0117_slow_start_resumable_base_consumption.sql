-- 0117_slow_start_resumable_base_consumption.sql
-- aidcp:kind=expand
-- aidcp:objects=table:facebook_operation_policy,table:facebook_operation_policy_audit
-- aidcp:objects=table:config_mirror_version
--
-- change default-consumption-after-slow-start（DML-only，无 schema 改动）。
--
-- 冷启动（慢启动）毕业后的回落模式此前写死为 persona：统一模式 API 与建号路径在激活
-- slow_start 时都把 base_mode 自动写成 'persona'。本 change 把默认回落改为 'consumption'
-- （毕业后不依赖人设绑定即可继续运转）。代码侧只影响此后的写入；这条迁移把**当前仍在
-- active 慢启动、base_mode 还是自动写入的 'persona'** 的存量环境一次性翻成 'consumption'。
--
-- 刻意不动的：
--   * base_mode='rule'（legacy 迁移保证：既有规则模式保留为回落模式）；
--   * 未开慢启动 / 已有 completion 行 / 按起点+总天数推导已毕业的环境（它们正按现模式
--     运行，回头翻动等于改运行中环境的模式）；
--   * 非 Facebook 环境。
--
-- active 判据与运行时同源：无 completion 行，且 now() 仍在 起点 + 全局总天数 之内
-- （全局行缺席时按编译默认 7 天，与 store 的 bounds 默认一致）。
--
-- 每行发新 policy revision + audit（actor_class='migration'），与「模式变更必须成新修订」
-- 的既有规约一致；这些环境处于慢启动覆盖层下，消费/规则运行时尚未在旧修订上创建动作，
-- 修订推进不会误伤在途工作。末尾推进 facebook_operation_policy 镜像版本，让消费方在
-- 同游标载荷漂移前拿到新基线（同 0108 的教训与形态）。

WITH bumped AS (
  UPDATE facebook_operation_policy p
     SET base_mode = 'consumption',
         policy_revision = nextval('facebook_operation_policy_revision_seq'),
         updated_at = now(),
         updated_by = 'migration:0117'
    FROM client_environments e
   WHERE e.env_key = p.env_key
     AND p.base_mode = 'persona'
     AND lower(btrim(COALESCE(e.platform, ''))) IN ('facebook', 'fb')
     AND e.slow_start_since IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM facebook_environment_slow_start_completion c
            WHERE c.env_key = p.env_key
         )
     AND now() < e.slow_start_since + make_interval(
           days => COALESCE(
             (SELECT g.slow_start_total_days FROM facebook_operation_global_policy g LIMIT 1),
             7
           )
         )
  RETURNING
    p.env_key,
    p.policy_revision AS new_revision,
    p.rule_views_per_like,
    p.rule_join_every_n_rounds,
    p.consumption_views_per_like,
    p.consumption_confirmed_likes_per_join,
    p.consumption_confirmed_joins_per_comment,
    p.cadence_source
)
INSERT INTO facebook_operation_policy_audit (
  env_key,
  prior_revision,
  new_revision,
  before_policy,
  after_policy,
  actor_class,
  actor_id,
  request_id,
  reason,
  created_at
)
SELECT
  b.env_key,
  -- UPDATE 的 RETURNING 只见新值；上一修订从该环境最近一条 audit 取，首次无 audit 记 0。
  COALESCE(
    (SELECT a.new_revision FROM facebook_operation_policy_audit a
      WHERE a.env_key = b.env_key
      ORDER BY a.new_revision DESC LIMIT 1),
    0
  ),
  b.new_revision,
  jsonb_build_object('baseMode', 'persona'),
  jsonb_build_object(
    'baseMode', 'consumption',
    'cadenceSource', b.cadence_source,
    'rule', jsonb_build_object(
      'viewsPerLike', b.rule_views_per_like,
      'joinEveryNRounds', b.rule_join_every_n_rounds
    ),
    'consumption', jsonb_build_object(
      'viewsPerLike', b.consumption_views_per_like,
      'confirmedLikesPerJoin', b.consumption_confirmed_likes_per_join,
      'confirmedJoinsPerComment', b.consumption_confirmed_joins_per_comment
    )
  ),
  'migration',
  '0117',
  'migration:0117',
  'slow_start_resumable_base_default_consumption',
  now()
FROM bumped b;

-- 消费方（automation 镜像 / 客户端投影）按镜像版本失效缓存；数据变了游标必须动，
-- 否则重启后同游标载荷漂移会被正确拒绝（0108 的事故形态）。
INSERT INTO config_mirror_version (mirror_key, version, updated_at)
VALUES ('facebook_operation_policy', 1, now())
ON CONFLICT (mirror_key)
DO UPDATE SET
  version = config_mirror_version.version + 1,
  updated_at = now();
