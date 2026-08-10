-- 0118_facebook_cadence_mode.sql
-- aidcp:kind=expand
-- aidcp:objects=column:facebook_operation_global_policy.cadence_mode,table:config_mirror_version
--
-- Global cadence interpretation mode (change facebook-cadence-probability-mode):
-- 'fixed' keeps the existing exact-count triggers; 'probabilistic' reinterprets
-- every configured "N of A per B" value as an independent 1/N draw per eligible
-- A event. One global switch, no per-environment override.

ALTER TABLE facebook_operation_global_policy
  ADD COLUMN IF NOT EXISTS cadence_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (cadence_mode IN ('fixed', 'probabilistic'));

-- The per-environment baseline projection gains a wire-optional cadenceMode key,
-- i.e. the full payload of the facebook_operation_policy sync-read snapshot
-- changes shape without any operator writing the config. The cursor for this
-- stream comes from config_mirror_version, which only moves on config writes;
-- without this bump a consumer holding a checkpoint sees a different payload at
-- the same cursor and refuses it as same_cursor_payload_drift (0108 precedent).

INSERT INTO config_mirror_version (mirror_key, version, updated_at)
VALUES ('facebook_operation_policy', 1, now())
ON CONFLICT (mirror_key)
DO UPDATE SET
  version = config_mirror_version.version + 1,
  updated_at = now();
