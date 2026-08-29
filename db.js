// db.js — الاتصال بقاعدة بيانات PostgreSQL وإدارة الجداول والاستعلامات
const { Pool } = require('pg');

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
    ALTER TABLE subjects ADD COLUMN IF NOT EXISTS hashtag TEXT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_stage_hashtag
      ON subjects(stage_id, hashtag) WHERE hashtag IS NOT NULL;
  `);
}

// ---------- المراحل ----------
const addStage = (name) =>
  pool.query('INSERT INTO stages(name) VALUES($1) RETURNING *', [name]);

const listStages = () =>
  pool.query('SELECT * FROM stages ORDER BY id').then((r) => r.rows);

// ---------- المواد ----------
const addSubject = (stageId, name, hashtag) =>
  pool
    .query('INSERT INTO subjects(stage_id, name, hashtag) VALUES($1,$2,$3) RETURNING *', [
      stageId,
      name,
      hashtag || null,
    ])
    .then((r) => r.rows[0]);

const listSubjectsByStage = (stageId) =>
  pool
    .query('SELECT * FROM subjects WHERE stage_id=$1 ORDER BY id', [stageId])
    .then((r) => r.rows);

// إيجاد مادة داخل مرحلة معيّنة اعتمادًا على الهاشتاغ (أو اسمها بدون مسافات كخيار احتياطي)
const findSubjectByHashtag = async (stageId, hashtag) => {
  const clean = hashtag.trim();
  const r = await pool.query(
    `SELECT * FROM subjects
     WHERE stage_id=$1
       AND (hashtag = $2 OR REPLACE(name, ' ', '') = $2)
     LIMIT 1`,
    [stageId, clean]
  );
  return r.rows[0];
};

// ---------- الطلبة ----------
const getStudentByTelegramId = (telegramId) =>
  pool
    .query('SELECT * FROM students WHERE telegram_id=$1', [telegramId])
    .then((r) => r.rows[0]);

const createStudent = (telegramId, fullName, stageId) =>
  pool
    .query(
      'INSERT INTO students(telegram_id, full_name, stage_id) VALUES($1,$2,$3) RETURNING *',
      [telegramId, fullName, stageId]
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

const updateStudentStage = (id, stageId) =>
  pool.query('UPDATE students SET stage_id=$1 WHERE id=$2', [stageId, id]);

const deleteStudent = (id) => pool.query('DELETE FROM students WHERE id=$1', [id]);

const getStudentsByStage = (stageId) =>
  pool.query('SELECT * FROM students WHERE stage_id=$1', [stageId]).then((r) => r.rows);

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
const activateLesson = (subjectId, hours = 24, sourceType = 'manual', sourceUrl = null) =>
  pool
    .query(
      `INSERT INTO lessons(subject_id, activated_at, active_until, source_type, source_url)
       VALUES($1, now(), now() + ($2 || ' hours')::interval, $3, $4) RETURNING *`,
      [subjectId, hours, sourceType, sourceUrl]
    )
    .then((r) => r.rows[0]);

// للتحقق من عدم تفعيل نفس المادة مرتين خلال فترة قصيرة (منشورات متعددة لنفس الدرس)
const getRecentLessonForSubject = (subjectId, minutes = 15) =>
  pool
    .query(
      `SELECT * FROM lessons WHERE subject_id=$1 AND activated_at > now() - ($2 || ' minutes')::interval
       ORDER BY activated_at DESC LIMIT 1`,
      [subjectId, minutes]
    )
    .then((r) => r.rows[0]);

const getActiveLessonsForStudent = (stageId, studentId) =>
  pool
    .query(
      `SELECT l.id AS lesson_id, s.name AS subject_name, l.active_until,
              EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=$2) AS attended
       FROM lessons l
       JOIN subjects s ON s.id = l.subject_id
       WHERE s.stage_id = $1 AND l.active_until > now()
       ORDER BY l.activated_at DESC`,
      [stageId, studentId]
    )
    .then((r) => r.rows);

const getLessonById = (lessonId) =>
  pool
    .query(
      `SELECT l.*, s.stage_id, s.name AS subject_name FROM lessons l
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

// الدروس التي تحتاج تذكيرًا: تنتهي خلال ساعتين ولم يُرسَل لها تذكير بعد
const getLessonsNeedingReminder = () =>
  pool
    .query(
      `SELECT l.*, s.stage_id, s.name AS subject_name FROM lessons l
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
       WHERE st.stage_id = $1
         AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=$2 AND a.student_id=st.id)`,
      [stageId, lessonId]
    )
    .then((r) => r.rows);

// ---------- التقارير ----------
const getStageReport = (stageId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name,
              sub.id AS subject_id, sub.name AS subject_name,
              COUNT(l.id) AS total_lessons,
              COUNT(a.id) AS attended_lessons
       FROM students st
       CROSS JOIN subjects sub
       LEFT JOIN lessons l ON l.subject_id = sub.id
       LEFT JOIN attendance a ON a.lesson_id = l.id AND a.student_id = st.id
       WHERE st.stage_id = $1 AND sub.stage_id = $1
       GROUP BY st.id, st.full_name, sub.id, sub.name
       ORDER BY st.full_name, sub.name`,
      [stageId]
    )
    .then((r) => r.rows);

module.exports = {
  pool,
  initSchema,
  addStage,
  listStages,
  addSubject,
  listSubjectsByStage,
  findSubjectByHashtag,
  getStudentByTelegramId,
  createStudent,
  searchStudents,
  getStudentById,
  updateStudentName,
  updateStudentStage,
  deleteStudent,
  getStudentsByStage,
  linkChannel,
  getChannelByChatId,
  listChannelsWithStage,
  unlinkChannel,
  activateLesson,
  getRecentLessonForSubject,
  getActiveLessonsForStudent,
  getLessonById,
  markAttendance,
  getLessonsNeedingReminder,
  markReminderSent,
  getNonAttendedStudentsForLesson,
  getStageReport,
};
