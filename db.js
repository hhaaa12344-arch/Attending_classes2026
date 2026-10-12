// db.js — الاتصال بقاعدة بيانات PostgreSQL وإدارة الجداول والاستعلامات
const { Pool, types, defaults } = require('pg');
// TIMESTAMP columns in this project store UTC. Do not let the host's local
// timezone reinterpret deadlines or serialize JS Dates using a local offset.
defaults.parseInputDatesAsUTC = true;
types.setTypeParser(1114, value => new Date(value.replace(' ','T')+'Z'));
types.setTypeParser(1082, value => new Date(value+'T00:00:00Z'));
const { normalizeHashtag } = require('./utils');

const MAX_LEAVE_DAYS_PER_SEASON = 10;
const poolMax=Number(process.env.PG_POOL_MAX||5);
if(!Number.isInteger(poolMax)||poolMax<1||poolMax>30)throw new Error('PG_POOL_MAX must be an integer from 1 to 30');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // تُحفظ أعمدة الوقت القديمة بصيغة TIMESTAMP؛ تثبيت جلسة PostgreSQL على UTC
  // يمنع اختلاف تفسير المهل بين خادم وآخر، ثم نحول يوم الغياب إلى توقيت المعهد صراحةً.
  options: '-c timezone=UTC',
  // حد صغير قابل للضبط؛ لا يعني ضمان سعة أو تكلفة دون قياس على الاستضافة.
  max: poolMax,
  idleTimeoutMillis: 30000, // يغلق الاتصال الخامل بعد نصف دقيقة فلا يتراكم
  connectionTimeoutMillis: 5000, // لا ينتظر اتصالًا للأبد إن كانت القاعدة مشغولة
  statement_timeout: 15000, // يقتل أي استعلام يتجاوز 15 ثانية فلا يعلّق البوت
  query_timeout: 15000,
  keepAlive: true,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// أخطاء الاتصالات الخاملة تُسجَّل ولا تُسقط العملية (توثيق node-postgres يوصي بهذا).
pool.on('error', (err) => {
  console.error('خطأ غير متوقع في مجمع اتصالات PostgreSQL:', err.message);
});

// إنشاء/تحديث الجداول تلقائيًا عند كل تشغيل (آمن للتشغيل المتكرر — IF NOT EXISTS في كل مكان)
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      registration_visible BOOLEAN NOT NULL DEFAULT true
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
    -- مفتاح مقارنة الأسماء: يتجاهل الفراغات المتكررة وفروق الهمزات والياء والتاء المربوطة (للتنبيه على السجلات المكررة فقط).
    CREATE OR REPLACE FUNCTION student_name_key(text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      SELECT lower(regexp_replace(translate(btrim($1),'أإآٱىةؤئ','اااايهوي'),'\\s+',' ','g'))
    $fn$;
    CREATE INDEX IF NOT EXISTS idx_students_name_key ON students(student_name_key(full_name));
    CREATE INDEX IF NOT EXISTS idx_lessons_subject ON lessons(subject_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
    -- فهارس أداء تُسرّع التقارير وفحص الغياب مع تراكم مئات آلاف الصفوف عبر المواسم:
    CREATE INDEX IF NOT EXISTS idx_attendance_lesson ON attendance(lesson_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_student_lesson ON attendance(student_id, lesson_id);
    CREATE INDEX IF NOT EXISTS idx_channels_stage ON channels(stage_id);

    -- يسجّل أي منشور درس يصل من قناة غير مرتبطة (أو مرتبطة بموسم غير نشط)،
    -- حتى تظهر المشكلة بوضوح في تشخيص القنوات بدل أن تُبتلع بصمت.
    CREATE TABLE IF NOT EXISTS unlinked_channel_posts (
      telegram_chat_id BIGINT PRIMARY KEY,
      chat_title TEXT,
      chat_username TEXT,
      reason TEXT NOT NULL,
      post_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_notified_at TIMESTAMPTZ
    );

    -- آخر تحديث استلمه البوت من كل قناة، حتى يمكن تشخيص الفرق بين:
    -- «تليجرام لم يرسل المنشور للبوت» و«البوت استلمه لكنه لم يفعّل درسًا».
    CREATE TABLE IF NOT EXISTS channel_post_activity (
      telegram_chat_id BIGINT PRIMARY KEY,
      chat_title TEXT,
      chat_username TEXT,
      last_message_id BIGINT,
      last_update_kind TEXT,
      last_content_kind TEXT,
      last_hashtags JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_outcome TEXT NOT NULL DEFAULT 'received',
      last_detail TEXT,
      stage_id_at_receive INTEGER,
      stage_season_id_at_receive INTEGER,
      last_lesson_id INTEGER,
      received_updates INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_channel_post_activity_seen ON channel_post_activity(last_received_at DESC);

  `);

  // ترقية آمنة لقواعد بيانات أُنشئت بنسخة سابقة من هذا البوت (قبل إضافة هذه الأعمدة)
  await pool.query(`
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS registration_visible BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS next_stage_id INTEGER REFERENCES stages(id) ON DELETE SET NULL;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE subjects ADD COLUMN IF NOT EXISTS hashtag TEXT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_chat_id BIGINT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS source_message_id BIGINT;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS attendance_opened_at TIMESTAMP;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS republished_at TIMESTAMP;
    ALTER TABLE lessons ADD COLUMN IF NOT EXISTS schedule_date DATE;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marking_kind TEXT NOT NULL DEFAULT 'student'
      CHECK (marking_kind IN ('student','admin_late'));
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by BIGINT;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS admin_note TEXT;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS public_link TEXT;
  `);

  // المواسم مستقلة لكل مرحلة: يمكن بدء ��وسم لمراحل محددة وترك غيرها في موسمها الحالي.
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

    -- يُنشأ بعد stage_seasons الذي يعتمد عليه، بما يشمل التشغيل لأول مرة.
    CREATE TABLE IF NOT EXISTS lesson_schedule_entries (
      id SERIAL PRIMARY KEY,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      lesson_date DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(stage_season_id, subject_id, lesson_date)
    );
    CREATE INDEX IF NOT EXISTS idx_lesson_schedule_stage_season_date
      ON lesson_schedule_entries(stage_season_id, lesson_date);

    -- ملفات الدروس التي وصلت من القناة قبل إدخال جدول ذلك اليوم.
    -- تُحفظ مؤقتًا ثم تُطابق تلقائيًا مع المواد المجدولة بعد استقرار إدخال الجدول،
    -- بدل أن يضيع المنشور ويضطر الأدمن إلى التفعيل اليدوي.
    CREATE TABLE IF NOT EXISTS pending_channel_lesson_posts (
      id BIGSERIAL PRIMARY KEY,
      telegram_chat_id BIGINT NOT NULL,
      source_message_id BIGINT NOT NULL,
      stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      lesson_date DATE NOT NULL,
      source_url TEXT,
      content_kind TEXT,
      received_at TIMESTAMP NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','activated','duplicate')),
      lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
      resolved_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
      resolved_at TIMESTAMP,
      UNIQUE(telegram_chat_id, source_message_id)
    );
    ALTER TABLE pending_channel_lesson_posts ADD COLUMN IF NOT EXISTS auto_match BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE pending_channel_lesson_posts ADD COLUMN IF NOT EXISTS content_text TEXT;
    ALTER TABLE pending_channel_lesson_posts ADD COLUMN IF NOT EXISTS title_message_id BIGINT;
    CREATE INDEX IF NOT EXISTS idx_pending_channel_lessons_lookup
      ON pending_channel_lesson_posts(stage_season_id, lesson_date, status, received_at, id);

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

    -- ردود البوت العابرة في محادثات الطلبة والأساتذة؛ تُحذف عند أول تفاعل تالٍ (transientMessages.js).
    CREATE TABLE IF NOT EXISTS transient_ui_messages (
      chat_id BIGINT NOT NULL,
      message_id BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY(chat_id, message_id)
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
    ALTER TABLE student_leaves ADD COLUMN IF NOT EXISTS is_exception BOOLEAN NOT NULL DEFAULT false;
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

    -- سجل الترحيلات التي تُنفَّذ مرة واحدة فقط
    CREATE TABLE IF NOT EXISTS applied_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- نوع المرحلة: 'lessons_only' حضور دروس فقط، أو 'full' مع مباحثات وتقارير وامتحانات.
    -- المراحل المُنشأة قبل هذه الميزة تُعتبر كاملة حفاظًا على سلوكها الحالي.
    ALTER TABLE stages ADD COLUMN IF NOT EXISTS stage_type TEXT NOT NULL DEFAULT 'full';

    -- كود نقل حساب الطالب عند تغييره هاتفه أو حساب تليجرام
    ALTER TABLE students ADD COLUMN IF NOT EXISTS transfer_code TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS transfer_code_at TIMESTAMP;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_students_transfer_code
      ON students(transfer_code) WHERE transfer_code IS NOT NULL;

    -- ربط القناة بموسم المرحلة: يجعل قنوات المواسم المنتهية تتوقف تلقائيًا عن تفعيل الدروس.
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS stage_season_id
      INTEGER REFERENCES stage_seasons(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_channels_stage_season ON channels(stage_season_id);

    -- ---------- الأساتذة ----------
    -- الأستاذ كيان مستقل عن الأدمن: يُعرَّف من لوحة الأدمن ثم يربط حسابه بكود تفعيل لمرة واحدة،
    -- فلا يحتاج الأدمن لمعرفة معرّف تليجرام الخاص به مسبقًا.
    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      telegram_id BIGINT UNIQUE,
      link_code TEXT UNIQUE,
      phone TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      linked_at TIMESTAMP
    );

    -- إسناد أستاذ لمادة داخل موسم محدد؛ فيمكن أن يتغير أستاذ المادة بين موسم وآخر
    -- مع بقاء سجل الموسم السابق منسوبًا لأستاذه الحقيقي.
    CREATE TABLE IF NOT EXISTS teaching_assignments (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP NOT NULL DEFAULT now(),
      UNIQUE(subject_id, stage_season_id, teacher_id)
    );

    CREATE INDEX IF NOT EXISTS idx_teach_assign_teacher ON teaching_assignments(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_teach_assign_subject ON teaching_assignments(subject_id);
    CREATE INDEX IF NOT EXISTS idx_teach_assign_season ON teaching_assignments(stage_season_id);
    ALTER TABLE students ADD COLUMN IF NOT EXISTS official_confirmed_at TIMESTAMP;
    -- يُحفظ يوزر تيليجرام (إن وُجد) عند كل تفاعل مع البوت، لعرضه في قوائم التنبيهات الإدارية.
    ALTER TABLE students ADD COLUMN IF NOT EXISTS telegram_username TEXT;

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

    CREATE TABLE IF NOT EXISTS lesson_corrections (
      lesson_id INTEGER PRIMARY KEY REFERENCES lessons(id) ON DELETE RESTRICT,
      canonical_lesson_id INTEGER REFERENCES lessons(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,actor_id BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(canonical_lesson_id IS NULL OR canonical_lesson_id<>lesson_id)
    );
    CREATE TABLE IF NOT EXISTS lesson_repair_batches (
      key TEXT PRIMARY KEY,actor_id BIGINT NOT NULL,before_data JSONB NOT NULL,after_data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE VIEW effective_lessons AS
      SELECT l.* FROM lessons l WHERE NOT EXISTS(SELECT 1 FROM lesson_corrections r WHERE r.lesson_id=l.id);

    UPDATE lessons l
    SET stage_season_id = chosen.id
    FROM subjects sub
    JOIN LATERAL (
      SELECT ss.id FROM stage_seasons ss
      WHERE ss.stage_id=sub.stage_id
      ORDER BY ss.started_at, ss.id LIMIT 1
    ) chosen ON true
    WHERE l.subject_id=sub.id AND l.stage_season_id IS NULL;

    -- القنوات المرتبطة سابقًا بالمرحلة فقط: تُربط بالموسم النشط لتلك المرحلة كي تبقى عاملة.
    UPDATE channels c
    SET stage_season_id = ss.id
    FROM stage_seasons ss
    WHERE ss.stage_id = c.stage_id AND ss.is_active = true AND c.stage_season_id IS NULL;

    -- ترحيل لمرة واحدة: التسجيلات التي أُنشئت آليًا عند ترقية قاعدة قديمة كان تاريخ بدئها
    -- لحظة الترقية، فتختفي دروس الطالب السابقة من تقاريره. نُرجعها إلى بداية موسم مرحلته.
    WITH todo AS (
      SELECT 1 WHERE NOT EXISTS (
        SELECT 1 FROM applied_migrations WHERE key = 'enrollment_started_at_backfill'
      )
    )
    UPDATE enrollments e
    SET started_at = ss.started_at
    FROM stage_seasons ss, todo
    WHERE ss.id = e.stage_season_id AND e.started_at > ss.started_at;

    INSERT INTO applied_migrations(key) VALUES ('enrollment_started_at_backfill')
    ON CONFLICT (key) DO NOTHING;

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
    CREATE INDEX IF NOT EXISTS idx_lessons_subject_season ON lessons(subject_id, stage_season_id);
    CREATE INDEX IF NOT EXISTS idx_lessons_season_activated ON lessons(stage_season_id, activated_at);
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

    -- عدّاد الغياب المتتالي محسوب ومخزَّن عند إدراج كل يوم، فلا يُعاد حسابه بالكامل كل جولة.
    ALTER TABLE student_attendance_days
      ADD COLUMN IF NOT EXISTS absence_streak INTEGER NOT NULL DEFAULT 0;

    -- آخر يوم عولج فعلًا لكل موسم مرحلة، كي يبدأ الفحص منه لا من بداية الموسم في كل جولة.
    CREATE TABLE IF NOT EXISTS attendance_processing_cursor (
      stage_season_id INTEGER PRIMARY KEY REFERENCES stage_seasons(id) ON DELETE CASCADE,
      last_processed_date DATE,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );

    -- إعدادات تشغيل بسيطة يغيّرها الأدمن من داخل البوت دون الحاجة إلى Variables.
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
    INSERT INTO bot_settings(key,value) VALUES('student_registration_open','true')
    ON CONFLICT(key) DO NOTHING;

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

// ---------- إعدادات البوت ----------
const isStudentRegistrationOpen = () =>
  pool.query("SELECT value FROM bot_settings WHERE key='student_registration_open'")
    .then(r => !r.rows[0] || r.rows[0].value === 'true');

const setStudentRegistrationOpen = (open) =>
  pool.query(`INSERT INTO bot_settings(key,value,updated_at) VALUES('student_registration_open',$1,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING value`, [open ? 'true' : 'false'])
    .then(r => r.rows[0].value === 'true');

// ---------- المراحل ----------
async function addStage(name, stageType = 'full') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let season = await client.query('SELECT id FROM seasons ORDER BY created_at DESC, id DESC LIMIT 1');
    if (!season.rows[0]) {
      season = await client.query("INSERT INTO seasons(name) VALUES('الموسم الأول') RETURNING id");
    }
    const stage = await client.query(
      `INSERT INTO stages(name, sort_order, stage_type)
       VALUES($1, COALESCE((SELECT MAX(sort_order) + 1 FROM stages), 1), $2) RETURNING *`,
      [name, stageType === 'lessons_only' ? 'lessons_only' : 'full']
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

// المراحل الظاهرة فقط للطالب عند التسجيل الذاتي لأول مرة.
// لا يؤثر هذا الحجب في الطلبة الموجودين أصلًا، ولا في النقل الإداري أو بقية وظائف المرحلة.
const listRegistrationStages = () =>
  pool
    .query('SELECT * FROM stages WHERE is_active=true AND registration_visible=true ORDER BY sort_order, id')
    .then((r) => r.rows);

const setStageRegistrationVisible = (id, visible) =>
  pool
    .query('UPDATE stages SET registration_visible=$2 WHERE id=$1 RETURNING *', [id, visible === true])
    .then((r) => r.rows[0]);

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

const setStageType = (id, stageType) =>
  pool
    .query('UPDATE stages SET stage_type=$2 WHERE id=$1 RETURNING *',
      [id, stageType === 'lessons_only' ? 'lessons_only' : 'full'])
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
      `SELECT st.*, sg.name AS stage_name, sg.stage_type FROM students st
       JOIN stages sg ON sg.id = st.stage_id
       WHERE st.telegram_id=$1`,
      [telegramId]
    )
    .then((r) => r.rows[0]);

// مفتاح مقارنة الاسم الرباعي: أول أربعة أسماء بعد توحيد الفراغات والهمزات والياء والتاء المربوطة،
// فلا يُتجاوز المنع بإضافة اسم خامس أو بمسافة زائدة أو بهمزة مختلفة.
const NAME_COMPARE_WORDS = 4;
const nameKeySql = (expr) => `array_to_string((string_to_array(student_name_key(${expr}),' '))[1:${NAME_COMPARE_WORDS}],' ')`;

// الطالب النشط الذي يطابق هذا الاسم الرباعي (السجل المؤرشف لا يمنع التسجيل). يعيد null إن لم يوجد.
async function findActiveStudentByName(fullName, client = pool) {
  const r = await client.query(
    `SELECT st.id, st.full_name, st.stage_id, sg.name AS stage_name
       FROM students st JOIN stages sg ON sg.id = st.stage_id
      WHERE st.is_active = true AND ${nameKeySql('st.full_name')} = ${nameKeySql('$1::text')}
      ORDER BY st.id LIMIT 1`,
    [fullName]
  );
  return r.rows[0] || null;
}

// options.rejectDuplicateName: تسجيل الطالب بنفسه. يُرفض الاسم المكرر برمز DUPLICATE_NAME، والطريق الوحيد
// لمن غيّر حسابه هو كود نقل الحساب (transferStudentAccount). الإضافة اليدوية من الأدمن لا تستعمل هذا الخيار.
async function createStudent(telegramId, fullName, stageId, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.rejectDuplicateName) {
      // قفل بحسب الاسم يمنع تسجيلين متزامنين بالاسم نفسه من حسابين.
      await client.query(`SELECT pg_advisory_xact_lock(734226, hashtext(${nameKeySql('$1::text')}))`, [fullName]);
      const same = await findActiveStudentByName(fullName, client);
      if (same) {
        const err = new Error('هذا الاسم مسجَّل مسبقًا في النظام.');
        err.code = 'DUPLICATE_NAME';
        err.existing = same;
        throw err;
      }
    }
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

// ---------- نقل حساب الطالب عند تغيير الهاتف أو حساب تليجرام ----------
// يولّد الأدمن كودًا لمرة واحدة، يرسله الطالب من حسابه الجديد فينتقل سجله كاملًا
// (الحضور والمباحثات والامتحانات والدرجات) لأن كل شيء مرتبط بـ students.id لا بمعرّف تليجرام.
async function generateStudentTransferCode(studentId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const r = await pool.query(
        'UPDATE students SET transfer_code=$2, transfer_code_at=now() WHERE id=$1 RETURNING *',
        [studentId, generateLinkCode()]
      );
      return r.rows[0];
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('تعذر توليد كود نقل فريد، حاول مرة أخرى.');
}

// ينقل السجل إلى معرّف تليجرام الجديد ويُبطل الكود بعد الاستعمال.
async function transferStudentAccount(code, newTelegramId) {
  const clean = (code || '').trim().toUpperCase();
  if (!clean) return null;

  const target = await pool
    .query('SELECT * FROM students WHERE transfer_code=$1 AND is_active=true', [clean])
    .then((r) => r.rows[0]);
  if (!target) return null;

  // إن كان الحساب الجديد مسجَّلًا كطالب آخر، نمنع الالتباس بدل دمج سجلين
  const existing = await pool
    .query('SELECT * FROM students WHERE telegram_id=$1', [newTelegramId])
    .then((r) => r.rows[0]);
  if (existing && existing.id !== target.id) {
    const err = new Error('هذا الحساب مسجَّل لطالب آخر. راجع الإدارة.');
    err.code = 'ACCOUNT_IN_USE';
    throw err;
  }

  // Recheck the code in the write itself: two accounts cannot consume it.
  const r = await pool.query(
    `UPDATE students SET telegram_id=$2, transfer_code=NULL, transfer_code_at=NULL
     WHERE id=$1 AND transfer_code=$3 AND is_active=true
       AND transfer_code_at > now()-interval '24 hours' RETURNING *`,
    [target.id, newTelegramId, clean]
  );
  return r.rows[0];
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
      `SELECT st.*, sg.name AS stage_name, sg.stage_type FROM students st
       JOIN stages sg ON sg.id = st.stage_id WHERE st.id=$1`,
      [id]
    )
    .then((r) => r.rows[0]);

const updateStudentName = (id, name) =>
  pool.query('UPDATE students SET full_name=$1 WHERE id=$2', [name, id]);

async function updateStudentStage(id, stageId, transactionClient = null) {
  const client = transactionClient || await pool.connect();
  try {
    if(!transactionClient)await client.query('BEGIN');
    const current=(await client.query('SELECT stage_id FROM students WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current)throw new Error('الطالب غير موجود.');
    if(Number(current.stage_id)===Number(stageId)){if(!transactionClient)await client.query('COMMIT');return;}
    const target = await client.query(
      'SELECT ss.id FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id AND st.is_active=true WHERE ss.stage_id=$1 AND ss.is_active=true FOR UPDATE OF ss',
      [stageId]
    );
    if (!target.rows[0]) throw new Error('لا يوجد موسم نشط للمرحلة الجديدة.');
    // أغلق عضويات المجموعات القديمة قبل النقل؛ يبقى تاريخها وحضورها محفوظين.
    await client.query(`INSERT INTO group_membership_history
      (student_id,group_id,subject_id,stage_season_id,assigned_at,ended_at)
      SELECT m.student_id,m.group_id,m.subject_id,m.stage_season_id,m.assigned_at,now()
      FROM group_memberships m
      JOIN enrollments e ON e.student_id=m.student_id AND e.stage_season_id=m.stage_season_id AND e.status='active'
      WHERE m.student_id=$1 ON CONFLICT DO NOTHING`,[id]);
    await client.query(`DELETE FROM group_memberships m USING enrollments e
      WHERE m.student_id=$1 AND e.student_id=m.student_id
        AND e.stage_season_id=m.stage_season_id AND e.status='active'`,[id]);
    await client.query(`DELETE FROM student_group_numbers n USING enrollments e
      WHERE n.student_id=$1 AND e.student_id=n.student_id
        AND e.stage_season_id=n.stage_season_id AND e.status='active'`,[id]);
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
    if(!transactionClient)await client.query('COMMIT');
  } catch (err) {
    if(!transactionClient)await client.query('ROLLBACK');
    throw err;
  } finally {
    if(!transactionClient)client.release();
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

// موسم المرحلة النشط الذي الطالب مسجَّل فيه حاليًا
const getStudentActiveStageSeason = (studentId) =>
  pool
    .query(
      `SELECT e.stage_season_id, ss.stage_id FROM enrollments e
       JOIN stage_seasons ss ON ss.id=e.stage_season_id
       WHERE e.student_id=$1 AND e.status='active' LIMIT 1`,
      [studentId]
    )
    .then((r) => r.rows[0]);

const getStudentsByStage = (stageId) =>
  pool
    .query('SELECT * FROM students WHERE stage_id=$1 AND is_active=true', [stageId])
    .then((r) => r.rows);

// طلبة المرحلة النشطون غير المجازين اليوم — باستعلام واحد بدل استعلامَي إجازة لكل طالب.
// يُستعمل لإشعارات الدروس والمباحثات والامتحانات، فيهبط عدد الاستعلامات من آلاف إلى واحد.
const getEligibleStudentsForStage = (stageId, onDate) =>
  pool
    .query(
      `SELECT st.id, st.telegram_id, st.full_name
       FROM students st
       WHERE st.stage_id=$1 AND st.is_active=true
         AND NOT EXISTS (
           SELECT 1 FROM student_leaves sl
           WHERE sl.student_id=st.id AND sl.status='approved'
             AND $2::date BETWEEN sl.start_date AND sl.end_date
         )`,
      [stageId, onDate]
    )
    .then((r) => r.rows);

// نسخة إشعار الدرس اليومي: تُرجع فقط من لم يُشعَر اليوم وتحجز الإشعار لهم دفعة واحدة (ذرّيًا).
const claimDailyLessonRecipients = (stageId, onDate) =>
  pool
    .query(
      `WITH eligible AS (
         SELECT st.id, st.telegram_id, st.full_name
         FROM students st
         WHERE st.stage_id=$1 AND st.is_active=true
           AND NOT EXISTS (
             SELECT 1 FROM student_leaves sl
             WHERE sl.student_id=st.id AND sl.status='approved'
               AND $2::date BETWEEN sl.start_date AND sl.end_date
           )
       ),
       claimed AS (
         INSERT INTO student_daily_lesson_notifications(student_id, stage_id, notification_date)
         SELECT id, $1, $2::date FROM eligible
         ON CONFLICT DO NOTHING
         RETURNING student_id
       )
       SELECT e.id, e.telegram_id, e.full_name
       FROM eligible e JOIN claimed c ON c.student_id = e.id`,
      [stageId, onDate]
    )
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
              (SELECT COUNT(*) FROM effective_lessons l WHERE l.stage_season_id=r.id) AS lesson_count
       FROM ranked r WHERE r.stage_id=$1 ORDER BY r.started_at DESC, r.id DESC`,
      [stageId]
    )
    .then((r) => r.rows);

// واجهة الطالب لا تعرض السجل التاريخي عند «تقرير الحضور»؛ تعرض فقط تسجيله الفعلي
// في مرحلته الحالية وموسمها النشط. تبقى المواسم والمراحل السابقة محفوظة في قاعدة البيانات
// ومتاحة لتقارير الإدارة والأرشيف، لكنها لا تظهر للطالب بعد نقله إلى مرحلة أخرى.
const listStudentSeasons = (studentId) =>
  pool
    .query(
      `WITH ranked AS (${RANKED_STAGE_SEASONS_CTE})
       SELECT r.*, COALESCE(r.stage_name_snapshot, r.current_stage_name) AS stage_name,
              (SELECT COUNT(*) FROM effective_lessons l WHERE l.stage_season_id=r.id) AS lesson_count
       FROM students st
       JOIN enrollments e ON e.student_id=st.id AND e.status='active'
       JOIN ranked r ON r.id=e.stage_season_id AND r.is_active=true AND r.stage_id=st.stage_id
       WHERE st.id=$1 AND st.is_active=true
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

// ---------- الأساتذة ----------
// كود التفعيل: يُنشئه الأدمن ويرسله للأستاذ، فيرسله الأستاذ للبوت مرة واحدة ليُربط حسابه.
function generateLinkCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بلا أحرف/أرقام متشابهة
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[require('node:crypto').randomInt(alphabet.length)];
  return code;
}

async function addTeacher(fullName, phone = null) {
  const name = (fullName || '').trim();
  if (!name) throw new Error('اسم الأستاذ مطلوب.');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const r = await pool.query(
        'INSERT INTO teachers(full_name, phone, link_code) VALUES($1,$2,$3) RETURNING *',
        [name, phone, generateLinkCode()]
      );
      return r.rows[0];
    } catch (err) {
      if (err.code === '23505') continue; // تصادم نادر في الكود، أعد التوليد
      throw err;
    }
  }
  throw new Error('تعذر توليد كود تفعيل فريد، حاول مرة أخرى.');
}

const getTeacherByTelegramId = (telegramId) =>
  pool
    .query('SELECT * FROM teachers WHERE telegram_id=$1 AND is_active=true', [telegramId])
    .then((r) => r.rows[0]);

const getTeacherById = (id) =>
  pool.query('SELECT * FROM teachers WHERE id=$1', [id]).then((r) => r.rows[0]);

// ربط حساب تليجرام للأستاذ بكود التفعيل (يُستهلك الكود بعد الربط).
async function linkTeacherAccount(code, telegramId) {
  const clean = (code || '').trim().toUpperCase();
  if (!clean) return null;
  const existing = await pool.query('SELECT * FROM teachers WHERE telegram_id=$1', [telegramId]);
  if (existing.rows[0]) {
    const err = new Error('هذا الحساب مرتبط بأستاذ بالفعل.');
    err.code = 'ALREADY_LINKED';
    throw err;
  }
  const r = await pool.query(
    `UPDATE teachers SET telegram_id=$2, linked_at=now(), link_code=NULL
     WHERE link_code=$1 AND is_active=true RETURNING *`,
    [clean, telegramId]
  );
  return r.rows[0];
}

const listTeachers = () =>
  pool
    .query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM teaching_assignments ta
               JOIN stage_seasons ss ON ss.id=ta.stage_season_id
               WHERE ta.teacher_id=t.id AND ss.is_active=true) AS active_subject_count
       FROM teachers t ORDER BY t.is_active DESC, t.full_name`
    )
    .then((r) => r.rows);

const updateTeacherName = (id, name) =>
  pool.query('UPDATE teachers SET full_name=$1 WHERE id=$2 RETURNING *', [name, id]).then((r) => r.rows[0]);

const setTeacherActive = (id, active) =>
  pool.query('UPDATE teachers SET is_active=$2 WHERE id=$1 RETURNING *', [id, active]).then((r) => r.rows[0]);

// إعادة توليد كود التفعيل (لو فقده الأستاذ أو أراد الأدمن نقل الحساب لجهاز آخر).
const regenerateTeacherCode = (id) =>
  pool
    .query('UPDATE teachers SET link_code=$2, telegram_id=NULL, linked_at=NULL WHERE id=$1 RETURNING *', [
      id,
      generateLinkCode(),
    ])
    .then((r) => r.rows[0]);

const hardDeleteTeacher = (id) =>
  pool.query('DELETE FROM teachers WHERE id=$1 RETURNING id', [id]).then((r) => r.rowCount > 0);

// إسناد المواد: دائمًا ضمن الموسم النشط للمرحلة التي تتبعها المادة.
async function assignTeacherToSubject(teacherId, subjectId) {
  const season = await pool.query(
    `SELECT ss.id FROM subjects sub
     JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.is_active=true
     WHERE sub.id=$1`,
    [subjectId]
  );
  if (!season.rows[0]) {
    const err = new Error('لا يوجد موسم نشط لمرحلة هذه المادة.');
    err.code = 'NO_ACTIVE_SEASON';
    throw err;
  }
  return pool
    .query(
      `INSERT INTO teaching_assignments(teacher_id, subject_id, stage_season_id)
       VALUES($1,$2,$3) ON CONFLICT (subject_id, stage_season_id, teacher_id) DO NOTHING RETURNING *`,
      [teacherId, subjectId, season.rows[0].id]
    )
    .then((r) => r.rows[0]);
}

const unassignTeacherFromSubject = (assignmentId) =>
  pool.query('DELETE FROM teaching_assignments WHERE id=$1 RETURNING id', [assignmentId]).then((r) => r.rowCount > 0);

// كل مواد المواسم النشطة — يستخدمها الأدمن الذي يملك صلاحيات الأستاذ على كل المواد.
const listAllActiveSubjects = () =>
  pool
    .query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name,
              sg.id AS stage_id, COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              ss.id AS stage_season_id, se.name AS season_name,
              (SELECT COUNT(*) FROM enrollments e
               WHERE e.stage_season_id=ss.id AND e.status='active') AS student_count
       FROM subjects sub
       JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.is_active=true
       JOIN stages sg ON sg.id=ss.stage_id AND sg.stage_type <> 'lessons_only'
       JOIN seasons se ON se.id=ss.season_id
       ORDER BY sg.sort_order NULLS LAST, sg.id, sub.name`
    )
    .then((r) => r.rows);

// مواد الأستاذ في الموسم النشط (ما يراه في لوحته).
const listTeacherSubjects = (teacherId) =>
  pool
    .query(
      `SELECT ta.id AS assignment_id, sub.id AS subject_id, sub.name AS subject_name,
              sg.id AS stage_id, COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              ss.id AS stage_season_id, se.name AS season_name,
              (SELECT COUNT(*) FROM enrollments e
               WHERE e.stage_season_id=ss.id AND e.status='active') AS student_count
       FROM teaching_assignments ta
       JOIN teachers tt ON tt.id=ta.teacher_id AND tt.is_active=true
       JOIN subjects sub ON sub.id=ta.subject_id
       JOIN stage_seasons ss ON ss.id=ta.stage_season_id
       JOIN stages sg ON sg.id=ss.stage_id AND sg.stage_type <> 'lessons_only'
       JOIN seasons se ON se.id=ss.season_id
       WHERE ta.teacher_id=$1 AND ss.is_active=true
       ORDER BY sg.sort_order NULLS LAST, sg.id, sub.name`,
      [teacherId]
    )
    .then((r) => r.rows);

// أساتذة مادة معيّنة في الموسم النشط (لعرضها للأدمن).
const listSubjectTeachers = (subjectId) =>
  pool
    .query(
      `SELECT ta.id AS assignment_id, t.id AS teacher_id, t.full_name, t.telegram_id
       FROM teaching_assignments ta
       JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
       JOIN stage_seasons ss ON ss.id=ta.stage_season_id AND ss.is_active=true
       WHERE ta.subject_id=$1 ORDER BY t.full_name`,
      [subjectId]
    )
    .then((r) => r.rows);

// Report eligibility uses attendance availability, not the publication date used
// for numbering. Keep closed windows in history and preserve recorded attendance.
// Republished lessons have a separate 24-hour window; do not count the closed gap
// between the original 24-hour window and republication for a moved enrollment.
const REPORT_LESSON_ELIGIBILITY = `(
  (COALESCE(l.attendance_opened_at,l.activated_at) <= now()
    AND (e.ended_at IS NULL OR COALESCE(l.attendance_opened_at,l.activated_at) < e.ended_at)
    AND (CASE WHEN l.republished_at IS NULL THEN l.active_until
      ELSE LEAST(l.active_until,COALESCE(l.attendance_opened_at,l.activated_at)+interval '24 hours') END) > e.started_at)
  OR (l.republished_at IS NOT NULL AND l.republished_at <= now()
    AND (e.ended_at IS NULL OR l.republished_at < e.ended_at) AND l.active_until > e.started_at)
  OR EXISTS (SELECT 1 FROM attendance saved WHERE saved.lesson_id=l.id AND saved.student_id=st.id)
)`;

// تقرير حضور مادة واحدة لأستاذها: كل طالب وكم درسًا حضر من الدروس المتاحة خلال تسجيله.
const getSubjectAttendanceForTeacher = (subjectId, stageSeasonId) =>
  pool
    .query(
      `SELECT st.id AS student_id, st.full_name,pm.mode,gm.group_id,
              discussion_group_label(gm.group_id) AS group_title,
              COUNT(l.id) AS total_lessons,
              -- يُحتسب الحضور المؤشَّر ضمن مهلة الدرس فقط، كما في تقريري الطالب والأدمن
              COUNT(a.id) FILTER (WHERE (a.listened_at <= l.active_until OR a.marking_kind='admin_late')) AS attended_lessons
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       LEFT JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=$1 AND pm.stage_season_id=$2
       LEFT JOIN group_memberships gm ON gm.student_id=st.id AND gm.subject_id=$1 AND gm.stage_season_id=$2
       LEFT JOIN effective_lessons l ON l.subject_id=$1 AND l.stage_season_id=$2
            AND ${REPORT_LESSON_ELIGIBILITY}
       LEFT JOIN attendance a ON a.lesson_id=l.id AND a.student_id=st.id
       WHERE e.stage_season_id=$2 AND e.status='active'
       GROUP BY st.id, st.full_name,pm.mode,gm.group_id
       ORDER BY gm.group_id,st.full_name`,
      [subjectId, stageSeasonId]
    )
    .then((r) => r.rows);

// ---------- لوحة المعهد ----------
const getInstituteOverview = () =>
  pool
    .query(
      `SELECT
        (SELECT COUNT(*) FROM stages WHERE is_active=true) AS active_stages,
        (SELECT COUNT(*) FROM subjects sub
         JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.is_active=true) AS subjects,
        (SELECT COUNT(*) FROM students WHERE is_active=true) AS active_students,
        (SELECT COUNT(*) FROM teachers WHERE is_active=true) AS teachers,
        (SELECT COUNT(*) FROM teachers WHERE is_active=true AND telegram_id IS NOT NULL) AS linked_teachers,
        (SELECT COUNT(*) FROM channels c
         JOIN stage_seasons ss2 ON ss2.id=c.stage_season_id AND ss2.is_active=true) AS active_channels,
        (SELECT COUNT(*) FROM effective_lessons WHERE (activated_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date = ((now() AT TIME ZONE $1))::date) AS lessons_today,
        (SELECT COUNT(*) FROM attendance WHERE (listened_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date = ((now() AT TIME ZONE $1))::date) AS attendance_today,
        (SELECT COUNT(*) FROM mubahatha_sessions WHERE (opened_at AT TIME ZONE 'UTC' AT TIME ZONE $1)::date = ((now() AT TIME ZONE $1))::date) AS sessions_today`,
      [process.env.SCHEDULE_TIMEZONE || 'Asia/Baghdad']
    )
    .then((r) => r.rows[0]);

const getInstituteStageBreakdown = () =>
  pool
    .query(
      `SELECT COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name, se.name AS season_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.stage_season_id=ss.id AND e.status='active') AS student_count,
              (SELECT COUNT(*) FROM subjects sub WHERE sub.stage_id=sg.id) AS subject_count,
              (SELECT COUNT(*) FROM effective_lessons l WHERE l.stage_season_id=ss.id) AS lesson_count,
              (SELECT COUNT(*) FROM mubahatha_groups g WHERE g.stage_season_id=ss.id) AS group_count,
              (SELECT COUNT(*) FROM channels c WHERE c.stage_season_id=ss.id) AS channel_count
       FROM stage_seasons ss
       JOIN stages sg ON sg.id=ss.stage_id
       JOIN seasons se ON se.id=ss.season_id
       WHERE ss.is_active=true
       ORDER BY sg.sort_order NULLS LAST, sg.id`
    )
    .then((r) => r.rows);

// ---------- القنوات ----------
// القناة تُربط بموسم المرحلة (stage_season) لا بالمرحلة نفسها.
// فائدة ذلك: عند بدء موسم جديد يصبح موسم المرحلة السابق غير نشط، فتتوقف قناته القديمة تلقائيًا
// عن تفعيل الدروس — وهو ما يناسب إنشاء قنوات جديدة كل موسم، ويمنع أن يُفعِّل منشورٌ قديم
// (أو تعديلٌ على منشور قديم) درسًا في الموسم الحالي بالخطأ.
const linkChannel = async (stageId, chatId, title) => {
  const season = await pool.query(
    'SELECT id FROM stage_seasons WHERE stage_id=$1 AND is_active=true LIMIT 1',
    [stageId]
  );
  if (!season.rows[0]) {
    const err = new Error('لا يوجد موسم نشط لهذه المرحلة، فلا يمكن ربط قناة بها.');
    err.code = 'NO_ACTIVE_SEASON';
    throw err;
  }
  return pool
    .query(
      `INSERT INTO channels(stage_id, stage_season_id, telegram_chat_id, title) VALUES($1,$2,$3,$4)
       ON CONFLICT (telegram_chat_id)
       DO UPDATE SET stage_id=$1, stage_season_id=$2, title=$4 RETURNING *`,
      [stageId, season.rows[0].id, chatId, title]
    )
    .then((r) => r.rows[0]);
};

// تُبقي القناة مرتبطة تلقائيًا بالموسم النشط الحالي لنفس مرحلتها.
// كان الربط السابق يتوقف بمجرد بدء موسم جديد لأن channels.stage_season_id يبقى على الموسم القديم؛
// عندها لا يصل التنفيذ أصلًا إلى فحص الملف الصوتي أو الهاشتاغ، فتبدو المشكلة كأن الصوت/الهاشتاغ لا يعملان
// في مرحلة واحدة فقط. تحديث الربط هنا يحافظ على نفس القناة والمرحلة ويمنع هذا التوقف الصامت.
const getChannelByChatId = (chatId) =>
  pool
    .query(
      `UPDATE channels c
       SET stage_season_id=ss.id
       FROM stages st
       JOIN stage_seasons ss ON ss.stage_id=st.id AND ss.is_active=true
       WHERE c.telegram_chat_id=$1
         AND st.id=c.stage_id
         AND st.is_active=true
       RETURNING c.*`,
      [chatId]
    )
    .then((r) => r.rows[0]);

const listChannelsWithStage = () =>
  pool
    .query(
      `SELECT c.*, s.name AS stage_name, ss.is_active AS season_is_active, se.name AS season_name
       FROM channels c
       JOIN stages s ON s.id = c.stage_id
       LEFT JOIN stage_seasons ss ON ss.id = c.stage_season_id
       LEFT JOIN seasons se ON se.id = ss.season_id
       ORDER BY ss.is_active DESC NULLS LAST, c.id`
    )
    .then((r) => r.rows);

// القنوات التي توقفت لأن موسمها انتهى — تُعرض للأدمن ليربط قنوات الموسم الجديد.
const listStaleChannels = (stageId) =>
  pool
    .query(
      `SELECT c.*, s.name AS stage_name FROM channels c
       JOIN stages s ON s.id = c.stage_id
       LEFT JOIN stage_seasons ss ON ss.id = c.stage_season_id
       WHERE c.stage_id=$1 AND (ss.is_active IS DISTINCT FROM true)`,
      [stageId]
    )
    .then((r) => r.rows);

const unlinkChannel = (id) => pool.query('DELETE FROM channels WHERE id=$1', [id]);

// تحدّد سبب فشل التعرّف على القناة: غير مرتبطة إطلاقًا، أم مرتبطة بموسم غير نشط.
const getChannelLinkStatus = (chatId) =>
  pool
    .query(
      `SELECT c.id,c.stage_id,c.stage_season_id,s.name AS stage_name,ss.is_active AS season_is_active
       FROM channels c JOIN stages s ON s.id=c.stage_id
       LEFT JOIN stage_seasons ss ON ss.id=c.stage_season_id
       WHERE c.telegram_chat_id=$1`,
      [chatId]
    )
    .then((r) => r.rows[0] || null);

// يسجّل وصول منشور من قناة غير مفعّلة، ويُعيد true إذا حان وقت تنبيه الأدمن
// (مرة واحدة كل ساعتين لكل قناة كحد أقصى، حتى لا يُغرق الأدمن برسائل متكررة).
const THROTTLE_MINUTES = 120;
const recordUnlinkedChannelPost = async (chatId, title, username, reason) => {
  const row = (
    await pool.query(
      `INSERT INTO unlinked_channel_posts(telegram_chat_id, chat_title, chat_username, reason)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (telegram_chat_id) DO UPDATE SET
         chat_title=$2, chat_username=$3, reason=$4,
         post_count=unlinked_channel_posts.post_count + 1, last_seen_at=now()
       RETURNING *, (last_notified_at IS NULL OR last_notified_at < now() - ($5 || ' minutes')::interval) AS should_notify`,
      [chatId, title || null, username || null, reason, THROTTLE_MINUTES]
    )
  ).rows[0];
  if (row.should_notify) {
    await pool.query('UPDATE unlinked_channel_posts SET last_notified_at=now() WHERE telegram_chat_id=$1', [chatId]);
  }
  return row.should_notify;
};

// تُستدعى عند نجاح ربط قناة بمرحلة، لتنظيف أي أثر تشخيصي سابق لها.
const clearUnlinkedChannelPost = (chatId) =>
  pool.query('DELETE FROM unlinked_channel_posts WHERE telegram_chat_id=$1', [chatId]);

const listUnlinkedChannelAlerts = () =>
  pool.query('SELECT * FROM unlinked_channel_posts ORDER BY last_seen_at DESC LIMIT 30').then((r) => r.rows);

const dismissUnlinkedChannelAlert = (chatId) =>
  pool.query('DELETE FROM unlinked_channel_posts WHERE telegram_chat_id=$1', [chatId]);

// يسجل كل channel_post / edited_channel_post فور وصوله، قبل محاولة التعرف على المادة.
// لا نخزن نص المنشور نفسه؛ فقط بيانات تشخيصية آمنة تكفي لمعرفة أين توقف المسار.
const recordChannelPostActivity = ({
  chatId, title = null, username = null, messageId = null, updateKind = 'channel_post',
  contentKind = 'other', hashtags = []
}) =>
  pool.query(
    `INSERT INTO channel_post_activity(
       telegram_chat_id,chat_title,chat_username,last_message_id,last_update_kind,last_content_kind,last_hashtags
     ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT(telegram_chat_id) DO UPDATE SET
       chat_title=EXCLUDED.chat_title,chat_username=EXCLUDED.chat_username,
       last_message_id=EXCLUDED.last_message_id,last_update_kind=EXCLUDED.last_update_kind,
       last_content_kind=EXCLUDED.last_content_kind,last_hashtags=EXCLUDED.last_hashtags,
       last_received_at=now(),last_outcome='received',last_detail=NULL,
       stage_id_at_receive=NULL,stage_season_id_at_receive=NULL,last_lesson_id=NULL,
       received_updates=channel_post_activity.received_updates+1
     RETURNING *`,
    [chatId,title,username,messageId,updateKind,contentKind,JSON.stringify(hashtags)]
  ).then((r)=>r.rows[0]);

// يحدّث نتيجة معالجة آخر منشور فقط. شرط message_id يمنع منشورًا أبطأ من أن يكتب
// نتيجته فوق منشور أحدث وصل أثناء المعالجة.
const setChannelPostActivityOutcome = (
  chatId, messageId, outcome, detail = null, { stageId = null, stageSeasonId = null, lessonId = null } = {}
) =>
  pool.query(
    `UPDATE channel_post_activity SET
       last_outcome=$3,last_detail=$4,stage_id_at_receive=$5,stage_season_id_at_receive=$6,last_lesson_id=$7
     WHERE telegram_chat_id=$1 AND ($2::bigint IS NULL OR last_message_id=$2)
     RETURNING *`,
    [chatId,messageId,outcome,detail,stageId,stageSeasonId,lessonId]
  ).then((r)=>r.rows[0]||null);

function telegramUsernameFromPublicLink(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value));
    if (!['t.me','telegram.me'].includes(u.hostname.toLowerCase())) return null;
    const first = u.pathname.split('/').filter(Boolean)[0];
    if (!first || first === 'c' || first === 'joinchat' || first.startsWith('+')) return null;
    return first.replace(/^@/,'').toLowerCase();
  } catch (_) { return null; }
}

// فحص عميق للوحة الويب: يعرض الربط الفعلي في DB، آخر منشور وصل للبوت،
// وآخر درس فُعّل من نفس Chat ID، ثم يصنف حالات التبديل/التعارض المحتملة.
const getDeepChannelDiagnostics = async () => {
  const rows = (await pool.query(
    `WITH latest_lesson AS (
       SELECT DISTINCT ON (l.source_chat_id)
         l.source_chat_id,l.id AS lesson_id,l.activated_at,l.source_message_id,
         sub.name AS lesson_subject_name,sub.stage_id AS lesson_stage_id,sg.name AS lesson_stage_name
       FROM effective_lessons l
       JOIN subjects sub ON sub.id=l.subject_id
       JOIN stages sg ON sg.id=sub.stage_id
       WHERE l.source_chat_id IS NOT NULL
       ORDER BY l.source_chat_id,l.activated_at DESC,l.id DESC
     ), lesson_stage_history AS (
       SELECT l.source_chat_id,COUNT(DISTINCT sub.stage_id)::int AS lesson_stage_count,
         string_agg(DISTINCT sg.name,'، ' ORDER BY sg.name) AS lesson_stage_names
       FROM effective_lessons l JOIN subjects sub ON sub.id=l.subject_id JOIN stages sg ON sg.id=sub.stage_id
       WHERE l.source_chat_id IS NOT NULL
       GROUP BY l.source_chat_id
     )
     SELECT c.id,c.telegram_chat_id,c.title,c.public_link,c.stage_id,s.name AS stage_name,s.is_active AS stage_is_active,
       c.stage_season_id,ss.stage_id AS season_stage_id,ss.is_active AS season_is_active,se.name AS season_name,
       a.chat_title AS observed_title,a.chat_username AS observed_username,a.last_message_id,a.last_update_kind,
       a.last_content_kind,a.last_hashtags,a.last_received_at,a.last_outcome,a.last_detail,
       a.stage_id_at_receive,a.stage_season_id_at_receive,a.last_lesson_id,a.received_updates,
       ll.lesson_id AS latest_lesson_id,ll.activated_at AS latest_lesson_at,ll.source_message_id AS latest_lesson_message_id,
       ll.lesson_subject_name,ll.lesson_stage_id,ll.lesson_stage_name,
       COALESCE(lh.lesson_stage_count,0) AS lesson_stage_count,lh.lesson_stage_names
     FROM channels c
     JOIN stages s ON s.id=c.stage_id
     LEFT JOIN stage_seasons ss ON ss.id=c.stage_season_id
     LEFT JOIN seasons se ON se.id=ss.season_id
     LEFT JOIN channel_post_activity a ON a.telegram_chat_id=c.telegram_chat_id
     LEFT JOIN latest_lesson ll ON ll.source_chat_id=c.telegram_chat_id
     LEFT JOIN lesson_stage_history lh ON lh.source_chat_id=c.telegram_chat_id
     ORDER BY s.sort_order NULLS LAST,s.id,c.id`
  )).rows;

  const linkCounts = new Map();
  for (const row of rows) {
    const key = String(row.public_link || '').trim().toLowerCase();
    if (key) linkCounts.set(key,(linkCounts.get(key)||0)+1);
  }

  return rows.map((row) => {
    const problems = [];
    const dbStageId = Number(row.stage_id);
    const seasonStageId = row.season_stage_id == null ? null : Number(row.season_stage_id);
    const observedStageId = row.stage_id_at_receive == null ? null : Number(row.stage_id_at_receive);
    const lessonStageId = row.lesson_stage_id == null ? null : Number(row.lesson_stage_id);
    const publicUsername = telegramUsernameFromPublicLink(row.public_link);
    const observedUsername = String(row.observed_username || '').replace(/^@/,'').toLowerCase() || null;
    const linkKey = String(row.public_link || '').trim().toLowerCase();

    if (seasonStageId == null) problems.push({ severity:'error', code:'season_missing', text:'القناة لا تشير إلى موسم مرحلة موجود.' });
    else if (seasonStageId !== dbStageId) problems.push({ severity:'error', code:'stage_season_mismatch', text:'المرحلة المسجلة لا تطابق مرحلة الموسم المرتبط بالقناة.' });
    if (row.stage_is_active !== true) problems.push({ severity:'error', code:'stage_inactive', text:'المرحلة نفسها غير نشطة.' });
    if (row.season_is_active !== true) problems.push({ severity:'error', code:'season_inactive', text:'الموسم المرتبط بالقناة غير نشط.' });
    if (observedStageId != null && observedStageId !== dbStageId) problems.push({ severity:'warn', code:'mapping_changed', text:'آخر منشور استلمه البوت كان أثناء ربط هذه القناة بمرحلة مختلفة.' });
    if (lessonStageId != null && lessonStageId !== dbStageId) problems.push({ severity:'error', code:'lesson_stage_mismatch', text:'آخر درس فُعّل من هذا Chat ID يعود إلى مرحلة مختلفة عن الربط الحالي.' });
    if (Number(row.lesson_stage_count) > 1) problems.push({ severity:'warn', code:'multi_stage_history', text:`هذا Chat ID فعّل دروسًا تاريخيًا لأكثر من مرحلة (${row.lesson_stage_names || 'مراحل متعددة'})؛ راجع ما إذا حصل تبديل سابق بين القنوات.` });
    if (publicUsername && observedUsername && publicUsername !== observedUsername) problems.push({ severity:'error', code:'public_link_mismatch', text:'رابط القناة الظاهر لا يطابق username الحقيقي الذي استلمه البوت من هذا Chat ID.' });
    if (linkKey && (linkCounts.get(linkKey)||0) > 1) problems.push({ severity:'warn', code:'duplicate_public_link', text:'الرابط الظاهر نفسه مستخدم لأكثر من قناة في قاعدة البيانات.' });

    const outcome = row.last_outcome;
    if (outcome === 'processing_error') problems.push({ severity:'error', code:'last_processing_error', text:'آخر منشور وصل للبوت انتهى بخطأ أثناء المعالجة.' });
    else if (['hashtag_no_match','schedule_no_match','schedule_pending','unlinked','season_inactive'].includes(outcome))
      problems.push({
        severity:'warn',
        code:'last_post_not_activated',
        text: outcome === 'schedule_pending'
          ? 'آخر منشور محفوظ مؤقتًا بانتظار اكتمال جدول اليوم وسيعاد فحصه تلقائيًا.'
          : 'آخر منشور وصل للبوت لكنه لم يفعّل درسًا.'
      });

    let health = 'ok';
    if (problems.some((p)=>p.severity==='error')) health='error';
    else if (problems.some((p)=>p.severity==='warn')) health='warn';
    else if (!row.last_received_at) health='unknown';

    return { ...row, public_username:publicUsername, health, problems };
  });
};

// ---------- الدروس ----------
const activateLesson = async (
  subjectId,
  hours = 24,
  sourceType = 'manual',
  sourceUrl = null,
  sourceChatId = null,
  sourceMessageId = null,
  activatedAt = null,
  options = {}
) => {
  // درس فُتح احتياطيًا من الجدول بلا منشور (schedule_fallback) ينتظر منشوره: عند وصول منشور
  // المادة نفسها في اليوم نفسه يُربط به بدل إنشاء درس ثانٍ، فيحتفظ الحضور المسجّل ويظهر رابط الدرس.
  if (sourceMessageId != null && sourceChatId != null && String(sourceType).startsWith('channel')) {
    const adopted = (await (options.client || pool).query(
      `UPDATE lessons SET source_type=$2, source_url=$3, source_chat_id=$4, source_message_id=$5
       WHERE id=(
         SELECT l.id FROM lessons l
         JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true
         WHERE l.subject_id=$1 AND l.source_type='schedule_fallback' AND l.source_message_id IS NULL
           AND l.schedule_date=COALESCE($6::date,(now() AT TIME ZONE 'Asia/Baghdad')::date)
           AND NOT EXISTS(SELECT 1 FROM lesson_corrections r WHERE r.lesson_id=l.id)
           AND NOT EXISTS(SELECT 1 FROM lessons x WHERE x.source_chat_id=$4 AND x.source_message_id=$5)
         ORDER BY l.id LIMIT 1 FOR UPDATE OF l SKIP LOCKED)
       RETURNING *`,
      [subjectId, sourceType, sourceUrl, sourceChatId, sourceMessageId, options.scheduleDate || null]
    )).rows[0];
    if (adopted) return adopted;
  }
  return (options.client || pool)
    .query(
      `INSERT INTO lessons(
         subject_id, stage_season_id, activated_at, active_until, source_type, source_url,
         source_chat_id, source_message_id, attendance_opened_at, schedule_date
       )
       SELECT sub.id, ss.id,
              COALESCE($7::timestamp, now()),
              COALESCE($8::timestamp,$7::timestamp, now()) + ($2 || ' hours')::interval,
              $3, $4, $5, $6, $8::timestamp, $9::date
       FROM subjects sub
       JOIN stages st ON st.id=sub.stage_id AND st.is_active=true
       JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.is_active=true
       WHERE sub.id=$1
       ON CONFLICT (source_chat_id, source_message_id)
         WHERE source_chat_id IS NOT NULL AND source_message_id IS NOT NULL
       DO UPDATE SET source_url=COALESCE(EXCLUDED.source_url, lessons.source_url)
       RETURNING *`,
      [subjectId, hours, sourceType, sourceUrl, sourceChatId, sourceMessageId, activatedAt, options.attendanceOpenedAt||null,options.scheduleDate||null]
    )
    .then((r) => r.rows[0]);
};

const getLessonBySource = (chatId, messageId) => pool.query(`
  SELECT resolved.*, (r.lesson_id IS NOT NULL AND r.canonical_lesson_id IS NULL) AS withdrawn
  FROM lessons original LEFT JOIN lesson_corrections r ON r.lesson_id=original.id
  JOIN lessons resolved ON resolved.id=COALESCE(r.canonical_lesson_id,original.id)
  WHERE original.source_chat_id=$1 AND original.source_message_id=$2
  UNION ALL SELECT l.*,false FROM effective_lessons l JOIN pending_channel_lesson_posts p ON p.lesson_id=l.id
  WHERE p.telegram_chat_id=$1 AND p.source_message_id=$2 AND p.status IN ('activated','duplicate') LIMIT 1`,[chatId,messageId]).then(r=>r.rows[0]);

// الدرس المفتوح متاح للمسجلين حاليًا، ولو انضموا أو انتقلوا بعد تفعيله.
// لا نغيّر تاريخ الالتحاق؛ يبقى أساسًا لحساب الغياب عن الدروس السابقة.
const getActiveLessonsForStudent = (stageId, studentId) =>
  pool
    .query(
      `SELECT l.id AS lesson_id, s.name AS subject_name, l.activated_at, l.active_until, l.source_url,
              (SELECT COUNT(*) FROM effective_lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number,
              false AS attended
       FROM effective_lessons l
       JOIN subjects s ON s.id = l.subject_id
       JOIN enrollments e
         ON e.stage_season_id=l.stage_season_id AND e.student_id=$2 AND e.status='active'
       JOIN students st ON st.id=e.student_id AND st.is_active=true AND st.stage_id=s.stage_id
       JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true AND ss.stage_id=s.stage_id
       JOIN stages sg ON sg.id=ss.stage_id AND sg.is_active=true
       WHERE s.stage_id = $1 AND l.active_until > now() AND l.activated_at <= now()
         AND e.started_at <= now() AND (e.ended_at IS NULL OR e.ended_at > now())
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
              (SELECT COUNT(*) FROM effective_lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number
       FROM effective_lessons l
       JOIN subjects s ON s.id=l.subject_id WHERE l.id=COALESCE((SELECT canonical_lesson_id FROM lesson_corrections WHERE lesson_id=$1),$1)`,
      [lessonId]
    )
    .then((r) => r.rows[0]);

const markAttendance = async (studentId, lessonId) => {
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(734221,1)');
    const redirect=(await c.query('SELECT canonical_lesson_id FROM lesson_corrections WHERE lesson_id=$1',[lessonId])).rows[0];
    if(redirect){if(!redirect.canonical_lesson_id){await c.query('COMMIT');return undefined;}lessonId=redirect.canonical_lesson_id;}
    const result=await c.query(
      `INSERT INTO attendance(student_id, lesson_id)
       SELECT $1, l.id
       FROM effective_lessons l
       JOIN enrollments e
         ON e.stage_season_id=l.stage_season_id AND e.student_id=$1 AND e.status='active'
       JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true
       JOIN subjects sub ON sub.id=l.subject_id AND sub.stage_id=ss.stage_id
       JOIN students st ON st.id=e.student_id AND st.is_active=true AND st.stage_id=ss.stage_id
       JOIN stages sg ON sg.id=ss.stage_id AND sg.is_active=true
       WHERE l.id=$2 AND l.active_until > now() AND l.activated_at <= now()
         AND e.started_at <= now() AND (e.ended_at IS NULL OR e.ended_at > now())
       ON CONFLICT (student_id, lesson_id) DO NOTHING RETURNING *`,
      [studentId, lessonId]
    );
    const inserted=result.rows[0];
    if(inserted){
      const lesson=(await c.query('SELECT stage_season_id,republished_at FROM effective_lessons WHERE id=$1',[lessonId])).rows[0];
      if(lesson.republished_at)await require('./absence').refreshAdministrativeAttendance(c,[studentId],lesson.stage_season_id,process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad');
    }
    await c.query('COMMIT');return inserted;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
};

// آخر الدروس المفعّلة لمرحلة معيّنة (كل موادها)، لإدارتها يدويًا: إلغاء تفعيل بالخطأ،
// إعادة فتح للتأخر، أو تحضير جماعي. تُحسب عدد الحاضرين لكل درس مباشرة.
const getRecentLessonsForStage = (stageId, limit = 15) =>
  pool
    .query(
      `SELECT l.id, l.activated_at, l.active_until, l.source_type, s.name AS subject_name,
              (l.active_until > now()) AS is_active,
              (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id=l.id) AS attended_count,
              (SELECT COUNT(*)::int FROM enrollments e WHERE e.stage_season_id=l.stage_season_id AND e.status='active') AS enrolled_count
       FROM effective_lessons l JOIN subjects s ON s.id=l.subject_id
       WHERE s.stage_id=$1
       ORDER BY l.activated_at DESC LIMIT $2`,
      [stageId, limit]
    )
    .then((r) => r.rows);

// إلغاء تفعيل كامل — لدرس فُعِّل بالخطأ (مرحلة خاطئة مثلًا). يحذف الدرس وأي حضور مسجَّل عليه
// (عبر ON DELETE CASCADE في جدول attendance)، فلا يبقى له أثر في أي تقرير.
const cancelLesson = (lessonId) =>
  pool.query('DELETE FROM lessons WHERE id=$1 RETURNING *', [lessonId]).then((r) => r.rows[0]);

// إعادة الفتح تحفظ النشر والحضور، وتنتهي بعد 24 ساعة من التفعيل الأصلي.
const reopenLesson = (lessonId) =>
  pool.query(`UPDATE lessons l SET active_until=COALESCE(l.republished_at,l.attendance_opened_at,l.activated_at) + interval '24 hours'
    FROM stage_seasons ss
    WHERE l.id=$1 AND ss.id=l.stage_season_id AND ss.is_active=true
      AND l.activated_at <= now() AND COALESCE(l.republished_at,l.attendance_opened_at,l.activated_at) + interval '24 hours' > now()
    RETURNING l.*`,[lessonId]).then(r=>r.rows[0]);

// تحضير جماعي لكل طلبة المرحلة النشطين ضمن موسم الدرس ممن لم يؤشّروا بعد؛
// يُستخدم عند رغبة الأدمن باعتبار الجميع حاضرين لهذا اليوم.
// بعد انتهاء مهلة الدرس يُسجَّل الحضور بصفة «حضور إداري متأخر» (admin_late) مع هوية المسؤول؛ وإلا يُحسب
// وقت التأشير بعد المهلة فيستبعده تقرير الطالب وحساب الغياب بينما تعدّه لوحة الإدارة (فيظهر للأدمن 10 من 10 وللطالب نقص).
const markAllPresentForLesson = async (lessonId, actorId = null) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // القفل نفسه الذي تستعمله بقية مسارات الحضور الإداري كي لا تبقى لقطة غياب قديمة.
    await c.query('SELECT pg_advisory_xact_lock(734221,1)');
    const rows = (await c.query(
      `INSERT INTO attendance(student_id, lesson_id, marking_kind, marked_by, admin_note)
       SELECT e.student_id, l.id,
              CASE WHEN l.active_until <= now() THEN 'admin_late' ELSE 'student' END,
              CASE WHEN l.active_until <= now() THEN $2::bigint END,
              CASE WHEN l.active_until <= now() THEN 'تحضير جماعي بعد انتهاء مهلة الدرس' END
       FROM effective_lessons l
       JOIN enrollments e ON e.stage_season_id=l.stage_season_id AND e.status='active'
       JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true
       JOIN subjects sub ON sub.id=l.subject_id AND sub.stage_id=ss.stage_id
       JOIN students st ON st.id=e.student_id AND st.is_active=true AND st.stage_id=ss.stage_id
       JOIN stages sg ON sg.id=ss.stage_id AND sg.is_active=true
       WHERE l.id=$1 AND l.activated_at <= now()
         AND e.started_at <= now() AND (e.ended_at IS NULL OR e.ended_at > now())
       ON CONFLICT (student_id, lesson_id) DO NOTHING RETURNING student_id, marking_kind`,
      [lessonId, actorId]
    )).rows;
    const late = rows.filter((r) => r.marking_kind === 'admin_late').map((r) => r.student_id);
    if (late.length) {
      const lesson = (await c.query('SELECT stage_season_id FROM effective_lessons WHERE id=$1', [lessonId])).rows[0];
      await require('./absence').refreshAdministrativeAttendance(c, late, lesson.stage_season_id, process.env.ATTENDANCE_TIME_ZONE || 'Asia/Baghdad');
    }
    await c.query('COMMIT');
    return rows.length;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};

const canStudentAttendLesson = (studentId, lessonId) =>
  pool
    .query(
      `SELECT 1 FROM effective_lessons l
       JOIN enrollments e ON e.stage_season_id=l.stage_season_id
       JOIN stage_seasons ss ON ss.id=l.stage_season_id AND ss.is_active=true
       JOIN subjects sub ON sub.id=l.subject_id AND sub.stage_id=ss.stage_id
       JOIN students st ON st.id=e.student_id AND st.is_active=true AND st.stage_id=ss.stage_id
       JOIN stages sg ON sg.id=ss.stage_id AND sg.is_active=true
       WHERE l.id=$2 AND e.student_id=$1 AND e.status='active'
         AND l.activated_at <= now()
         AND e.started_at <= now() AND (e.ended_at IS NULL OR e.ended_at > now())
       LIMIT 1`,
      [studentId, lessonId]
    )
    .then((r) => Boolean(r.rows[0]));

// ---------- الإجازات ----------
// الطالب يحدد تاريخ البداية وعدد الأيام؛ مجموع الموافق عليه والمعلّق لا يتجاوز 10 أيام في الموسم.
async function requestLeave(studentId, startDate, days, reason, {exception=false}={}) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > MAX_LEAVE_DAYS_PER_SEASON) throw new Error('عدد أيام الطلب يجب أن يكون بين 1 و10.');
  if(typeof exception!=='boolean')throw new Error('نوع طلب الإجازة غير صالح.');
  const note=String(reason||'').trim();
  if(note.length>1000)throw new Error('سبب الإجازة طويل جدًا (الحد 1000 حرف).');
  if(exception&&note.length<5)throw new Error('بيّن الحالة الطارئة والحرجة في سبب طلب الاستثناء.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // قفل صف الطالب يجعل فحص الرصيد وإضافة الطلب عملية ذرية حتى مع طلبين متزامنين.
    const student = await client.query('SELECT id FROM students WHERE id=$1 FOR UPDATE', [studentId]);
    if (!student.rows[0]) throw new Error('الطالب غير موجود.');

    const enrollment = await client.query(
      `SELECT e.stage_season_id
       FROM enrollments e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
       JOIN students st ON st.id=e.student_id AND st.is_active=true
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
      `SELECT COALESCE(SUM(days), 0)::integer AS used_days,
        COALESCE(SUM(days) FILTER (WHERE status IN ('approved','ended')),0)::integer AS approved_days
       FROM student_leaves
       WHERE student_id=$1 AND stage_season_id=$2 AND is_exception=false AND status IN ('pending','approved','ended')`,
      [studentId, stageSeasonId]
    );
    const usedDays = Number(usage.rows[0].used_days);
    const remainingDays = Math.max(0, MAX_LEAVE_DAYS_PER_SEASON - usedDays);
    if(exception&&Number(usage.rows[0].approved_days)<MAX_LEAVE_DAYS_PER_SEASON){
      const err=new Error('يظهر طلب الاستثناء بعد استنفاد الأيام العشرة المعتمدة فقط.');err.code='LEAVE_EXCEPTION_NOT_ELIGIBLE';throw err;
    }
    if (!exception && d > remainingDays) {
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
         AND stage_season_id=$4
         AND end_date >= $2::date AND start_date <= $2::date + ($3::int-1) LIMIT 1`,
      [studentId, startDate,d,stageSeasonId]
    );
    if (overlap.rows[0]) {
      const err = new Error('لديك إجازة قائمة أو طلب معلّق يتداخل مع هذا التاريخ.');
      err.code = 'LEAVE_OVERLAP';
      throw err;
    }

    const result = await client.query(
      `INSERT INTO student_leaves(
         student_id, stage_season_id, start_date, end_date, days, reason, status, is_exception
       )
       VALUES($1, $2, $3::date, ($3::date + ($4 - 1) * interval '1 day')::date, $4, $5, 'pending', $6)
       RETURNING *`,
      [studentId, stageSeasonId, startDate, d, note || null, exception]
    );
    await client.query('COMMIT');
    return {
      ...result.rows[0],
      used_days: usedDays + (exception?0:d),
      remaining_days: remainingDays - (exception?0:d),
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
              COALESCE(SUM(sl.days) FILTER (WHERE sl.status IN ('approved','ended') AND NOT sl.is_exception), 0)::integer AS approved_days,
              COALESCE(SUM(sl.days) FILTER (WHERE sl.status='pending' AND NOT sl.is_exception), 0)::integer AS pending_days,
              COALESCE(SUM(sl.days) FILTER (WHERE sl.status IN ('approved','ended') AND sl.is_exception), 0)::integer AS exception_days
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
        exceptionDays: Number(row.exception_days),
        exceptionEligible: approvedDays >= MAX_LEAVE_DAYS_PER_SEASON,
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

async function decideLeave(leaveId, approve, adminTelegramId, {exceptionApproval=false}={}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(734221,1)');
    await client.query('SELECT id FROM students WHERE id=(SELECT student_id FROM student_leaves WHERE id=$1) FOR UPDATE',[leaveId]);
    const before=(await client.query('SELECT * FROM student_leaves WHERE id=$1 FOR UPDATE',[leaveId])).rows[0];
    if(before?.status==='pending'&&approve){
      const valid=(await client.query(`SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id AND st.is_active=true
        JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
        WHERE e.student_id=$1 AND e.stage_season_id=$2 AND e.status='active'`,[before.student_id,before.stage_season_id])).rows[0];
      if(!valid)throw new Error('الطالب غير مسجل في موسم الإجازة النشط.');
      const {appError}=require('./integrity');
      const used=Number((await client.query("SELECT COALESCE(SUM(days),0) AS n FROM student_leaves WHERE student_id=$1 AND stage_season_id=$2 AND NOT is_exception AND status IN ('approved','ended')",[before.student_id,before.stage_season_id])).rows[0].n);
      if(before.is_exception){
        if(exceptionApproval!==true)throw appError('هذا طلب استثناء طارئ؛ يحتاج موافقة استثنائية صريحة.');
        if(used<MAX_LEAVE_DAYS_PER_SEASON)throw appError('عاد للطالب رصيد اعتيادي؛ اسحب طلب الاستثناء وقدّم طلبًا اعتياديًا.','CONFLICT',409);
      }else if(used+Number(before.days)>MAX_LEAVE_DAYS_PER_SEASON)throw appError('تتجاوز الموافقة رصيد الإجازات: عشرة أيام للموسم.');
    }
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
         WHERE student_id=$1 AND attendance_date BETWEEN $2::date AND $3::date
           AND ($4::int IS NULL OR stage_season_id=$4)`,
        [leave.student_id, leave.start_date, leave.end_date,leave.stage_season_id]
      );
      await client.query(`INSERT INTO absence_dirty_students(student_id,stage_season_id)
        SELECT DISTINCT student_id,stage_season_id FROM student_attendance_days WHERE student_id=$1
          AND ($2::int IS NULL OR stage_season_id=$2) ON CONFLICT DO NOTHING`,[leave.student_id,leave.stage_season_id]);
      // Cancel queued lesson notices if approval arrives after the broadcast was queued.
      await client.query(`UPDATE notification_outbox SET status='expired'
        WHERE status='pending' AND chat_id=(SELECT telegram_id FROM students WHERE id=$1)
          AND (dedupe_key LIKE 'daily:%' OR dedupe_key LIKE 'lesson-reminder:%')
          AND (now() AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`,
      [leave.student_id,leave.start_date,leave.end_date,process.env.ATTENDANCE_TIME_ZONE||'Asia/Baghdad']);
      // Remove unsent snapshots for this student; recomputation builds the corrected list.
      const withdrawn=await client.query(`DELETE FROM notification_outbox o WHERE o.status='pending' AND (
        (o.delivery_mark->>'kind'='student_absence' AND (o.delivery_mark->>'id')::bigint IN
          (SELECT id FROM student_attendance_days WHERE student_id=$1 AND stage_season_id=$2))
        OR (o.delivery_mark->>'kind'='admin_absence' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(o.delivery_mark->'ids') item(id)
          JOIN student_attendance_days d ON d.id=item.id::bigint WHERE d.student_id=$1 AND d.stage_season_id=$2))) RETURNING delivery_mark`,[leave.student_id,leave.stage_season_id]);
      const resetIds=withdrawn.rows.flatMap(r=>r.delivery_mark?.kind==='admin_absence'?r.delivery_mark.ids:[]);
      if(resetIds.length)await client.query('UPDATE student_attendance_days SET admin_alert_queued_at=NULL WHERE id=ANY($1::bigint[]) AND admin_alert_sent_at IS NULL',[resetIds]);
    }
    if(leave)await client.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
      VALUES($1,'leave_decision','leave',$2,$3::jsonb,$4::jsonb)`,[adminTelegramId,leaveId,JSON.stringify(before),JSON.stringify(leave)]);
    if(leave){
      const st=(await client.query('SELECT telegram_id FROM students WHERE id=$1',[leave.student_id])).rows[0];
      const range=`${leave.start_date.toISOString().slice(0,10)} → ${leave.end_date.toISOString().slice(0,10)}`;
      await require('./outbox').enqueueNotification(client,{key:`leave:${leaveId}:decision`,chatId:st.telegram_id,
        text:approve?`✅ تمت الموافقة${leave.is_exception?' الاستثنائية':''} على إجازتك (${range}).\nلا تحتسب هذه الفترة غيابًا ولا تصلك خلالها إشعارات الدروس. تسجيل الحضور يبقى ضمن مهلة الدرس فقط.`:
          `❌ لم تتم الموافقة على طلب إجازتك (${range}).`});
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
    await client.query('SELECT pg_advisory_xact_lock(734221,1)');
    await client.query('SELECT id FROM students WHERE id=$1 FOR UPDATE',[studentId]);
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
         SET status=CASE WHEN $2::date <= start_date THEN 'cancelled' ELSE 'ended' END,
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
    if(leave.status==='approved')await require('./leaveManagement').refreshLeaveAttendance(client,result.rows[0]);
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
              (SELECT COUNT(*) FROM effective_lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number
       FROM effective_lessons l
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
              (SELECT COUNT(*) FROM effective_lessons numbered
               WHERE numbered.subject_id=l.subject_id
                 AND numbered.stage_season_id=l.stage_season_id
                 AND (numbered.activated_at, numbered.id) <= (l.activated_at, l.id)) AS lesson_number
       FROM effective_lessons l
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
       JOIN effective_lessons l ON l.stage_season_id=e.stage_season_id AND l.id=$2
       WHERE st.stage_id = $1 AND st.is_active=true
          AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.lesson_id=$2 AND a.student_id=st.id)`,
      [stageId, lessonId]
    )
    .then((r) => r.rows);

// ---------- تنبيهات الغياب المتتالي ----------
// يُغلق يوم الدراسة بعد انتهاء مهلة آخر درس فيه، ثم تُحفظ لقطة لا تتغير لاحقًا.
// اليوم غياب كامل فقط عندما يكون عدد الدروس المؤشرة ضمن مهلتها صفرًا.
// معالجة تدريجية: تعالج فقط الأيام التي اكتملت مهلة دروسها ولم تُعالَج بعد،
// وتبدأ من اليوم التالي لآخر يوم مُعالَج لكل موسم بدل مسح الموسم كله في كل جولة.
// وتحسب عدّاد الغياب المتتالي وقت الإدراج فيُخزَّن ولا يُعاد حسابه لاحقًا.
async function processCompletedAttendanceDays(timeZone = 'Asia/Baghdad') {
  return require('./absence').processCompletedDays(pool,timeZone);
}

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
  // يعتمد على absence_streak المخزَّن مسبقًا، فلا يعيد حساب السلاسل بـ Window Functions كل جولة.
  return pool
    .query(
      `SELECT d.id AS attendance_day_id,
              d.student_id, st.telegram_id, st.full_name,
              COALESCE(ss.stage_name_snapshot, sg.name) AS stage_name,
              d.stage_season_id, d.absence_streak AS streak_length,
              (SELECT MIN(start_day.attendance_date) FROM student_attendance_days start_day
               WHERE start_day.student_id=d.student_id AND start_day.stage_season_id=d.stage_season_id
                 AND start_day.is_full_absence=true AND start_day.attendance_date<=d.attendance_date
                 AND start_day.attendance_date>COALESCE((SELECT MAX(b.attendance_date) FROM student_attendance_days b
                   WHERE b.student_id=d.student_id AND b.stage_season_id=d.stage_season_id
                   AND NOT b.is_full_absence AND NOT b.is_excused_leave AND b.attendance_date<=d.attendance_date),'-infinity'::date)) AS streak_start_date,
              d.attendance_date AS streak_end_date
       FROM student_attendance_days d
       JOIN students st ON st.id=d.student_id AND st.is_active=true
       JOIN enrollments e
         ON e.student_id=d.student_id AND e.stage_season_id=d.stage_season_id AND e.status='active'
       JOIN stage_seasons ss ON ss.id=d.stage_season_id
       JOIN stages sg ON sg.id=ss.stage_id
       WHERE d.is_full_absence=true
         AND NOT EXISTS(SELECT 1 FROM absence_dirty_students dirty WHERE dirty.student_id=d.student_id AND dirty.stage_season_id=d.stage_season_id)
         AND d.absence_streak=$1
         AND d.${sentColumn} IS NULL
         ${alertKind === 'admin' ? 'AND d.admin_alert_queued_at IS NULL' : ''}
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

// يوزر تيليجرام تحديثه أفضل جهد عند كل تفاعل؛ لا يفشل التفاعل إن تعذّر الحفظ.
const syncStudentUsername = (telegramId, username) =>
  pool
    .query(
      `UPDATE students SET telegram_username=$2
       WHERE telegram_id=$1 AND telegram_username IS DISTINCT FROM $2`,
      [telegramId, username || null]
    )
    .catch(() => {});

// ---------- إحصائيات استمرار الطلبة لكل مرحلة ----------
// الحدّان 3 و10 يومًا هما نفس حدّي تنبيه الطالب وتنبيه الأدمن في نظام الغياب أعلاه،
// فيُعاد استخدامهما هنا للاتساق: أقل من 3 = مستمر، من 3 إلى 9 = متلكئ، 10 فأكثر أو غير نشط = تارك.
// تُؤخذ آخر قيمة absence_streak مسجَّلة للطالب (عبر كل مواسمه) كمؤشر لحالته الحالية.
const STUDENT_LAGGING_STREAK = 3;
const STUDENT_DROPPED_STREAK = 10;
const getStageStudentBreakdown = () =>
  pool
    .query(
      `WITH latest_streak AS (
         SELECT DISTINCT ON (student_id) student_id, absence_streak
         FROM student_attendance_days
         ORDER BY student_id, attendance_date DESC
       )
       SELECT sg.id AS stage_id, sg.name AS stage_name,
              COUNT(st.id)::int AS total,
              COUNT(*) FILTER (WHERE st.is_active AND COALESCE(ls.absence_streak,0) < $1)::int AS continuing,
              COUNT(*) FILTER (WHERE st.is_active AND COALESCE(ls.absence_streak,0) BETWEEN $1 AND $2-1)::int AS lagging,
              COUNT(*) FILTER (WHERE NOT st.is_active OR COALESCE(ls.absence_streak,0) >= $2)::int AS dropped
       FROM stages sg
       JOIN students st ON st.stage_id=sg.id
       LEFT JOIN latest_streak ls ON ls.student_id=st.id
       GROUP BY sg.id, sg.name
       ORDER BY sg.name`,
      [STUDENT_LAGGING_STREAK, STUDENT_DROPPED_STREAK]
    )
    .then((r) => r.rows);

// قائمة الطلبة الذين يحتاجون متابعة الآن (متلكئون بحضورهم، ولا يزالون نشطين مسجَّلين).
const getAbsenceWatchlist = () =>
  pool
    .query(
      `WITH latest_streak AS (
         SELECT DISTINCT ON (d.student_id) d.student_id, d.stage_season_id, d.absence_streak
         FROM student_attendance_days d
         ORDER BY d.student_id, d.attendance_date DESC
       )
       SELECT st.id AS student_id, st.full_name, st.telegram_username, st.telegram_id,
              sg.name AS stage_name, ls.stage_season_id, ls.absence_streak
       FROM latest_streak ls
       JOIN students st ON st.id=ls.student_id AND st.is_active=true
       JOIN stages sg ON sg.id=st.stage_id
       WHERE ls.absence_streak>=$1
       ORDER BY ls.absence_streak DESC, st.full_name`,
      [STUDENT_LAGGING_STREAK]
    )
    .then((r) => r.rows);

// عدد الدروس الفائتة لكل مادة، لمجموعة طلبة محدَّدين (تُستدعى بعد جلب watchlist).
const getMissedLessonsBySubject = (studentIds) => {
  const ids = studentIds.map(Number).filter(Number.isSafeInteger);
  if (ids.length === 0) return Promise.resolve([]);
  return pool
    .query(
      `SELECT st.id AS student_id, sub.name AS subject_name,
              COUNT(l.id)::int AS total_lessons, COUNT(a.id)::int AS attended
       FROM students st
       JOIN enrollments e ON e.student_id=st.id AND e.status='active'
       JOIN stage_seasons ss ON ss.id=e.stage_season_id
       JOIN subjects sub ON sub.stage_id=ss.stage_id
       JOIN effective_lessons l ON l.subject_id=sub.id AND l.stage_season_id=ss.id
         AND l.activated_at>=e.started_at AND (e.ended_at IS NULL OR l.activated_at<=e.ended_at)
       LEFT JOIN attendance a ON a.student_id=st.id AND a.lesson_id=l.id
       WHERE st.id = ANY($1::int[])
       GROUP BY st.id, sub.name
       HAVING COUNT(l.id)>COUNT(a.id)
       ORDER BY st.id, sub.name`,
      [ids]
    )
    .then((r) => r.rows);
};

// ---------- المواسم الدراسية ----------
const listSeasons = () =>
  pool
    .query(
      `SELECT s.id, s.name, s.created_at,
              EXISTS(SELECT 1 FROM stage_seasons ss WHERE ss.season_id=s.id AND ss.is_active=true) AS is_current
       FROM seasons s ORDER BY s.created_at DESC, s.id DESC`
    )
    .then((r) => r.rows);

// ---------- أداء الأستاذ ----------
// سجل مباحثاته: كل موعد أسبوعي مرَّ عليه تاريخ محدَّد، وهل عُقدت الجلسة أم أُجِّلت.
const getTeacherSessionLog = (teacherId, limit = 60) =>
  pool
    .query(
      `SELECT sub.name AS subject_name, g.title AS group_title, sd.scheduled_date,
              CASE WHEN sd.decision='confirmed' THEN true
                   WHEN sd.decision='postponed' THEN false
                   ELSE NULL END AS held,
              ms.is_closed
       FROM schedule_slots s
       JOIN slot_decisions sd ON sd.slot_id=s.id
       JOIN mubahatha_groups g ON g.id=s.group_id
       JOIN subjects sub ON sub.id=s.subject_id
       LEFT JOIN mubahatha_sessions ms ON ms.id=sd.session_id
       WHERE s.teacher_id=$1
       ORDER BY sd.scheduled_date DESC
       LIMIT $2`,
      [teacherId, limit]
    )
    .then((r) => r.rows);

// تقاريره: كم دقَّق بنفسه، وكم بقي بلا درجة من تقارير مواده الحالية.
const getTeacherReportStats = (teacherId) =>
  pool
    .query(
      `SELECT COUNT(*) FILTER (WHERE sr.graded_at IS NOT NULL AND sr.graded_by=t.telegram_id)::int AS graded_by_teacher,
              COUNT(*) FILTER (WHERE sr.graded_at IS NULL)::int AS ungraded
       FROM teaching_assignments ta
       JOIN teachers t ON t.id=ta.teacher_id
       JOIN student_reports sr ON sr.subject_id=ta.subject_id AND sr.stage_season_id=ta.stage_season_id
       WHERE ta.teacher_id=$1`,
      [teacherId]
    )
    .then((r) => r.rows[0] || { graded_by_teacher: 0, ungraded: 0 });

// امتحاناته المنشورة فعليًا (وليست مجرَّد مسودة).
const getTeacherExamStats = (teacherId) =>
  pool
    .query(`SELECT COUNT(*) FILTER (WHERE status='published')::int AS published,
                    COUNT(*)::int AS total
             FROM exams WHERE teacher_id=$1`, [teacherId])
    .then((r) => r.rows[0] || { published: 0, total: 0 });

// ---------- واجهة الطالب وسجل الموسم الحالي ----------
const recordStudentUiMessage = (studentId, messageId, messageKind = 'screen') =>
  pool.query(
    `INSERT INTO student_ui_messages(student_id, message_id, message_kind) VALUES($1,$2,$3)
     ON CONFLICT (student_id, message_id)
     DO UPDATE SET message_kind=EXCLUDED.message_kind`,
    [studentId, messageId, messageKind === 'menu' ? 'menu' : 'screen']
  );

// رسائل القائمة السفلية تُحفظ عند فتح الشاشات الداخلية، وتُستبدل فقط عند إرسال قائمة جديدة.
const takeStudentUiMessages = (studentId, includeMenu = false, exceptMessageId = null) =>
  pool
    .query(
      `DELETE FROM student_ui_messages
       WHERE student_id=$1 AND ($2::boolean OR message_kind <> 'menu')
         AND ($3::bigint IS NULL OR message_id <> $3::bigint)
       RETURNING message_id`,
      [studentId, Boolean(includeMenu), exceptMessageId]
    )
    .then((r) => r.rows.map((row) => Number(row.message_id)).filter(Number.isSafeInteger));

// ردود عابرة: تُسجَّل عند إرسالها وتُؤخذ (وتُحذف من الجدول) عند التفاعل التالي.
const recordTransientMessage = (chatId, messageId) =>
  pool.query(
    'INSERT INTO transient_ui_messages(chat_id, message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [chatId, messageId]
  );

const takeTransientMessages = (chatId, keepMessageId = null) =>
  pool
    .query(
      `DELETE FROM transient_ui_messages
       WHERE chat_id=$1 AND ($2::bigint IS NULL OR message_id <> $2::bigint)
       RETURNING message_id`,
      [chatId, keepMessageId]
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
      `SELECT sl.id, sl.start_date, sl.end_date, sl.days, sl.is_exception
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
    approvedLeaveDays: leaveResult.rows.filter(l=>!l.is_exception).reduce((sum, leave) => sum + Number(leave.days), 0),
    exceptionLeaveDays: leaveResult.rows.filter(l=>l.is_exception).reduce((sum, leave) => sum + Number(leave.days), 0),
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
              COUNT(a.id) FILTER (WHERE (a.listened_at <= l.active_until OR a.marking_kind='admin_late')) AS attended_lessons,
              COALESCE(
                STRING_AGG(
                  TO_CHAR(timezone($2, a.listened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI'),
                  ' | ' ORDER BY a.listened_at
                ) FILTER (WHERE (a.listened_at <= l.active_until OR a.marking_kind='admin_late')),
                ''
              ) AS attendance_dates,
              COALESCE((
                SELECT SUM(sl.days) FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND NOT sl.is_exception AND sl.status IN ('approved','ended')
              ), 0)::integer AS approved_leave_days,
              COALESCE((
                SELECT STRING_AGG(
                  TO_CHAR(sl.start_date, 'YYYY-MM-DD') || ' → ' || TO_CHAR(sl.end_date, 'YYYY-MM-DD') ||
                  ' (' || sl.days || ' يوم' || CASE WHEN sl.is_exception THEN '، استثناء طارئ' ELSE '' END || ')',
                  ' | ' ORDER BY sl.start_date, sl.id
                )
                FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND sl.status IN ('approved','ended')
              ), '') AS approved_leave_periods
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       JOIN ranked r ON r.id=e.stage_season_id
       JOIN subjects sub ON sub.stage_id=r.stage_id
       LEFT JOIN effective_lessons l ON l.subject_id=sub.id AND l.stage_season_id=r.id
              AND ${REPORT_LESSON_ELIGIBILITY}
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
              COUNT(a.id) FILTER (WHERE (a.listened_at <= l.active_until OR a.marking_kind='admin_late')) AS attended_lessons,
              COALESCE(
                STRING_AGG(
                  TO_CHAR(timezone(${timeZoneParam}, a.listened_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI'),
                  ' | ' ORDER BY a.listened_at
                ) FILTER (WHERE (a.listened_at <= l.active_until OR a.marking_kind='admin_late')),
                ''
              ) AS attendance_dates,
              COALESCE((
                SELECT SUM(sl.days) FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND NOT sl.is_exception AND sl.status IN ('approved','ended')
              ), 0)::integer AS approved_leave_days,
              COALESCE((
                SELECT STRING_AGG(
                  TO_CHAR(sl.start_date, 'YYYY-MM-DD') || ' → ' || TO_CHAR(sl.end_date, 'YYYY-MM-DD') ||
                  ' (' || sl.days || ' يوم' || CASE WHEN sl.is_exception THEN '، استثناء طارئ' ELSE '' END || ')',
                  ' | ' ORDER BY sl.start_date, sl.id
                )
                FROM student_leaves sl
                WHERE sl.student_id=st.id AND sl.stage_season_id=r.id AND sl.status IN ('approved','ended')
              ), '') AS approved_leave_periods
       FROM enrollments e
       JOIN students st ON st.id=e.student_id
       JOIN ranked r ON r.id=e.stage_season_id
       JOIN subjects sub ON sub.stage_id=r.stage_id
       LEFT JOIN effective_lessons l ON l.subject_id=sub.id AND l.stage_season_id=r.id
              AND ${REPORT_LESSON_ELIGIBILITY}
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

// ---------------- منشورات القنوات المعلقة بانتظار الجدول ----------------
async function queuePendingChannelLessonPost({
  chatId,
  messageId,
  stageId,
  stageSeasonId,
  lessonDate,
  sourceUrl = null,
  contentKind = null,
  receivedAt = null,
  autoMatch = false,
  contentText = null,
  titleMessageId = null,
}, queryable=pool) {
  if (!Number.isFinite(Number(chatId)) || !Number.isFinite(Number(messageId))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lessonDate || ''))) return null;
  return (
    await queryable.query(
      `INSERT INTO pending_channel_lesson_posts(
         telegram_chat_id,source_message_id,stage_id,stage_season_id,lesson_date,source_url,content_kind,received_at,auto_match,content_text,title_message_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamp,now()),$9,$10,$11)
       ON CONFLICT(telegram_chat_id,source_message_id) DO UPDATE SET
         source_url=COALESCE(EXCLUDED.source_url,pending_channel_lesson_posts.source_url),
         content_kind=COALESCE(EXCLUDED.content_kind,pending_channel_lesson_posts.content_kind)
       RETURNING *`,
      [chatId,messageId,stageId,stageSeasonId,lessonDate,sourceUrl,contentKind,receivedAt,autoMatch,String(contentText||'').slice(0,4096),titleMessageId]
    )
  ).rows[0] || null;
}

async function getPendingChannelLessonPosts(stageSeasonId, lessonDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lessonDate || ''))) return [];
  return (
    await pool.query(
      `SELECT p.*,c.title AS channel_title
       FROM pending_channel_lesson_posts p
       LEFT JOIN channels c ON c.telegram_chat_id=p.telegram_chat_id
       WHERE p.stage_season_id=$1 AND p.lesson_date<=$2::date AND p.status='pending'
       ORDER BY p.received_at,p.source_message_id,p.id`,
      [stageSeasonId,lessonDate]
    )
  ).rows;
}

async function getPendingChannelLessonStageSeasonsForDate(lessonDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lessonDate || ''))) return [];
  return (
    await pool.query(
      `SELECT DISTINCT p.stage_season_id
       FROM pending_channel_lesson_posts p
       JOIN stage_seasons ss ON ss.id=p.stage_season_id AND ss.is_active=true
       JOIN stages st ON st.id=ss.stage_id AND st.is_active=true
       WHERE p.lesson_date<=$1::date AND p.status='pending'
       ORDER BY p.stage_season_id`,
      [lessonDate]
    )
  ).rows.map((row)=>Number(row.stage_season_id));
}

async function getLessonScheduleRecoveryState(stageSeasonId, lessonDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lessonDate || ''))) {
    return { scheduled_count:0, latest_schedule_change:null };
  }
  const row = (
    await pool.query(
      `SELECT COUNT(*)::int AS scheduled_count,MAX(created_at) AS latest_schedule_change
       FROM lesson_schedule_entries
       WHERE stage_season_id=$1 AND lesson_date=$2::date`,
      [stageSeasonId,lessonDate]
    )
  ).rows[0];
  return row || { scheduled_count:0, latest_schedule_change:null };
}

async function resolvePendingChannelLessonPost(id, lessonId, subjectId, status='activated') {
  if (!['activated','duplicate'].includes(status)) throw new Error('حالة معالجة المنشور المعلق غير صالحة.');
  return (
    await pool.query(
      `UPDATE pending_channel_lesson_posts
       SET status=$4,lesson_id=$2,resolved_subject_id=$3,resolved_at=now()
       WHERE id=$1 AND status='pending'
       RETURNING *`,
      [id,lessonId,subjectId,status]
    )
  ).rows[0] || null;
}

async function resolvePendingChannelLessonPostBySource(chatId, messageId, lessonId, subjectId, status='activated') {
  if (!['activated','duplicate'].includes(status)) throw new Error('حالة معالجة المنشور المعلق غير صالحة.');
  return (
    await pool.query(
      `UPDATE pending_channel_lesson_posts
       SET status=$5,lesson_id=$3,resolved_subject_id=$4,resolved_at=now()
       WHERE telegram_chat_id=$1 AND source_message_id=$2 AND status='pending'
       RETURNING *`,
      [chatId,messageId,lessonId,subjectId,status]
    )
  ).rows[0] || null;
}

// ---------------- جدول الدروس الدراسي ----------------
function addMonthsIso(dateIso, months) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function lessonScheduleDates(startIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const endExclusive = new Date(`${addMonthsIso(startIso, 6)}T00:00:00Z`);
  const dates = [];
  for (const d = new Date(start); d < endExclusive; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day === 4 || day === 5) continue;
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function normalizeDateString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function getLessonSchedule(stageSeasonId) {
  const ss = (await pool.query(`
    SELECT
      ss.id AS stage_season_id,
      ss.stage_id,
      TO_CHAR(ss.started_at, 'YYYY-MM-DD') AS start_date,
      st.name AS stage_name,
      se.name AS season_name
    FROM stage_seasons ss
    JOIN stages st ON st.id=ss.stage_id
    JOIN seasons se ON se.id=ss.season_id
    WHERE ss.id=$1
  `, [stageSeasonId])).rows[0];
  if (!ss) return null;
  const subjects = (await pool.query('SELECT id,name FROM subjects WHERE stage_id=$1 ORDER BY id', [ss.stage_id])).rows;
  const entries = (await pool.query(`SELECT id,subject_id,lesson_date::text AS lesson_date
    FROM lesson_schedule_entries WHERE stage_season_id=$1 ORDER BY lesson_date,subject_id`, [stageSeasonId])).rows;
  const startDate = normalizeDateString(ss.start_date) || '';
  return { ...ss, start_date: startDate, end_date_exclusive: addMonthsIso(startDate, 6), subjects, entries, dates: lessonScheduleDates(startDate) };
}

// المواد المجدولة للنشر في تاريخ محدد داخل موسم المرحلة.
// يُستعمل كمسار ثانٍ مكمّل للهاشتاغ عند نشر الدرس في القناة من دون هاشتاغ.
async function getScheduledSubjectsForDate(stageSeasonId, lessonDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lessonDate || ''))) return [];
  return (await pool.query(`
    SELECT DISTINCT sub.id, sub.name, sub.hashtag, lse.lesson_date::text AS lesson_date
    FROM lesson_schedule_entries lse
    JOIN subjects sub ON sub.id=lse.subject_id
    JOIN stage_seasons ss ON ss.id=lse.stage_season_id AND ss.stage_id=sub.stage_id
    WHERE lse.stage_season_id=$1 AND lse.lesson_date=$2
    ORDER BY sub.id`, [stageSeasonId, lessonDate])).rows;
}

// المواد المجدولة التي لم تُفعّل بعد في يوم النشر.
// الهاشتاغ يستطيع تفعيل أي مادة مباشرة، لذلك تُستبعد المادة هنا إذا كان لها درس
// مفعّل بالفعل في هذا الموسم في تاريخ اليوم، وبذلك يمكن دمج الهاشتاغ مع الجدول
// حتى عندما تكون في اليوم نفسه 3 مواد أو أكثر.
async function getPendingScheduledSubjectsForDate(stageSeasonId, lessonDate, queryable=pool) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lessonDate || ''))) return [];
  return (await queryable.query(`
    SELECT DISTINCT sub.id, sub.name, sub.hashtag, lse.lesson_date::text AS lesson_date
    FROM lesson_schedule_entries lse
    JOIN subjects sub ON sub.id=lse.subject_id
    JOIN stage_seasons ss ON ss.id=lse.stage_season_id AND ss.stage_id=sub.stage_id
    WHERE lse.stage_season_id=$1 AND lse.lesson_date=$2
      AND NOT EXISTS (
        SELECT 1
        FROM effective_lessons l
        WHERE l.stage_season_id=$1
          AND l.subject_id=sub.id
          AND COALESCE(l.schedule_date,(l.activated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Baghdad')::date)=$2::date
          AND NOT (l.source_type='schedule_fallback' AND l.source_message_id IS NULL)
      )
    ORDER BY sub.id`, [stageSeasonId, lessonDate])).rows;
}
async function setLessonScheduleEntry(stageSeasonId,subjectId,lessonDate,checked) {
  const date=String(lessonDate||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ الجدول غير صالح.');
  const ss=(await pool.query(`SELECT id, stage_id, TO_CHAR(started_at, 'YYYY-MM-DD') AS start_date
    FROM stage_seasons WHERE id=$1`, [stageSeasonId])).rows[0];
  if(!ss) throw new Error('الموسم الدراسي غير موجود.');
  if(!(await pool.query('SELECT id FROM subjects WHERE id=$1 AND stage_id=$2', [subjectId, ss.stage_id])).rows[0])
    throw new Error('المادة لا تنتمي إلى المرحلة المختارة.');
  const normalizedStartDate = normalizeDateString(ss.start_date) || '';
  if(!new Set(lessonScheduleDates(normalizedStartDate)).has(date))
    throw new Error('يمكن اختيار أيام الدراسة فقط، مع استبعاد الخميس والجمعة.');
  if(checked) {
    const inserted = await pool.query(`INSERT INTO lesson_schedule_entries(stage_season_id,subject_id,lesson_date)
      VALUES($1,$2,$3) ON CONFLICT(stage_season_id,subject_id,lesson_date) DO NOTHING RETURNING *`,
      [stageSeasonId, subjectId, date]);
    const row = inserted.rows[0];
    return row ? { ...row, lesson_date: normalizeDateString(row.lesson_date) } : { stage_season_id: stageSeasonId, subject_id: subjectId, lesson_date: date };
  }
  await pool.query('DELETE FROM lesson_schedule_entries WHERE stage_season_id=$1 AND subject_id=$2 AND lesson_date=$3',
    [stageSeasonId,subjectId,date]);
  return { stage_season_id: stageSeasonId, subject_id: subjectId, lesson_date: date, checked: false };
}

module.exports = {
  pool,
  initSchema,
  isStudentRegistrationOpen,
  setStudentRegistrationOpen,
  addStage,
  listStages,
  listRegistrationStages,
  setStageRegistrationVisible,
  listAllStages,
  getStageById,
  updateStageName,
  setStageType,
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
  findActiveStudentByName,
  markWelcomed,
  generateStudentTransferCode,
  transferStudentAccount,
  confirmOfficialStudent,
  searchStudents,
  getStudentById,
  updateStudentName,
  updateStudentStage,
  archiveStudent,
  hardDeleteStudent,
  getStudentsByStage,
  getEligibleStudentsForStage,
  claimDailyLessonRecipients,
  getStudentActiveStageSeason,
  listStageSeasons,
  getLessonSchedule,
  getScheduledSubjectsForDate,
  getPendingScheduledSubjectsForDate,
  queuePendingChannelLessonPost,
  getPendingChannelLessonPosts,
  getPendingChannelLessonStageSeasonsForDate,
  getLessonScheduleRecoveryState,
  resolvePendingChannelLessonPost,
  resolvePendingChannelLessonPostBySource,
  setLessonScheduleEntry,
  listStudentSeasons,
  startSeasonForStages,
  getPendingTransition,
  resolveStudentTransition,
  linkChannel,
  getChannelByChatId,
  listChannelsWithStage,
  listStaleChannels,
  getInstituteOverview,
  getInstituteStageBreakdown,
  addTeacher,
  getTeacherByTelegramId,
  getTeacherById,
  linkTeacherAccount,
  listTeachers,
  updateTeacherName,
  setTeacherActive,
  regenerateTeacherCode,
  hardDeleteTeacher,
  assignTeacherToSubject,
  unassignTeacherFromSubject,
  listTeacherSubjects,
  listAllActiveSubjects,
  listSubjectTeachers,
  getSubjectAttendanceForTeacher,
  unlinkChannel,
  getChannelLinkStatus,
  recordUnlinkedChannelPost,
  clearUnlinkedChannelPost,
  listUnlinkedChannelAlerts,
  dismissUnlinkedChannelAlert,
  recordChannelPostActivity,
  setChannelPostActivityOutcome,
  getDeepChannelDiagnostics,
  activateLesson,
  getLessonBySource,
  getActiveLessonsForStudent,
  claimDailyLessonNotification,
  releaseDailyLessonNotification,
  getLessonById,
  markAttendance,
  getRecentLessonsForStage,
  cancelLesson,
  reopenLesson,
  markAllPresentForLesson,
  REPORT_LESSON_ELIGIBILITY,
  canStudentAttendLesson,
  getLessonsNeedingReminder,
  markReminderSent,
  getNonAttendedStudentsForLesson,
  processCompletedAttendanceDays,
  getStudentAbsenceAlertCandidates,
  getAdminAbsenceAlertCandidates,
  markStudentAbsenceAlertSent,
  syncStudentUsername,
  getStageStudentBreakdown,
  getAbsenceWatchlist,
  getMissedLessonsBySubject,
  listSeasons,
  getTeacherSessionLog,
  getTeacherReportStats,
  getTeacherExamStats,
  markAdminAbsenceAlertsSent,
  recordStudentUiMessage,
  takeStudentUiMessages,
  recordTransientMessage,
  takeTransientMessages,
  getStudentCurrentSeasonActivity,
  getCurrentSeasonLeaveUsage,
  requestLeave,
  getLeaveById,
  decideLeave,
  adjustLeave: require('./leaveManagement').createLeaveManagement(pool).adjustLeave,
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
