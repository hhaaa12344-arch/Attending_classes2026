// db.js — الاتصال بقاعدة بيانات PostgreSQL وإدارة الجداول والاستعلامات
const { Pool } = require('pg');
const { normalizeHashtag } = require('./utils');

const MAX_LEAVE_DAYS_PER_SEASON = 10;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // تُحفظ أعمدة الوقت القديمة بصيغة TIMESTAMP؛ تثبيت جلسة PostgreSQL على UTC
  // يمنع اختلاف تفسير المهل بين خادم وآخر، ثم نحول يوم الغياب إلى توقيت المعهد صراحةً.
  options: '-c timezone=UTC',
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// إنشاء/تحديث الجداول تلقائيًا عند كل تشغيل (آمن للتشغيل المتكرر — IF NOT EXISTS في كل مكان)
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY,
      stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hashtag TEXT
    );

    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      stage_id INTEGER NOT NULL REFERENCES stages(id),
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      activated_at TIMESTAMP NOT NULL DEFAULT now(),
      active_until TIMESTAMP NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT,
      source_chat_id BIGINT,
      source_message_id BIGINT,
      reminder_sent BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      listened_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(student_id, lesson_id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
      telegram_chat_id BIGINT NOT NULL UNIQUE,
      title TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_subjects_stage ON subjects(stage_id);
    CREATE INDEX IF NOT EXISTS idx_students_stage ON students(stage_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_subject ON lessons(subject_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
    CREATE INDEX IF NOT EXISTS idx_channels_stage ON channels(stage_id);
  `);

  // ترقية آمنة لقواعد بيانات أُنشئت بنسخة سابقة من هذا البوت (قبل إضافة هذه الأعمدة)
  await pool.query(`
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS next_stage_id INTEGER REFERENCES stages(id) ON DELETE SET NULL;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE subjects ADD COLUMN IF NOT EXISTS hashtag TEXT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_chat_id BIGINT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_message_id BIGINT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
  `);

  // المواسم مستقلة لكل مرحلة: يمكن بدء موسم لمراحل محددة وترك غيرها في موسمها الحالي.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stage_seasons (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
      stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE RESTRICT,
      stage_name_snapshot TEXT,
      started_at TIMESTAMP NOT NULL DEFAULT now(),
      ended_at TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(stage_id, season_id)
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMP NOT NULL DEFAULT now(),
      ended_at TIMESTAMP,
      UNIQUE(student_id, stage_season_id)
    );

    CREATE TABLE IF NOT EXISTS student_transitions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      from_enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
      repeat_stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      decided_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS student_leaves (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      stage_season_id INTEGER REFERENCES stage_seasons(id) ON DELETE SET NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      days INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMP NOT NULL DEFAULT now(),
      decided_at TIMESTAMP,
      decided_by BIGINT,
      backlog_notified BOOLEAN NOT NULL DEFAULT false
    );

    -- تُحفظ فقط رسائل واجهة الطالب القابلة للتنظيف؛ التنبيهات المهمة لا تُسجل هنا.
    CREATE TABLE IF NOT EXISTS student_ui_messages (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      message_id BIGINT NOT NULL,
      message_kind TEXT NOT NULL DEFAULT 'screen',
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY(student_id, message_id)
    );

    -- يمنع إرسال إشعار مستقل لكل درس؛ لكل طالب إشعار نشر واحد فقط يوميًا لكل مرحلة.
    CREATE TABLE IF NOT EXISTS student_daily_lesson_notifications (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
      notification_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY(student_id, stage_id, notification_date)
    );

    -- عند الترقية من 2.4.1 نعامل الرسائل القديمة كرسائل قائمة حتى لا تختفي
    -- لوحة الطالب في أول ضغط بعد التحديث. الجداول الجديدة تبدأ بنوع screen أعلاه.
    ALTER TABLE student_ui_messages ADD COLUMN IF NOT EXISTS message_kind TEXT;
    ALTER TABLE student_leaves
      ADD COLUMN IF NOT EXISTS stage_season_id INTEGER REFERENCES stage_seasons(id) ON DELETE SET NULL;
    UPDATE student_ui_messages SET message_kind='menu' WHERE message_kind IS NULL;
    ALTER TABLE student_ui_messages ALTER COLUMN message_kind SET DEFAULT 'screen';
    ALTER TABLE student_ui_messages ALTER COLUMN message_kind SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_seasons_one_active
      ON stage_seasons(stage_id) WHERE is_active=true;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_one_active
      ON enrollments(student_id) WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transitions_one_pending
      ON student_transitions(student_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_enrollments_stage_season ON enrollments(stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_transitions_student ON student_transitions(student_id);
    CREATE INDEX IF NOT EXISTS idx_leaves_student ON student_leaves(student_id);
    CREATE INDEX IF NOT EXISTS idx_leaves_status ON student_leaves(status);
    CREATE INDEX IF NOT EXISTS idx_leaves_stage_season
      ON student_leaves(student_id, stage_season_id, status);
    CREATE INDEX IF NOT EXISTS idx_student_ui_messages_created
      ON student_ui_messages(student_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_daily_lesson_notifications_date
      ON student_daily_lesson_notifications(notification_date);
  `);

  // تحويل البيانات القديمة إلى موسم تأسيسي واحد من دون فقد أي درس أو حضور.
  await pool.query(`
    UPDATE stages SET sort_order=id WHERE sort_order IS NULL;

    ALTER TABLE stage_seasons ADD COLUMN IF NOT EXISTS stage_name_snapshot TEXT;

    -- إزالة قيد التفرد العام القديم على اسم الموسم إن وُجد؛
    -- التفرد المطلوب صار «لا يتكرر الاسم داخل المرحلة الواحدة» ويُفرض في الكود، مما يسمح بإعادة استخدام
    -- نفس اسم الموسم (مثل «2026-2027») عبر عدة مراحل في نفس الدفعة.
    ALTER TABLE seasons DROP CONSTRAINT IF EXISTS seasons_name_key;

    ALTER TABLE students ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMP;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS official_confirmed_at TIMESTAMP;

    -- «السجل السابق» اسم مخصص لترحيل بيانات نسخة قديمة فقط.
    -- في التثبيت الجديد لا تُنشأ مواسم هنا إطلاقًا، ليأخذ أول موسم اسم «الموسم الأول» من addStage.
    INSERT INTO seasons(name)
    SELECT 'السجل السابق'
    WHERE NOT EXISTS (SELECT 1 FROM seasons)
      AND EXISTS (SELECT 1 FROM stages);

    WITH latest_season AS (
      SELECT id FROM seasons ORDER BY created_at DESC, id DESC LIMIT 1
    )
    INSERT INTO stage_seasons(season_id, stage_id, stage_name_snapshot, is_active)
    SELECT latest_season.id, st.id, st.name, true
    FROM stages st CROSS JOIN latest_season
    WHERE NOT EXISTS (SELECT 1 FROM stage_seasons ss WHERE ss.stage_id=st.id);

    UPDATE stage_seasons ss SET stage_name_snapshot=st.name
    FROM stages st WHERE st.id=ss.stage_id AND ss.stage_name_snapshot IS NULL;

    ALTER TABLE lessons
      ADD COLUMN IF NOT EXISTS stage_season_id INTEGER REFERENCES stage_seasons(id) ON DELETE RESTRICT;

    UPDATE lessons l
    SET stage_season_id = chosen.id
    FROM subjects sub
    JOIN LATERAL (
      SELECT ss.id FROM stage_seasons ss
      WHERE ss.stage_id=sub.stage_id
      ORDER BY ss.started_at, ss.id LIMIT 1
    ) chosen ON true
    WHERE l.subject_id=sub.id AND l.stage_season_id IS NULL;

    INSERT INTO enrollments(student_id, stage_season_id, status, started_at)
    SELECT st.id, ss.id, 'active', st.created_at
    FROM students st
    JOIN stage_seasons ss ON ss.stage_id=st.stage_id AND ss.is_active=true
    WHERE NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id=st.id);

    -- ربط الإجازات القديمة بالموسم الذي كان الطالب مسجلًا فيه وقت تقديمها.
    UPDATE student_leaves sl
    SET stage_season_id = (
      SELECT e.stage_season_id
      FROM enrollments e
      WHERE e.student_id=sl.student_id
        AND sl.requested_at >= e.started_at
        AND sl.requested_at <= COALESCE(e.ended_at, 'infinity'::timestamp)
      ORDER BY e.started_at DESC, e.id DESC
      LIMIT 1
    )
    WHERE sl.stage_season_id IS NULL
      AND EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.student_id=sl.student_id
          AND sl.requested_at >= e.started_at
          AND sl.requested_at <= COALESCE(e.ended_at, 'infinity'::timestamp)
      );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_stage_hashtag
      ON subjects(stage_id, hashtag) WHERE hashtag IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_source_message
      ON lessons(source_chat_id, source_message_id)
      WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_lessons_stage_season ON lessons(stage_season_id);
  `);

  // لقطة يومية ثابتة عند اكتمال مهل دروس اليوم؛ لا يسمح البوت بالتأشير بعد انتهاء المهلة.
  // يبدأ الرصد من تاريخ تثبيت هذه النسخة حتى لا ترسل الترقية تنبيهات عن غيابات تاريخية قديمة.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS absence_monitoring_config (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      started_at TIMESTAMP NOT NULL DEFAULT now()
    );

    INSERT INTO absence_monitoring_config(id) VALUES(1)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS student_attendance_days (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      attendance_date DATE NOT NULL,
      lesson_count INTEGER NOT NULL CHECK (lesson_count > 0),
      attended_on_time_count INTEGER NOT NULL CHECK (attended_on_time_count >= 0),
      missed_lesson_count INTEGER NOT NULL CHECK (missed_lesson_count >= 0),
      is_excused_leave BOOLEAN NOT NULL DEFAULT false,
      is_full_absence BOOLEAN NOT NULL,
      processed_at TIMESTAMP NOT NULL DEFAULT now(),
      student_alert_sent_at TIMESTAMP,
      admin_alert_sent_at TIMESTAMP,
      UNIQUE(student_id, stage_season_id, attendance_date)
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_days_student_date
      ON student_attendance_days(student_id, stage_season_id, attendance_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_days_student_alert
      ON student_attendance_days(student_alert_sent_at) WHERE student_alert_sent_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attendance_days_admin_alert
      ON student_attendance_days(admin_alert_sent_at) WHERE admin_alert_sent_at IS NULL;

    ALTER TABLE student_attendance_days
      ADD COLUMN IF NOT EXISTS is_excused_leave BOOLEAN NOT NULL DEFAULT false;

    -- تصحيح أي لقطة أنشأها الإصدار 2.3.0 ليوم كان الطالب فيه بإجازة معتمدة.
    UPDATE student_attendance_days d
    SET is_excused_leave=true, is_full_absence=false
    WHERE EXISTS (
      SELECT 1 FROM student_leaves sl
      WHERE sl.student_id=d.student_id AND sl.status IN ('approved','ended')
        AND d.attendance_date BETWEEN sl.start_date AND sl.end_date
    );
  `);
}

// ---------- المراحل ----------
async function addStage(name) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let season = await client.query('SELECT id FROM seasons ORDER BY created_at DESC, id DESC LIMIT 1');
    if (!season.rows[0]) {
      season = await client.query("INSERT INTO seasons(name) VALUES('الموسم الأول') RETURNING id");
    }
    const stage = await client.query(
      `INSERT INTO stages(name, sort_order)
       VALUES($1, COALESCE((SELECT MAX(sort_order) + 1 FROM stages), 1)) RETURNING *`,
      [name]
    );
    await client.query(
      'INSERT INTO stage_seasons(season_id, stage_id, stage_name_snapshot, is_active) VALUES($1,$2,$3,true)',
      [season.rows[0].id, stage.rows[0].id, stage.rows[0].name]
    );
    await client.query('COMMIT');
    return stage.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const listStages = () =>
  pool
    .query('SELECT * FROM stages WHERE is_active=true ORDER BY sort_order, id')
    .then((r) => r.rows);

const listAllStages = () =>
  pool
    .query(
      `SELECT st.*, next.name AS next_stage_name,
              (SELECT COUNT(*) FROM students s WHERE s.stage_id=st.id AND s.is_active=true) AS student_count
       FROM stages st LEFT JOIN stages next ON next.id=st.next_stage_id
       ORDER BY st.sort_order, st.id`
    )
    .then((r) => r.rows);

const getStageById = (stageId) =>
  pool
    .query(
      `SELECT st.*, next.name AS next_stage_name,
              (SELECT COUNT(*) FROM students s WHERE s.stage_id=st.id AND s.is_active=true) AS student_count
       FROM stages st LEFT JOIN stages next ON next.id=st.next_stage_id
       WHERE st.id=$1`,
      [stageId]
    )
    .then((r) => r.rows[0]);

async function updateStageName(stageId, name) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stage = await client.query('UPDATE stages SET name=$1 WHERE id=$2 RETURNING *', [name, stageId]);
    await client.query(
      'UPDATE stage_seasons SET stage_name_snapshot=$1 WHERE stage_id=$2 AND is_active=true',
      [name, stageId]
    );
    await client.query('COMMIT');
    return stage.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const archiveStage = (stageId) =>
  pool.query('UPDATE stages SET is_active=false WHERE id=$1 RETURNING *', [stageId]).then((r) => r.rows[0]);

const restoreStage = (stageId) =>
  pool.query('UPDATE stages SET is_active=true WHERE id=$1 RETURNING *', [stageId]).then((r) => r.rows[0]);

// حذف نهائي للمرحلة وكل ما يتعلق بها: طلبتها، موادها ودروسها وحضورها، مواسمها وتسجيلاتها، قنواتها.
// يتم بترتيب صريح داخل معاملة واحدة لتجاوز قيود ON DELETE RESTRICT، فإما ينجح كله أو يُلغى كله.
async function hardDeleteStage(stageId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // فكّ ربط أي مرحلة تشير إلى هذه كمرحلة أعلى لها
    await client.query('UPDATE stages SET next_stage_id=NULL WHERE next_stage_id=$1', [stageId]);

    // طلبة هذه المرحلة: حذفهم نهائيًا يُسقط تلقائيًا تسجيلاتهم وانتقالاتهم وحضورهم وإجازاتهم (CASCADE على student_id)
    await client.query('DELETE FROM students WHERE stage_id=$1', [stageId]);

    // دروس مواد هذه المرحلة (ثم المواد) — الحضور يسقط تلقائيًا مع الدرس
    await client.query(
      'DELETE FROM lessons WHERE subject_id IN (SELECT id FROM subjects WHERE stage_id=$1)',
      [stageId]
    );
    await client.query('DELETE FROM subjects WHERE stage_id=$1', [stageId]);

    // ما تبقّى من تسجيلات/انتقالات مرتبطة بمواسم هذه المرحلة (لطلبة انتقلوا من هنا مثلًا)
    await client.query(
      `DELETE FROM student_transitions WHERE repeat_stage_season_id IN
         (SELECT id FROM stage_seasons WHERE stage_id=$1)`,
      [stageId]
    );
    await client.query(
      `DELETE FROM enrollments WHERE stage_season_id IN
         (SELECT id FROM stage_seasons WHERE stage_id=$1)`,
      [stageId]
    );

    await client.query('DELETE FROM channels WHERE stage_id=$1', [stageId]);
    await client.query('DELETE FROM stage_seasons WHERE stage_id=$1', [stageId]);
    const result = await client.query('DELETE FROM stages WHERE id=$1 RETURNING id', [stageId]);

    await client.query('COMMIT');
    return result.rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setStageNext(stageId, nextStageId) {
  if (nextStageId === null) {
    return pool
      .query('UPDATE stages SET next_stage_id=NULL WHERE id=$1 RETURNING *', [stageId])
      .then((r) => r.rows[0]);
  }
  if (Number(stageId) === Number(nextStageId)) {
    const err = new Error('لا يمكن أن تكون المرحلة هي المرحلة الأعلى لنفسها.');
    err.code = 'STAGE_CYCLE';
    throw err;
  }
  const cycle = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT id, next_stage_id FROM stages WHERE id=$2
       UNION ALL
       SELECT st.id, st.next_stage_id FROM stages st
       JOIN chain c ON st.id=c.next_stage_id
     )
     SELECT 1 FROM chain WHERE id=$1 LIMIT 1`,
    [stageId, nextStageId]
  );
  if (cycle.rows[0]) {
    const err = new Error('هذا الربط يصنع حلقة بين المراحل.');
    err.code = 'STAGE_CYCLE';
    throw err;
  }
  return pool
    .query('UPDATE stages SET next_stage_id=$1 WHERE id=$2 RETURNING *', [nextStageId, stageId])
    .then((r) => r.rows[0]);
}

// ---------- المواد ----------
const addSubject = (stageId, name, hashtag) =>
  pool
    .query('INSERT INTO subjects(stage_id, name, hashtag) VALUES($1,$2,$3) RETURNING *', [
      stageId,
      name,
      normalizeHashtag(hashtag) || null,
    ])
    .then((r) => r.rows[0]);

const listSubjectsByStage = (stageId) =>
  pool
    .query('SELECT * FROM subjects WHERE stage_id=$1 ORDER BY id', [stageId])
    .then((r) => r.rows);

// إيجاد مادة داخل مرحلة معيّنة اعتمادًا على الهاشتاغ (أو اسمها بدون مسافات كخيار احتياطي)
const findSubjectByHashtag = async (stageId, hashtag) => {
  const clean = normalizeHashtag(hashtag);
  const r = await pool.query('SELECT * FROM subjects WHERE stage_id=$1 ORDER BY id', [stageId]);
  return r.rows.find(
    (subject) =>
      normalizeHashtag(subject.hashtag || '') === clean || normalizeHashtag(subject.name) === clean
  );
};

const getSubjectById = (subjectId) =>
  pool
    .query(
      `SELECT sub.*, st.name AS stage_name
       FROM subjects sub JOIN stages st ON st.id=sub.stage_id
       WHERE sub.id=$1`,
      [subjectId]
    )
    .then((r) => r.rows[0]);

const updateSubjectHashtag = (subjectId, hashtag) =>
  pool
    .query('UPDATE subjects SET hashtag=$1 WHERE id=$2 RETURNING *', [normalizeHashtag(hashtag), subjectId])
    .then((r) => r.rows[0]);

// حذف نهائي للمادة: يمحوها مع كل دروسها وسجل حضورها (عبر ON DELETE CASCADE).
async function hardDeleteSubject(subjectId) {
  const result = await pool.query('DELETE FROM subjects WHERE id=$1 RETURNING id', [subjectId]);
  return result.rowCount > 0;
}

// ---------- الطلبة ----------
const getStudentByTelegramId = (telegramId) =>
  pool
    .query(
      `SELECT st.*, sg.name AS stage_name FROM students st
       JOIN stages sg ON sg.id = st.stage_id
       WHERE st.telegram_id=$1`,
      [telegramId]
    )
    .then((r) => r.rows[0]);

async function createStudent(telegramId, fullName, stageId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stageSeason = await client.query(
      `SELECT ss.id FROM stage_seasons ss
       JOIN stages st ON st.id=ss.stage_id AND st.is_active=true
       WHERE ss.stage_id=$1 AND ss.is_active=true FOR UPDATE OF ss`,
      [stageId]
    );
    if (!stageSeason.rows[0]) throw new Error('لا يوجد موسم نشط لهذه المرحلة.');
    const student = await client.query(
      'INSERT INTO students(telegram_id, full_name, stage_id) VALUES($1,$2,$3) RETURNING *',
      [telegramId, fullName, stageId]
    );
    await client.query(
      'INSERT INTO enrollments(student_id, stage_season_id, status) VALUES($1,$2,\'active\')',
      [student.rows[0].id, stageSeason.rows[0].id]
    );
    await client.query('COMMIT');
    return student.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const markWelcomed = (studentId) =>
  pool.query('UPDATE students SET welcomed_at=now() WHERE id=$1 AND welcomed_at IS NULL', [studentId]);

const confirmOfficialStudent = (studentId) =>
  pool
    .query(
      `UPDATE students
       SET official_confirmed_at=COALESCE(official_confirmed_at, now()),
           welcomed_at=COALESCE(welcomed_at, now())
       WHERE id=$1 RETURNING *`,
      [studentId]
    )
    .then((r) => r.rows[0]);

const searchStudents = (query, limit = 10) =>
  pool
    .query(
      `SELECT st.*, sg.name AS stage_name FROM students st
       JOIN stages sg ON sg.id = st.stage_id
       WHERE st.full_name ILIKE $1
       ORDER BY st.full_name LIMIT $2`,
      [`%${query}%`, limit]
    )
    .then((r) => r.rows);

const getStudentById = (id) =>
  pool
    .query(
      `SELECT st.*, sg.name AS stage_name FROM students st
       JOIN stages sg ON sg.id = st.stage_id WHERE st.id=$1`,
      [id]
    )
    .then((r) => r.rows[0]);

const updateStudentName = (id, name) =>
  pool.query('UPDATE students SET full_name=$1 WHERE id=$2', [name, id]);

async function updateStudentStage(id, stageId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      'SELECT id FROM stage_seasons WHERE stage_id=$1 AND is_active=true FOR UPDATE',
      [stageId]
    );
    if (!target.rows[0]) throw new Error('لا يوجد موسم نشط للمرحلة الجديدة.');
    await client.query(
      `UPDATE enrollments SET status='moved', ended_at=now()
       WHERE student_id=$1 AND status='active'`,
      [id]
    );
    await client.query(
      `INSERT INTO enrollments(student_id, stage_season_id, status)
       VALUES($1,$2,'active')
       ON CONFLICT (student_id, stage_season_id)
       DO UPDATE SET status='active', ended_at=NULL, started_at=now()`,
      [id, target.rows[0].id]
    );
    await client.query('UPDATE students SET stage_id=$1, is_active=true WHERE id=$2', [stageId, id]);
    await client.query(
      `UPDATE student_transitions SET status='cancelled', decision='admin_moved', decided_at=now()
       WHERE student_id=$1 AND status='pending'`,
      [id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// حذف بالأرشفة: يبقي كل بيانات الطالب وسجل حضوره، ويخفيه فقط من القوائم النشطة.
async function archiveStudent(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE students SET is_active=false WHERE id=$1', [id]);
    await client.query(
      `UPDATE enrollments SET status='archived', ended_at=COALESCE(ended_at, now())
       WHERE student_id=$1 AND status='active'`,
      [id]
    );
    await client.query(
      `UPDATE student_transitions SET status='cancelled', decision='student_archived', decided_at=now()
       WHERE student_id=$1 AND status='pending'`,
      [id]
    );
    await client.query(
      `UPDATE student_leaves SET status='cancelled', decided_at=now()
       WHERE student_id=$1 AND status='pending'`,
      [id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// حذف نهائي: يمحو الطالب وكل سجلاته (حضور، تسجيلات، انتقالات، إجازات) بلا رجعة.
// الحذف المتسلسل (ON DELETE CASCADE) في المخطط يتكفل بالجداول التابعة.
async function hardDeleteStudent(id) {
  const result = await pool.query('DELETE FROM students WHERE id=$1 RETURNING id', [id]);
  return result.rowCount > 0;
}

const getStudentsByStage = (stageId) =>
  pool
    .query('SELECT * FROM students WHERE stage_id=$1 AND is_active=true', [stageId])
    .then((r) => r.rows);

// ---------- المواسم وانتقال الطلبة ----------
// season_name: الاسم الذي كتبه الأدمن للموسم (مثل «الموسم الأول 2026»)، يُعرض كما هو.
// season_number: رقم ترتيبي مساعد داخل المرحلة (1 = أول موسم)، يُستخدم لاقتراح اسم افتراضي فقط.
// recency_rank: ترتيب الحداثة (1=الأحدث/النشط دائمًا، 2=الذي سبقه مباشرة). يُستخدم لعرض وسم «الحالي/السابق».
const RANKED_STAGE_SEASONS_CTE = `
  SELECT ss.*, st.name AS current_stage_name, se.name AS season_name,
         ROW_NUMBER() OVER (PARTITION BY ss.stage_id ORDER BY ss.started_at ASC, ss.id ASC) AS season_number,
         ROW_NUMBER() OVER (PARTITION BY ss.stage_id ORDER BY ss.started_at DESC, ss.id DESC) AS recency_rank
  FROM stage_seasons ss
  JOIN stages st ON st.id = ss.stage_id
  JOIN seasons se ON se.id = ss.season_id
`;

const listStageSeasons = (stageId) =>
  pool
    .query(
      `WITH ranked AS (${RANKED_STAGE_SEASONS_CTE})
       SELECT r.*, COALESCE(r.stage_name_snapshot, r.current_stage_name) AS stage_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.stage_season_id=r.id) AS student_count,
              (SELECT COUNT(*) FROM lessons l WHERE l.stage_season_id=r.id) AS lesson_count
       FROM ranked r WHERE r.stage_id=$1 ORDER BY r.started_at DESC, r.id DESC`,
      [stageId]
    )
    .then((r) => r.rows);

// مواسم مرحلة معيّنة التي كان الطالب مسجَّلًا فيها فعليًا (لأي حالة تسجيل) — لقائمة اختيار «تقريري».
const listStudentSeasons = (studentId) =>
  pool
    .query(
      `WITH ranked AS (${RANKED_STAGE_SEASONS_CTE})
       SELECT r.*, COALESCE(r.stage_name_snapshot, r.current_stage_name) AS stage_name,
              (SELECT COUNT(*) FROM lessons l WHERE l.stage_season_id=r.id) AS lesson_count
       FROM ranked r
       JOIN enrollments e ON e.stage_season_id = r.id
       WHERE e.student_id = $1
       ORDER BY r.started_at DESC, r.id DESC`,
      [studentId]
    )
    .then((r) => r.rows);

async function startSeasonForStages(name, stageIds) {
  const seasonName = (name || '').trim();
  if (!seasonName) throw new Error('يجب إدخال اسم الموسم.');
  const ids = [...new Set((stageIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) throw new Error('يجب اختيار مرحلة واحدة على الأقل.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // «seasons» صف يجمع دفعة المراحل التي بدأت معًا، ويحمل الاسم الذي كتبه الأدمن ويُعرض كما هو.
    const seasonResult = await client.query(
      'INSERT INTO seasons(name) VALUES($1) RETURNING *',
      [seasonName]
    );
    const season = seasonResult.rows[0];
    const summary = [];

    for (const stageId of ids) {
      const stage = await client.query(
        'SELECT * FROM stages WHERE id=$1 AND is_active=true FOR UPDATE',
        [stageId]
      );
      if (!stage.rows[0]) {
        const err = new Error(`المرحلة رقم ${stageId} غير موجودة أو مؤرشفة.`);
        err.code = 'INVALID_STAGE';
        throw err;
      }

      // منع تكرار نفس اسم الموسم لنفس المرحلة، حتى لا يلتبس تقريران باسم واحد.
      const dupName = await client.query(
        `SELECT 1 FROM stage_seasons ss JOIN seasons se ON se.id=ss.season_id
         WHERE ss.stage_id=$1 AND se.name=$2 LIMIT 1`,
        [stageId, seasonName]
      );
      if (dupName.rows[0]) {
        const err = new Error(`للمرحلة «${stage.rows[0].name}» موسم بنفس الاسم «${seasonName}» مسبقًا.`);
        err.code = 'DUPLICATE_SEASON_NAME';
        throw err;
      }

      const current = await client.query(
        'SELECT * FROM stage_seasons WHERE stage_id=$1 AND is_active=true FOR UPDATE',
        [stageId]
      );
      const oldStageSeason = current.rows[0];

      if (oldStageSeason) {
        const pending = await client.query(
          `SELECT 1 FROM student_transitions tr
           JOIN enrollments e ON e.id=tr.from_enrollment_id
           WHERE (e.stage_season_id=$1 OR tr.repeat_stage_season_id=$1)
             AND tr.status='pending' LIMIT 1`,
          [oldStageSeason.id]
        );
        if (pending.rows[0]) {
          const err = new Error(`ما زال في المرحلة «${stage.rows[0].name}» طلبة لم يختاروا وضعهم للموسم السابق.`);
          err.code = 'PENDING_TRANSITIONS';
          throw err;
        }
        await client.query(
          'UPDATE stage_seasons SET is_active=false, ended_at=now() WHERE id=$1',
          [oldStageSeason.id]
        );
      }

      const newStageSeason = await client.query(
        `INSERT INTO stage_seasons(season_id, stage_id, stage_name_snapshot, is_active)
         VALUES($1,$2,$3,true) RETURNING *`,
        [season.id, stageId, stage.rows[0].name]
      );

      let affectedStudents = [];
      if (oldStageSeason) {
        affectedStudents = (
          await client.query(
            `UPDATE enrollments SET status='awaiting_decision', ended_at=now()
             WHERE stage_season_id=$1 AND status='active' RETURNING *`,
            [oldStageSeason.id]
          )
        ).rows;
        for (const enrollment of affectedStudents) {
          await client.query(
            `INSERT INTO student_transitions(
               student_id, from_enrollment_id, repeat_stage_season_id, status
             ) VALUES($1,$2,$3,'pending')`,
            [enrollment.student_id, enrollment.id, newStageSeason.rows[0].id]
          );
        }
      }
      summary.push({
        stageId,
        stageName: stage.rows[0].name,
        affectedStudents: affectedStudents.length,
        stageSeasonId: newStageSeason.rows[0].id,
      });
    }

    await client.query('COMMIT');
    return { season, stages: summary };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const getPendingTransition = (studentId) =>
  pool
    .query(
      `WITH ranked AS (${RANKED_STAGE_SEASONS_CTE})
       SELECT tr.*, source_stage.id AS source_stage_id, source_stage.name AS source_stage_name,
              repeat_r.season_number AS repeat_season_number,
              repeat_r.season_name AS repeat_season_name,
              next_stage.id AS next_stage_id, next_stage.name AS next_stage_name
       FROM student_transitions tr
       JOIN enrollments old_e ON old_e.id=tr.from_enrollment_id
       JOIN stage_seasons old_ss ON old_ss.id=old_e.stage_season_id
       JOIN stages source_stage ON source_stage.id=old_ss.stage_id
       JOIN ranked repeat_r ON repeat_r.id=tr.repeat_stage_season_id
       LEFT JOIN stages next_stage
         ON next_stage.id=source_stage.next_stage_id AND next_stage.is_active=true
       WHERE tr.student_id=$1 AND tr.status='pending'
       LIMIT 1`,
      [studentId]
    )
    .then((r) => r.rows[0]);

async function resolveStudentTransition(studentId, decision) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transition = await client.query(
      `SELECT tr.*, old_ss.stage_id AS source_stage_id, source_stage.next_stage_id
       FROM student_transitions tr
       JOIN enrollments old_e ON old_e.id=tr.from_enrollment_id
       JOIN stage_seasons old_ss ON old_ss.id=old_e.stage_season_id
       JOIN stages source_stage ON source_stage.id=old_ss.stage_id
       WHERE tr.student_id=$1 AND tr.status='pending' FOR UPDATE`,
      [studentId]
    );
    const pending = transition.rows[0];
    if (!pending) {
      const err = new Error('لا يوجد انتقال موسم معلّق لهذا الطالب.');
      err.code = 'NO_PENDING_TRANSITION';
      throw err;
    }

    let targetStageId;
    let targetStageSeasonId;
    if (decision === 'repeat') {
      const repeat = await client.query(
        'SELECT * FROM stage_seasons WHERE id=$1 AND is_active=true',
        [pending.repeat_stage_season_id]
      );
      if (!repeat.rows[0]) throw new Error('موسم الإعادة لم يعد نشطًا. راجع الأدمن.');
      targetStageId = repeat.rows[0].stage_id;
      targetStageSeasonId = repeat.rows[0].id;
    } else if (decision === 'promote') {
      if (!pending.next_stage_id) {
        const err = new Error('لم يحدد الأدمن مرحلة أعلى لهذه المرحلة.');
        err.code = 'NO_NEXT_STAGE';
        throw err;
      }
      const target = await client.query(
        `SELECT ss.id AS stage_season_id, st.id AS stage_id
         FROM stages st JOIN stage_seasons ss ON ss.stage_id=st.id AND ss.is_active=true
         WHERE st.id=$1 AND st.is_active=true`,
        [pending.next_stage_id]
      );
      if (!target.rows[0]) throw new Error('المرحلة الأعلى غير نشطة أو ليس لها موسم نشط.');
      targetStageId = target.rows[0].stage_id;
      targetStageSeasonId = target.rows[0].stage_season_id;
    } else {
      throw new Error('قرار الانتقال غير صحيح.');
    }

    await client.query(
      `INSERT INTO enrollments(student_id, stage_season_id, status)
       VALUES($1,$2,'active')
       ON CONFLICT (student_id, stage_season_id)
       DO UPDATE SET status='active', ended_at=NULL, started_at=now()`,
      [studentId, targetStageSeasonId]
    );
    await client.query('UPDATE students SET stage_id=$1 WHERE id=$2', [targetStageId, studentId]);
    await client.query(
      `UPDATE student_transitions
       SET status='completed', decision=$1, decided_at=now() WHERE id=$2`,
      [decision, pending.id]
    );
    await client.query('COMMIT');
    return getStudentById(studentId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------- القنوات ----------
const linkChannel = (stageId, chatId, title) =>
  pool
    .query(
      `INSERT INTO channels(stage_id, telegram_chat_id, title) VALUES($1,$2,$3)
       ON CONFLICT (telegram_chat_id) DO UPDATE SET stage_id=$1, title=$3 RETURNING *`,
      [stageId, chatId, title]
    )
    .then((r) => r.rows[0]);

const getChannelByChatId = (chatId) =>
  pool.query('SELECT * FROM channels WHERE telegram_chat_id=$1', [chatId]).then((r) => r.rows[0]);

const listChannelsWithStage = () =>
  pool
    .query(
      `SELECT c.*, s.name AS stage_name FROM channels c
       JOIN stages s ON s.id = c.stage_id ORDER BY c.id`
    )
    .then((r) => r.rows);

const unlinkChannel = (id) => pool.query('DELETE FROM channels WHERE id=$1', [id]);

// ---------- الدروس ----------
const activateLesson = (
  subjectId,
  hours = 24,
  sourceType = 'manual',
  sourceUrl = null,
  sourceChatId = null,
  sourceMessageId = null
) =>
  pool
    .query(
      `INSERT INTO lessons(
         subject_id, stage_season_id, activated_at, active_until, source_type, source_url,
         source_chat_id, source_message_id
       )
       SELECT sub.id, ss.id, now(), now() + ($2 || ' hours')::interval, $3, $4, $5, $6
       FROM subjects sub
       JOIN stages st ON st.id=sub.stage_id AND st.is_active=true
       JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.is_active=true
       WHERE sub.id=$1
       ON CONFLICT (source_chat_id, source_message_id)
         WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL
       DO UPDATE SET source_url=COALESCE(EXCLUDED.source_url, lessons.source_url)
       RETURNING *`,
      [subjectId, hours, sourceType, sourceUrl, sourceChatId, sourceMessageId]
    )
    .then((r) => r.rows[0]);

const getLessonBySource = (chatId, messageId) =>
  pool
    .query(
      'SELECT * FROM lessons WHERE source_chat_id=$1 AND source_message_id=$2 LIMIT 1',
      [chatId, messageId]
    )
    .then((r) => r.rows[0]);

const getActiveLessonsForStudent = (stageId, studentId) =>
  pool
    .query(
      `SELECT l.id AS lesson_id, s.name AS subject_name, l.active_until, l.source_url,
              (SELECT COUNT(*) FROM lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number,
              false AS attended
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       JOIN enrollments e
         ON e.stage_season_id=l.stage_season_id AND e.student_id=$2 AND e.status='active'
       WHERE s.stage_id = $1 AND l.active_until > now()
         AND NOT EXISTS(
           SELECT 1 FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=$2
         )
       ORDER BY l.activated_at DESC`,
      [stageId, studentId]
    )
    .then((r) => r.rows);

// حجز ذري لإشعار نشر دروس اليوم. إذا فشل إرسال تليجرام يُلغى الحجز كي تعاد المحاولة لاحقًا.
const claimDailyLessonNotification = (studentId, stageId, notificationDate) =>
  pool
    .query(
      `INSERT INTO student_daily_lesson_notifications(student_id, stage_id, notification_date)
       VALUES($1,$2,$3::date)
       ON CONFLICT (student_id, stage_id, notification_date) DO NOTHING
       RETURNING student_id`,
      [studentId, stageId, notificationDate]
    )
    .then((r) => Boolean(r.rows[0]));

const releaseDailyLessonNotification = (studentId, stageId, notificationDate) =>
  pool.query(
    `DELETE FROM student_daily_lesson_notifications
     WHERE student_id=$1 AND stage_id=$2 AND notification_date=$3::date`,
    [studentId, stageId, notificationDate]
  );

const getLessonById = (lessonId) =>
  pool
    .query(
      `SELECT l.*, s.stage_id, s.name AS subject_name,
              (SELECT COUNT(*) FROM lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number
       FROM lessons l
       JOIN subjects s ON s.id=l.subject_id WHERE l.id=$1`,
      [lessonId]
    )
    .then((r) => r.rows[0]);

const markAttendance = (studentId, lessonId) =>
  pool
    .query(
      `INSERT INTO attendance(student_id, lesson_id)
       SELECT $1, l.id
       FROM lessons l
       JOIN enrollments e
         ON e.stage_season_id=l.stage_season_id AND e.student_id=$1 AND e.status='active'
       WHERE l.id=$2 AND l.active_until >= now()
       ON CONFLICT (student_id, lesson_id) DO NOTHING RETURNING *`,
      [studentId, lessonId]
    )
    .then((r) => r.rows[0]);

const canStudentAttendLesson = (studentId, lessonId) =>
  pool
    .query(
      `SELECT 1 FROM lessons l
       JOIN enrollments e ON e.stage_season_id=l.stage_season_id
       WHERE l.id=$2 AND e.student_id=$1 AND e.status='active' LIMIT 1`,
      [studentId, lessonId]
    )
    .then((r) => Boolean(r.rows[0]));

// ---------- الإجازات ----------
// الطالب يحدد تاريخ البداية وعدد الأيام؛ مجموع الموافق عليه والمعلّق لا يتجاوز 10 أيام في الموسم.
async function requestLeave(studentId, startDate, days, reason) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1) throw new Error('عدد أيام الإجازة يجب أن يكون رقمًا صحيحًا موجبًا.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // قفل صف الطالب يجعل فحص الرصيد وإضافة الطلب عملية ذرية حتى مع طلبين متزامنين.
    const student = await client.query('SELECT id FROM students WHERE id=$1 FOR UPDATE', [studentId]);
    if (!student.rows[0]) throw new Error('الطالب غير موجود.');

    const enrollment = await client.query(
      `SELECT e.stage_season_id
       FROM enrollments e
       WHERE e.student_id=$1 AND e.status='active'
       ORDER BY e.started_at DESC, e.id DESC LIMIT 1`,
      [studentId]
    );
    if (!enrollment.rows[0]) {
      const err = new Error('لا يوجد موسم دراسي نشط في حسابك حاليًا.');
      err.code = 'NO_ACTIVE_SEASON';
      throw err;
    }
    const stageSeasonId = Number(enrollment.rows[0].stage_season_id);
    const usage = await client.query(
      `SELECT COALESCE(SUM(days), 0)::integer AS used_days
       FROM student_leaves
       WHERE student_id=$1 AND stage_season_id=$2 AND status IN ('pending','approved','ended')`,
      [studentId, stageSeasonId]
    );
    const usedDays = Number(usage.rows[0].used_days);
    const remainingDays = Math.max(0, MAX_LEAVE_DAYS_PER_SEASON - usedDays);
    if (d > remainingDays) {
      const err = new Error(
        remainingDays === 0
          ? `استنفدت رصيد الإجازات للموسم الحالي (${MAX_LEAVE_DAYS_PER_SEASON} أيام).`
          : `المتبقي من رصيد إجازاتك في هذا الموسم ${remainingDays} يوم فقط من أصل ${MAX_LEAVE_DAYS_PER_SEASON}.`
      );
      err.code = 'LEAVE_SEASON_LIMIT';
      err.usedDays = usedDays;
      err.remainingDays = remainingDays;
      throw err;
    }

    // منع تداخل طلب جديد مع إجازة قائمة (معلّقة أو موافق عليها) لم تنتهِ بعد.
    const overlap = await client.query(
      `SELECT 1 FROM student_leaves
       WHERE student_id=$1 AND status IN ('pending','approved')
         AND end_date >= $2::date LIMIT 1`,
      [studentId, startDate]
    );
    if (overlap.rows[0]) {
      const err = new Error('لديك إجازة قائمة أو طلب معلّق يتداخل مع هذا التاريخ.');
      err.code = 'LEAVE_OVERLAP';
      throw err;
    }

    const result = await client.query(
      `INSERT INTO student_leaves(
         student_id, stage_season_id, start_date, end_date, days, reason, status
       )
       VALUES($1, $2, $3::date, ($3::date + ($4 - 1) * interval '1 day')::date, $4, $5, 'pending')
       RETURNING *`,
      [studentId, stageSeasonId, startDate, d, reason || null]
    );
    await client.query('COMMIT');
    return {
      ...result.rows[0],
      used_days: usedDays + d,
      remaining_days: remainingDays - d,
      max_days: MAX_LEAVE_DAYS_PER_SEASON,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const getCurrentSeasonLeaveUsage = (studentId) =>
  pool
    .query(
      `SELECT e.stage_season_id,
              COALESCE(SUM(sl.days) FILTER (WHERE sl.status IN ('approved','ended')), 0)::integer AS approved_days,
              COALESCE(SUM(sl.days) FILTER (WHERE sl.status='pending'), 0)::integer AS pending_days
       FROM enrollments e
       LEFT JOIN student_leaves sl
         ON sl.student_id=e.student_id AND sl.stage_season_id=e.stage_season_id
       WHERE e.student_id=$1 AND e.status='active'
       GROUP BY e.stage_season_id
       ORDER BY MAX(e.started_at) DESC LIMIT 1`,
      [studentId]
    )
    .then((r) => {
      const row = r.rows[0];
      if (!row) return null;
      const approvedDays = Number(row.approved_days);
      const pendingDays = Number(row.pending_days);
      return {
        stageSeasonId: Number(row.stage_season_id),
        approvedDays,
        pendingDays,
        reservedDays: approvedDays + pendingDays,
        remainingDays: Math.max(0, MAX_LEAVE_DAYS_PER_SEASON - approvedDays - pendingDays),
        maxDays: MAX_LEAVE_DAYS_PER_SEASON,
      };
    });

const getLeaveById = (leaveId) =>
  pool
    .query(
      `SELECT sl.*, st.full_name, st.telegram_id, sg.name AS stage_name
       FROM student_leaves sl
       JOIN students st ON st.id=sl.student_id
       JOIN stages sg ON sg.id=st.stage_id
       WHERE sl.id=$1`,
      [leaveId]
    )
    .then((r) => r.rows[0]);

async function decideLeave(leaveId, approve, adminTelegramId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE student_leaves
       SET status=$2, decided_at=now(), decided_by=$3
       WHERE id=$1 AND status='pending' RETURNING *`,
      [leaveId, approve ? 'approved' : 'rejected', adminTelegramId]
    );
    const leave = result.rows[0];
    if (leave && approve) {
      // إذا جاءت الموافقة بعد حفظ لقطة يوم ما، تُصحَّح فورًا إلى يوم إجازة غير محسوب.
      await client.query(
        `UPDATE student_attendance_days
         SET is_excused_leave=true, is_full_absence=false
         WHERE student_id=$1 AND attendance_date BETWEEN $2::date AND $3::date`,
        [leave.student_id, leave.start_date, leave.end_date]
      );
    }
    await client.query('COMMIT');
    return leave;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cancelLeave(studentId, leaveId, returnDate = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT * FROM student_leaves
       WHERE id=$1 AND student_id=$2 AND status IN ('pending','approved') FOR UPDATE`,
      [leaveId, studentId]
    );
    const leave = found.rows[0];
    if (!leave) {
      await client.query('COMMIT');
      return undefined;
    }
    let result;
    if (leave.status === 'pending') {
      result = await client.query(
        `UPDATE student_leaves SET status='cancelled', decided_at=now()
         WHERE id=$1 RETURNING *`,
        [leaveId]
      );
    } else {
      const effectiveReturnDate = returnDate || new Date().toISOString().slice(0, 10);
      result = await client.query(
        `UPDATE student_leaves
         SET status='ended',
             end_date=CASE
               WHEN $2::date <= start_date THEN start_date
               ELSE LEAST(end_date, ($2::date - interval '1 day')::date)
             END,
             days=CASE
               WHEN $2::date <= start_date THEN 1
               ELSE (LEAST(end_date, ($2::date - interval '1 day')::date) - start_date + 1)
             END,
             decided_at=now()
         WHERE id=$1 RETURNING *`,
        [leaveId, effectiveReturnDate]
      );
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// هل الطالب في إجازة مفعّلة (موافق عليها) في هذا التاريخ؟
const isStudentOnLeave = (studentId, onDate) =>
  pool
    .query(
      `SELECT 1 FROM student_leaves
       WHERE student_id=$1 AND status='approved'
         AND $2::date BETWEEN start_date AND end_date LIMIT 1`,
      [studentId, onDate]
    )
    .then((r) => Boolean(r.rows[0]));

// إجازة الطالب الحالية أو القادمة (موافق عليها ولم تنتهِ)
const getActiveOrUpcomingLeave = (studentId, onDate = null) =>
  pool
    .query(
      `SELECT * FROM student_leaves
       WHERE student_id=$1 AND status='approved'
         AND end_date >= COALESCE($2::date, CURRENT_DATE)
       ORDER BY start_date LIMIT 1`,
      [studentId, onDate]
    )
    .then((r) => r.rows[0]);

const getPendingLeave = (studentId) =>
  pool
    .query(
      `SELECT * FROM student_leaves WHERE student_id=$1 AND status='pending'
       ORDER BY requested_at DESC LIMIT 1`,
      [studentId]
    )
    .then((r) => r.rows[0]);

// طلبة كانوا مجازين وانتهت إجازتهم، ولم يُنبَّهوا بعد بضرورة متابعة الدروس الفائتة.
// يُستدعى عند تفعيل أول درس بعد انقضاء الإجازة.
const getStudentsReturningFromLeave = (stageId, onDate = null) =>
  pool
    .query(
      `SELECT DISTINCT st.id, st.telegram_id, st.full_name, sl.id AS leave_id
       FROM student_leaves sl
       JOIN students st ON st.id=sl.student_id
       WHERE st.stage_id=$1 AND st.is_active=true
         AND sl.status IN ('approved','ended') AND sl.backlog_notified=false
         AND sl.end_date < COALESCE($2::date, CURRENT_DATE)`,
      [stageId, onDate]
    )
    .then((r) => r.rows);

const markLeaveBacklogNotified = (leaveId) =>
  pool.query('UPDATE student_leaves SET backlog_notified=true WHERE id=$1', [leaveId]);

// كل الدروس غير المؤشَّرة في تسجيل الطالب النشط — لملخص العودة من الإجازة فقط.
// هذا الاستعلام لا يتيح التأشير بعد المهلة؛ معالج الحضور يبقى هو الضابط لذلك.
const getUnmarkedLessonsForStudent = (studentId) =>
  pool
    .query(
      `SELECT l.id AS lesson_id, s.name AS subject_name, l.active_until, l.source_url,
              (SELECT COUNT(*) FROM lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number
       FROM lessons l
       JOIN subjects s ON s.id=l.subject_id
       JOIN enrollments e
         ON e.stage_season_id=l.stage_season_id AND e.student_id=$1 AND e.status='active'
       WHERE NOT EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=$1)
       ORDER BY l.activated_at DESC`,
      [studentId]
    )
    .then((r) => r.rows);

const listPendingLeaves = () =>
  pool
    .query(
      `SELECT sl.*, st.full_name, sg.name AS stage_name
       FROM student_leaves sl
       JOIN students st ON st.id=sl.student_id
       JOIN stages sg ON sg.id=st.stage_id
       WHERE sl.status='pending' ORDER BY sl.requested_at`
    )
    .then((r) => r.rows);

// الدروس التي تحتاج تذكيرًا: تنتهي خلال ساعتين ولم يُرسَل لها تذكير بعد
const getLessonsNeedingReminder = () =>
  pool
    .query(
      `SELECT l.*, s.stage_id, s.name AS subject_name,
              (SELECT COUNT(*) FROM lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       WHERE l.reminder_sent = false
         AND l.active_until > now()
         AND l.active_until <= now() + interval '2 hours'`
    )
    .then((r) => r.rows);

const markReminderSent = (lessonId) =>
  pool.query('UPDATE lessons SET reminder_sent=true WHERE id=$1', [lessonId]);

const getNonAttendedStudentsForLesson = (lessonId, stageId) =>
  pool
    .query(
      `SELECT st.* FROM students st
       JOIN enrollments e ON e.student_id=st.id AND e.status='active'
       JOIN lessons l ON l.stage_season_id=e.stage_season_id AND l.id=$2
       WHERE st.stage_id = $1 AND st.is_active=true
          AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=$2 AND a.student_id=st.id)`,
      [stageId, lessonId]
    )
    .then((r) => r.rows);

// ---------- تنبيهات الغياب المتتالي ----------
// يُغلق يوم الدراسة بعد انتهاء مهلة آخر درس فيه، ثم تُحفظ لقطة لا تتغير لاحقًا.
// اليوم غياب كامل فقط عندما يكون عدد الدروس المؤشرة ضمن مهلتها صفرًا.
const processCompletedAttendanceDays = (timeZone = 'Asia/Baghdad') =>
  pool
    .query(
      `WITH completed_days AS (
         SELECT e.student_id,
                l.stage_season_id,
                lesson_day.attendance_date,
                COUNT(l.id)::integer AS lesson_count,
                COUNT(a.id) FILTER (WHERE a.listened_at <= l.active_until)::integer
                  AS attended_on_time_count,
                EXISTS (
                  SELECT 1 FROM student_leaves sl
                  WHERE sl.student_id=e.student_id AND sl.status IN ('approved','ended')
                    AND lesson_day.attendance_date BETWEEN sl.start_date AND sl.end_date
                ) AS is_excused_leave
         FROM students st
         JOIN enrollments e ON e.student_id=st.id AND e.status='active'
         JOIN lessons l ON l.stage_season_id=e.stage_season_id
         JOIN absence_monitoring_config cfg ON cfg.id=1
         CROSS JOIN LATERAL (
           SELECT ((l.activated_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date AS attendance_date
         ) lesson_day
         LEFT JOIN attendance a ON a.student_id=st.id AND a.lesson_id=l.id
         WHERE st.is_active=true
           AND lesson_day.attendance_date >=
             (((cfg.started_at AT TIME ZONE 'UTC') AT TIME ZONE $1)::date)
         GROUP BY e.student_id, l.stage_season_id, lesson_day.attendance_date
         -- اليوم هو تاريخ تفعيل الدروس، ولا نعتمده قبل انتهاء مهلة كل دروسه.
         HAVING MAX(l.active_until) <= now()
       )
       INSERT INTO student_attendance_days(
         student_id, stage_season_id, attendance_date, lesson_count,
         attended_on_time_count, missed_lesson_count, is_excused_leave, is_full_absence
       )
       SELECT student_id, stage_season_id, attendance_date, lesson_count,
              attended_on_time_count,
              lesson_count - attended_on_time_count,
              is_excused_leave,
              NOT is_excused_leave AND attended_on_time_count = 0
       FROM completed_days
       ON CONFLICT (student_id, stage_season_id, attendance_date) DO NOTHING
       RETURNING *`,
      [timeZone]
    )
    .then((r) => r.rows);

const ABSENCE_STREAKS_CTE = `
  WITH ordered_days AS (
    SELECT d.*,
           LAG(d.is_full_absence) OVER (
             PARTITION BY d.student_id, d.stage_season_id ORDER BY d.attendance_date
           ) AS previous_full_absence
    FROM student_attendance_days d
  ), grouped_days AS (
    SELECT o.*,
           SUM(
             CASE
               WHEN o.is_full_absence AND COALESCE(o.previous_full_absence, false) THEN 0
               ELSE 1
             END
           ) OVER (
             PARTITION BY o.student_id, o.stage_season_id
             ORDER BY o.attendance_date ROWS UNBOUNDED PRECEDING
           ) AS streak_group
    FROM ordered_days o
  ), streaked_days AS (
    SELECT g.*,
           CASE WHEN g.is_full_absence THEN
             COUNT(*) FILTER (WHERE g.is_full_absence) OVER (
               PARTITION BY g.student_id, g.stage_season_id, g.streak_group
               ORDER BY g.attendance_date ROWS UNBOUNDED PRECEDING
             )
           ELSE 0 END::integer AS streak_length,
           MIN(g.attendance_date) FILTER (WHERE g.is_full_absence) OVER (
             PARTITION BY g.student_id, g.stage_season_id, g.streak_group
           ) AS streak_start_date
    FROM grouped_days g
  )`;

async function getAbsenceAlertCandidates(threshold, alertKind) {
  const sentColumn =
    alertKind === 'student'
      ? 'student_alert_sent_at'
      : alertKind === 'admin'
        ? 'admin_alert_sent_at'
        : null;
  if (!sentColumn || !Number.isInteger(threshold) || threshold < 1) {
    throw new Error('نوع تنبيه الغياب أو حدّه غير صالح.');
  }
  return pool
    .query(
      `${ABSENCE_STREAKS_CTE}
       SELECT d.id AS attendance_day_id,
              d.student_id, st.telegram_id, st.full_name,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              d.stage_season_id, d.streak_length,
              d.streak_start_date, d.attendance_date AS streak_end_date
       FROM streaked_days d
       JOIN students st ON st.id=d.student_id AND st.is_active=true
       JOIN enrollments e
         ON e.student_id=d.student_id AND e.stage_season_id=d.stage_season_id AND e.status='active'
       JOIN stage_seasons ss ON ss.id=d.stage_season_id
       JOIN stages sg ON sg.id=ss.stage_id
       WHERE d.is_full_absence=true
         AND d.streak_length=$1
         AND d.${sentColumn} IS NULL
       ORDER BY stage_name, st.full_name`,
      [threshold]
    )
    .then((r) => r.rows);
}

const getStudentAbsenceAlertCandidates = () => getAbsenceAlertCandidates(3, 'student');
const getAdminAbsenceAlertCandidates = () => getAbsenceAlertCandidates(10, 'admin');

const markStudentAbsenceAlertSent = (attendanceDayId) =>
  pool.query(
    `UPDATE student_attendance_days SET student_alert_sent_at=now()
     WHERE id=$1 AND student_alert_sent_at IS NULL`,
    [attendanceDayId]
  );

const markAdminAbsenceAlertsSent = (attendanceDayIds) => {
  const ids = attendanceDayIds.map(Number).filter(Number.isSafeInteger);
  if (ids.length === 0) return Promise.resolve();
  return pool.query(
    `UPDATE student_attendance_days SET admin_alert_sent_at=now()
     WHERE id = ANY($1::bigint[]) AND admin_alert_sent_at IS NULL`,
    [ids]
  );
};

// ---------- واجهة الطالب وسجل الموسم الحالي ----------
const recordStudentUiMessage = (studentId, messageId, messageKind = 'screen') =>
  pool.query(
    `INSERT INTO student_ui_messages(student_id, message_id, message_kind) VALUES($1,$2,$3)
     ON CONFLICT (student_id, message_id)
     DO UPDATE SET message_kind=EXCLUDED.message_kind`,
    [studentId, messageId, messageKind === 'menu' ? 'menu' : 'screen']
  );

// رسائل القائمة السفلية تُحفظ عند فتح الشاشات الداخلية، وتُستبدل فقط عند إرسال قائمة جديدة.
const takeStudentUiMessages = (studentId, includeMenu = false) =>
  pool
    .query(
      `DELETE FROM student_ui_messages
       WHERE student_id=$1 AND ($2::boolean OR message_kind <> 'menu')
       RETURNING message_id`,
      [studentId, Boolean(includeMenu)]
    )
    .then((r) => r.rows.map((row) => Number(row.message_id)).filter(Number.isSafeInteger));

async function getStudentCurrentSeasonActivity(studentId, onDate = null) {
  const currentResult = await pool.query(
    `SELECT e.stage_season_id, e.started_at, e.ended_at,
            COALESCE(ss.stage_name_snapshot, st.name) AS stage_name,
            se.name AS season_name
     FROM enrollments e
     JOIN stage_seasons ss ON ss.id=e.stage_season_id
     JOIN stages st ON st.id=ss.stage_id
     JOIN seasons se ON se.id=ss.season_id
     WHERE e.student_id=$1 AND e.status='active'
     ORDER BY e.started_at DESC LIMIT 1`,
    [studentId]
  );
  const current = currentResult.rows[0];
  if (!current) return null;

  const [leaveResult, warningResult] = await Promise.all([
    pool.query(
      `SELECT sl.id, sl.start_date, sl.end_date, sl.days
       FROM student_leaves sl
       WHERE sl.student_id=$1 AND sl.status IN ('approved','ended')
         AND (
           sl.stage_season_id=$2
           OR (
             sl.stage_season_id IS NULL
             AND sl.end_date >= $3::date
             AND sl.start_date <= COALESCE($4::date, $5::date, CURRENT_DATE)
           )
         )
       ORDER BY sl.start_date DESC, sl.id DESC`,
      [studentId, current.stage_season_id, current.started_at, current.ended_at, onDate]
    ),
    pool.query(
      `SELECT d.id, d.attendance_date, d.student_alert_sent_at
       FROM student_attendance_days d
       WHERE d.student_id=$1 AND d.stage_season_id=$2
         AND d.student_alert_sent_at IS NOT NULL
       ORDER BY d.attendance_date DESC, d.id DESC`,
      [studentId, current.stage_season_id]
    ),
  ]);

  return {
    stageSeasonId: Number(current.stage_season_id),
    stageName: current.stage_name,
    seasonName: current.season_name,
    leaves: leaveResult.rows,
    approvedLeaveDays: leaveResult.rows.reduce((sum, leave) => sum + Number(leave.days), 0),
    maxLeaveDays: MAX_LEAVE_DAYS_PER_SEASON,
    warnings: warningResult.rows,
  };
}

// ---------- التقارير التاريخية ----------
const getStageSeasonReport = (stageSeasonId, timeZone = 'Asia/Baghdad') =>
  pool
    .query(
      `WITH ranked AS (${RANKED_STAGE_SEASONS_CTE})
       SELECT st.id AS student_id, st.full_name,
              r.id AS stage_season_id, r.stage_id,
              COALESCE(r.stage_name_snapshot, r.current_stage_name) AS stage_name,
              r.season_name, r.season_number, r.recency_rank, r.is_active, r.started_at, r.ended_at,
              sub.id AS subject_id, sub.name AS subject_name,
              COUNT(l.id) AS total_lessons,
              COUNT(a.id) FILTER (WHERE a.listened_at <= l.active_until) AS attended_lessons,
              COALESCE(
                STRING_AGG(
                  TO_CHAR(timezone($2, a.listened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI'),
                  ' | ' ORDER BY a.listened_at
                ) FILTER (WHERE a.listened_at <= l.active_until),
                ''
              ) AS attendance_dates,
              COALESCE((
                SELECT SUM(sl.days) FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND sl.status IN ('approved','ended')
              ), 0)::integer AS approved_leave_days,
              COALESCE((
                SELECT STRING_AGG(
                  TO_CHAR(sl.start_date, 'YYYY-MM-DD') || ' → ' || TO_CHAR(sl.end_date, 'YYYY-MM-DD') ||
                  ' (' || sl.days || ' يوم)',
                  ' | ' ORDER BY sl.start_date, sl.id
                )
                FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND sl.status IN ('approved','ended')
              ), '') AS approved_leave_periods
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       JOIN ranked r ON r.id=e.stage_season_id
       JOIN subjects sub ON sub.stage_id=r.stage_id
       LEFT JOIN lessons l ON l.subject_id=sub.id AND l.stage_season_id=r.id
       LEFT JOIN attendance a ON a.lesson_id = l.id AND a.student_id = st.id
       WHERE r.id=$1
       GROUP BY st.id, st.full_name, r.id, r.stage_id, r.stage_name_snapshot, r.current_stage_name,
                r.season_name, r.season_number, r.recency_rank, r.is_active, r.started_at, r.ended_at,
                sub.id, sub.name
       ORDER BY st.full_name, sub.name`,
      [stageSeasonId, timeZone]
    )
    .then((r) => r.rows);

// تقرير الطالب عبر كل مواسمه، أو موسم واحد فقط عند تمرير stageSeasonId (لاختيار الطالب من «تقريري»).
const getStudentSeasonReport = (studentId, stageSeasonId = null, timeZone = 'Asia/Baghdad') => {
  const timeZoneParam = stageSeasonId ? '$3' : '$2';
  return pool
    .query(
      `WITH ranked AS (${RANKED_STAGE_SEASONS_CTE})
       SELECT st.id AS student_id, st.full_name,
              r.id AS stage_season_id, r.stage_id,
              COALESCE(r.stage_name_snapshot, r.current_stage_name) AS stage_name,
              r.season_name, r.season_number, r.recency_rank, r.is_active, r.started_at, r.ended_at,
              e.status AS enrollment_status,
              sub.id AS subject_id, sub.name AS subject_name,
              COUNT(l.id) AS total_lessons,
              COUNT(a.id) FILTER (WHERE a.listened_at <= l.active_until) AS attended_lessons,
              COALESCE(
                STRING_AGG(
                  TO_CHAR(timezone(${timeZoneParam}, a.listened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI'),
                  ' | ' ORDER BY a.listened_at
                ) FILTER (WHERE a.listened_at <= l.active_until),
                ''
              ) AS attendance_dates,
              COALESCE((
                SELECT SUM(sl.days) FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND sl.status IN ('approved','ended')
              ), 0)::integer AS approved_leave_days,
              COALESCE((
                SELECT STRING_AGG(
                  TO_CHAR(sl.start_date, 'YYYY-MM-DD') || ' → ' || TO_CHAR(sl.end_date, 'YYYY-MM-DD') ||
                  ' (' || sl.days || ' يوم)',
                  ' | ' ORDER BY sl.start_date, sl.id
                )
                FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND sl.status IN ('approved','ended')
              ), '') AS approved_leave_periods
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       JOIN ranked r ON r.id=e.stage_season_id
       JOIN subjects sub ON sub.stage_id=r.stage_id
       LEFT JOIN lessons l ON l.subject_id=sub.id AND l.stage_season_id=r.id
       LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=st.id
       WHERE st.id=$1 ${stageSeasonId ? 'AND r.id=$2' : ''}
       GROUP BY st.id, st.full_name, r.id, r.stage_id, r.stage_name_snapshot, r.current_stage_name,
                r.season_name, r.season_number, r.recency_rank, r.is_active, r.started_at, r.ended_at,
                e.status, sub.id, sub.name
       ORDER BY r.started_at DESC, r.id DESC, sub.name`,
      stageSeasonId ? [studentId, stageSeasonId, timeZone] : [studentId, timeZone]
    )
    .then((r) => r.rows);
};

module.exports = {
  pool,
  initSchema,
  addStage,
  listStages,
  listAllStages,
  getStageById,
  updateStageName,
  archiveStage,
  restoreStage,
  hardDeleteStage,
  setStageNext,
  addSubject,
  listSubjectsByStage,
  findSubjectByHashtag,
  getSubjectById,
  updateSubjectHashtag,
  hardDeleteSubject,
  getStudentByTelegramId,
  createStudent,
  markWelcomed,
  confirmOfficialStudent,
  searchStudents,
  getStudentById,
  updateStudentName,
  updateStudentStage,
  archiveStudent,
  hardDeleteStudent,
  getStudentsByStage,
  listStageSeasons,
  listStudentSeasons,
  startSeasonForStages,
  getPendingTransition,
  resolveStudentTransition,
  linkChannel,
  getChannelByChatId,
  listChannelsWithStage,
  unlinkChannel,
  activateLesson,
  getLessonBySource,
  getActiveLessonsForStudent,
  claimDailyLessonNotification,
  releaseDailyLessonNotification,
  getLessonById,
  markAttendance,
  canStudentAttendLesson,
  getLessonsNeedingReminder,
  markReminderSent,
  getNonAttendedStudentsForLesson,
  processCompletedAttendanceDays,
  getStudentAbsenceAlertCandidates,
  getAdminAbsenceAlertCandidates,
  markStudentAbsenceAlertSent,
  markAdminAbsenceAlertsSent,
  recordStudentUiMessage,
  takeStudentUiMessages,
  getStudentCurrentSeasonActivity,
  getCurrentSeasonLeaveUsage,
  requestLeave,
  getLeaveById,
  decideLeave,
  cancelLeave,
  isStudentOnLeave,
  getActiveOrUpcomingLeave,
  getPendingLeave,
  getStudentsReturningFromLeave,
  markLeaveBacklogNotified,
  getUnmarkedLessonsForStudent,
  listPendingLeaves,
  getStageSeasonReport,
  getStudentSeasonReport,
  MAX_LEAVE_DAYS_PER_SEASON,
};
