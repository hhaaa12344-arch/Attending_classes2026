// studies.js — نظام المباحثات والامتحانات: المباحثات والتقارير والامتحانات والدرجات.
// وحدة مستقلة تشارك مجمع الاتصالات نفسه مع db.js (لا استيراد دائري: هذه تستورد db، وdb لا تستوردها).
const { pool } = require('./db');
const {examWindowSql,enrollmentSql}=require('./examAccess');
const { appError, positiveInt, pageOptions, validScore } = require('./integrity');
const {startOrResumeAttempt,submitAnswer,finalizeAttempt,isExamAvailable,overrideStudentGrade}=require('./academicTransactions').createAcademicTransactions(pool);

// توزيع الدرجات في الموسم (قابل للتغيير من مكان واحد)
// الامتحان يفتح ليلًا في الساعة المحددة من اليوم المختار ويستمر عدد الساعات المُدخَل.
const SCHEDULE_TZ = process.env.SCHEDULE_TIMEZONE || 'Asia/Baghdad';
const confirmationSetting = String(process.env.SCHEDULE_REQUIRE_CONFIRMATION ?? 'true').trim().toLowerCase();
if (!['true','false'].includes(confirmationSetting)) throw new Error('SCHEDULE_REQUIRE_CONFIRMATION must be true or false');
const SCHEDULE_REQUIRE_CONFIRMATION = confirmationSetting === 'true';
const EXAM_START_HOUR = Number(process.env.EXAM_START_HOUR || 22);
// لا يظهر حضور البداية فور بدء المباحثة؛ يفتح بعد عشر دقائق من الموعد الأصلي.
const START_ATTENDANCE_DELAY_MINUTES = Number(process.env.START_ATTENDANCE_DELAY_MINUTES || 10);
// Administrative attendance recovery never changes the original discussion schedule.
const DISCUSSION_REOPEN_MINUTES = 10;
if (!Number.isInteger(START_ATTENDANCE_DELAY_MINUTES) || START_ATTENDANCE_DELAY_MINUTES < 1 || START_ATTENDANCE_DELAY_MINUTES > 30) {
  throw new Error('START_ATTENDANCE_DELAY_MINUTES must be an integer from 1 to 30');
}

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

    -- طلبات الطالب لتغيير اشتراكه في مادة (مباحثات ⇄ تقارير)؛ لا تُنفَّذ إلا باعتماد الإدارة.
    CREATE TABLE IF NOT EXISTS participation_change_requests (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      from_mode TEXT NOT NULL CHECK (from_mode IN ('mubahatha','report')),
      to_mode TEXT NOT NULL CHECK (to_mode IN ('mubahatha','report')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      requested_at TIMESTAMP NOT NULL DEFAULT now(),
      decided_at TIMESTAMP,
      decided_by BIGINT,
      CHECK (from_mode <> to_mode)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_participation_change_one_pending
      ON participation_change_requests(student_id, subject_id, stage_season_id) WHERE status='pending';

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
      -- phase: 'start' حضور بداية المباحثة، 'end' حضور نهايتها؛ سجلان مستقلان لكل طالب.
      phase TEXT NOT NULL DEFAULT 'start' CHECK (phase IN ('start','end')),
      marked_at TIMESTAMP NOT NULL DEFAULT now(),
      marked_by TEXT NOT NULL DEFAULT 'student',
      UNIQUE(session_id, student_id, phase)
    );

    -- ترقية آمنة للسجلات القديمة (كان القيد على session+student فقط قبل الحضور المزدوج)
    ALTER TABLE mubahatha_attendance ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'start';
    DO $mub$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mubahatha_attendance_session_id_student_id_key') THEN
        ALTER TABLE mubahatha_attendance DROP CONSTRAINT mubahatha_attendance_session_id_student_id_key;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mubahatha_attendance_session_student_phase_key') THEN
        ALTER TABLE mubahatha_attendance
          ADD CONSTRAINT mubahatha_attendance_session_student_phase_key
          UNIQUE(session_id, student_id, phase);
      END IF;
    END $mub$;

    -- إدارة الحضور الثاني على مستوى الجلسة:
    -- end_opened_at لحظة فتح حضور النهاية، end_closes_at نهاية ساعة الموعد الأصلية، end_prompt_sent حقل تاريخي للتوافق.
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS end_opened_at TIMESTAMP;
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS end_closes_at TIMESTAMP;
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS end_prompt_sent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS attendance_reopened_at TIMESTAMP;
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS attendance_reopen_until TIMESTAMP;
    ALTER TABLE mubahatha_sessions ADD COLUMN IF NOT EXISTS attendance_reopen_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mubahatha_attendance ADD COLUMN IF NOT EXISTS admin_note TEXT;

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
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
      published_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    DO $exam_status$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid='exams'::regclass AND conname='exams_status_check'
          AND pg_get_constraintdef(oid) LIKE '%cancelled%'
      ) THEN
        ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_status_check;
        ALTER TABLE exams ADD CONSTRAINT exams_status_check CHECK (status IN ('draft','published','cancelled'));
      END IF;
    END $exam_status$;
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS cancelled_by BIGINT;
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_subject_id_stage_season_id_exam_number_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_active_monthly_number
      ON exams(subject_id,stage_season_id,exam_number) WHERE status<>'cancelled';

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
      submitted_at TIMESTAMP NOT NULL DEFAULT now(),
      score NUMERIC,
      graded_at TIMESTAMP,
      graded_by BIGINT
    );

    -- تقييم التقارير جزئيًا: الأستاذ يقيّم كل تقرير حين يصله، لا دفعة واحدة في النهاية.
    ALTER TABLE student_reports ADD COLUMN IF NOT EXISTS score NUMERIC;
    ALTER TABLE student_reports ADD COLUMN IF NOT EXISTS graded_at TIMESTAMP;
    ALTER TABLE student_reports ADD COLUMN IF NOT EXISTS graded_by BIGINT;

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
    -- درجة حضور الدروس يمنحها الأستاذ بعد مراجعة تقرير الحضور
    ALTER TABLE final_grades ADD COLUMN IF NOT EXISTS lessons_score NUMERIC NOT NULL DEFAULT 0;


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
    ALTER TABLE slot_decisions ADD COLUMN IF NOT EXISTS reason TEXT;

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
    CREATE INDEX IF NOT EXISTS idx_exam_answers_attempt ON exam_answers(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_reports_subject ON student_reports(subject_id, stage_season_id);
  `);
  // Keep closed participation periods; existing per-subject choices are the fallback.
  // No backfill changes a student's choice or invents one for undecided students.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participation_mode_history (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK(mode IN ('report','mubahatha')),
      started_at TIMESTAMP NOT NULL,
      ended_at TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_participation_history_lookup
      ON participation_mode_history(student_id,subject_id,stage_season_id,started_at,ended_at);
    CREATE OR REPLACE FUNCTION preserve_participation_period() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.mode IS DISTINCT FROM NEW.mode OR
        (OLD.mode='mubahatha' AND OLD.joined_mubahatha_at IS DISTINCT FROM NEW.joined_mubahatha_at) THEN
        INSERT INTO participation_mode_history(student_id,subject_id,stage_season_id,mode,started_at,ended_at)
        VALUES(OLD.student_id,OLD.subject_id,OLD.stage_season_id,OLD.mode,
          CASE WHEN OLD.mode='mubahatha' THEN COALESCE(OLD.joined_mubahatha_at,OLD.chosen_at)
            ELSE COALESCE(OLD.switched_at,OLD.chosen_at) END,
          CASE WHEN OLD.mode IS DISTINCT FROM NEW.mode THEN COALESCE(NEW.switched_at,now())
            ELSE COALESCE(NEW.joined_mubahatha_at,now()) END);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS participation_period_changed ON participation_modes;
    CREATE TRIGGER participation_period_changed BEFORE UPDATE ON participation_modes
      FOR EACH ROW EXECUTE FUNCTION preserve_participation_period();
    CREATE OR REPLACE FUNCTION was_in_mubahatha(stid INTEGER,sid INTEGER,ssid INTEGER,at_time TIMESTAMP)
      RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM participation_mode_history h
        WHERE h.student_id=stid AND h.subject_id=sid AND h.stage_season_id=ssid AND h.mode='mubahatha'
          AND at_time>=h.started_at AND at_time<h.ended_at)
      OR EXISTS(SELECT 1 FROM participation_modes pm
        WHERE pm.student_id=stid AND pm.subject_id=sid AND pm.stage_season_id=ssid AND pm.mode='mubahatha'
          AND at_time>=COALESCE(pm.joined_mubahatha_at,pm.chosen_at))
    $$;
  `);
  await require('./groupAllocation').initGroupAllocation(pool);
  await require('./participationSettings').initParticipationSettings(pool);
}

// ---------------------------------------------------------------------------
// أنماط المشاركة
// ---------------------------------------------------------------------------
async function setParticipationMode(studentId,subjectId,stageSeasonId,mode) {
  try {return await changeParticipationMode(studentId,subjectId,stageSeasonId,mode,{expectedMode:null});}
  catch(e){if(e.code==='CONFLICT')return undefined;throw e;}
}

const getParticipationMode = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      'SELECT * FROM participation_modes WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3',
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

// التحويل من التقارير إلى المباحثات: الجلسات السابقة لا تُحسب عليه إطلاقًا،
// وتقاريره المُسلَّمة تبقى وتُضاف درجتها لاحقًا عند احتساب الدرجة.
async function changeParticipationMode(studentId, subjectId, stageSeasonId, mode, {actorId=null,expectedMode}={}) {
  [studentId,subjectId,stageSeasonId].forEach(positiveInt);
  if(!['report','mubahatha'].includes(mode))throw appError('نوع المتابعة غير صالح.');
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    // Match the lock order used by group allocation and stage transfers.
    await c.query('SELECT id FROM stage_seasons WHERE id=$1 FOR SHARE',[stageSeasonId]);
    await c.query('SELECT id FROM students WHERE id=$1 FOR UPDATE',[studentId]);
    const eligible=(await c.query(`SELECT sub.name AS subject_name FROM students st
      JOIN enrollments e ON e.student_id=st.id AND e.status='active'
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      JOIN subjects sub ON sub.stage_id=ss.stage_id
      WHERE st.id=$1 AND st.is_active=true AND st.stage_id=ss.stage_id AND sub.id=$2 AND ss.id=$3
        AND participation_enabled(sub.id,ss.id)`,[studentId,subjectId,stageSeasonId])).rows[0];
    if(!eligible)throw appError('الطالب غير نشط أو المادة ليست ضمن مواد موسمه المتاحة.','CONFLICT',409);
    const before=(await c.query(`SELECT * FROM participation_modes
      WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 FOR UPDATE`,[studentId,subjectId,stageSeasonId])).rows[0];
    if(expectedMode!==undefined && (before?.mode??null)!==expectedMode)
      throw appError('تغيّر نوع المتابعة. أعد فتح ملف الطالب ثم حاول مجددًا.','CONFLICT',409);
    if(before?.mode===mode){await c.query('COMMIT');return before;}
    const after=(await c.query(`INSERT INTO participation_modes(student_id,subject_id,stage_season_id,mode,chosen_at,joined_mubahatha_at)
      VALUES($1,$2,$3,$4,clock_timestamp(),CASE WHEN $4='mubahatha' THEN clock_timestamp() END)
      ON CONFLICT(student_id,subject_id,stage_season_id) DO UPDATE
      SET mode=EXCLUDED.mode,switched_at=EXCLUDED.chosen_at,
        joined_mubahatha_at=CASE WHEN EXCLUDED.mode='mubahatha' THEN EXCLUDED.chosen_at ELSE participation_modes.joined_mubahatha_at END
      RETURNING *`,[studentId,subjectId,stageSeasonId,mode])).rows[0];
    if(mode==='report')await c.query(`UPDATE notification_outbox n SET status='expired',lease_until=NULL
      WHERE n.status='pending' AND n.chat_id=(SELECT telegram_id FROM students WHERE id=$1)
        AND (EXISTS(SELECT 1 FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
          WHERE g.subject_id=$2 AND g.stage_season_id=$3
            AND (n.dedupe_key LIKE 'session:'||s.id||':start:%' OR n.dedupe_key LIKE 'session:'||s.id||':end:%'
              OR n.dedupe_key LIKE 'session:'||s.id||':reopen:%'))
          OR EXISTS(SELECT 1 FROM schedule_slots sl WHERE sl.subject_id=$2 AND sl.stage_season_id=$3
            AND n.dedupe_key LIKE 'slot:'||sl.id||':%'))`,[studentId,subjectId,stageSeasonId]);
    if(actorId!==null)await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
      VALUES($1,'change_participation_mode','student',$2,$3::jsonb,$4::jsonb)`,
      [actorId,studentId,JSON.stringify(before||{student_id:studentId,subject_id:subjectId,stage_season_id:stageSeasonId,mode:null}),JSON.stringify({...after,subject_name:eligible.subject_name})]);
    await c.query('COMMIT');return after;
  } catch(e){await c.query('ROLLBACK');throw e;} finally {c.release();}
}

async function switchToMubahatha(studentId,subjectId,stageSeasonId) {
  try {return await changeParticipationMode(studentId,subjectId,stageSeasonId,'mubahatha',{expectedMode:'report'});}
  catch(e){if(e.code==='CONFLICT')return undefined;throw e;}
}

// ---------------------------------------------------------------------------
// طلبات تغيير الاشتراك (مباحثات ⇄ تقارير) بموافقة الإدارة
// ---------------------------------------------------------------------------
const OPPOSITE_MODE = { mubahatha: 'report', report: 'mubahatha' };

async function requestParticipationChange(studentId, subjectId, stageSeasonId) {
  [studentId, subjectId, stageSeasonId].forEach(positiveInt);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM students WHERE id=$1 FOR UPDATE', [studentId]);
    const row = (await c.query(`SELECT sub.name AS subject_name, pm.mode FROM students st
      JOIN enrollments e ON e.student_id=st.id AND e.status='active'
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      JOIN subjects sub ON sub.stage_id=ss.stage_id
      JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=sub.id AND pm.stage_season_id=ss.id
      WHERE st.id=$1 AND st.is_active=true AND st.stage_id=ss.stage_id AND sub.id=$2 AND ss.id=$3
        AND participation_enabled(sub.id,ss.id)`, [studentId, subjectId, stageSeasonId])).rows[0];
    if (!row) throw appError('اختر نظام هذه المادة أولًا من «المباحثات والتقارير»، أو أنها ليست ضمن موادك الحالية.', 'CONFLICT', 409);
    const existing = (await c.query(`SELECT * FROM participation_change_requests
      WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 AND status='pending' FOR UPDATE`,
    [studentId, subjectId, stageSeasonId])).rows[0];
    if (existing && existing.from_mode === row.mode) {
      await c.query('COMMIT');
      return { request: { ...existing, subject_name: row.subject_name }, created: false };
    }
    // طلب قديم لم يعد يوافق النمط الحالي (غيّره الأدمن مثلًا) يُلغى ويُنشأ طلب جديد.
    if (existing) await c.query("UPDATE participation_change_requests SET status='cancelled',decided_at=now() WHERE id=$1", [existing.id]);
    const request = (await c.query(`INSERT INTO participation_change_requests(student_id,subject_id,stage_season_id,from_mode,to_mode)
      VALUES($1,$2,$3,$4,$5) RETURNING *`, [studentId, subjectId, stageSeasonId, row.mode, OPPOSITE_MODE[row.mode]])).rows[0];
    await c.query('COMMIT');
    return { request: { ...request, subject_name: row.subject_name }, created: true };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const getParticipationChangeRequest = (id) => pool.query(`SELECT r.*, st.full_name, st.telegram_id,
    COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name, sub.name AS subject_name
  FROM participation_change_requests r
  JOIN students st ON st.id=r.student_id
  JOIN subjects sub ON sub.id=r.subject_id
  JOIN stage_seasons ss ON ss.id=r.stage_season_id
  JOIN stages sg ON sg.id=ss.stage_id
  WHERE r.id=$1`, [id]).then((r) => r.rows[0]);

const listPendingParticipationChanges = (studentId) => pool.query(
  `SELECT * FROM participation_change_requests WHERE student_id=$1 AND status='pending' ORDER BY id`, [studentId]
).then((r) => r.rows);

const cancelParticipationChange = (id, studentId) => pool.query(
  `UPDATE participation_change_requests SET status='cancelled', decided_at=now()
   WHERE id=$1 AND student_id=$2 AND status='pending' RETURNING *`, [id, studentId]
).then((r) => r.rows[0]);

// قرار الإدارة: يُحسم الطلب ذريًا مرة واحدة فقط. null = عولج سابقًا أو ألغاه الطالب.
// stale = تغيّر نمط الطالب قبل الاعتماد فلم يُنفَّذ شيء.
async function decideParticipationChange(id, approve, actorId) {
  positiveInt(id);
  const claimed = (await pool.query(`UPDATE participation_change_requests
    SET status=$2, decided_at=now(), decided_by=$3 WHERE id=$1 AND status='pending' RETURNING *`,
  [id, approve ? 'approved' : 'rejected', actorId])).rows[0];
  if (!claimed) return null;
  if (!approve) return { request: claimed, applied: false };
  try {
    await changeParticipationMode(claimed.student_id, claimed.subject_id, claimed.stage_season_id, claimed.to_mode,
      { actorId, expectedMode: claimed.from_mode });
    return { request: claimed, applied: true };
  } catch (e) {
    if (e.code === 'CONFLICT') {
      await pool.query("UPDATE participation_change_requests SET status='cancelled' WHERE id=$1", [id]);
      return { request: { ...claimed, status: 'cancelled' }, applied: false, stale: true, reason: e.message };
    }
    await pool.query("UPDATE participation_change_requests SET status='pending',decided_at=NULL,decided_by=NULL WHERE id=$1", [id]).catch(() => {});
    throw e;
  }
}

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
  positiveInt(capacity, 'سعة المجموعة');
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  const setting=(await client.query('SELECT discussion_grouping FROM stage_seasons WHERE id=$1 FOR SHARE',[stageSeasonId])).rows[0];
  if(setting?.discussion_grouping===false)throw appError('هذه المرحلة تعمل دون تقسيم. عدّل رابط مباحثة المادة من إعدادات المرحلة.');
  await client.query('SELECT pg_advisory_xact_lock(734222,$1::int)',[stageSeasonId]);
  // Serialize numbering for this subject/season; MAX+1 alone races.
  await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [subjectId, stageSeasonId]);
  const valid = await client.query(`SELECT 1 FROM subjects sub JOIN stage_seasons ss ON ss.stage_id=sub.stage_id
    JOIN stages st ON st.id=ss.stage_id
    WHERE sub.id=$1 AND ss.id=$2 AND ss.is_active=true AND participation_enabled(sub.id,ss.id)`, [subjectId, stageSeasonId]);
  if (!valid.rows[0]) throw appError('المادة أو الموسم غير متاح للمباحثات.');
  const next = await client.query(
    'SELECT COALESCE(MAX(group_number),0)+1 AS n FROM mubahatha_groups WHERE subject_id=$1 AND stage_season_id=$2',
    [subjectId, stageSeasonId]
  );
  const number = Number(next.rows[0].n);
  const reserved=Number((await client.query('SELECT group_reserved_count($1,$2) AS n',[stageSeasonId,number])).rows[0].n);
  if(capacity<reserved)throw appError(`السعة ${capacity} أقل من ${reserved} مقعدًا محجوزًا مسبقًا للمجموعة رقم ${number} عبر مواد المرحلة.`,'GROUP_CAPACITY',409);
  const group = await client
    .query(
      `INSERT INTO mubahatha_groups(subject_id, stage_season_id, group_number, title, invite_link, telegram_chat_id, capacity)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [subjectId, stageSeasonId, number, title || `المجموعة ${number}`, inviteLink, chatId, capacity]
    )
    .then((r) => r.rows[0]);
  await client.query('COMMIT');
  return group;
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

const getGroupById = (groupId) =>
  pool.query('SELECT g.*,discussion_group_label(g.id) AS title FROM mubahatha_groups g WHERE g.id=$1', [groupId]).then((r) => r.rows[0]);

const listGroups = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT g.*,ss.discussion_grouping, discussion_group_label(g.id) AS title, (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) AS member_count,
         group_reserved_count(g.stage_season_id,g.group_number) AS reserved_count
       FROM mubahatha_groups g JOIN stage_seasons ss ON ss.id=g.stage_season_id
       WHERE g.subject_id=$1 AND g.stage_season_id=$2 AND g.merged_into_id IS NULL
       ORDER BY g.group_number`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

const setGroupCapacity = (groupId, capacity) => updateGroupSettings(groupId,{capacity});

// Validate all fields first; a bad link must not partially change capacity.
async function updateGroupSettings(groupId,body) {
  positiveInt(groupId);
  if(body.capacity!==undefined&&positiveInt(body.capacity)>10000)throw appError('السعة لا تتجاوز 10000 طالب.');
  if(body.inviteLink!==undefined&&body.inviteLink!==null&&
    (typeof body.inviteLink!=='string'||(body.inviteLink&&!/^https:\/\/t\.me\/[A-Za-z0-9_+/?=-]+$/.test(body.inviteLink))))throw appError('رابط المجموعة يجب أن يكون رابط تليجرام https://t.me/');
  if(body.active!==undefined&&typeof body.active!=='boolean')throw appError('حالة المجموعة غير صالحة.');
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    const origin=(await c.query('SELECT stage_season_id FROM mubahatha_groups WHERE id=$1',[groupId])).rows[0];
    if(!origin)throw appError('المجموعة غير موجودة.','NOT_FOUND',404);
    const season=(await c.query('SELECT discussion_grouping FROM stage_seasons WHERE id=$1 FOR SHARE',[origin.stage_season_id])).rows[0];
    await c.query('SELECT pg_advisory_xact_lock(734222,$1::int)',[origin.stage_season_id]);
    const before=(await c.query('SELECT * FROM mubahatha_groups WHERE id=$1 FOR UPDATE',[groupId])).rows[0];
    if(!before)throw appError('المجموعة غير موجودة.','NOT_FOUND',404);
    if(before.merged_into_id)throw appError('هذه مجموعة سابقة مدمجة؛ سجلها محفوظ ولا يمكن إعادة تفعيلها.');
    if((body.capacity!==undefined&&Number(body.capacity)<before.capacity)||(body.active===true&&!before.is_active)){
      const n=Number((await c.query('SELECT COUNT(*) AS n FROM group_memberships WHERE group_id=$1',[groupId])).rows[0].n);
      const reserved=season?.discussion_grouping?Number((await c.query('SELECT group_reserved_count($1,$2) AS n',[before.stage_season_id,before.group_number])).rows[0].n):0;
      const required=Math.max(n,reserved);
      if(Number(body.capacity??before.capacity)<required)throw appError(`لا يمكن خفض السعة دون عدد المقاعد المحجوزة للمجموعة (${required}).`,'GROUP_CAPACITY');
    }
    const result=(await c.query(`UPDATE mubahatha_groups SET capacity=$2,invite_link=$3,is_active=$4 WHERE id=$1 RETURNING *`,
      [groupId,body.capacity??before.capacity,body.inviteLink===undefined?before.invite_link:body.inviteLink||null,body.active??before.is_active])).rows[0];
    await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

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
       WHERE pm.subject_id=$1 AND pm.stage_season_id=$2 AND pm.mode IN ('mubahatha','report')
         AND EXISTS(SELECT 1 FROM enrollments en WHERE en.student_id=st.id AND en.stage_season_id=$2 AND en.status='active')
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

// تعطيل/إعادة تفعيل مجموعة مباحثة دون حذف سجلاتها (حضور، مواعيد، تقارير).
const setGroupActive = (groupId, active) =>
  pool
    .query('UPDATE mubahatha_groups SET is_active=$2 WHERE id=$1 AND merged_into_id IS NULL RETURNING *', [groupId, active])
    .then((r) => r.rows[0]);

const getStudentGroup = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT g.*, discussion_group_label(g.id) AS title, m.assigned_at FROM group_memberships m
       JOIN mubahatha_groups g ON g.id=m.group_id
       WHERE m.student_id=$1 AND m.subject_id=$2 AND m.stage_season_id=$3`,
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

// رقم موحد للطالب في جميع مواد المرحلة والموسم.
const {assignStudentToGroup,moveStudentToGroup}=require('./groupAllocation').createGroupAllocation(pool);

// ---------------------------------------------------------------------------
// جلسات المباحثة
// ---------------------------------------------------------------------------
async function openSession(groupId,teacherId,title,hours=24){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const group=(await c.query(`SELECT g.id FROM mubahatha_groups g JOIN stage_seasons ss ON ss.id=g.stage_season_id
      WHERE g.id=$1 AND g.is_active=true AND ss.is_active=true AND participation_enabled(g.subject_id,ss.id) FOR SHARE OF ss`,[groupId])).rows[0];
    if(!group)throw appError('هذه المادة غير متاحة للمباحثات أو المجموعة غير نشطة.');
    const result=(await c.query(`INSERT INTO mubahatha_sessions(group_id,teacher_id,title,closes_at)
      VALUES($1,$2,$3,now()+make_interval(hours=>$4::int)) RETURNING *`,[groupId,teacherId,title,hours])).rows[0];
    await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

const closeSession = (sessionId) =>
  pool
    .query('UPDATE mubahatha_sessions SET is_closed=true WHERE id=$1 RETURNING *', [sessionId])
    .then((r) => r.rows[0]);

const listGroupSessions = (groupId) =>
  pool
    .query(
      `SELECT s.*, (SELECT COUNT(*) FROM (
          SELECT student_id FROM mubahatha_attendance a WHERE a.session_id=s.id GROUP BY student_id
          HAVING bool_or(phase='start') AND bool_or(phase='end')
        ) complete_students) AS attended_count
       FROM mubahatha_sessions s WHERE s.group_id=$1 ORDER BY s.opened_at DESC`,
      [groupId]
    )
    .then((r) => r.rows);

// مصدر موحد لحضور المباحثات في لوحة الأستاذ وأزرار البوت.
// تحسب الجلسات التي كان الطالب مؤهلًا لها فقط، ويكتمل الحضور بالبداية والنهاية معًا.
const listDiscussionAttendanceForTeacher = (subjectId, stageSeasonId) =>
  pool.query(`
    WITH memberships AS (
      SELECT student_id,subject_id,stage_season_id,group_id,assigned_at,NULL::timestamp AS ended_at
      FROM group_memberships
      UNION ALL
      SELECT student_id,subject_id,stage_season_id,group_id,assigned_at,ended_at
      FROM group_membership_history
    )
    SELECT st.id AS student_id,st.full_name,pm.mode,
           current_group.group_id,discussion_group_label(current_group.group_id) AS group_title,
           (SELECT COUNT(*) FROM student_reports r WHERE r.student_id=st.id AND r.subject_id=pm.subject_id
             AND r.stage_season_id=pm.stage_season_id) AS report_count,
           COUNT(DISTINCT ms.id) AS eligible_sessions,
           COUNT(DISTINCT ms.id) FILTER (
             WHERE start_att.id IS NOT NULL AND end_att.id IS NOT NULL
           ) AS attended_sessions,
           COUNT(DISTINCT ms.id) FILTER (
             WHERE start_att.id IS NOT NULL AND end_att.id IS NULL
           ) AS incomplete_sessions
    FROM participation_modes pm
    JOIN students st ON st.id=pm.student_id AND st.is_active=true
    JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=pm.stage_season_id AND e.status='active'
    LEFT JOIN group_memberships current_group ON current_group.student_id=st.id
      AND current_group.subject_id=pm.subject_id AND current_group.stage_season_id=pm.stage_season_id
    LEFT JOIN memberships gm ON gm.student_id=pm.student_id AND gm.subject_id=pm.subject_id
      AND gm.stage_season_id=pm.stage_season_id
    LEFT JOIN mubahatha_sessions ms ON ms.group_id=gm.group_id
      AND ms.opened_at>=gm.assigned_at AND (gm.ended_at IS NULL OR ms.opened_at<gm.ended_at)
      AND was_in_mubahatha(pm.student_id,pm.subject_id,pm.stage_season_id,ms.opened_at)
    LEFT JOIN mubahatha_attendance start_att ON start_att.session_id=ms.id
      AND start_att.student_id=pm.student_id AND start_att.phase='start'
    LEFT JOIN mubahatha_attendance end_att ON end_att.session_id=ms.id
      AND end_att.student_id=pm.student_id AND end_att.phase='end'
    WHERE pm.subject_id=$1 AND pm.stage_season_id=$2
    GROUP BY st.id,st.full_name,pm.mode,pm.subject_id,pm.stage_season_id,current_group.group_id
    ORDER BY current_group.group_id,st.full_name,st.id`, [subjectId, stageSeasonId]).then((r) => r.rows);

const getOpenSessionForGroup = (groupId) =>
  pool
    .query(
      `SELECT * FROM mubahatha_sessions
       WHERE group_id=$1 AND is_closed=false AND closes_at > now()
       ORDER BY opened_at DESC LIMIT 1`,
      [groupId]
    )
    .then((r) => r.rows[0]);

const markSessionAttendance = (sessionId, studentId, phase = 'start', markedBy = 'student') =>
  pool
    .query(
      `INSERT INTO mubahatha_attendance(session_id, student_id, phase, marked_by)
       SELECT s.id, st.id, $3, $4 FROM mubahatha_sessions s
       JOIN mubahatha_groups g ON g.id=s.group_id AND g.is_active=true
       JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
       JOIN group_memberships m ON m.group_id=g.id AND m.student_id=$2
       JOIN students st ON st.id=m.student_id AND st.is_active=true
       JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=ss.id AND e.status='active'
       JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=g.subject_id
         AND pm.stage_season_id=ss.id AND pm.mode='mubahatha'
       WHERE s.id=$1 AND participation_enabled(g.subject_id,g.stage_season_id) AND s.opened_at <= now() AND m.assigned_at <= s.opened_at
         AND pm.joined_mubahatha_at <= s.opened_at
         AND ((s.attendance_reopened_at <= now() AND s.attendance_reopen_until > now() AND $3 IN ('start','end'))
           OR (s.attendance_reopened_at IS NULL AND (($3='start'
               AND s.opened_at + make_interval(mins => $5::int) <= now()
               AND s.closes_at > now())
           OR ($3='end' AND s.end_opened_at <= now() AND s.end_closes_at > now()))))
       ON CONFLICT (session_id, student_id, phase) DO NOTHING RETURNING *`,
      [sessionId, studentId, phase, markedBy, START_ATTENDANCE_DELAY_MINUTES]
    )
    .then((r) => r.rows[0]);

// عند عدم إنهاء الأستاذ للمباحثة يفتح حضور النهاية تلقائيًا قبل نهاية الساعة
// بعشر دقائق افتراضيًا. وإذا أنهى الأستاذ يدويًا بعد فتح الحضور الأول، يفتح
// الحضور الثاني فورًا. في الحالتين يبقى الحضور الثاني متاحًا إلى نهاية الساعة
// الأصلية فقط (مثال 16:00 -> متاح حتى 16:59:59، ويغلق عند 17:00).
const END_ATTENDANCE_MINUTES = Number(process.env.END_ATTENDANCE_MINUTES || 10);
if (!Number.isInteger(END_ATTENDANCE_MINUTES) || END_ATTENDANCE_MINUTES < 1 || END_ATTENDANCE_MINUTES > 60 - START_ATTENDANCE_DELAY_MINUTES) {
  throw new Error(`END_ATTENDANCE_MINUTES must be an integer from 1 to ${60 - START_ATTENDANCE_DELAY_MINUTES}`);
}

async function openEndAttendance(sessionId, automatic = false) {
  const r = await pool.query(
    `UPDATE mubahatha_sessions
     SET end_opened_at = now(),
         end_closes_at = closes_at,
         is_closed = true
     WHERE id=$1 AND end_opened_at IS NULL AND is_closed=false
       AND attendance_reopened_at IS NULL
       AND start_notifications_queued=true
       AND opened_at + make_interval(mins => $4::int) <= now()
       AND closes_at > now()
       AND (NOT $3 OR closes_at - make_interval(mins => $2::int) <= now())
       AND EXISTS (SELECT 1 FROM mubahatha_groups g JOIN stage_seasons ss ON ss.id=g.stage_season_id
         WHERE g.id=mubahatha_sessions.group_id AND g.is_active=true AND ss.is_active=true)
     RETURNING *`,
    [sessionId, END_ATTENDANCE_MINUTES, automatic, START_ATTENDANCE_DELAY_MINUTES]
  );
  return r.rows[0]; // null إن كان مفتوحًا مسبقًا
}

const isStartAttendanceOpen = (sessionId) =>
  pool
    .query(
      `SELECT 1 FROM mubahatha_sessions
       WHERE id=$1
         AND ((attendance_reopened_at <= now() AND attendance_reopen_until > now())
           OR (attendance_reopened_at IS NULL AND opened_at + make_interval(mins => $2::int) <= now()
             AND closes_at > now()))`,
      [sessionId, START_ATTENDANCE_DELAY_MINUTES]
    )
    .then((r) => Boolean(r.rows[0]));

// هل حضور النهاية مفتوح الآن لهذه الجلسة؟
const isEndAttendanceOpen = (sessionId) =>
  pool
    .query(
      `SELECT 1 FROM mubahatha_sessions
       WHERE id=$1 AND ((attendance_reopened_at <= now() AND attendance_reopen_until > now())
         OR (attendance_reopened_at IS NULL AND end_opened_at <= now() AND end_closes_at > now()))`,
      [sessionId]
    )
    .then((r) => Boolean(r.rows[0]));

// الجلسات التي حان تنبيه أستاذها بقرب فتح الحضور الثاني (قبل الإغلاق بـ leadMinutes) ولم يُنبَّه.
const getSessionsNeedingEndPrompt = (leadMinutes = 10) =>
  pool
    .query(
      `SELECT s.*, g.subject_id, discussion_group_label(g.id) AS group_title, g.group_number,
              t.telegram_id AS teacher_telegram_id, sub.name AS subject_name
       FROM mubahatha_sessions s
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN subjects sub ON sub.id=g.subject_id
       JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
       LEFT JOIN teachers t ON t.id=s.teacher_id AND t.is_active=true
       WHERE s.is_closed=false AND s.end_prompt_sent=false
         AND s.attendance_reopened_at IS NULL
         AND s.closes_at > now()
         AND s.closes_at - make_interval(mins => $1::int) <= now()`,
      [leadMinutes]
    )
    .then((r) => r.rows);

const markEndPromptSent = (sessionId) =>
  pool.query('UPDATE mubahatha_sessions SET end_prompt_sent=true WHERE id=$1', [sessionId]);

// الجلسات التي دخلت آخر عشر دقائق ولم يفتح الأستاذ حضورها الثاني — يُفتح تلقائيًا.
const getSessionsNeedingAutoEnd = () =>
  pool
    .query(
      `SELECT s.*, g.id AS gid, discussion_group_label(g.id) AS group_title, g.group_number,
              sub.name AS subject_name
       FROM mubahatha_sessions s
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN subjects sub ON sub.id=g.subject_id
       JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
       WHERE s.end_opened_at IS NULL AND s.is_closed=false AND s.start_notifications_queued=true AND g.is_active=true
         AND s.attendance_reopened_at IS NULL
         AND s.closes_at - make_interval(mins => $1::int) <= now()
         AND s.closes_at > now()`,
      [END_ATTENDANCE_MINUTES]
    )
    .then((r) => r.rows);

// إذا كان المجدول متوقفًا أثناء نافذة 16:50–17:00 ثم عاد بعد الإغلاق،
// لا نمدد الحضور خارج الساعة الأصلية: نغلق الجلسة المنتهية فقط حتى لا تبقى معلقة.
const closeExpiredSessionsWithoutEnd = () =>
  pool
    .query(
      `UPDATE mubahatha_sessions s SET is_closed=true
       WHERE s.is_closed=false AND s.end_opened_at IS NULL AND s.closes_at <= now()
       RETURNING s.id`
    )
    .then((r) => r.rows);

// ---------------------------------------------------------------------------
// الامتحانات
// ---------------------------------------------------------------------------
// أيام الأسبوع القادم لعرضها على الأستاذ (اليوم + 7 أيام)، والبوت يحوّل الاختيار إلى تاريخ.
const WEEKDAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function upcomingWeekDays(from = new Date()) {
  const days = [];
  const local=new Intl.DateTimeFormat('en-CA',{timeZone:SCHEDULE_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(from);
  const part=t=>local.find(p=>p.type===t).value;
  const base=new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    days.push({
      iso: d.toISOString().slice(0, 10),
      label: `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.toISOString().slice(0, 10)}`,
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
  const examTitle = typeof title === 'string' && title.trim()
    ? title.trim()
    : `الامتحان الشهري ${n}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO exams(subject_id, stage_season_id, teacher_id, exam_number, title,
                         opens_at, available_hours, closes_at, max_score)
       VALUES($1,$2,$3,$4,$5,
              (($6::date + make_interval(hours => $9::int)) AT TIME ZONE $10) AT TIME ZONE 'UTC',
              $7::int,
              (($6::date + make_interval(hours => $9::int)) AT TIME ZONE $10) AT TIME ZONE 'UTC'
                + make_interval(hours => $7::int),
              $8)
       RETURNING *`,
      [subjectId, stageSeasonId, teacherId, n, examTitle, dateIso, h, GRADE_WEIGHTS.examEach, EXAM_START_HOUR, SCHEDULE_TZ]
    );
    const exam = r.rows[0];
    const subject = (await client.query('SELECT name FROM subjects WHERE id=$1', [subjectId])).rows[0];
    const subjectName = subject?.name || 'المادة';
    const opensText = new Date(exam.opens_at).toLocaleString('ar-IQ', {
      timeZone: SCHEDULE_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const text =
      `📢 لديك امتحان مجدول في مادة «${subjectName}».\n` +
      `📚 الموضوع: «${examTitle}».\n` +
      `🗓 الموعد: ${opensText}.\n` +
      `⏳ مدة الإتاحة: ${h} ساعة.\n\n` +
      'سيظهر الامتحان تلقائيًا في «📝 الامتحانات الشهرية» عند حلول الموعد.';
    // إشعار واحد فور إنشاء الامتحان. نستخدم نفس مفتاح النشر لمنع أي إشعار مكرر لاحقًا.
    await client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
      SELECT 'exam:'||$1::text||':'||st.id::text,st.telegram_id,$2::jsonb,$3 FROM enrollments en
      JOIN students st ON st.id=en.student_id AND st.is_active=true
      WHERE en.stage_season_id=$4 AND en.status='active' ON CONFLICT DO NOTHING`,
      [exam.id, JSON.stringify([text, {}]), exam.closes_at, stageSeasonId]);
    await client.query('COMMIT');
    return exam;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const e = new Error(`الامتحان الشهري رقم ${n} موجود مسبقًا لهذه المادة في هذا الموسم.`);
      e.code = 'EXAM_EXISTS';
      throw e;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function addExamQuestion(examId, { type, prompt, options, correct }) {
  if (!['tf', 'mcq'].includes(type)) throw new Error('نوع السؤال يجب أن يكون tf أو mcq.');
  if(typeof prompt!=='string'||prompt.trim().length<3||prompt.length>3000)throw appError('نص السؤال يجب أن يكون بين 3 و3000 حرف.');
  const answers=type==='tf'?['صح','خطأ']:options;
  if(!Array.isArray(answers)||answers.length<2||answers.length>6||new Set(answers).size!==answers.length||!answers.includes(correct)||answers.some(x=>typeof x!=='string'||!x.trim()||x.length>300))throw appError('الخيارات أو الإجابة الصحيحة غير صالحة.');
  const client=await pool.connect();
  try{
  await client.query('BEGIN');
  const exam = await client.query('SELECT status FROM exams WHERE id=$1 FOR UPDATE', [examId]).then((r) => r.rows[0]);
  if (!exam) throw new Error('الامتحان غير موجود.');
  if(exam.status==='cancelled')throw appError('الامتحان ملغى؛ يبقى سجله محفوظًا.','CONFLICT',409);
  if((await client.query('SELECT 1 FROM exam_attempts WHERE exam_id=$1 LIMIT 1',[examId])).rowCount)
    throw appError('بدأ أحد الطلبة الامتحان؛ لا يمكن تعديل أسئلته.','ALREADY_TAKEN',409);
  const pos = await client
    .query('SELECT COALESCE(MAX(position),0)+1 AS n FROM exam_questions WHERE exam_id=$1', [examId])
    .then((r) => Number(r.rows[0].n));
  const result=await client
    .query(
      `INSERT INTO exam_questions(exam_id, position, question_type, prompt, options, correct_answer)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [examId, pos, type, prompt, options ? JSON.stringify(options) : null, String(correct)]
    )
    .then((r) => r.rows[0]);
  await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

const listExamQuestions = (examId) =>
  pool
    .query('SELECT * FROM exam_questions WHERE exam_id=$1 ORDER BY position', [examId])
    .then((r) => r.rows);

async function deleteExamQuestion(questionId) {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const exam=(await c.query('SELECT e.* FROM exams e JOIN exam_questions q ON q.exam_id=e.id WHERE q.id=$1 FOR UPDATE OF e',[questionId])).rows[0];
    if(!exam)throw appError('السؤال غير موجود.','NOT_FOUND',404);
    if(exam.status==='cancelled')throw appError('الامتحان ملغى؛ يبقى سجله محفوظًا.','CONFLICT',409);
    if((await c.query('SELECT 1 FROM exam_attempts WHERE exam_id=$1 LIMIT 1',[exam.id])).rowCount)
      throw appError('بدأ أحد الطلبة الامتحان؛ لا يمكن تعديل أسئلته.','ALREADY_TAKEN',409);
    if(exam.status==='published'&&Number((await c.query('SELECT COUNT(*) AS n FROM exam_questions WHERE exam_id=$1',[exam.id])).rows[0].n)===1)
      throw appError('أضف سؤالًا بديلًا قبل حذف آخر سؤال من الامتحان المنشور.','LAST_QUESTION',409);
    const r=await c.query('DELETE FROM exam_questions WHERE id=$1 RETURNING id',[questionId]);
    await c.query('COMMIT');return r.rowCount>0;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

async function updateExamQuestion(questionId,{type,prompt,options,correct}){
  if(!['tf','mcq'].includes(type))throw appError('نوع السؤال غير صالح.');
  if(typeof prompt!=='string'||prompt.trim().length<3||prompt.length>3000)throw appError('نص السؤال يجب أن يكون بين 3 و3000 حرف.');
  const answers=type==='tf'?['صح','خطأ']:options;
  if(!Array.isArray(answers)||answers.length<2||answers.length>6||new Set(answers).size!==answers.length||
    !answers.includes(correct)||answers.some(x=>typeof x!=='string'||!x.trim()||x.length>300))
    throw appError('الخيارات أو الإجابة الصحيحة غير صالحة.');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const exam=(await c.query('SELECT e.id,e.status FROM exams e JOIN exam_questions q ON q.exam_id=e.id WHERE q.id=$1 FOR UPDATE OF e',[questionId])).rows[0];
    if(!exam)throw appError('السؤال غير موجود.','NOT_FOUND',404);
    if(exam.status==='cancelled')throw appError('الامتحان ملغى؛ يبقى سجله محفوظًا.','CONFLICT',409);
    if((await c.query('SELECT 1 FROM exam_attempts WHERE exam_id=$1 LIMIT 1',[exam.id])).rowCount)
      throw appError('بدأ أحد الطلبة الامتحان؛ لا يمكن تعديل أسئلته.','ALREADY_TAKEN',409);
    const result=(await c.query(`UPDATE exam_questions SET question_type=$2,prompt=$3,options=$4::jsonb,correct_answer=$5
      WHERE id=$1 RETURNING *`,[questionId,type,prompt.trim(),type==='mcq'?JSON.stringify(options):null,correct])).rows[0];
    await c.query('COMMIT');return result;
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}

async function updateExam(examId,{title,dateIso,hours}){
  if(typeof title!=='string'||title.trim().length<3||title.trim().length>150)throw appError('عنوان الامتحان يجب أن يكون بين 3 و150 حرفًا.');
  const parsedDate=new Date(`${dateIso}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dateIso||'')||Number.isNaN(parsedDate.getTime())||parsedDate.toISOString().slice(0,10)!==dateIso)
    throw appError('تاريخ الامتحان غير صالح.');
  const h=Number(hours);
  if(!Number.isInteger(h)||h<1||h>720)throw appError('مدة الإتاحة يجب أن تكون بين 1 و720 ساعة.');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const before=(await c.query(`SELECT e.* FROM exams e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      WHERE e.id=$1 FOR UPDATE OF e`,[examId])).rows[0];
    if(!before)throw appError('الامتحان غير موجود أو موسمه غير نشط.','NOT_FOUND',404);
    if(before.status==='cancelled')throw appError('الامتحان ملغى؛ يبقى سجله محفوظًا.','CONFLICT',409);
    if((await c.query('SELECT 1 FROM exam_attempts WHERE exam_id=$1 LIMIT 1',[examId])).rowCount)
      throw appError('بدأ أحد الطلبة الامتحان؛ لا يمكن تعديله.','ALREADY_TAKEN',409);
    const result=(await c.query(`UPDATE exams SET title=$2,
      opens_at=(($3::date+make_interval(hours=>$5::int)) AT TIME ZONE $6) AT TIME ZONE 'UTC',
      closes_at=((($3::date+make_interval(hours=>$5::int)) AT TIME ZONE $6) AT TIME ZONE 'UTC')+make_interval(hours=>$4::int),
      available_hours=$4::int WHERE id=$1 RETURNING *`,[examId,title.trim(),dateIso,h,EXAM_START_HOUR,SCHEDULE_TZ])).rows[0];
    const changed=before.title!==result.title||new Date(before.opens_at).getTime()!==new Date(result.opens_at).getTime()||Number(before.available_hours)!==h;
    if(changed){
      await c.query(`UPDATE notification_outbox SET status='expired' WHERE dedupe_key LIKE $1 AND status='pending'`,[`exam:${examId}:%`]);
      const message=`📝 تم تعديل الامتحان «${result.title}».\nيفتح: ${new Date(result.opens_at).toLocaleString('ar-IQ',{timeZone:SCHEDULE_TZ})}\nمدة الإتاحة: ${h} ساعة.`;
      await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
        SELECT $1||':'||st.id::text,st.telegram_id,$2::jsonb,$3 FROM enrollments en JOIN students st ON st.id=en.student_id AND st.is_active=true
        WHERE en.stage_season_id=$4 AND en.status='active' ON CONFLICT DO NOTHING`,
        [`exam-edit:${examId}:${Date.now()}`,JSON.stringify([message,{}]),result.closes_at,result.stage_season_id]);
    }
    await c.query('COMMIT');return result;
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}

async function deleteExam(examId){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const exam=(await c.query(`SELECT e.* FROM exams e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      WHERE e.id=$1 FOR UPDATE OF e`,[examId])).rows[0];
    if(!exam)throw appError('الامتحان غير موجود أو موسمه غير نشط.','NOT_FOUND',404);
    if(exam.status==='cancelled')throw appError('الامتحان ملغى؛ يبقى سجله محفوظًا.','CONFLICT',409);
    if((await c.query('SELECT 1 FROM exam_attempts WHERE exam_id=$1 LIMIT 1',[examId])).rowCount)
      throw appError('بدأ أحد الطلبة الامتحان؛ لا يمكن حذفه وسجلاته.','ALREADY_TAKEN',409);
    await c.query(`UPDATE notification_outbox SET status='expired' WHERE status='pending' AND
      (dedupe_key LIKE $1 OR dedupe_key LIKE $2 OR dedupe_key LIKE $3)`,
      [`exam:${examId}:%`,`exam-edit:${examId}:%`,`exam-postpone:${examId}:%`]);
    await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload)
      SELECT 'exam-cancel:'||$1::text||':'||st.id::text,st.telegram_id,$2::jsonb
      FROM enrollments en JOIN students st ON st.id=en.student_id AND st.is_active=true
      WHERE en.stage_season_id=$3 AND en.status='active' ON CONFLICT DO NOTHING`,
      [examId,JSON.stringify([`أُلغي الامتحان «${exam.title||'الشهري '+exam.exam_number}» ولم يعد متاحًا.`,{}]),exam.stage_season_id]);
    await c.query('DELETE FROM exams WHERE id=$1',[examId]);
    await c.query('COMMIT');return {deleted:true};
  }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}

async function getExamsReadyToAutoPublish(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return pool.query(
    `SELECT e.id FROM exams e
     JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
     WHERE e.status='draft'
       AND e.opens_at<=now()
       AND e.closes_at>now()
       AND EXISTS (SELECT 1 FROM exam_questions q WHERE q.exam_id=e.id)
     ORDER BY e.opens_at,e.id
     LIMIT $1`,
    [safeLimit]
  ).then(r=>r.rows);
}

async function publishExam(examId) {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const exam=(await c.query(`SELECT e.*,sub.name AS subject_name FROM exams e JOIN subjects sub ON sub.id=e.subject_id
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true WHERE e.id=$1 FOR UPDATE OF e`,[examId])).rows[0];
    if(!exam||exam.status!=='draft')throw appError('الامتحان منشور مسبقًا أو موسمه غير نشط.','CONFLICT',409);
    const count=Number((await c.query('SELECT COUNT(*) AS n FROM exam_questions WHERE exam_id=$1',[examId])).rows[0].n);
    if(!count)throw appError('لا يمكن نشر امتحان بلا أسئلة.','NO_QUESTIONS');
    if(new Date(exam.closes_at)<=new Date())throw appError('انتهى موعد الامتحان. غيّر الموعد أولًا.');
    const result=(await c.query("UPDATE exams SET status='published',published_at=now() WHERE id=$1 RETURNING *",[examId])).rows[0];
    const text='📝 نُشر الامتحان الشهري '+exam.exam_number+' في مادة «'+exam.subject_name+'».\nيفتح: '+new Date(exam.opens_at).toLocaleString('ar-IQ',{timeZone:SCHEDULE_TZ})+'\nمدة الإتاحة: '+exam.available_hours+' ساعة. ستجده في «📝 الامتحانات الشهرية» عند فتحه.';
    await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
      SELECT 'exam:'||$1::text||':'||st.id::text,st.telegram_id,$2::jsonb,$3 FROM enrollments en
      JOIN students st ON st.id=en.student_id AND st.is_active=true
      WHERE en.stage_season_id=$4 AND en.status='active' ON CONFLICT DO NOTHING`,[examId,JSON.stringify([text,{}]),exam.closes_at,exam.stage_season_id]);
    await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

const getExamById = (examId) =>
  pool
    .query(
      `SELECT e.*, sub.name AS subject_name,
              (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS question_count,
              (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id=e.id) AS attempt_count
       FROM exams e JOIN subjects sub ON sub.id=e.subject_id WHERE e.id=$1`,
      [examId]
    )
    .then((r) => r.rows[0]);

const listExamsForSubject = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT e.*, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id=e.id) AS question_count,
              (SELECT COUNT(*) FROM exam_attempts a WHERE a.exam_id=e.id AND a.submitted_at IS NOT NULL) AS submitted_count
        FROM exams e WHERE e.subject_id=$1 AND e.stage_season_id=$2 ORDER BY e.exam_number,e.created_at,e.id`,
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
       JOIN stage_seasons ss ON ss.id=e.stage_season_id
       JOIN students st ON st.id=en.student_id
       LEFT JOIN exam_attempts a ON a.exam_id=e.id AND a.student_id=$1
       WHERE e.status='published' AND ${enrollmentSql} AND ${examWindowSql('e','$1')}
         AND a.submitted_at IS NULL
       ORDER BY e.closes_at`,
      [studentId]
    )
    .then((r) => r.rows);

// بدء المحاولة أو استئنافها (لا تُنشأ محاولة ثانية أبدًا).

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

// التسليم: الدرجة نسبة الإجابات الصحيحة من 5، مهما كان عدد الأسئلة.

// تأجيل امتحان منشور إلى تاريخ جديد (ما لم يكن قد سلّمه أحد).
async function postponeExam(examId, newDateIso, hours) {
  const client=await pool.connect();
  try {
  await client.query('BEGIN');
   const original=(await client.query('SELECT id,status FROM exams WHERE id=$1 FOR UPDATE',[examId])).rows[0];
   if(!original||original.status==='cancelled')throw appError('الامتحان غير موجود أو ملغى.','CONFLICT',409);
  const submitted = await client
    .query('SELECT COUNT(*) AS c FROM exam_attempts WHERE exam_id=$1', [examId])
    .then((r) => Number(r.rows[0].c));
  if (submitted > 0) {
    const err = new Error(`بدأ ${submitted} طالبًا هذا الامتحان، فلا يمكن تأجيله أو حذف إجاباتهم.`);
    err.code = 'ALREADY_TAKEN';
    throw err;
  }

  const h = Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > 720) {
    const err = new Error('عدد ساعات الإتاحة يجب أن يكون بين 1 و720.');
    err.code = 'BAD_HOURS';
    throw err;
  }
  const result=await client
    .query(
      `UPDATE exams SET
         original_opens_at = COALESCE(original_opens_at, opens_at),
         opens_at = (($2::date + make_interval(hours => $4::int)) AT TIME ZONE $5) AT TIME ZONE 'UTC',
         available_hours = $3::int,
         closes_at = (($2::date + make_interval(hours => $4::int)) AT TIME ZONE $5) AT TIME ZONE 'UTC'
                     + make_interval(hours => $3::int),
         postponed_count = postponed_count + 1
       WHERE id=$1 RETURNING *`,
      [examId, newDateIso, h, EXAM_START_HOUR, SCHEDULE_TZ]
    )
    .then((r) => r.rows[0]);
  if(result?.status==='published'){
    await client.query("UPDATE notification_outbox SET status='expired' WHERE dedupe_key LIKE $1 AND status='pending'",[`exam:${examId}:%`]);
    const message=`🕓 تغيّر موعد الامتحان «${result.title||'الشهري '+result.exam_number}».\nيفتح: ${new Date(result.opens_at).toLocaleString('ar-IQ',{timeZone:SCHEDULE_TZ})}\nمدة الإتاحة: ${h} ساعة.`;
    await client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
      SELECT $1||':'||st.id::text,st.telegram_id,$2::jsonb,$3 FROM enrollments en JOIN students st ON st.id=en.student_id AND st.is_active=true
      WHERE en.stage_season_id=$4 AND en.status='active' ON CONFLICT DO NOTHING`,[`exam-postpone:${examId}:${result.postponed_count}`,JSON.stringify([message,{}]),result.closes_at,result.stage_season_id]);
  }
  await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

// إلغاء آمن يحفظ الامتحان وأسئلته للتدقيق ويمنع البدء فيه، مع إشعار من وصلهم الإعلان.
async function cancelExam(examId, actorId, reason = '') {
  const note=String(reason||'').trim();
  if(note.length>500)throw appError('سبب الإلغاء طويل جدًا (الحد 500 حرف).');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const exam=(await client.query(`SELECT e.*,sub.name AS subject_name FROM exams e
      JOIN subjects sub ON sub.id=e.subject_id
      JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
      WHERE e.id=$1 FOR UPDATE OF e`,[examId])).rows[0];
    if(!exam||exam.status==='cancelled')throw appError('الامتحان غير موجود أو ملغى مسبقًا.','CONFLICT',409);
    const attempts=(await client.query('SELECT COUNT(*)::int AS n FROM exam_attempts WHERE exam_id=$1',[examId])).rows[0].n;
    if(attempts>0)throw appError('بدأ طلبة هذا الامتحان؛ لا يمكن إلغاء امتحان له محاولات محفوظة.','CONFLICT',409);
    await client.query(`UPDATE exams SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancellation_reason=$3
      WHERE id=$1`,[examId,actorId,note||null]);
    await client.query(`UPDATE notification_outbox SET status='expired'
      WHERE status='pending' AND (dedupe_key LIKE $1 OR dedupe_key LIKE $2)`,
      [`exam:${examId}:%`,`exam-postpone:${examId}:%`]);
    const message=`📢 أُلغي الامتحان الشهري ${exam.exam_number} في مادة «${exam.subject_name}»`+
      `، الموضوع: «${exam.title||'الامتحان الشهري'}».\nلا تدخل إلى الامتحان في موعده السابق.`+
      (note?`\nالسبب: ${note}`:'');
    const queued=await client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
      SELECT 'exam-cancel:'||$1::text||':'||targets.chat_id::text,targets.chat_id,$2::jsonb,
             now()+interval '7 days'
      FROM (
        SELECT DISTINCT st.telegram_id AS chat_id FROM enrollments en
        JOIN students st ON st.id=en.student_id AND st.is_active=true
        WHERE en.stage_season_id=$3 AND en.status='active'
        UNION
        SELECT DISTINCT o.chat_id FROM notification_outbox o
        WHERE o.dedupe_key LIKE $4 OR o.dedupe_key LIKE $5
      ) targets
      ON CONFLICT DO NOTHING`,[examId,JSON.stringify([message,{}]),exam.stage_season_id,
        `exam:${examId}:%`,`exam-postpone:${examId}:%`]);
    await client.query('COMMIT');
    return {examId,recipientCount:queued.rowCount,subjectName:exam.subject_name,examNumber:exam.exam_number};
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
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
      `SELECT sl.*, sub.name AS subject_name, discussion_group_label(g.id) AS group_title
       FROM group_memberships m
       JOIN mubahatha_groups g ON g.id=m.group_id
       JOIN participation_modes pm ON pm.student_id=m.student_id AND pm.subject_id=m.subject_id
         AND pm.stage_season_id=m.stage_season_id AND pm.mode='mubahatha'
       JOIN schedule_slots sl ON sl.group_id=g.id AND sl.is_active=true
       JOIN subjects sub ON sub.id=sl.subject_id
       WHERE m.student_id=$1 AND participation_enabled(m.subject_id,m.stage_season_id)
         AND EXISTS(SELECT 1 FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true WHERE e.student_id=m.student_id AND e.stage_season_id=m.stage_season_id AND e.status='active')
       ORDER BY CASE WHEN sl.day_of_week=6 THEN 0 ELSE sl.day_of_week+1 END, sl.hour, sl.minute`,
      [studentId]
    )
    .then((r) => r.rows);

// مواد الطالب في موسمه النشط مع نمط مشاركته ومجموعته إن وُجدت.
const listStudentSubjects = (studentId, {includeDisabled=false}={}) =>
  pool
    .query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name,
              ss.id AS stage_season_id,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              pm.mode, pm.switched_at, participation_enabled(sub.id,ss.id) AS participation_enabled,
              g.id AS group_id, CASE WHEN ss.discussion_grouping THEN g.title ELSE 'المرحلة كاملة' END AS group_title,
              CASE WHEN ss.discussion_grouping THEN g.group_number END AS group_number, ss.discussion_grouping, g.invite_link,
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
       WHERE e.student_id=$1 AND e.status='active' AND ($2::boolean OR participation_enabled(sub.id,ss.id))
       ORDER BY sub.name`,
      [studentId,includeDisabled]
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
        (SELECT COUNT(DISTINCT pm.student_id) FROM participation_modes pm
         JOIN stage_seasons ss ON ss.id=pm.stage_season_id AND ss.is_active=true
         WHERE pm.mode='mubahatha' AND NOT EXISTS (
           SELECT 1 FROM group_memberships m WHERE m.student_id=pm.student_id
             AND m.subject_id=pm.subject_id AND m.stage_season_id=pm.stage_season_id
         )) AS unassigned_students,
        (SELECT COUNT(DISTINCT e.student_id) FROM enrollments e
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
        (SELECT COUNT(DISTINCT r2.student_id) FROM student_reports r2
         JOIN stage_seasons ss8 ON ss8.id=r2.stage_season_id AND ss8.is_active=true
         LEFT JOIN final_grades fg2 ON fg2.student_id=r2.student_id AND fg2.subject_id=r2.subject_id
              AND fg2.stage_season_id=r2.stage_season_id
         WHERE fg2.report_score IS NULL) AS ungraded_report_students,
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
      `SELECT m.subject_id, m.stage_season_id, g.id AS group_id, discussion_group_label(g.id) AS group_title, CASE WHEN ss.discussion_grouping THEN g.group_number END AS group_number,
              sub.name AS subject_name, pm.mode
       FROM group_memberships m
       JOIN mubahatha_groups g ON g.id=m.group_id
       JOIN subjects sub ON sub.id=m.subject_id
       JOIN stage_seasons ss ON ss.id=m.stage_season_id AND ss.is_active=true
       JOIN enrollments en ON en.student_id=m.student_id AND en.stage_season_id=m.stage_season_id AND en.status='active'
       LEFT JOIN participation_modes pm ON pm.student_id=m.student_id AND pm.subject_id=m.subject_id AND pm.stage_season_id=m.stage_season_id
       WHERE m.student_id=$1 AND participation_enabled(m.subject_id,m.stage_season_id)
       ORDER BY sub.name`,
      [studentId]
    )
    .then((r) => r.rows);

// إخراج الطالب من مجموعة المادة (يبقى مسجَّلًا في المرحلة).
async function removeStudentFromGroup(studentId, subjectId, stageSeasonId) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM students WHERE id=$1 FOR UPDATE',[studentId]);
    // Capture a consistent legacy cohort before its last membership is removed.
    await c.query(`INSERT INTO student_group_numbers(student_id,stage_season_id,group_number)
      SELECT $1,$2,MIN(g.group_number) FROM group_memberships m JOIN mubahatha_groups g ON g.id=m.group_id
      WHERE m.student_id=$1 AND m.stage_season_id=$2 HAVING COUNT(DISTINCT g.group_number)=1
      ON CONFLICT(student_id,stage_season_id) DO NOTHING`,[studentId,stageSeasonId]);
    const result=await c.query('DELETE FROM group_memberships WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 RETURNING id',[studentId,subjectId,stageSeasonId]);
    await c.query('COMMIT');return result.rowCount>0;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

// تصفير سجل الطالب الدراسي في موسم مرحلة معيّنة: يُستخدم عند نقله لمرحلة أخرى
// كي ينتقل بلا أي درجات (لا مجموعات ولا حضور مباحثات ولا محاولات امتحان ولا درجات نهائية).
async function resetStudentStudies(studentId, stageSeasonId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM students WHERE id=$1 FOR UPDATE',[studentId]);
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
    await client.query('DELETE FROM group_membership_history WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
    await client.query('DELETE FROM group_memberships WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
    await client.query('DELETE FROM student_group_numbers WHERE student_id=$1 AND stage_season_id=$2', [studentId, stageSeasonId]);
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
const submitReport = (studentId, subjectId, stageSeasonId, { fileId, kind, note, sourceMessageId = null }) =>
  pool
    .query(
      `INSERT INTO student_reports(student_id, subject_id, stage_season_id, telegram_file_id, file_kind, note,
                                   group_id, group_title_snapshot, source_message_id)
       SELECT pm.student_id,pm.subject_id,pm.stage_season_id,$4,$5,$6,g.id,CASE WHEN ss.discussion_grouping THEN g.title ELSE 'المرحلة كاملة' END,$7
       FROM participation_modes pm
       JOIN students st ON st.id=pm.student_id AND st.is_active=true
       JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=pm.stage_season_id AND e.status='active'
       JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
       JOIN subjects sub ON sub.id=pm.subject_id AND sub.stage_id=ss.stage_id
       JOIN group_memberships m ON m.student_id=pm.student_id AND m.subject_id=pm.subject_id AND m.stage_season_id=pm.stage_season_id
       JOIN mubahatha_groups g ON g.id=m.group_id AND g.is_active=true
       WHERE pm.student_id=$1 AND pm.subject_id=$2 AND pm.stage_season_id=$3 AND pm.mode='report' AND participation_enabled(pm.subject_id,pm.stage_season_id)
       ON CONFLICT(student_id,source_message_id) WHERE source_message_id IS NOT NULL DO NOTHING RETURNING *`,
      [studentId, subjectId, stageSeasonId, fileId, kind, note, sourceMessageId]
    )
    .then((r) => r.rows[0]);

// طلبة التقارير في المادة مع عدد ما سلّموه — يستعرضهم الأستاذ واحدًا تلو الآخر عند التقييم.
const listReportStudentsForGrading = (subjectId, stageSeasonId, { groupId = null, page = 0, size = 25, onlyUngraded = false } = {}) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name, pm.mode, pm.switched_at,
              COUNT(r.id) AS report_count,
              COUNT(r.id) FILTER (WHERE r.score IS NULL) AS pending_report_count,
              COUNT(r.id) FILTER (WHERE r.score IS NOT NULL) AS graded_report_count,
              MAX(r.submitted_at) AS last_submission,
              fg.report_score, COUNT(*) OVER() AS total_count,
              g.id AS group_id, discussion_group_label(g.id) AS group_title
       FROM participation_modes pm
       JOIN students st ON st.id=pm.student_id
       LEFT JOIN group_memberships gm ON gm.student_id=st.id AND gm.subject_id=pm.subject_id AND gm.stage_season_id=pm.stage_season_id
       LEFT JOIN mubahatha_groups g ON g.id=gm.group_id
       LEFT JOIN student_reports r
              ON r.student_id=st.id AND r.subject_id=pm.subject_id AND r.stage_season_id=pm.stage_season_id
             AND ($3::int IS NULL OR discussion_group_root(r.group_id)=$3)
       LEFT JOIN final_grades fg
              ON fg.student_id=st.id AND fg.subject_id=pm.subject_id AND fg.stage_season_id=pm.stage_season_id
       WHERE pm.subject_id=$1 AND pm.stage_season_id=$2
         AND (pm.mode='report' OR r.id IS NOT NULL)
         AND ($3::int IS NULL OR gm.group_id=$3 OR discussion_group_root(r.group_id)=$3)
         AND (NOT $6::boolean OR EXISTS (
           SELECT 1 FROM student_reports pending
           WHERE pending.student_id=st.id AND pending.subject_id=pm.subject_id
             AND pending.stage_season_id=pm.stage_season_id AND pending.score IS NULL
             AND ($3::int IS NULL OR discussion_group_root(pending.group_id)=$3)
         ))
       GROUP BY st.id, st.full_name, pm.mode, pm.switched_at, fg.report_score, g.id
       ORDER BY (COUNT(r.id) FILTER (WHERE r.score IS NULL)>0) DESC,
                MAX(r.submitted_at) DESC NULLS LAST,st.full_name,st.id LIMIT $4 OFFSET $5`,
      [subjectId, stageSeasonId, groupId, pageOptions(page,size).size, pageOptions(page,size).offset, onlyUngraded]
    )
    .then((r) => r.rows);

const listStudentReports = (studentId, subjectId, stageSeasonId, { page = 0, size = 10, groupId = null } = {}) =>
  pool
    .query(
      `SELECT *,COUNT(*) OVER() AS total_count FROM student_reports
       WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3
         AND ($4::int IS NULL OR discussion_group_root(group_id)=$4) ORDER BY submitted_at,id LIMIT $5 OFFSET $6`,
      [studentId, subjectId, stageSeasonId, groupId, pageOptions(page,size).size, pageOptions(page,size).offset]
    )
    .then((r) => r.rows);

// تقييم تقرير واحد بعينه (من 15)، فيمكن للأستاذ تقييمها تباعًا كلما وصلته.
const setReportItemScore = (reportId, score, gradedBy) =>
  pool
    .query(
      `UPDATE student_reports SET score=$2, graded_at=now(), graded_by=$3
       WHERE id=$1 RETURNING *`,
      [reportId, validScore(score, GRADE_WEIGHTS.participationTotal), gradedBy]
    )
    .then((r) => r.rows[0]);

// ملخّص تقييم تقارير طالب في مادة: كم قُيّم وكم بقي ومعدّل المُقيَّم.
const getReportGradingSummary = (studentId, subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT COUNT(*) AS total,
              COUNT(score) AS graded,
              ROUND(AVG(score)::numeric, 2) AS average
       FROM student_reports
       WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3`,
      [studentId, subjectId, stageSeasonId]
    )
    .then((r) => r.rows[0]);

// اعتماد معدّل التقارير المُقيَّمة كدرجة مشاركة نهائية للطالب.
async function applyReportAverage(studentId, subjectId, stageSeasonId) {
  const summary = await getReportGradingSummary(studentId, subjectId, stageSeasonId);
  if (Number(summary.graded) === 0) {
    const err = new Error('لم تُقيَّم أي من تقاريره بعد.');
    err.code = 'NO_GRADED_REPORTS';
    throw err;
  }
  if(Number(summary.graded)!==Number(summary.total))
    throw appError(`قيّم التقارير المتبقية أولًا (${Number(summary.graded)} من ${Number(summary.total)} مقيّم).`,'REPORTS_PENDING',409);
  const avg = Number(summary.average);
  await setReportScore(studentId, subjectId, stageSeasonId, avg);
  return { average: avg, graded: Number(summary.graded), total: Number(summary.total) };
}

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
      `SELECT s.*, sub.name AS subject_name, discussion_group_label(g.id) AS group_title, g.group_number
       FROM schedule_slots s
       JOIN subjects sub ON sub.id = s.subject_id
       JOIN mubahatha_groups g ON g.id = s.group_id
       WHERE s.stage_season_id=$1 AND s.day_of_week=$2 AND s.hour=$3
         AND s.subject_id <> $4 AND s.is_active=true`,
      [stageSeasonId, dayOfWeek, hour, subjectId]
    )
    .then((r) => r.rows);

// مواعيد الأستاذ نفسه في اليوم والساعة ذاتهما، ولو في مرحلة أخرى — لا يستطيع أن يكون في مكانين.
const findTeacherConflicts = (teacherId, dayOfWeek, hour, excludeGroupId = null) =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, g.group_number,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       WHERE s.teacher_id=$1 AND s.day_of_week=$2 AND s.hour=$3 AND s.is_active=true
         AND ($4::int IS NULL OR s.group_id <> $4::int)`,
      [teacherId, dayOfWeek, hour, excludeGroupId]
    )
    .then((r) => r.rows);

async function addScheduleSlot(groupId, { dayOfWeek, hour, minute = 0, durationHours = 1, teacherId }) {
  const day=Number(dayOfWeek),h=Number(hour),m=Number(minute);
  if(!Number.isInteger(day)||day<0||day>6||!Number.isInteger(h)||h<16||h>23||!Number.isInteger(m)||m<0||m>59||Number(durationHours)!==1)throw appError('موعد غير صالح. مواعيد المباحثات تكون بين الساعة 4 عصرًا و11 ليلًا، ومدتها ساعة واحدة.');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query('SELECT ss.id FROM stage_seasons ss JOIN mubahatha_groups g ON g.stage_season_id=ss.id WHERE g.id=$1 FOR SHARE OF ss',[groupId]);
    // One lock for schedule edits: infrequent administration, not student traffic.
    await c.query('SELECT pg_advisory_xact_lock(734222,1)');
    const group=(await c.query(`SELECT g.* FROM mubahatha_groups g JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
      WHERE g.id=$1 AND g.is_active=true AND participation_enabled(g.subject_id,g.stage_season_id)`,[groupId])).rows[0];
    if(!group)throw appError('المجموعة غير نشطة أو غير موجودة.');
    const owners=(await c.query(`SELECT ta.teacher_id FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
      WHERE ta.subject_id=$1 AND ta.stage_season_id=$2 ORDER BY ta.teacher_id`,[group.subject_id,group.stage_season_id])).rows;
    const ownerId=teacherId?positiveInt(teacherId):owners.length===1?owners[0].teacher_id:null;
    if(!ownerId||!owners.some(x=>Number(x.teacher_id)===Number(ownerId)))throw appError('اختر أستاذًا نشطًا مسندًا لهذه المادة.','NO_TEACHER');
    const start=day*1440+h*60+m;
    const conflict=(await c.query(`SELECT sl.id FROM schedule_slots sl JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
      CROSS JOIN unnest(ARRAY[-10080,0,10080]) shift(n)
      WHERE sl.is_active=true AND (sl.teacher_id=$1 OR sl.group_id=$2)
        AND sl.day_of_week*1440+sl.hour*60+sl.minute+shift.n<$3+60
        AND sl.day_of_week*1440+sl.hour*60+sl.minute+shift.n+sl.duration_hours*60>$3 LIMIT 1`,[ownerId,groupId,start])).rows[0];
    if(conflict)throw appError('يتداخل الموعد مع مباحثة أخرى للأستاذ أو المجموعة. اختر وقتًا آخر.','SCHEDULE_CONFLICT',409);
    const conflicts=(await c.query(`SELECT sl.*,sub.name AS subject_name,other.group_number AS other_group_number
      FROM schedule_slots sl JOIN subjects sub ON sub.id=sl.subject_id
      JOIN mubahatha_groups other ON other.id=sl.group_id
      WHERE sl.stage_season_id=$1 AND sl.is_active=true AND sl.subject_id<>$2 AND sl.day_of_week=$3
        AND sl.hour*60+sl.minute<$4+60 AND sl.hour*60+sl.minute+sl.duration_hours*60>$4`,[group.stage_season_id,group.subject_id,day,h*60+m])).rows;
    if(conflicts.some(sl=>Number(sl.other_group_number)===Number(group.group_number)))
      throw appError('يتداخل الموعد مع مادة أخرى للمجموعة نفسها. اختر وقتًا آخر.','SCHEDULE_CONFLICT',409);
    const slot=(await c.query(`INSERT INTO schedule_slots(group_id,subject_id,stage_season_id,teacher_id,day_of_week,hour,minute,duration_hours)
      VALUES($1,$2,$3,$4,$5,$6,$7,1) ON CONFLICT(group_id,day_of_week,hour,minute)
      DO UPDATE SET is_active=true,teacher_id=EXCLUDED.teacher_id,duration_hours=1 RETURNING *`,[groupId,group.subject_id,group.stage_season_id,ownerId,day,h,m])).rows[0];
    await c.query('COMMIT');return {slot,conflicts,teacherConflicts:[]};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

// Keep previous daily decisions and attendance linked to their original slot.
const removeScheduleSlot = (slotId) =>
  pool.query('UPDATE schedule_slots SET is_active=false WHERE id=$1 AND is_active=true RETURNING id',[slotId]).then(r=>r.rowCount>0);

const listGroupSlots = (groupId) =>
  pool
    .query('SELECT * FROM schedule_slots WHERE group_id=$1 AND is_active=true ORDER BY CASE WHEN day_of_week=6 THEN 0 ELSE day_of_week+1 END, hour, minute', [groupId])
    .then((r) => r.rows);

const listTeacherSlots = (teacherId) =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, discussion_group_label(g.id) AS group_title, g.group_number,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       WHERE s.teacher_id=$1 AND s.is_active=true AND participation_enabled(s.subject_id,s.stage_season_id)
       ORDER BY CASE WHEN s.day_of_week=6 THEN 0 ELSE s.day_of_week+1 END, s.hour, s.minute`,
      [teacherId]
    )
    .then((r) => r.rows);

// كل مواعيد المواسم النشطة — للأدمن الذي يشرف على الجميع.
const listAllSlots = () =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, discussion_group_label(g.id) AS group_title, g.group_number,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              t.full_name AS teacher_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       LEFT JOIN teachers t ON t.id=s.teacher_id
       WHERE s.is_active=true
       ORDER BY sg.sort_order NULLS LAST, CASE WHEN s.day_of_week=6 THEN 0 ELSE s.day_of_week+1 END, s.hour, s.minute`
    )
    .then((r) => r.rows);

// جدول المرحلة كاملًا (لعرضه على الأدمن ولكشف التعارضات بصريًا)
const listStageSeasonSlots = (stageSeasonId) =>
  pool
    .query(
      `SELECT s.*, sub.name AS subject_name, discussion_group_label(g.id) AS group_title, g.group_number, t.full_name AS teacher_name
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       LEFT JOIN teachers t ON t.id=s.teacher_id
       WHERE s.stage_season_id=$1 AND s.is_active=true AND participation_enabled(s.subject_id,s.stage_season_id)
       ORDER BY CASE WHEN s.day_of_week=6 THEN 0 ELSE s.day_of_week+1 END, s.hour, s.minute`,
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
       SELECT s.*, sub.name AS subject_name, discussion_group_label(g.id) AS group_title, g.group_number,
              sg.name AS stage_name,
              t.telegram_id AS teacher_telegram_id, t.full_name AS teacher_name,
              loc.ln::date AS scheduled_date
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id
       LEFT JOIN teachers t ON t.id=s.teacher_id AND t.is_active=true
       CROSS JOIN loc
       WHERE s.is_active=true AND participation_enabled(s.subject_id,s.stage_season_id)
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

const recordSlotDecision = (slotId, scheduledDate, decision, decidedBy, reason = null) =>
  pool
    .query(
      `INSERT INTO slot_decisions(slot_id, scheduled_date, decision, decided_at, decided_by, reason)
       SELECT sl.id,$2::date,$3,now(),$4,$6 FROM schedule_slots sl
       JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
       WHERE sl.id=$1 AND sl.is_active=true AND participation_enabled(sl.subject_id,sl.stage_season_id) AND $2::date=(now() AT TIME ZONE $5)::date
         AND EXTRACT(DOW FROM $2::date)::int=sl.day_of_week
         AND (now() AT TIME ZONE $5) < $2::date+make_time(sl.hour,sl.minute,0)+make_interval(hours=>sl.duration_hours)
       ON CONFLICT (slot_id, scheduled_date)
       DO UPDATE SET decision=$3, decided_at=now(), decided_by=$4, reason=$6
       WHERE slot_decisions.session_id IS NULL
       RETURNING *`,
      [slotId, scheduledDate, decision, decidedBy, SCHEDULE_TZ, reason]
    )
    .then((r) => r.rows[0]);

const setSlotDecisionReason = (slotId, scheduledDate, decidedBy, reason) =>
  pool
    .query(
      `UPDATE slot_decisions d SET reason=$4,decided_at=now(),decided_by=$3
       FROM schedule_slots sl JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
       WHERE d.slot_id=sl.id AND d.slot_id=$1 AND d.scheduled_date=$2::date
         AND d.decision='postponed' AND d.session_id IS NULL
         AND participation_enabled(sl.subject_id,sl.stage_season_id)
       RETURNING d.*`,
      [slotId, scheduledDate, decidedBy, reason]
    )
    .then((r) => r.rows[0]);

const getSlotDecision = (slotId, scheduledDate) =>
  pool
    .query('SELECT * FROM slot_decisions WHERE slot_id=$1 AND scheduled_date=$2::date', [slotId, scheduledDate])
    .then((r) => r.rows[0]);

// عند تعطيل اشتراط التأكيد يبدأ الموعد الصامت أيضًا؛ التأجيل الصريح يمنعه دائمًا.
const getSlotsReadyToStart = () =>
  pool
    .query(
      `WITH loc AS (SELECT (now() AT TIME ZONE $1) AS ln),
       dates AS (SELECT ln::date AS day FROM loc UNION ALL SELECT ln::date-1 FROM loc)
       SELECT s.*, d.id AS decision_id, dates.day AS scheduled_date,
              ((dates.day+make_time(s.hour,s.minute,0)) AT TIME ZONE $1) AT TIME ZONE 'UTC' AS scheduled_start,
              ((dates.day+make_time(s.hour,s.minute,0)+make_interval(hours=>s.duration_hours)) AT TIME ZONE $1) AT TIME ZONE 'UTC' AS scheduled_end,
              sub.name AS subject_name, discussion_group_label(g.id) AS group_title, g.group_number
       FROM schedule_slots s
       JOIN subjects sub ON sub.id=s.subject_id
       JOIN mubahatha_groups g ON g.id=s.group_id AND g.is_active=true
       JOIN stage_seasons ss ON ss.id=s.stage_season_id AND ss.is_active=true
       CROSS JOIN loc
       CROSS JOIN dates
       LEFT JOIN slot_decisions d ON d.slot_id=s.id AND d.scheduled_date=dates.day
       WHERE s.is_active=true AND participation_enabled(s.subject_id,s.stage_season_id) AND d.session_id IS NULL
         AND (d.decision='confirmed' OR ($2::boolean=false AND d.decision IS NULL))
         AND EXTRACT(DOW FROM dates.day)::int=s.day_of_week
         AND loc.ln >= (dates.day + make_time(s.hour, s.minute, 0))
         AND loc.ln < (dates.day + make_time(s.hour, s.minute, 0)+make_interval(hours=>s.duration_hours))`,
      [SCHEDULE_TZ, SCHEDULE_REQUIRE_CONFIRMATION]
    )
    .then((r) => r.rows);

// يفتح جلسة الموعد ويربطها بالقرار حتى لا تُفتح مرتين.
async function startSessionFromSlot(slot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM stage_seasons WHERE id=$1 FOR SHARE',[slot.stage_season_id]);
    await client.query(`INSERT INTO slot_decisions(slot_id,scheduled_date) VALUES($1,$2)
      ON CONFLICT(slot_id,scheduled_date) DO NOTHING`, [slot.id, slot.scheduled_date]);
    const claim = await client.query(
      `SELECT d.id FROM slot_decisions d JOIN schedule_slots sl ON sl.id=d.slot_id
       JOIN stage_seasons ss ON ss.id=sl.stage_season_id AND ss.is_active=true
       WHERE participation_enabled(sl.subject_id,sl.stage_season_id) AND d.slot_id=$1 AND d.scheduled_date=$2 AND d.session_id IS NULL AND sl.is_active=true
         AND (d.decision='confirmed' OR ($4::boolean=false AND d.decision IS NULL))
         AND $3::timestamp > now() AND $5::timestamp <= now() FOR UPDATE OF d`,
      [slot.id, slot.scheduled_date, slot.scheduled_end, SCHEDULE_REQUIRE_CONFIRMATION, slot.scheduled_start]
    );
    if (!claim.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const sess = await client.query(
      `INSERT INTO mubahatha_sessions(group_id, teacher_id, title, opened_at,closes_at,held_on)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [slot.group_id, slot.teacher_id, `${slot.subject_name} — ${formatSlot(slot)}`, slot.scheduled_start, slot.scheduled_end, slot.scheduled_date]
    );
    await client.query('UPDATE slot_decisions SET session_id=$2 WHERE id=$1', [
      claim.rows[0].id,
      sess.rows[0].id,
    ]);
    await client.query('COMMIT');
    return sess.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
       JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=m.subject_id
         AND pm.stage_season_id=m.stage_season_id AND pm.mode='mubahatha'
       JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=m.stage_season_id AND e.status='active'
       JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
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

// Show individual report evaluations before season finalization, without treating
// the default zero totals in a report-only final_grades row as finalized grades.
const listStudentGradeOverview = (studentId, {page=0,size=5,subjectId=null,stageSeasonId=null}={}) => {
  const paging = pageOptions(page,size);
  return pool.query(`
    WITH records AS (
      SELECT subject_id,stage_season_id FROM participation_modes WHERE student_id=$1
      UNION SELECT subject_id,stage_season_id FROM student_reports WHERE student_id=$1
      UNION SELECT subject_id,stage_season_id FROM final_grades WHERE student_id=$1
    ), reports AS (
      SELECT subject_id,stage_season_id,COUNT(*) AS report_count,COUNT(score) AS graded_count,
        ROUND(AVG(score)::numeric,2) AS report_average
      FROM student_reports WHERE student_id=$1 GROUP BY subject_id,stage_season_id
    )
    SELECT r.subject_id,r.stage_season_id,sub.name AS subject_name,
      COALESCE(ss.stage_name_snapshot,st.name) AS stage_name,se.name AS season_name,
      pm.mode,fg.report_score,fg.mubahatha_score,fg.participation_score,fg.exams_score,
      fg.total_score,fg.finalized_at,fg.edited_at,
      COALESCE(rep.report_count,0) AS report_count,COALESCE(rep.graded_count,0) AS graded_count,
      rep.report_average,COUNT(*) OVER() AS total_count
    FROM records r JOIN subjects sub ON sub.id=r.subject_id
    JOIN stage_seasons ss ON ss.id=r.stage_season_id JOIN seasons se ON se.id=ss.season_id
    JOIN stages st ON st.id=ss.stage_id
    LEFT JOIN participation_modes pm ON pm.student_id=$1 AND pm.subject_id=r.subject_id AND pm.stage_season_id=r.stage_season_id
    LEFT JOIN final_grades fg ON fg.student_id=$1 AND fg.subject_id=r.subject_id AND fg.stage_season_id=r.stage_season_id
    LEFT JOIN reports rep ON rep.subject_id=r.subject_id AND rep.stage_season_id=r.stage_season_id
    WHERE ($2::int IS NULL OR r.subject_id=$2) AND ($3::int IS NULL OR r.stage_season_id=$3)
    ORDER BY ss.started_at DESC,ss.id DESC,sub.id LIMIT $4 OFFSET $5`,
    [studentId,subjectId,stageSeasonId,paging.size,paging.offset]).then(r=>r.rows);
};

// تحرير درجة طالب يدويًا من الأستاذ أو الأدمن (لمن يحتاج مساعدة).
// يُحفظ من عدّلها ومتى، ويُعاد حساب المجموع من القيم الجديدة.

// طلبة المادة في الموسم مع درجاتهم (لاختيار من يُحرَّر له)
const listSubjectGrades = (subjectId, stageSeasonId, {page=0,size=25,studentId=null}={}) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name, fg.exams_score, fg.participation_score,
              fg.total_score, fg.lessons_score, fg.edited_at,COUNT(*) OVER() AS total_count
       FROM enrollments e
       JOIN students st ON st.id=e.student_id AND st.is_active=true
       LEFT JOIN final_grades fg
              ON fg.student_id=st.id AND fg.subject_id=$1 AND fg.stage_season_id=$2
       WHERE e.stage_season_id=$2 AND e.status='active' AND ($3::int IS NULL OR st.id=$3)
       ORDER BY st.full_name,st.id LIMIT $4 OFFSET $5`,
      [subjectId, stageSeasonId, studentId,pageOptions(page,size).size,pageOptions(page,size).offset]
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
              COUNT(DISTINCT s.id) AS eligible_sessions,
              -- الحضور يُحتسب مكتملًا فقط إن سجّل الطالب البداية والنهاية معًا لنفس الجلسة
              COUNT(DISTINCT s.id) FILTER (
                WHERE start_att.id IS NOT NULL AND end_att.id IS NOT NULL
              ) AS attended_sessions
       FROM participation_modes pm
       LEFT JOIN (
         SELECT student_id,subject_id,stage_season_id,group_id,assigned_at,NULL::timestamp AS ended_at FROM group_memberships
         UNION ALL SELECT student_id,subject_id,stage_season_id,group_id,assigned_at,ended_at FROM group_membership_history
       ) gm ON gm.student_id=pm.student_id AND gm.subject_id=pm.subject_id AND gm.stage_season_id=pm.stage_season_id
       LEFT JOIN mubahatha_sessions s ON s.group_id=gm.group_id
             AND s.opened_at>=gm.assigned_at AND (gm.ended_at IS NULL OR s.opened_at<gm.ended_at)
             AND was_in_mubahatha(pm.student_id,pm.subject_id,pm.stage_season_id,s.opened_at)
       LEFT JOIN mubahatha_attendance start_att
              ON start_att.session_id=s.id AND start_att.student_id=pm.student_id
             AND start_att.phase='start'
       LEFT JOIN mubahatha_attendance end_att
              ON end_att.session_id=s.id AND end_att.student_id=pm.student_id
             AND end_att.phase='end'
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
  requestParticipationChange,
  getParticipationChangeRequest,
  listPendingParticipationChanges,
  cancelParticipationChange,
  decideParticipationChange,
  listStudentGradeOverview,
  GRADE_WEIGHTS,
  SCHEDULE_HOURS,
  SCHEDULE_TZ,
  DAY_NAMES,
  formatHour,
  formatSlot,
  findScheduleConflicts,
  findTeacherConflicts,
  addScheduleSlot,
  removeScheduleSlot,
  listGroupSlots,
  listTeacherSlots,
  listAllSlots,
  listStageSeasonSlots,
  getSlotsNeedingPrompt,
  recordSlotPrompt,
  recordSlotDecision,
  setSlotDecisionReason,
  getSlotDecision,
  getSlotsReadyToStart,
  SCHEDULE_REQUIRE_CONFIRMATION,
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
  changeParticipationMode,
  countParticipationBySubject,
  createMubahathaGroup,
  listGroups,
  getGroupById,
  setGroupCapacity,
  updateGroupSettings,
  setGroupInviteLink,
  setGroupActive,
  setGroupChatId,
  listPreviousSeasonGroups,
  listUnassignedMubahathaStudents,
  getStudentGroup,
  assignStudentToGroup,
  openSession,
  closeSession,
  listGroupSessions,
  listDiscussionAttendanceForTeacher,
  getOpenSessionForGroup,
  markSessionAttendance,
  openEndAttendance,
  isStartAttendanceOpen,
  isEndAttendanceOpen,
  getSessionsNeedingEndPrompt,
  markEndPromptSent,
  getSessionsNeedingAutoEnd,
  closeExpiredSessionsWithoutEnd,
  START_ATTENDANCE_DELAY_MINUTES,
  DISCUSSION_REOPEN_MINUTES,
  END_ATTENDANCE_MINUTES,
  createExam,
  addExamQuestion,
  listExamQuestions,
  deleteExamQuestion,
  updateExamQuestion,
  updateExam,
  deleteExam,
  getExamsReadyToAutoPublish,
  publishExam,
  getExamById,
  listExamsForSubject,
  getOpenExamsForStudent,
  isExamAvailable,
  startOrResumeAttempt,
  getNextUnansweredQuestion,
  submitAnswer,
  finalizeAttempt,
  getExamResults,
  postponeExam,
  cancelExam,
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
  setReportItemScore,
  getReportGradingSummary,
  applyReportAverage,
  getStudentFinalGrades,
  overrideStudentGrade,
  listSubjectGrades,
  EXAM_START_HOUR,
  computeSeasonGrades,
  finalizeSeasonGrades,
};
