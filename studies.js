// studies.js — نظام المباحثات والامتحانات: المباحثات والتقارير والامتحانات والدرجات.
// وحدة مستقلة تشارك مجمع الاتصالات نفسه مع db.js (لا استيراد دائري: هذه تستورد db، وdb لا تستوردها).
const { pool } = require('./db');

// توزيع الدرجات في الموسم (قابل للتغيير من مكان واحد)
const GRADE_WEIGHTS = {
  examsTotal: 15, // 3 امتحانات شهرية × 5
  examEach: 5,
  participationTotal: 15, // المباحثات أو التقارير
  examsPerSeason: 3,
};

async function initStudiesSchema() {
  await pool.query(`
    -- ---------- نمط مشاركة الطالب في كل مادة ----------
    -- الطالب يختار لكل مادة: مباحثات أو تقارير. ويمكنه التحويل للمباحثات لاحقًا،
    -- وعندها لا تُحسب عليه الجلسات التي سبقت تحويله (joined_mubahatha_at).
    CREATE TABLE IF NOT EXISTS participation_modes (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('mubahatha','report')),
      chosen_at TIMESTAMP NOT NULL DEFAULT now(),
      joined_mubahatha_at TIMESTAMP,
      switched_at TIMESTAMP,
      UNIQUE(student_id, subject_id, stage_season_id)
    );

    -- ---------- مجموعات المباحثات ----------
    -- لكل مادة في الموسم مجموعة أو أكثر على تليجرام، لكل واحدة سعة قصوى.
    -- عند امتلاء المجموعة يوجّه البوت الطالب تلقائيًا إلى المجموعة التالية.
    CREATE TABLE IF NOT EXISTS mubahatha_groups (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      group_number INTEGER NOT NULL,
      title TEXT,
      invite_link TEXT,
      telegram_chat_id BIGINT,
      capacity INTEGER NOT NULL DEFAULT 50,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(subject_id, stage_season_id, group_number)
    );

    -- الطالب في مجموعة واحدة فقط لكل مادة في الموسم
    CREATE TABLE IF NOT EXISTS group_memberships (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES mubahatha_groups(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(student_id, subject_id, stage_season_id)
    );

    -- ---------- جلسات المباحثة ----------
    -- كل مجموعة تُعامل بشكل مستقل، فالجلسة مرتبطة بالمجموعة لا بالمادة وحدها.
    CREATE TABLE IF NOT EXISTS mubahatha_sessions (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES mubahatha_groups(id) ON DELETE CASCADE,
      teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      title TEXT,
      held_on DATE NOT NULL DEFAULT CURRENT_DATE,
      opened_at TIMESTAMP NOT NULL DEFAULT now(),
      closes_at TIMESTAMP NOT NULL,
      is_closed BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS mubahatha_attendance (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES mubahatha_sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      marked_at TIMESTAMP NOT NULL DEFAULT now(),
      marked_by TEXT NOT NULL DEFAULT 'student',
      UNIQUE(session_id, student_id)
    );

    -- ---------- الامتحانات الشهرية ----------
    -- ثلاثة امتحانات في الموسم لكل مادة، كل امتحان 5 درجات مهما كان عدد أسئلته.
    CREATE TABLE IF NOT EXISTS exams (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      exam_number INTEGER NOT NULL CHECK (exam_number BETWEEN 1 AND 3),
      title TEXT,
      opens_at TIMESTAMP NOT NULL,
      available_hours INTEGER NOT NULL CHECK (available_hours > 0),
      closes_at TIMESTAMP NOT NULL,
      max_score NUMERIC NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      published_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(subject_id, stage_season_id, exam_number)
    );

    -- الأسئلة: صح/خطأ أو اختيار من متعدد، ويجوز الخلط بينهما في الامتحان الواحد.
    CREATE TABLE IF NOT EXISTS exam_questions (
      id SERIAL PRIMARY KEY,
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      question_type TEXT NOT NULL CHECK (question_type IN ('tf','mcq')),
      prompt TEXT NOT NULL,
      options JSONB,
      correct_answer TEXT NOT NULL,
      UNIQUE(exam_id, position)
    );

    -- محاولة الطالب: تُحفظ كل إجابة فور اختيارها ليكمل من حيث توقف لو انقطع الاتصال.
    CREATE TABLE IF NOT EXISTS exam_attempts (
      id SERIAL PRIMARY KEY,
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      started_at TIMESTAMP NOT NULL DEFAULT now(),
      submitted_at TIMESTAMP,
      score NUMERIC,
      correct_count INTEGER,
      total_questions INTEGER,
      UNIQUE(exam_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS exam_answers (
      id SERIAL PRIMARY KEY,
      attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
      answer TEXT,
      is_correct BOOLEAN,
      answered_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(attempt_id, question_id)
    );

    -- ---------- التقارير ----------
    CREATE TABLE IF NOT EXISTS student_reports (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      telegram_file_id TEXT,
      file_kind TEXT,
      note TEXT,
      submitted_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- ---------- درجات نهاية الموسم ----------
    CREATE TABLE IF NOT EXISTS final_grades (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      exams_score NUMERIC NOT NULL DEFAULT 0,
      mubahatha_score NUMERIC NOT NULL DEFAULT 0,
      report_score NUMERIC NOT NULL DEFAULT 0,
      participation_score NUMERIC NOT NULL DEFAULT 0,
      total_score NUMERIC NOT NULL DEFAULT 0,
      finalized_at TIMESTAMP,
      edited_by BIGINT,
      edited_at TIMESTAMP,
      UNIQUE(student_id, subject_id, stage_season_id)
    );

    ALTER TABLE final_grades ADD COLUMN IF NOT EXISTS edited_by BIGINT;
    ALTER TABLE final_grades ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;


    -- تأجيل الامتحان: يُسجَّل التاريخ الأصلي عند أول تأجيل للرجوع إليه.
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS original_opens_at TIMESTAMP;
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS postponed_count INTEGER NOT NULL DEFAULT 0;

    -- ---------- الجدول الأسبوعي للمباحثات ----------
    -- الأستاذ يبني جدول مجموعته: يوم من أيام الأسبوع + ساعة من الساعات المتاحة.
    CREATE TABLE IF NOT EXISTS schedule_slots (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES mubahatha_groups(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
      minute INTEGER NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
      duration_hours INTEGER NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(group_id, day_of_week, hour, minute)
    );

    -- قرار الأستاذ اليومي: يُسأل قبل الموعد بخمس دقائق «هل توجد محاضرة اليوم؟».
    -- «تأجيل» يعني لا شيء يحدث اليوم، و«نعم» يفتح الجلسة في وقتها ويُنبَّه الطلبة.
    CREATE TABLE IF NOT EXISTS slot_decisions (
      id SERIAL PRIMARY KEY,
      slot_id INTEGER NOT NULL REFERENCES schedule_slots(id) ON DELETE CASCADE,
      scheduled_date DATE NOT NULL,
      decision TEXT CHECK (decision IN ('confirmed','postponed')),
      prompted_at TIMESTAMP NOT NULL DEFAULT now(),
      decided_at TIMESTAMP,
      decided_by BIGINT,
      session_id INTEGER REFERENCES mubahatha_sessions(id) ON DELETE SET NULL,
      UNIQUE(slot_id, scheduled_date)
    );

    CREATE INDEX IF NOT EXISTS idx_slots_group ON schedule_slots(group_id);
    CREATE INDEX IF NOT EXISTS idx_slots_season ON schedule_slots(stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_slot_dec_slot ON slot_decisions(slot_id, scheduled_date);

    -- المباحثة ساعة واحدة لا تتجاوزها؛ تُصحَّح أي مواعيد قديمة أُنشئت بساعتين.
    ALTER TABLE schedule_slots ALTER COLUMN duration_hours SET DEFAULT 1;
    UPDATE schedule_slots SET duration_hours = 1 WHERE duration_hours > 1;

    CREATE INDEX IF NOT EXISTS idx_part_modes_subject ON participation_modes(subject_id, stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_groups_subject ON mubahatha_groups(subject_id, stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_group ON group_memberships(group_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON mubahatha_sessions(group_id);
    CREATE INDEX IF NOT EXISTS idx_mub_att_session ON mubahatha_attendance(session_id);
    CREATE INDEX IF NOT EXISTS idx_exams_subject ON exams(subject_id, stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_exam_q_exam ON exam_questions(exam_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_student ON exam_attempts(student_id);
    CREATE INDEX IF NOT EXISTS idx_reports_subject ON student_reports(subject_id, stage_season_id);
  `);
}

// ---------------------------------------------------------------------------
// أنماط المشاركة
// ---------------------------------------------------------------------------
const setParticipationMode = (studentId, subjectId, stageSeasonId, mode) =>
  pool
    .query(
      `INSERT INTO participation_modes(student_id, subject_id, stage_season_id, mode, joined_mubahatha_at)
       VALUES($1,$2,$3,$4, CASE WHEN $4='mubahatha' THEN now() ELSE NULL END)
       ON CONFLICT (student_id, subject_id, stage_season_id) DO NOTHING RETURNING *`,
      [studentId, subjectId, stageSeasonId, mode]
    )
    .then((r) => r.rows[0]);

const getParticipationMode = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      'SELECT * FROM participation_modes WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3',
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

// التحويل من التقارير إلى المباحثات: الجلسات السابقة لا تُحسب عليه إطلاقًا،
// وتقاريره المُسلَّمة تبقى وتُضاف درجتها لاحقًا عند احتساب الدرجة.
const switchToMubahatha = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      `UPDATE participation_modes
       SET mode='mubahatha', switched_at=now(), joined_mubahatha_at=now()
       WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 AND mode='report'
       RETURNING *`,
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

const countParticipationBySubject = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT mode, COUNT(*) AS count FROM participation_modes
       WHERE subject_id=$1 AND stage_season_id=$2 GROUP BY mode`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

// ---------------------------------------------------------------------------
// مجموعات المباحثات + التوزيع التلقائي عند الامتلاء
// ---------------------------------------------------------------------------
async function createMubahathaGroup(subjectId, stageSeasonId, { title, inviteLink, chatId, capacity = 50 }) {
  const next = await pool.query(
    'SELECT COALESCE(MAX(group_number),0)+1 AS n FROM mubahatha_groups WHERE subject_id=$1 AND stage_season_id=$2',
    [subjectId, stageSeasonId]
  );
  const number = Number(next.rows[0].n);
  return pool
    .query(
      `INSERT INTO mubahatha_groups(subject_id, stage_season_id, group_number, title, invite_link, telegram_chat_id, capacity)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [subjectId, stageSeasonId, number, title || `المجموعة ${number}`, inviteLink, chatId, capacity]
    )
    .then((r) => r.rows[0]);
}

const getGroupById = (groupId) =>
  pool.query('SELECT * FROM mubahatha_groups WHERE id=$1', [groupId]).then((r) => r.rows[0]);

const listGroups = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT g.*, (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) AS member_count
       FROM mubahatha_groups g
       WHERE g.subject_id=$1 AND g.stage_season_id=$2
       ORDER BY g.group_number`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

const setGroupCapacity = (groupId, capacity) =>
  pool
    .query('UPDATE mubahatha_groups SET capacity=$2 WHERE id=$1 RETURNING *', [groupId, capacity])
    .then((r) => r.rows[0]);

const setGroupChatId = (groupId, chatId) =>
  pool
    .query('UPDATE mubahatha_groups SET telegram_chat_id=$2 WHERE id=$1 RETURNING *', [groupId, chatId])
    .then((r) => r.rows[0]);

// مجموعات موسم سابق لنفس المادة — تُعرض للأستاذ عند بدء موسم جديد ليعرف ما يحتاج إنشاءه.
const listPreviousSeasonGroups = (subjectId, currentStageSeasonId) =>
  pool
    .query(
      `SELECT g.*, se.name AS season_name
       FROM mubahatha_groups g
       JOIN stage_seasons ss ON ss.id=g.stage_season_id
       JOIN seasons se ON se.id=ss.season_id
       WHERE g.subject_id=$1 AND g.stage_season_id <> $2
       ORDER BY ss.started_at DESC, g.group_number`,
      [subjectId, currentStageSeasonId]
    )
    .then((r) => r.rows);

// الطلبة الذين اختاروا المباحثات في المادة ولم يُوزَّعوا على مجموعة بعد
// (يظهرون بعد بدء موسم جديد لأن مجموعات الموسم السابق لا تنتقل معهم).
const listUnassignedMubahathaStudents = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT st.id, st.telegram_id, st.full_name
       FROM participation_modes pm
       JOIN students st ON st.id=pm.student_id AND st.is_active=true
       WHERE pm.subject_id=$1 AND pm.stage_season_id=$2 AND pm.mode='mubahatha'
         AND NOT EXISTS (
           SELECT 1 FROM group_memberships m
           WHERE m.student_id=pm.student_id AND m.subject_id=$1 AND m.stage_season_id=$2
         )`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

const setGroupInviteLink = (groupId, inviteLink) =>
  pool
    .query('UPDATE mubahatha_groups SET invite_link=$2 WHERE id=$1 RETURNING *', [groupId, inviteLink])
    .then((r) => r.rows[0]);

const getStudentGroup = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT g.*, m.assigned_at FROM group_memberships m
       JOIN mubahatha_groups g ON g.id=m.group_id
       WHERE m.student_id=$1 AND m.subject_id=$2 AND m.stage_season_id=$3`,
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

// يوجّه الطالب لأول مجموعة فيها متسع؛ ولو امتلأت كلها يُرجع null ليُنبَّه الأدمن بإنشاء مجموعة جديدة.
// يُنفَّذ داخل معاملة مع قفل الصف حتى لا يتجاوز التوزيع المتزامن السعة.
async function assignStudentToGroup(studentId, subjectId, stageSeasonId) {
  const existing = await getStudentGroup(studentId, subjectId, stageSeasonId);
  if (existing) return { group: existing, created: false };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query(
      `SELECT g.id, g.capacity,
              (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) AS member_count
       FROM mubahatha_groups g
       WHERE g.subject_id=$1 AND g.stage_season_id=$2 AND g.is_active=true
       ORDER BY g.group_number
       FOR UPDATE`,
      [subjectId, stageSeasonId]
    );
    const target = candidate.rows.find((g) => Number(g.member_count) < Number(g.capacity));
    if (!target) {
      await client.query('ROLLBACK');
      return { group: null, created: false, full: true };
    }
    await client.query(
      `INSERT INTO group_memberships(group_id, student_id, subject_id, stage_season_id)
       VALUES($1,$2,$3,$4)`,
      [target.id, studentId, subjectId, stageSeasonId]
    );
    await client.query('COMMIT');
    const group = await pool
      .query('SELECT * FROM mubahatha_groups WHERE id=$1', [target.id])
      .then((r) => r.rows[0]);
    return { group, created: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// جلسات المباحثة
// ---------------------------------------------------------------------------
const openSession = (groupId, teacherId, title, hours = 24) =>
  pool
    .query(
      `INSERT INTO mubahatha_sessions(group_id, teacher_id, title, closes_at)
       VALUES($1,$2,$3, now() + make_interval(hours => $4::int)) RETURNING *`,
      [groupId, teacherId, title, hours]
    )
    .then((r) => r.rows[0]);

const closeSession = (sessionId) =>
  pool
    .query('UPDATE mubahatha_sessions SET is_closed=true WHERE id=$1 RETURNING *', [sessionId])
    .then((r) => r.rows[0]);

const listGroupSessions = (groupId) =>
  pool
    .query(
      `SELECT s.*, (SELECT COUNT(*) FROM mubahatha_attendance a WHERE a.session_id=s.id) AS attended_count
       FROM mubahatha_sessions s WHERE s.group_id=$1 ORDER BY s.opened_at DESC`,
      [groupId]
    )
    .then((r) => r.rows);

const getOpenSessionForGroup = (groupId) =>
  pool
    .query(
      `SELECT * FROM mubahatha_sessions
       WHERE group_id=$1 AND is_closed=false AND closes_at > now()
       ORDER BY opened_at DESC LIMIT 1`,
      [groupId]
    )
    .then((r) => r.rows[0]);

const markSessionAttendance = (sessionId, studentId, markedBy = 'student') =>
  pool
    .query(
      `INSERT INTO mubahatha_attendance(session_id, student_id, marked_by)
       VALUES($1,$2,$3) ON CONFLICT (session_id, student_id) DO NOTHING RETURNING *`,
      [sessionId, studentId, markedBy]
    )
    .then((r) => r.rows[0]);

// ---------------------------------------------------------------------------
// الامتحانات
// ---------------------------------------------------------------------------
// أيام الأسبوع القادم لعرضها على الأستاذ (اليوم + 7 أيام)، والبوت يحوّل الاختيار إلى تاريخ.
const WEEKDAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function upcomingWeekDays(from = new Date()) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    days.push({
      iso: d.toISOString().slice(0, 10),
      label: `${WEEKDAY_NAMES[d.getDay()]} ${d.toISOString().slice(0, 10)}`,
    });
  }
  return days;
}

async function createExam(subjectId, stageSeasonId, teacherId, { examNumber, title, dateIso, hours }) {
  const n = Number(examNumber);
  if (!Number.isInteger(n) || n < 1 || n > GRADE_WEIGHTS.examsPerSeason) {
    const err = new Error(`رقم الامتحان يجب أن يكون بين 1 و${GRADE_WEIGHTS.examsPerSeason}.`);
    err.code = 'BAD_EXAM_NUMBER';
    throw err;
  }
  const h = Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > 720) {
    const err = new Error('عدد ساعات الإتاحة يجب أن يكون رقمًا صحيحًا بين 1 و720.');
    err.code = 'BAD_HOURS';
    throw err;
  }
  try {
    const r = await pool.query(
      `INSERT INTO exams(subject_id, stage_season_id, teacher_id, exam_number, title,
                         opens_at, available_hours, closes_at, max_score)
       VALUES($1,$2,$3,$4,$5, $6::date, $7::int, $6::date + make_interval(hours => $7::int), $8)
       RETURNING *`,
      [subjectId, stageSeasonId, teacherId, n, title, dateIso, h, GRADE_WEIGHTS.examEach]
    );
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error(`الامتحان الشهري رقم ${n} موجود مسبقًا لهذه المادة في هذا الموسم.`);
      e.code = 'EXAM_EXISTS';
      throw e;
    }
    throw err;
  }
}

async function addExamQuestion(examId, { type, prompt, options, correct }) {
  if (!['tf', 'mcq'].includes(type)) throw new Error('نوع السؤال يجب أن يكون tf أو mcq.');
  const exam = await pool.query('SELECT status FROM exams WHERE id=$1', [examId]).then((r) => r.rows[0]);
  if (!exam) throw new Error('الامتحان غير موجود.');
  if (exam.status === 'published') {
    const err = new Error('لا يمكن تعديل أسئلة امتحان منشور.');
    err.code = 'EXAM_PUBLISHED';
    throw err;
  }
  const pos = await pool
    .query('SELECT COALESCE(MAX(position),0)+1 AS n FROM exam_questions WHERE exam_id=$1', [examId])
    .then((r) => Number(r.rows[0].n));
  return pool
    .query(
      `INSERT INTO exam_questions(exam_id, position, question_type, prompt, options, correct_answer)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [examId, pos, type, prompt, options ? JSON.stringify(options) : null, String(correct)]
    )
    .then((r) => r.rows[0]);
}

const listExamQuestions = (examId) =>
  pool
    .query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY position', [examId])
    .then((r) => r.rows);

const deleteExamQuestion = (questionId) =>
  pool.query('DELETE FROM exam_questions WHERE id=$1 RETURNING id', [questionId]).then((r) => r.rowCount > 0);

async function publishExam(examId) {
  const count = await pool
    .query('SELECT COUNT(*) AS c FROM exam_questions WHERE exam_id=$1', [examId])
    .then((r) => Number(r.rows[0].c));
  if (count === 0) {
    const err = new Error('لا يمكن نشر امتحان بلا أسئلة.');
    err.code = 'NO_QUESTIONS';
    throw err;
  }
  return pool
    .query(
      `UPDATE exams SET status='published', published_at=now()
       WHERE id=$1 AND status='draft' RETURNING *`,
      [examId]
    )
    .then((r) => r.rows[0]);
}

const getExamById = (examId) =>
  pool
    .query(
      `SELECT e.*, sub.name AS subject_name,
              (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS question_count
       FROM exams e JOIN subjects sub ON sub.id=e.subject_id WHERE e.id=$1`,
      [examId]
    )
    .then((r) => r.rows[0]);

const listExamsForSubject = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS question_count,
              (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id=e.id AND a.submitted_at IS NOT NULL) AS submitted_count
       FROM exams e WHERE e.subject_id=$1 AND e.stage_season_id=$2 ORDER BY e.exam_number`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

// الامتحانات المتاحة الآن لطالب: منشورة، ضمن وقتها، في موسمه، ولم يُسلّمها بعد.
// طلبة التقارير مشمولون بالامتحانات كطلبة المباحثات تمامًا.
const getOpenExamsForStudent = (studentId) =>
  pool
    .query(
      `SELECT e.*, sub.name AS subject_name,
              (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS question_count,
              a.id AS attempt_id, a.submitted_at
       FROM exams e
       JOIN subjects sub ON sub.id=e.subject_id
       JOIN enrollments en ON en.stage_season_id=e.stage_season_id
            AND en.student_id=$1 AND en.status='active'
       LEFT JOIN exam_attempts a ON a.exam_id=e.id AND a.student_id=$1
       WHERE e.status='published' AND now() BETWEEN e.opens_at AND e.closes_at
         AND a.submitted_at IS NULL
       ORDER BY e.closes_at`,
      [studentId]
    )
    .then((r) => r.rows);

// بدء المحاولة أو استئنافها (لا تُنشأ محاولة ثانية أبدًا).
async function startOrResumeAttempt(examId, studentId) {
  const exam = await getExamById(examId);
  if (!exam) throw new Error('الامتحان غير موجود.');
  if (exam.status !== 'published') {
    const err = new Error('الامتحان غير منشور.');
    err.code = 'NOT_PUBLISHED';
    throw err;
  }
  const now = new Date();
  if (now < new Date(exam.opens_at) || now > new Date(exam.closes_at)) {
    const err = new Error('الامتحان مغلق حاليًا.');
    err.code = 'EXAM_CLOSED';
    throw err;
  }
  // لا يدخل الامتحان إلا طالب مسجَّل فعليًا في موسم المرحلة التي يخصها الامتحان،
  // فلا يُفتح بضغطة زر معدّلة من طالب مرحلة أخرى.
  const enrolled = await pool
    .query(
      `SELECT 1 FROM enrollments WHERE student_id=$1 AND stage_season_id=$2 AND status='active' LIMIT 1`,
      [studentId, exam.stage_season_id]
    )
    .then((r) => Boolean(r.rows[0]));
  if (!enrolled) {
    const err = new Error('هذا الامتحان ليس لمرحلتك.');
    err.code = 'NOT_ENROLLED';
    throw err;
  }

  const existing = await pool
    .query('SELECT * FROM exam_attempts WHERE exam_id=$1 AND student_id=$2', [examId, studentId])
    .then((r) => r.rows[0]);
  if (existing) {
    if (existing.submitted_at) {
      const err = new Error('سبق أن سلّمت هذا الامتحان.');
      err.code = 'ALREADY_SUBMITTED';
      throw err;
    }
    return existing;
  }
  return pool
    .query(
      `INSERT INTO exam_attempts(exam_id, student_id, total_questions)
       VALUES($1,$2,$3) RETURNING *`,
      [examId, studentId, Number(exam.question_count)]
    )
    .then((r) => r.rows[0]);
}

// السؤال التالي الذي لم يُجب عنه — يجعل الامتحان قابلًا للاستئناف بعد انقطاع الاتصال.
const getNextUnansweredQuestion = (attemptId) =>
  pool
    .query(
      `SELECT q.*, (SELECT COUNT(*) FROM exam_questions qq WHERE qq.exam_id=q.exam_id) AS total,
              (SELECT COUNT(*) FROM exam_answers ans WHERE ans.attempt_id=$1) AS answered
       FROM exam_questions q
       JOIN exam_attempts a ON a.id=$1 AND a.exam_id=q.exam_id
       WHERE NOT EXISTS (SELECT 1 FROM exam_answers ans WHERE ans.attempt_id=$1 AND ans.question_id=q.id)
       ORDER BY q.position LIMIT 1`,
      [attemptId]
    )
    .then((r) => r.rows[0]);

// تُحفظ الإجابة وتُصحَّح فورًا (تصحيح آلي بالكامل).
async function submitAnswer(attemptId, questionId, answer) {
  const q = await pool
    .query('SELECT * FROM exam_questions WHERE id=$1', [questionId])
    .then((r) => r.rows[0]);
  if (!q) throw new Error('السؤال غير موجود.');
  const isCorrect = String(answer).trim() === String(q.correct_answer).trim();
  return pool
    .query(
      `INSERT INTO exam_answers(attempt_id, question_id, answer, is_correct)
       VALUES($1,$2,$3,$4) ON CONFLICT (attempt_id, question_id) DO NOTHING RETURNING *`,
      [attemptId, questionId, String(answer), isCorrect]
    )
    .then((r) => r.rows[0]);
}

// التسليم: الدرجة نسبة الإجابات الصحيحة من 5، مهما كان عدد الأسئلة.
async function finalizeAttempt(attemptId) {
  const attempt = await pool
    .query('SELECT * FROM exam_attempts WHERE id=$1', [attemptId])
    .then((r) => r.rows[0]);
  if (!attempt) throw new Error('المحاولة غير موجودة.');
  if (attempt.submitted_at) return attempt;

  const stats = await pool
    .query(
      `SELECT COUNT(*) FILTER (WHERE is_correct) AS correct,
              (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=$2) AS total
       FROM exam_answers WHERE attempt_id=$1`,
      [attemptId, attempt.exam_id]
    )
    .then((r) => r.rows[0]);

  const total = Number(stats.total) || 0;
  const correct = Number(stats.correct) || 0;
  const maxScore = await pool
    .query('SELECT max_score FROM exams WHERE id=$1', [attempt.exam_id])
    .then((r) => Number(r.rows[0].max_score));
  const score = total === 0 ? 0 : Math.round((correct / total) * maxScore * 100) / 100;

  return pool
    .query(
      `UPDATE exam_attempts SET submitted_at=now(), score=$2, correct_count=$3, total_questions=$4
       WHERE id=$1 RETURNING *`,
      [attemptId, score, correct, total]
    )
    .then((r) => r.rows[0]);
}

// تأجيل امتحان منشور إلى تاريخ جديد (ما لم يكن قد سلّمه أحد).
async function postponeExam(examId, newDateIso, hours) {
  const submitted = await pool
    .query('SELECT COUNT(*) AS c FROM exam_attempts WHERE exam_id=$1 AND submitted_at IS NOT NULL', [examId])
    .then((r) => Number(r.rows[0].c));
  if (submitted > 0) {
    const err = new Error(`سلّم ${submitted} طالبًا هذا الامتحان، فلا يمكن تأجيله.`);
    err.code = 'ALREADY_TAKEN';
    throw err;
  }
  const h = Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > 720) {
    const err = new Error('عدد ساعات الإتاحة يجب أن يكون بين 1 و720.');
    err.code = 'BAD_HOURS';
    throw err;
  }
  // تُحذف المحاولات غير المسلَّمة كي يبدأ الجميع من جديد في الموعد الجديد
  await pool.query('DELETE FROM exam_attempts WHERE exam_id=$1 AND submitted_at IS NULL', [examId]);
  return pool
    .query(
      `UPDATE exams SET
         original_opens_at = COALESCE(original_opens_at, opens_at),
         opens_at = $2::date,
         available_hours = $3::int,
         closes_at = $2::date + make_interval(hours => $3::int),
         postponed_count = postponed_count + 1
       WHERE id=$1 RETURNING *`,
      [examId, newDateIso, h]
    )
    .then((r) => r.rows[0]);
}

const getExamResults = (examId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name, a.score, a.correct_count, a.total_questions, a.submitted_at
       FROM exam_attempts a JOIN students st ON st.id=a.student_id
       WHERE a.exam_id=$1 ORDER BY a.score DESC NULLS LAST, st.full_name`,
      [examId]
    )
    .then((r) => r.rows);

const getAttemptById = (attemptId) =>
  pool.query('SELECT * FROM exam_attempts WHERE id=$1', [attemptId]).then((r) => r.rows[0]);

const getQuestionById = (questionId) =>
  pool.query('SELECT * FROM exam_questions WHERE id=$1', [questionId]).then((r) => r.rows[0]);

// درجات الطالب في الامتحانات الشهرية التي سلّمها (تُعرض له بعد كل امتحان وفي شاشته).
const getStudentExamResults = (studentId) =>
  pool
    .query(
      `SELECT a.score, a.correct_count, a.total_questions, a.submitted_at,
              e.exam_number, e.max_score, sub.name AS subject_name
       FROM exam_attempts a
       JOIN exams e ON e.id=a.exam_id
       JOIN subjects sub ON sub.id=e.subject_id
       WHERE a.student_id=$1 AND a.submitted_at IS NOT NULL
       ORDER BY a.submitted_at DESC`,
      [studentId]
    )
    .then((r) => r.rows);

// جدول الطالب: مواعيد المجموعات التي هو عضو فيها.
const listStudentSlots = (studentId) =>
  pool
    .query(
      `SELECT sl.*, sub.name AS subject_name, g.title AS group_title
       FROM group_memberships m
       JOIN mubahatha_groups g ON g.id=m.group_id
       JOIN schedule_slots sl ON sl.group_id=g.id AND sl.is_active=true
       JOIN subjects sub ON sub.id=sl.subject_id
       WHERE m.student_id=$1
       ORDER BY sl.day_of_week, sl.hour, sl.minute`,
      [studentId]
    )
    .then((r) => r.rows);

// مواد الطالب في موسمه النشط مع نمط مشاركته ومجموعته إن وُجدت.
const listStudentSubjects = (studentId) =>
  pool
    .query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name,
              ss.id AS stage_season_id,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              pm.mode, pm.switched_at,
              g.id AS group_id, g.title AS group_title, g.invite_link,
              (SELECT COUNT(*) FROM student_reports r
               WHERE r.student_id=$1 AND r.subject_id=sub.id AND r.stage_season_id=ss.id) AS report_count
       FROM enrollments e
       JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       JOIN subjects sub ON sub.stage_id=ss.stage_id
       LEFT JOIN participation_modes pm
              ON pm.student_id=$1 AND pm.subject_id=sub.id AND pm.stage_season_id=ss.id
       LEFT JOIN group_memberships m
              ON m.student_id=$1 AND m.subject_id=sub.id AND m.stage_season_id=ss.id
       LEFT JOIN mubahatha_groups g ON g.id=m.group_id
       WHERE e.student_id=$1 AND e.status='active'
       ORDER BY sub.name`,
      [studentId]
    )
    .then((r) => r.rows);

// التقارير التي لم تُقيَّم بعد في مادة — تُسلَّم للأستاذ الجديد عند تغيير الأستاذ.
const listUngradedReports = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT r.*, st.full_name
       FROM student_reports r
       JOIN students st ON st.id=r.student_id
       LEFT JOIN final_grades fg
              ON fg.student_id=r.student_id AND fg.subject_id=r.subject_id
             AND fg.stage_season_id=r.stage_season_id
       WHERE r.subject_id=$1 AND r.stage_season_id=$2
         AND (fg.report_score IS NULL)
       ORDER BY st.full_name, r.submitted_at`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

// ملخّص ما تحتويه المادة لتسليمه للأستاذ الجديد
const getSubjectHandoverSummary = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT
         (SELECT COUNT(*) FROM enrollments e
          WHERE e.stage_season_id=$2 AND e.status='active') AS student_count,
         (SELECT COUNT(*) FROM mubahatha_groups g
          WHERE g.subject_id=$1 AND g.stage_season_id=$2) AS group_count,
         (SELECT COUNT(*) FROM schedule_slots sl
          WHERE sl.subject_id=$1 AND sl.stage_season_id=$2 AND sl.is_active=true) AS slot_count,
         (SELECT COUNT(*) FROM mubahatha_sessions ms
          JOIN mubahatha_groups g2 ON g2.id=ms.group_id
          WHERE g2.subject_id=$1 AND g2.stage_season_id=$2) AS session_count,
         (SELECT COUNT(*) FROM exams e2
          WHERE e2.subject_id=$1 AND e2.stage_season_id=$2) AS exam_count,
         (SELECT COUNT(*) FROM participation_modes pm
          WHERE pm.subject_id=$1 AND pm.stage_season_id=$2 AND pm.mode='report') AS report_students`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

// تغيير أستاذ المادة: كل بيانات المادة مرتبطة بالمادة والموسم لا بالأستاذ،
// فتنتقل تلقائيًا. ونحوّل معها ملكية المواعيد والامتحانات ليدير الأستاذ الجديد جلساته.
async function replaceSubjectTeacher(subjectId, stageSeasonId, newTeacherId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT ta.teacher_id, t.full_name, t.telegram_id
       FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id
       WHERE ta.subject_id=$1 AND ta.stage_season_id=$2`,
      [subjectId, stageSeasonId]
    );
    await client.query(
      'DELETE FROM teaching_assignments WHERE subject_id=$1 AND stage_season_id=$2',
      [subjectId, stageSeasonId]
    );
    await client.query(
      `INSERT INTO teaching_assignments(teacher_id, subject_id, stage_season_id)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [newTeacherId, subjectId, stageSeasonId]
    );
    // المواعيد والامتحانات تنتقل ملكيتها ليصل السؤال اليومي للأستاذ الجديد
    await client.query(
      'UPDATE schedule_slots SET teacher_id=$3 WHERE subject_id=$1 AND stage_season_id=$2',
      [subjectId, stageSeasonId, newTeacherId]
    );
    await client.query(
      'UPDATE exams SET teacher_id=$3 WHERE subject_id=$1 AND stage_season_id=$2',
      [subjectId, stageSeasonId, newTeacherId]
    );
    await client.query('COMMIT');
    return { previous: previous.rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// إدارة الاستثناءات: يعالج النظام الحالات الطبيعية، ويُبرز للأدمن ما يحتاج تدخلًا بشريًا.
const getInstituteExceptions = () =>
  pool
    .query(
      `SELECT
        (SELECT COUNT(*) FROM participation_modes pm
         JOIN stage_seasons ss ON ss.id=pm.stage_season_id AND ss.is_active=true
         WHERE pm.mode='mubahatha' AND NOT EXISTS (
           SELECT 1 FROM group_memberships m WHERE m.student_id=pm.student_id
             AND m.subject_id=pm.subject_id AND m.stage_season_id=pm.stage_season_id
         )) AS unassigned_students,
        (SELECT COUNT(*) FROM enrollments e
         JOIN stage_seasons ss2 ON ss2.id=e.stage_season_id AND ss2.is_active=true
         JOIN stages sgx ON sgx.id=ss2.stage_id AND sgx.stage_type <> 'lessons_only'
         JOIN subjects sub ON sub.stage_id=ss2.stage_id
         WHERE e.status='active' AND NOT EXISTS (
           SELECT 1 FROM participation_modes pm2 WHERE pm2.student_id=e.student_id
             AND pm2.subject_id=sub.id AND pm2.stage_season_id=e.stage_season_id
         )) AS no_mode_students,
        (SELECT COUNT(*) FROM mubahatha_groups g
         JOIN stage_seasons ss3 ON ss3.id=g.stage_season_id AND ss3.is_active=true
         WHERE g.invite_link IS NULL) AS groups_without_link,
        (SELECT COUNT(*) FROM subjects sub2
         JOIN stage_seasons ss4 ON ss4.stage_id=sub2.stage_id AND ss4.is_active=true
         JOIN stages sgy ON sgy.id=ss4.stage_id AND sgy.stage_type <> 'lessons_only'
         WHERE NOT EXISTS (
           SELECT 1 FROM teaching_assignments ta WHERE ta.subject_id=sub2.id
             AND ta.stage_season_id=ss4.id
         )) AS subjects_without_teacher,
        (SELECT COUNT(*) FROM teachers WHERE is_active=true AND telegram_id IS NULL) AS unlinked_teachers,
        (SELECT COUNT(*) FROM student_leaves WHERE status='pending') AS pending_leaves,
        (SELECT COUNT(*) FROM exams e2
         JOIN stage_seasons ss5 ON ss5.id=e2.stage_season_id AND ss5.is_active=true
         WHERE e2.status='draft') AS draft_exams,
        (SELECT COUNT(*) FROM student_reports r
         JOIN stage_seasons ss6 ON ss6.id=r.stage_season_id AND ss6.is_active=true
         LEFT JOIN final_grades fg ON fg.student_id=r.student_id AND fg.subject_id=r.subject_id
              AND fg.stage_season_id=r.stage_season_id
         WHERE fg.report_score IS NULL) AS ungraded_reports,
        (SELECT COUNT(*) FROM stage_seasons ss7
         WHERE ss7.is_active=true AND NOT EXISTS (
           SELECT 1 FROM channels c WHERE c.stage_season_id=ss7.id
         )) AS stages_without_channel`
    )
    .then((r) => r.rows[0]);

// ---------------------------------------------------------------------------
// نقل الطالب وإخراجه من المجموعات
// ---------------------------------------------------------------------------
// مجموعات الطالب الحالية (لاختيار المادة عند نقله).
const listStudentGroups = (studentId) =>
  pool
    .query(
      `SELECT m.subject_id, m.stage_season_id, g.id AS group_id, g.title AS group_title,
              sub.name AS subject_name
       FROM group_memberships m
       JOIN mubahatha_groups g ON g.id=m.group_id
       JOIN subjects sub ON sub.id=m.subject_id
       JOIN stage_seasons ss ON ss.id=m.stage_season_id AND ss.is_active=true
       WHERE m.student_id=$1
       ORDER BY sub.name`,
      [studentId]
    )
    .then((r) => r.rows);

// نقل الطالب إلى مجموعة أخرى في نفس المادة: يبدأ من جديد فلا تُحسب عليه
// جلسات المجموعة السابقة ولا تُنقل درجاتها معه.
async function moveStudentToGroup(studentId, subjectId, stageSeasonId, newGroupId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT g.*, (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) AS member_count
       FROM mubahatha_groups g WHERE g.id=$1 FOR UPDATE`,
      [newGroupId]
    );
    const group = target.rows[0];
    if (!group) throw new Error('المجموعة غير موجودة.');
    if (Number(group.member_count) >= Number(group.capacity)) {
      const err = new Error('المجموعة ممتلئة.');
      err.code = 'GROUP_FULL';
      throw err;
    }
    await client.query(
      `INSERT INTO group_memberships(group_id, student_id, subject_id, stage_season_id)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (student_id, subject_id, stage_season_id)
       DO UPDATE SET group_id=$1, assigned_at=now()`,
      [newGroupId, studentId, subjectId, stageSeasonId]
    );
    // بداية جديدة: الجلسات السابقة لا تُحسب عليه
    await client.query(
      `UPDATE participation_modes SET joined_mubahatha_at=now()
       WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3`,
      [studentId, subjectId, stageSeasonId]
    );
    await client.query('COMMIT');
    return group;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// إخراج الطالب من مجموعة المادة (يبقى مسجَّلًا في المرحلة).
const removeStudentFromGroup = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      'DELETE FROM group_memberships WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 RETURNING id',
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rowCount > 0);

// تصفير سجل الطالب الدراسي في موسم مرحلة معيّنة: يُستخدم عند نقله لمرحلة أخرى
// كي ينتقل بلا أي درجات (لا مجموعات ولا حضور مباحثات ولا محاولات امتحان ولا درجات نهائية).
async function resetStudentStudies(studentId, stageSeasonId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM mubahatha_attendance a
       USING mubahatha_sessions s, mubahatha_groups g
       WHERE a.session_id=s.id AND s.group_id=g.id
         AND a.student_id=$1 AND g.stage_season_id=$2`,
      [studentId, stageSeasonId]
    );
    await client.query(
      `DELETE FROM exam_attempts a USING exams e
       WHERE a.exam_id=e.id AND a.student_id=$1 AND e.stage_season_id=$2`,
      [studentId, stageSeasonId]
    );
    await client.query('DELETE FROM group_memberships WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
    await client.query('DELETE FROM participation_modes WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
    await client.query('DELETE FROM student_reports WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
    await client.query('DELETE FROM final_grades WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// التقارير
// ---------------------------------------------------------------------------
const submitReport = (studentId, subjectId, stageSeasonId, { fileId, kind, note }) =>
  pool
    .query(
      `INSERT INTO student_reports(student_id, subject_id, stage_season_id, telegram_file_id, file_kind, note)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [studentId, subjectId, stageSeasonId, fileId, kind, note]
    )
    .then((r) => r.rows[0]);

// طلبة التقارير في المادة مع عدد ما سلّموه — يستعرضهم الأستاذ واحدًا تلو الآخر عند التقييم.
const listReportStudentsForGrading = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name, pm.mode, pm.switched_at,
              COUNT(r.id) AS report_count,
              MAX(r.submitted_at) AS last_submission,
              fg.report_score
       FROM participation_modes pm
       JOIN students st ON st.id=pm.student_id
       LEFT JOIN student_reports r
              ON r.student_id=st.id AND r.subject_id=pm.subject_id AND r.stage_season_id=pm.stage_season_id
       LEFT JOIN final_grades fg
              ON fg.student_id=st.id AND fg.subject_id=pm.subject_id AND fg.stage_season_id=pm.stage_season_id
       WHERE pm.subject_id=$1 AND pm.stage_season_id=$2
         AND (pm.mode='report' OR pm.switched_at IS NOT NULL)
       GROUP BY st.id, st.full_name, pm.mode, pm.switched_at, fg.report_score
       ORDER BY st.full_name`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

const listStudentReports = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT * FROM student_reports
       WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 ORDER BY submitted_at`,
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

const setReportScore = (studentId, subjectId, stageSeasonId, score) =>
  pool
    .query(
      `INSERT INTO final_grades(student_id, subject_id, stage_season_id, report_score)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (student_id, subject_id, stage_season_id)
       DO UPDATE SET report_score=$4 RETURNING *`,
      [studentId, subjectId, stageSeasonId, score]
    )
    .then((r) => r.rows[0]);

// ---------------------------------------------------------------------------
// الجدول الأسبوعي للمباحثات
// ---------------------------------------------------------------------------
// المنطقة الزمنية للجدولة (العراق افتراضيًا) — كل الساعات في الجدول بتوقيت محلي.
const SCHEDULE_TZ = process.env.SCHEDULE_TIMEZONE || 'Asia/Baghdad';

// الساعات المتاحة للاختيار من الأستاذ (تُعرض كأزرار: 8، 9، 10 ...)
const SCHEDULE_HOURS = (process.env.SCHEDULE_HOURS || '8,9,10,11,12,13,14,15,16,17,18,19,20,21')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);

// أسماء الأيام بترتيب PostgreSQL/JS: 0 = الأحد
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

const formatHour = (hour, minute = 0) =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

const formatSlot = (slot) =>
  `${DAY_NAMES[slot.day_of_week]} ${formatHour(slot.hour, slot.minute)}`;

// تعارض الجدول: طالب المرحلة يدرس كل موادها، فلا يصح أن تُعقد مادتان مختلفتان
// للمرحلة نفسها في اليوم والساعة ذاتهما. أما مجموعتا المادة الواحدة فلا تعارض بينهما
// لأن الطالب في مجموعة واحدة فقط.
const findScheduleConflicts = (stageSeasonId, dayOfWeek, hour, subjectId) =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, g.title AS group_title, g.group_number
       FROM schedule_slots s
       JOIN subjects sub ON sub.id = s.subject_id
       JOIN mubahatha_groups g ON g.id = s.group_id
       WHERE s.stage_season_id=$1 AND s.day_of_week=$2 AND s.hour=$3
         AND s.subject_id <> $4 AND s.is_active=true`,
      [stageSeasonId, dayOfWeek, hour, subjectId]
    )
    .then((r) => r.rows);

async function addScheduleSlot(groupId, { dayOfWeek, hour, minute = 0, durationHours = 1, teacherId }) {
  // المباحثة ساعة واحدة كحد أقصى، فكل ساعة موعد مستقل.
  const hours = Math.min(1, Math.max(1, Number(durationHours) || 1));
  const group = await pool
    .query('SELECT * FROM mubahatha_groups WHERE id=$1', [groupId])
    .then((r) => r.rows[0]);
  if (!group) throw new Error('المجموعة غير موجودة.');

  const conflicts = await findScheduleConflicts(group.stage_season_id, dayOfWeek, hour, group.subject_id);
  try {
    const slot = await pool
      .query(
        `INSERT INTO schedule_slots(group_id, subject_id, stage_season_id, teacher_id,
                                    day_of_week, hour, minute, duration_hours)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [groupId, group.subject_id, group.stage_season_id, teacherId, dayOfWeek, hour, minute, hours]
      )
      .then((r) => r.rows[0]);
    return { slot, conflicts };
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error('هذا الموعد مسجَّل مسبقًا لهذه المجموعة.');
      e.code = 'SLOT_EXISTS';
      throw e;
    }
    throw err;
  }
}

const removeScheduleSlot = (slotId) =>
  pool.query('DELETE FROM schedule_slots WHERE id=$1 RETURNING id', [slotId]).then((r) => r.rowCount > 0);

const listGroupSlots = (groupId) =>
  pool
    .query('SELECT * FROM schedule_slots WHERE group_id=$1 ORDER BY day_of_week, hour, minute', [groupId])
    .then((r) => r.rows);

const listTeacherSlots = (teacherId) =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, g.title AS group_title, g.group_number,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       WHERE s.teacher_id=$1 AND s.is_active=true
       ORDER BY s.day_of_week, s.hour, s.minute`,
      [teacherId]
    )
    .then((r) => r.rows);

// كل مواعيد المواسم النشطة — للأدمن الذي يشرف على الجميع.
const listAllSlots = () =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, g.title AS group_title, g.group_number,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              t.full_name AS teacher_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       LEFT JOIN teachers t ON t.id=s.teacher_id
       WHERE s.is_active=true
       ORDER BY sg.sort_order NULLS LAST, s.day_of_week, s.hour, s.minute`
    )
    .then((r) => r.rows);

// جدول المرحلة كاملًا (لعرضه على الأدمن ولكشف التعارضات بصريًا)
const listStageSeasonSlots = (stageSeasonId) =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, g.group_number, t.full_name AS teacher_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       LEFT JOIN teachers t ON t.id=s.teacher_id
       WHERE s.stage_season_id=$1 AND s.is_active=true
       ORDER BY s.day_of_week, s.hour, s.minute`,
      [stageSeasonId]
    )
    .then((r) => r.rows);

// ---------------------------------------------------------------------------
// السؤال اليومي للأستاذ وفتح الجلسة تلقائيًا
// ---------------------------------------------------------------------------
// المواعيد التي حان وقت سؤال أستاذها (قبل الموعد بـ leadMinutes) ولم يُسأل عنها اليوم بعد.
const getSlotsNeedingPrompt = (leadMinutes = 5) =>
  pool
    .query(
      `WITH loc AS (SELECT (now() AT TIME ZONE $1) AS ln)
       SELECT s.*, sub.name AS subject_name, g.title AS group_title, g.group_number,
              t.telegram_id AS teacher_telegram_id, t.full_name AS teacher_name,
              loc.ln::date AS scheduled_date
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       LEFT JOIN teachers t ON t.id=s.teacher_id
       CROSS JOIN loc
       WHERE s.is_active=true
         AND EXTRACT(DOW FROM loc.ln)::int = s.day_of_week
         AND (loc.ln::date + make_time(s.hour, s.minute, 0)) - loc.ln
             BETWEEN interval '0 minutes' AND make_interval(mins => $2::int)
         AND NOT EXISTS (
           SELECT 1 FROM slot_decisions d
           WHERE d.slot_id = s.id AND d.scheduled_date = loc.ln::date
         )`,
      [SCHEDULE_TZ, leadMinutes]
    )
    .then((r) => r.rows);

// يُسجَّل أن الأستاذ سُئل اليوم، فلا يتكرر السؤال.
const recordSlotPrompt = (slotId, scheduledDate) =>
  pool
    .query(
      `INSERT INTO slot_decisions(slot_id, scheduled_date) VALUES($1,$2::date)
       ON CONFLICT (slot_id, scheduled_date) DO NOTHING RETURNING *`,
      [slotId, scheduledDate]
    )
    .then((r) => r.rows[0]);

const recordSlotDecision = (slotId, scheduledDate, decision, decidedBy) =>
  pool
    .query(
      `INSERT INTO slot_decisions(slot_id, scheduled_date, decision, decided_at, decided_by)
       VALUES($1,$2::date,$3, now(), $4)
       ON CONFLICT (slot_id, scheduled_date)
       DO UPDATE SET decision=$3, decided_at=now(), decided_by=$4
       RETURNING *`,
      [slotId, scheduledDate, decision, decidedBy]
    )
    .then((r) => r.rows[0]);

const getSlotDecision = (slotId, scheduledDate) =>
  pool
    .query('SELECT * FROM slot_decisions WHERE slot_id=$1 AND scheduled_date=$2::date', [slotId, scheduledDate])
    .then((r) => r.rows[0]);

// المواعيد المؤكَّدة التي حان وقتها ولم تُفتح جلستها بعد.
const getSlotsReadyToStart = () =>
  pool
    .query(
      `WITH loc AS (SELECT (now() AT TIME ZONE $1) AS ln)
       SELECT s.*, d.id AS decision_id, d.scheduled_date,
              sub.name AS subject_name, g.title AS group_title, g.group_number
       FROM slot_decisions d
       JOIN schedule_slots s ON s.id=d.slot_id
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       CROSS JOIN loc
       WHERE d.decision='confirmed' AND d.session_id IS NULL
         AND d.scheduled_date = loc.ln::date
         AND loc.ln >= (d.scheduled_date + make_time(s.hour, s.minute, 0))`,
      [SCHEDULE_TZ]
    )
    .then((r) => r.rows);

// يفتح جلسة الموعد ويربطها بالقرار حتى لا تُفتح مرتين.
async function startSessionFromSlot(slot) {
  const session = await openSession(
    slot.group_id,
    slot.teacher_id,
    `${slot.subject_name} — ${formatSlot(slot)}`,
    slot.duration_hours
  );
  await pool.query('UPDATE slot_decisions SET session_id=$2 WHERE id=$1', [slot.decision_id, session.id]);
  return session;
}

const getSessionById = (sessionId) =>
  pool.query('SELECT * FROM mubahatha_sessions WHERE id=$1', [sessionId]).then((r) => r.rows[0]);

// التحقق أن الطالب عضو في مجموعة الجلسة قبل قبول تسجيل حضوره
const isStudentInGroup = (studentId, groupId) =>
  pool
    .query('SELECT 1 FROM group_memberships WHERE student_id=$1 AND group_id=$2', [studentId, groupId])
    .then((r) => Boolean(r.rows[0]));

// طلبة الموسم النشط في مرحلة معيّنة (لإشعارهم بالامتحانات مثلًا)
const listSeasonStudents = (stageSeasonId) =>
  pool
    .query(
      `SELECT st.id, st.telegram_id, st.full_name
       FROM enrollments e
       JOIN students st ON st.id=e.student_id AND st.is_active=true
       WHERE e.stage_season_id=$1 AND e.status='active'`,
      [stageSeasonId]
    )
    .then((r) => r.rows);

// أعضاء المجموعة لإرسال تنبيه بدء المباحثة إليهم
const listGroupStudents = (groupId) =>
  pool
    .query(
      `SELECT st.id, st.telegram_id, st.full_name
       FROM group_memberships m
       JOIN students st ON st.id=m.student_id AND st.is_active=true
       WHERE m.group_id=$1`,
      [groupId]
    )
    .then((r) => r.rows);

// ---------------------------------------------------------------------------
// درجات الطالب المحفوظة (تبقى لكل موسم على حدة فلا تضيع مع المواسم القادمة)
// ---------------------------------------------------------------------------
const getStudentFinalGrades = (studentId) =>
  pool
    .query(
      `SELECT fg.*, sub.name AS subject_name,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              se.name AS season_name, ss.is_active AS season_active,
              pm.mode
       FROM final_grades fg
       JOIN subjects sub ON sub.id=fg.subject_id
       JOIN stage_seasons ss ON ss.id=fg.stage_season_id
       JOIN stages sg ON sg.id=ss.stage_id
       JOIN seasons se ON se.id=ss.season_id
       LEFT JOIN participation_modes pm
              ON pm.student_id=fg.student_id AND pm.subject_id=fg.subject_id
             AND pm.stage_season_id=fg.stage_season_id
       WHERE fg.student_id=$1 AND fg.finalized_at IS NOT NULL
       ORDER BY ss.started_at DESC, sub.name`,
      [studentId]
    )
    .then((r) => r.rows);

// تحرير درجة طالب يدويًا من الأستاذ أو الأدمن (لمن يحتاج مساعدة).
// يُحفظ من عدّلها ومتى، ويُعاد حساب المجموع من القيم الجديدة.
async function overrideStudentGrade(studentId, subjectId, stageSeasonId, fields, editedBy) {
  const current = await pool
    .query(
      'SELECT * FROM final_grades WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3',
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

  const exams = fields.examsScore !== undefined ? Number(fields.examsScore) : Number(current ? current.exams_score : 0);
  const participation =
    fields.participationScore !== undefined
      ? Number(fields.participationScore)
      : Number(current ? current.participation_score : 0);

  const cappedExams = Math.max(0, Math.min(GRADE_WEIGHTS.examsTotal, exams));
  const cappedPart = Math.max(0, Math.min(GRADE_WEIGHTS.participationTotal, participation));
  const total = Math.round((cappedExams + cappedPart) * 100) / 100;

  return pool
    .query(
      `INSERT INTO final_grades(student_id, subject_id, stage_season_id,
          exams_score, participation_score, total_score, finalized_at, edited_by, edited_at)
       VALUES($1,$2,$3,$4,$5,$6, COALESCE((SELECT finalized_at FROM final_grades
           WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3), now()), $7, now())
       ON CONFLICT (student_id, subject_id, stage_season_id) DO UPDATE SET
          exams_score=$4, participation_score=$5, total_score=$6,
          finalized_at=COALESCE(final_grades.finalized_at, now()),
          edited_by=$7, edited_at=now()
       RETURNING *`,
      [studentId, subjectId, stageSeasonId, cappedExams, cappedPart, total, editedBy]
    )
    .then((r) => r.rows[0]);
}

// طلبة المادة في الموسم مع درجاتهم (لاختيار من يُحرَّر له)
const listSubjectGrades = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name, fg.exams_score, fg.participation_score,
              fg.total_score, fg.edited_at
       FROM enrollments e
       JOIN students st ON st.id=e.student_id AND st.is_active=true
       LEFT JOIN final_grades fg
              ON fg.student_id=st.id AND fg.subject_id=$1 AND fg.stage_season_id=$2
       WHERE e.stage_season_id=$2 AND e.status='active'
       ORDER BY st.full_name`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

// ---------------------------------------------------------------------------
// احتساب درجات نهاية الموسم
// ---------------------------------------------------------------------------
// درجة المباحثات: نسبة وتناسب — (ما حضره ÷ الجلسات المؤهَّلة له) × 15.
// «المؤهَّلة» تستثني الجلسات التي عُقدت قبل انضمامه (حالة المحوَّل من التقارير).
// درجة الامتحانات: مجموع درجات الامتحانات الثلاثة (5 لكل امتحان).
// درجة المشاركة النهائية = درجة التقارير + درجة المباحثات، بحد أقصى 15.
async function computeSeasonGrades(subjectId, stageSeasonId) {
  const rows = await pool.query(
    `WITH eligible AS (
       SELECT pm.student_id,
              COUNT(s.id) AS eligible_sessions,
              COUNT(att.id) AS attended_sessions
       FROM participation_modes pm
       LEFT JOIN group_memberships gm
              ON gm.student_id=pm.student_id AND gm.subject_id=pm.subject_id
             AND gm.stage_season_id=pm.stage_season_id
       LEFT JOIN mubahatha_sessions s
              ON s.group_id=gm.group_id
             AND (pm.joined_mubahatha_at IS NULL OR s.opened_at >= pm.joined_mubahatha_at)
       LEFT JOIN mubahatha_attendance att
              ON att.session_id=s.id AND att.student_id=pm.student_id
       WHERE pm.subject_id=$1 AND pm.stage_season_id=$2
       GROUP BY pm.student_id
     ),
     exam_totals AS (
       SELECT a.student_id, COALESCE(SUM(a.score),0) AS exams_score
       FROM exam_attempts a
       JOIN exams e ON e.id=a.exam_id
       WHERE e.subject_id=$1 AND e.stage_season_id=$2 AND a.submitted_at IS NOT NULL
       GROUP BY a.student_id
     )
     SELECT st.id AS student_id, st.full_name, pm.mode,
            COALESCE(el.eligible_sessions,0) AS eligible_sessions,
            COALESCE(el.attended_sessions,0) AS attended_sessions,
            COALESCE(et.exams_score,0) AS exams_score,
            COALESCE(fg.report_score,0) AS report_score
     FROM participation_modes pm
     JOIN students st ON st.id=pm.student_id
     LEFT JOIN eligible el ON el.student_id=pm.student_id
     LEFT JOIN exam_totals et ON et.student_id=pm.student_id
     LEFT JOIN final_grades fg
            ON fg.student_id=pm.student_id AND fg.subject_id=pm.subject_id
           AND fg.stage_season_id=pm.stage_season_id
     WHERE pm.subject_id=$1 AND pm.stage_season_id=$2
     ORDER BY st.full_name`,
    [subjectId, stageSeasonId]
  );

  return rows.rows.map((r) => {
    const eligible = Number(r.eligible_sessions);
    const attended = Number(r.attended_sessions);
    const mubahathaScore =
      eligible === 0 ? 0 : Math.round((attended / eligible) * GRADE_WEIGHTS.participationTotal * 100) / 100;
    const reportScore = Number(r.report_score);
    const participation = Math.min(GRADE_WEIGHTS.participationTotal, mubahathaScore + reportScore);
    const examsScore = Math.min(GRADE_WEIGHTS.examsTotal, Number(r.exams_score));
    return {
      studentId: r.student_id,
      fullName: r.full_name,
      mode: r.mode,
      eligibleSessions: eligible,
      attendedSessions: attended,
      mubahathaScore,
      reportScore,
      participationScore: Math.round(participation * 100) / 100,
      examsScore,
      totalScore: Math.round((participation + examsScore) * 100) / 100,
    };
  });
}

// إنهاء موسم المباحثات والتقارير: يحفظ الدرجات المحسوبة في final_grades.
async function finalizeSeasonGrades(subjectId, stageSeasonId) {
  const grades = await computeSeasonGrades(subjectId, stageSeasonId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const g of grades) {
      await client.query(
        `INSERT INTO final_grades(student_id, subject_id, stage_season_id,
            exams_score, mubahatha_score, report_score, participation_score, total_score, finalized_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (student_id, subject_id, stage_season_id) DO UPDATE SET
            exams_score=$4, mubahatha_score=$5, participation_score=$7,
            total_score=$8, finalized_at=now()`,
        [
          g.studentId, subjectId, stageSeasonId,
          g.examsScore, g.mubahathaScore, g.reportScore, g.participationScore, g.totalScore,
        ]
      );
    }
    await client.query('COMMIT');
    return grades;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  GRADE_WEIGHTS,
  SCHEDULE_HOURS,
  SCHEDULE_TZ,
  DAY_NAMES,
  formatHour,
  formatSlot,
  findScheduleConflicts,
  addScheduleSlot,
  removeScheduleSlot,
  listGroupSlots,
  listTeacherSlots,
  listAllSlots,
  listStageSeasonSlots,
  getSlotsNeedingPrompt,
  recordSlotPrompt,
  recordSlotDecision,
  getSlotDecision,
  getSlotsReadyToStart,
  startSessionFromSlot,
  listGroupStudents,
  listSeasonStudents,
  getSessionById,
  isStudentInGroup,
  initStudiesSchema,
  upcomingWeekDays,
  setParticipationMode,
  getParticipationMode,
  switchToMubahatha,
  countParticipationBySubject,
  createMubahathaGroup,
  listGroups,
  getGroupById,
  setGroupCapacity,
  setGroupInviteLink,
  setGroupChatId,
  listPreviousSeasonGroups,
  listUnassignedMubahathaStudents,
  getStudentGroup,
  assignStudentToGroup,
  openSession,
  closeSession,
  listGroupSessions,
  getOpenSessionForGroup,
  markSessionAttendance,
  createExam,
  addExamQuestion,
  listExamQuestions,
  deleteExamQuestion,
  publishExam,
  getExamById,
  listExamsForSubject,
  getOpenExamsForStudent,
  startOrResumeAttempt,
  getNextUnansweredQuestion,
  submitAnswer,
  finalizeAttempt,
  getExamResults,
  postponeExam,
  getAttemptById,
  getQuestionById,
  getStudentExamResults,
  listStudentSlots,
  listUngradedReports,
  getInstituteExceptions,
  getSubjectHandoverSummary,
  replaceSubjectTeacher,
  listStudentSubjects,
  listStudentGroups,
  moveStudentToGroup,
  removeStudentFromGroup,
  resetStudentStudies,
  submitReport,
  listReportStudentsForGrading,
  listStudentReports,
  setReportScore,
  getStudentFinalGrades,
  overrideStudentGrade,
  listSubjectGrades,
  computeSeasonGrades,
  finalizeSeasonGrades,
};
