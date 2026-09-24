'use strict';

// Additive, repeatable migrations. Never guess a historical report's group.
async function initIntegritySchema(pool) {
  await pool.query(`
    ALTER TABLE student_reports ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES mubahatha_groups(id) ON DELETE SET NULL;
    ALTER TABLE student_reports ADD COLUMN IF NOT EXISTS group_title_snapshot TEXT;
    ALTER TABLE student_reports ADD COLUMN IF NOT EXISTS source_message_id BIGINT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_source_once ON student_reports(student_id, source_message_id)
      WHERE source_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_reports_group_page ON student_reports(group_id, submitted_at, id);
    CREATE INDEX IF NOT EXISTS idx_students_stage_name_id ON students(stage_id, full_name, id);
    CREATE INDEX IF NOT EXISTS idx_memberships_group_student ON group_memberships(group_id, student_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_group_opened ON mubahatha_sessions(group_id, opened_at);
    CREATE TABLE IF NOT EXISTS absence_dirty_students (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      PRIMARY KEY(student_id,stage_season_id)
    );
    ALTER TABLE student_attendance_days ADD COLUMN IF NOT EXISTS admin_alert_queued_at TIMESTAMP;
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGSERIAL PRIMARY KEY, actor_id BIGINT NOT NULL, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      before_data JSONB, after_data JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS exam_student_windows (
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      opens_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL,
      note TEXT CHECK (length(note) <= 500),
      created_by BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (exam_id,student_id),
      CHECK (closes_at > opens_at)
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id BIGSERIAL PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
      chat_id BIGINT NOT NULL, method TEXT NOT NULL DEFAULT 'sendMessage',
      payload JSONB NOT NULL, priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','expired')),
      attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_until TIMESTAMPTZ, expires_at TIMESTAMPTZ,
      last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS student_contact_messages (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      actor_id BIGINT NOT NULL,
      actor_role TEXT NOT NULL CHECK (actor_role IN ('admin','teacher')),
      teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
      context_kind TEXT CHECK (context_kind IN ('leave','report')),
      context_id INTEGER,
      message_text TEXT NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 3000),
      request_key TEXT NOT NULL UNIQUE,
      outbox_id BIGINT REFERENCES notification_outbox(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_student_contact_messages_student ON student_contact_messages(student_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbox_due ON notification_outbox(available_at, priority, id)
      WHERE status IN ('pending','sending');
    ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS delivery_mark JSONB;
    ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT;
    ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    -- Existing historical sessions must NOT be broadcast on migration.
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS start_notifications_queued BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS end_notifications_queued BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE mubahatha_sessions ALTER COLUMN start_notifications_queued SET DEFAULT false;
    ALTER TABLE mubahatha_sessions ALTER COLUMN end_notifications_queued SET DEFAULT false;
  `);
}

function appError(message, code = 'INVALID_INPUT', status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function positiveInt(value, name = 'المعرّف') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw appError(`${name} غير صالح.`);
  return n;
}
function pageOptions(page = 0, size = 25) {
  const p = Number(page), s = Number(size);
  if (!Number.isSafeInteger(p) || p < 0 || p > 100000 || !Number.isSafeInteger(s) || s < 1 || s > 100) {
    throw appError('رقم الصفحة أو حجمها غير صالح.');
  }
  return { page: p, size: s, offset: p * s };
}
function validScore(value, max) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n) || n < 0 || n > max) {
    throw appError(`الدرجة يجب أن تكون بين 0 و${max}.`);
  }
  return Math.round(n * 100) / 100;
}
module.exports = { initIntegritySchema, appError, positiveInt, pageOptions, validScore };
