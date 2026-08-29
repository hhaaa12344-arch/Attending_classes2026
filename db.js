// db.js — الاتصال بقاعدة بيانات PostgreSQL وإدارة الجداول والاستعلامات
const { Pool } = require('pg');
const { normalizeHashtag } = require('./utils');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
      name TEXT NOT NULL UNIQUE,
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_seasons_one_active
      ON stage_seasons(stage_id) WHERE is_active=true;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_one_active
      ON enrollments(student_id) WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transitions_one_pending
      ON student_transitions(student_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_enrollments_stage_season ON enrollments(stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_transitions_student ON student_transitions(student_id);
  `);

  // تحويل البيانات القديمة إلى موسم تأسيسي واحد من دون فقد أي درس أو حضور.
  await pool.query(`
    UPDATE stages SET sort_order=id WHERE sort_order IS NULL;

    ALTER TABLE stage_seasons ADD COLUMN IF NOT EXISTS stage_name_snapshot TEXT;

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
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_stage_hashtag
      ON subjects(stage_id, hashtag) WHERE hashtag IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_source_message
      ON lessons(source_chat_id, source_message_id)
      WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_lessons_stage_season ON lessons(stage_season_id);
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

// ---------- الطلبة ----------
const getStudentByTelegramId = (telegramId) =>
  pool
    .query('SELECT * FROM students WHERE telegram_id=$1', [telegramId])
    .then((r) => r.rows[0]);

async function createStudent(telegramId, fullName, stageId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stageSeason = await client.query(
      'SELECT id FROM stage_seasons WHERE stage_id=$1 AND is_active=true FOR UPDATE',
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

async function deleteStudent(id) {
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
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const getStudentsByStage = (stageId) =>
  pool
    .query('SELECT * FROM students WHERE stage_id=$1 AND is_active=true', [stageId])
    .then((r) => r.rows);

// ---------- المواسم وانتقال الطلبة ----------
const listSeasons = () =>
  pool
    .query(
      `SELECT se.*,
              COUNT(ss.id) AS stage_count,
              COUNT(ss.id) FILTER (WHERE ss.is_active) AS active_stage_count
       FROM seasons se LEFT JOIN stage_seasons ss ON ss.season_id=se.id
       GROUP BY se.id ORDER BY se.created_at DESC, se.id DESC`
    )
    .then((r) => r.rows);

const listStageSeasons = (stageId) =>
  pool
    .query(
      `SELECT ss.*, se.name AS season_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.stage_season_id=ss.id) AS student_count,
              (SELECT COUNT(*) FROM lessons l WHERE l.stage_season_id=ss.id) AS lesson_count
       FROM stage_seasons ss JOIN seasons se ON se.id=ss.season_id
       WHERE ss.stage_id=$1 ORDER BY ss.started_at DESC, ss.id DESC`,
      [stageId]
    )
    .then((r) => r.rows);

const getSeasonDetails = (seasonId) =>
  pool
    .query(
      `SELECT se.id AS season_id, se.name AS season_name, se.created_at,
              ss.id AS stage_season_id, ss.is_active, ss.started_at, ss.ended_at,
              st.id AS stage_id, COALESCE(ss.stage_name_snapshot, st.name) AS stage_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.stage_season_id=ss.id) AS student_count,
              (SELECT COUNT(*) FROM lessons l WHERE l.stage_season_id=ss.id) AS lesson_count
       FROM seasons se
       LEFT JOIN stage_seasons ss ON ss.season_id=se.id
       LEFT JOIN stages st ON st.id=ss.stage_id
       WHERE se.id=$1 ORDER BY st.sort_order, st.id`,
      [seasonId]
    )
    .then((r) => r.rows);

async function startSeasonForStages(name, stageIds) {
  const ids = [...new Set(stageIds.map(Number).filter(Number.isInteger))];
  if (ids.length === 0) throw new Error('يجب اختيار مرحلة واحدة على الأقل.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seasonResult = await client.query(
      `INSERT INTO seasons(name) VALUES($1)
       ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
      [name]
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

      const duplicate = await client.query(
        'SELECT 1 FROM stage_seasons WHERE stage_id=$1 AND season_id=$2',
        [stageId, season.id]
      );
      if (duplicate.rows[0]) {
        const err = new Error(`بدأ هذا الموسم مسبقًا للمرحلة «${stage.rows[0].name}».`);
        err.code = 'SEASON_ALREADY_STARTED';
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
      `SELECT tr.*, source_stage.id AS source_stage_id, source_stage.name AS source_stage_name,
              repeat_season.name AS repeat_season_name,
              next_stage.id AS next_stage_id, next_stage.name AS next_stage_name
       FROM student_transitions tr
       JOIN enrollments old_e ON old_e.id=tr.from_enrollment_id
       JOIN stage_seasons old_ss ON old_ss.id=old_e.stage_season_id
       JOIN stages source_stage ON source_stage.id=old_ss.stage_id
       JOIN stage_seasons repeat_ss ON repeat_ss.id=tr.repeat_stage_season_id
       JOIN seasons repeat_season ON repeat_season.id=repeat_ss.season_id
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

// للتحقق من عدم تفعيل نفس المادة مرتين خلال فترة قصيرة (منشورات متعددة لنفس الدرس)
const getRecentLessonForSubject = (subjectId, minutes = 15) =>
  pool
    .query(
      `SELECT l.* FROM lessons l
       JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true
       WHERE l.subject_id=$1 AND l.activated_at > now() - ($2 || ' minutes')::interval
       ORDER BY l.activated_at DESC LIMIT 1`,
      [subjectId, minutes]
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
              EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=$2) AS attended
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       JOIN enrollments e
         ON e.stage_season_id=l.stage_season_id AND e.student_id=$2 AND e.status='active'
       WHERE s.stage_id = $1 AND l.active_until > now()
       ORDER BY l.activated_at DESC`,
      [stageId, studentId]
    )
    .then((r) => r.rows);

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
      `INSERT INTO attendance(student_id, lesson_id) VALUES($1,$2)
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

// ---------- التقارير التاريخية ----------
const getStageSeasonReport = (stageSeasonId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name,
              ss.id AS stage_season_id, sg.id AS stage_id,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              se.id AS season_id, se.name AS season_name,
              sub.id AS subject_id, sub.name AS subject_name,
              COUNT(l.id) AS total_lessons,
              COUNT(a.id) AS attended_lessons
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       JOIN stage_seasons ss ON ss.id=e.stage_season_id
       JOIN stages sg ON sg.id=ss.stage_id
       JOIN seasons se ON se.id=ss.season_id
       JOIN subjects sub ON sub.stage_id=ss.stage_id
       LEFT JOIN lessons l ON l.subject_id=sub.id AND l.stage_season_id=ss.id
       LEFT JOIN attendance a ON a.lesson_id = l.id AND a.student_id = st.id
       WHERE ss.id=$1
       GROUP BY st.id, st.full_name, ss.id, sg.id, sg.name, ss.stage_name_snapshot,
                se.id, se.name, sub.id, sub.name
       ORDER BY st.full_name, sub.name`,
      [stageSeasonId]
    )
    .then((r) => r.rows);

const getStudentSeasonReport = (studentId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name,
              ss.id AS stage_season_id, sg.id AS stage_id,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              se.id AS season_id, se.name AS season_name, ss.started_at, ss.ended_at,
              e.status AS enrollment_status,
              sub.id AS subject_id, sub.name AS subject_name,
              COUNT(l.id) AS total_lessons,
              COUNT(a.id) AS attended_lessons
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       JOIN stage_seasons ss ON ss.id=e.stage_season_id
       JOIN stages sg ON sg.id=ss.stage_id
       JOIN seasons se ON se.id=ss.season_id
       JOIN subjects sub ON sub.stage_id=ss.stage_id
       LEFT JOIN lessons l ON l.subject_id=sub.id AND l.stage_season_id=ss.id
       LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=st.id
       WHERE st.id=$1
       GROUP BY st.id, st.full_name, ss.id, sg.id, sg.name, ss.stage_name_snapshot, se.id, se.name,
                ss.started_at, ss.ended_at, e.status, sub.id, sub.name
       ORDER BY ss.started_at DESC, ss.id DESC, sub.name`,
      [studentId]
    )
    .then((r) => r.rows);

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
  setStageNext,
  addSubject,
  listSubjectsByStage,
  findSubjectByHashtag,
  getSubjectById,
  updateSubjectHashtag,
  getStudentByTelegramId,
  createStudent,
  searchStudents,
  getStudentById,
  updateStudentName,
  updateStudentStage,
  deleteStudent,
  getStudentsByStage,
  listSeasons,
  listStageSeasons,
  getSeasonDetails,
  startSeasonForStages,
  getPendingTransition,
  resolveStudentTransition,
  linkChannel,
  getChannelByChatId,
  listChannelsWithStage,
  unlinkChannel,
  activateLesson,
  getLessonBySource,
  getRecentLessonForSubject,
  getActiveLessonsForStudent,
  getLessonById,
  markAttendance,
  canStudentAttendLesson,
  getLessonsNeedingReminder,
  markReminderSent,
  getNonAttendedStudentsForLesson,
  getStageSeasonReport,
  getStudentSeasonReport,
};
