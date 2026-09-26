// index.js — بوت تسجيل حضور الطلبة عبر تليجرام
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const studies = require('./studies');
const instituteLinks = require('./instituteLinks').createInstituteLinks(db.pool);
const { initIntegritySchema } = require('./integrity');
const access = require('./access').createAccess(db.pool);
const adminData = require('./adminData').createAdminData(db, studies);
const scheduler = require('./scheduler').createScheduler({pool:db.pool,studies});
const studentReminders = require('./studentReminders');
const { randomUUID } = require('node:crypto');
const {
  extractFirstUrl,
  extractHashtags,
  formatSeasonLabel,
  hasLessonContent,
  normalizeHashtag,
  telegramMessageLink,
} = require('./utils');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isSafeInteger);

// كل درس مفعّل (يدويًا أو تلقائيًا من القناة) يبقى متاحًا لتسجيل الحضور لهذه المدة
const LESSON_ACTIVE_HOURS = Number(process.env.LESSON_ACTIVE_HOURS || 24);
// التقارير اليومية وحدود الغياب تُحسب بحسب توقيت بغداد افتراضيًا.
const ATTENDANCE_TIME_ZONE = process.env.ATTENDANCE_TIME_ZONE || 'Asia/Baghdad';
const MAX_LEAVE_DAYS_PER_SEASON = 10;
if (!BOT_TOKEN) {
  console.error('خطأ: يجب ضبط متغير البيئة BOT_TOKEN');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('خطأ: يجب ضبط متغير البيئة DATABASE_URL');
  process.exit(1);
}
if (!Number.isFinite(LESSON_ACTIVE_HOURS) || LESSON_ACTIVE_HOURS <= 0) {
  console.error('خطأ: LESSON_ACTIVE_HOURS يجب أن يكون رقمًا موجبًا');
  process.exit(1);
}
try {
  new Intl.DateTimeFormat('en', { timeZone: ATTENDANCE_TIME_ZONE }).format();
} catch (_) {
  console.error('خطأ: ATTENDANCE_TIME_ZONE يجب أن يكون اسم منطقة زمنية صالحًا مثل Asia/Baghdad');
  process.exit(1);
}
if (ADMIN_IDS.length === 0) {
  console.warn('تحذير: لم يتم ضبط أي معرف صحيح داخل ADMIN_IDS؛ لن تعمل لوحة الأدمن.');
}

const bot = new Telegraf(BOT_TOKEN);
// Dedicated sender keeps backups outside automatic UI message cleanup.
const { BUTTON: BACKUP_BUTTON, initBackupSchema, createBackups } = require('./backups');
const backupTelegram = require('./backups').boundedTelegram(new (require('telegraf').Telegram)(BOT_TOKEN));
const backups = createBackups({pool:db.pool,telegram:backupTelegram,adminIds:ADMIN_IDS});
const {STUDENT_BUTTON: GUIDE_BUTTON, ADMIN_BUTTON: GUIDE_ADMIN_BUTTON}=require('./studentGuideContent');
const {initStudentGuideSchema,createStudentGuide}=require('./studentGuide');
const studentGuide=createStudentGuide({pool:db.pool,telegram:bot.telegram});
bot.use(require('./updateGate').createUpdateGate());
bot.use(async(ctx,next)=>{
  if(!['group','supergroup'].includes(ctx.chat?.type)||ctx.update.my_chat_member)return next();
  const approved=(await db.pool.query('SELECT 1 FROM approved_group_chats WHERE chat_id=$1 AND approved_at IS NOT NULL',[ctx.chat.id])).rowCount>0;
  if(approved)return next();
  try{await bot.telegram.leaveChat(ctx.chat.id);}catch(err){console.warn('تعذر مغادرة مجموعة غير معتمدة:',err.description||err.message);}
});

// طابور إرسال عام ينظّم معدّل الرسائل ويعالج 429؛ يُستعمل للبث الجماعي.
const { createTelegramQueue, PRIORITY } = require('./telegramQueue');
const tgQueue = createTelegramQueue(bot.telegram);
const outboxWorker = require('./outbox').createOutboxWorker(db.pool,tgQueue,bot.telegram.deleteMessage.bind(bot.telegram));
const broadcasts = require('./broadcasts').createBroadcasts(db.pool);
// Both background sends and replies share the same rate limiter.
for(const method of ['sendMessage','sendDocument','sendPhoto']) bot.telegram[method]=tgQueue[method];
bot.use((ctx,next)=>{
  for(const method of ['sendMessage','sendDocument','sendPhoto']) ctx.telegram[method]=(chatId,content,extra)=>tgQueue[method](chatId,content,extra,{priority:PRIORITY.high});
  return next();
});
// أفضل جهد: يُحدَّث يوزر تيليجرام المخزَّن للطالب كلما تفاعل، بلا انتظار ودون كسر الرد لو فشل.
bot.use((ctx,next)=>{
  if(ctx.from?.id)db.syncStudentUsername(ctx.from.id,ctx.from.username||null);
  return next();
});
let adminServer;

// حارس وضع المعاينة: يمنع أي عملية كتابة قبل أن تصل لمعالجها.
// أزرار الكتابة (تسجيل حضور، منح درجة، إرسال، اختيار نمط، حذف...) تُعرض معطّلة.
// أزرار الاستعراض والتنقل تمر بحرية. القائمة تُبنى من بادئات معرّفات أزرار الكتابة.
const PREVIEW_BLOCKED_ACTION_PREFIXES = [
  'attend', 'mub_attend', 'mub_end_attend', 'mub_finish',
  'pm_set', 'pm_join', 'pm_switch', 'pm_switchok',
  'rep_send', 'stex_start', 'stex_ans',
  'sr_item', 'sr_apply', 'sr_manual', 'lr_grade', 'gr_edit',
  'season_choice', 'leave_approve', 'leave_reject', 'leave_cancel', 'leave_open',
  'noop_activity',
  'slot_yes', 'slot_no', 'confirm_official_student',
];
// خطوات الإدخال النصي التي تكتب في القاعدة (تُمنع في المعاينة)
const PREVIEW_BLOCKED_TEXT_ACTIONS = new Set([
  'leave_awaiting_days', 'leave_awaiting_reason', 'student_report_upload',
  'report_item_score', 'teacher_report_score', 'grade_override', 'lessons_score',
  'teacher_slot_postpone_reason',
]);
// أزرار قوائم الطالب/الأستاذ التي تُنفّذ عمليات (لا مجرد عرض)
const PREVIEW_BLOCKED_HEARS = new Set(['🌴 طلب إجازة', '📄 إرسال تقرير', '📣 رسالة جماعية']);

bot.use(async (ctx, next) => {
  if (!isInPreview(ctx)) return next();

  // أي لوحة ReplyKeyboard تُعرض أثناء المعاينة يجب أن تحتفظ دائمًا بزر الخروج.
  // بعض شاشات الطالب/الأستاذ تعيد القائمة الأصلية بعد العرض، وكان ذلك يجعل زر الخروج يختفي.
  const originalReply = ctx.reply.bind(ctx);
  ctx.reply = (text, extra = undefined) => {
    if (extra?.reply_markup?.keyboard && Array.isArray(extra.reply_markup.keyboard)) {
      const hasExit = extra.reply_markup.keyboard.some(row =>
        Array.isArray(row) && row.some(btn => (typeof btn === 'string' ? btn : btn?.text) === '🚪 الخروج من المعاينة')
      );
      if (!hasExit) {
        extra = {
          ...extra,
          reply_markup: {
            ...extra.reply_markup,
            keyboard: [...extra.reply_markup.keyboard, [{ text: '🚪 الخروج من المعاينة' }]],
            resize_keyboard: true,
            is_persistent: true,
          },
        };
      }
    }
    return originalReply(text, extra);
  };

  // Unknown actions are read-only denied in preview, including forged callbacks
  // from a different role. New write handlers cannot accidentally bypass a denylist.
  const previewReads = new Set(['pv_exit','menu_today','menu_report','pm_subj','sr_subj','sr_group','sr_page','sr_stu',
    'gr_subj','gr_page','gr_stu','teacher_att','teacher_att_group','tg_subj','tg_group','ts_subj','ts_group','ex_subj','ex_view',
    'stex_list','rep_subj','noop','noop_activity','il_view','student_grades','student_report_marks']);
  if (ctx.callbackQuery?.data && !previewReads.has(ctx.callbackQuery.data.split(':')[0])) {
    return ctx.answerCbQuery('👁️ المعاينة للقراءة فقط؛ اخرج منها لإجراء تعديلات.',{show_alert:true});
  }
  if (ctx.message && !ctx.message.text) return ctx.reply('👁️ لا يمكن إرسال ملفات أو إجراء تعديل أثناء المعاينة.');

  // أزرار الكتابة عبر callback
  const data = ctx.callbackQuery && ctx.callbackQuery.data;
  if (data) {
    const prefix = data.split(':')[0];
    if (PREVIEW_BLOCKED_ACTION_PREFIXES.includes(prefix)) {
      return ctx.answerCbQuery(
        '👁️ وضع المعاينة: هذه العملية معطّلة، ولا يُحفظ شيء.',
        { show_alert: true }
      );
    }
  }

  // أزرار قوائم تُنفّذ عمليات
  const text = ctx.message && ctx.message.text;
  if(text&&!STUDENT_MENU_BUTTONS.has(text.trim())&&!TEACHER_MENU_BUTTONS.has(text.trim())&&!['/start','↩️ رجوع','❌ إلغاء العملية','🚪 الخروج من المعاينة'].includes(text.trim())){
    return ctx.reply('👁️ المعاينة للقراءة فقط. اخرج منها لإدارة البيانات.');
  }
  if (text && PREVIEW_BLOCKED_HEARS.has(text.trim())) {
    return ctx.reply('👁️ وضع المعاينة: هذه العملية معطّلة، ولا يُحفظ شيء.');
  }

  // خطوة إدخال نصي تكتب في القاعدة
  const state = userState.get(ctx.from.id);
  if (text && state && PREVIEW_BLOCKED_TEXT_ACTIONS.has(state.action)) {
    userState.delete(ctx.from.id);
    return ctx.reply('👁️ وضع المعاينة: هذه العملية معطّلة، ولا يُحفظ شيء.');
  }

  return next();
});

// حالة مؤقتة في الذاكرة لكل مستخدم لإدارة خطوات الإدخال المتعددة (تسجيل، إضافة، تعديل...)
// يعمل بشكل صحيح طالما البوت يعمل على نسخة تشغيل واحدة (الوضع الافتراضي على Railway)
const rawUserState = new Map();
// غلاف يضيف تلقائيًا صلاحية 30 دقيقة لكل حالة إدخال، فتُنظَّف المهجورة دوريًا
const userState = {
  set(key, value) {
    return rawUserState.set(key, { ...value, expiresAt: Date.now() + 30 * 60 * 1000 });
  },
  get(key) {
    const state=rawUserState.get(key);
    if(state?.expiresAt<=Date.now()){rawUserState.delete(key);return undefined;}
    return state;
  },
  delete(key) {
    return rawUserState.delete(key);
  },
  entries() {
    return rawUserState.entries();
  },
};
const timers = [];  // مراجع المؤقتات للإغلاق المنظم
let scheduleTickRunning = false;  // قفل يمنع تداخل جولات الجدولة

const BACK_BUTTON = '↩️ رجوع';
const STUDENT_ACTIVITY_BUTTON = '📋 المتغيرات';
const LEGACY_STUDENT_ACTIVITY_BUTTON = '📋 إجازاتي وإنذاراتي';
const LEGACY_STUDENT_ACTIVITY_BUTTON_2 = '📋 إجازاتي وتنبيهاتي';
const STUDENT_MENU_BUTTONS = new Set([
  GUIDE_BUTTON,
  '🔗 روابط المعهد',
  '🚪 الخروج من المعاينة',
  '📚 دروس اليوم',
  '📊 تقرير الحضور',
  '📊 تقريري',
  '🌴 طلب إجازة',
  '🗓️ جدولي',
  '📝 الامتحانات الشهرية',
  '🎯 درجات - المباحثات',
  '🎯 درجات المباحثات والتقارير',
  '📖 المباحثات والتقارير',
  '📖 مشاركتي',
  '📄 إرسال تقرير',
  STUDENT_ACTIVITY_BUTTON,
  LEGACY_STUDENT_ACTIVITY_BUTTON,
  LEGACY_STUDENT_ACTIVITY_BUTTON_2,
]);

// أزرار لوحة الأستاذ — تُعامل كأزرار قوائم فلا تُفسَّر كإدخال نصي
// زر تعبئة مرئي كمساحة فارغة لرفع زر لوحة الأستاذ عن حافة شاشة الهاتف.
const TEACHER_MENU_SPACER = '\u3164';
const TEACHER_MENU_BUTTONS = new Set([
  '💬 التواصل مع طالب معين',
  '📣 رسالة جماعية',
  '🔗 روابط المعهد',
  '🚪 الخروج من المعاينة',
  '📚 موادي', '📊 حضور موادي', '👥 المجموعات',
  '🗓️ جدول المباحثات', '📝 الامتحانات', '🏁 إنهاء الموسم', '✏️ تحرير الدرجات',
  '📄 تقارير الطلبة', '🔗 روابط المجموعات',
  '🖥️ فتح لوحة الأستاذ', TEACHER_MENU_SPACER,
]);

const ADMIN_MENU_BUTTONS = new Set([
  '💬 التواصل مع طالب معين',
  '📣 رسالة جماعية',
  GUIDE_ADMIN_BUTTON,
  BACKUP_BUTTON,
  '⚙️ إدارة روابط المعهد',
  '➕ إضافة مرحلة دراسية',
  '➕ إضافة مادة',
  '🟢 تفعيل درس يدويًا',
  '📊 تقرير الحضور',
  '🎓 إدارة الطلبة',
  '🔗 ربط قناة بمرحلة',
  '📡 القنوات المرتبطة',
  '🏷️ المواد والهاشتاغات',
  '⚙️ إدارة المراحل',
  '🗓️ بدء موسم جديد',
  '🗂️ أرشيف المواسم',
  '🌴 طلبات الإجازة',
  '👨‍🏫 إدارة الأساتذة',
  '🔄 تغيير أستاذ مادة',
  '📈 لوحة المعهد',
  '👁️ الدخول بصفة أخرى',
  '📄 تقارير الطلبة',
  '🔗 روابط المجموعات',
  '🖥️ لوحة الإدارة',
]);

const isAdmin = (ctx) => Boolean(ctx.from&&ADMIN_IDS.includes(ctx.from.id));

// ---------------------------------------------------------------------------
// وضع المعاينة للأدمن: يدخل بصفة طالب أو أستاذ حقيقي فيرى ما يراه، بلا حفظ أي شيء.
// ---------------------------------------------------------------------------
// المفتاح: معرّف تليجرام للأدمن → { role: 'student'|'teacher', id, name }
const previewMode = new Map();

const isInPreview = (ctx) => isAdmin(ctx) && previewMode.has(ctx.from.id);
const getPreview = (ctx) => ctx.from?previewMode.get(ctx.from.id):undefined;

// يُستدعى في بداية كل معالج يكتب في قاعدة البيانات. إن كان الأدمن يعاين، يوقف العملية.
// يعالج نداءات الأزرار (answerCbQuery) والرسائل (reply) معًا.
async function blockIfPreview(ctx) {
  if (!isInPreview(ctx)) return false;
  const msg = '👁️ وضع المعاينة: هذه العملية معطّلة، ولا يُحفظ أي شيء في قاعدة البيانات.';
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(msg, { show_alert: true });
    else await ctx.reply(msg);
  } catch (err) {
    /* تجاهل */
  }
  return true;
}

// الطالب الفعّال: المنتحَل في وضع المعاينة، وإلا صاحب الحساب.
async function effectiveStudent(ctx) {
  if(!ctx.from)return null;
  const pv = getPreview(ctx);
  if (pv && pv.role === 'student') return db.getStudentById(pv.id);
  return db.getStudentByTelegramId(ctx.from.id);
}

// الأستاذ الفعّال: المنتحَل في وضع المعاينة، وإلا صاحب الحساب (أو الأدمن بصلاحية أستاذ).
async function effectiveTeacher(ctx) {
  if(!ctx.from)return null;
  const pv = getPreview(ctx);
  if (pv && pv.role === 'teacher') return db.getTeacherById(pv.id);
  return db.getTeacherByTelegramId(ctx.from.id);
}

// رسالة تُرسل للطالب أول مرة يسجّل فيها، تُوضّح جهة النظام والحكم الشرعي لتأشير الحضور.
const WELCOME_MESSAGE =
  'بسم الله الرحمن الرحيم\n\n' +
  'أهلًا بك في نظام تسجيل حضور الدروس الإلكتروني، التابع لـ:\n' +
  '«معهد تراث الأنبياء عليهم السلام للدراسات الحوزوية الإلكترونية».\n\n' +
  '⚠️ تنبيه شرعي مهم:\n' +
  'لا يجوز شرعًا تأشير أي درس على أنه «تم الاستماع» إلا بعد متابعته فعلًا. ' +
  'التأشير أمانة، والحضور المسجَّل يُبنى عليه، فاحرص على ألا تؤشّر درسًا لم تستمع إليه.\n\n' +
  'وفقكم الله لما يحب ويرضى.';

const OFFICIAL_CONFIRMATION_MESSAGE =
  `${WELCOME_MESSAGE}\n\n` +
  '✅ صفة التسجيل:\n' +
  'أنت مسجّل في المعهد بصفة «طالب رسمي». وللدخول إلى البوت، يرجى تأكيد صفة تسجيلك بالضغط على الزر أدناه.';

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
function buttonStyle(text) {
  const value = String(text || '');
  if (/(❌|🗑|حذف|رفض|إلغاء|أرشفة)/.test(value)) return 'danger';
  if (/(✅|✔|🟢|➕|موافقة|تأكيد|حفظ|تفعيل)/.test(value)) return 'success';
  return 'primary';
}

function replyButton(text, style = buttonStyle(text)) {
  return { text, style };
}

function callbackButton(text, data, style = buttonStyle(text)) {
  return { ...Markup.button.callback(text, data), style };
}

function urlButton(text, url, style = 'success') {
  return { ...Markup.button.url(text, url), style };
}

function stagesKeyboard(stages, prefix) {
  return Markup.inlineKeyboard(
    stages.map((s) => [callbackButton(limitButtonText(s.name), `${prefix}:${s.id}`)])
  );
}

function subjectsKeyboard(subjects, prefix) {
  return Markup.inlineKeyboard(
    subjects.map((s) => [callbackButton(limitButtonText(s.name), `${prefix}:${s.id}`)])
  );
}

// مراحل «حضور دروس فقط» لا تظهر لطلبتها أزرار المباحثات والتقارير والامتحانات،
// فلا يُعرض للطالب ما لا ينطبق على مرحلته.
function studentMainMenu(student = null) {
  const lessonsOnly = student && student.stage_type === 'lessons_only';
  const rows = [
    [replyButton('📚 دروس اليوم'), replyButton('📊 تقرير الحضور')],
    [replyButton('🌴 طلب إجازة'), replyButton(STUDENT_ACTIVITY_BUTTON)],
  ];
  if (!lessonsOnly) {
    rows.push([replyButton('🗓️ جدولي'), replyButton('📝 الامتحانات الشهرية')]);
    rows.push([replyButton('🎯 درجات المباحثات والتقارير'), replyButton('📖 المباحثات والتقارير')]);
    rows.push([replyButton('📄 إرسال تقرير')]);
  }
  rows.push([replyButton('🔗 روابط المعهد'),replyButton(GUIDE_BUTTON)]);
  rows.push([replyButton(BACK_BUTTON)]);
  return Markup.keyboard(rows).resize();
}

// حارس مشترك: يمنع ميزات المباحثات في مرحلة «حضور دروس فقط»
function stageSupportsStudies(student) {
  return !student || student.stage_type !== 'lessons_only';
}

function backOnlyMenu() {
  return Markup.keyboard([[replyButton(BACK_BUTTON)]]).resize();
}

function officialConfirmationKeyboard() {
  return Markup.inlineKeyboard([
    [callbackButton('✅ أؤكد أنني مسجّل بصفة طالب رسمي', 'confirm_official_student')],
  ]);
}

async function sendOfficialConfirmationPrompt(ctx) {
  const student = await effectiveStudent(ctx);
  if (student) {
    return replyStudentScreen(ctx, student, OFFICIAL_CONFIRMATION_MESSAGE, officialConfirmationKeyboard());
  }
  return ctx.reply(OFFICIAL_CONFIRMATION_MESSAGE, officialConfirmationKeyboard());
}

function teacherMainMenu() {
  return Markup.keyboard([
    [replyButton('📚 موادي'), replyButton('📊 حضور موادي')],
    [replyButton('👥 المجموعات'), replyButton('🗓️ جدول المباحثات')],
    [replyButton('📝 الامتحانات'), replyButton('🏁 إنهاء الموسم')],
    [replyButton('✏️ تحرير الدرجات'), replyButton('📄 تقارير الطلبة')],
    [replyButton('🔗 روابط المجموعات')],
    [replyButton('🔗 روابط المعهد')],
    [replyButton('💬 التواصل مع طالب معين'), replyButton('📣 رسالة جماعية')],
    [replyButton('🖥️ فتح لوحة الأستاذ')],
    [replyButton(TEACHER_MENU_SPACER)],
  ]).resize();
}

function adminMainMenu() {
  const rows = [
    ['➕ إضافة مرحلة دراسية', '➕ إضافة مادة'],
    ['🟢 تفعيل درس يدويًا', '📊 تقرير الحضور'],
    ['🛠️ إدارة الدروس المفعّلة'],
    ['🎓 إدارة الطلبة', '🔗 ربط قناة بمرحلة'],
    ['💬 التواصل مع طالب معين', '📣 رسالة جماعية'],
    ['📡 القنوات المرتبطة', '🏷️ المواد والهاشتاغات'],
    ['🩺 تشخيص مشاكل القنوات'],
    ['⚙️ إدارة المراحل', '🗓️ بدء موسم جديد'],
    ['🗂️ أرشيف المواسم', '🌴 طلبات الإجازة'],
    ['👨‍🏫 إدارة الأساتذة', '🔄 تغيير أستاذ مادة'],
    ['📈 لوحة المعهد', '👁️ الدخول بصفة أخرى'],
    ['👥 المجموعات', '🗓️ جدول المباحثات'],
    ['📝 الامتحانات', '🏁 إنهاء الموسم'],
    ['✏️ تحرير الدرجات', '📄 تقارير الطلبة'],
    ['🔗 روابط المجموعات'],
    ['🖥️ لوحة الإدارة'],
    ['⚙️ إدارة روابط المعهد', BACKUP_BUTTON],
    [GUIDE_ADMIN_BUTTON],
    [BACK_BUTTON, '❌ إلغاء العملية'],
  ];
  return Markup.keyboard(rows.map((row) => row.map((text) => replyButton(text)))).resize();
}

function studentActionsKeyboard(studentId, isActive = true) {
  const rows = [
    [callbackButton('💬 التواصل مع هذا الطالب', `contact:select:admin:${studentId}:0`)],
    [callbackButton('✏️ تعديل الاسم', `stu_edit_name:${studentId}`)],
    [callbackButton('🔁 تغيير المرحلة', `stu_edit_stage:${studentId}`)],
    [callbackButton('📊 تقرير كل المواسم', `stu_report:${studentId}`)],
    [callbackButton('📣 إرسال تذكير بالمطلوب', `stu_remind:${studentId}`)],
  ];
  if (isActive) {
    rows.push([callbackButton('📱 كود نقل الحساب (تغيير الهاتف)', `stu_xfer:${studentId}`)]);
    rows.push([callbackButton('👥 نقل إلى مجموعة أخرى', `stu_movegrp:${studentId}`)]);
    rows.push([callbackButton('🔀 نقل لمرحلة أخرى بلا درجات', `stu_movefresh:${studentId}`)]);
    rows.push([callbackButton('🗄️ أرشفة الطالب (مع حفظ بياناته)', `stu_archive_confirm:${studentId}`)]);
  } else {
    rows.push([callbackButton('♻️ إعادة تفعيل الطالب', `stu_restore:${studentId}`)]);
  }
  rows.push([callbackButton('🗑️ حذف نهائي (مع كل بياناته)', `stu_hard_confirm:${studentId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendToStageStudents(stageId, text, extra = undefined, options = {}) {
  const {
    excludeStudentIds = new Set(),
    skipOnLeave = false,
    dailyLessonNotificationDate = null,
    dailyLessonExpiresAt = null,
  } = options;
  const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);

  // استعلام واحد يُرجع المستحقين، بدل استعلامَي إجازة/حجز لكل طالب على حدة.
  let recipients;
  if (dailyLessonNotificationDate) {
    return require('./dailyNotifications').queueDailyLessons(db.pool,{stageId,onDate:dailyLessonNotificationDate,text,extra,excluded:[...excludeStudentIds],expiresAt:dailyLessonExpiresAt});
  } else if (skipOnLeave) {
    recipients = await db.getEligibleStudentsForStage(stageId, today);
  } else {
    recipients = await db.getStudentsByStage(stageId);
  }

  const targets = recipients.filter((st) => !excludeStudentIds.has(st.id));
  // الإرسال عبر الطابور المركزي (أولوية بث منخفضة)، بلا تأخير يدوي — الطابور ينظّم المعدل.
  const results = await Promise.allSettled(
    targets.map((st) =>
      tgQueue.sendMessage(st.telegram_id, text, extra, { priority: PRIORITY.low })
    )
  );
  const delivered = results.filter((r) => r.status === 'fulfilled').length;

  // تحرير حجز اليوم لمن فشل إرساله فعليًا، كي يُعاد الإشعار في الجولة التالية
  if (dailyLessonNotificationDate) {
    await Promise.allSettled(
      results.map((r, i) =>
        r.status === 'rejected'
          ? db.releaseDailyLessonNotification(targets[i].id, stageId, dailyLessonNotificationDate)
          : Promise.resolve()
      )
    );
  }
  return { delivered, total: targets.length };
}

// عند نشر درس جديد: نبّه الطلبة الذين انتهت إجازتهم توًّا بضرورة متابعة الدروس الفائتة أيضًا.
async function notifyReturningFromLeave(stageId) {
  const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  const returning = await db.getStudentsReturningFromLeave(stageId, today);
  for (const st of returning) {
    let delivered = false;
    try {
      const pending = await db.getUnmarkedLessonsForStudent(st.id);
      await bot.telegram.sendMessage(
        st.telegram_id,
        `انتهت إجازتك، وعادت إليك إشعارات الدروس. يوجد في سجلك الحالي ${pending.length} درسًا غير مؤشّر، ` +
          'منها دروس الإجازة التي لا تُحتسب غيابًا.\n' +
          'لا يمكن تأشير أي درس انتهت مهلته؛ افتح «📚 دروس اليوم» لعرض الدروس التي ما زالت مهلتها سارية.'
      );
      delivered = true;
    } catch (err) {
      console.warn(`تعذر تنبيه الطالب العائد من إجازة ${st.id}:`, err.description || err.message);
    }
    if (delivered) await db.markLeaveBacklogNotified(st.leave_id);
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function notifyAdmins(text, extra = undefined) {
  let delivered = 0;
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text, extra);
      delivered += 1;
    } catch (err) {
      console.warn(`تعذر إرسال تنبيه للأدمن ${adminId}:`, err.description || err.message);
    }
  }
  return delivered;
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function buildAdminAbsenceMessages(candidates, maxLength = 3600) {
  if (!candidates.length) return [];
  const header =
    '🚨 قائمة الطلبة الذين بلغ غيابهم الكامل 10 أيام دراسية متتالية\n' +
    'لم يسجّل الطلبة أدناه أي حضور ضمن مهلة دروس تلك الأيام:\n';
  const messages = [];
  let text = header;
  let attendanceDayIds = [];
  let currentStage = null;

  for (const candidate of candidates) {
    const stage = candidate.stage_name || 'مرحلة غير محددة';
    const stageHeading = stage === currentStage ? '' : `\n📘 ${stage}\n`;
    const line =
      `• ${candidate.full_name} — من ${dateOnly(candidate.streak_start_date)} ` +
      `إلى ${dateOnly(candidate.streak_end_date)}\n`;
    const addition = stageHeading + line;

    if (attendanceDayIds.length && text.length + addition.length > maxLength) {
      messages.push({ text: text.trim(), attendanceDayIds });
      text = header + `\n📘 ${stage}\n` + line;
      attendanceDayIds = [];
    } else {
      text += addition;
    }
    attendanceDayIds.push(candidate.attendance_day_id);
    currentStage = stage;
  }
  if (attendanceDayIds.length) messages.push({ text: text.trim(), attendanceDayIds });
  return messages;
}

function normalizeArabicDigits(value) {
  return String(value || '')
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

function parseLeaveDays(value) {
  const normalized = normalizeArabicDigits(value);
  if (!/^\d+$/.test(normalized)) return null;
  const days = Number(normalized);
  return Number.isInteger(days) && days >= 1 && days <= MAX_LEAVE_DAYS_PER_SEASON ? days : null;
}

function currentDateInTimeZone(timeZone = ATTENDANCE_TIME_ZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function deleteMessageQuietly(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch (_) {
    // قد تكون الرسالة حُذفت مسبقًا أو تجاوزت مهلة الحذف؛ لا نوقف العملية.
  }
}

function studentUiMessageKind(extra) {
  return extra && extra.reply_markup && Array.isArray(extra.reply_markup.keyboard)
    ? 'menu'
    : 'screen';
}

async function beginStudentScreen(ctx, student, options = {}) {
  if(isInPreview(ctx))return;
  const messageIds = await db.takeStudentUiMessages(student.id, Boolean(options.includeMenu));
  for (const messageId of messageIds) {
    await deleteMessageQuietly(ctx.chat.id, messageId);
  }
  if (ctx.message && ctx.message.message_id) {
    await deleteMessageQuietly(ctx.chat.id, ctx.message.message_id);
  }
}

async function trackStudentUiMessage(student, message, messageKind = 'screen') {
  if (message && Number.isSafeInteger(Number(message.message_id))) {
    await db.recordStudentUiMessage(student.id, Number(message.message_id), messageKind);
  }
  return message;
}

async function replyStudentScreen(ctx, student, text, extra = undefined, options = {}) {
  if(isInPreview(ctx))return ctx.reply(text,extra);
  const messageKind = studentUiMessageKind(extra);
  if (options.clear !== false) {
    await beginStudentScreen(ctx, student, { includeMenu: messageKind === 'menu' });
  }
  const message = await ctx.reply(text, extra);
  return trackStudentUiMessage(student, message, messageKind);
}

function withStudentName(student, text) {
  return `👤 الطالب: ${student.full_name}\n\n${text}`;
}

const REPORT_WEEKLY_REMINDER = '🗓️ تذكير: أرسل تقرير كل مادة مرة واحدة أسبوعيًا، وليس يوميًا.';

function formatStudentSeasonActivity(activity) {
  if (!activity) return '📋 لا يوجد موسم دراسي نشط في حسابك حاليًا.';
  const leaves = activity.leaves || [];
  const warnings = activity.warnings || [];
  const leaveLines = leaves.length
    ? leaves.map(
        (leave, index) =>
          `${index + 1}. ${dateOnly(leave.start_date)} → ${dateOnly(leave.end_date)} (${Number(leave.days)} يومًا)`
      )
    : ['لا توجد إجازات معتمدة.'];
  const approvedLeaveDays = Number.isFinite(Number(activity.approvedLeaveDays))
    ? Number(activity.approvedLeaveDays)
    : leaves.reduce((sum, leave) => sum + Number(leave.days), 0);
  const maxLeaveDays = Number(activity.maxLeaveDays || MAX_LEAVE_DAYS_PER_SEASON);
  let text =
    `${STUDENT_ACTIVITY_BUTTON}\n` +
    `المرحلة: ${activity.stageName || '—'}\n` +
    `الموسم: ${activity.seasonName || '—'}\n\n` +
    `🌴 الإجازات المعتمدة (${leaves.length}):\n` +
    `الأيام المستخدمة: ${approvedLeaveDays} من ${maxLeaveDays} — المتبقي: ${Math.max(
      0,
      maxLeaveDays - approvedLeaveDays
    )}\n` +
    leaveLines.join('\n');
  if (warnings.length) {
    const notificationLines = warnings.map(
      (warning, index) =>
        `${index + 1}. تنبيه غياب متتالٍ حتى يوم ${dateOnly(warning.attendance_date)}`
    );
    text += `\n\n⚠️ التنبيهات المستلمة (${warnings.length}):\n${notificationLines.join('\n')}`;
  }
  return text;
}

function formatAdminStudentDetails(student, activity, attendanceRows = []) {
  let text =
    `الطالب: ${student.full_name}\n` +
    `المرحلة: ${student.stage_name}\n` +
    `الحالة: ${student.is_active ? 'نشط' : 'مؤرشف'}`;
  if (!activity) return `${text}\nالموسم الحالي: لا يوجد تسجيل نشط.`;

  const approvedLeaveDays = Number(activity.approvedLeaveDays || 0);
  const leaveLines = (activity.leaves || []).map(
    (leave) =>
      `• ${dateOnly(leave.start_date)} → ${dateOnly(leave.end_date)} (${Number(leave.days)} يومًا)`
  );
  const attendanceLines = attendanceRows.map(
    (row) => `• ${row.subject_name}: ${Number(row.attended_lessons)} من ${Number(row.total_lessons)}`
  );
  text +=
    `\nالموسم: ${activity.seasonName || '—'}` +
    `\n\n📊 الحضور:\n${attendanceLines.length ? attendanceLines.join('\n') : 'لا توجد دروس مسجلة.'}` +
    `\n\n🌴 الإجازات المعتمدة: ${approvedLeaveDays} من ${MAX_LEAVE_DAYS_PER_SEASON} أيام` +
    `\nالمتبقي: ${Math.max(0, MAX_LEAVE_DAYS_PER_SEASON - approvedLeaveDays)} أيام` +
    `\n${leaveLines.length ? leaveLines.join('\n') : 'لا توجد إجازات معتمدة.'}`;
  return text;
}

function lessonKeyboard(lessons) {
  const rows = [];
  const pendingLessons = lessons.filter((lesson) => !lesson.attended);
  const channelUrl = pendingLessons.map((lesson) => channelEntryUrl(lesson.source_url)).find(Boolean);
  if (channelUrl) {
    rows.push([urlButton('📢 الانتقال إلى قناة الدروس', channelUrl)]);
  }
  for (const lesson of pendingLessons) {
    const number = Number(lesson.lesson_number);
    const title = `${lesson.subject_name} — الدرس ${number}`;
    rows.push([
      callbackButton(
        limitButtonText(`أضغط لتأشير الحضور — ${title}`),
        `attend:${lesson.lesson_id}`,
        'success'
      ),
    ]);
  }
  rows.push([callbackButton('📅 الجدول الدراسي', 'student_lesson_schedule')]);
  return Markup.inlineKeyboard(rows);
}

function limitButtonText(text, maxLength = 60) {
  const chars = Array.from(text);
  return chars.length <= maxLength ? text : `${chars.slice(0, maxLength - 1).join('')}…`;
}

function clickableUrl(value) {
  if (!value) return null;
  const url = String(value).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) return `https://${url}`;
  return null;
}

// في القنوات العامة نفتح واجهة القناة نفسها. وفي القنوات الخاصة نستخدم رابط المنشور
// لأنه المدخل المضمون إلى القناة، لكننا نعرضه مرة واحدة فقط.
function channelEntryUrl(value) {
  const url = clickableUrl(value);
  if (!url) return null;
  const publicPost = url.match(/^(https?:\/\/t\.me\/)(?!c\/)([A-Za-z0-9_]+)\/\d+(?:[/?#].*)?$/i);
  return publicPost ? `${publicPost[1]}${publicPost[2]}` : url;
}

function dailyLessonNotificationKeyboard(lesson) {
  const channelUrl = channelEntryUrl(lesson && lesson.source_url);
  if (channelUrl) {
    return Markup.inlineKeyboard([[urlButton('📢 الانتقال إلى قناة الدروس', channelUrl)]]);
  }
  return Markup.inlineKeyboard([[callbackButton('📚 عرض دروس اليوم', 'menu_today')]]);
}

function dailyLessonNotificationText(hasChannelLink) {
  return (
    '📢 تم نشر دروس هذا اليوم لمرحلتك.\n' +
    (hasChannelLink
      ? 'اضغط «الانتقال إلى قناة الدروس» للاستماع، ثم افتح «📚 دروس اليوم» لتأشير الدروس التي استمعت إليها.'
      : 'افتح «📚 دروس اليوم» للاستماع وتأشير الدروس التي أكملتها.')
  );
}

function singleLessonKeyboard(lesson) {
  return Markup.inlineKeyboard([
    [
      callbackButton(
        `✅ تم الاستماع — الدرس ${Number(lesson.lesson_number)}`,
        `attend:${lesson.id}`,
        'success'
      ),
    ],
  ]);
}

async function showTodayLessons(ctx, options = {}) {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const transition = await db.getPendingTransition(student.id);
  if (transition) {
    return showTransitionPrompt(ctx);
  }

  const lessons = await db.getActiveLessonsForStudent(student.stage_id, student.id);
  if (lessons.length === 0) {
    const text = options.confirmation
      ? `${options.confirmation}\n\nلا توجد دروس أخرى غير مؤشَّرة حاليًا لمرحلتك.`
      : 'لا توجد دروس غير مؤشَّرة حاليًا لمرحلتك. تحقق لاحقًا.';
    return replyStudentScreen(ctx, student, text, Markup.inlineKeyboard([
      [callbackButton('📅 الجدول الدراسي', 'student_lesson_schedule')]
    ]));
  }

  const heading = options.confirmation
    ? `${options.confirmation}\n\nدروس اليوم المتاحة لمرحلتك:`
    : 'دروس اليوم غير المؤشَّرة لمرحلتك:\nانتقل إلى قناة الدروس، ثم أشّر كل درس استمعت إليه.';
  const keyboard = lessonKeyboard(lessons);

  if (options.edit) {
    try {
      return await ctx.editMessageText(heading, keyboard);
    } catch (err) {
      if (!String(err.description || err.message).includes('message is not modified')) throw err;
      return undefined;
    }
  }
  return replyStudentScreen(ctx, student, heading, keyboard);
}

async function answerIfCallback(ctx, text) {
  if (ctx.callbackQuery) await ctx.answerCbQuery(text);
}

function denyUnauthorized(ctx) {
  return ctx.callbackQuery ? ctx.answerCbQuery('غير مصرح.') : ctx.reply('هذا الخيار متاح للأدمن فقط.');
}

// جدول Markdown نصي؛ طريقة عرضه واتجاه الصفحة يعتمدان على القارئ.
function mdCell(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')   // الشرطة العمودية تكسر أعمدة الجدول
    .replace(/\r?\n/g, ' ');
}

function buildMarkdownTable(header, rows, { alignRight = false } = {}) {
  const head = `| ${header.map(mdCell).join(' | ')} |`;
  const sep = `| ${header.map(() => alignRight ? '---:' : '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

// يُنشئ مستند Markdown بعنوان وسطر تاريخ ثم جدول
function addSequenceColumn(header, rows) {
  const hasSequence = header.some((value) => ['ت', 'تسلسل', '#'].includes(String(value ?? '').trim()));
  if (hasSequence) return { header, rows };
  return {
    header: ['تسلسل', ...header],
    rows: rows.map((row, index) => [index + 1, ...row]),
  };
}

function buildMarkdownDoc(title, header, rows, note = '', options = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const sequenced = options.sequence === false ? { header, rows } : addSequenceColumn(header, rows);
  return (
    `# ${title}\n\n` +
    `_تاريخ التوليد: ${stamp}_\n\n` +
    (note ? `${note}\n\n` : '') +
    buildMarkdownTable(sequenced.header, sequenced.rows, options) +
    '\n'
  );
}

function buildRtlMarkdownDoc(title, header, rows, note = '') {
  // نضيف التسلسل قبل عكس الأعمدة، حتى يبقى عمود «تسلسل» في الموضع الطبيعي
  // عند فتح ملف Markdown بقارئ يدعم الاتجاه من اليمين إلى اليسار.
  const sequenced = addSequenceColumn(header, rows);
  return buildMarkdownDoc(mdCell(title), [...sequenced.header].reverse(),
    sequenced.rows.map(row => [...row].reverse()), mdCell(note), { alignRight: true, sequence: false });
}

function sendMarkdownDoc(ctx, filename, content, extra = {}) {
  return ctx.replyWithDocument({
    source: Buffer.from(content, 'utf-8'),
    filename: `${filename}.md`,
  }, extra);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function safeFilePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

function groupStudentReport(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.stage_season_id)) {
      groups.set(row.stage_season_id, {
        seasonName: formatSeasonLabel(row),
        stageName: row.stage_name,
        approvedLeaveDays: Number(row.approved_leave_days || 0),
        approvedLeavePeriods: row.approved_leave_periods || '',
        subjects: [],
      });
    }
    groups.get(row.stage_season_id).subjects.push({
      name: row.subject_name,
      attended: Number(row.attended_lessons),
      total: Number(row.total_lessons),
    });
  }
  return [...groups.values()];
}

function formatStudentReport(rows) {
  if (rows.length === 0) return ['لا توجد بيانات دراسية مسجلة حتى الآن.'];
  const sections = groupStudentReport(rows).map((group) => {
    const subjectLines = group.subjects.map(
      (subject) => `• ${subject.name}: ${subject.attended} حضور من ${subject.total} درس`
    );
    const leaveText = group.approvedLeavePeriods
      ? `الإجازات المعتمدة: ${group.approvedLeaveDays} من ${MAX_LEAVE_DAYS_PER_SEASON} أيام\n${group.approvedLeavePeriods}\n`
      : `الإجازات المعتمدة: 0 من ${MAX_LEAVE_DAYS_PER_SEASON} أيام\n`;
    return `📘 ${group.seasonName}\nالمرحلة: ${group.stageName}\n${leaveText}${subjectLines.join('\n')}`;
  });

  const messages = [];
  let current = '📊 تقرير الحضور حسب كل مرحلة وموسم\n\n';
  for (const section of sections) {
    if ((current + section).length > 3800) {
      messages.push(current.trim());
      current = '';
    }
    current += `${section}\n\n`;
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

function buildStudentReportMd(rows) {
  const header = [
    'الموسم', 'المرحلة', 'المادة', 'الحضور', 'إجمالي الدروس',
    'تواريخ الحضور', 'أيام الإجازة', 'فترات الإجازة',
  ];
  const body = rows.map((row) => [
    formatSeasonLabel(row),
    row.stage_name,
    row.subject_name,
    Number(row.attended_lessons),
    Number(row.total_lessons),
    row.attendance_dates || '',
    Number(row.approved_leave_days || 0),
    row.approved_leave_periods || '',
  ]);
  return buildMarkdownDoc('تقرير حضور الطالب', header, body);
}

function buildStageSeasonMd(rows) {
  const byStudent = new Map();
  for (const row of rows) {
    if (!byStudent.has(row.student_id)) {
      byStudent.set(row.student_id, {
        name: row.full_name,
        approvedLeaveDays: Number(row.approved_leave_days || 0),
        approvedLeavePeriods: row.approved_leave_periods || '',
        subjects: [],
      });
    }
    byStudent.get(row.student_id).subjects.push({
      name: row.subject_name,
      total: Number(row.total_lessons),
      attended: Number(row.attended_lessons),
      attendanceDates: row.attendance_dates || '',
    });
  }
  const subjectNames = [...new Set(rows.map((row) => row.subject_name))];
  const header = [
    'ت', 'اسم الطالب', 'أيام الإجازة', 'تواريخ الإجازات المعتمدة',
    ...subjectNames.flatMap((name) => [
      `${name} - حضر`,
      `${name} - الإجمالي`,
      `${name} - تواريخ وأوقات الحضور`,
    ]),
  ];
  const body = [];
  let index = 1;
  for (const { name, approvedLeaveDays, approvedLeavePeriods, subjects } of byStudent.values()) {
    const cells = [index++, name, approvedLeaveDays, approvedLeavePeriods];
    for (const subjectName of subjectNames) {
      const found = subjects.find((subject) => subject.name === subjectName);
      cells.push(
        found ? found.attended : 0,
        found ? found.total : 0,
        found ? found.attendanceDates : ''
      );
    }
    body.push(cells);
  }
  const title = `تقرير حضور ${rows[0].stage_name}`;
  const note = `الموسم: ${formatSeasonLabel(rows[0])}`;
  return buildRtlMarkdownDoc(title, header, body, note);
}

async function sendStudentReportMessages(ctx, studentId, stageSeasonId = null, options = {}) {
  const rows = await db.getStudentSeasonReport(studentId, stageSeasonId, ATTENDANCE_TIME_ZONE);
  const student = options.cleanUi === false ? null : options.student || (await db.getStudentById(studentId));
  if (student) await beginStudentScreen(ctx, student);
  for (const [index, text] of formatStudentReport(rows).entries()) {
    const message = await ctx.reply(index === 0 && student ? withStudentName(student, text) : text);
    if (student&&!isInPreview(ctx)) await trackStudentUiMessage(student, message);
  }
  return rows;
}

function transitionKeyboard(transition) {
  const rows = [[callbackButton(`🔁 إعادة ${transition.source_stage_name}`, 'season_choice:repeat')]];
  if (transition.next_stage_id) {
    rows.push([
      callbackButton(`✅ نجحت — الانتقال إلى ${transition.next_stage_name}`, 'season_choice:promote'),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

async function showTransitionPrompt(ctx, options = {}) {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const transition = await db.getPendingTransition(student.id);
  if (!transition) {
    return replyStudentScreen(
      ctx,
      student,
      'لا يوجد اختيار موسم جديد مطلوب منك حاليًا.',
      studentMainMenu(await effectiveStudent(ctx))
    );
  }
  const text =
    `🆕 بدأ موسم «${transition.repeat_season_name}» للمرحلة «${transition.source_stage_name}».\n` +
    'اختر حالتك بدقة؛ سيُحفظ تقرير موسمك السابق كما هو:';
  if (options.edit) return ctx.editMessageText(text, transitionKeyboard(transition));
  return replyStudentScreen(ctx, student, text, transitionKeyboard(transition));
}

function seasonSelectionKeyboard(stages, selectedIds) {
  const selected = new Set(selectedIds.map(Number));
  const rows = stages.map((stage) => [
    callbackButton(
      `${selected.has(stage.id) ? '✅' : '◻️'} ${limitButtonText(stage.name, 50)}`,
      `season_toggle:${stage.id}`
    ),
  ]);
  rows.push([callbackButton('🚀 بدء الموسم للمراحل المحددة', 'season_confirm', 'success')]);
  rows.push([callbackButton('إلغاء', 'season_cancel')]);
  return Markup.inlineKeyboard(rows);
}

// ---------------------------------------------------------------------------
// تسجيل الدخول للطالب
// ---------------------------------------------------------------------------
studentGuide.install({bot,userState,isAdmin,isInPreview,effectiveStudent,effectiveTeacher,
  onContinue:startStudentRegistration,menus:[STUDENT_MENU_BUTTONS,TEACHER_MENU_BUTTONS,ADMIN_MENU_BUTTONS]});

async function startStudentRegistration(ctx,codeOnly=false){
  if(ctx.chat?.type!=='private')return;
  userState.delete(ctx.from.id);
  if(isAdmin(ctx))return ctx.reply('لوحة تحكم الأدمن:',adminMainMenu());
  const student=await effectiveStudent(ctx);
  if(student){
    if(!student.is_active)return ctx.reply('حسابك مؤرشف حاليًا. تواصل مع الأدمن.');
    if(!student.official_confirmed_at)return sendOfficialConfirmationPrompt(ctx);
    return replyStudentScreen(ctx,student,`أهلًا بك ${student.full_name} 👋`,studentMainMenu(student));
  }
  const teacher=await effectiveTeacher(ctx);
  if(teacher)return ctx.reply(`أهلًا بك أستاذ ${teacher.full_name} 👋`,teacherMainMenu());
  const registrationOpen=await db.isStudentRegistrationOpen();
  userState.set(ctx.from.id,{action:'awaiting_full_name'});
  if(!registrationOpen){
    return ctx.reply(
      '⛔ التسجيل الجديد متوقف مؤقتًا من إدارة المعهد.\n\n'+
      'إذا كنت أستاذًا ولديك كود تفعيل، أو طالبًا مسجّلًا سابقًا ولديك كود نقل حساب، أرسل الكود هنا.\n'+
      'أما إضافة طالب جديد فتتم حاليًا من الإدارة فقط.',
      backOnlyMenu()
    );
  }
  return ctx.reply(codeOnly?'أرسل كود تفعيل الأستاذ أو كود نقل حساب الطالب الذي زوّدتك به الإدارة.':
    'أهلًا بك في بوت معهد تراث الأنبياء عليهم السلام.\n\n'+
    '🎓 تسجيل طالب جديد\nأرسل اسمك الرباعي في رسالة واحدة، ثم اختر مرحلتك الدراسية من الأزرار.\n\n'+
    '📝 ملاحظات مهمة\n'+
    '• للأستاذ: أرسل كود تفعيل الأستاذ الذي زوّدتك به الإدارة بدلًا من كتابة الاسم.\n'+
    '• للطالب المسجّل سابقًا الذي يستخدم حساب تليجرام جديدًا: أرسل كود نقل الحساب من الإدارة لاستعادة سجلك، ولا تسجّل كطالب جديد.',backOnlyMenu());
}

bot.start(async (ctx) => {
  if(ctx.chat?.type!=='private')return;
  userState.delete(ctx.from.id);
  if(isInPreview(ctx))previewMode.delete(ctx.from.id);
  if(isAdmin(ctx)){
    await studentGuide.clear(ctx);
    return ctx.reply('لوحة تحكم الأدمن:',adminMainMenu());
  }
  const student=await effectiveStudent(ctx);
  if(student){
    await studentGuide.clear(ctx);
    if(!student.is_active)return ctx.reply('حسابك مؤرشف حاليًا. تواصل مع الأدمن إذا كنت تريد العودة للدراسة.');
    if(!student.official_confirmed_at)return sendOfficialConfirmationPrompt(ctx);
    await replyStudentScreen(ctx,student,`أهلًا بعودتك ${student.full_name} 👋`,studentMainMenu(student));
    if(await db.getPendingTransition(student.id))return showTransitionPrompt(ctx);
    return;
  }
  const teacher=await effectiveTeacher(ctx);
  if(teacher){await studentGuide.clear(ctx);return ctx.reply(`أهلًا بك أستاذ ${teacher.full_name} 👋`,teacherMainMenu());}
  return studentGuide.open(ctx);
});

// Compatibility with an old onboarding button; it never resets an existing account.
bot.action('onboarding_ack',async(ctx)=>{
  if(ctx.chat?.type!=='private'||isInPreview(ctx))return;
  await ctx.answerCbQuery();await studentGuide.clear(ctx);return startStudentRegistration(ctx);
});

bot.command('teacher', async (ctx) => {
  const teacher = await effectiveTeacher(ctx);
  if (!teacher) {
    return ctx.reply('هذا الأمر متاح للأساتذة المسجّلين فقط. أرسل كود التفعيل الذي زوّدك به المعهد.');
  }
  userState.delete(ctx.from.id);
  return ctx.reply(`لوحة الأستاذ ${teacher.full_name}:`, teacherMainMenu());
});

// لا يستطيع الطالب استعمال وظائف البوت قبل الضغط على تأكيد التسجيل الرسمي.
// التسجيل الأولي (الاسم والمرحلة) يمر لأن الطالب لا يكون موجودًا في قاعدة البيانات بعد.
async function requireOfficialConfirmation(ctx, next) {
  if (isAdmin(ctx)) return next();
  const callbackData = ctx.callbackQuery && ctx.callbackQuery.data;
  if (callbackData === 'confirm_official_student') return next();
  const student = await effectiveStudent(ctx);
  if (!student) return next();
  if (!student.is_active) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('حسابك مؤرشف حاليًا.', { show_alert: true });
    else await ctx.reply('حسابك مؤرشف حاليًا. تواصل مع الأدمن إذا كنت تريد العودة للدراسة.');
    return undefined;
  }
  if (student.official_confirmed_at) return next();
  if (ctx.callbackQuery) await ctx.answerCbQuery('يجب تأكيد صفة تسجيلك أولًا.', { show_alert: true });
  await sendOfficialConfirmationPrompt(ctx);
  return undefined;
}

backups.install({bot,isAdmin,isInPreview,userState});

bot.on('text', requireOfficialConfirmation);
bot.on('callback_query', requireOfficialConfirmation);

bot.action('confirm_official_student', async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('أكمل تسجيل الاسم والمرحلة أولًا.', { show_alert: true });
  if (!student.is_active) return ctx.answerCbQuery('حسابك مؤرشف حاليًا.', { show_alert: true });
  await db.confirmOfficialStudent(student.id);
  await ctx.answerCbQuery('تم تأكيد التسجيل الرسمي ✅');
  try {
    await ctx.editMessageText('✅ تم تأكيد أنك مسجّل في المعهد بصفة طالب رسمي.');
  } catch (err) {
    if (!String(err.description || err.message).includes('message is not modified')) throw err;
  }
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await deleteMessageQuietly(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id);
  }
  return replyStudentScreen(ctx, student, `أهلًا بك ${student.full_name} 👋`, studentMainMenu(await effectiveStudent(ctx)));
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للأدمن فقط.');
  userState.delete(ctx.from.id);
  return ctx.reply('لوحة تحكم الأدمن:', adminMainMenu());
});

// ---------------------------------------------------------------------------
// معالجة الرسائل المُحوَّلة (Forward) لربط قناة بمرحلة — يجب أن تُفحص قبل معالج النصوص العام
// ---------------------------------------------------------------------------
bot.on('message', async (ctx, next) => {
  const state = userState.get(ctx.from.id);
  if (state && state.action === 'admin_awaiting_channel_forward' && isAdmin(ctx)) {
    const msg = ctx.message;
    const inputText = typeof msg.text === 'string' ? msg.text.trim() : '';
    // أزرار لوحة الأدمن والإلغاء ليست رسائل قناة محوَّلة؛ مرّرها لمعالج النصوص
    // كي يلغي الحالة السابقة ثم ينفذ الخيار الجديد بصورة طبيعية.
    if (
      inputText === '❌ إلغاء العملية' ||
      inputText === BACK_BUTTON ||
      ADMIN_MENU_BUTTONS.has(inputText) ||
      STUDENT_MENU_BUTTONS.has(inputText) ||
      TEACHER_MENU_BUTTONS.has(inputText)
    ) {
      return next();
    }
    const forwardChat =
      (msg.forward_from_chat && msg.forward_from_chat) ||
      (msg.forward_origin && msg.forward_origin.chat) ||
      null;
    if (!forwardChat || forwardChat.type !== 'channel') {
      return ctx.reply('لم أتعرف على قناة في الرسالة المُحوَّلة. تأكد أنك تُحوّل منشورًا من داخل القناة نفسها، وأنني مضاف كأدمن فيها.');
    }
    userState.set(ctx.from.id, {
      action: 'admin_channel_choose_stage',
      chatId: forwardChat.id,
      title: forwardChat.title,
    });
    const stages = await db.listStages();
    if (stages.length === 0) {
      userState.delete(ctx.from.id);
      return ctx.reply('لا توجد مراحل بعد. أضف مرحلة أولًا.');
    }
    return ctx.reply(`تم التعرّف على القناة: ${forwardChat.title}\nاختر المرحلة التي تمثلها هذه القناة:`, stagesKeyboard(stages, 'admin_channel_stage'));
  }
  return next();
});

// ---------------------------------------------------------------------------
// معالجة النصوص العامة (حسب الحالة المخزنة لكل مستخدم)
// ---------------------------------------------------------------------------
// يُرسل التقرير فور استلامه إلى حساب أستاذ المادة الشخصي على تليجرام،
// فلا ينتظر الأستاذ نهاية الموسم ليطّلع عليه.
async function deliverReportToTeachers(student, subjectId, subjectName, payload) {
  const teachers = await db.listSubjectTeachers(subjectId);
  const recipients = teachers.filter((t) => t.telegram_id);
  const caption =
    `📄 تقرير جديد\n` +
    `الطالب: ${student.full_name}\n` +
    `المادة: ${subjectName}\n` +
    `المجموعة: ${payload.groupTitle || 'غير محددة في السجل القديم'}\n` +
    `التاريخ: ${new Date().toISOString().slice(0, 10)}\n\n` +
    '⏳ سيبقى هذا التقرير ضمن «تقارير الطلبة» بانتظار التقييم حتى تسجّل درجته.';

  let delivered = 0;
  for (const t of recipients) {
    try {
      if (payload.kind === 'document') {
        await bot.telegram.sendDocument(Number(t.telegram_id), payload.fileId, { caption });
      } else if (payload.kind === 'photo') {
        await bot.telegram.sendPhoto(Number(t.telegram_id), payload.fileId, { caption });
      } else {
        await bot.telegram.sendMessage(Number(t.telegram_id), `${caption}\n\n${payload.note}`);
      }
      delivered += 1;
    } catch (err) {
      console.warn(`تعذر إرسال التقرير للأستاذ ${t.teacher_id}:`, err.description || err.message);
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  // لا نرسل للأدمن إشعارًا عند وصول التقرير؛ التقرير محفوظ ويمكن متابعته من اللوحة التفاعلية.
  // إذا لم يكن للمادة أستاذ مرتبط بحساب، يبقى التقرير محفوظًا بانتظار الإسناد/التقييم.
  return { delivered, total: recipients.length };
}

// استقبال ملف التقرير (مستند أو صورة) عندما يكون الطالب في خطوة الإرسال
bot.on(['document', 'photo'], async (ctx, next) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'student_report_upload') return next();
  const student = await effectiveStudent(ctx);
  if (!student) {
    userState.delete(ctx.from.id);
    return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  }
  const msg = ctx.message;
  const fileId = msg.document
    ? msg.document.file_id
    : msg.photo[msg.photo.length - 1].file_id; // أعلى دقة متاحة
  const kind = msg.document ? 'document' : 'photo';
  const assignment=await studies.assignStudentToGroup(student.id,state.subjectId,state.ssId);
  if(!assignment.group)return ctx.reply(assignment.message+' ثم أعد إرسال التقرير.');
  const report=await studies.submitReport(student.id, state.subjectId, state.ssId, {
    fileId,
    kind,
    note: msg.caption || null,
    sourceMessageId:msg.message_id,
  });
  if(!report)return ctx.reply('لم يُضف تقرير جديد: إما أنه محفوظ مسبقًا أو تغيّر موسمك أو نمط مشاركتك.');
  const sent = await deliverReportToTeachers(student, state.subjectId, state.subjectName, {
    kind,
    fileId,
    note: msg.caption || null,
    groupTitle:report.group_title_snapshot,
  });
  userState.delete(ctx.from.id);
  return ctx.reply(
    `✅ استُلم تقرير مادة «${state.subjectName}».` +
      (sent.delivered > 0 ? '\nوصل إلى الأستاذ.' : '\nمحفوظ في النظام وسيطّلع عليه الأستاذ.'),
    studentMainMenu(await effectiveStudent(ctx))
  );
});

instituteLinks.install({ bot, Markup, userState, isAdmin, isInPreview, getPreview,
  effectiveStudent, effectiveTeacher, replyStudentScreen, studentMainMenu, teacherMainMenu,
  adminMainMenu, menus: [STUDENT_MENU_BUTTONS, TEACHER_MENU_BUTTONS, ADMIN_MENU_BUTTONS] });

bot.on('text', async (ctx, next) => {
  const inputText = ctx.message.text.trim();

  if (inputText === BACK_BUTTON) {
    await studentGuide.clear(ctx);
    const hadStep = userState.delete(ctx.from.id);
    if (isInPreview(ctx)) {
      const pv=getPreview(ctx);
      return ctx.reply(
        hadStep ? 'تم الرجوع عن الخطوة الحالية في المعاينة.' : 'أنت في القائمة الرئيسية للمعاينة.',
        pv?.role==='teacher' ? teacherPreviewMenu() : studentPreviewMenu(await effectiveStudent(ctx))
      );
    }
    if (isAdmin(ctx)) {
      return ctx.reply(hadStep ? 'تم الرجوع عن الخطوة الحالية.' : 'أنت في القائمة الرئيسية.', adminMainMenu());
    }
    const teacher=await effectiveTeacher(ctx);
    if(teacher)return ctx.reply('تم الرجوع إلى لوحة الأستاذ.',teacherMainMenu());
    const student = await effectiveStudent(ctx);
    if (!student) return ctx.reply('تم الرجوع. أرسل /start لبدء التسجيل من جديد.');
    return replyStudentScreen(
      ctx,
      student,
      hadStep ? 'تم الرجوع عن الخطوة الحالية.' : 'أنت في القائمة الرئيسية.',
      studentMainMenu(student)
    );
  }

  if (inputText === '❌ إلغاء العملية') {
    await studentGuide.clear(ctx);
    userState.delete(ctx.from.id);
    if(isInPreview(ctx)){
      const pv=getPreview(ctx);
      return ctx.reply('تم إلغاء الخطوة الحالية في المعاينة.',pv?.role==='teacher'?teacherPreviewMenu():studentPreviewMenu(await effectiveStudent(ctx)));
    }
    if(isAdmin(ctx))return ctx.reply('تم إلغاء العملية الحالية.',adminMainMenu());
    const teacher=await effectiveTeacher(ctx);
    const student=teacher?null:await effectiveStudent(ctx);
    return ctx.reply('تم إلغاء العملية الحالية.',teacher?teacherMainMenu():studentMainMenu(student));
  }

  // الضغط على زر رئيسي: يُلغي أي إدخال قديم، وينظّف رسائل البوت السابقة
  if (
    ADMIN_MENU_BUTTONS.has(inputText) ||
    STUDENT_MENU_BUTTONS.has(inputText) ||
    TEACHER_MENU_BUTTONS.has(inputText)
  ) {
    userState.delete(ctx.from.id);
    await purgeBotMessages(ctx);
    return next();
  }

  const state = userState.get(ctx.from.id);
  if (!state) return next();
  if(state.action==='contact_search'){
    const q=String(ctx.message.text||'').trim();
    if(!q||q.length>150)return ctx.reply('أرسل الاسم أو جزءًا منه، حتى 150 حرفًا.');
    userState.set(ctx.from.id,{...state,action:'contact_results',q});
    return showContactStudents(ctx,state.role,state.subjectId||0,q,0);
  }
  if(state.action==='contact_compose'){
    const message=String(ctx.message.text||'').trim();
    if(!message||message.length>3000)return ctx.reply('أرسل رسالة نصية من 1 إلى 3000 حرف، أو اضغط «❌ إلغاء العملية».');
    if(isInPreview(ctx))return ctx.reply('اخرج من وضع المعاينة أولًا.');
    const role=isAdmin(ctx)?'admin':await db.getTeacherByTelegramId(ctx.from.id)?'teacher':null;
    if(role!==state.role)return ctx.reply('انتهت صلاحية هذه الخطوة. ابدأ البحث من جديد.');
    try{
      const saved=await require('./studentContact').createStudentContact(db.pool).send({
        actorId:ctx.from.id,role,studentId:state.studentId,subjectId:state.subjectId||null,
        message,contextKind:state.contextKind||(state.reportId?'report':null),contextId:state.contextId||state.reportId||null,
        requestKey:`contact:${ctx.from.id}:${ctx.message.message_id}`});
      userState.delete(ctx.from.id);
      return ctx.reply(`حُفظت رسالتك للطالب للإرسال عبر البوت ✅\nرقم الرسالة: ${saved.id}`,role==='admin'?adminMainMenu():teacherMainMenu());
    }catch(err){return ctx.reply(`تعذر حفظ الرسالة: ${err.message}`);}
  }
  if(state.action==='broadcast_compose'){
    const message=String(ctx.message.text||'').trim();
    if(!message||message.length>3000)return ctx.reply('اكتب رسالة من 1 إلى 3000 حرف، أو اضغط «❌ إلغاء العملية».');
    const actor=await broadcastActor(ctx);
    if(!actor){userState.delete(ctx.from.id);return ctx.reply('انتهت صلاحية الإرسال. افتح الزر من جديد.');}
    try{
      const preview=await broadcasts.preview(actor,state.scope);
      if(!preview.recipientCount)return ctx.reply('لا يوجد طلبة مستلمون في هذا النطاق. اختر نطاقًا آخر.');
      userState.set(ctx.from.id,{action:'broadcast_confirm',scope:state.scope,message,
        requestKey:`broadcast:${ctx.from.id}:${ctx.message.message_id}`});
      return ctx.reply(`📣 مراجعة الرسالة\nالنطاق: ${preview.label}\nعدد المستلمين: ${preview.recipientCount}\n\n${message}\n\nهل تريد إرسالها؟`,
        Markup.inlineKeyboard([[callbackButton('✅ تأكيد الإرسال', 'broadcast:confirm')],
          [callbackButton('❌ إلغاء', 'admin_cancel_noop')]]));
    }catch(err){userState.delete(ctx.from.id);return ctx.reply(`تعذر تجهيز الرسالة: ${err.message}`);}
  }
  if(state.action==='broadcast_confirm')return ctx.reply('اضغط «تأكيد الإرسال» أو «إلغاء» أسفل معاينة الرسالة.');
  if (state.action === 'awaiting_onboarding_ack') {
    return ctx.reply('اضغط زر «ابدأ التسجيل» أسفل الدليل، أو «لديّ كود تفعيل / نقل حساب». لفتح الدليل مجددًا أرسل /guide.');
  }
  if(state.action.startsWith('teacher_')){
    const exam=state.examId?await studies.getExamById(state.examId):null;
    const subjectId=exam?.subject_id||state.subjectId,seasonId=exam?.stage_season_id||state.ssId;
    if(subjectId&&seasonId&&!await teacherOwnsSubject(ctx,subjectId,seasonId)){
      userState.delete(ctx.from.id);return ctx.reply('لم تعد لديك صلاحية تعديل هذه المادة.');
    }
  }
  // Revalidate the target when a teacher submits the text step: old callbacks
  // and forged ids must not edit an unrelated student's report/grade.
  if(['teacher_report_score','grade_override','lessons_score','report_item_score'].includes(state.action)) {
    if(!await access.studentSubject(state.studentId,state.subjectId,state.ssId) ||
      (state.reportId && !await access.reportMatches(state.reportId,state.studentId,state.subjectId,state.ssId))) {
      userState.delete(ctx.from.id);return ctx.reply('لم يعد هذا السجل متاحًا للتعديل في المادة والموسم المختارين.');
    }
  }

  // -------- الأستاذ: سبب تأجيل مباحثة اليوم --------
  if (state.action === 'teacher_slot_postpone_reason') {
    const reason = ctx.message.text.trim().replace(/\s+/g, ' ');
    if (reason.length < 3 || reason.length > 300) {
      return ctx.reply('اكتب سببًا مختصرًا وواضحًا للتأجيل (من 3 إلى 300 حرف).');
    }
    const teacher = await effectiveTeacher(ctx);
    if (!isAdmin(ctx) && (!teacher || !await access.teacherObject(teacher.id, 'slot', state.slotId))) {
      userState.delete(ctx.from.id);
      return ctx.reply('لم يعد هذا الموعد ضمن صلاحياتك.');
    }
    const saved = await studies.setSlotDecisionReason(state.slotId, state.date, ctx.from.id, reason);
    if (!saved) {
      userState.delete(ctx.from.id);
      return ctx.reply('لم يعد بالإمكان حفظ سبب التأجيل؛ ربما بدأ الموعد أو تغيّر القرار.');
    }
    const notice = await scheduler.queueSlotDecisionNotice(state.slotId, state.date, 'postponed', reason);
    userState.delete(ctx.from.id);
    return ctx.reply(
      `🕓 حُفظ تأجيل مباحثة اليوم.\nالسبب: ${reason}\n` +
      `حُفظ إشعار ${Number(notice?.notified || 0)} طالبًا في طابور الإرسال.`,
      teacher ? teacherMainMenu() : adminMainMenu()
    );
  }

  // -------- تسجيل اسم الطالب --------
  if (state.action === 'awaiting_full_name') {
    const fullName = ctx.message.text.trim();

    // كود من 8 محارف: قد يكون كود نقل حساب طالب أو كود تفعيل أستاذ.
    if (/^[A-Za-z0-9]{8}$/.test(fullName)) {
      // (أ) نقل حساب طالب غيّر هاتفه أو حساب تليجرام
      try {
        const moved = await db.transferStudentAccount(fullName, ctx.from.id);
        if (moved) {
          userState.delete(ctx.from.id);
          return ctx.reply(
            `✅ تم نقل حسابك بنجاح.\nأهلًا بعودتك ${moved.full_name} 👋\n\n` +
              'سجلك كامل محفوظ: الحضور والمباحثات والامتحانات والدرجات.',
            studentMainMenu(await effectiveStudent(ctx))
          );
        }
      } catch (err) {
        if (err.code === 'ACCOUNT_IN_USE') {
          userState.delete(ctx.from.id);
          return ctx.reply(err.message);
        }
        throw err;
      }
      // (ب) كود تفعيل أستاذ
      try {
        const teacher = await db.linkTeacherAccount(fullName, ctx.from.id);
        if (teacher) {
          userState.delete(ctx.from.id);
          return ctx.reply(
            `تم تفعيل حسابك كأستاذ ✅\nأهلًا بك أستاذ ${teacher.full_name}.`,
            teacherMainMenu()
          );
        }
      } catch (err) {
        if (err.code === 'ALREADY_LINKED') {
          userState.delete(ctx.from.id);
          return ctx.reply('هذا الحساب مرتبط بأستاذ بالفعل. أرسل /teacher لفتح لوحتك.');
        }
        throw err;
      }
      // ليس كود تفعيل صالحًا — يُكمل كاسم عادي إن كان التسجيل مفتوحًا
    }

    if (!(await db.isStudentRegistrationOpen())) {
      return ctx.reply(
        '⛔ التسجيل الجديد متوقف حاليًا. إذا كان لديك كود تفعيل أستاذ أو كود نقل حساب صحيح فأرسله، وإلا تواصل مع إدارة المعهد.'
      );
    }

    if (fullName.split(/\s+/).length < 4) {
      return ctx.reply('الرجاء إدخال الاسم الرباعي كاملًا (أربعة أسماء على الأقل).', backOnlyMenu());
    }
    const stages = await db.listRegistrationStages();
    if (stages.length === 0) {
      userState.delete(ctx.from.id);
      return ctx.reply('لا توجد مرحلة متاحة للتسجيل الجديد حاليًا. يرجى المحاولة لاحقًا أو التواصل مع إدارة المعهد.');
    }
    userState.set(ctx.from.id, { action: 'awaiting_stage_choice', fullName });
    return ctx.reply('اختر مرحلتك الدراسية:', stagesKeyboard(stages, 'reg_stage'));
  }

  // -------- طلب إجازة: إدخال عدد الأيام --------
  if (state.action === 'leave_awaiting_days') {
    const days = parseLeaveDays(ctx.message.text);
    if (days === null) {
      const student = await effectiveStudent(ctx);
      if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
      return replyStudentScreen(
        ctx,
        student,
        `أرسل عدد أيام الإجازة فقط، مثال: 1 أو ١. يجب أن يكون العدد بين 1 و${MAX_LEAVE_DAYS_PER_SEASON}.\n` +
          `للرجوع اضغط «${BACK_BUTTON}».`,
        studentMainMenu(await effectiveStudent(ctx))
      );
    }
    const student = await effectiveStudent(ctx);
    if (!student) {
      userState.delete(ctx.from.id);
      return ctx.reply('الرجاء التسجيل أولًا عبر /start');
    }
    try {
      const leave = await db.requestLeave(
        student.id,
        currentDateInTimeZone(ATTENDANCE_TIME_ZONE),
        days,
        null
      );
      userState.delete(ctx.from.id);
      await replyStudentScreen(
        ctx,
        student,
        `تم إرسال طلب إجازتك ✅\nمن ${leave.start_date.toISOString().slice(0, 10)} ` +
          `إلى ${leave.end_date.toISOString().slice(0, 10)} (${days} يومًا).\n` +
          `الرصيد المتبقي في هذا الموسم: ${Number(leave.remaining_days)} من ${Number(leave.max_days)} أيام.\n` +
          'سيصلك إشعار عند قبول الأدمن للطلب. عند الموافقة لا تُحسب أيام الإجازة غيابًا، ' +
          'ويبقى التأشير ممكنًا خلال مهلة كل درس فقط.',
        studentMainMenu(await effectiveStudent(ctx))
      );
      // إشعار الأدمن مع أزرار الموافقة/الرفض
      await notifyAdmins(
        `🌴 طلب إجازة جديد\nالطالب: ${student.full_name}\nالمرحلة: ${student.stage_name || '—'}\n` +
          `المدة: ${days} يومًا (${leave.start_date.toISOString().slice(0, 10)} → ${leave.end_date
            .toISOString()
            .slice(0, 10)})\n` +
          `الرصيد المحجوز بعد الطلب: ${Number(leave.used_days)} من ${Number(leave.max_days)} أيام`,
        Markup.inlineKeyboard([
          [
            callbackButton('✅ موافقة', `leave_approve:${leave.id}`),
            callbackButton('❌ رفض', `leave_reject:${leave.id}`),
          ],
        ])
      );
      return undefined;
    } catch (err) {
      userState.delete(ctx.from.id);
      return replyStudentScreen(ctx, student, `تعذّر تسجيل الإجازة: ${err.message}`, studentMainMenu(await effectiveStudent(ctx)));
    }
  }

  // -------- الأستاذ: سعة المجموعة الجديدة --------
  if (state.action === 'teacher_group_capacity') {
    const cap = Number(ctx.message.text.trim());
    if (!Number.isInteger(cap) || cap < 1 || cap > 1000) {
      return ctx.reply('أرسل رقمًا صحيحًا بين 1 و1000.');
    }
    userState.set(ctx.from.id, { ...state, action: 'teacher_group_newlink', capacity: cap });
    return ctx.reply(
      'أرسل رابط دعوة مجموعة تليجرام الخاصة بها (مثال: https://t.me/+xxxx)، أو أرسل «تخطي» لإضافته لاحقًا:'
    );
  }

  // -------- الأستاذ: رابط المجموعة الجديدة ثم إنشاؤها --------
  if (state.action === 'teacher_group_newlink') {
    const raw = ctx.message.text.trim();
    const link = raw === 'تخطي' ? null : raw;
    const teacher = await teacherOwnsSubject(ctx, state.subjectId, state.ssId);
    userState.delete(ctx.from.id);
    if (!teacher) return ctx.reply('غير مصرح.');
    const group = await studies.createMubahathaGroup(state.subjectId, state.ssId, {
      inviteLink: link,
      capacity: state.capacity,
    });
    return ctx.reply(
      `✅ أُنشئت «${group.title}» بسعة ${group.capacity} طالبًا.\n` +
        (link ? '' : '⚠️ لم تُضف رابط الدعوة بعد؛ لن يستطيع الطلبة الانضمام حتى تضيفه.'),
      teacherMainMenu()
    );
  }

  // -------- الأستاذ: تعيين رابط دعوة لمجموعة قائمة --------
  if (state.action === 'teacher_group_link') {
    const link = ctx.message.text.trim();
    const group = await studies.getGroupById(state.groupId);
    userState.delete(ctx.from.id);
    if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
      return ctx.reply('غير مصرح.');
    }
    await studies.setGroupInviteLink(state.groupId, link);
    return ctx.reply('✅ حُفظ رابط الدعوة.', teacherMainMenu());
  }

  // -------- الأستاذ: تعديل سعة مجموعة قائمة --------
  if (state.action === 'teacher_group_editcap') {
    const cap = Number(ctx.message.text.trim());
    if (!Number.isInteger(cap) || cap < 1 || cap > 1000) {
      return ctx.reply('أرسل رقمًا صحيحًا بين 1 و1000.');
    }
    const group = await studies.getGroupById(state.groupId);
    userState.delete(ctx.from.id);
    if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
      return ctx.reply('غير مصرح.');
    }
    await studies.setGroupCapacity(state.groupId, cap);
    return ctx.reply(`✅ صارت السعة ${cap} طالبًا.`, teacherMainMenu());
  }

  // -------- الأستاذ: موضوع الامتحان قبل تحديد ساعات الإتاحة --------
  if(state.action==='teacher_exam_edit_title'){
    const exam=await studies.getExamById(state.examId);
    if(!exam||!await teacherOwnsSubject(ctx,exam.subject_id,exam.stage_season_id))return ctx.reply('غير مصرح.');
    const dateIso=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(exam.opens_at));
    try{await studies.updateExam(exam.id,{title:ctx.message.text.trim(),dateIso,hours:exam.available_hours});userState.delete(ctx.from.id);return renderExam(ctx,exam.id);}
    catch(err){return ctx.reply(err.message);}
  }
  if(state.action==='teacher_q_edit_prompt'){
    const prompt=ctx.message.text.trim();
    if(prompt.length<3||prompt.length>3000)return ctx.reply('أرسل سؤالًا بين 3 و3000 حرف.');
    if(state.type==='tf'){
      userState.set(ctx.from.id,{...state,action:'teacher_q_edit_tf_answer',prompt});
      return ctx.reply('اختر الإجابة الصحيحة:',Markup.inlineKeyboard([[callbackButton('صح',`ex_edit_tfans:${state.questionId}:صح`),callbackButton('خطأ',`ex_edit_tfans:${state.questionId}:خطأ`)]]));
    }
    userState.set(ctx.from.id,{...state,action:'teacher_q_edit_options',prompt});
    return ctx.reply('أرسل الخيارات، كل خيار في سطر مستقل (من 2 إلى 6):');
  }
  if(state.action==='teacher_q_edit_options'){
    const options=ctx.message.text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(options.length<2||options.length>6||new Set(options).size!==options.length)return ctx.reply('أرسل من خيارين إلى 6 خيارات مختلفة.');
    userState.set(ctx.from.id,{...state,action:'teacher_q_edit_mcq_answer',options});
    return ctx.reply('اختر الإجابة الصحيحة:',Markup.inlineKeyboard(options.map((x,i)=>[callbackButton(limitButtonText(x,45),`ex_edit_mcqans:${state.questionId}:${i}`)])));
  }
  if (state.action === 'teacher_exam_topic') {
    const title = ctx.message.text.trim();
    if (title.length < 3 || title.length > 150) {
      return ctx.reply('أرسل موضوعًا واضحًا للامتحان بين 3 و150 حرفًا.');
    }
    userState.set(ctx.from.id, { ...state, action: 'teacher_exam_hours', title });
    return ctx.reply(
      `الموضوع: «${title}»\n\nكم ساعة يبقى الامتحان متاحًا؟ (أرسل رقمًا، مثال: 24)`
    );
  }

  // -------- الأستاذ: ساعات إتاحة الامتحان ثم إنشاؤه --------
  if (state.action === 'teacher_exam_hours') {
    const hours = Number(ctx.message.text.trim());
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      return ctx.reply('أرسل عدد ساعات صحيحًا بين 1 و720.');
    }
    const teacher = await teacherOwnsSubject(ctx, state.subjectId, state.ssId);
    userState.delete(ctx.from.id);
    if (!teacher) return ctx.reply('غير مصرح.');
    try {
      const exam = await studies.createExam(state.subjectId, state.ssId, teacher.id, {
        examNumber: state.number,
        title: state.title || `الامتحان الشهري ${state.number}`,
        dateIso: state.dateIso,
        hours,
      });
      await ctx.reply(
        `✅ أُنشئ الامتحان الشهري ${state.number} وتم إشعار الطلبة به.\n` +
          `الموضوع: «${state.title || `الامتحان الشهري ${state.number}`}»\n` +
          `يفتح ${state.dateIso} ويبقى متاحًا ${hours} ساعة.\n` +
          'أضف الأسئلة فقط؛ وسيصبح الامتحان متاحًا تلقائيًا عند الموعد المحدد.',
        teacherMainMenu()
      );
      return renderExam(ctx, exam.id);
    } catch (err) {
      return ctx.reply(`تعذر إنشاء الامتحان: ${err.message}`, teacherMainMenu());
    }
  }

  // -------- الأستاذ: ساعات إتاحة الامتحان المؤجَّل --------
  if (state.action === 'teacher_exam_postpone_hours') {
    const hours = Number(ctx.message.text.trim());
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      return ctx.reply('أرسل عدد ساعات صحيحًا بين 1 و720.');
    }
    const exam = await studies.getExamById(state.examId);
    if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
      userState.delete(ctx.from.id);
      return ctx.reply('غير مصرح.');
    }
    try {
      const updated = await studies.postponeExam(state.examId, state.dateIso, hours);
      userState.delete(ctx.from.id);
      await ctx.reply(
        `✅ أُجّل الامتحان إلى ${state.dateIso} ويبقى متاحًا ${hours} ساعة.`,
        isAdmin(ctx) ? adminMainMenu() : teacherMainMenu()
      );
      return ctx.reply(updated.status==='published'?'📤 حُفظت إشعارات الموعد الجديد لإرسالها إلى الطلبة.':'حُفظ الموعد الجديد للمسودة.');
    } catch (err) {
      userState.delete(ctx.from.id);
      return ctx.reply(`تعذر التأجيل: ${err.message}`);
    }
  }

  // -------- الأستاذ: نص سؤال صح/خطأ ثم اختيار الجواب --------
  if (state.action === 'teacher_q_tf_prompt') {
    const prompt = ctx.message.text.trim();
    if (prompt.length < 3) return ctx.reply('أرسل نص سؤال صالح.');
    userState.set(ctx.from.id, { action: 'teacher_q_tf_answer', examId: state.examId, prompt });
    return ctx.reply(
      `السؤال: ${prompt}\n\nما الجواب الصحيح؟`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('صح', `ex_tfans:${state.examId}:صح`),
          Markup.button.callback('خطأ', `ex_tfans:${state.examId}:خطأ`),
        ],
      ])
    );
  }

  // -------- الأستاذ: نص سؤال الخيارات ثم الخيارات --------
  if (state.action === 'teacher_q_mcq_prompt') {
    const prompt = ctx.message.text.trim();
    if (prompt.length < 3) return ctx.reply('أرسل نص سؤال صالح.');
    userState.set(ctx.from.id, { action: 'teacher_q_mcq_options', examId: state.examId, prompt });
    return ctx.reply(
      'أرسل الخيارات، كل خيار في سطر مستقل (من خيارين إلى ستة). مثال:\n\nالخيار الأول\nالخيار الثاني\nالخيار الثالث'
    );
  }

  if (state.action === 'teacher_q_mcq_options') {
    const options = ctx.message.text
      .split('\n')
      .map((o) => o.trim())
      .filter(Boolean);
    if (options.length < 2 || options.length > 6) {
      return ctx.reply('أرسل من خيارين إلى ستة، كل واحد في سطر.');
    }
    userState.set(ctx.from.id, { ...state, action: 'teacher_q_mcq_correct', options });
    return ctx.reply(
      'أي الخيارات هو الصحيح؟',
      Markup.inlineKeyboard(
        options.map((o, i) => [Markup.button.callback(limitButtonText(o, 50), `ex_mcqans:${state.examId}:${i}`)])
      )
    );
  }

  // -------- الأستاذ: درجة تقرير طالب ثم الانتقال للذي يليه --------
  if (state.action === 'teacher_report_score') {
    const score = Number(ctx.message.text.trim());
    const max = studies.GRADE_WEIGHTS.participationTotal;
    if (Number.isNaN(score) || score < 0 || score > max) {
      return ctx.reply(`أرسل درجة بين 0 و${max}.`);
    }
    if (!(await teacherOwnsSubject(ctx, state.subjectId, state.ssId))) {
      userState.delete(ctx.from.id);
      return ctx.reply('غير مصرح.');
    }
    await studies.setReportScore(state.studentId, state.subjectId, state.ssId, score);
    await ctx.reply(`✅ ${state.studentName}: ${score} من ${max}.`);
    return showNextReportStudent(ctx, state.subjectId, state.ssId);
  }

  // -------- تقرير مكتوب نصًا من الطالب --------
  if (state.action === 'student_report_upload') {
    const student = await effectiveStudent(ctx);
    if (!student) {
      userState.delete(ctx.from.id);
      return ctx.reply('الرجاء التسجيل أولًا عبر /start');
    }
    const text = ctx.message.text.trim();
    if (text.length < 10) {
      return ctx.reply('التقرير النصي قصير جدًا. أرسل نصًا أوفى أو أرسل ملفًا.');
    }
    const assignment=await studies.assignStudentToGroup(student.id,state.subjectId,state.ssId);
    if(!assignment.group)return ctx.reply(assignment.message+' ثم أعد إرسال التقرير.');
    const report=await studies.submitReport(student.id, state.subjectId, state.ssId, {
      fileId: null,
      kind: 'text',
      note: text,
      sourceMessageId:ctx.message.message_id,
    });
    if(!report)return ctx.reply('لم يُضف تقرير جديد: إما أنه محفوظ مسبقًا أو تغيّر موسمك أو نمط مشاركتك.');
    const sent = await deliverReportToTeachers(student, state.subjectId, state.subjectName, {
      kind: 'text',
      fileId: null,
      note: text,
      groupTitle:report.group_title_snapshot,
    });
    userState.delete(ctx.from.id);
    return ctx.reply(
      `✅ استُلم تقرير مادة «${state.subjectName}».` +
        (sent.delivered > 0 ? '\nوصل إلى الأستاذ.' : '\nمحفوظ في النظام وسيطّلع عليه الأستاذ.'),
      studentMainMenu(await effectiveStudent(ctx))
    );
  }

  // ميزة درجة حضور الدروس أزيلت في 2.16. لا نعالج حالاتها القديمة.
  if(state.action==='lessons_score'){
    userState.delete(ctx.from.id);return ctx.reply('درجة حضور الدروس غير معتمدة ضمن نظام الدرجات الحالي.');
  }

  // -------- درجة تقرير مفرد (تقييم جزئي) --------
  if (state.action === 'report_item_score') {
    const score = Number(ctx.message.text.trim());
    const max = studies.GRADE_WEIGHTS.participationTotal;
    if (Number.isNaN(score) || score < 0 || score > max) {
      return ctx.reply(`أرسل درجة بين 0 و${max}.`);
    }
    if (!(await teacherOwnsSubject(ctx, state.subjectId, state.ssId))) {
      userState.delete(ctx.from.id);
      return ctx.reply('غير مصرح.');
    }
    await studies.setReportItemScore(state.reportId, score, ctx.from.id);
    const summary = await studies.getReportGradingSummary(state.studentId, state.subjectId, state.ssId);
    userState.delete(ctx.from.id);
    return ctx.reply(
      `✅ حُفظ تقييم هذا التقرير: ${score} من ${max}.\n` +
        `التقارير المُقيَّمة: ${Number(summary.graded)} من ${Number(summary.total)} | متوسط التقييمات: ${Number(summary.average)} من ${max}\n` +
        'لحفظ هذا المتوسط في سجل درجات الطالب، افتح قائمة تقييم تقاريره واضغط «حفظ متوسط التقييمات كدرجة التقارير». تقييم التقرير وحده لا يحدّث درجة التقارير المعتمدة.',
      isAdmin(ctx) ? adminMainMenu() : teacherMainMenu()
    );
  }

  // -------- تحرير درجة طالب من الأستاذ أو الأدمن --------
  if (state.action === 'grade_override') {
    const score = Number(ctx.message.text.trim());
    if (Number.isNaN(score) || score < 0 || score > state.max) {
      return ctx.reply(`أرسل درجة بين 0 و${state.max}.`);
    }
    if (!(await teacherOwnsSubject(ctx, state.subjectId, state.ssId))) {
      userState.delete(ctx.from.id);
      return ctx.reply('غير مصرح.');
    }
    const fields = state.field === 'part' ? { participationScore: score } : { examsScore: score };
    const saved = await studies.overrideStudentGrade(
      state.studentId, state.subjectId, state.ssId, fields, ctx.from.id
    );
    userState.delete(ctx.from.id);
    return ctx.reply(
      `✅ حُدّثت الدرجة.\nالمشاركة: ${Number(saved.participation_score)} | ` +
        `الامتحانات: ${Number(saved.exams_score)} | المجموع: ${Number(saved.total_score)}`,
      isAdmin(ctx) ? adminMainMenu() : teacherMainMenu()
    );
  }

  // -------- بحث عن طالب للدخول بصفته (معاينة) --------
  if (state.action === 'pv_search_student' && isAdmin(ctx)) {
    const results = await db.searchStudents(ctx.message.text.trim(), 12);
    userState.delete(ctx.from.id);
    if (results.length === 0) return ctx.reply('لا توجد نتائج مطابقة.');
    return ctx.reply(
      'اختر الطالب للدخول بصفته:',
      Markup.inlineKeyboard(
        results.map((s) => [
          callbackButton(limitButtonText(`${s.full_name} — ${s.stage_name}`, 48), `pv_as_student:${s.id}`),
        ])
      )
    );
  }

  if (!isAdmin(ctx)) return next(); // كل الحالات التالية خاصة بالأدمن فقط

  // -------- إضافة طالب يدويًا: Telegram ID --------
  if (state.action === 'admin_manual_student_id') {
    const raw=ctx.message.text.trim();
    if(!/^\d{4,20}$/.test(raw))return ctx.reply('أرسل Telegram ID صحيحًا بالأرقام فقط.');
    try{if(BigInt(raw)<=0n)throw new Error();}catch{return ctx.reply('Telegram ID غير صالح.');}
    const existing=await db.getStudentByTelegramId(raw);
    if(existing){
      userState.delete(ctx.from.id);
      return ctx.reply(`هذا الـ ID مرتبط مسبقًا بالطالب «${existing.full_name}».`,adminMainMenu());
    }
    userState.set(ctx.from.id,{action:'admin_manual_student_name',telegramId:raw});
    return ctx.reply('أرسل الاسم الرباعي للطالب:');
  }

  // -------- إضافة طالب يدويًا: الاسم ثم اختيار المرحلة --------
  if (state.action === 'admin_manual_student_name') {
    const fullName=ctx.message.text.trim().replace(/\s+/g,' ');
    if(fullName.split(' ').length<4||fullName.length>200)return ctx.reply('أرسل الاسم الرباعي الكامل (أربعة أسماء على الأقل).');
    const stages=await db.listStages();
    if(!stages.length){userState.delete(ctx.from.id);return ctx.reply('لا توجد مرحلة نشطة لإضافة الطالب إليها.');}
    userState.set(ctx.from.id,{action:'admin_manual_student_stage',telegramId:state.telegramId,fullName});
    return ctx.reply(
      `الطالب: ${fullName}\nTelegram ID: ${state.telegramId}\n\nاختر المرحلة:`,
      Markup.inlineKeyboard(stages.map(st=>[callbackButton(limitButtonText(st.name),`admin_manual_student_stage:${st.id}`)]))
    );
  }

  // -------- إضافة مرحلة --------
  if (state.action === 'admin_awaiting_stage_name') {
    const name = ctx.message.text.trim();
    if (!name) return ctx.reply('أرسل اسمًا غير فارغ للمرحلة أو اضغط «↩️ رجوع».');
    userState.set(ctx.from.id, { action: 'admin_awaiting_stage_type', stageName: name });
    return ctx.reply(
      `المرحلة: ${name}\n\nاختر نوعها:\n\n` +
        '• **حضور دروس فقط**: يستمع الطالب للدروس ويؤشّر حضوره، بلا مباحثات ولا تقارير ولا امتحانات.\n' +
        '• **كاملة**: دروس + مباحثات أو تقارير + امتحانات شهرية ودرجات.',
      Markup.inlineKeyboard([
        [callbackButton('📚 حضور دروس فقط', 'stage_type:lessons_only')],
        [callbackButton('🎓 كاملة (مباحثات وتقارير وامتحانات)', 'stage_type:full')],
      ])
    );
  }

  // -------- تعديل اسم مرحلة --------
  if (state.action === 'admin_awaiting_stage_rename') {
    const name = ctx.message.text.trim();
    if (!name) return ctx.reply('أرسل اسمًا غير فارغ للمرحلة أو اضغط «↩️ رجوع».');
    try {
      await db.updateStageName(state.stageId, name);
    } catch (err) {
      if (err.code === '23505') return ctx.reply('اسم المرحلة مستخدم مسبقًا. أرسل اسمًا آخر أو ألغِ العملية.');
      throw err;
    }
    userState.delete(ctx.from.id);
    return ctx.reply(`تم تعديل اسم المرحلة إلى «${name}» ✅`, adminMainMenu());
  }

  // -------- اسم موسم جديد ثم اختيار المراحل --------
  if (state.action === 'admin_awaiting_season_name') {
    const seasonName = ctx.message.text.trim();
    if (!seasonName) return ctx.reply('الرجاء إدخال اسم صالح للموسم.');
    const stages = await db.listStages();
    if (stages.length === 0) {
      userState.delete(ctx.from.id);
      return ctx.reply('لا توجد مراحل نشطة لبدء موسم جديد.', adminMainMenu());
    }
    userState.set(ctx.from.id, {
      action: 'admin_selecting_season_stages',
      seasonName,
      selectedStageIds: [],
    });
    return ctx.reply(
      `اختر المراحل التي سيبدأ لها موسم «${seasonName}».\nالمراحل غير المختارة ستبقى في موسمها الحالي:`,
      seasonSelectionKeyboard(stages, [])
    );
  }

  // -------- إضافة أستاذ --------
  if (state.action === 'admin_awaiting_teacher_name') {
    const name = ctx.message.text.trim();
    if (name.length < 3) return ctx.reply('الرجاء إدخال اسم صالح للأستاذ.');
    const teacher = await db.addTeacher(name);
    userState.delete(ctx.from.id);
    return ctx.reply(
      `تمت إضافة الأستاذ «${teacher.full_name}» ✅\n\n` +
        `كود التفعيل:\n\n${teacher.link_code}\n\n` +
        'أرسل هذا الكود للأستاذ، ويكتبه في البوت بعد /start ليُفعَّل حسابه.\n' +
        'ثم أسنِد إليه المواد من «👨‍🏫 إدارة الأساتذة».',
      adminMainMenu()
    );
  }

  // -------- إضافة مادة: الاسم --------
  if (state.action === 'admin_awaiting_subject_name') {
    const name = ctx.message.text.trim();
    if (!name) return ctx.reply('أرسل اسمًا غير فارغ للمادة أو اضغط «↩️ رجوع».');
    userState.set(ctx.from.id, { action: 'admin_awaiting_subject_hashtag', stageId: state.stageId, name });
    return ctx.reply(
      'أدخل الهاشتاغ الذي سيُستخدم لهذه المادة داخل منشورات القناة (بدون # وبدون مسافات)، أو أرسل "تخطي" لتوليده تلقائيًا من الاسم:'
    );
  }

  // -------- إضافة مادة: الهاشتاغ --------
  if (state.action === 'admin_awaiting_subject_hashtag') {
    const input = ctx.message.text.trim();
    const hashtag = normalizeHashtag(input === 'تخطي' ? state.name : input);
    if (!hashtag) return ctx.reply('أرسل هاشتاغًا صحيحًا يحتوي حروفًا أو أرقامًا، أو أرسل «تخطي».');
    try {
      await db.addSubject(state.stageId, state.name, hashtag);
    } catch (err) {
      if (err.code === '23505') {
        return ctx.reply('هذا الهاشتاغ مستخدم بالفعل لمادة أخرى في نفس المرحلة. أرسل هاشتاغًا مختلفًا أو ألغِ العملية.');
      }
      throw err;
    }
    userState.delete(ctx.from.id);
    return ctx.reply(`تمت إضافة المادة: ${state.name} (هاشتاغ: #${hashtag}) ✅`, adminMainMenu());
  }

  // -------- تعديل هاشتاغ مادة --------
  if (state.action === 'admin_awaiting_subject_hashtag_edit') {
    const hashtag = normalizeHashtag(ctx.message.text);
    if (!hashtag) return ctx.reply('أرسل هاشتاغًا صحيحًا بدون مسافات.');
    try {
      await db.updateSubjectHashtag(state.subjectId, hashtag);
    } catch (err) {
      if (err.code === '23505') {
        return ctx.reply('هذا الهاشتاغ مستخدم لمادة أخرى في المرحلة نفسها. أرسل هاشتاغًا مختلفًا أو اضغط «إلغاء العملية».');
      }
      throw err;
    }
    userState.delete(ctx.from.id);
    return ctx.reply(`تم تحديث هاشتاغ مادة «${state.subjectName}» إلى #${hashtag} ✅`, adminMainMenu());
  }

  // -------- بحث عن طالب --------
  if (state.action === 'admin_awaiting_student_search') {
    const q = ctx.message.text.trim();
    const stageId=state.stageId||0;
    userState.set(ctx.from.id,{action:'students_search_results',stageId,q});
    return showStageStudents(ctx,stageId,0,q);
  }

  // -------- تعديل اسم طالب --------
  if (state.action === 'admin_awaiting_new_name') {
    const name = ctx.message.text.trim();
    if (name.split(/\s+/).length < 4) {
      return ctx.reply('أرسل الاسم الرباعي الكامل للطالب (أربعة أسماء على الأقل)، أو اضغط «↩️ رجوع».');
    }
    await db.updateStudentName(state.studentId, name);
    userState.delete(ctx.from.id);
    return ctx.reply(`تم تحديث الاسم إلى: ${name} ✅`, adminMainMenu());
  }

  return next();
});

// ---------------------------------------------------------------------------
// اختيار المرحلة أثناء تسجيل الطالب
// ---------------------------------------------------------------------------
bot.action(/reg_stage:(\d+)/, async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'awaiting_stage_choice') return ctx.answerCbQuery();
  const stageId = Number(ctx.match[1]);
  // تحقق لحظة الضغط أيضًا: قد تكون المرحلة حُجبت بعد إرسال لوحة الاختيار للطالب.
  const availableStages = await db.listRegistrationStages();
  if (!availableStages.some((stage) => Number(stage.id) === stageId)) {
    if (availableStages.length === 0) {
      userState.delete(ctx.from.id);
      await ctx.answerCbQuery('التسجيل في هذه المرحلة غير متاح حاليًا.', { show_alert: true });
      return ctx.editMessageText('لا توجد مرحلة متاحة للتسجيل الجديد حاليًا. يرجى المحاولة لاحقًا أو التواصل مع إدارة المعهد.');
    }
    await ctx.answerCbQuery('هذه المرحلة محجوبة عن التسجيل الجديد حاليًا.', { show_alert: true });
    return ctx.editMessageText('اختر مرحلتك الدراسية من المراحل المتاحة حاليًا:', stagesKeyboard(availableStages, 'reg_stage'));
  }
  await db.createStudent(ctx.from.id, state.fullName, stageId);
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تم حفظ بيانات التسجيل');
  await ctx.editMessageText('تم حفظ اسمك ومرحلتك بنجاح ✅');
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await deleteMessageQuietly(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id);
  }
  return sendOfficialConfirmationPrompt(ctx);
});

// ---------------------------------------------------------------------------
// دروس اليوم للطالب
// ---------------------------------------------------------------------------
bot.action('menu_today', async (ctx) => {
  await ctx.answerCbQuery();
  return showTodayLessons(ctx);
});

bot.hears('📚 دروس اليوم', (ctx) => showTodayLessons(ctx));


function studentScheduleDateLabel(iso){
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('ar-IQ',{timeZone:'UTC',weekday:'long',day:'numeric',month:'numeric',year:'numeric'});
}

function shiftIsoDate(iso, days){
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0,10);
}

function isoWeekday(iso){
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function studentScheduleWindow(todayIso){
  // يبدأ الأسبوع الدراسي من السبت وينتهي الأربعاء، والخميس والجمعة
  // يعرضان الجدول المقرر للأسبوع القادم.
  const weekday = isoWeekday(todayIso);
  const showNextWeek = weekday === 4 || weekday === 5; // الخميس والجمعة
  const saturdayOffset = showNextWeek
    ? 6 - weekday
    : -((weekday + 1) % 7);
  const startDate = shiftIsoDate(todayIso, saturdayOffset);
  const endDate = shiftIsoDate(startDate, 4); // السبت إلى الأربعاء
  return {
    startDate,
    endDate,
    label: showNextWeek ? 'الأسبوع القادم' : 'هذا الأسبوع',
  };
}

function studentScheduleDayLabel(iso){
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('ar-IQ',{
    timeZone:'UTC', weekday:'long', day:'numeric', month:'numeric'
  });
}

function studentScheduleDays(data, startDate, endDate){
  const checked=new Set(data.entries.map(e=>`${e.subject_id}:${e.lesson_date}`));
  const days=[];
  let cursor=startDate;
  while(cursor<=endDate){
    const subjects=data.subjects.filter(sub=>checked.has(`${sub.id}:${cursor}`));
    if(subjects.length)days.push({date:cursor,subjects});
    cursor=shiftIsoDate(cursor,1);
  }
  return days;
}

// جدول الطالب من الموسم النشط لمرحلته؛ قد يبقى تسجيل الطالب مرتبطًا بموسم سابق.
async function getStudentLessonScheduleData(student){
  if(!student.stage_id)return null;
  const activeSeason=(await db.pool.query(`
    SELECT ss.id AS stage_season_id
    FROM stage_seasons ss
    JOIN stages st ON st.id=ss.stage_id AND st.is_active=true
    WHERE ss.stage_id=$1 AND ss.is_active=true
    ORDER BY ss.id DESC
    LIMIT 1`,[student.stage_id])).rows[0];
  if(activeSeason)return db.getLessonSchedule(activeSeason.stage_season_id);
  const enrolledSeason=await db.getStudentActiveStageSeason(student.id);
  return enrolledSeason?db.getLessonSchedule(enrolledSeason.stage_season_id):null;
}

async function showStudentLessonSchedule(ctx){
  const student=await effectiveStudent(ctx);
  if(!student)return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const data=await getStudentLessonScheduleData(student);
  if(!data)return ctx.reply('لا يوجد موسم دراسي نشط لمرحلتك حاليًا.');
  if(!data.subjects || data.subjects.length===0)return ctx.reply('لا توجد مواد مرتبطة بمرحلتك حاليًا.');

  const today=currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  const window=studentScheduleWindow(today);
  const days=studentScheduleDays(data,window.startDate,window.endDate);
  const rows=days.map(day=>[
    callbackButton(`📅 ${studentScheduleDayLabel(day.date)}`,`student_schedule_day:${day.date}`)
  ]);
  const text=
    `📅 الجدول الدراسي لـ${window.label}\n`+
    `المرحلة: ${data.stage_name}\n\n`+
    (days.length
      ? 'اختر يوم النشر لعرض المواد المقررة فيه:'
      : 'لا توجد مواعيد نشر محددة في الجدول لهذه الفترة.');
  rows.push([callbackButton('↩️ العودة إلى دروس اليوم','menu_today')]);
  return replyStudentScreen(ctx,student,text,Markup.inlineKeyboard(rows));
}

async function showStudentScheduleDay(ctx, iso){
  const student=await effectiveStudent(ctx);
  if(!student)return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const data=await getStudentLessonScheduleData(student);
  if(!data)return ctx.reply('لا يوجد موسم دراسي نشط لمرحلتك حاليًا.');
  if(!data.subjects || data.subjects.length===0)return ctx.reply('لا توجد مواد مرتبطة بمرحلتك حاليًا.');

  const today=currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  const window=studentScheduleWindow(today);
  if(iso<window.startDate || iso>window.endDate || [4,5].includes(isoWeekday(iso))){
    await ctx.answerCbQuery('هذا اليوم ليس ضمن الجدول المعروض حاليًا.');
    return showStudentLessonSchedule(ctx);
  }

  const checked=new Set(data.entries.map(e=>`${e.subject_id}:${e.lesson_date}`));
  const subjects=data.subjects.filter(sub=>checked.has(`${sub.id}:${iso}`));
  if(!subjects.length){
    await ctx.answerCbQuery('لا توجد مواد مقررة لهذا اليوم.');
    return showStudentLessonSchedule(ctx);
  }

  const list=subjects.map((subject,index)=>`${index+1}. ${subject.name}`).join('\n');
  const text=
    `📅 ${studentScheduleDayLabel(iso)}\n`+
    `المرحلة: ${data.stage_name}\n\n`+
    `مواد النشر:\n${list}`;
  await ctx.answerCbQuery();
  return replyStudentScreen(ctx,student,text,Markup.inlineKeyboard([
    [callbackButton('↩️ أيام الجدول الدراسي','student_lesson_schedule')],
    [callbackButton('📚 دروس اليوم','menu_today')]
  ]));
}
bot.action('student_lesson_schedule', async ctx=>{await ctx.answerCbQuery();return showStudentLessonSchedule(ctx);});
bot.action(/^student_schedule_day:(\d{4}-\d{2}-\d{2})$/, async ctx=>showStudentScheduleDay(ctx,ctx.match[1]));

async function openMyReport(ctx) {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const seasons = await db.listStudentSeasons(student.id);
  if (seasons.length === 0) return replyStudentScreen(ctx, student, withStudentName(student, 'لا توجد بيانات دراسية مسجلة حتى الآن.'));
  if (seasons.length === 1) {
    await sendStudentReportMessages(ctx, student.id, seasons[0].id, { student });
    return undefined;
  }
  const rows = seasons.map((season) => [
    callbackButton(
      `${season.is_active ? '🟢' : '📘'} ${season.stage_name} — ${limitButtonText(formatSeasonLabel(season), 40)}`,
      `my_report_season:${season.id}`
    ),
  ]);
  return replyStudentScreen(ctx, student, withStudentName(student, 'اختر الموسم الذي تريد عرض تقريره:'), Markup.inlineKeyboard(rows));
}

bot.hears(['📊 تقرير الحضور','📊 تقريري'], async ctx => {
  if(isAdmin(ctx)&&!isInPreview(ctx))return openReports(ctx);
  if(getPreview(ctx)?.role==='teacher'||(!isInPreview(ctx)&&await effectiveTeacher(ctx)))return showTeacherAttendanceMenu(ctx);
  return openMyReport(ctx);
});

bot.action(/my_report_season:(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const seasonId = Number(ctx.match[1]);
  // لا نسمح بزر قديم محفوظ في تليجرام أن يفتح موسمًا سابقًا بعد نقل الطالب.
  const visibleSeasons = await db.listStudentSeasons(student.id);
  if (!visibleSeasons.some((season) => Number(season.id) === seasonId)) {
    return ctx.answerCbQuery('هذا الموسم لم يعد ضمن مرحلتك الحالية.', { show_alert: true });
  }
  await ctx.answerCbQuery();
  const rows = await sendStudentReportMessages(ctx, student.id, seasonId, { student });
  if (rows.length === 0) return replyStudentScreen(ctx, student, withStudentName(student, 'لا توجد بيانات لهذا الموسم.'));
  return undefined;
});

async function openStudentSeasonActivity(ctx) {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const activity = await db.getStudentCurrentSeasonActivity(
    student.id,
    currentDateInTimeZone(ATTENDANCE_TIME_ZONE)
  );
  return replyStudentScreen(ctx, student, withStudentName(student, formatStudentSeasonActivity(activity)), studentMainMenu(await effectiveStudent(ctx)));
}

bot.hears(STUDENT_ACTIVITY_BUTTON, openStudentSeasonActivity);
// توافق مؤقت مع لوحة المفاتيح القديمة؛ بعد أول ضغط تظهر تسمية «المتغيرات» الجديدة.
bot.hears(LEGACY_STUDENT_ACTIVITY_BUTTON, openStudentSeasonActivity);
bot.hears(LEGACY_STUDENT_ACTIVITY_BUTTON_2, openStudentSeasonActivity);

// ---------------------------------------------------------------------------
// الطالب — طلب إجازة / إلغاؤها
// ---------------------------------------------------------------------------
async function openLeaveRequest(ctx) {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!student.is_active) return ctx.reply(withStudentName(student, 'حسابك مؤرشف حاليًا.'));

  const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  const [active, pending, usage] = await Promise.all([
    db.getActiveOrUpcomingLeave(student.id, today),
    db.getPendingLeave(student.id),
    db.getCurrentSeasonLeaveUsage(student.id),
  ]);
  if (!usage) {
    return replyStudentScreen(
      ctx,
      student,
      withStudentName(student, 'لا يوجد موسم دراسي نشط في حسابك حاليًا، لذلك لا يمكن تقديم طلب إجازة.'),
      studentMainMenu(await effectiveStudent(ctx))
    );
  }
  if (active) {
    return replyStudentScreen(
      ctx,
      student,
      withStudentName(student, `لديك إجازة معتمدة من ${active.start_date.toISOString().slice(0, 10)} ` +
        `إلى ${active.end_date.toISOString().slice(0, 10)}.\n` +
        `الرصيد المتبقي في الموسم: ${usage.remainingDays} من ${usage.maxDays} أيام.`),
      Markup.inlineKeyboard([[callbackButton('إلغاء الإجازة والعودة للدروس', `leave_cancel:${active.id}`, 'danger')]])
    );
  }
  if (pending) {
    return replyStudentScreen(
      ctx,
      student,
      withStudentName(student, `لديك طلب إجازة قيد المراجعة من ${pending.start_date.toISOString().slice(0, 10)} ` +
        `إلى ${pending.end_date.toISOString().slice(0, 10)}.\n` +
        `الرصيد المتبقي بعد احتساب الطلب المعلّق: ${usage.remainingDays} من ${usage.maxDays} أيام.`),
      Markup.inlineKeyboard([[callbackButton('سحب الطلب', `leave_cancel:${pending.id}`, 'danger')]])
    );
  }
  if (usage.remainingDays <= 0) {
    return replyStudentScreen(
      ctx,
      student,
      withStudentName(student, `استنفدت رصيد الإجازات للموسم الحالي (${usage.maxDays} أيام)، ولا يمكن تقديم طلب جديد حتى الموسم القادم.`),
      studentMainMenu(await effectiveStudent(ctx))
    );
  }
  userState.set(ctx.from.id, { action: 'leave_awaiting_days' });
  return replyStudentScreen(
    ctx,
    student,
    withStudentName(student, 'طلب إجازة 🌴\nأرسل عدد أيام الإجازة المطلوبة، مثال: 1 أو ١.\n' +
      `المتبقي لك في هذا الموسم: ${usage.remainingDays} من ${usage.maxDays} أيام.\n` +
      'ستبدأ الإجازة تلقائيًا من اليوم بعد موافقة الأدمن.\n' +
      `للرجوع اضغط «${BACK_BUTTON}».`),
    studentMainMenu(await effectiveStudent(ctx))
  );
}

bot.hears('🌴 طلب إجازة', openLeaveRequest);

bot.action(/leave_cancel:(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const cancelled = await db.cancelLeave(
    student.id,
    Number(ctx.match[1]),
    currentDateInTimeZone(ATTENDANCE_TIME_ZONE)
  );
  if (!cancelled) return ctx.answerCbQuery('لا توجد إجازة قابلة للإلغاء.');
  await ctx.answerCbQuery('تم الإلغاء ✅');
  await ctx.editMessageText('تم إلغاء الإجازة. ستعود إليك إشعارات الدروس من جديد.');
  await notifyAdmins(`ℹ️ ألغى الطالب «${student.full_name}» إجازته.`);
  return undefined;
});

// ---------------------------------------------------------------------------
// الأدمن — مراجعة طلبات الإجازة
// ---------------------------------------------------------------------------
async function openLeaveRequests(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const pending = await db.listPendingLeaves();
  await answerIfCallback(ctx);
  if (pending.length === 0) return ctx.reply('لا توجد طلبات إجازة معلّقة.');
  for (const leave of pending) {
    await ctx.reply(
      `🌴 طلب إجازة\nالطالب: ${leave.full_name}\nالمرحلة: ${leave.stage_name}\n` +
        `المدة: ${leave.days} يومًا (${leave.start_date.toISOString().slice(0, 10)} → ${leave.end_date
          .toISOString()
          .slice(0, 10)})`,
      Markup.inlineKeyboard([
        [
          callbackButton('✅ موافقة', `leave_approve:${leave.id}`),
          callbackButton('❌ رفض', `leave_reject:${leave.id}`),
        ],
        [callbackButton('💬 الرد على الطالب',`contact:leave:${leave.id}`)],
      ])
    );
  }
  return undefined;
}

bot.hears('🌴 طلبات الإجازة', openLeaveRequests);

const studentContact = require('./studentContact').createStudentContact(db.pool);
async function showContactStudents(ctx, role, subjectId, query, page) {
  try {
    const result = await studentContact.search({actorId:ctx.from.id,role,subjectId:subjectId||null,q:query,page});
    const rows=result.rows.map(st=>[callbackButton(limitButtonText(`${st.full_name} — ${st.stage_name||st.subject_name||''}`,52),`contact:select:${role}:${st.id}:${subjectId||0}`)]);
    const nav=[];
    if(page>0)nav.push(callbackButton('السابق',`contact:page:${role}:${subjectId||0}:${page-1}`));
    if((page+1)*20<result.total)nav.push(callbackButton('التالي',`contact:page:${role}:${subjectId||0}:${page+1}`));
    if(nav.length)rows.push(nav);
    return ctx.reply(`نتائج البحث عن «${query}»: ${result.total} طالب. اختر الطالب للتواصل:`,rows.length?Markup.inlineKeyboard(rows):undefined);
  } catch(err) { return ctx.reply(`تعذر البحث: ${err.message}`); }
}
bot.hears('💬 التواصل مع طالب معين',async ctx=>{
  if(isInPreview(ctx))return ctx.reply('اخرج من وضع المعاينة أولًا.');
  if(isAdmin(ctx)){
    userState.set(ctx.from.id,{action:'contact_search',role:'admin',subjectId:0});
    return ctx.reply('أرسل اسم الطالب أو جزءًا منه للبحث.');
  }
  return pickTeacherSubject(ctx,'contact:subject','اختر مادة الطالب أولًا:');
});
bot.action(/^contact:subject:(\d+):(\d+)$/,async ctx=>{
  const subjectId=Number(ctx.match[1]),seasonId=Number(ctx.match[2]);
  if(isInPreview(ctx)||!await teacherOwnsSubject(ctx,subjectId,seasonId))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  userState.set(ctx.from.id,{action:'contact_search',role:'teacher',subjectId});
  return ctx.reply('أرسل اسم الطالب أو جزءًا منه للبحث في هذه المادة.');
});
bot.action(/^contact:page:(admin|teacher):(\d+):(\d+)$/,async ctx=>{
  const role=ctx.match[1],subjectId=Number(ctx.match[2]),page=Number(ctx.match[3]);
  const state=userState.get(ctx.from.id);
  if(isInPreview(ctx)||!state?.q||state.role!==role||Number(state.subjectId||0)!==subjectId||
    (role==='admin'?!isAdmin(ctx):!await effectiveTeacher(ctx)))return ctx.answerCbQuery('ابدأ البحث من جديد.');
  await ctx.answerCbQuery();return showContactStudents(ctx,role,subjectId,state.q,page);
});
bot.action(/^contact:select:(admin|teacher):(\d+):(\d+)(?::(\d+))?$/,async ctx=>{
  const role=ctx.match[1],studentId=Number(ctx.match[2]),subjectId=Number(ctx.match[3]),reportId=Number(ctx.match[4]||0);
  if(isInPreview(ctx)||role==='admin'&&!isAdmin(ctx)||role==='teacher'&&!await effectiveTeacher(ctx))return ctx.answerCbQuery('غير مصرح.');
  try {
    // The selected row is checked again, because old Telegram buttons can outlive enrollment changes.
    const st=(await db.pool.query('SELECT id,full_name,telegram_id FROM students WHERE id=$1',[studentId])).rows[0];
    if(!st)throw Error('الطالب غير موجود.');
    await studentContact.history({actorId:ctx.from.id,role,studentId,subjectId:subjectId||null});
    if(reportId&&role==='teacher'){
      const ok=await db.pool.query('SELECT 1 FROM student_reports WHERE id=$1 AND student_id=$2 AND subject_id=$3',[reportId,studentId,subjectId]);
      if(!ok.rowCount)throw Error('التقرير لا يخص هذا الطالب.');
    }
    await ctx.answerCbQuery();
    const rows=[[callbackButton('✉️ أرسل رسالة عبر البوت',`contact:compose:${role}:${studentId}:${subjectId}:${reportId}`)]];
    if(st.telegram_id)rows.unshift([Markup.button.url('فتح حساب الطالب في تيليغرام',`tg://user?id=${st.telegram_id}`)]);
    return ctx.reply(`الطالب: ${st.full_name}\nيمكنك فتح حسابه أو إرسال رسالة خاصة عبر البوت. قد تمنع خصوصية تيليغرام فتح المحادثة المباشرة.`,Markup.inlineKeyboard(rows));
  } catch(err) { return ctx.answerCbQuery(err.message,{show_alert:true}); }
});
bot.action(/^contact:compose:(admin|teacher):(\d+):(\d+):(\d+)$/,async ctx=>{
  const role=ctx.match[1],studentId=Number(ctx.match[2]),subjectId=Number(ctx.match[3]),reportId=Number(ctx.match[4]);
  if(isInPreview(ctx)||role==='admin'&&!isAdmin(ctx)||role==='teacher'&&!await effectiveTeacher(ctx))return ctx.answerCbQuery('غير مصرح.');
  try{await studentContact.history({actorId:ctx.from.id,role,studentId,subjectId:subjectId||null});}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
  userState.set(ctx.from.id,{action:'contact_compose',role,studentId,subjectId,reportId});
  await ctx.answerCbQuery();return ctx.reply('اكتب الرسالة التي تريد إرسالها لهذا الطالب (حتى 3000 حرف).');
});
bot.action(/^contact:leave:(\d+)$/,async ctx=>{
  if(!isAdmin(ctx)||isInPreview(ctx))return ctx.answerCbQuery('غير مصرح.');
  const leave=await db.getLeaveById(Number(ctx.match[1]));
  if(!leave)return ctx.answerCbQuery('طلب الإجازة غير موجود.');
  userState.set(ctx.from.id,{action:'contact_compose',role:'admin',studentId:leave.student_id,subjectId:0,contextKind:'leave',contextId:leave.id});
  await ctx.answerCbQuery();return ctx.reply(`اكتب ردك على طلب إجازة ${leave.full_name}:`);
});

async function decideLeaveAction(ctx, leaveId, approve) {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const updated = await db.decideLeave(leaveId, approve, ctx.from.id);
  if (!updated) {
    await ctx.answerCbQuery('عولج الطلب مسبقًا أو لم يعد موجودًا.');
    return ctx.editMessageText('تم التعامل مع هذا الطلب مسبقًا.');
  }
  const leave = await db.getLeaveById(leaveId);
  await ctx.answerCbQuery(approve ? 'تمت الموافقة ✅' : 'تم الرفض');
  const range = `${updated.start_date.toISOString().slice(0, 10)} → ${updated.end_date
    .toISOString()
    .slice(0, 10)}`;
  await ctx.editMessageText(
    `${approve ? '✅ تمت الموافقة على' : '❌ رُفض'} طلب إجازة «${leave.full_name}» (${range}).`
  );
  try {
    if (approve) {
      await bot.telegram.sendMessage(
          leave.telegram_id,
          `✅ تمت الموافقة على إجازتك (${range}).\n` +
            'لن تصلك إشعارات الدروس في أيام إجازتك، ولا تُحتسب هذه الأيام غيابًا ضمن سلسلة الغياب المتتالي. ' +
            'يمكن تأشير الدرس خلال مهلته فقط، ولا يمكن تأشيره بعد انتهاء المهلة. ' +
            'وستُنبَّه عند أول درس بعدها بضرورة متابعة ما فاتك.'
      );
    } else {
      await bot.telegram.sendMessage(leave.telegram_id, `❌ لم تتم الموافقة على طلب إجازتك (${range}).`);
    }
  } catch (err) {
    console.warn('تعذر إشعار الطالب بقرار الإجازة:', err.description || err.message);
  }
  return undefined;
}

bot.action(/leave_approve:(\d+)/, (ctx) => decideLeaveAction(ctx, Number(ctx.match[1]), true));
bot.action(/leave_reject:(\d+)/, (ctx) => decideLeaveAction(ctx, Number(ctx.match[1]), false));


bot.action('season_open', async (ctx) => {
  await ctx.answerCbQuery();
  return showTransitionPrompt(ctx);
});

bot.action(/season_choice:(repeat|promote)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  await ctx.answerCbQuery('جاري حفظ اختيارك...');
  try {
    const updated = await db.resolveStudentTransition(student.id, ctx.match[1]);
    await ctx.editMessageText(
      ctx.match[1] === 'repeat'
        ? `تم تسجيلك لإعادة المرحلة «${updated.stage_name}» في موسمها الجديد ✅`
        : `تهانينا، تم نقلك إلى المرحلة «${updated.stage_name}» ✅`
    );
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await deleteMessageQuietly(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id);
    }
    return replyStudentScreen(ctx, updated, 'قائمتك الدراسية جاهزة:', studentMainMenu(await effectiveStudent(ctx)));
  } catch (err) {
    return replyStudentScreen(ctx, student, `تعذر حفظ الاختيار: ${err.message}`);
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery('تم تسجيل حضورك مسبقًا لهذا الدرس ✅'));

bot.action(/^attend:(\d+)$/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا عبر /start');
  const lessonId = Number(ctx.match[1]);
  const lesson = await db.getLessonById(lessonId);
  if (!lesson) return ctx.answerCbQuery('الدرس غير موجود.');
  if (lesson.stage_id !== student.stage_id) return ctx.answerCbQuery('هذا الدرس ليس لمرحلتك.');
  if (!(await db.canStudentAttendLesson(student.id, lessonId))) {
    return ctx.answerCbQuery('يجب إكمال اختيار الموسم الجديد أولًا عبر /start.');
  }
  if (new Date(lesson.active_until) < new Date()) {
    return ctx.answerCbQuery(`انتهت مدة تسجيل الحضور لهذا الدرس (${LESSON_ACTIVE_HOURS} ساعة).`);
  }
  const inserted = await db.markAttendance(student.id, lessonId);
  if (!inserted) {
    const latestLesson = await db.getLessonById(lessonId);
    if (!latestLesson || new Date(latestLesson.active_until) < new Date()) {
      return ctx.answerCbQuery(`انتهت مدة تسجيل الحضور لهذا الدرس (${LESSON_ACTIVE_HOURS} ساعة).`);
    }
    if (!(await db.canStudentAttendLesson(student.id, lessonId))) {
      return ctx.answerCbQuery('يجب إكمال اختيار الموسم الجديد أولًا عبر /start.');
    }
    return ctx.answerCbQuery('تم تسجيل حضورك مسبقًا لهذا الدرس ✅');
  }
  await ctx.answerCbQuery('تم تسجيل حضورك ✅');
  return showTodayLessons(ctx, {
    edit: true,
    confirmation: `✅ تم الاستماع للدرس رقم ${Number(lesson.lesson_number)} من مادة «${lesson.subject_name}».`,
  });
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إضافة مرحلة
// ---------------------------------------------------------------------------
async function openAddStage(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  userState.set(ctx.from.id, { action: 'admin_awaiting_stage_name' });
  await answerIfCallback(ctx);
  return ctx.reply('أدخل اسم المرحلة الدراسية الجديدة:');
}

bot.action('admin_add_stage', openAddStage);
bot.hears('➕ إضافة مرحلة دراسية', openAddStage);

async function openStageManagement(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listAllStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  const rows = stages.map((stage) => [
    callbackButton(
      `${stage.is_active ? '✅' : '🗄️'} ${limitButtonText(stage.name, 48)}`,
      `admin_stage:${stage.id}`
    ),
  ]);
  return ctx.reply('اختر مرحلة لتعديل اسمها أو مرحلتها الأعلى أو أرشفتها:', Markup.inlineKeyboard(rows));
}

bot.hears('⚙️ إدارة المراحل', openStageManagement);

bot.action(/admin_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stage = await db.getStageById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!stage) return ctx.reply('المرحلة غير موجودة.');
  const rows = [
    [callbackButton('✏️ تعديل اسم المرحلة', `admin_stage_rename:${stage.id}`)],
    [callbackButton('⬆️ تحديد المرحلة الأعلى', `admin_stage_next:${stage.id}`)],
    [callbackButton('📊 مواسم وتقارير المرحلة', `admin_report_stage:${stage.id}`)],
    [
      stage.is_active
        ? callbackButton('🗄️ أرشفة المرحلة (مع حفظ بياناتها)', `admin_stage_archive:${stage.id}`)
        : callbackButton('♻️ استعادة المرحلة', `admin_stage_restore:${stage.id}`),
    ],
    [callbackButton('🎓 نوع المرحلة (دروس فقط / كاملة)', `admin_stage_type:${stage.id}`)],
    [callbackButton('🗑️ حذف نهائي (المرحلة وكل بياناتها)', `admin_stage_hard:${stage.id}`)],
  ];
  return ctx.reply(
    `المرحلة: ${stage.name}\nالحالة: ${stage.is_active ? 'نشطة' : 'مؤرشفة'}\n` +
      `المرحلة الأعلى: ${stage.next_stage_name || 'غير محددة'}\n` +
      `الطلبة الحاليون: ${Number(stage.student_count)}`,
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/admin_stage_rename:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stage = await db.getStageById(Number(ctx.match[1]));
  if (!stage) return ctx.answerCbQuery('المرحلة غير موجودة.');
  userState.set(ctx.from.id, { action: 'admin_awaiting_stage_rename', stageId: stage.id });
  await ctx.answerCbQuery();
  return ctx.reply(`أرسل الاسم الجديد للمرحلة «${stage.name}»:`);
});

bot.action(/admin_stage_next:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const sourceId = Number(ctx.match[1]);
  const stages = (await db.listStages()).filter((stage) => stage.id !== sourceId);
  await ctx.answerCbQuery();
  const rows = stages.map((stage) => [
    callbackButton(limitButtonText(stage.name), `admin_stage_next_pick:${sourceId}:${stage.id}`),
  ]);
  rows.push([callbackButton('بدون مرحلة أعلى', `admin_stage_next_pick:${sourceId}:0`)]);
  return ctx.reply('اختر المرحلة التي ينتقل إليها الطالب عند النجاح:', Markup.inlineKeyboard(rows));
});

bot.action(/admin_stage_next_pick:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  const nextStageId = Number(ctx.match[2]) || null;
  try {
    await db.setStageNext(stageId, nextStageId);
    await ctx.answerCbQuery('تم الحفظ ✅');
    return ctx.editMessageText('تم تحديث المرحلة الأعلى بنجاح ✅');
  } catch (err) {
    return ctx.answerCbQuery(err.message, { show_alert: true });
  }
});

bot.action(/admin_stage_archive:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stage = await db.getStageById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!stage) return ctx.reply('المرحلة غير موجودة.');
  return ctx.reply(
    `سيتم إخفاء «${stage.name}» من التسجيل وبدء المواسم الجديدة، مع الاحتفاظ بكل تقاريرها السابقة. ` +
      `يوجد حاليًا ${Number(stage.student_count)} طالب مرتبط بها. هل تريد المتابعة؟`,
    Markup.inlineKeyboard([
      [callbackButton('نعم، أرشف المرحلة', `admin_stage_archive_confirm:${stage.id}`, 'danger')],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/admin_stage_archive_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.archiveStage(Number(ctx.match[1]));
  await ctx.answerCbQuery('تمت الأرشفة ✅');
  return ctx.editMessageText('تمت أرشفة المرحلة مع الاحتفاظ بالدروس والحضور والتقارير السابقة ✅');
});

bot.action(/admin_stage_restore:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.restoreStage(Number(ctx.match[1]));
  await ctx.answerCbQuery('تمت الاستعادة ✅');
  return ctx.editMessageText('تمت استعادة المرحلة وأصبحت نشطة من جديد ✅');
});

bot.action(/admin_stage_hard:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stage = await db.getStageById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!stage) return ctx.reply('المرحلة غير موجودة.');
  return ctx.reply(
    `⚠️ حذف نهائي للمرحلة «${stage.name}».\n` +
      `سيُمحى نهائيًا كل ما يتعلق بها: طلبتها (${Number(stage.student_count)})، موادها ودروسها وحضورها، ` +
      'ومواسمها وتقاريرها، وقنواتها المرتبطة. لا يمكن التراجع.\nهل أنت متأكد؟',
    Markup.inlineKeyboard([
      [callbackButton('🗑️ نعم، احذف المرحلة نهائيًا', `admin_stage_hard_confirm:${stage.id}`)],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/admin_stage_hard_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  try {
    await db.hardDeleteStage(Number(ctx.match[1]));
    await ctx.answerCbQuery('تم الحذف النهائي ✅');
    return ctx.editMessageText('تم حذف المرحلة وكل بياناتها نهائيًا ✅');
  } catch (err) {
    return ctx.answerCbQuery(`تعذر الحذف: ${err.message}`, { show_alert: true });
  }
});

async function openStartSeason(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  userState.set(ctx.from.id, { action: 'admin_awaiting_season_name' });
  await answerIfCallback(ctx);
  return ctx.reply(
    'أرسل اسم الموسم الجديد كاملًا، مثل: «الموسم الأول 2026».\n' +
      'سيُعرض الاسم كما تكتبه، ويضيف البوت تلقائيًا وسم «(الحالي)» له و«(السابق)» للموسم الذي قبله.\n' +
      'بعد الاسم ستختار المراحل التي يبدأ لها هذا الموسم؛ بقية المراحل لن تتغير.'
  );
}

bot.hears('🗓️ بدء موسم جديد', openStartSeason);

bot.action(/season_toggle:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'admin_selecting_season_stages') {
    return ctx.answerCbQuery('انتهت جلسة الاختيار. ابدأ من لوحة الأدمن.', { show_alert: true });
  }
  const stageId = Number(ctx.match[1]);
  const selected = new Set(state.selectedStageIds.map(Number));
  if (selected.has(stageId)) selected.delete(stageId);
  else selected.add(stageId);
  state.selectedStageIds = [...selected];
  userState.set(ctx.from.id, state);
  const stages = await db.listStages();
  await ctx.answerCbQuery(selected.has(stageId) ? 'تم تحديد المرحلة' : 'تم إلغاء تحديد المرحلة');
  return ctx.editMessageText(
    `اختر المراحل التي سيبدأ لها موسم «${state.seasonName}».\nالمحدد حاليًا: ${selected.size}`,
    seasonSelectionKeyboard(stages, state.selectedStageIds)
  );
});

bot.action('season_confirm', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'admin_selecting_season_stages') {
    return ctx.answerCbQuery('انتهت جلسة الاختيار.', { show_alert: true });
  }
  if (state.selectedStageIds.length === 0) {
    return ctx.answerCbQuery('اختر مرحلة واحدة على الأقل.', { show_alert: true });
  }
  await ctx.answerCbQuery('جاري إنشاء الموسم وحفظ السجلات...');
  try {
    const result = await db.startSeasonForStages(state.seasonName, state.selectedStageIds);
    userState.delete(ctx.from.id);
    const lines = result.stages.map(
      (stage) => `• ${stage.stageName}: ${stage.affectedStudents} طالب بانتظار اختيار الإعادة أو النجاح`
    );
    await ctx.editMessageText(`تم بدء موسم «${result.season.name}» بنجاح ✅\n${lines.join('\n')}`);

    // قنوات المواسم المنتهية تتوقف تلقائيًا؛ نُذكّر الأدمن بربط قنوات الموسم الجديد.
    const staleLines = [];
    for (const stage of result.stages) {
      const stale = await db.listStaleChannels(stage.stageId);
      for (const ch of stale) {
        staleLines.push(`• ${ch.title || ch.telegram_chat_id} (${stage.stageName})`);
      }
    }
    if (staleLines.length > 0) {
      await ctx.reply(
        '📡 توقفت هذه القنوات لأن موسمها انتهى، ولن تُفعّل أي دروس بعد الآن:\n' +
          staleLines.join('\n') +
          '\n\nاربط قنوات الموسم الجديد من «🔗 ربط قناة بمرحلة». ' +
          'يمكنك فكّ ربط القنوات القديمة نهائيًا من «📡 القنوات المرتبطة».'
      );
    }

    for (const stage of result.stages) {
      await sendToStageStudents(
        stage.stageId,
        `🆕 بدأ موسم «${result.season.name}» لمرحلتك «${stage.stageName}».\n` +
          'اضغط الزر أدناه ثم اختر: إعادة المرحلة، أو الانتقال إلى المرحلة الأعلى عند النجاح.',
        Markup.inlineKeyboard([[callbackButton('اختيار وضعي للموسم الجديد', 'season_open')]])
      );
    }
    return ctx.reply('يمكنك متابعة العمل من لوحة الأدمن:', adminMainMenu());
  } catch (err) {
    return ctx.reply(`تعذر بدء الموسم: ${err.message}\nلم تُغيّر أي بيانات.`);
  }
});

bot.action('season_cancel', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تم الإلغاء');
  return ctx.editMessageText('تم إلغاء إنشاء الموسم.');
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إضافة مادة
// ---------------------------------------------------------------------------
async function openAddSubject(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد. أضف مرحلة أولًا.');
  return ctx.reply('اختر المرحلة التي ستضيف لها المادة:', stagesKeyboard(stages, 'admin_subj_stage'));
}

bot.action('admin_add_subject', openAddSubject);
bot.hears('➕ إضافة مادة', openAddSubject);

bot.action(/admin_subj_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  userState.set(ctx.from.id, { action: 'admin_awaiting_subject_name', stageId });
  await ctx.answerCbQuery();
  return ctx.reply('أدخل اسم المادة:');
});

async function openSubjectHashtags(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  return ctx.reply('اختر المرحلة لعرض المواد وهاشتاغاتها:', stagesKeyboard(stages, 'admin_tags_stage'));
}

bot.hears('🏷️ المواد والهاشتاغات', openSubjectHashtags);

bot.action(/admin_tags_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const subjects = await db.listSubjectsByStage(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (subjects.length === 0) return ctx.reply('لا توجد مواد في هذه المرحلة.');
  const rows = subjects.map((subject) => [
    callbackButton(
      limitButtonText(`${subject.name} — #${subject.hashtag || normalizeHashtag(subject.name)}`),
      `admin_subject_menu:${subject.id}`
    ),
  ]);
  return ctx.reply('المواد الحالية (اضغط على مادة لإدارتها):', Markup.inlineKeyboard(rows));
});

bot.action(/admin_subject_menu:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const subject = await db.getSubjectById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!subject) return ctx.reply('المادة غير موجودة.');
  return ctx.reply(
    `المادة: ${subject.name}\nالهاشتاغ: #${subject.hashtag || normalizeHashtag(subject.name)}`,
    Markup.inlineKeyboard([
      [callbackButton('🏷️ تعديل الهاشتاغ', `admin_edit_tag:${subject.id}`)],
      [callbackButton('🗑️ حذف المادة نهائيًا (مع دروسها وحضورها)', `admin_subject_hard:${subject.id}`)],
    ])
  );
});

bot.action(/admin_subject_hard:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const subject = await db.getSubjectById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!subject) return ctx.reply('المادة غير موجودة.');
  return ctx.reply(
    `⚠️ حذف نهائي لمادة «${subject.name}» مع كل دروسها وسجل حضورها. لا يمكن التراجع.\nهل أنت متأكد؟`,
    Markup.inlineKeyboard([
      [callbackButton('🗑️ نعم، احذف المادة نهائيًا', `admin_subject_hard_confirm:${subject.id}`)],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/admin_subject_hard_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.hardDeleteSubject(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم الحذف النهائي ✅');
  return ctx.editMessageText('تم حذف المادة وكل دروسها وحضورها نهائيًا ✅');
});

bot.action(/admin_edit_tag:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const subject = await db.getSubjectById(Number(ctx.match[1]));
  if (!subject) return ctx.answerCbQuery('المادة غير موجودة.');
  userState.set(ctx.from.id, {
    action: 'admin_awaiting_subject_hashtag_edit',
    subjectId: subject.id,
    subjectName: subject.name,
  });
  await ctx.answerCbQuery();
  return ctx.reply(`أرسل الهاشتاغ الجديد لمادة «${subject.name}» (مع # أو بدونها):`);
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — تفعيل درس يدويًا
// ---------------------------------------------------------------------------
async function openActivateLesson(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  return ctx.reply('اختر المرحلة:', stagesKeyboard(stages, 'admin_act_stage'));
}

bot.action('admin_activate', openActivateLesson);
bot.hears('🟢 تفعيل درس يدويًا', openActivateLesson);

bot.action(/admin_act_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  const subjects = await db.listSubjectsByStage(stageId);
  await ctx.answerCbQuery();
  if (subjects.length === 0) return ctx.reply('لا توجد مواد لهذه المرحلة بعد.');
  return ctx.reply(`اختر المادة لتفعيل درس اليوم (يبقى متاحًا ${LESSON_ACTIVE_HOURS} ساعة):`, subjectsKeyboard(subjects, 'admin_act_subject'));
});

bot.action(/admin_act_subject:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery('جاري التفعيل وإرسال الإشعارات...');
  const subjectId = Number(ctx.match[1]);
  const subject = await db.getSubjectById(subjectId);
  if (!subject) return ctx.reply('المادة غير موجودة.');
  const activated = await db.activateLesson(subjectId, LESSON_ACTIVE_HOURS, 'manual', null);
  if (!activated) return ctx.reply('تعذر التفعيل: المرحلة مؤرشفة أو لا يوجد لها موسم نشط.');
  const lesson = await db.getLessonById(activated.id);
  const notificationDate = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  const hasChannelLink = Boolean(channelEntryUrl(lesson.source_url));
  await notifyReturningFromLeave(subject.stage_id);
  const delivery = await sendToStageStudents(
    subject.stage_id,
    dailyLessonNotificationText(hasChannelLink),
    dailyLessonNotificationKeyboard(lesson),
    { skipOnLeave: true, dailyLessonNotificationDate: notificationDate, dailyLessonExpiresAt: lesson.active_until }
  );
  return ctx.editMessageText(
    `تم تفعيل الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» لمدة ${LESSON_ACTIVE_HOURS} ساعة ✅\n` +
      `حُفظ تنبيه دروس اليوم للإرسال إلى ${delivery.queued ?? delivery.delivered} طالب` +
      (delivery.alreadyNotifiedToday ? `، وسبق تنبيه ${delivery.alreadyNotifiedToday} اليوم` : '') +
      (delivery.skippedOnLeave ? `، وتُخطّي ${delivery.skippedOnLeave} في إجازة.` : '.')
  );
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إدارة الدروس المفعّلة (إلغاء تفعيل بالخطأ، إعادة فتح، تحضير جماعي)
// ---------------------------------------------------------------------------
async function openManageLessons(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listAllStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  return ctx.reply('اختر المرحلة لعرض آخر دروسها المفعّلة:', stagesKeyboard(stages, 'admin_mgt_stage'));
}

bot.hears('🛠️ إدارة الدروس المفعّلة', openManageLessons);

async function renderLessonManagement(ctx, stageId) {
  const lessons = await db.getRecentLessonsForStage(stageId, 15);
  if (lessons.length === 0) {
    return ctx.reply('لا توجد دروس مفعّلة لهذه المرحلة بعد.');
  }
  const buttons = lessons.map((l) => [
    callbackButton(
      limitButtonText(
        `${l.is_active ? '🟢' : '⚪️'} ${l.subject_name} — ${new Date(l.activated_at).toLocaleString('ar-IQ', { timeZone: ATTENDANCE_TIME_ZONE })} (${l.attended_count}/${l.enrolled_count})`,
        60
      ),
      `admin_mgt_lesson:${l.id}:${stageId}`
    ),
  ]);
  return ctx.reply(
    'آخر الدروس المفعّلة لهذه المرحلة (🟢 ضمن مهلته الآن | ⚪️ انتهت مهلته):\nاختر درسًا لإدارته:',
    Markup.inlineKeyboard(buttons)
  );
}

bot.action(/admin_mgt_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  return renderLessonManagement(ctx, Number(ctx.match[1]));
});

bot.action(/admin_mgt_lesson:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const lessonId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const lesson = await db.getLessonById(lessonId);
  if (!lesson) return ctx.answerCbQuery('لم يعد هذا الدرس موجودًا.', { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.reply(
    `الدرس رقم ${Number(lesson.lesson_number)} — «${lesson.subject_name}»\n` +
      `فُعّل: ${new Date(lesson.activated_at).toLocaleString('ar-IQ', { timeZone: ATTENDANCE_TIME_ZONE })}\n` +
      `${new Date(lesson.active_until) > new Date() ? '🟢 لا يزال ضمن مهلته.' : '⚪️ انتهت مهلته.'}\n\n` +
      'اختر الإجراء المطلوب:',
    Markup.inlineKeyboard([
      [callbackButton('❌ إلغاء التفعيل نهائيًا (فُعِّل بالخطأ)', `admin_mgt_cancel:${lessonId}:${stageId}`)],
      [callbackButton('🔁 إعادة فتح ضمن 24 ساعة من النشر', `admin_mgt_reopen:${lessonId}:${stageId}`)],
      [callbackButton('✅ تحضير جميع طلبة المرحلة', `admin_mgt_markall:${lessonId}:${stageId}`)],
      [callbackButton('↩️ رجوع لقائمة الدروس', `admin_mgt_stage:${stageId}`)],
    ])
  );
});

bot.action(/admin_mgt_cancel:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const lessonId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const lesson = await db.getLessonById(lessonId);
  if (!lesson) return ctx.answerCbQuery('لم يعد هذا الدرس موجودًا.', { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `⚠️ تحذير\nسيُحذف الدرس رقم ${Number(lesson.lesson_number)} من «${lesson.subject_name}» نهائيًا مع كل حضور مسجَّل عليه، ولن يظهر في أي تقرير بعد الآن.\nهل أنت متأكد؟`,
    Markup.inlineKeyboard([
      [callbackButton('✅ نعم، احذف نهائيًا', `admin_mgt_cancel_confirm:${lessonId}:${stageId}`)],
      [callbackButton('❌ إلغاء', `admin_mgt_lesson:${lessonId}:${stageId}`)],
    ])
  );
});

bot.action(/admin_mgt_cancel_confirm:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const lessonId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const cancelled = await db.cancelLesson(lessonId);
  if (!cancelled) {
    await ctx.answerCbQuery('لم يعد هذا الدرس موجودًا.', { show_alert: true });
    return renderLessonManagement(ctx, stageId);
  }
  await ctx.answerCbQuery('تم الإلغاء ✅');
  await ctx.editMessageText('✅ تم إلغاء تفعيل الدرس وحذف أي حضور مسجَّل عليه نهائيًا.');
  return renderLessonManagement(ctx, stageId);
});

bot.action(/admin_mgt_reopen:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const lessonId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const reopened = await db.reopenLesson(lessonId);
  if (!reopened) return ctx.answerCbQuery('الدرس غير متاح لإعادة الفتح: مضت 24 ساعة على نشره أو موسمه غير نشط.', { show_alert: true });
  const lesson = await db.getLessonById(lessonId);
  await ctx.answerCbQuery('تم فتح الدرس ✅');
  return ctx.editMessageText(
    `✅ أُعيد فتح الدرس رقم ${Number(lesson.lesson_number)} من «${lesson.subject_name}» حتى ${new Date(reopened.active_until).toLocaleString('ar-IQ', {timeZone:'Asia/Baghdad'})}؛ ضمن 24 ساعة من النشر الأصلي.\n` +
      'يمكن للطلبة الآن فتح «📚 دروس اليوم» وتأشير الحضور عليه.'
  );
});

bot.action(/admin_mgt_markall:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const lessonId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const lesson = await db.getLessonById(lessonId);
  if (!lesson) return ctx.answerCbQuery('لم يعد هذا الدرس موجودًا.', { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `⚠️ سيُسجَّل جميع طلبة المرحلة النشطين المسجَّلين في موسم هذا الدرس حاضرين للدرس رقم ${Number(lesson.lesson_number)} من «${lesson.subject_name}»، بمن فيهم من لم يستمع فعليًا.\nهل تريد المتابعة؟`,
    Markup.inlineKeyboard([
      [callbackButton('✅ نعم، سجّل الجميع حاضرين', `admin_mgt_markall_confirm:${lessonId}:${stageId}`)],
      [callbackButton('❌ إلغاء', `admin_mgt_lesson:${lessonId}:${stageId}`)],
    ])
  );
});

bot.action(/admin_mgt_markall_confirm:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const lessonId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const added = await db.markAllPresentForLesson(lessonId);
  await ctx.answerCbQuery('تم ✅');
  await ctx.editMessageText(`✅ سُجِّل ${added} طالبًا حاضرًا لم يكونوا مؤشَّرين سابقًا.`);
  return renderLessonManagement(ctx, stageId);
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — التقارير (Markdown)
// ---------------------------------------------------------------------------
async function openReports(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listAllStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  const rows = stages.map((stage) => [
    callbackButton(
      `${stage.is_active ? '✅' : '🗄️'} ${limitButtonText(stage.name, 48)}`,
      `admin_report_stage:${stage.id}`
    ),
  ]);
  return ctx.reply('اختر المرحلة، ثم اختر الموسم المطلوب:', Markup.inlineKeyboard(rows));
}

bot.action('admin_reports', openReports);

bot.action(/admin_report_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  const stage = await db.getStageById(stageId);
  const seasons = await db.listStageSeasons(stageId);
  await ctx.answerCbQuery();
  if (!stage || seasons.length === 0) return ctx.reply('لا توجد مواسم مسجلة لهذه المرحلة.');
  const buttons = seasons.map((season) => [
    callbackButton(
      `${season.is_active ? '🟢' : '📘'} ${limitButtonText(formatSeasonLabel(season), 46)} — ${Number(
        season.student_count
      )} طالب`,
      `admin_report_season:${season.id}`
    ),
  ]);
  return ctx.reply(`اختر موسم المرحلة «${stage.name}»:`, Markup.inlineKeyboard(buttons));
});

bot.action(/admin_report_season:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageSeasonId = Number(ctx.match[1]);
  const rows = await db.getStageSeasonReport(stageSeasonId, ATTENDANCE_TIME_ZONE);
  await ctx.answerCbQuery();
  if (rows.length === 0) {
    return ctx.reply('لا توجد بيانات كافية لهذا الموسم (تأكد من وجود طلبة ومواد).');
  }
  await sendMarkdownDoc(
    ctx,
    `تقرير_${safeFilePart(rows[0].stage_name)}_${safeFilePart(formatSeasonLabel(rows[0]))}`,
    buildStageSeasonMd(rows)
  );
  return ctx.reply('تنزيل كل تسجيل حضور مع تاريخه ووقته:',Markup.inlineKeyboard([
    [Markup.button.callback('📥 حضور الدروس MD',`admin_report_md:${stageSeasonId}:lessons`)],
    [Markup.button.callback('📥 حضور المباحثات MD',`admin_report_md:${stageSeasonId}:discussions`)]
  ]));
});

// Old CSV buttons also return Markdown after this update.
bot.action(/^admin_report_(?:md|csv):(\d+):(lessons|discussions)$/,async(ctx)=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery('جارٍ تجهيز السجلات…');
  return ctx.replyWithDocument({source:require('node:stream').Readable.from(adminData.attendanceMarkdown(Number(ctx.match[1]),ctx.match[2])),filename:`attendance-${ctx.match[1]}-${ctx.match[2]}.md`});
});

async function openSeasonArchive(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const stages = await db.listAllStages();
  await answerIfCallback(ctx);
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  const rows = stages.map((stage) => [
    callbackButton(
      `${stage.is_active ? '✅' : '🗄️'} ${limitButtonText(stage.name, 48)}`,
      `admin_archive_stage:${stage.id}`
    ),
  ]);
  return ctx.reply('اختر المرحلة لعرض أرشيف مواسمها:', Markup.inlineKeyboard(rows));
}

bot.hears('🗂️ أرشيف المواسم', openSeasonArchive);

bot.action(/admin_archive_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  const stage = await db.getStageById(stageId);
  const seasons = await db.listStageSeasons(stageId);
  await ctx.answerCbQuery();
  if (!stage || seasons.length === 0) return ctx.reply('لا توجد مواسم مسجلة لهذه المرحلة.');
  const lines = seasons.map(
    (season) =>
      `${season.is_active ? '🟢' : '📘'} ${formatSeasonLabel(season)} — ` +
      `${Number(season.student_count)} طالب، ${Number(season.lesson_count)} درس`
  );
  const buttons = seasons.map((season) => [
    callbackButton(
      `📥 تقرير ${limitButtonText(formatSeasonLabel(season), 42)}`,
      `admin_report_season:${season.id}`
    ),
  ]);
  return ctx.reply(`أرشيف مواسم «${stage.name}»:\n${lines.join('\n')}`, Markup.inlineKeyboard(buttons));
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إدارة الطلبة (بحث / تعديل / حذف)
// ---------------------------------------------------------------------------
async function openStudentManagement(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  userState.delete(ctx.from.id);
  await answerIfCallback(ctx);
  const [stages,registrationOpen] = await Promise.all([adminData.stages(),db.isStudentRegistrationOpen()]);
  const rows = stages.map(s => [callbackButton(
    limitButtonText(`${s.is_active ? '🎓' : '🗄️'} ${s.name} — ${s.student_count} طالب`),
    `students_stage:${s.id}`)]);
  rows.push([callbackButton('➕ إضافة طالب يدويًا بالـ ID', 'admin_student_add')]);
  rows.push([callbackButton(
    registrationOpen ? '🔒 إيقاف انضمام الطلبة الجدد' : '🔓 فتح انضمام الطلبة الجدد',
    `admin_registration:${registrationOpen?'off':'on'}`,
    registrationOpen ? 'danger' : 'success'
  )]);
  rows.push([callbackButton('🔎 البحث في جميع الطلبة', 'students_search:0')]);
  rows.push([callbackButton('📣 تنويه لجميع الطلبة ذوي الإجراءات الناقصة', 'students_remind_all')]);
  return ctx.reply(
    `إدارة الطلبة\nحالة الانضمام الجديد: ${registrationOpen?'🟢 مفتوح':'🔴 متوقف'}\n\nاختر المرحلة أو الإجراء المطلوب:`,
    Markup.inlineKeyboard(rows)
  );
}

async function showStageStudents(ctx, stageId, page = 0, q = '') {
  const data = await adminData.students({ stageId:stageId || null, page, q, status:'all' });
  const rows = data.rows.map(s => [callbackButton(limitButtonText(`${s.is_active ? '' : '🗄️ '}${s.full_name} — ${s.groups.map(g=>g.subject+': '+g.group).join('، ') || s.stage_name}`), `stu_select:${s.id}`)]);
  const nav=[];
  if (page>0) nav.push(callbackButton('السابق', `students_page:${stageId}:${page-1}`));
  if ((page+1)*data.size<data.total) nav.push(callbackButton('التالي', `students_page:${stageId}:${page+1}`));
  if(nav.length)rows.push(nav);
  rows.push([callbackButton('🔎 بحث',`students_search:${stageId}`),callbackButton('↩️ المراحل','admin_students')]);
  return ctx.reply(`الطلبة: ${data.total} | الصفحة ${page+1}\n${data.total ? 'اختر الطالب لعرض ملفه:' : 'لا توجد نتائج مطابقة.'}`,Markup.inlineKeyboard(rows));
}

bot.action(/^students_stage:(\d+)$/,async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const s=await adminData.stage(Number(ctx.match[1]));
  const rows=[
    [callbackButton(`👥 الطلبة (${s.student_count})`,`students_page:${s.id}:0`)],
    [callbackButton('📚 المواد والمجموعات',`students_content:${s.id}`)],
    [callbackButton('📊 تقارير الحضور والمواسم',`admin_report_stage:${s.id}`)],
    [callbackButton('🔎 بحث داخل المرحلة',`students_search:${s.id}`)],
    [callbackButton('↩️ المراحل','admin_students')]
  ];
  return ctx.reply(`${s.name}\nالموسم: ${s.season_name||'لا يوجد موسم نشط'}\nالطلبة: ${s.student_count} | المواد: ${s.subject_count} | المجموعات: ${s.group_count}`,Markup.inlineKeyboard(rows));
});
bot.action(/^students_content:(\d+)$/,async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();const s=await adminData.stage(Number(ctx.match[1]));
  const lines=s.subjects.map(sub=>`📘 ${sub.name} — ${sub.teacher_name||'بلا أستاذ'}\n`+s.groups.filter(g=>g.subject_id===sub.id).map(g=>s.discussion_grouping===false?`• ${g.title}: ${g.member_count}/${g.capacity}`:`• ${g.title}: ${g.member_count} عضو، ${g.reserved_count}/${g.capacity} مقعد محجوز`).join('\n'));
  return ctx.reply((lines.join('\n\n')||'لا توجد مواد بعد.').slice(0,3800),Markup.inlineKeyboard([[callbackButton('↩️ المرحلة',`students_stage:${s.id}`)]]));
});
bot.action(/^students_page:(\d+):(\d+)$/,async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');await ctx.answerCbQuery();
  const state=userState.get(ctx.from.id);
  const stageId=Number(ctx.match[1]);
  return showStageStudents(ctx,stageId,Number(ctx.match[2]),state?.action==='students_search_results'&&state.stageId===stageId?state.q:'');
});
bot.action(/^students_search:(\d+)$/,async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');await ctx.answerCbQuery();
  userState.set(ctx.from.id,{action:'admin_awaiting_student_search',stageId:Number(ctx.match[1])});
  return ctx.reply('أرسل الاسم أو جزءًا منه. يمكنك الرجوع دون البحث.');
});

function getTeacherWebUrl(){
  try{
    const configured=new URL(process.env.ADMIN_WEB_URL||'');
    if(configured.protocol!=='https:')return null;
    return `${configured.origin}/teacher/`;
  }catch{return null;}
}

async function openTeacherWeb(ctx){
  if(isInPreview(ctx))return ctx.reply('اخرج من وضع المعاينة أولًا ثم افتح لوحة الأستاذ من حساب الأستاذ نفسه.');
  const teacher=await db.getTeacherByTelegramId(ctx.from?.id);
  if(!teacher)return ctx.reply('لوحة الأستاذ متاحة للأستاذ المرتبط بهذا الحساب فقط.');
  if(ctx.chat?.type!=='private')return ctx.reply('افتح لوحة الأستاذ من المحادثة الخاصة مع البوت.');
  const url=getTeacherWebUrl();
  if(process.env.ADMIN_WEB_ENABLED!=='true'||!url)return ctx.reply('لوحة الأستاذ غير مفعّلة حاليًا. راجع إعدادات لوحة الويب.');
  return ctx.reply('افتح لوحة الأستاذ:',Markup.inlineKeyboard([[Markup.button.webApp('🖥️ فتح لوحة الأستاذ',url)]]));
}
bot.hears('🖥️ فتح لوحة الأستاذ',openTeacherWeb);
// زر المسافة أسفل لوحة الأستاذ وظيفته بصرية فقط؛ نحذف رسالته إن ضُغط بالخطأ.
bot.hears(TEACHER_MENU_SPACER,async ctx=>{try{await ctx.deleteMessage();}catch(_){}});
bot.command('teacher_web',openTeacherWeb);

async function openAdminWeb(ctx){
  if(!isAdmin(ctx)||isInPreview(ctx))return ctx.reply('لوحة الإدارة متاحة للأدمن خارج وضع المعاينة فقط.');
  if(ctx.chat?.type!=='private')return ctx.reply('افتح هذه اللوحة من المحادثة الخاصة مع البوت.');
  if(process.env.ADMIN_WEB_ENABLED!=='true'||!process.env.ADMIN_WEB_URL)return ctx.reply('لوحة الإدارة جاهزة ضمن المشروع. لتفعيلها اضبط ADMIN_WEB_ENABLED=true ورابط ADMIN_WEB_URL وفق دليل التحديث.');
  return ctx.reply('افتح لوحة إدارة المعهد:',Markup.inlineKeyboard([[Markup.button.webApp('🖥️ فتح لوحة الإدارة',process.env.ADMIN_WEB_URL)]]));
}
bot.hears('🖥️ لوحة الإدارة',openAdminWeb);
bot.command('admin_web',openAdminWeb);
bot.action('admin_students', openStudentManagement);
bot.hears('🎓 إدارة الطلبة', openStudentManagement);

bot.action('students_remind_all',async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const rows=await studentReminders.incompleteStudents(db.pool);
  if(!rows.length)return ctx.reply('لا يوجد طلاب لديهم إجراءات ناقصة حاليًا.');
  const campaignId=randomUUID();
  userState.set(ctx.from.id,{action:'students_remind_all',campaignId,at:Date.now()});
  return ctx.reply(`سيُرسل تنويه مخصص إلى ${rows.length} طالبًا لديهم إجراءات ناقصة. يذكر التنويه ما ينقص كل طالب وطريقة إكماله عبر البوت.`,
    Markup.inlineKeyboard([[callbackButton('📨 إرسال التنويهات الآن',`students_remind_send:${campaignId}`)],
      [callbackButton('↩️ إدارة الطلبة','admin_students')]]));
});
bot.action(/^students_remind_send:([0-9a-f-]{36})$/,async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');
  const state=userState.get(ctx.from.id);
  if(state?.action!=='students_remind_all'||state.campaignId!==ctx.match[1]||Date.now()-state.at>10*60*1000)
    return ctx.answerCbQuery('انتهت صلاحية خطوة الإرسال. افتح إدارة الطلبة مجددًا.',{show_alert:true});
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('يجري إدراج التنويهات للإرسال.');
  const result=await studentReminders.queueIncompleteStudents(db.pool,state.campaignId);
  return ctx.reply(`أُدرج ${result.queued} تنويهًا مخصصًا في طابور الإرسال من أصل ${result.eligible} طالبًا تنطبق عليهم الشروط الآن.`);
});

bot.action(/admin_registration:(on|off)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const open=ctx.match[1]==='on';
  await db.setStudentRegistrationOpen(open);
  return openStudentManagement(ctx);
});

bot.action('admin_student_add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id,{action:'admin_manual_student_id'});
  await ctx.answerCbQuery();
  return ctx.reply(
    'أرسل Telegram ID للطالب بالأرقام فقط.\nمثال: 123456789\n\nسيُضاف الطالب يدويًا حتى لو كان الانضمام العام متوقفًا.'
  );
});

bot.action(/admin_manual_student_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const state=userState.get(ctx.from.id);
  if(!state||state.action!=='admin_manual_student_stage')return ctx.answerCbQuery('انتهت خطوة الإضافة. ابدأ من إدارة الطلبة.');
  const stageId=Number(ctx.match[1]);
  try{
    const student=await db.createStudent(state.telegramId,state.fullName,stageId);
    userState.delete(ctx.from.id);
    await ctx.answerCbQuery('تمت الإضافة ✅');
    let note='';
    try{
      await bot.telegram.sendMessage(student.telegram_id,
        `تمت إضافتك يدويًا إلى نظام معهد تراث الأنبياء ✅\nافتح البوت وأرسل /start لإكمال الدخول وتأكيد صفة التسجيل.`);
      note='\n📨 أُرسل للطالب إشعار بالدخول إلى البوت.';
    }catch(err){
      note='\nℹ️ تمت الإضافة، لكن تليجرام لم يسمح بإرسال رسالة للطالب الآن. يجب أن يفتح الطالب البوت بنفسه ويرسل /start أولًا.';
    }
    return ctx.editMessageText(`✅ تمت إضافة «${student.full_name}» يدويًا.\nTelegram ID: ${student.telegram_id}${note}`);
  }catch(err){
    if(err.code==='23505'){userState.delete(ctx.from.id);return ctx.answerCbQuery('هذا الـ ID مسجل مسبقًا.',{show_alert:true});}
    return ctx.answerCbQuery(`تعذر الإضافة: ${err.message}`,{show_alert:true});
  }
});

async function buildStudentManualReminder(studentId){
  const student=await db.getStudentById(studentId);
  if(!student)return null;
  const tasks=[];
  if(!student.official_confirmed_at)tasks.push('افتح البوت واضغط زر تأكيد التسجيل الرسمي.');
  const activity=await db.getStudentActiveStageSeason(studentId);
  if(activity){
    const missing=(await db.pool.query(`SELECT sub.name FROM subjects sub
      WHERE sub.stage_id=$1 AND participation_enabled(sub.id,$2)
        AND NOT EXISTS(SELECT 1 FROM participation_modes pm WHERE pm.student_id=$3 AND pm.subject_id=sub.id AND pm.stage_season_id=$2)
      ORDER BY sub.name`,[activity.stage_id,activity.stage_season_id,studentId])).rows.map(r=>r.name);
    if(missing.length)tasks.push(`اختر نوع المشاركة (مباحثة أو تقرير) في: ${missing.join('، ')}.`);
    const unjoined=(await db.pool.query(`SELECT sub.name FROM participation_modes pm
      JOIN subjects sub ON sub.id=pm.subject_id
      WHERE pm.student_id=$1 AND pm.stage_season_id=$2 AND pm.mode='mubahatha'
        AND NOT EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.student_id=pm.student_id AND gm.subject_id=pm.subject_id AND gm.stage_season_id=pm.stage_season_id)
      ORDER BY sub.name`,[studentId,activity.stage_season_id])).rows.map(r=>r.name);
    if(unjoined.length)tasks.push(`ادخل إلى مجموعة المباحثة في: ${unjoined.join('، ')}.`);
  }
  if(await db.getPendingTransition(studentId))tasks.push('افتح البوت وحدد حالتك للموسم الجديد (إعادة المرحلة أو الانتقال).');
  if(!tasks.length)return {student,text:null};
  return {student,text:`📌 تذكير من إدارة المعهد\n\n${tasks.map((t,i)=>`${i+1}. ${t}`).join('\n')}\n\nيرجى تنفيذ المطلوب من خلال البوت.`};
}

bot.action(/stu_remind:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const reminder=await buildStudentManualReminder(Number(ctx.match[1]));
  if(!reminder)return ctx.answerCbQuery('الطالب غير موجود.',{show_alert:true});
  if(!reminder.text)return ctx.answerCbQuery('لا يوجد إجراء معلّق واضح لهذا الطالب حاليًا.',{show_alert:true});
  try{
    await bot.telegram.sendMessage(reminder.student.telegram_id,reminder.text);
    return ctx.answerCbQuery('أُرسل التذكير للطالب ✅',{show_alert:true});
  }catch(err){
    return ctx.answerCbQuery('تعذر الإرسال. إذا لم يسبق للطالب فتح البوت، يجب أن يرسل /start أولًا.',{show_alert:true});
  }
});

bot.action(/stu_select:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const student = await db.getStudentById(studentId);
  await ctx.answerCbQuery();
  if (!student) return ctx.reply('الطالب غير موجود (ربما حُذف).');
  const activity = await db.getStudentCurrentSeasonActivity(
    studentId,
    currentDateInTimeZone(ATTENDANCE_TIME_ZONE)
  );
  const attendanceRows = activity
    ? await db.getStudentSeasonReport(studentId, activity.stageSeasonId, ATTENDANCE_TIME_ZONE)
    : [];
  const groups=await studies.listStudentGroups(studentId);
  return ctx.reply(
    formatAdminStudentDetails(student, activity, attendanceRows)+'\n\n👥 المجموعات حسب المادة:\n'+
      (groups.map(g=>`• ${g.subject_name}: ${g.group_title}`).join('\n')||'لم يُوزع على مجموعات بعد.'),
    studentActionsKeyboard(studentId, student.is_active)
  );
});

bot.action(/stu_edit_name:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  userState.set(ctx.from.id, { action: 'admin_awaiting_new_name', studentId });
  await ctx.answerCbQuery();
  return ctx.reply('أدخل الاسم الجديد للطالب:');
});

bot.action(/stu_report:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const student = await db.getStudentById(studentId);
  await ctx.answerCbQuery('جاري تجهيز التقرير...');
  if (!student) return ctx.reply('الطالب غير موجود.');
  const rows = await sendStudentReportMessages(ctx, studentId, null, { cleanUi: false });
  if (rows.length === 0) return undefined;
  return sendMarkdownDoc(ctx, `تقرير_الطالب_${studentId}`, buildStudentReportMd(rows));
});

bot.action(/stu_edit_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const stages = await db.listStages();
  await ctx.answerCbQuery();
  return ctx.reply('اختر المرحلة الجديدة:', stagesKeyboard(stages, `stu_set_stage:${studentId}`));
});

bot.action(/stu_set_stage:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  await db.updateStudentStage(studentId, stageId);
  await ctx.answerCbQuery('تم النقل ✅');
  return ctx.editMessageText('تم تحديث مرحلة الطالب بنجاح ✅');
});

bot.action(/stu_restore:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const student = await db.getStudentById(Number(ctx.match[1]));
  if (!student) return ctx.answerCbQuery('الطالب غير موجود.');
  await db.updateStudentStage(student.id, student.stage_id);
  await ctx.answerCbQuery('تمت إعادة التفعيل ✅');
  return ctx.editMessageText('تمت إعادة تفعيل الطالب في موسمه الحالي ✅');
});

bot.action(/stu_archive_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  return ctx.reply(
    'أرشفة الطالب: يُمنع من الدخول وتبقى كل تقارير مواسمه وحضوره محفوظة، ويمكن إعادة تفعيله لاحقًا.\nهل تريد المتابعة؟',
    Markup.inlineKeyboard([
      [callbackButton('✅ نعم، أرشف مع حفظ البيانات', `stu_archive:${studentId}`, 'danger')],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/stu_archive:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.archiveStudent(Number(ctx.match[1]));
  await ctx.answerCbQuery('تمت الأرشفة ✅');
  return ctx.editMessageText('تمت أرشفة الطالب مع الاحتفاظ بكامل سجل مواسمه وحضوره ✅');
});

bot.action(/stu_hard_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const student = await db.getStudentById(studentId);
  await ctx.answerCbQuery();
  return ctx.reply(
    `⚠️ حذف نهائي للطالب «${student ? student.full_name : ''}».\n` +
      'سيُمحى نهائيًا مع كل تسجيلاته وحضوره وإجازاته، ولا يمكن التراجع.\nهل أنت متأكد؟',
    Markup.inlineKeyboard([
      [callbackButton('🗑️ نعم، احذف نهائيًا', `stu_hard:${studentId}`)],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/stu_hard:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.hardDeleteStudent(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم الحذف النهائي ✅');
  return ctx.editMessageText('تم حذف الطالب وكل بياناته نهائيًا ✅');
});

// زر إلغاء عام: يستعمله الطالب والأستاذ والأدمن، فلا يُقصر على الأدمن
bot.action('admin_cancel_noop', async (ctx) => {
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تم الإلغاء');
  return ctx.editMessageText('تم إلغاء العملية.');
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — ربط قناة بمرحلة
// ---------------------------------------------------------------------------
async function openLinkChannel(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  userState.set(ctx.from.id, { action: 'admin_awaiting_channel_forward' });
  await answerIfCallback(ctx);
  return ctx.reply(
    'الخطوات:\n' +
      '1) أضِف هذا البوت كأدمن داخل قناة تليجرام الخاصة بالمرحلة (صلاحية نشر الرسائل كافية).\n' +
      '2) حوّل (Forward) أي منشور من داخل تلك القناة إلى هذا الشات الآن.\n\n' +
      'سأتعرف على القناة تلقائيًا من الرسالة المُحوَّلة.'
  );
}

bot.action('admin_link_channel', openLinkChannel);
bot.hears('🔗 ربط قناة بمرحلة', openLinkChannel);

bot.action(/admin_channel_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'admin_channel_choose_stage') return ctx.answerCbQuery();
  const stageId = Number(ctx.match[1]);
  try {
    await db.linkChannel(stageId, state.chatId, state.title);
    await db.clearUnlinkedChannelPost(state.chatId);
  } catch (err) {
    userState.delete(ctx.from.id);
    await ctx.answerCbQuery('تعذر الربط');
    return ctx.editMessageText(`تعذر ربط القناة: ${err.message}`);
  }
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تم الربط ✅');
  return ctx.editMessageText(
    `تم ربط قناة "${state.title}" بموسم هذه المرحلة الحالي بنجاح ✅\n\n` +
      'من الآن، أي منشور في القناة يحتوي على صوت أو ملف صوتي أو فيديو أو رابط مع هاشتاغ اسم المادة (مثل #المحاسبة) سيُفعّل الدرس تلقائيًا، حتى لو أُضيف الهاشتاغ بتعديل المنشور لاحقًا. ويمكن أيضًا إرسال الهاشتاغ وحده في رسالة مستقلة (مثل #المحاسبة) لتفعيل المادة مباشرة.\n\n' +
      'ملاحظة: عند بدء موسم جديد لهذه المرحلة ستتوقف هذه القناة تلقائيًا، وتربط قناة الموسم الجديد.'
  );
});

// ---------------------------------------------------------------------------
// لوحة الأستاذ
// ---------------------------------------------------------------------------
async function requireTeacher(ctx) {
  const teacher = await effectiveTeacher(ctx);
  if (teacher) return teacher;
  // في المعاينة بصفة أستاذ نتوقف على الأستاذ المنتحَل فقط، لا نمنح صلاحيات الأدمن الكاملة
  if (isAdmin(ctx) && !isInPreview(ctx)) return { id: null, full_name: 'الأدمن', isAdmin: true };
  await ctx.reply('هذه الشاشة متاحة للأساتذة والأدمن فقط.');
  return null;
}

async function showTeacherSubjects(ctx) {
  const subjects = await getActorSubjects(ctx);
  if (!subjects) return ctx.reply('هذه الشاشة متاحة للأساتذة والأدمن فقط.');
  if (subjects.length === 0) {
    return ctx.reply('لم تُسنَد إليك أي مادة في الموسم الحالي بعد. راجع إدارة المعهد.');
  }
  const lines = subjects.map(
    (s) => `• ${s.subject_name} — ${s.stage_name} (${Number(s.student_count)} طالب)`
  );
  return ctx.reply(`موادك في ${subjects[0].season_name}:\n${lines.join('\n')}`, teacherMainMenu());
}

bot.hears('📚 موادي', showTeacherSubjects);

async function showTeacherAttendanceMenu(ctx) {
  const subjects = await getActorSubjects(ctx);
  if (!subjects) return ctx.reply('هذه الشاشة متاحة للأساتذة والأدمن فقط.');
  if (subjects.length === 0) return ctx.reply('لا توجد مواد متاحة في الموسم الحالي.');
  const rows = subjects.map((s) => [
    Markup.button.callback(
      limitButtonText(`${s.subject_name} — ${s.stage_name}`, 50),
      `teacher_att:${s.subject_id}:${s.stage_season_id}`
    ),
  ]);
  return ctx.reply('اختر المادة لعرض حضور مباحثات طلبتها:', Markup.inlineKeyboard(rows));
}

bot.hears('📊 حضور موادي', showTeacherAttendanceMenu);

bot.action(/^teacher_att:(\d+):(\d+)$/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const stageSeasonId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, stageSeasonId))) {
    return ctx.answerCbQuery('هذه المادة ليست ضمن موادك.');
  }

  await ctx.answerCbQuery();
  const rows = await studies.listDiscussionAttendanceForTeacher(subjectId, stageSeasonId);
  if (!rows.length) return ctx.reply('لا يوجد طلبة مشاركون في هذه المادة.');
  const groups=new Map();
  for(const row of rows){
    const id=Number(row.group_id||0);
    if(!groups.has(id))groups.set(id,{title:row.group_title||'بلا مجموعة',count:0});
    groups.get(id).count++;
  }
  if(groups.size===1&&groups.has(0))return sendTeacherGroupAttendance(ctx,subjectId,stageSeasonId,0,rows);
  return ctx.reply('اختر المجموعة لتنزيل تقرير حضورها بصيغة MD:',Markup.inlineKeyboard(
    [...groups].map(([id,g])=>[callbackButton(limitButtonText(`${g.title} — ${g.count} طالب`),`teacher_att_group:${subjectId}:${stageSeasonId}:${id}`)])));
});

async function sendTeacherGroupAttendance(ctx,subjectId,seasonId,groupId,allRows){
  const rows=allRows.filter(r=>Number(r.group_id||0)===groupId);
  if(!rows.length)return ctx.reply('لا يوجد طلبة مشاركون في هذه المجموعة حاليًا.');
  const subject=await db.getSubjectById(subjectId);
  const title=`حضور ${subject?.name||'المادة'} — ${rows[0].group_title||'بلا مجموعة'}`;
  return sendMarkdownDoc(ctx,`حضور_المادة_${subjectId}_المجموعة_${groupId}`,
    buildRtlMarkdownDoc(title,['الطالب','نمط المشاركة','الحضور المكتمل','الجلسات المؤهلة','بداية بلا نهاية','التقارير المرسلة'],
      rows.map(r=>[r.full_name,r.mode==='report'?'تقارير':'مباحثات',Number(r.attended_sessions),Number(r.eligible_sessions),Number(r.incomplete_sessions),Number(r.report_count)]),
      'الحضور المكتمل هو بداية ونهاية الجلسة معًا. يُعرض طلبة المجموعة الحالية مع الاحتفاظ بسجلاتهم السابقة في المادة عند انتقالهم بين المجموعات.'),
    Markup.inlineKeyboard([[callbackButton('↩️ مجموعات المادة',`teacher_att:${subjectId}:${seasonId}`)]]));
}
bot.action(/^teacher_att_group:(\d+):(\d+):(\d+)$/,async ctx=>{
  const [,subjectId,seasonId,groupId]=ctx.match.map(Number);
  if(!await teacherOwnsSubject(ctx,subjectId,seasonId))return ctx.answerCbQuery('غير مصرح.');
  if(groupId){
    const group=await studies.getGroupById(groupId);
    if(!group||group.subject_id!==subjectId||group.stage_season_id!==seasonId)return ctx.answerCbQuery('المجموعة لا تنتمي إلى هذه المادة.');
  }
  await ctx.answerCbQuery();
  return sendTeacherGroupAttendance(ctx,subjectId,seasonId,groupId,await studies.listDiscussionAttendanceForTeacher(subjectId,seasonId));
});

// ---------------------------------------------------------------------------
// الأدمن — إدارة الأساتذة
// ---------------------------------------------------------------------------
async function openTeacherManagement(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const teachers = await db.listTeachers();
  await answerIfCallback(ctx);
  const rows = teachers.map((t) => [
    Markup.button.callback(
      `${t.is_active ? (t.telegram_id ? '✅' : '🕓') : '🗄️'} ${limitButtonText(t.full_name, 36)} — ${Number(
        t.active_subject_count
      )} مادة`,
      `admin_teacher:${t.id}`
    ),
  ]);
  rows.push([Markup.button.callback('➕ إضافة أستاذ', 'admin_teacher_add')]);
  return ctx.reply(
    teachers.length === 0
      ? 'لا يوجد أساتذة بعد. أضف أستاذًا ليبدأ استخدام النظام.'
      : 'الأساتذة:\n✅ مفعّل | 🕓 بانتظار إرسال كود التفعيل | 🗄️ معطّل',
    Markup.inlineKeyboard(rows)
  );
}

bot.hears('👨‍🏫 إدارة الأساتذة', openTeacherManagement);

bot.action('admin_teacher_add', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id, { action: 'admin_awaiting_teacher_name' });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل اسم الأستاذ:');
});

bot.action(/admin_teacher:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const teacher = await db.getTeacherById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!teacher) return ctx.reply('الأستاذ غير موجود.');
  const subjects = await db.listTeacherSubjects(teacher.id);
  const subjLines = subjects.length
    ? subjects.map((s) => `  • ${s.subject_name} — ${s.stage_name}`).join('\n')
    : '  (لا مواد في الموسم الحالي)';
  const status = teacher.telegram_id
    ? 'مفعّل ✅'
    : `بانتظار التفعيل 🕓 — كود التفعيل: ${teacher.link_code}`;
  return ctx.reply(
    `الأستاذ: ${teacher.full_name}\nالحالة: ${status}\nمواده:\n${subjLines}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📘 إسناد مادة', `admin_teacher_assign:${teacher.id}`)],
      [Markup.button.callback('🚫 سحب مادة', `admin_teacher_unassign:${teacher.id}`)],
      [Markup.button.callback('🔑 إعادة توليد كود التفعيل', `admin_teacher_regen:${teacher.id}`)],
      [Markup.button.callback('📣 إرسال تذكير بالمطلوب', `admin_teacher_remind:${teacher.id}`)],
      [
        teacher.is_active
          ? Markup.button.callback('🗄️ تعطيل الأستاذ', `admin_teacher_toggle:${teacher.id}:0`)
          : Markup.button.callback('♻️ إعادة تفعيل', `admin_teacher_toggle:${teacher.id}:1`),
      ],
      [Markup.button.callback('🗑️ حذف نهائي', `admin_teacher_del:${teacher.id}`)],
    ])
  );
});

bot.action(/admin_teacher_remind:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const teacher=await db.getTeacherById(Number(ctx.match[1]));
  if(!teacher)return ctx.answerCbQuery('الأستاذ غير موجود.',{show_alert:true});
  if(!teacher.telegram_id)return ctx.answerCbQuery('الأستاذ لم يربط حسابه بالبوت بعد، فلا يمكن إرسال إشعار له.',{show_alert:true});
  const pending=(await db.pool.query(`SELECT sub.name,COUNT(r.id)::int AS pending
    FROM teaching_assignments ta
    JOIN stage_seasons ss ON ss.id=ta.stage_season_id AND ss.is_active=true
    JOIN subjects sub ON sub.id=ta.subject_id
    JOIN student_reports r ON r.subject_id=ta.subject_id AND r.stage_season_id=ta.stage_season_id AND r.score IS NULL
    WHERE ta.teacher_id=$1
    GROUP BY sub.id,sub.name ORDER BY sub.name`,[teacher.id])).rows;
  if(!pending.length)return ctx.answerCbQuery('لا توجد تقارير غير مقيّمة لهذا الأستاذ حاليًا.',{show_alert:true});
  const total=pending.reduce((n,r)=>n+Number(r.pending),0);
  const text=`📌 تذكير من إدارة المعهد\n\nلديك ${total} تقريرًا بانتظار التقييم:\n${pending.map(r=>`• ${r.name}: ${Number(r.pending)} تقرير`).join('\n')}\n\nيرجى فتح «📄 تقارير الطلبة» وتقييم التقارير المعلّقة.`;
  try{
    await bot.telegram.sendMessage(teacher.telegram_id,text);
    return ctx.answerCbQuery('أُرسل التذكير للأستاذ ✅',{show_alert:true});
  }catch(err){
    return ctx.answerCbQuery('تعذر إرسال التذكير إلى حساب الأستاذ.',{show_alert:true});
  }
});

bot.action(/admin_teacher_regen:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const t = await db.regenerateTeacherCode(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم التوليد ✅');
  return ctx.editMessageText(
    `كود تفعيل جديد للأستاذ ${t.full_name}:\n\n${t.link_code}\n\n` +
      'أرسله له ليكتبه في البوت. (الارتباط السابق أُلغي.)'
  );
});

bot.action(/admin_teacher_toggle:(\d+):(0|1)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.setTeacherActive(Number(ctx.match[1]), ctx.match[2] === '1');
  await ctx.answerCbQuery('تم ✅');
  return ctx.editMessageText(ctx.match[2] === '1' ? 'أُعيد تفعيل الأستاذ ✅' : 'عُطّل الأستاذ 🗄️');
});

bot.action(/admin_teacher_del:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const id = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  return ctx.reply(
    '⚠️ حذف نهائي للأستاذ وكل إسناداته. لا يؤثر على حضور الطلبة. متأكد؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('🗑️ نعم، احذف', `admin_teacher_del_ok:${id}`)],
      [Markup.button.callback('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/admin_teacher_del_ok:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.hardDeleteTeacher(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم الحذف ✅');
  return ctx.editMessageText('حُذف الأستاذ نهائيًا ✅');
});

bot.action(/admin_teacher_assign:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const teacherId = Number(ctx.match[1]);
  const stages = await db.listStages();
  await ctx.answerCbQuery();
  if (stages.length === 0) return ctx.reply('لا توجد مراحل نشطة.');
  return ctx.reply(
    'اختر المرحلة التي تتبعها المادة:',
    Markup.inlineKeyboard(
      stages.map((s) => [Markup.button.callback(limitButtonText(s.name), `admin_tassign_stage:${teacherId}:${s.id}`)])
    )
  );
});

bot.action(/admin_tassign_stage:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const teacherId = Number(ctx.match[1]);
  const subjects = await db.listSubjectsByStage(Number(ctx.match[2]));
  await ctx.answerCbQuery();
  if (subjects.length === 0) return ctx.reply('لا توجد مواد في هذه المرحلة.');
  return ctx.reply(
    'اختر المادة لإسنادها:',
    Markup.inlineKeyboard(
      subjects.map((s) => [
        Markup.button.callback(limitButtonText(s.name), `admin_tassign_do:${teacherId}:${s.id}`),
      ])
    )
  );
});

bot.action(/admin_tassign_do:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  try {
    const created = await db.assignTeacherToSubject(Number(ctx.match[1]), Number(ctx.match[2]));
    await ctx.answerCbQuery(created ? 'تم الإسناد ✅' : 'مسنَدة مسبقًا');
    return ctx.editMessageText(created ? 'تم إسناد المادة للأستاذ ✅' : 'هذه المادة مسنَدة له مسبقًا.');
  } catch (err) {
    await ctx.answerCbQuery('تعذر الإسناد');
    return ctx.editMessageText(`تعذر الإسناد: ${err.message}`);
  }
});

bot.action(/admin_teacher_unassign:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const subjects = await db.listTeacherSubjects(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (subjects.length === 0) return ctx.reply('لا توجد مواد مسنَدة له في الموسم الحالي.');
  return ctx.reply(
    'اختر المادة لسحبها:',
    Markup.inlineKeyboard(
      subjects.map((s) => [
        Markup.button.callback(
          limitButtonText(`${s.subject_name} — ${s.stage_name}`, 50),
          `admin_tunassign_do:${s.assignment_id}`
        ),
      ])
    )
  );
});

bot.action(/admin_tunassign_do:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.unassignTeacherFromSubject(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم السحب ✅');
  return ctx.editMessageText('سُحبت المادة من الأستاذ ✅');
});

// ---------------------------------------------------------------------------
// مواعيد المباحثات: سؤال الأستاذ قبل الموعد، ثم فتح الجلسة وتنبيه الطلبة
// ---------------------------------------------------------------------------
const SLOT_PROMPT_LEAD_MINUTES = Number(process.env.SLOT_PROMPT_LEAD_MINUTES || 5);

async function runScheduleTick() {
  // قفل بسيط يمنع تداخل جولتين (لو تأخرت جولة تجاوزت الدقيقة) فلا تُفتح جلسة مرتين.
  if (scheduleTickRunning) return;
  scheduleTickRunning = true;
  try {
    await runScheduleTickInner();
  } finally {
    scheduleTickRunning = false;
  }
}

async function runScheduleTickInner() {
  return scheduler.tick(ADMIN_IDS);
}

// يفتح حضور النهاية (مرة واحدة) ويرسل زر «حضرت النهاية» لطلبة المجموعة عبر الطابور.
async function openEndAttendanceAndNotify(sessionId, byWhom) {
  return scheduler.openEnd(sessionId, byWhom === 'تلقائيًا');
}

bot.action(/slot_yes:(\d+):(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const teacher = await effectiveTeacher(ctx);
  if (!isAdmin(ctx) && (!teacher || !await access.teacherObject(teacher.id,'slot',Number(ctx.match[1])))) return ctx.answerCbQuery('غير مصرح.');
  const slotId=Number(ctx.match[1]),date=ctx.match[2];
  const saved=await studies.recordSlotDecision(slotId, date, 'confirmed', ctx.from.id, null);
  if(!saved)return ctx.answerCbQuery('الموعد قديم أو بدأت جلسته بالفعل.');
  userState.delete(ctx.from.id);
  const notice=await scheduler.queueSlotDecisionNotice(slotId,date,'confirmed');
  await ctx.answerCbQuery('تم التأكيد ✅');
  return ctx.editMessageText(`✅ تم تأكيد المباحثة. يبدأ الموعد في وقته، وحُفظ إشعار ${Number(notice?.notified||0)} طالبًا للإرسال.`);
});

bot.action(/slot_no:(\d+):(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const teacher = await effectiveTeacher(ctx);
  if (!isAdmin(ctx) && (!teacher || !await access.teacherObject(teacher.id,'slot',Number(ctx.match[1])))) return ctx.answerCbQuery('غير مصرح.');
  const slotId=Number(ctx.match[1]),date=ctx.match[2];
  // نسجل التأجيل فورًا حتى لا تفتح الجلسة أثناء كتابة السبب.
  const saved=await studies.recordSlotDecision(slotId, date, 'postponed', ctx.from.id, null);
  if(!saved)return ctx.answerCbQuery('الموعد قديم أو بدأت جلسته بالفعل.');
  userState.set(ctx.from.id,{action:'teacher_slot_postpone_reason',slotId,date});
  await ctx.answerCbQuery('تم اختيار التأجيل');
  return ctx.editMessageText('🕓 أُوقف موعد مباحثة اليوم حتى لا تبدأ الجلسة.\nأرسل الآن سبب التأجيل برسالة نصية (مثال: ظرف طارئ)، وبعد حفظه سيصل إشعار للطلبة.');
});

bot.action(/^mub_attend:(\d+)$/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا عبر /start');
  const sessionId = Number(ctx.match[1]);
  const session = await studies.getSessionById(sessionId);
  if (!session) return ctx.answerCbQuery('الجلسة غير موجودة.');
  if (!(await studies.isStartAttendanceOpen(sessionId))) {
    if (!session.attendance_reopened_at && !session.is_closed && new Date(session.closes_at) > new Date()) {
      return ctx.answerCbQuery('لم يبدأ تسجيل حضور البداية بعد.');
    }
    return ctx.answerCbQuery('انتهى وقت تسجيل حضور بداية المباحثة.');
  }
  const member = await studies.isStudentInGroup(student.id, session.group_id);
  if (!member) return ctx.answerCbQuery('هذه المباحثة ليست لمجموعتك.');

  const marked = await studies.markSessionAttendance(sessionId, student.id, 'start');
  if (!marked) return ctx.answerCbQuery('لم يُضف سجل جديد: سجّلت مسبقًا أو انتهت المهلة أو لست مؤهلًا لهذه الجلسة.');
  await ctx.answerCbQuery('تم تسجيل حضور البداية ✅');
  const end=(await db.pool.query("SELECT 1 FROM mubahatha_attendance WHERE session_id=$1 AND student_id=$2 AND phase='end'",[sessionId,student.id])).rows[0];
  return ctx.editMessageText(
    end ? '✅ اكتمل حضورك بالبداية والنهاية، بارك الله فيك.' : session.attendance_reopened_at
      ? '✅ سُجّل حضورك في بداية المباحثة.\nيمكنك إكمال حضور النهاية الآن قبل انتهاء الفرصة الإضافية.'
      : '✅ سُجّل حضورك في بداية المباحثة.\nلا تنسَ تسجيل حضور النهاية عند إغلاقها.',
    !end && await studies.isEndAttendanceOpen(sessionId)
      ? Markup.inlineKeyboard([[callbackButton('✅ حضرت نهاية المباحثة', `mub_end_attend:${sessionId}`)]])
      : {}
  );
});

// حضور النهاية — سجل مستقل عن البداية
bot.action(/^mub_end_attend:(\d+)$/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا عبر /start');
  const sessionId = Number(ctx.match[1]);
  if (!(await studies.isEndAttendanceOpen(sessionId))) {
    return ctx.answerCbQuery('انتهى وقت تسجيل حضور النهاية.');
  }
  const session = await studies.getSessionById(sessionId);
  if (!session) return ctx.answerCbQuery('الجلسة غير موجودة.');
  if (!(await studies.isStudentInGroup(student.id, session.group_id))) {
    return ctx.answerCbQuery('هذه المباحثة ليست لمجموعتك.');
  }
  const marked = await studies.markSessionAttendance(sessionId, student.id, 'end');
  if (!marked) return ctx.answerCbQuery('لم يُضف سجل جديد: سجّلت مسبقًا أو انتهت المهلة أو لست مؤهلًا لهذه الجلسة.');
  await ctx.answerCbQuery('تم تسجيل حضور النهاية ✅');
  const start=(await db.pool.query("SELECT 1 FROM mubahatha_attendance WHERE session_id=$1 AND student_id=$2 AND phase='start'",[sessionId,student.id])).rows[0];
  return ctx.editMessageText(start
    ? '✅ سُجّل حضور النهاية. اكتمل حضورك بالبداية والنهاية، بارك الله فيك.'
    : 'سُجّل حضور النهاية، لكن لم تسجّل حضور البداية؛ لذلك لا يُحسب حضور هذه المباحثة مكتملًا.',
    !start && await studies.isStartAttendanceOpen(sessionId)
      ? Markup.inlineKeyboard([[callbackButton('✅ حضرت بداية المباحثة', `mub_attend:${sessionId}`)]])
      : {});
});

// الأستاذ ينهي المباحثة يدويًا فيفتح حضور النهاية فورًا
bot.action(/^mub_finish:(\d+)$/, async (ctx) => {
  const teacher = await effectiveTeacher(ctx);
  if (!teacher && !isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const sessionId = Number(ctx.match[1]);
  if(!isAdmin(ctx) && !await access.teacherObject(teacher.id,'session',sessionId)) return ctx.answerCbQuery('هذه الجلسة ليست ضمن صلاحياتك.');
  await ctx.answerCbQuery();
  const result = await openEndAttendanceAndNotify(sessionId, 'الأستاذ');
  if (!result) return ctx.editMessageText('حضور النهاية مفتوح مسبقًا أو الجلسة غير موجودة.');
  return ctx.editMessageText(
    `✅ أُنهيت المباحثة وفُتح حضور النهاية حتى نهاية ساعة الموعد الأصلية. حُفظت إشعارات ${result.notified} طالبًا في طابور الإرسال.`
  );
});

// ---------------------------------------------------------------------------
// الأستاذ — إدارة مجموعات المباحثات
// ---------------------------------------------------------------------------
// الأدمن يملك صلاحيات الأستاذ كاملة: يرى كل مواد المعهد ويعمل عليها،
// بينما يرى الأستاذ المواد المسنَدة إليه فقط.
async function getActorSubjects(ctx) {
  // في المعاينة بصفة أستاذ: مواد ذلك الأستاذ فقط، لا كل مواد المعهد
  if (isAdmin(ctx) && !isInPreview(ctx)) return db.listAllActiveSubjects();
  const teacher = await effectiveTeacher(ctx);
  if (!teacher) return null;
  return db.listTeacherSubjects(teacher.id);
}

async function pickTeacherSubject(ctx, prefix, prompt) {
  const subjects = await getActorSubjects(ctx);
  if (!subjects) {
    await ctx.reply('هذه الشاشة متاحة للأساتذة والأدمن فقط.');
    return undefined;
  }
  if (subjects.length === 0) {
    return ctx.reply(
      isAdmin(ctx)
        ? 'لا توجد مواد في المواسم النشطة بعد.'
        : 'لا توجد مواد مسنَدة إليك في الموسم الحالي.'
    );
  }
  return ctx.reply(
    prompt,
    Markup.inlineKeyboard(
      subjects.map((s) => [
        Markup.button.callback(
          limitButtonText(`${s.subject_name} — ${s.stage_name}`, 50),
          `${prefix}:${s.subject_id}:${s.stage_season_id}`
        ),
      ])
    )
  );
}

// يتحقق من صلاحية العمل على المادة: الأدمن على كل المواد، والأستاذ على مواده فقط.
// يُرجع كائنًا فيه teacherId (قد يكون null للأدمن) أو null إن لم يُصرَّح.
async function teacherOwnsSubject(ctx, subjectId, stageSeasonId) {
  if (isAdmin(ctx) && !isInPreview(ctx)) {
    const teacher = await effectiveTeacher(ctx);
    return { id: teacher ? teacher.id : null, isAdmin: true };
  }
  const teacher = await effectiveTeacher(ctx);
  if (!teacher) return null;
  const owns = (await db.listTeacherSubjects(teacher.id)).some(
    (s) => s.subject_id === subjectId && s.stage_season_id === stageSeasonId
  );
  return owns ? { id: teacher.id, isAdmin: false } : null;
}

async function broadcastActor(ctx) {
  if(isInPreview(ctx))return null;
  if(isAdmin(ctx))return {id:ctx.from.id,role:'admin'};
  const teacher=await effectiveTeacher(ctx);
  return teacher?{id:ctx.from.id,role:'teacher',teacherId:teacher.id}:null;
}

async function startBroadcastCompose(ctx,scope) {
  const actor=await broadcastActor(ctx);
  if(!actor)return ctx.answerCbQuery('هذه العملية متاحة للأستاذ والإدارة فقط.');
  try{
    const preview=await broadcasts.preview(actor,scope);
    await ctx.answerCbQuery();
    if(!preview.recipientCount)return ctx.reply('لا يوجد طلبة مستلمون في هذا النطاق. اختر نطاقًا آخر.');
    userState.set(ctx.from.id,{action:'broadcast_compose',scope});
    return ctx.reply(`📣 رسالة جماعية\nالنطاق: ${preview.label}\nعدد المستلمين حاليًا: ${preview.recipientCount}\n\nأرسل نص الرسالة (حتى 3000 حرف). سيظهر لك تأكيد قبل الإرسال.`);
  }catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
}

bot.hears('📣 رسالة جماعية', async ctx=>{
  const actor=await broadcastActor(ctx);
  if(!actor)return ctx.reply('هذه العملية متاحة للأستاذ والإدارة فقط.');
  const subjects=await getActorSubjects(ctx);
  const rows=[];
  if(actor.role==='admin')rows.push([callbackButton('📣 جميع الطلبة', 'broadcast:scope:all')]);
  rows.push(...subjects.map(s=>[callbackButton(limitButtonText(`${s.subject_name} — ${s.stage_name}`,50),
    `broadcast:subject:${s.subject_id}:${s.stage_season_id}`)]));
  if(!rows.length)return ctx.reply('لا توجد مواد مسندة إليك في الموسم الحالي.');
  return ctx.reply('اختر المادة، ثم حدد جميع طلبتها أو مجموعة معينة:',Markup.inlineKeyboard(rows));
});

bot.action('broadcast:scope:all',async ctx=>startBroadcastCompose(ctx,{kind:'all'}));
bot.action(/^broadcast:subject:(\d+):(\d+)$/,async ctx=>{
  const subjectId=Number(ctx.match[1]),seasonId=Number(ctx.match[2]);
  if(!await teacherOwnsSubject(ctx,subjectId,seasonId))return ctx.answerCbQuery('هذه المادة ليست ضمن موادك.');
  const groups=(await studies.listGroups(subjectId,seasonId)).filter(g=>g.is_active);
  await ctx.answerCbQuery();
  return ctx.reply('اختر نطاق الرسالة:',Markup.inlineKeyboard([
    [callbackButton('📚 جميع طلبة المادة',`broadcast:scope:subject:${subjectId}:${seasonId}`)],
    ...groups.map(g=>[callbackButton(limitButtonText(`👥 ${g.title}`,50),
      `broadcast:scope:group:${subjectId}:${seasonId}:${g.id}`)]),
  ]));
});
bot.action(/^broadcast:scope:subject:(\d+):(\d+)$/,async ctx=>
  startBroadcastCompose(ctx,{kind:'subject',subjectId:Number(ctx.match[1]),seasonId:Number(ctx.match[2])}));
bot.action(/^broadcast:scope:group:(\d+):(\d+):(\d+)$/,async ctx=>
  startBroadcastCompose(ctx,{kind:'group',subjectId:Number(ctx.match[1]),seasonId:Number(ctx.match[2]),groupId:Number(ctx.match[3])}));
bot.action('broadcast:confirm',async ctx=>{
  const state=userState.get(ctx.from.id);
  if(state?.action!=='broadcast_confirm')return ctx.answerCbQuery('انتهت صلاحية المعاينة. ابدأ من جديد.',{show_alert:true});
  const actor=await broadcastActor(ctx);
  if(!actor)return ctx.answerCbQuery('غير مصرح.',{show_alert:true});
  try{
    const result=await broadcasts.send(actor,state.scope,state.message,state.requestKey);
    userState.delete(ctx.from.id);
    await ctx.answerCbQuery('حُفظت الرسالة للإرسال ✅');
    return ctx.editMessageText(`✅ حُفظت الرسالة الجماعية للإرسال إلى ${result.recipientCount} طالبًا.\nرقم الإرسال: ${result.id}`);
  }catch(err){return ctx.answerCbQuery(`تعذر الإرسال: ${err.message}`,{show_alert:true});}
});

bot.hears('👥 المجموعات', (ctx) => pickTeacherSubject(ctx, 'tg_groups', 'اختر المادة لإدارة مجموعاتها:'));

async function renderGroups(ctx, subjectId, stageSeasonId, edit = false) {
  const groups = await studies.listGroups(subjectId, stageSeasonId);
  const lines = groups.length
    ? groups
        .map(
          (g) =>
            `${g.group_number}) ${g.title} — ${g.discussion_grouping===false?`${Number(g.member_count)}/${g.capacity} عضو`:`${Number(g.member_count)} عضو، ${Number(g.reserved_count)}/${g.capacity} مقعد محجوز`}` +
            `${Number(g.discussion_grouping===false?g.member_count:g.reserved_count) >= g.capacity ? ' (ممتلئة)' : ''}` +
            `${g.invite_link ? '' : ' ⚠️ بلا رابط دعوة'}`
        )
        .join('\n')
    : 'لا توجد مجموعات بعد.';
  const rows = groups.map((g) => [
    Markup.button.callback(`⚙️ ${limitButtonText(g.title, 30)}`, `tg_group:${g.id}`),
  ]);
  rows.push([Markup.button.callback('➕ إضافة مجموعة', `tg_addgroup:${subjectId}:${stageSeasonId}`)]);
  const text = `مجموعات المباحثة:\n${lines}\n\nعند امتلاء مجموعة يُوجَّه الطلبة تلقائيًا إلى التالية.`;
  const kb = Markup.inlineKeyboard(rows);
  return edit ? ctx.editMessageText(text, kb) : ctx.reply(text, kb);
}

bot.action(/tg_groups:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  return renderGroups(ctx, subjectId, ssId);
});

bot.action(/tg_addgroup:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id, { action: 'teacher_group_capacity', subjectId, ssId });
  await ctx.answerCbQuery();
  return ctx.reply('كم عدد الطلبة الأقصى في المجموعة الواحدة؟ (أرسل رقمًا، مثال: 50)');
});

bot.action(/tg_group:(\d+)/, async (ctx) => {
  const group = await studies.getGroupById(Number(ctx.match[1]));
  if (!group) return ctx.answerCbQuery('المجموعة غير موجودة.');
  if (!(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  return ctx.reply(
    `المجموعة: ${group.title}\nالسعة: ${group.capacity}\n` +
      `رابط الدعوة: ${group.invite_link || 'غير محدد ⚠️'}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔗 تعيين رابط الدعوة', `tg_link:${group.id}`)],
      [Markup.button.callback('💬 ربط مجموعة تليجرام', `tg_chat:${group.id}`)],
      [Markup.button.callback('👤 تعديل السعة', `tg_cap:${group.id}`)],
    ])
  );
});

// يعرض المجموعات التي أُضيف إليها البوت مشرفًا ولم تُربط بعد
bot.action(/tg_chat:(\d+)/, async (ctx) => {
  const group = await studies.getGroupById(Number(ctx.match[1]));
  if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  const options = [...pendingGroupChats.values()];
  if (options.length === 0) {
    return ctx.reply(
      'لم يُضَف البوت مشرفًا في أي مجموعة بعد.\n\n' +
        'الخطوات:\n' +
        '1) أضِف البوت إلى مجموعة تليجرام؛ سيغادرها ويطلب موافقة الأدمن.\n' +
        '2) بعد الموافقة أضِفه مجددًا، ثم عُد إلى هنا واختر المجموعة.'
    );
  }
  return ctx.reply(
    'اختر مجموعة تليجرام لربطها:',
    Markup.inlineKeyboard(
      options.map((c) => [
        Markup.button.callback(limitButtonText(c.title || String(c.id), 45), `tg_chatdo:${group.id}:${c.id}`),
      ])
    )
  );
});

bot.action(/tg_chatdo:(\d+):(-?\d+)/, async (ctx) => {
  const groupId = Number(ctx.match[1]);
  const chatId = Number(ctx.match[2]);
  const group = await studies.getGroupById(groupId);
  if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  if(!pendingGroupChats.has(chatId))return ctx.answerCbQuery('المجموعة غير متاحة للربط. أضف البوت بعد موافقة الأدمن.',{show_alert:true});
  await studies.setGroupChatId(groupId, chatId);
  pendingGroupChats.delete(chatId);
  await ctx.answerCbQuery('تم الربط ✅');
  return ctx.editMessageText(`✅ رُبطت مجموعة تليجرام بـ«${group.title}».`);
});

bot.action(/tg_link:(\d+)/, async (ctx) => {
  const group = await studies.getGroupById(Number(ctx.match[1]));
  if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  userState.set(ctx.from.id, { action: 'teacher_group_link', groupId: group.id });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل رابط دعوة مجموعة تليجرام (مثال: https://t.me/+xxxx):');
});

bot.action(/tg_cap:(\d+)/, async (ctx) => {
  const group = await studies.getGroupById(Number(ctx.match[1]));
  if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  userState.set(ctx.from.id, { action: 'teacher_group_editcap', groupId: group.id });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل السعة الجديدة (رقم):');
});

// ---------------------------------------------------------------------------
// الأستاذ — الجدول الأسبوعي
// ---------------------------------------------------------------------------
bot.hears('🗓️ جدول المباحثات', async (ctx) => {
  const actor = await requireTeacher(ctx);
  if (!actor) return undefined;
  const admin=isAdmin(ctx)&&!isInPreview(ctx);
  const slots = admin ? await studies.listAllSlots() : await studies.listTeacherSlots(actor.id);
  if(slots.length)await sendMarkdownDoc(ctx,'جدول_المباحثات',
    buildRtlMarkdownDoc(admin?'جدول مباحثات المعهد':'جدول مباحثات الأستاذ',
      ['المرحلة','المادة','المجموعة','الأستاذ','اليوم','الساعة'],
      slots.map(s=>[s.stage_name,s.subject_name,s.group_title||s.group_number,s.teacher_name||actor.full_name,
        studies.DAY_NAMES[s.day_of_week],studies.formatHour(s.hour,s.minute)]),'جميع المواعيد بتوقيت بغداد.'));
  return ctx.reply(
    slots.length ? `أُرفق جدول المباحثات: ${slots.length} موعدًا. اختر الإجراء المطلوب:` : 'لا توجد مواعيد مباحثات نشطة. يمكنك إضافة موعد:',
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ إضافة موعد', 'ts_add')],
      ...(slots.length
        ? [[Markup.button.callback('🗑️ حذف موعد', 'ts_del')]]
        : []),
    ])
  );
});

bot.action('ts_add', async (ctx) => {
  await ctx.answerCbQuery();
  return pickTeacherSubject(ctx, 'ts_subj', 'اختر المادة لإضافة موعد لها:');
});

bot.action(/ts_subj:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  const groups = await studies.listGroups(subjectId, ssId);
  await ctx.answerCbQuery();
  if (groups.length === 0) {
    return ctx.reply('أنشئ مجموعة أولًا من «👥 المجموعات» قبل إضافة موعد.');
  }
  return ctx.reply(
    'اختر المجموعة:',
    Markup.inlineKeyboard(
      groups.map((g) => [Markup.button.callback(limitButtonText(g.title, 40), `ts_grp:${g.id}`)])
    )
  );
});

bot.action(/ts_grp:(\d+)/, async (ctx) => {
  const group = await studies.getGroupById(Number(ctx.match[1]));
  if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  return ctx.reply(
    'اختر يوم المباحثة:',
    Markup.inlineKeyboard(
      studies.DAY_NAMES.map((name, i) => [Markup.button.callback(name, `ts_day:${group.id}:${i}`)])
    )
  );
});

bot.action(/ts_day:(\d+):(\d)/, async (ctx) => {
  const groupId = Number(ctx.match[1]);
  const day = Number(ctx.match[2]);
  const group = await studies.getGroupById(groupId);
  if (!group || !(await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  const rows = [];
  for (let i = 0; i < studies.SCHEDULE_HOURS.length; i += 3) {
    rows.push(
      studies.SCHEDULE_HOURS.slice(i, i + 3).map((h) =>
        Markup.button.callback(studies.formatHour(h), `ts_hour:${groupId}:${day}:${h}`)
      )
    );
  }
  return ctx.reply(`${studies.DAY_NAMES[day]} — اختر الساعة:`, Markup.inlineKeyboard(rows));
});

bot.action(/ts_hour:(\d+):(\d):(\d+)/, async (ctx) => {
  const groupId = Number(ctx.match[1]);
  const day = Number(ctx.match[2]);
  const hour = Number(ctx.match[3]);
  const group = await studies.getGroupById(groupId);
  const teacher = group && (await teacherOwnsSubject(ctx, group.subject_id, group.stage_season_id));
  if (!teacher) return ctx.answerCbQuery('غير مصرح.');
  try {
    const { slot, conflicts, teacherConflicts } = await studies.addScheduleSlot(groupId, {
      dayOfWeek: day, hour, teacherId: teacher.id || null,
    });
    await ctx.answerCbQuery('تمت الإضافة ✅');
    let text = `✅ أُضيف الموعد: ${studies.formatSlot(slot)}`;
    if (teacherConflicts && teacherConflicts.length > 0) {
      text +=
        '\n\n⚠️ تعارض في جدولك أنت: لديك موعد آخر في الوقت نفسه:\n' +
        teacherConflicts
          .map((c) => `• ${c.subject_name} — ${c.stage_name} (مجموعة ${c.group_number})`)
          .join('\n') +
        '\nلا يمكنك أن تكون في مباحثتين معًا.';
    }
    if (conflicts.length > 0) {
      // تنبيه لا منع: قد يكون التعارض مقصودًا في حالات نادرة، لكن يجب أن يراه الأستاذ.
      text +=
        '\n\n⚠️ تنبيه تعارض: توجد مباحثة أخرى لنفس المرحلة في هذا الوقت:\n' +
        conflicts.map((c) => `• ${c.subject_name} (مجموعة ${c.group_number})`).join('\n') +
        '\nطالب المرحلة يدرس كل موادها، فلن يستطيع حضور الاثنتين.';
    }
    return ctx.editMessageText(text);
  } catch (err) {
    await ctx.answerCbQuery('تعذرت الإضافة');
    if (err.code === 'NO_TEACHER') {
      return ctx.editMessageText(
        `⚠️ ${err.message}\n\n` +
          'أسنِد أستاذًا للمادة من «👨‍🏫 إدارة الأساتذة» ← الأستاذ ← «📘 إسناد مادة»، ثم أعد إضافة الموعد.'
      );
    }
    return ctx.editMessageText(`تعذرت إضافة الموعد: ${err.message}`);
  }
});

bot.action('ts_del', async (ctx) => {
  const actor = await requireTeacher(ctx);
  if (!actor) return ctx.answerCbQuery('غير مصرح.');
  const slots = isAdmin(ctx) ? await studies.listAllSlots() : await studies.listTeacherSlots(actor.id);
  await ctx.answerCbQuery();
  if (slots.length === 0) return ctx.reply('لا توجد مواعيد.');
  return ctx.reply(
    'اختر الموعد لحذفه:',
    Markup.inlineKeyboard(
      slots.map((s) => [
        Markup.button.callback(
          limitButtonText(`${studies.formatSlot(s)} — ${s.subject_name}`, 50),
          `ts_delok:${s.id}`
        ),
      ])
    )
  );
});

bot.action(/ts_delok:(\d+)/, async (ctx) => {
  const actor = await requireTeacher(ctx);
  if (!actor) return ctx.answerCbQuery('غير مصرح.');
  const all = isAdmin(ctx) ? await studies.listAllSlots() : await studies.listTeacherSlots(actor.id);
  if (!all.some((s) => s.id === Number(ctx.match[1]))) return ctx.answerCbQuery('هذا الموعد ليس في جدولك.');
  await studies.removeScheduleSlot(Number(ctx.match[1]));
  await ctx.answerCbQuery('حُذف ✅');
  return ctx.editMessageText('حُذف الموعد من الجدول ✅');
});

// ---------------------------------------------------------------------------
// الأستاذ — الامتحانات الشهرية
// ---------------------------------------------------------------------------
bot.hears('📝 الامتحانات', (ctx) => pickTeacherSubject(ctx, 'ex_subj', 'اختر المادة لإدارة امتحاناتها:'));

bot.action(/ex_subj:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const exams = await studies.listExamsForSubject(subjectId, ssId);
  const byNumber = new Map(exams.filter(e=>e.status!=='cancelled').map((e) => [e.exam_number, e]));
  const rows = [];
  for (let n = 1; n <= studies.GRADE_WEIGHTS.examsPerSeason; n += 1) {
    const e = byNumber.get(n);
    rows.push([
      e
        ? Markup.button.callback(
            `${e.status === 'cancelled' ? '🚫' : e.status === 'published' ? '📤' : '⏰'} الشهري ${n} — ${Number(e.question_count)} سؤال` +
              (e.status === 'cancelled' ? ' (ملغى)' : e.status === 'published' ? ` (${Number(e.submitted_count)} سلّموا)` : ' (مجدول)'),
            `ex_view:${e.id}`
          )
        : Markup.button.callback(`➕ إنشاء الامتحان الشهري ${n}`, `ex_new:${subjectId}:${ssId}:${n}`),
    ]);
    for(const cancelled of exams.filter(e=>e.exam_number===n&&e.status==='cancelled')){
      rows.push([Markup.button.callback(`🚫 سجل الامتحان الملغى ${n}`,`ex_view:${cancelled.id}`)]);
    }
  }
  return ctx.reply(
    `امتحانات المادة (${studies.GRADE_WEIGHTS.examsPerSeason} امتحانات، كل واحد ` +
      `${studies.GRADE_WEIGHTS.examEach} درجات مهما كان عدد الأسئلة):`,
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/ex_new:(\d+):(\d+):(\d)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const number = Number(ctx.match[3]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const days = studies.upcomingWeekDays();
  return ctx.reply(
    `الامتحان الشهري ${number} — اختر يوم الامتحان:`,
    Markup.inlineKeyboard(
      days.map((d) => [
        Markup.button.callback(d.label, `ex_day:${subjectId}:${ssId}:${number}:${d.iso}`),
      ])
    )
  );
});

bot.action(/ex_day:(\d+):(\d+):(\d):(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const [, subjectId, ssId, number, iso] = ctx.match;
  if (!(await teacherOwnsSubject(ctx, Number(subjectId), Number(ssId)))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  userState.set(ctx.from.id, {
    action: 'teacher_exam_topic',
    subjectId: Number(subjectId),
    ssId: Number(ssId),
    number: Number(number),
    dateIso: iso,
  });
  await ctx.answerCbQuery();
  return ctx.reply(
    `تاريخ الامتحان: ${iso}\n\nأرسل موضوع الامتحان الذي سيظهر في إشعار الطلبة، مثال: «أحكام البيع».`
  );
});

async function renderExam(ctx, examId, edit = false) {
  const exam = await studies.getExamById(examId);
  const questions = await studies.listExamQuestions(examId);
  const lines = questions.length
    ? questions
        .map((q) => `${q.position}) [${q.question_type === 'tf' ? 'صح/خطأ' : 'خيارات'}] ${q.prompt}`)
        .join('\n')
    : 'لا أسئلة بعد.';
  const rows = [];
  if(exam.status!=='cancelled'&&Number(exam.attempt_count)===0){
    rows.push([callbackButton('✏️ تعديل موضوع الامتحان',`ex_edit_title:${examId}`)]);
    rows.push([callbackButton('📅 تعديل تاريخ الامتحان',`ex_edit_date:${examId}`)]);
    rows.push([callbackButton('➕ سؤال صح/خطأ',`ex_qtf:${examId}`),callbackButton('➕ سؤال اختيار متعدد',`ex_qmcq:${examId}`)]);
    rows.push([callbackButton('✏️ تعديل سؤال',`ex_edit_question:${examId}`),callbackButton('🗑️ حذف سؤال',`ex_delete_question:${examId}`)]);
    rows.push([callbackButton('🗑️ حذف الامتحان',`ex_delete:${examId}`)]);
  }
  if (exam.status === 'published') {
    rows.push([Markup.button.callback('📊 النتائج', `ex_res:${examId}`)]);
    rows.push([Markup.button.callback('🕓 تأجيل الامتحان', `ex_pp:${examId}`)]);
  }
  if(exam.status!=='cancelled')rows.push([Markup.button.callback('🚫 إلغاء الامتحان وإشعار الطلبة',`ex_cancel:${examId}`)]);
  const text =
    `📝 ${exam.title || 'الامتحان الشهري ' + exam.exam_number} — ${exam.subject_name}\n` +
    `الحالة: ${exam.status === 'cancelled' ? 'ملغى 🚫' : exam.status === 'published' ? 'منشور 📤' : 'مجدول تلقائيًا ⏰'}\n` +
    `يفتح: ${new Date(exam.opens_at).toISOString().slice(0, 16).replace('T', ' ')}\n` +
    `يُغلق: ${new Date(exam.closes_at).toISOString().slice(0, 16).replace('T', ' ')}\n` +
    `الدرجة: ${Number(exam.max_score)}\n\nالأسئلة (${questions.length}):\n${lines.slice(0,2700)}${lines.length>2700?'\n… بقية الأسئلة متاحة كاملة في لوحة الإدارة.':''}`;
  const kb = Markup.inlineKeyboard(rows);
  return edit ? ctx.editMessageText(text, kb) : ctx.reply(text, kb);
}

bot.action(/ex_view:(\d+)/, async (ctx) => {
  const exam = await studies.getExamById(Number(ctx.match[1]));
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  return renderExam(ctx, exam.id);
});

bot.action(/^ex_cancel:(\d+)$/,async ctx=>{
  const exam=await studies.getExamById(Number(ctx.match[1]));
  if(!exam||!await teacherOwnsSubject(ctx,exam.subject_id,exam.stage_season_id))return ctx.answerCbQuery('غير مصرح.');
  if(exam.status==='cancelled')return ctx.answerCbQuery('الامتحان ملغى مسبقًا.');
  await ctx.answerCbQuery();
  return ctx.reply(`هل تريد إلغاء «${exam.title||'الامتحان الشهري '+exam.exam_number}»؟\nسيُحفظ سجله ويصل إشعار إلغاء للطلبة. لا يمكن الإلغاء إذا بدأ طالب محاولة.`,
    Markup.inlineKeyboard([[callbackButton('✅ تأكيد الإلغاء',`ex_cancel_confirm:${exam.id}`)],
      [callbackButton('تراجع','admin_cancel_noop')]]));
});
bot.action(/^ex_cancel_confirm:(\d+)$/,async ctx=>{
  const exam=await studies.getExamById(Number(ctx.match[1]));
  if(!exam||!await teacherOwnsSubject(ctx,exam.subject_id,exam.stage_season_id))return ctx.answerCbQuery('غير مصرح.');
  try{
    const result=await studies.cancelExam(exam.id,ctx.from.id);
    await ctx.answerCbQuery('أُلغي الامتحان ✅');
    return ctx.editMessageText(`🚫 أُلغي الامتحان الشهري ${result.examNumber} في مادة «${result.subjectName}».\nحُفظ إشعار الإلغاء للإرسال إلى ${result.recipientCount} طالبًا.`);
  }catch(err){return ctx.answerCbQuery(`تعذر الإلغاء: ${err.message}`,{show_alert:true});}
});

async function editableExamForAction(ctx,examId){
  const exam=await studies.getExamById(examId);
  if(!exam||exam.status==='cancelled'||!await teacherOwnsSubject(ctx,exam.subject_id,exam.stage_season_id)||Number(exam.attempt_count)>0)return null;
  return exam;
}
bot.action(/^ex_edit_title:(\d+)$/,async ctx=>{
  const exam=await editableExamForAction(ctx,Number(ctx.match[1]));if(!exam)return ctx.answerCbQuery('لا يمكن تعديل هذا الامتحان.');
  userState.set(ctx.from.id,{action:'teacher_exam_edit_title',examId:exam.id});await ctx.answerCbQuery();return ctx.reply('أرسل موضوع الامتحان الجديد:');
});
bot.action(/^ex_edit_date:(\d+)$/,async ctx=>{
  const exam=await editableExamForAction(ctx,Number(ctx.match[1]));if(!exam)return ctx.answerCbQuery('لا يمكن تعديل هذا الامتحان.');
  await ctx.answerCbQuery();return ctx.reply('اختر تاريخ الامتحان الجديد:',Markup.inlineKeyboard(studies.upcomingWeekDays().map(day=>[callbackButton(day.label,`ex_edit_day:${exam.id}:${day.iso}`)])));
});
bot.action(/^ex_edit_day:(\d+):(\d{4}-\d{2}-\d{2})$/,async ctx=>{
  const exam=await editableExamForAction(ctx,Number(ctx.match[1]));if(!exam)return ctx.answerCbQuery('لا يمكن تعديل هذا الامتحان.');
  try{await studies.updateExam(exam.id,{title:exam.title,dateIso:ctx.match[2],hours:exam.available_hours});await ctx.answerCbQuery('حُفظ التاريخ');return renderExam(ctx,exam.id);}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
});
bot.action(/^ex_delete:(\d+)$/,async ctx=>{
  const exam=await editableExamForAction(ctx,Number(ctx.match[1]));if(!exam)return ctx.answerCbQuery('لا يمكن حذف هذا الامتحان.');
  await ctx.answerCbQuery();return ctx.reply(`حذف «${exam.title}» وأسئلته؟`,Markup.inlineKeyboard([[callbackButton('نعم، احذف الامتحان',`ex_delete_confirm:${exam.id}`)]]));
});
bot.action(/^ex_delete_confirm:(\d+)$/,async ctx=>{
  const exam=await editableExamForAction(ctx,Number(ctx.match[1]));if(!exam)return ctx.answerCbQuery('لا يمكن حذف هذا الامتحان.');
  try{await studies.deleteExam(exam.id);await ctx.answerCbQuery('حُذف الامتحان');return ctx.editMessageText('حُذف الامتحان وأسئلته.');}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
});
for(const action of ['edit','delete'])bot.action(new RegExp(`^ex_${action}_question:(\\d+)$`),async ctx=>{
  const exam=await editableExamForAction(ctx,Number(ctx.match[1]));if(!exam)return ctx.answerCbQuery('لا يمكن تعديل الأسئلة.');
  const questions=await studies.listExamQuestions(exam.id);await ctx.answerCbQuery();
  if(!questions.length)return ctx.reply('لا توجد أسئلة.');
  return ctx.reply(action==='edit'?'اختر السؤال لتعديله:':'اختر السؤال لحذفه:',Markup.inlineKeyboard(questions.map(q=>[callbackButton(limitButtonText(`${q.position}. ${q.prompt}`,48),`ex_${action}_question_pick:${q.id}`)])));
});
bot.action(/^ex_edit_question_pick:(\d+)$/,async ctx=>{
  const q=await studies.getQuestionById(Number(ctx.match[1]));const exam=q&&await editableExamForAction(ctx,q.exam_id);
  if(!exam)return ctx.answerCbQuery('لا يمكن تعديل السؤال.');
  userState.set(ctx.from.id,{action:'teacher_q_edit_prompt',questionId:q.id,examId:exam.id,type:q.question_type});
  await ctx.answerCbQuery();return ctx.reply(`السؤال الحالي: ${q.prompt}\nأرسل نص السؤال الجديد:`);
});
bot.action(/^ex_delete_question_pick:(\d+)$/,async ctx=>{
  const q=await studies.getQuestionById(Number(ctx.match[1]));const exam=q&&await editableExamForAction(ctx,q.exam_id);
  if(!exam)return ctx.answerCbQuery('لا يمكن حذف السؤال.');
  try{await studies.deleteExamQuestion(q.id);await ctx.answerCbQuery('حُذف السؤال');return renderExam(ctx,exam.id);}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
});
bot.action(/^ex_edit_tfans:(\d+):(صح|خطأ)$/,async ctx=>{
  const state=userState.get(ctx.from.id),q=await studies.getQuestionById(Number(ctx.match[1]));
  if(!state||state.action!=='teacher_q_edit_tf_answer'||state.questionId!==q?.id||!await editableExamForAction(ctx,q.exam_id))return ctx.answerCbQuery('انتهت عملية التعديل.');
  try{await studies.updateExamQuestion(q.id,{type:'tf',prompt:state.prompt,correct:ctx.match[2]});userState.delete(ctx.from.id);await ctx.answerCbQuery('حُفظ السؤال');return renderExam(ctx,q.exam_id);}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
});
bot.action(/^ex_edit_mcqans:(\d+):(\d+)$/,async ctx=>{
  const state=userState.get(ctx.from.id),q=await studies.getQuestionById(Number(ctx.match[1]));
  if(!state||state.action!=='teacher_q_edit_mcq_answer'||state.questionId!==q?.id||!await editableExamForAction(ctx,q.exam_id))return ctx.answerCbQuery('انتهت عملية التعديل.');
  const correct=state.options[Number(ctx.match[2])];if(!correct)return ctx.answerCbQuery('خيار غير صالح.');
  try{await studies.updateExamQuestion(q.id,{type:'mcq',prompt:state.prompt,options:state.options,correct});userState.delete(ctx.from.id);await ctx.answerCbQuery('حُفظ السؤال');return renderExam(ctx,q.exam_id);}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
});

bot.action(/ex_qtf:(\d+)/, async (ctx) => {
  const exam = await studies.getExamById(Number(ctx.match[1]));
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  userState.set(ctx.from.id, { action: 'teacher_q_tf_prompt', examId: exam.id });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل نص سؤال «صح/خطأ»:');
});

bot.action(/ex_qmcq:(\d+)/, async (ctx) => {
  const exam = await studies.getExamById(Number(ctx.match[1]));
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  userState.set(ctx.from.id, { action: 'teacher_q_mcq_prompt', examId: exam.id });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل نص سؤال الاختيار من متعدد:');
});

bot.action(/ex_tfans:(\d+):(صح|خطأ)/, async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'teacher_q_tf_answer') return ctx.answerCbQuery();
  const exam=await studies.getExamById(Number(ctx.match[1]));
  if(state.examId!==Number(ctx.match[1])||!exam||!await teacherOwnsSubject(ctx,exam.subject_id,exam.stage_season_id))return ctx.answerCbQuery('غير مصرح.');
  await studies.addExamQuestion(Number(ctx.match[1]), {
    type: 'tf', prompt: state.prompt, correct: ctx.match[2],
  });
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('أُضيف السؤال ✅');
  await ctx.editMessageText(`✅ أُضيف السؤال، والجواب الصحيح: ${ctx.match[2]}`);
  return renderExam(ctx, Number(ctx.match[1]));
});

bot.action(/ex_mcqans:(\d+):(\d+)/, async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'teacher_q_mcq_correct') return ctx.answerCbQuery();
  const examId = Number(ctx.match[1]);
  const exam=await studies.getExamById(examId);
  if(state.examId!==examId||!exam||!await teacherOwnsSubject(ctx,exam.subject_id,exam.stage_season_id))return ctx.answerCbQuery('غير مصرح.');
  const index = Number(ctx.match[2]);
  const correct = state.options[index];
  if (correct === undefined) return ctx.answerCbQuery('خيار غير صالح.');
  await studies.addExamQuestion(examId, {
    type: 'mcq', prompt: state.prompt, options: state.options, correct,
  });
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('أُضيف السؤال ✅');
  await ctx.editMessageText(`✅ أُضيف السؤال، والجواب الصحيح: ${correct}`);
  return renderExam(ctx, examId);
});

bot.action(/ex_pub:(\d+)/, async (ctx) => {
  const exam = await studies.getExamById(Number(ctx.match[1]));
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  try {
    await studies.publishExam(exam.id);
    await ctx.answerCbQuery('نُشر ✅');
    return ctx.editMessageText('📤 نُشر الامتحان وحُفظت إشعارات الطلبة للإرسال تلقائيًا.');
  } catch (err) {
    return ctx.answerCbQuery(`تعذر النشر: ${err.message}`, { show_alert: true });
  }
});

bot.action(/ex_pp:(\d+)/, async (ctx) => {
  const exam = await studies.getExamById(Number(ctx.match[1]));
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  const days = studies.upcomingWeekDays();
  return ctx.reply(
    `🕓 تأجيل «${exam.title || 'الامتحان الشهري ' + exam.exam_number}».\n` +
      'يمكن تغيير الموعد ما دام لم يبدأ أي طالب محاولة.\n\nاختر التاريخ الجديد:',
    Markup.inlineKeyboard(
      days.map((d) => [callbackButton(d.label, `ex_ppday:${exam.id}:${d.iso}`)])
    )
  );
});

bot.action(/ex_ppday:(\d+):(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const examId = Number(ctx.match[1]);
  const exam = await studies.getExamById(examId);
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  userState.set(ctx.from.id, { action: 'teacher_exam_postpone_hours', examId, dateIso: ctx.match[2] });
  await ctx.answerCbQuery();
  return ctx.reply(`التاريخ الجديد: ${ctx.match[2]}\n\nكم ساعة يبقى الامتحان متاحًا؟`);
});

bot.action(/ex_res:(\d+)/, async (ctx) => {
  const exam = await studies.getExamById(Number(ctx.match[1]));
  if (!exam || !(await teacherOwnsSubject(ctx, exam.subject_id, exam.stage_season_id))) {
    return ctx.answerCbQuery('غير مصرح.');
  }
  await ctx.answerCbQuery();
  const results = await studies.getExamResults(exam.id);
  if (results.length === 0) return ctx.reply('لم يدخل الامتحان أحد بعد.');
  const submitted = results.filter((r) => r.submitted_at);
  await ctx.reply(`📊 سلّم ${submitted.length} طالبًا من أصل ${results.length} بدأوا الامتحان.`);
  return sendMarkdownDoc(
    ctx,
    `نتائج_الامتحان_${exam.exam_number}`,
    buildMarkdownDoc(
      `نتائج ${exam.title || 'الامتحان الشهري ' + exam.exam_number} — ${exam.subject_name}`,
      ['الطالب', 'الدرجة', 'الإجابات الصحيحة', 'عدد الأسئلة'],
      submitted.map((r) => [
        r.full_name, Number(r.score), Number(r.correct_count), Number(r.total_questions),
      ]),
      `**الدرجة القصوى:** ${Number(exam.max_score)}`
    )
  );
});

// ---------------------------------------------------------------------------
// الأستاذ — إنهاء الموسم: تقييم التقارير ثم احتساب الدرجات
// ---------------------------------------------------------------------------
bot.hears('🏁 إنهاء الموسم', (ctx) =>
  pickTeacherSubject(ctx, 'fin_subj', 'اختر المادة لإنهاء موسم مباحثاتها وتقاريرها:')
);

bot.action(/fin_subj:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const pending = await studies.listReportStudentsForGrading(subjectId, ssId);
  const ungraded = await studies.listReportStudentsForGrading(subjectId,ssId,{onlyUngraded:true,size:1});
  return ctx.reply(
    `طلبة التقارير في هذه المادة: ${Number(pending[0]?.total_count||0)}\n` +
      `بانتظار التقييم: ${Number(ungraded[0]?.total_count||0)}\n\n` +
      `درجة التقارير من ${studies.GRADE_WEIGHTS.participationTotal}، ` +
      `ودرجة المباحثات تُحسب تلقائيًا بنسبة الحضور.`,
    Markup.inlineKeyboard([
      ...(ungraded.length
        ? [[Markup.button.callback('📄 تقييم التقارير طالبًا تلو الآخر', `fin_grade:${subjectId}:${ssId}`)]]
        : []),
      [Markup.button.callback('📊 معاينة الدرجات قبل الاعتماد', `fin_preview:${subjectId}:${ssId}`)],
      [Markup.button.callback('🏁 اعتماد درجات الموسم', `fin_confirm:${subjectId}:${ssId}`)],
    ])
  );
});

// يعرض طالبًا واحدًا مع سجله السابق ليقيّمه الأستاذ، ثم ينتقل للذي يليه.
async function showNextReportStudent(ctx, subjectId, ssId) {
  const pending = await studies.listReportStudentsForGrading(subjectId, ssId,{onlyUngraded:true,size:1});
  const next = pending.find((p) => p.report_score === null);
  if (!next) {
    return ctx.reply('✅ اكتمل تقييم جميع طلبة التقارير في هذه المادة.', teacherMainMenu());
  }
  const reports = await studies.listStudentReports(next.student_id, subjectId, ssId);
  const lines = reports.length
    ? reports
        .map((r, i) => `${i + 1}) ${new Date(r.submitted_at).toISOString().slice(0, 10)}`)
        .join('\n')
    : 'لم يُسلّم أي تقرير.';
  await ctx.reply(
    `👤 ${next.full_name}\n` +
      `النمط: ${next.mode === 'report' ? 'تقارير' : 'محوَّل إلى مباحثات'}\n` +
      `عدد التقارير المُسلَّمة: ${Number(next.report_count)}\n${lines}\n\n` +
      `أرسل الدرجة من ${studies.GRADE_WEIGHTS.participationTotal}:`
  );
  // نُرسل ملفات تقاريره ليطّلع عليها قبل التقييم
  for (const r of reports.slice(0, 5)) {
    if (!r.telegram_file_id) continue;
    try {
      await ctx.replyWithDocument(r.telegram_file_id);
    } catch (err) {
      console.warn('تعذر إرسال ملف تقرير:', err.description || err.message);
    }
  }
  userState.set(ctx.from.id, {
    action: 'teacher_report_score',
    subjectId,
    ssId,
    studentId: next.student_id,
    studentName: next.full_name,
  });
  return undefined;
}

bot.action(/fin_grade:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  return showNextReportStudent(ctx, subjectId, ssId);
});

bot.action(/fin_preview:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const grades = await studies.computeSeasonGrades(subjectId, ssId);
  if (grades.length === 0) return ctx.reply('لا يوجد طلبة اختاروا نمط مشاركة في هذه المادة بعد.');
  await ctx.reply(`📊 معاينة درجات ${grades.length} طالبًا (لم تُعتمد بعد).`);
  return sendMarkdownDoc(
    ctx,
    `معاينة_درجات_${subjectId}`,
    buildMarkdownDoc(
      'معاينة درجات الموسم',
      ['الطالب', 'النمط', 'حضر', 'من', 'المباحثات', 'التقارير', 'المشاركة', 'الامتحانات', 'الدروس', 'المجموع'],
      grades.map((g) => [
        g.fullName, g.mode === 'report' ? 'تقارير' : 'مباحثات',
        g.attendedSessions, g.eligibleSessions, g.mubahathaScore, g.reportScore,
        g.participationScore, g.examsScore, g.lessonsScore, g.totalScore,
      ]),
      '_هذه معاينة قبل الاعتماد._'
    )
  );
});

bot.action(/fin_confirm:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  return ctx.reply(
    '🏁 اعتماد درجات الموسم يحفظ الدرجات النهائية لكل الطلبة في هذه المادة. هل تريد المتابعة؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ نعم، اعتمد الدرجات', `fin_do:${subjectId}:${ssId}`)],
      [Markup.button.callback('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/fin_do:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  const grades = await studies.finalizeSeasonGrades(subjectId, ssId);
  await ctx.answerCbQuery('اعتُمدت ✅');
  return ctx.editMessageText(`🏁 اعتُمدت درجات ${grades.length} طالبًا في هذه المادة ✅`);
});

// ---------------------------------------------------------------------------
// الطالب — جدوله الأسبوعي
// ---------------------------------------------------------------------------
bot.hears('🗓️ جدولي', async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return ctx.reply('مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.');
  const slots = await studies.listStudentSlots(student.id);
  if (slots.length === 0) {
    return ctx.reply('لا توجد مواعيد مباحثات في جدولك بعد. سيظهر الجدول بعد انضمامك لمجموعات المباحثة.');
  }
  const byDay = new Map();
  for (const s of slots) {
    if (!byDay.has(s.day_of_week)) byDay.set(s.day_of_week, []);
    byDay.get(s.day_of_week).push(s);
  }
  const lines = [];
  // ترتيب العرض الدراسي يبدأ من السبت، مع إبقاء day_of_week بصيغة PostgreSQL/JS (الأحد=0، السبت=6).
  for (const d of [6, 0, 1, 2, 3, 4, 5]) {
    if (!byDay.has(d)) continue;
    lines.push(`\n📅 ${studies.DAY_NAMES[d]}`);
    for (const s of byDay.get(d)) {
      lines.push(`   ${studies.formatHour(s.hour, s.minute)} — ${s.subject_name} (${s.group_title})`);
    }
  }
  return ctx.reply(`🗓️ جدول مباحثاتك الأسبوعي:${lines.join('\n')}`);
});

// ---------------------------------------------------------------------------
// الطالب — الامتحانات الشهرية
// ---------------------------------------------------------------------------
bot.hears('📝 الامتحانات الشهرية', async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return replyStudentScreen(ctx, student, withStudentName(student, 'مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.'));

  const open = await studies.getOpenExamsForStudent(student.id);
  const done = await studies.getStudentExamResults(student.id);

  const doneLines = done.length
    ? done
        .map(
          (r) =>
            `• ${r.subject_name} — الشهري ${r.exam_number}: ${Number(r.score)} من ${Number(r.max_score)}` +
            ` (${Number(r.correct_count)} من ${Number(r.total_questions)} صحيحة)`
        )
        .join('\n')
    : 'لم تُسلّم أي امتحان بعد.';

  const rows = open.map((e) => [
    Markup.button.callback(
      limitButtonText(`📝 ${e.subject_name} — الشهري ${e.exam_number}`, 50),
      `stex_start:${e.id}`
    ),
  ]);

  return replyStudentScreen(
    ctx, student,
    withStudentName(student, `📝 الامتحانات الشهرية\n\nالمتاحة الآن: ${open.length}\n\nدرجاتك السابقة:\n${doneLines}`),
    rows.length ? Markup.inlineKeyboard(rows) : undefined
  );
});

// يعرض السؤال التالي، أو ينهي الامتحان ويُظهر الدرجة فور انتهائه.
async function sendNextExamQuestion(ctx, attemptId, examId) {
  const q = await studies.getNextUnansweredQuestion(attemptId);
  if (!q) {
    const result = await studies.finalizeAttempt(attemptId);
    const exam = await studies.getExamById(examId);
    return ctx.reply(
      `✅ انتهى الامتحان وسُلّم.\n\n` +
        `📊 درجتك: ${Number(result.score)} من ${Number(exam.max_score)}\n` +
        `الإجابات الصحيحة: ${Number(result.correct_count)} من ${Number(result.total_questions)}\n\n` +
        'وفقك الله.',
      studentMainMenu(await effectiveStudent(ctx))
    );
  }
  const options =
    q.question_type === 'tf'
      ? ['صح', 'خطأ']
      : Array.isArray(q.options)
      ? q.options
      : JSON.parse(q.options || '[]');
  const rows = options.map((o, i) => [
    Markup.button.callback(limitButtonText(o, 50), `stex_ans:${attemptId}:${q.id}:${i}`),
  ]);
  return ctx.reply(
    `السؤال ${q.position} من ${Number(q.total)}:\n\n${q.prompt}`,
    Markup.inlineKeyboard(rows)
  );
}

bot.action(/stex_start:(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const examId = Number(ctx.match[1]);
  try {
    const attempt = await studies.startOrResumeAttempt(examId, student.id);
    await ctx.answerCbQuery();
    const exam = await studies.getExamById(examId);
    await ctx.editMessageText(
      `📝 ${exam.subject_name} — الامتحان الشهري ${exam.exam_number}\n` +
        `عدد الأسئلة: ${Number(exam.question_count)} | الدرجة: ${Number(exam.max_score)}\n\n` +
        'إن انقطع الاتصال ستُكمل من حيث توقفت.'
    );
    return sendNextExamQuestion(ctx, attempt.id, examId);
  } catch (err) {
    return ctx.answerCbQuery(err.message, { show_alert: true });
  }
});

bot.action(/stex_ans:(\d+):(\d+):(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const attemptId = Number(ctx.match[1]);
  const questionId = Number(ctx.match[2]);
  const index = Number(ctx.match[3]);

  const attempt = await studies.getAttemptById(attemptId);
  if (!attempt || attempt.student_id !== student.id) return ctx.answerCbQuery('غير مصرح.');
  if (attempt.submitted_at) return ctx.answerCbQuery('سبق أن سلّمت هذا الامتحان.');

  // يُفحص وقت الإغلاق عند كل إجابة، فلا تُقبل إجابة بعد انتهاء مهلة الامتحان
  const examNow = await studies.getExamById(attempt.exam_id);
  if (!examNow || !await studies.isExamAvailable(attempt.exam_id,student.id)) {
    const expiredResult=await studies.finalizeAttempt(attemptId,{onlyIfClosed:true});
    if(!expiredResult)return ctx.answerCbQuery('الامتحان غير متاح الآن؛ راجع نافذة الفتح الخاصة بك ثم أعد المحاولة.',{show_alert:true});
    await ctx.answerCbQuery('انتهت مهلة الامتحان.', { show_alert: true });
    const done = await studies.getAttemptById(attemptId);
    return ctx.reply(
      `⏰ انتهت مهلة الامتحان وسُلّم بما أجبت عنه.\n` +
        `درجتك: ${Number(done.score)} من ${Number(examNow ? examNow.max_score : 5)}`,
      studentMainMenu(await effectiveStudent(ctx))
    );
  }

  const question = await studies.getQuestionById(questionId);
  if (!question || question.exam_id !== attempt.exam_id) return ctx.answerCbQuery('سؤال غير صالح.');

  const options =
    question.question_type === 'tf'
      ? ['صح', 'خطأ']
      : Array.isArray(question.options)
      ? question.options
      : JSON.parse(question.options || '[]');
  const answer = options[index];
  if (answer === undefined) return ctx.answerCbQuery('خيار غير صالح.');

  try {await studies.submitAnswer(attemptId, questionId, answer);}
  catch(err){return ctx.answerCbQuery(err.message,{show_alert:true});}
  await ctx.answerCbQuery('سُجّلت إجابتك');
  await ctx.editMessageText(`السؤال ${question.position}: ${question.prompt}\n\nإجابتك: ${answer} ✔️`);
  return sendNextExamQuestion(ctx, attemptId, attempt.exam_id);
});

bot.action(/stu_xfer:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const student = await db.generateStudentTransferCode(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم التوليد ✅');
  return ctx.editMessageText(
    `📱 كود نقل حساب «${student.full_name}»:\n\n${student.transfer_code}\n\n` +
      'أرسل الكود للطالب. من حسابه الجديد يفتح البوت ويرسل /start ثم يكتب الكود بدل اسمه، ' +
      'فينتقل سجله كاملًا (الحضور والمباحثات والامتحانات والدرجات) إلى الحساب الجديد.\n' +
      'الكود يُستعمل مرة واحدة ويُبطل بعدها.'
  );
});

// ---------------------------------------------------------------------------
// نقل الطالب: بين مجموعات المادة، أو إلى مرحلة أخرى بلا درجات
// ---------------------------------------------------------------------------
bot.action(/stu_movegrp:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const student = await db.getStudentById(studentId);
  await ctx.answerCbQuery();
  if (!student) return ctx.reply('الطالب غير موجود.');
  const memberships = await studies.listStudentGroups(studentId);
  if (memberships.length === 0) return ctx.reply('هذا الطالب ليس عضوًا في أي مجموعة مباحثة.');
  return ctx.reply(
    `اختر مادة لتحديد رقم المجموعة الجديد في جميع مواد الطالب لهذا الموسم:\nالطالب: ${student.full_name}`,
    Markup.inlineKeyboard(
      memberships.map((m) => [
        callbackButton(
          limitButtonText(`${m.subject_name} — ${m.group_title}`, 50),
          `stu_mgsubj:${studentId}:${m.subject_id}:${m.stage_season_id}`
        ),
      ])
    )
  );
});

bot.action(/stu_mgsubj:(\d+):(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const [, studentId, subjectId, ssId] = ctx.match.map(Number);
  const groups = await studies.listGroups(subjectId, ssId);
  await ctx.answerCbQuery();
  const available = groups.filter((g) => Number(g.reserved_count) < Number(g.capacity));
  if (available.length === 0) return ctx.reply('لا توجد مجموعة فيها متسع. أنشئ مجموعة جديدة أولًا.');
  return ctx.reply(
    'اختر الرقم الجديد: سيُوحّد في جميع مواد الطالب بهذا الموسم بعد التحقق من السعة. تبدأ أهلية الحضور من وقت النقل في المجموعات المتغيرة وتبقى التقارير السابقة محفوظة.',
    Markup.inlineKeyboard(
      available.map((g) => [
        callbackButton(
          `${g.title} (${Number(g.reserved_count)}/${g.capacity} محجوز)`,
          `stu_mgdo:${studentId}:${subjectId}:${ssId}:${g.id}`
        ),
      ])
    )
  );
});

bot.action(/stu_mgdo:(\d+):(\d+):(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const [, studentId, subjectId, ssId, groupId] = ctx.match.map(Number);
  try {
    const group = await studies.moveStudentToGroup(studentId, subjectId, ssId, groupId);
    await ctx.answerCbQuery('تم النقل ✅');
    return ctx.editMessageText(
      `✅ وُحّد رقم مجموعة الطالب إلى ${group.group_number} في جميع مواده بهذا الموسم.\nتغيّرت ${group.moved_subject_ids.length} مادة، وبقيت التقارير السابقة محفوظة.`
    );
  } catch (err) {
    return ctx.answerCbQuery(`تعذر النقل: ${err.message}`, { show_alert: true });
  }
});

bot.action(/stu_movefresh:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const stages = await db.listStages();
  await ctx.answerCbQuery();
  const student = await db.getStudentById(studentId);
  if (!student) return ctx.reply('الطالب غير موجود.');
  return ctx.reply(
    `🔀 نقل «${student.full_name}» إلى مرحلة أخرى بلا درجات.\n` +
      'سيُمحى سجله الدراسي في مرحلته الحالية (المجموعات، حضور المباحثات، محاولات الامتحانات، التقارير، الدرجات) ' +
      'ليبدأ في المرحلة الجديدة من الصفر.\n\nاختر المرحلة الجديدة:',
    Markup.inlineKeyboard(
      stages
        .filter((s) => s.id !== student.stage_id)
        .map((s) => [callbackButton(limitButtonText(s.name), `stu_mfdo:${studentId}:${s.id}`)])
    )
  );
});

bot.action(/stu_mfdo:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  await ctx.answerCbQuery();
  return ctx.reply(
    '⚠️ تأكيد: سيُمحى سجله الدراسي في مرحلته الحالية نهائيًا. هل تريد المتابعة؟',
    Markup.inlineKeyboard([
      [callbackButton('✅ نعم، انقله بلا درجات', `stu_mfok:${studentId}:${stageId}`)],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/stu_mfok:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const stageId = Number(ctx.match[2]);
  const current = await db.getStudentActiveStageSeason(studentId);
  if (current) await studies.resetStudentStudies(studentId, current.stage_season_id);
  await db.updateStudentStage(studentId, stageId);
  await ctx.answerCbQuery('تم النقل ✅');
  return ctx.editMessageText('✅ نُقل الطالب إلى المرحلة الجديدة بلا أي درجات، ويبدأ فيها من الصفر.');
});

// ---------------------------------------------------------------------------
// التقاط مجموعات تليجرام التي أُضيف إليها البوت
// ---------------------------------------------------------------------------
// تليجرام يضيف البوت أولًا ثم يرسل my_chat_member؛ لذلك يغادر أي مجموعة غير معتمدة فورًا.
const pendingGroupChats = new Map();

bot.on('my_chat_member', async (ctx) => {
  const upd = ctx.myChatMember;
  const chat = upd.chat;
  if (!['group', 'supergroup'].includes(chat.type)) return;
  const status = upd.new_chat_member && upd.new_chat_member.status;
  if(['left','kicked'].includes(status)){pendingGroupChats.delete(chat.id);return;}
  if (!['administrator', 'member'].includes(status)) return;
  const allowed=(await db.pool.query('SELECT approved_at FROM approved_group_chats WHERE chat_id=$1',[chat.id])).rows[0]?.approved_at;
  if(!allowed){
    await db.pool.query(`INSERT INTO approved_group_chats(chat_id,title) VALUES($1,$2)
      ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title,requested_at=now() WHERE approved_group_chats.approved_at IS NULL`,
      [chat.id,chat.title||null]);
    pendingGroupChats.delete(chat.id);
    let left=true;
    try{await bot.telegram.leaveChat(chat.id);}catch(err){left=false;console.warn('تعذر مغادرة مجموعة غير معتمدة:',err.description||err.message);}
    await notifyAdmins(`🔐 طلب إضافة البوت إلى مجموعة «${chat.title||chat.id}» (ID: ${chat.id}).\n`+
      (left?'غادرها البوت. اضغط الموافقة ثم أضفه من جديد.':'تعذرت مغادرة المجموعة تلقائيًا؛ أزل البوت منها يدويًا ثم وافق إن رغبت.'),
      Markup.inlineKeyboard([[callbackButton('✅ الموافقة على هذه المجموعة',`group_approve:${chat.id}`)]]));
    return;
  }
  pendingGroupChats.set(chat.id, { id: chat.id, title: chat.title, at: Date.now() });
  await notifyAdmins(
    `👥 أُضيف البوت إلى مجموعة «${chat.title}».\n` +
      'اربطها بمادة من «👥 المجموعات» ← المادة ← «💬 ربط مجموعة تليجرام».'
  );
});

bot.action(/^group_approve:(-?\d+)$/,async ctx=>{
  if(!isAdmin(ctx))return ctx.answerCbQuery('غير مصرح.');
  const chatId=Number(ctx.match[1]);
  if(!Number.isSafeInteger(chatId))return ctx.answerCbQuery('معرف المجموعة غير صالح.');
  const row=(await db.pool.query(`UPDATE approved_group_chats SET approved_at=COALESCE(approved_at,now()),approved_by=COALESCE(approved_by,$2)
    WHERE chat_id=$1 RETURNING title`,[chatId,ctx.from.id])).rows[0];
  if(!row)return ctx.answerCbQuery('طلب المجموعة غير موجود.');
  await ctx.answerCbQuery('تمت الموافقة ✅');
  return ctx.reply(`✅ وافقت على مجموعة «${row.title||chatId}». أضف البوت إليها مجددًا، ثم اربطها بمجموعة المباحثة من لوحة الأستاذ.`);
});

// ---------------------------------------------------------------------------
// الطالب — درجاته المحفوظة عبر كل المواسم
// ---------------------------------------------------------------------------
async function showStudentGrades(ctx, page = 0) {
  if (ctx.chat?.type !== 'private') return;
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return ctx.reply('مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.');
  const grades = await studies.listStudentGradeOverview(student.id,{page,size:5});
  const max = studies.GRADE_WEIGHTS.participationTotal;
  const parts = [], buttons = [];
  for (const g of grades) {
    let text = `📘 ${limitButtonText(g.subject_name,65)}\n${limitButtonText(g.stage_name,65)} — ${limitButtonText(g.season_name,65)}`;
    if (Number(g.report_count) || g.mode === 'report' || Number(g.report_score) > 0) {
      text += `\n📄 التقارير المُقيَّمة: ${Number(g.graded_count)} من ${Number(g.report_count)}`;
      text += `\nمتوسط تقييمات التقارير: ${g.report_average === null ? 'لم تُقيَّم بعد' : `${Number(g.report_average)} من ${max}`}`;
      text += `\nدرجة التقارير المحفوظة: ${g.report_score === null ? 'لم تُحفظ بعد' : `${Number(g.report_score)} من ${max}`}`;
      if (Number(g.report_count)) buttons.push([callbackButton(
        limitButtonText(`📄 تقييمات تقاريري — ${g.subject_name} — ${g.season_name}`,60),
        `student_report_marks:${g.subject_id}:${g.stage_season_id}:0:${page}`)]);
    }
    if (g.finalized_at || g.edited_at) {
      text += `\n🗣️ درجة المباحثات المحسوبة: ${Number(g.mubahatha_score)} من ${max}`;
      text += `\nدرجة المشاركة المعتمدة (المباحثات والتقارير): ${Number(g.participation_score)} من ${max}`;
      text += `\nالامتحانات الشهرية: ${Number(g.exams_score)} من ${studies.GRADE_WEIGHTS.examsTotal}`;
      text += `\nالمجموع المعتمد: ${Number(g.total_score)} من ${max + studies.GRADE_WEIGHTS.examsTotal}`;
    } else {
      text += '\nلم تُعتمد درجات الموسم النهائية بعد.';
    }
    parts.push(text);
  }
  const nav = [];
  if (page > 0) nav.push(callbackButton('السابق',`student_grades:${page-1}`));
  if ((page+1)*5 < Number(grades[0]?.total_count || 0)) nav.push(callbackButton('التالي',`student_grades:${page+1}`));
  if (nav.length) buttons.push(nav);
  const text = `🎯 درجات المباحثات والتقارير — الصفحة ${page+1}\n\n` +
    (parts.length ? parts.join('\n\n') + '\n\nمتوسط التقييمات يتغيّر مع تقييم التقارير؛ درجة التقارير المحفوظة يحدّثها الأستاذ بصورة مستقلة.' : 'لا توجد سجلات في هذه الصفحة بعد.');
  return renderStudentGrades(ctx,student,text,buttons);
}

async function renderStudentGrades(ctx,student,text,buttons) {
  const extra = Markup.inlineKeyboard(buttons);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    try { return await ctx.editMessageText(text,extra); }
    catch (err) { if (String(err.description || err.message).includes('message is not modified')) return; throw err; }
  }
  return replyStudentScreen(ctx,student,text,extra);
}

// Keep old reply keyboards working after the label changes.
bot.hears(['🎯 درجات - المباحثات','🎯 درجات المباحثات والتقارير'],ctx=>showStudentGrades(ctx));
bot.action(/^student_grades:(\d{1,5})$/,ctx=>showStudentGrades(ctx,Number(ctx.match[1])));
bot.action(/^student_report_marks:(\d+):(\d+):(\d{1,5}):(\d{1,5})$/,async ctx=>{
  if (ctx.chat?.type !== 'private') return ctx.answerCbQuery('افتح درجاتك في المحادثة الخاصة.');
  const student = await effectiveStudent(ctx);
  if (!student || !stageSupportsStudies(student)) return ctx.answerCbQuery('غير متاح.');
  const [,subjectId,stageSeasonId,page,returnPage] = ctx.match.map(Number);
  // The student id always comes from the authenticated actor, never callback data.
  const [overview] = await studies.listStudentGradeOverview(student.id,{subjectId,stageSeasonId});
  if (!overview || !Number(overview.report_count)) return ctx.answerCbQuery('لا توجد تقارير لك في هذه المادة والموسم.');
  const reports = await studies.listStudentReports(student.id,subjectId,stageSeasonId,{page,size:10});
  const max = studies.GRADE_WEIGHTS.participationTotal;
  const lines = reports.map((r,i)=>{
    const stamp = new Date(r.submitted_at).toLocaleString('en-GB',{timeZone:ATTENDANCE_TIME_ZONE});
    return `${page*10+i+1}. ${stamp}\n${r.score === null ? '⏳ بانتظار تقييم الأستاذ' : `✅ التقييم: ${Number(r.score)} من ${max}`}`;
  });
  const nav = [], buttons = [];
  if (page) nav.push(callbackButton('السابق',`student_report_marks:${subjectId}:${stageSeasonId}:${page-1}:${returnPage}`));
  if ((page+1)*10 < Number(overview.report_count)) nav.push(callbackButton('التالي',`student_report_marks:${subjectId}:${stageSeasonId}:${page+1}:${returnPage}`));
  if (nav.length) buttons.push(nav);
  buttons.push([callbackButton('↩️ درجات المباحثات والتقارير',`student_grades:${returnPage}`)]);
  return renderStudentGrades(ctx,student,
    `📄 تقييمات تقاريري — ${limitButtonText(overview.subject_name,65)}\n${limitButtonText(overview.stage_name,65)} — ${limitButtonText(overview.season_name,65)}\n` +
    `الصفحة ${page+1} | أوقات التسليم: ${ATTENDANCE_TIME_ZONE}\n\n` +
    (lines.join('\n\n') || 'لا توجد تقارير في هذه الصفحة.') +
    `\n\nمتوسط التقييمات: ${overview.report_average === null ? 'لم تُقيَّم بعد' : `${Number(overview.report_average)} من ${max}`}\n` +
    `درجة التقارير المحفوظة: ${overview.report_score === null ? 'لم تُحفظ بعد' : `${Number(overview.report_score)} من ${max}`}`,buttons);
});

// ---------------------------------------------------------------------------
// الأستاذ/الأدمن — تحرير الدرجة النهائية لطالب
// ---------------------------------------------------------------------------
bot.hears('✏️ تحرير الدرجات', (ctx) =>
  pickTeacherSubject(ctx, 'gr_subj', 'اختر المادة لتحرير درجات طلبتها:')
);

async function showGradeStudents(ctx,subjectId,ssId,page=0){
  if(!await teacherOwnsSubject(ctx,subjectId,ssId))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();const students=await studies.listSubjectGrades(subjectId,ssId,{page});
  const total=Number(students[0]?.total_count||0);
  const rows=students.map(r=>[callbackButton(limitButtonText(`${r.full_name} — ${r.total_score??'بلا درجة'}`),`gr_stu:${r.student_id}:${subjectId}:${ssId}`)]);
  const nav=[];if(page>0)nav.push(callbackButton('السابق',`gr_page:${subjectId}:${ssId}:${page-1}`));
  if((page+1)*25<total)nav.push(callbackButton('التالي',`gr_page:${subjectId}:${ssId}:${page+1}`));
  if(nav.length)rows.push(nav);
  return ctx.reply(`اختر الطالب لتحرير درجته. الطلبة: ${total} | الصفحة ${page+1}`,Markup.inlineKeyboard(rows));
}
bot.action(/^gr_subj:(\d+):(\d+)$/,ctx=>showGradeStudents(ctx,Number(ctx.match[1]),Number(ctx.match[2])));
bot.action(/^gr_page:(\d+):(\d+):(\d+)$/,ctx=>showGradeStudents(ctx,Number(ctx.match[1]),Number(ctx.match[2]),Number(ctx.match[3])));

bot.action(/gr_stu:(\d+):(\d+):(\d+)/, async (ctx) => {
  const [, studentId, subjectId, ssId] = ctx.match.map(Number);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const student = await db.getStudentById(studentId);
  const rows = await studies.listSubjectGrades(subjectId, ssId,{studentId});
  const g = rows.find((r) => r.student_id === studentId) || {};
  return ctx.reply(
    `👤 ${student ? student.full_name : ''}\n` +
      `الامتحانات الشهرية: ${g.exams_score === null || g.exams_score === undefined ? 0 : Number(g.exams_score)}` +
      ` من ${studies.GRADE_WEIGHTS.examsTotal}\n` +
      `المشاركة (مباحثات/تقارير): ${
        g.participation_score === null || g.participation_score === undefined ? 0 : Number(g.participation_score)
      } من ${studies.GRADE_WEIGHTS.participationTotal}\n` +
      `المجموع: ${g.total_score === null || g.total_score === undefined ? 0 : Number(g.total_score)}\n\n` +
      'ماذا تريد تحريره؟',
    Markup.inlineKeyboard([
      [callbackButton('✏️ درجة المشاركة', `gr_edit:${studentId}:${subjectId}:${ssId}:part`)],
      [callbackButton('✏️ درجة الامتحانات', `gr_edit:${studentId}:${subjectId}:${ssId}:exam`)],
    ])
  );
});

bot.action(/gr_edit:(\d+):(\d+):(\d+):(part|exam)/, async (ctx) => {
  const studentId = Number(ctx.match[1]);
  const subjectId = Number(ctx.match[2]);
  const ssId = Number(ctx.match[3]);
  const field = ctx.match[4];
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  const max =
    field === 'part' ? studies.GRADE_WEIGHTS.participationTotal : studies.GRADE_WEIGHTS.examsTotal;
  userState.set(ctx.from.id, { action: 'grade_override', studentId, subjectId, ssId, field, max });
  await ctx.answerCbQuery();
  return ctx.reply(`أرسل الدرجة الجديدة (من 0 إلى ${max}):`);
});

// ---------------------------------------------------------------------------
// الطالب — نمط المشاركة (مباحثات أو تقارير) لكل مادة
// ---------------------------------------------------------------------------
function modeLabel(row) {
  if (!row.mode) return '⚪️ لم تختر بعد';
  if (row.mode === 'mubahatha') {
    return row.group_id ? `🟢 مباحثات — ${row.group_title}` : '🟡 مباحثات — بانتظار مجموعة';
  }
  return `📄 تقارير (${Number(row.report_count)} مُسلَّم)`;
}

async function showMyParticipation(ctx) {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return replyStudentScreen(ctx, student, withStudentName(student, 'مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.'));
  const subjects = await studies.listStudentSubjects(student.id);
  if (subjects.length === 0) {
    return replyStudentScreen(ctx, student, withStudentName(student, 'لا توجد مواد مشمولة بالمباحثات والتقارير في موسمك الحالي. تبقى دروسك متاحة من «دروس اليوم».'));
  }
  const lines = subjects.map((s) => `• ${s.subject_name}: ${modeLabel(s)}`);
  return replyStudentScreen(
    ctx, student,
    withStudentName(student, `📖 المباحثات والتقارير في ${subjects[0].stage_name}:\n${lines.join('\n')}\n\n` +
      `اختر المادة لفتح المباحثات أو إرسال التقارير:\n\n${REPORT_WEEKLY_REMINDER}`),
    Markup.inlineKeyboard(
      subjects.map((s) => [
        callbackButton(
          limitButtonText(`${s.subject_name} — ${modeLabel(s)}`, 55),
          `pm_subj:${s.subject_id}:${s.stage_season_id}`
        ),
      ])
    )
  );
}

bot.hears(['📖 المباحثات والتقارير','📖 مشاركتي'], showMyParticipation);

bot.action(/pm_subj:(\d+):(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const subjects = await studies.listStudentSubjects(student.id);
  const row = subjects.find((s) => s.subject_id === subjectId && s.stage_season_id === ssId);
  await ctx.answerCbQuery();
  if (!row) return ctx.reply('هذه المادة ليست ضمن موادك.');

  const rows = [];
  if (!row.mode) {
    rows.push([callbackButton('👥 المباحثات', `pm_set:${subjectId}:${ssId}:mubahatha`)]);
    rows.push([callbackButton('📄 التقارير', `pm_set:${subjectId}:${ssId}:report`)]);
  } else if (row.mode === 'report') {
    // التحويل متاح دائمًا من التقارير إلى المباحثات
    rows.push([callbackButton('🔁 التحويل إلى المباحثات', `pm_switch:${subjectId}:${ssId}`)]);
    rows.push([callbackButton('📄 إرسال تقرير', `rep_send:${subjectId}:${ssId}`)]);
  } else if (!row.group_id) {
    rows.push([callbackButton('👥 الدخول إلى المباحثة', `pm_join:${subjectId}:${ssId}`)]);
  } else {
    rows.push([callbackButton('🔗 رابط المباحثة', `pm_join:${subjectId}:${ssId}`)]);
  }

  const note =
    row.mode === 'report'
      ? '\n\nملاحظة: التحويل إلى المباحثات لا يحاسبك على الجلسات التي سبقت تحويلك، وتبقى درجة تقاريرك محسوبة لك.'
      : '';
  return replyStudentScreen(ctx, student, withStudentName(student, `📘 ${row.subject_name}\nنمطك الحالي: ${modeLabel(row)}${note}`), Markup.inlineKeyboard(rows));
});

bot.action(/pm_set:(\d+):(\d+):(mubahatha|report)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const mode = ctx.match[3];

  const subjects = await studies.listStudentSubjects(student.id);
  const row = subjects.find((s) => s.subject_id === subjectId && s.stage_season_id === ssId);
  if (!row) return ctx.answerCbQuery('هذه المادة ليست ضمن موادك.');
  if (row.mode) return ctx.answerCbQuery('اخترت نمطك مسبقًا لهذه المادة.');

  const savedMode=await studies.setParticipationMode(student.id, subjectId, ssId, mode);
  if(!savedMode)return ctx.answerCbQuery('تغيّرت إعدادات المادة أو سبق حفظ اختيارك. أعد فتح القائمة.');
  await ctx.answerCbQuery('تم الحفظ ✅');
  if (mode === 'report') {
    const assigned=await studies.assignStudentToGroup(student.id,subjectId,ssId);
    return ctx.editMessageText(
      `📄 اخترت نظام التقارير في «${row.subject_name}».\n` +
        (assigned.group?`تنظيم المباحثات: ${assigned.group.title}\n`:assigned.message+'\n')+
        'أرسل تقاريرك من «📖 المباحثات والتقارير» ← المادة ← «إرسال تقرير».\n' +
        'وأنت مشمول بالامتحانات الشهرية كبقية الطلبة.'
    );
  }
  await ctx.editMessageText(`👥 اخترت نظام المباحثات في «${row.subject_name}». جارٍ فتح مباحثة المادة...`);
  return joinMubahathaGroup(ctx, student, subjectId, ssId);
});

// التوزيع التلقائي: أول مجموعة فيها متسع، فإن امتلأت كلها يُنبَّه الأدمن لإنشاء مجموعة جديدة.
async function joinMubahathaGroup(ctx, student, subjectId, ssId) {
  // لا ينضم لمجموعة مادة إلا من اختار المباحثات فيها فعلًا
  const mode = await studies.getParticipationMode(student.id, subjectId, ssId);
  if (!mode || mode.mode !== 'mubahatha') {
    return ctx.reply('لست في نظام المباحثات في هذه المادة. اخترها أولًا من «📖 المباحثات والتقارير».');
  }
  const result = await studies.assignStudentToGroup(student.id, subjectId, ssId);
  if (!result.group) {
    await notifyAdmins(`⚠️ تعذر توزيع الطالب «${student.full_name}» في المادة رقم ${subjectId}، موسم المرحلة رقم ${ssId}.\n${result.message}`);
    return ctx.reply(result.message+' أُبلغت الإدارة؛ أعد المحاولة من «المباحثات والتقارير» بعد توفير المجموعة.');
  }
  const group = result.group;
  if (!group.invite_link) {
    await notifyAdmins(`⚠️ «${group.title}» بلا رابط دعوة، وطالب ينتظر الانضمام إليها.`);
    return ctx.reply(
      `تم تسجيلك في «${group.title}»، لكن رابط الدعوة غير متوفر بعد. أُبلغت الإدارة وسيصلك قريبًا.`
    );
  }
  return ctx.reply(
    `👥 مباحثة المادة: ${group.title}\n\nانضم إليها من الرابط أدناه، وستصلك تنبيهات بدء المباحثات في وقتها.`,
    Markup.inlineKeyboard([[Markup.button.url('🔗 الدخول إلى المباحثة', group.invite_link)]])
  );
}

bot.action(/pm_join:(\d+):(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  await ctx.answerCbQuery();
  return joinMubahathaGroup(ctx, student, Number(ctx.match[1]), Number(ctx.match[2]));
});

bot.action(/pm_switch:(\d+):(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  await ctx.answerCbQuery();
  return ctx.reply(
    '🔁 التحويل إلى المباحثات:\n' +
      '• لن تُحاسب على الجلسات التي عُقدت قبل تحويلك.\n' +
      '• تبقى درجة تقاريرك المُسلَّمة محسوبة لك.\n\nهل تريد المتابعة؟',
    Markup.inlineKeyboard([
      [callbackButton('✅ نعم، حوّلني', `pm_switchok:${subjectId}:${ssId}`)],
      [callbackButton('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/pm_switchok:(\d+):(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const switched = await studies.switchToMubahatha(student.id, subjectId, ssId);
  if (!switched) return ctx.answerCbQuery('لست في نظام التقارير لهذه المادة.');
  await ctx.answerCbQuery('تم التحويل ✅');
  await ctx.editMessageText('✅ تم تحويلك إلى نظام المباحثات. جارٍ فتح مباحثة المادة...');
  return joinMubahathaGroup(ctx, student, subjectId, ssId);
});

// ---------------------------------------------------------------------------
// الطالب — إرسال التقارير
// ---------------------------------------------------------------------------
bot.hears('📄 إرسال تقرير', async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return replyStudentScreen(ctx, student, withStudentName(student, 'مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.'));
  const subjects = await studies.listStudentSubjects(student.id);
  const reportSubjects = subjects.filter((s) => s.mode === 'report');
  if (reportSubjects.length === 0) {
    return replyStudentScreen(
      ctx, student, withStudentName(student, `لست في نظام التقارير في أي مادة.\nاختر نظام التقارير من «📖 المباحثات والتقارير» أولًا.\n\n${REPORT_WEEKLY_REMINDER}`)
    );
  }
  return replyStudentScreen(
    ctx, student, withStudentName(student, `اختر المادة التي تريد إرسال تقريرها:\n\n${REPORT_WEEKLY_REMINDER}`),
    Markup.inlineKeyboard(
      reportSubjects.map((s) => [
        callbackButton(
          limitButtonText(`${s.subject_name} (${Number(s.report_count)} مُسلَّم)`, 50),
          `rep_send:${s.subject_id}:${s.stage_season_id}`
        ),
      ])
    )
  );
});

bot.action(/rep_send:(\d+):(\d+)/, async (ctx) => {
  const student = await effectiveStudent(ctx);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const subjects = await studies.listStudentSubjects(student.id);
  const row = subjects.find((s) => s.subject_id === subjectId && s.stage_season_id === ssId);
  if (!row) return ctx.answerCbQuery('هذه المادة ليست ضمن موادك.');
  // يُعاد التحقق من قاعدة البيانات لا من الزر الظاهر
  if (row.mode !== 'report') {
    return ctx.answerCbQuery('لست في نظام التقارير في هذه المادة.', { show_alert: true });
  }
  userState.set(ctx.from.id, {
    action: 'student_report_upload',
    subjectId,
    ssId,
    subjectName: row.subject_name,
  });
  await ctx.answerCbQuery();
  return replyStudentScreen(
    ctx, student, withStudentName(student, `📄 أرسل الآن تقرير مادة «${row.subject_name}»:\n` +
      `يمكنك إرسال ملف (PDF أو Word) أو صورة أو نص مكتوب.\n\n${REPORT_WEEKLY_REMINDER}\nللإلغاء أرسل /start.`)
  );
});

// ---------------------------------------------------------------------------
// تغيير أستاذ المادة أثناء الموسم مع تسليم كامل للأستاذ الجديد
// ---------------------------------------------------------------------------
bot.hears('🔄 تغيير أستاذ مادة', (ctx) =>
  pickTeacherSubject(ctx, 'ch_subj', 'اختر المادة التي تريد تغيير أستاذها:')
);

bot.action(/ch_subj:(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const teachers = (await db.listTeachers()).filter((t) => t.is_active);
  await ctx.answerCbQuery();
  if (teachers.length === 0) return ctx.reply('لا يوجد أساتذة. أضف أستاذًا أولًا.');
  const current = await db.listSubjectTeachers(subjectId);
  return ctx.reply(
    `الأستاذ الحالي: ${current.length ? current.map((t) => t.full_name).join('، ') : 'لا أحد'}\n\n` +
      'اختر الأستاذ الجديد. ستنتقل إليه كل بيانات المادة، وتُرسل له التقارير غير المقيَّمة تلقائيًا:',
    Markup.inlineKeyboard(
      teachers.map((t) => [
        callbackButton(limitButtonText(t.full_name, 45), `ch_do:${subjectId}:${ssId}:${t.id}`),
      ])
    )
  );
});

bot.action(/ch_do:(\d+):(\d+):(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const [, subjectId, ssId, newTeacherId] = ctx.match.map(Number);
  await ctx.answerCbQuery('جارٍ التسليم...');

  const result = await studies.replaceSubjectTeacher(subjectId, ssId, newTeacherId);
  const teacher = await db.getTeacherById(newTeacherId);
  const subject = await db.getSubjectById(subjectId);
  const summary = await studies.getSubjectHandoverSummary(subjectId, ssId);
  const ungraded = await studies.listUngradedReports(subjectId, ssId);

  await ctx.editMessageText(
    `✅ صار «${teacher.full_name}» أستاذ مادة «${subject.name}».\n` +
      `انتقلت إليه: ${Number(summary.group_count)} مجموعة، ${Number(summary.slot_count)} موعدًا، ` +
      `${Number(summary.exam_count)} امتحانًا، و${Number(summary.student_count)} طالبًا.\n` +
      `التقارير غير المقيَّمة المُرسَلة إليه: ${ungraded.length}.`
  );

  if (!teacher.telegram_id) {
    return ctx.reply(
      `⚠️ «${teacher.full_name}» لم يفعّل حسابه بعد، فلن تصله التقارير الآن.\n` +
        'أرسل له كود التفعيل من «👨‍🏫 إدارة الأساتذة»، وستصله البيانات عند فتحه البوت.'
    );
  }

  // تسليم ملخّص المادة للأستاذ الجديد
  try {
    await bot.telegram.sendMessage(
      Number(teacher.telegram_id),
      `📋 تسلّمت مادة «${subject.name}».\n\n` +
        `الطلبة: ${Number(summary.student_count)}\n` +
        `مجموعات المباحثة: ${Number(summary.group_count)}\n` +
        `مواعيد الجدول: ${Number(summary.slot_count)}\n` +
        `الجلسات المنعقدة سابقًا: ${Number(summary.session_count)}\n` +
        `الامتحانات: ${Number(summary.exam_count)}\n` +
        `طلبة نظام التقارير: ${Number(summary.report_students)}\n\n` +
        `سيصلك الآن ${ungraded.length} تقريرًا لم تُقيَّم بعد.\n` +
        'تجد كل شيء في لوحتك: 📚 موادي | 🗓️ جدول المباحثات | 📝 الامتحانات | 🏁 إنهاء الموسم.'
    );
  } catch (err) {
    console.warn('تعذر إبلاغ الأستاذ الجديد:', err.description || err.message);
  }

  // إرسال التقارير غير المقيَّمة واحدًا تلو الآخر
  let sent = 0;
  for (const r of ungraded) {
    const caption = `📄 تقرير غير مقيَّم\nالطالب: ${r.full_name}\nالمادة: ${subject.name}\n` +
      `التاريخ: ${new Date(r.submitted_at).toISOString().slice(0, 10)}`;
    try {
      if (r.file_kind === 'document' && r.telegram_file_id) {
        await bot.telegram.sendDocument(Number(teacher.telegram_id), r.telegram_file_id, { caption });
      } else if (r.file_kind === 'photo' && r.telegram_file_id) {
        await bot.telegram.sendPhoto(Number(teacher.telegram_id), r.telegram_file_id, { caption });
      } else {
        await bot.telegram.sendMessage(Number(teacher.telegram_id), `${caption}\n\n${r.note || ''}`);
      }
      sent += 1;
    } catch (err) {
      console.warn('تعذر إرسال تقرير للأستاذ الجديد:', err.description || err.message);
    }
    await new Promise((res) => setTimeout(res, 60));
  }

  // إبلاغ الأستاذ السابق
  for (const prev of result.previous) {
    if (!prev.telegram_id || prev.teacher_id === newTeacherId) continue;
    try {
      await bot.telegram.sendMessage(
        Number(prev.telegram_id),
        `ℹ️ لم تعد مسؤولًا عن مادة «${subject.name}» في هذا الموسم. سلّمت إلى «${teacher.full_name}».`
      );
    } catch (err) {
      console.warn('تعذر إبلاغ الأستاذ السابق:', err.description || err.message);
    }
  }

  return ctx.reply(`📤 أُرسل ${sent} من ${ungraded.length} تقريرًا إلى الأستاذ الجديد.`);
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — نظرة عامة على المعهد وإدارة الاستثناءات
// ---------------------------------------------------------------------------
bot.hears('📈 لوحة المعهد', async (ctx) => {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const overview = await db.getInstituteOverview();
  const exceptions = await studies.getInstituteExceptions();

  const lines = [
    '📈 لوحة المعهد',
    '',
    `المراحل النشطة: ${Number(overview.active_stages)}`,
    `المواد: ${Number(overview.subjects)}`,
    `الطلبة النشطون: ${Number(overview.active_students)}`,
    `الأساتذة المفعّلون: ${Number(overview.linked_teachers)} من ${Number(overview.teachers)}`,
    `القنوات النشطة: ${Number(overview.active_channels)}`,
    '',
    '📚 اليوم',
    `دروس مفعّلة: ${Number(overview.lessons_today)}`,
    `تسجيلات حضور: ${Number(overview.attendance_today)}`,
    `جلسات مباحثة: ${Number(overview.sessions_today)}`,
    '',
    '⚠️ ما يحتاج تدخلك',
  ];

  const problems = [];
  if (Number(exceptions.unassigned_students) > 0) {
    problems.push(`• ${Number(exceptions.unassigned_students)} طالبًا اختاروا المباحثات ولم يُوزَّعوا على مجموعة بعد`);
  }
  if (Number(exceptions.no_mode_students) > 0) {
    problems.push(
      `• ${Number(exceptions.no_mode_students)} طالبًا لم يختاروا نمط مشاركتهم في مادة واحدة على الأقل`
    );
  }
  if (Number(exceptions.groups_without_link) > 0) {
    problems.push(`• ${Number(exceptions.groups_without_link)} مجموعة بلا رابط دعوة`);
  }
  if (Number(exceptions.subjects_without_teacher) > 0) {
    problems.push(`• ${Number(exceptions.subjects_without_teacher)} مادة بلا أستاذ مُسنَد`);
  }
  if (Number(exceptions.unlinked_teachers) > 0) {
    problems.push(`• ${Number(exceptions.unlinked_teachers)} أستاذًا لم يفعّلوا حساباتهم`);
  }
  if (Number(exceptions.pending_leaves) > 0) {
    problems.push(`• ${Number(exceptions.pending_leaves)} طلب إجازة بانتظار قرارك`);
  }
  if (Number(exceptions.draft_exams) > 0) {
    problems.push(`• ${Number(exceptions.draft_exams)} امتحانًا مسودة لم يُنشر`);
  }
  if (Number(exceptions.ungraded_reports) > 0) {
    problems.push(
      `• ${Number(exceptions.ungraded_reports)} تقريرًا لم يُقيَّم` +
        ` (لـ${Number(exceptions.ungraded_report_students)} طالبًا)`
    );
  }
  if (Number(exceptions.stages_without_channel) > 0) {
    problems.push(`• ${Number(exceptions.stages_without_channel)} مرحلة بلا قناة نشطة`);
  }
  lines.push(problems.length ? problems.join('\n') : '✅ لا توجد أمور معلّقة.');

  return ctx.reply(
    lines.join('\n'),
    Markup.inlineKeyboard([[callbackButton('📥 تقرير مفصّل بكل المراحل', 'adm_full_report')]])
  );
});

bot.action('adm_full_report', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery('جارٍ التجهيز...');
  const rows = await db.getInstituteStageBreakdown();
  if (rows.length === 0) return ctx.reply('لا توجد مراحل نشطة.');
  return sendMarkdownDoc(
    ctx,
    'تقرير_المعهد',
    buildMarkdownDoc(
      'تقرير المعهد — كل المراحل',
      ['المرحلة', 'الموسم', 'الطلبة', 'المواد', 'الدروس', 'المجموعات', 'القنوات'],
      rows.map((r) => [
        r.stage_name,
        r.season_name,
        Number(r.student_count),
        Number(r.subject_count),
        Number(r.lesson_count),
        Number(r.group_count),
        Number(r.channel_count),
      ])
    )
  );
});

bot.action(/stage_type:(lessons_only|full)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'admin_awaiting_stage_type') return ctx.answerCbQuery();
  const type = ctx.match[1];
  try {
    await db.addStage(state.stageName, type);
  } catch (err) {
    userState.delete(ctx.from.id);
    if (err.code === '23505') return ctx.answerCbQuery('هذه المرحلة موجودة مسبقًا.', { show_alert: true });
    throw err;
  }
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تمت الإضافة ✅');
  await ctx.editMessageText(
    `✅ أُضيفت «${state.stageName}» — ` +
      (type === 'lessons_only'
        ? 'حضور دروس فقط.\nلن تظهر لطلبتها المباحثات ولا التقارير ولا الامتحانات.'
        : 'مرحلة كاملة.\nتشمل المباحثات والتقارير والامتحانات الشهرية والدرجات.')
  );
  return ctx.reply('يمكنك متابعة العمل من لوحة الأدمن:', adminMainMenu());
});

// تغيير نوع مرحلة قائمة
bot.action(/admin_stage_type:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stage = await db.getStageById(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!stage) return ctx.reply('المرحلة غير موجودة.');
  const isLessonsOnly = stage.stage_type === 'lessons_only';
  return ctx.reply(
    `المرحلة: ${stage.name}\nنوعها الحالي: ${isLessonsOnly ? '📚 حضور دروس فقط' : '🎓 كاملة'}`,
    Markup.inlineKeyboard([
      [
        callbackButton(
          isLessonsOnly ? '🎓 اجعلها كاملة' : '📚 اجعلها حضور دروس فقط',
          `admin_stage_type_set:${stage.id}:${isLessonsOnly ? 'full' : 'lessons_only'}`
        ),
      ],
    ])
  );
});

bot.action(/admin_stage_type_set:(\d+):(lessons_only|full)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stage = await db.setStageType(Number(ctx.match[1]), ctx.match[2]);
  await ctx.answerCbQuery('تم التغيير ✅');
  return ctx.editMessageText(
    `✅ صارت «${stage.name}» ${ctx.match[2] === 'lessons_only' ? '📚 حضور دروس فقط' : '🎓 كاملة'}.`
  );
});

// ---------------------------------------------------------------------------
// تنظيف المحادثة تلقائيًا
// ---------------------------------------------------------------------------
// عند الضغط على أي زر من القائمة تُحذف رسائل البوت السابقة، فلا تتراكم المحادثة.
// نتتبّع معرّفات رسائل البوت لكل محادثة في الذاكرة (تليجرام لا يسمح بحذف ما مضى عليه 48 ساعة).
const botMessages = new Map(); // chatId -> [messageId]
const MAX_TRACKED = 60;

function trackBotMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  const list = botMessages.get(chatId) || [];
  list.push(messageId);
  if (list.length > MAX_TRACKED) list.splice(0, list.length - MAX_TRACKED);
  botMessages.set(chatId, list);
}

async function purgeBotMessages(ctx) {
  await studentGuide.clear(ctx);
  const chatId = ctx.chat && ctx.chat.id;
  const list = botMessages.get(chatId);
  if (!chatId || !list || list.length === 0) return;
  botMessages.delete(chatId);
  for (const id of list) {
    try {
      await ctx.telegram.deleteMessage(chatId, id);
    } catch (err) {
      // رسالة قديمة أو محذوفة مسبقًا — تُتجاوز بهدوء
    }
  }
}

// يلتقط معرّفات ما يرسله البوت ليحذفها لاحقًا
bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type === 'private') {
    for (const method of ['reply', 'replyWithDocument', 'replyWithPhoto']) {
      const original = ctx[method].bind(ctx);
      ctx[method] = async (...args) => {
        const sent = await original(...args);
        if (sent && sent.message_id) trackBotMessage(ctx.chat.id, sent.message_id);
        return sent;
      };
    }
  }
  return next();
});

// يعيد لوحة الأزرار حسب دور المستخدم، إن اختفت لأي سبب
bot.command('menu', async (ctx) => {
  if (isAdmin(ctx)) return ctx.reply('لوحة الأدمن:', adminMainMenu());
  const teacher = await effectiveTeacher(ctx);
  if (teacher) return ctx.reply('لوحة الأستاذ:', teacherMainMenu());
  const student = await effectiveStudent(ctx);
  if (student) return ctx.reply('قائمتك:', studentMainMenu(student));
  return ctx.reply('أرسل /start للبدء.');
});

// ---------------------------------------------------------------------------
// الأستاذ — روابط مجموعات المباحثة
// ---------------------------------------------------------------------------
bot.hears('🔗 روابط المجموعات', async (ctx) => {
  const subjects = await getActorSubjects(ctx);
  if (!subjects) return ctx.reply('هذه الشاشة متاحة للأساتذة والأدمن فقط.');
  if (subjects.length === 0) return ctx.reply('لا توجد مواد متاحة في الموسم الحالي.');

  const blocks = [];
  const buttons = [];
  for (const sub of subjects) {
    const groups = await studies.listGroups(sub.subject_id, sub.stage_season_id);
    if (groups.length === 0) continue;
    blocks.push(
      `📘 ${sub.subject_name} — ${sub.stage_name}\n` +
        groups
          .map(
            (g) =>
              `   ${g.title}: ${g.discussion_grouping===false?Number(g.member_count):`${Number(g.member_count)} عضو، ${Number(g.reserved_count)} محجوز`}/${g.capacity}` +
              `${g.invite_link ? '' : ' ⚠️ بلا رابط'}`
          )
          .join('\n')
    );
    for (const g of groups) {
      if (g.invite_link) {
        buttons.push([Markup.button.url(limitButtonText(`🔗 ${g.title} — ${sub.subject_name}`, 50), g.invite_link)]);
      }
    }
  }
  if (blocks.length === 0) {
    return ctx.reply('لا توجد مجموعات بعد. أنشئها من «👥 المجموعات».');
  }
  return ctx.reply(
    `روابط مجموعات المباحثة:\n\n${blocks.join('\n\n')}`,
    buttons.length ? Markup.inlineKeyboard(buttons) : undefined
  );
});

// ---------------------------------------------------------------------------
// الأستاذ — تقارير الطلبة (نظام التقارير بدل المباحثات): مراجعتها ومنح الدرجة
// ---------------------------------------------------------------------------
bot.hears('📄 تقارير الطلبة', (ctx) =>
  pickTeacherSubject(ctx, 'sr_subj', 'اختر المادة لمراجعة تقارير طلبتها ومنح الدرجات:')
);

bot.action(/^sr_subj:(\d+):(\d+)$/,async ctx=>{
  const subjectId=Number(ctx.match[1]),ssId=Number(ctx.match[2]);
  if(!await teacherOwnsSubject(ctx,subjectId,ssId))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();const groups=await studies.listGroups(subjectId,ssId);
  const rows=groups.map(g=>[callbackButton(limitButtonText(g.title),`sr_page:${subjectId}:${ssId}:${g.id}:0`)]);
  rows.push([callbackButton('كل المجموعات والسجلات القديمة',`sr_page:${subjectId}:${ssId}:0:0`)]);
  return ctx.reply('اختر المجموعة لمراجعة تقارير طلبتها بصورة مستقلة:',Markup.inlineKeyboard(rows));
});
bot.action(/^sr_page:(\d+):(\d+):(\d+):(\d+)$/,async ctx=>{
  const subjectId=Number(ctx.match[1]),ssId=Number(ctx.match[2]),groupId=Number(ctx.match[3]),page=Number(ctx.match[4]);
  if(!await teacherOwnsSubject(ctx,subjectId,ssId))return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();const students=await studies.listReportStudentsForGrading(subjectId,ssId,{groupId:groupId||null,page});
  const total=Number(students[0]?.total_count||0);
  const rows=students.map(r=>[callbackButton(limitButtonText(`${r.full_name} — ${r.report_count} تقرير`),`sr_stu:${r.student_id}:${subjectId}:${ssId}:${groupId}:0`)]);
  const nav=[];if(page>0)nav.push(callbackButton('السابق',`sr_page:${subjectId}:${ssId}:${groupId}:${page-1}`));
  if((page+1)*25<total)nav.push(callbackButton('التالي',`sr_page:${subjectId}:${ssId}:${groupId}:${page+1}`));
  if(nav.length)rows.push(nav);rows.push([callbackButton('↩️ المجموعات',`sr_subj:${subjectId}:${ssId}`)]);
  return ctx.reply(`طلبة التقارير: ${total} | الصفحة ${page+1}`,Markup.inlineKeyboard(rows));
});

bot.action(/^sr_stu:(\d+):(\d+):(\d+)(?::(\d+):(\d+))?$/, async (ctx) => {
  const [, studentId, subjectId, ssId] = ctx.match.map(Number);
  const groupId=Number(ctx.match[4]||0),page=Number(ctx.match[5]||0);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();

  const student = await db.getStudentById(studentId);
  const reports = await studies.listStudentReports(studentId, subjectId, ssId,{groupId:groupId||null,page});
  if (reports.length === 0) {
    return ctx.reply(`👤 ${student ? student.full_name : ''}\nلم يُسلّم أي تقرير بعد.`);
  }
  await ctx.reply(
    `👤 ${student ? student.full_name : ''}\nعدد التقارير: ${Number(reports[0].total_count)} | الصفحة ${page+1}\nسأرسل تقارير هذه الصفحة لمراجعتها:`
  );
  // تُرسل تقاريره ليطّلع عليها قبل وضع الدرجة
  for (const r of reports) {
    const stamp = new Date(r.submitted_at).toISOString().slice(0, 10);
    try {
      if (r.file_kind === 'document' && r.telegram_file_id) {
        await ctx.replyWithDocument(r.telegram_file_id, { caption: `📄 ${stamp}` });
      } else if (r.file_kind === 'photo' && r.telegram_file_id) {
        await ctx.replyWithPhoto(r.telegram_file_id, { caption: `📄 ${stamp}` });
      } else {
        await ctx.reply(`📄 ${stamp}\n\n${r.note || ''}`);
      }
    } catch (err) {
      console.warn('تعذر عرض تقرير:', err.description || err.message);
    }
  }
  const summary = await studies.getReportGradingSummary(studentId, subjectId, ssId);
  const rows = reports
    .map((r) => [
      callbackButton(
        `${r.score === null ? '📝' : '✅'} تقييم هذا التقرير — ${new Date(r.submitted_at)
          .toISOString()
          .slice(0, 10)}${r.score === null ? '' : ` (${Number(r.score)}/${studies.GRADE_WEIGHTS.participationTotal})`}`,
        `sr_item:${r.id}:${studentId}:${subjectId}:${ssId}`
      ),
    ]);
  rows.push([callbackButton('💬 الرد على أحدث تقرير',isAdmin(ctx)?`contact:select:admin:${studentId}:0`:`contact:select:teacher:${studentId}:${subjectId}:${reports[0].id}`)]);
  const nav=[];
  if(page>0)nav.push(callbackButton('تقارير سابقة',`sr_stu:${studentId}:${subjectId}:${ssId}:${groupId}:${page-1}`));
  if((page+1)*10<Number(reports[0].total_count))nav.push(callbackButton('تقارير تالية',`sr_stu:${studentId}:${subjectId}:${ssId}:${groupId}:${page+1}`));
  if(nav.length)rows.push(nav);
  if(Number(summary.total)>0&&Number(summary.graded)===Number(summary.total))rows.push([
    callbackButton(`✅ اعتماد درجة التقارير: ${Number(summary.average)}/${studies.GRADE_WEIGHTS.participationTotal}`,
      `sr_apply:${studentId}:${subjectId}:${ssId}`),
  ]);
  rows.push([
    callbackButton('✍️ تحديد درجة التقارير يدويًا', `sr_manual:${studentId}:${subjectId}:${ssId}`),
  ]);
  return ctx.reply(
    `تقييم تقارير «${student ? student.full_name : ''}»:\n` +
      `التقارير المُقيَّمة: ${Number(summary.graded)} من ${Number(summary.total)}` +
      `${summary.average === null ? '' : ` | متوسط التقييمات: ${Number(summary.average)} من ${studies.GRADE_WEIGHTS.participationTotal}`}\n\n` +
      'اضغط «تقييم هذا التقرير» لإعطائه درجة أو تعديل تقييمه السابق.\n' +
      `بعد تقييم التقارير كلها يظهر زر «اعتماد درجة التقارير». يحسب متوسط درجاتها من ${studies.GRADE_WEIGHTS.participationTotal} ويحفظه درجةً معتمدة لهذه المادة وهذا الموسم.\n` +
      'للاستثناءات يمكنك تحديد درجة التقارير يدويًا.',
    Markup.inlineKeyboard(rows)
  );
});

bot.action(/sr_item:(\d+):(\d+):(\d+):(\d+)/, async (ctx) => {
  const [, reportId, studentId, subjectId, ssId] = ctx.match.map(Number);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  if(!await access.reportMatches(reportId,studentId,subjectId,ssId))return ctx.answerCbQuery('التقرير لا يطابق الطالب أو المادة أو الموسم.');
  userState.set(ctx.from.id, { action: 'report_item_score', reportId, studentId, subjectId, ssId });
  await ctx.answerCbQuery();
  return ctx.reply(
    `أرسل درجة هذا التقرير (من 0 إلى ${studies.GRADE_WEIGHTS.participationTotal}):`
  );
});

bot.action(/sr_apply:(\d+):(\d+):(\d+)/, async (ctx) => {
  const [, studentId, subjectId, ssId] = ctx.match.map(Number);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  if(!await access.studentSubject(studentId,subjectId,ssId))return ctx.answerCbQuery('الطالب ليس في الموسم الحالي لهذه المادة.');
  try {
    const res = await studies.applyReportAverage(studentId, subjectId, ssId);
    await ctx.answerCbQuery('حُفظت درجة التقارير ✅');
    const student = await db.getStudentById(studentId);
    if (student && student.telegram_id) {
      try {
        await bot.telegram.sendMessage(
          Number(student.telegram_id),
          `📄 اعتُمدت درجة تقاريرك: ${res.average} من ${studies.GRADE_WEIGHTS.participationTotal}.`
        );
      } catch (err) {
        console.warn('تعذر إبلاغ الطالب بدرجة تقاريره:', err.description || err.message);
      }
    }
    return ctx.editMessageText(
      `✅ حُفظت درجة التقارير لهذه المادة وهذا الموسم: ${res.average} من ${studies.GRADE_WEIGHTS.participationTotal}.\n` +
        `احتُسبت من متوسط ${res.graded} تقريرًا مُقيَّمًا، من أصل ${res.total} تقريرًا.\n` +
        'إذا قيّمت تقارير إضافية أو عدّلت تقييمًا، اضغط زر حفظ المتوسط مجددًا لتحديث درجة التقارير.'
    );
  } catch (err) {
    return ctx.answerCbQuery(err.message, { show_alert: true });
  }
});

bot.action(/sr_manual:(\d+):(\d+):(\d+)/, async (ctx) => {
  const [, studentId, subjectId, ssId] = ctx.match.map(Number);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  const student = await db.getStudentById(studentId);
  userState.set(ctx.from.id, {
    action: 'teacher_report_score',
    subjectId,
    ssId,
    studentId,
    studentName: student ? student.full_name : '',
  });
  await ctx.answerCbQuery();
  return ctx.reply(`أرسل درجة التقارير التي تريد حفظها لهذا الطالب في هذه المادة وهذا الموسم (من 0 إلى ${studies.GRADE_WEIGHTS.participationTotal}).\nستُحفظ الدرجة التي تدخلها مباشرةً، دون حساب متوسط تقييمات التقارير:`);
});

// ---------------------------------------------------------------------------
// الأدمن — الدخول بصفة طالب أو أستاذ (وضع معاينة، بلا حفظ)
// ---------------------------------------------------------------------------
bot.hears('👁️ الدخول بصفة أخرى', async (ctx) => {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  if (isInPreview(ctx)) {
    const pv = getPreview(ctx);
    return ctx.reply(
      `أنت الآن في وضع المعاينة بصفة: ${pv.role === 'student' ? 'الطالب' : 'الأستاذ'} «${pv.name}».`,
      Markup.inlineKeyboard([[callbackButton('🚪 الخروج من المعاينة', 'pv_exit')]])
    );
  }
  return ctx.reply(
    '👁️ وضع المعاينة: تدخل بصفة طالب أو أستاذ حقيقي فترى ما يراه تمامًا، ' +
      'وأي عملية تعديل تُعرض معطّلة ولا يُحفظ شيء.\n\nبصفة من تريد الدخول؟',
    Markup.inlineKeyboard([
      [callbackButton('🎓 بصفة طالب', 'pv_pick_student')],
      [callbackButton('👨‍🏫 بصفة أستاذ', 'pv_pick_teacher')],
    ])
  );
});

bot.action('pv_pick_student', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id, { action: 'pv_search_student' });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل اسم الطالب (كليًا أو جزئيًا) للدخول بصفته:');
});

bot.action('pv_pick_teacher', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const teachers = (await db.listTeachers()).filter((t) => t.telegram_id);
  await ctx.answerCbQuery();
  if (teachers.length === 0) {
    return ctx.reply('لا يوجد أساتذة مفعّلون للدخول بصفتهم.');
  }
  return ctx.reply(
    'اختر الأستاذ للدخول بصفته:',
    Markup.inlineKeyboard(
      teachers.slice(0, 40).map((t) => [
        callbackButton(limitButtonText(t.full_name, 45), `pv_as_teacher:${t.id}`),
      ])
    )
  );
});

bot.action(/pv_as_student:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const student = await db.getStudentById(Number(ctx.match[1]));
  if (!student) return ctx.answerCbQuery('الطالب غير موجود.');
  previewMode.set(ctx.from.id, { role: 'student', id: student.id, name: student.full_name });
  await ctx.answerCbQuery('دخلت وضع المعاينة');
  await ctx.editMessageText(
    `👁️ أنت الآن تعاين بصفة الطالب «${student.full_name}».\n` +
      'كل ما تراه هو ما يراه هو، وأي تعديل معطّل. للخروج اضغط الزر أو أرسل /start.'
  );
  return ctx.reply(`قائمة الطالب «${student.full_name}» (معاينة):`, studentPreviewMenu(student));
});

bot.action(/pv_as_teacher:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const teacher = await db.getTeacherById(Number(ctx.match[1]));
  if (!teacher) return ctx.answerCbQuery('الأستاذ غير موجود.');
  previewMode.set(ctx.from.id, { role: 'teacher', id: teacher.id, name: teacher.full_name });
  await ctx.answerCbQuery('دخلت وضع المعاينة');
  await ctx.editMessageText(
    `👁️ أنت الآن تعاين بصفة الأستاذ «${teacher.full_name}».\n` +
      'كل ما تراه هو ما يراه هو، وأي تعديل معطّل. للخروج اضغط الزر أو أرسل /start.'
  );
  return ctx.reply(`لوحة الأستاذ «${teacher.full_name}» (معاينة):`, teacherPreviewMenu());
});

bot.action('pv_exit', async (ctx) => {
  previewMode.delete(ctx.from.id);
  await ctx.answerCbQuery('خرجت من المعاينة');
  await ctx.editMessageText('🚪 خرجت من وضع المعاينة، وعدت أدمن.');
  return ctx.reply('لوحة الأدمن:', adminMainMenu());
});

// قوائم المعاينة: نفس قوائم الطالب/الأستاذ مع زر خروج ظاهر دائمًا
function studentPreviewMenu(student) {
  const base = studentMainMenu(student).reply_markup.keyboard;
  return Markup.keyboard([...base, ['🚪 الخروج من المعاينة']]).resize();
}
function teacherPreviewMenu() {
  const base = teacherMainMenu().reply_markup.keyboard;
  return Markup.keyboard([...base, ['🚪 الخروج من المعاينة']]).resize();
}

bot.hears('🚪 الخروج من المعاينة', async (ctx) => {
  if (!isInPreview(ctx)) return undefined;
  previewMode.delete(ctx.from.id);
  return ctx.reply('🚪 خرجت من وضع المعاينة، وعدت أدمن.', adminMainMenu());
});

async function showLinkedChannels(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const channels = await db.listChannelsWithStage();
  await answerIfCallback(ctx);
  if (channels.length === 0) return ctx.reply('لا توجد قنوات مرتبطة بعد.');

  const lines = channels.map(
    (c) =>
      `${c.season_is_active ? '🟢' : '⚪️'} ${c.title || c.telegram_chat_id} → ${c.stage_name}` +
      (c.season_is_active ? '' : ' (متوقفة — انتهى موسمها)')
  );
  const buttons = channels.map((c) => [
    Markup.button.callback(
      `🗑️ فكّ ربط ${limitButtonText(c.title || String(c.telegram_chat_id), 40)}`,
      `admin_unlink_channel:${c.id}`
    ),
  ]);
  return ctx.reply(
    'القنوات المرتبطة:\n' +
      lines.join('\n') +
      '\n\n🟢 نشطة تُفعّل الدروس | ⚪️ متوقفة لا تُفعّل شيئًا (اربط قناة الموسم الجديد).',
    Markup.inlineKeyboard(buttons)
  );
}

bot.action('admin_list_channels', showLinkedChannels);
bot.hears('📡 القنوات المرتبطة', showLinkedChannels);

// ---------------------------------------------------------------------------
// 🩺 تشخيص مشاكل القنوات — شاشة واحدة تُظهر كل ما قد يمنع تفعيل الدروس:
// قنوات أرسلت دروسًا ولم تُفعَّل (غير مرتبطة، أو مرتبطة بموسم غير نشط)،
// وقنوات مرتبطة رسميًا لكن موسمها متوقف.
// ---------------------------------------------------------------------------
async function showChannelDiagnostics(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  await answerIfCallback(ctx);

  const [alerts, channels] = await Promise.all([
    db.listUnlinkedChannelAlerts(),
    db.listChannelsWithStage(),
  ]);
  const stale = channels.filter((c) => !c.season_is_active);

  const parts = [];

  if (alerts.length) {
    const lines = alerts.map((a) => {
      const reasonText = a.reason === 'season_inactive' ? 'مرتبطة بموسم متوقف' : 'غير مرتبطة إطلاقًا';
      const who = a.chat_title || a.telegram_chat_id;
      return (
        `⚠️ ${who} (${a.telegram_chat_id})${a.chat_username ? ` — ${a.chat_username}` : ''}\n` +
        `   السبب: ${reasonText} | منشورات لم تُفعَّل: ${a.post_count}\n` +
        `   آخر منشور: ${new Date(a.last_seen_at).toLocaleString('ar-IQ', { timeZone: ATTENDANCE_TIME_ZONE })}`
      );
    });
    parts.push(`🔴 قنوات وصلتها دروس ولم تُفعَّل (${alerts.length}):\n` + lines.join('\n\n'));
  } else {
    parts.push('🟢 لا توجد قنوات أرسلت دروسًا غير مُفعّلة مؤخرًا.');
  }

  if (stale.length) {
    const lines = stale.map((c) => `• ${c.title || c.telegram_chat_id} → ${c.stage_name} (موسمها متوقف)`);
    parts.push(`⚪️ قنوات مرتبطة رسميًا لكن موسمها غير نشط (${stale.length}):\n${lines.join('\n')}`);
  }

  parts.push(
    'الحل في الحالتين: افتح «🔗 ربط قناة بمرحلة» وحوّل أي منشور من القناة الصحيحة لربطها بموسم المرحلة الحالي.'
  );

  const buttons = alerts.map((a) => [
    Markup.button.callback(
      `🗑️ تجاهل تنبيه ${limitButtonText(a.chat_title || String(a.telegram_chat_id), 30)}`,
      `admin_dismiss_unlinked:${a.telegram_chat_id}`
    ),
  ]);
  buttons.push([Markup.button.callback('🔗 ربط قناة الآن', 'admin_link_channel')]);

  return ctx.reply(parts.join('\n\n'), Markup.inlineKeyboard(buttons));
}

bot.hears('🩺 تشخيص مشاكل القنوات', showChannelDiagnostics);

bot.action(/admin_dismiss_unlinked:(-?\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.dismissUnlinkedChannelAlert(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم التجاهل ✅');
  return showChannelDiagnostics(ctx);
});

bot.action(/admin_unlink_channel:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const channelId = Number(ctx.match[1]);
  const channel = (await db.listChannelsWithStage()).find((c) => Number(c.id) === channelId);
  if (!channel) return ctx.answerCbQuery('القناة غير موجودة أو فُكّ ربطها مسبقًا.', { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    `⚠️ تحذير\n\nهل أنت متأكد من فك ارتباط قناة «${channel.title || channel.telegram_chat_id}» عن مرحلة «${channel.stage_name}»؟\n\n` +
      'سيُلغى الربط فقط، ولن تُحذف القناة نفسها ولا الدروس أو سجلات الحضور السابقة.',
    Markup.inlineKeyboard([
      [callbackButton('✅ نعم، فك الارتباط', `admin_unlink_channel_confirm:${channelId}`)],
      [callbackButton('❌ إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action(/admin_unlink_channel_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const channelId = Number(ctx.match[1]);
  await db.unlinkChannel(channelId);
  await ctx.answerCbQuery('تم فكّ الربط ✅');
  return ctx.editMessageText('✅ تم فكّ ارتباط القناة بنجاح.\nلن تُفعّل القناة دروسًا جديدة، وبقيت البيانات السابقة محفوظة.');
});

// ---------------------------------------------------------------------------
// تسجيل منشور درس من قناة غير مفعّلة في التشخيص فقط، من دون تنبيه تليجرام للأدمن
// ---------------------------------------------------------------------------
async function reportUnlinkedChannelPost(message, chatId) {
  try {
    const status = await db.getChannelLinkStatus(chatId);
    const title = message.chat.title || String(chatId);
    const username = message.chat.username ? `@${message.chat.username}` : null;
    const reason = !status
      ? 'never_linked'
      : status.season_is_active
      ? 'unknown'
      : 'season_inactive';
    // يُحفظ التشخيص في قاعدة البيانات واللوحة التفاعلية فقط، من دون إغراق الأدمن برسائل تليجرام.
    await db.recordUnlinkedChannelPost(chatId, title, username, reason);
  } catch (err) {
    console.error('تعذر تسجيل قناة غير مرتبطة:', err.message);
  }
}

// ---------------------------------------------------------------------------
// الاستماع لمنشورات القنوات (وكذلك تعديلاتها) وتفعيل الدروس تلقائيًا
// ---------------------------------------------------------------------------
function isStandaloneLessonHashtag(message) {
  // رسالة مستقلة مثل «#الفقه» يجب أن تُعد أمر تفعيل صريحًا، لا إعلانًا نصيًا عاديًا.
  // نقبل فقط رسالة مؤلفة بالكامل من هاشتاغ/هاشتاغات ومسافات أو فواصل؛
  // حتى لا يؤدي ذكر #الفقه داخل إعلان نصي عادي إلى إنشاء درس بالخطأ.
  if (hasLessonContent(message)) return false;
  const text = String(message.caption || message.text || '').trim();
  if (!text || !extractHashtags(message).length) return false;
  return /^(?:#[\p{L}\p{N}_\u0640]+(?:[\s،,؛;]*)?)+$/u.test(text);
}

function channelPostContentKind(message, standaloneHashtag = false) {
  if (standaloneHashtag) return 'hashtag_only';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.document) {
    const mime = String(message.document.mime_type || '').toLowerCase();
    const name = String(message.document.file_name || '');
    if (mime.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma)$/i.test(name)) return 'audio_document';
    return 'document';
  }
  if (message.video || message.video_note) return 'video';
  if (extractFirstUrl(message)) return 'link';
  if (message.text || message.caption) return 'text';
  return 'other';
}

// تفعيل درس قناة مع إرسال إشعار «دروس اليوم» للطلبة فقط.
// إشعارات الأدمن الخاصة بالتفعيل/الفشل ألغيت؛ التفاصيل تبقى متاحة في اللوحة التفاعلية.
async function activateChannelLesson({
  channel,
  subject,
  sourceType,
  sourceUrl,
  chatId,
  messageId,
  notificationDate,
  activatedAt = null,
  activityMessageId = messageId,
}) {
  const activated = await db.activateLesson(
    subject.id,
    LESSON_ACTIVE_HOURS,
    sourceType,
    sourceUrl,
    chatId,
    messageId,
    activatedAt
  );
  if (!activated) throw new Error('المرحلة مؤرشفة أو لا يوجد لها موسم نشط.');

  const lesson = await db.getLessonById(activated.id);
  await db.resolvePendingChannelLessonPostBySource(
    chatId,
    messageId,
    lesson.id,
    subject.id,
    'activated'
  );

  await db.setChannelPostActivityOutcome(
    chatId,
    activityMessageId,
    sourceType === 'channel_schedule_recovered' ? 'activated_after_schedule' : 'activated',
    sourceType === 'channel_schedule_recovered'
      ? `فُعّل «${subject.name}» تلقائيًا بعد إدخال جدول اليوم — الدرس رقم ${Number(lesson.lesson_number)}.`
      : `فُعّل «${subject.name}» — الدرس رقم ${Number(lesson.lesson_number)}.`,
    { stageId: channel.stage_id, stageSeasonId: channel.stage_season_id, lessonId: lesson.id }
  );

  await notifyReturningFromLeave(channel.stage_id);
  const hasChannelLink = Boolean(channelEntryUrl(sourceUrl));
  const delivery = await sendToStageStudents(
    channel.stage_id,
    dailyLessonNotificationText(hasChannelLink),
    dailyLessonNotificationKeyboard(lesson),
    {
      skipOnLeave: true,
      dailyLessonNotificationDate: notificationDate,
      dailyLessonExpiresAt: lesson.active_until,
    }
  );
  return { lesson, delivery };
}

let pendingLessonRecoveryRunning = false;

// إذا وصلت ملفات الدرس قبل أن يضيف الأدمن جدول اليوم، نحفظها ثم نعيد مطابقتها لاحقًا.
// ننتظر قليلًا بعد آخر تعديل للجدول كي لا نطابق أول ملف مع مادة خاطئة أثناء إدخال عدة مواد متتابعة.
async function recoverPendingChannelLessonsForDate(lessonDate) {
  if (pendingLessonRecoveryRunning) return { recovered: 0 };
  pendingLessonRecoveryRunning = true;
  let recovered = 0;
  try {
    const stageSeasonIds = await db.getPendingChannelLessonStageSeasonsForDate(lessonDate);
    for (const stageSeasonId of stageSeasonIds) {
      let posts = await db.getPendingChannelLessonPosts(stageSeasonId, lessonDate);
      if (!posts.length) continue;

      // نظف أي منشور أصبح له درس بالفعل (مثلاً بعد تعديل المنشور أو تفعيل آخر متزامن).
      for (const post of posts) {
        const existing = await db.getLessonBySource(post.telegram_chat_id, post.source_message_id);
        if (!existing) continue;
        const existingLesson = await db.getLessonById(existing.id);
        await db.resolvePendingChannelLessonPost(
          post.id,
          existing.id,
          existingLesson?.subject_id || existing.subject_id,
          'duplicate'
        );
      }

      posts = await db.getPendingChannelLessonPosts(stageSeasonId, lessonDate);
      if (!posts.length) continue;

      const scheduled = await db.getPendingScheduledSubjectsForDate(stageSeasonId, lessonDate);
      if (!scheduled.length) continue;

      const state = await db.getLessonScheduleRecoveryState(stageSeasonId, lessonDate);
      const latestChangeMs = state.latest_schedule_change
        ? new Date(state.latest_schedule_change).getTime()
        : 0;
      const scheduleStable = latestChangeMs > 0 && Date.now() - latestChangeMs >= 20 * 1000;
      if (!scheduleStable) continue;

      // إذا ما زال عدد المواد المُدخلة أقل من عدد الملفات، نعطي الأدمن مهلة لإكمال الجدول.
      // بعد دقيقتين من آخر تعديل نعالج ما أمكن ونترك الباقي معلّقًا بدل أن يضيع.
      const enoughSubjects = scheduled.length >= posts.length;
      const longStable = Date.now() - latestChangeMs >= 2 * 60 * 1000;
      if (!enoughSubjects && !longStable) continue;

      const pairCount = Math.min(posts.length, scheduled.length);
      for (let i = 0; i < pairCount; i += 1) {
        const post = posts[i];
        const subject = scheduled[i];
        const channel = await db.getChannelByChatId(post.telegram_chat_id);
        if (!channel || Number(channel.stage_season_id) !== Number(stageSeasonId)) continue;

        // لا نُنشئ درسًا انتهت مهلته أصلًا؛ يبقى المنشور معلّقًا ويمكن للأدمن معالجته يدويًا.
        const receivedAt = post.received_at ? new Date(post.received_at) : null;
        if (!receivedAt || Number.isNaN(receivedAt.getTime())) continue;
        if (Date.now() - receivedAt.getTime() >= LESSON_ACTIVE_HOURS * 60 * 60 * 1000) continue;

        const result = await activateChannelLesson({
          channel,
          subject,
          sourceType: 'channel_schedule_recovered',
          sourceUrl: post.source_url || null,
          chatId: Number(post.telegram_chat_id),
          messageId: Number(post.source_message_id),
          notificationDate: lessonDate,
          activatedAt: receivedAt,
          activityMessageId: Number(post.source_message_id),
        });
        await db.resolvePendingChannelLessonPost(
          post.id,
          result.lesson.id,
          subject.id,
          'activated'
        );
        recovered += 1;
        console.log(
          `تم استرجاع درس معلق بعد إدخال الجدول: موسم ${stageSeasonId}، مادة ${subject.id}، منشور ${post.source_message_id}`
        );
      }
    }
    return { recovered };
  } finally {
    pendingLessonRecoveryRunning = false;
  }
}

async function recoverPendingChannelLessonsToday() {
  const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  try {
    return await recoverPendingChannelLessonsForDate(today);
  } catch (err) {
    console.error('تعذر مطابقة الملفات المعلقة مع جدول اليوم:', err.message);
    return { recovered: 0, error: err.message };
  }
}

async function handleChannelLesson(ctx) {
  let activityChatId = null;
  let activityMessageId = null;
  let activityStageId = null;
  let activityStageSeasonId = null;
  let activityLessonId = null;
  try {
    const message = ctx.channelPost || ctx.editedChannelPost;
    if (!message) return;
    const chatId = message.chat.id;
    const hashtags = extractHashtags(message);
    const standaloneHashtag = isStandaloneLessonHashtag(message);
    const lessonContent = hasLessonContent(message);
    const updateKind = ctx.editedChannelPost ? 'edited_channel_post' : 'channel_post';
    activityChatId = chatId;
    activityMessageId = message.message_id || null;

    // نسجل الوصول أولًا قبل أي شرط. بهذه المعلومة تستطيع اللوحة التفاعلية حسم السؤال:
    // هل تليجرام أوصل المنشور للبوت أصلًا، أم وصل وتوقف داخل منطق الربط/الهاشتاغ/الجدول؟
    await db.recordChannelPostActivity({
      chatId,
      title: message.chat.title || null,
      username: message.chat.username ? `@${message.chat.username}` : null,
      messageId: activityMessageId,
      updateKind,
      contentKind: channelPostContentKind(message, standaloneHashtag),
      hashtags,
    });

    const channel = await db.getChannelByChatId(chatId);
    if (!channel) {
      // القناة إما غير مرتبطة إطلاقًا، أو مرتبطة بموسم/مرحلة غير صالحين.
      const status = await db.getChannelLinkStatus(chatId);
      activityStageId = status?.stage_id || null;
      activityStageSeasonId = status?.stage_season_id || null;
      const outcome = status && !status.season_is_active ? 'season_inactive' : 'unlinked';
      await db.setChannelPostActivityOutcome(
        chatId,
        activityMessageId,
        outcome,
        status ? `الربط الموجود: ${status.stage_name || 'مرحلة غير معروفة'}؛ الموسم ${status.season_is_active ? 'نشط' : 'غير نشط'}.` : 'لم يُعثر على ربط لهذا Telegram Chat ID.',
        { stageId: activityStageId, stageSeasonId: activityStageSeasonId }
      );
      // نعتبر أيضًا رسالة الهاشتاغ المستقلة محاولة تفعيل درس، كي لا تضيع بصمت.
      if (lessonContent || standaloneHashtag) await reportUnlinkedChannelPost(message, chatId);
      return;
    }

    activityStageId = channel.stage_id;
    activityStageSeasonId = channel.stage_season_id;

    // سابقًا كان الشرط التالي يُسقط «#الفقه» إذا أُرسل كرسالة مستقلة لأن الرسالة
    // لا تحتوي صوتًا/فيديو/رابطًا. الآن الهاشتاغ المستقل الصريح يعمل في جميع المراحل.
    if (!lessonContent && !standaloneHashtag) {
      await db.setChannelPostActivityOutcome(
        chatId,
        activityMessageId,
        'ignored_non_lesson',
        'وصل المنشور للبوت وربط القناة سليم، لكنه ليس محتوى درس ولا رسالة هاشتاغ مستقلة.',
        { stageId: activityStageId, stageSeasonId: activityStageSeasonId }
      );
      return;
    }

    const currentDate = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
    const postLink = telegramMessageLink(message);
    const externalUrl = extractFirstUrl(message);
    // وجهة الطالب هي منشور الدرس نفسه داخل قناة مرحلته، حتى إن احتوى المنشور رابطًا خارجيًا.
    const sourceUrl = postLink || externalUrl;

    // الهاشتاغ والجدول الدراسي يعملان داخل مسار اكتشاف واحد للدرس:
    // 1) إذا وُجد هاشتاغ صحيح، فهو تعريف صريح للمادة ويأخذ الأولوية.
    // 2) إذا لم يوجد هاشتاغ، نستخدم جدول اليوم للمواد التي لم تُفعّل بعد.
    // 3) إذا كانت هناك عدة مواد في اليوم نفسه (وهو الوضع الطبيعي)، يطابق كل منشور
    //    غير مُهاشتك المادة التالية غير المُفعّلة بحسب ترتيب أعمدة الجدول.
    // 4) إذا سبق تفعيل إحدى المواد بالهاشتاغ، تُستبعد من قائمة الجدول تلقائيًا،
    //    فيستمر المنشور التالي على المادة التالية دون تعارض.
    let subject = null;
    let activationSourceType = standaloneHashtag ? 'channel_hashtag' : 'channel';

    for (const tag of hashtags) {
      subject = await db.findSubjectByHashtag(channel.stage_id, tag);
      if (subject) break;
    }

    if (!subject && hashtags.length === 0) {
      // إذا كان لهذه المرحلة ملفات أقدم معلّقة بانتظار الجدول، لا نتجاوزها بمنشور أحدث؛
      // نحافظ على ترتيب النشر ثم تعالجها عملية الاسترجاع بالتسلسل.
      const pendingBacklog = await db.getPendingChannelLessonPosts(
        channel.stage_season_id,
        currentDate
      );
      const pendingScheduled = pendingBacklog.length
        ? []
        : await db.getPendingScheduledSubjectsForDate(
            channel.stage_season_id,
            currentDate
          );
      if (pendingScheduled.length > 0) {
        // أولًا نحاول التعرف على اسم المادة إذا كان مذكورًا في عنوان/وصف المنشور
        // حتى لو لم يُستخدم هاشتاغ. وإذا لم يُذكر الاسم، نستخدم ترتيب أعمدة الجدول.
        const messageText = String(message.caption || message.text || '');
        const normalizedMessageText = normalizeHashtag(messageText);
        const namedMatch = pendingScheduled.find((item) => {
          const normalizedSubjectName = normalizeHashtag(item.name || '');
          return normalizedSubjectName.length >= 3 && normalizedMessageText.includes(normalizedSubjectName);
        });

        // ترتيب subject_id هو نفسه ترتيب المواد الظاهر في الصف العلوي من جدول الأدمن والطالب.
        subject = namedMatch || pendingScheduled[0];
        activationSourceType = 'channel_schedule';
      }
    }

    if (!subject) {
      if (hashtags.length) {
        await db.setChannelPostActivityOutcome(
          chatId,
          activityMessageId,
          'hashtag_no_match',
          `وصل المنشور، لكن الهاشتاغات (${hashtags.map((tag)=>`#${tag}`).join('، ')}) لا تطابق مواد المرحلة رقم ${channel.stage_id}.`,
          { stageId: activityStageId, stageSeasonId: activityStageSeasonId }
        );
      } else if (lessonContent) {
        // إذا نُشر الملف قبل إدخال الجدول لا نضيّعه: نحفظه بانتظار جدول هذا اليوم.
        await db.queuePendingChannelLessonPost({
          chatId,
          messageId: activityMessageId,
          stageId: channel.stage_id,
          stageSeasonId: channel.stage_season_id,
          lessonDate: currentDate,
          sourceUrl,
          contentKind: channelPostContentKind(message, standaloneHashtag),
        });
        await db.setChannelPostActivityOutcome(
          chatId,
          activityMessageId,
          'schedule_pending',
          `وصل ملف الدرس قبل توفر مادة مجدولة غير مُفعّلة في ${currentDate}؛ حُفظ وسيُعاد فحصه تلقائيًا بعد إدخال الجدول.`,
          { stageId: activityStageId, stageSeasonId: activityStageSeasonId }
        );
      } else {
        await db.setChannelPostActivityOutcome(
          chatId,
          activityMessageId,
          'no_subject',
          'وصل المنشور للبوت لكن تعذر تحديد مادة له.',
          { stageId: activityStageId, stageSeasonId: activityStageSeasonId }
        );
      }
      return;
    }

    // التعديل المتكرر لنفس منشور القناة لا ينشئ درسًا جديدًا ولا يكرر الإشعار.
    const existing = await db.getLessonBySource(chatId, message.message_id);
    if (existing) {
      activityLessonId = existing.id;
      const existingLesson = await db.getLessonById(existing.id);
      await db.resolvePendingChannelLessonPostBySource(
        chatId,
        message.message_id,
        existing.id,
        existingLesson?.subject_id || existing.subject_id,
        'duplicate'
      );
      await db.setChannelPostActivityOutcome(
        chatId,
        activityMessageId,
        'duplicate_post',
        `هذا المنشور سبق أن فعّل الدرس #${existing.id}؛ لم يُنشأ درس مكرر.`,
        { stageId: activityStageId, stageSeasonId: activityStageSeasonId, lessonId: activityLessonId }
      );
      return;
    }

    const result = await activateChannelLesson({
      channel,
      subject,
      sourceType: activationSourceType,
      sourceUrl,
      chatId,
      messageId: message.message_id,
      notificationDate: currentDate,
      activityMessageId,
    });
    activityLessonId = result.lesson.id;
  } catch (err) {
    if (activityChatId != null) {
      try {
        await db.setChannelPostActivityOutcome(
          activityChatId,
          activityMessageId,
          activityLessonId ? 'activated_notification_error' : 'processing_error',
          String(err.message || 'خطأ غير معروف').slice(0, 500),
          { stageId: activityStageId, stageSeasonId: activityStageSeasonId, lessonId: activityLessonId }
        );
      } catch (diagErr) {
        console.error('تعذر تحديث تشخيص منشور القناة:', diagErr.message);
      }
    }
    console.error('خطأ أثناء معالجة منشور القناة:', err);
    // الخطأ مسجل في تشخيص القنوات داخل اللوحة التفاعلية؛ لا نرسله للأدمن على تليجرام.
  }
}

bot.on('channel_post', handleChannelLesson);
bot.on('edited_channel_post', handleChannelLesson);

// ---------------------------------------------------------------------------
// تذكير تلقائي للطلبة الذين لم يسجلوا حضورًا قبل انتهاء المهلة
// ---------------------------------------------------------------------------
let reminderCheckRunning = false;

async function checkReminders() {
  if(reminderCheckRunning)return;reminderCheckRunning=true;
  try{
    for(const lesson of await db.getLessonsNeedingReminder()){
      const c=await db.pool.connect();
      try{
        await c.query('BEGIN');
        const text=`⏰ لم تسجّل حضور الدرس ${lesson.lesson_number} من «${lesson.subject_name}». تأكد من الاستماع والتأشير قبل انتهاء المهلة.`;
        await c.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,expires_at)
          SELECT 'lesson-reminder:'||l.id::text||':'||st.id::text,st.telegram_id,$2::jsonb,l.active_until
          FROM lessons l JOIN enrollments e ON e.stage_season_id=l.stage_season_id AND e.status='active'
          JOIN students st ON st.id=e.student_id AND st.is_active=true
          JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
          WHERE l.id=$1 AND l.activated_at>=e.started_at AND l.active_until>now()
            AND NOT EXISTS(SELECT 1 FROM attendance a WHERE a.student_id=st.id AND a.lesson_id=l.id)
            AND NOT EXISTS(SELECT 1 FROM student_leaves sl WHERE sl.student_id=st.id AND sl.stage_season_id=e.stage_season_id
              AND sl.status='approved' AND $3::date BETWEEN sl.start_date AND sl.end_date)
          ON CONFLICT(dedupe_key) DO NOTHING`,[lesson.id,JSON.stringify([text,Markup.inlineKeyboard([[callbackButton('أضغط لتسجيل الحضور',`attend:${lesson.id}`)]])]),currentDateInTimeZone(ATTENDANCE_TIME_ZONE)]);
        await c.query('UPDATE lessons SET reminder_sent=true WHERE id=$1',[lesson.id]);
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }
  }catch(e){console.error('تعذر تجهيز تذكيرات الحضور:',e.message);}finally{reminderCheckRunning=false;}
}

let absenceCheckRunning = false;

async function checkConsecutiveAbsence() {
  if(absenceCheckRunning)return;absenceCheckRunning=true;
  try{
    await db.processCompletedAttendanceDays(ATTENDANCE_TIME_ZONE);
    const {enqueueNotification}=require('./outbox');
    for(const student of await db.getStudentAbsenceAlertCandidates()){
      await enqueueNotification(db.pool,{key:`absence:student:${student.attendance_day_id}`,chatId:student.telegram_id,
        text:'⚠️ تنبيه غياب\nلم تسجّل أي حضور ضمن مهلة الدروس لثلاثة أيام دراسية متتالية '+
          `(${dateOnly(student.streak_start_date)} → ${dateOnly(student.streak_end_date)}).\nيرجى متابعة دروسك وتأشير الحضور بعد الاستماع الفعلي.`,
        mark:{kind:'student_absence',id:student.attendance_day_id}});
    }
    const candidates=await db.getAdminAbsenceAlertCandidates();
    if(ADMIN_IDS.length)for(const message of buildAdminAbsenceMessages(candidates)){
      const c=await db.pool.connect();
      try{
        await c.query('BEGIN');
        for(const adminId of ADMIN_IDS)await enqueueNotification(c,{key:`absence:admin:${adminId}:${message.attendanceDayIds.join('-')}`,chatId:adminId,
          text:message.text,mark:{kind:'admin_absence',ids:message.attendanceDayIds}});
        await c.query('UPDATE student_attendance_days SET admin_alert_queued_at=now() WHERE id=ANY($1::bigint[])',[message.attendanceDayIds]);
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    }
  }catch(e){console.error('تعذر تجهيز تنبيهات الغياب:',e.message);}finally{absenceCheckRunning=false;}
}

// ---------------------------------------------------------------------------
// تشغيل البوت
// ---------------------------------------------------------------------------
bot.catch(async (err, ctx) => {
  console.error(`خطأ غير معالج في التحديث ${ctx.update.update_id}:`, err);
  try {
    if (ctx.chat && ctx.chat.type === 'private') {
      await ctx.reply('حدث خطأ غير متوقع. حاول مرة أخرى، وإذا تكرر الخطأ أبلغ الأدمن.');
    }
  } catch (_) {
    // فشل الرد نفسه لا يجب أن يوقف البوت.
  }
});

async function main() {
  await db.initSchema();
  await studies.initStudiesSchema();
  await initIntegritySchema(db.pool);
  await instituteLinks.initSchema();
  await initBackupSchema(db.pool);
  await initStudentGuideSchema(db.pool);
  backups.start();
  console.log('تم تجهيز قاعدة البيانات ✅');
  if(process.env.ADMIN_WEB_ENABLED==='true') {
    adminServer=await require('./adminServer').startAdminServer({db,studies,adminData,scheduler,botToken:BOT_TOKEN,adminIds:ADMIN_IDS});
  }

  // مراجع المؤقتات لإيقافها عند الإغلاق المنظم
  timers.push(setInterval(checkReminders, 10 * 60 * 1000));
  timers.push(setInterval(checkConsecutiveAbsence, 10 * 60 * 1000));
  timers.push(setInterval(()=>runScheduleTick().catch(err=>console.error('Schedule failed:',err.message)), 30 * 1000));
  // إعادة فحص الملفات التي وصلت قبل إدخال جدول اليوم.
  timers.push(setInterval(()=>recoverPendingChannelLessonsToday(), 15 * 1000));
  // تنظيف الذاكرة كل خمس دقائق: حالات إدخال منتهية، وسجلات مجموعات قديمة
  timers.push(setInterval(cleanupMemory, 5 * 60 * 1000));
  const tick=()=>runScheduleTick().catch(err=>console.error('Schedule failed:',err.message));
  // launch() long-polling does not resolve until shutdown: timers MUST precede it.
  timers.push(setInterval(()=>outboxWorker.tick().catch(err=>console.error('Outbox failed:',err.message)),1000));
  tick();
  checkReminders();
  checkConsecutiveAbsence();
  recoverPendingChannelLessonsToday();
  await launchBotWithRetry();
}

// خطأ 409 من تليجرام يعني أن نسخة أخرى من البوت (بنفس التوكن) لا تزال تستقبل getUpdates —
// غالبًا نسخة سابقة لم تُغلق بعد أثناء إعادة نشر Railway. بدل إسقاط الحاوية فورًا (ما يسبب
// حلقة تعطّل متكررة قد تُطيل التعارض)، نعيد المحاولة بمهلة متصاعدة فقط لهذا الخطأ تحديدًا.
// أي خطأ آخر، أو استمرار 409 بعد كل المحاولات، يُرمى كما هو فيوقف العملية كالسابق.
async function launchBotWithRetry(maxAttempts = 6) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.launch({}, () => console.log('البوت يعمل الآن ✅'));
      return; // launch() لا يُحلّ الوعد إلا عند الإغلاق المنظم (bot.stop) — لا نصل هنا إلا حينها
    } catch (err) {
      const isConflict = err?.response?.error_code === 409;
      if (!isConflict || attempt === maxAttempts) throw err;
      const waitMs = Math.min(5000 * attempt, 30000);
      console.warn(`تعارض getUpdates (409): نسخة سابقة من البوت لا تزال تعمل على الأرجح. إعادة المحاولة خلال ${waitMs / 1000} ثانية (محاولة ${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// تنظيف الخرائط في الذاكرة كي لا تنمو بلا حدّ مع كثرة المستخدمين
function cleanupMemory() {
  const now = Date.now();
  let cleaned = 0;
  for (const [userId, state] of userState.entries()) {
    if (state && state.expiresAt && state.expiresAt < now) {
      userState.delete(userId);
      cleaned += 1;
    }
  }
  // المجموعات المُلتقطة التي مضى على إضافتها أكثر من 24 ساعة
  for (const [chatId, info] of pendingGroupChats.entries()) {
    if (info && info.at && now - info.at > 24 * 60 * 60 * 1000) {
      pendingGroupChats.delete(chatId);
    }
  }
  if (cleaned > 0) console.log(`تنظيف الذاكرة: أُزيلت ${cleaned} حالة إدخال منتهية.`);
}

// إغلاق منظم: يوقف المؤقتات والاستقبال ثم يغلق قاعدة البيانات، فلا تُفقد البيانات
async function gracefulShutdown(signal) {
  console.log(`استلام ${signal}: إغلاق منظم...`);
  for (const t of timers) clearInterval(t);
  outboxWorker.stop();
  await backups.stop();
  tgQueue.stop();
  if(adminServer) await new Promise(resolve=>adminServer.close(resolve));
  try {
    bot.stop(signal);
  } catch (err) {
    /* قد يكون متوقفًا */
  }
  try {
    await db.pool.end();
  } catch (err) {
    console.warn('تعذر إغلاق مجمع الاتصالات:', err.message);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('فشل تشغيل البوت:', err);
    process.exit(1);
  });

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  // لا تُسقط العملية على خطأ غير ملتقط؛ سجّله وواصل العمل
  process.on('unhandledRejection', (err) => {
    console.error('وعد مرفوض غير معالَج:', err && err.message ? err.message : err);
  });
}

module.exports = {
  bot,
  previewMode,
  isInPreview,
  effectiveStudent,
  effectiveTeacher,
  buildStageSeasonMd,
  buildStudentReportMd,
  buildMarkdownTable,
  formatStudentReport,
  groupStudentReport,
  parseLeaveDays,
  currentDateInTimeZone,
  studentScheduleWindow,
  buildAdminAbsenceMessages,
  lessonKeyboard,
  singleLessonKeyboard,
  channelEntryUrl,
  dailyLessonNotificationKeyboard,
  dailyLessonNotificationText,
  sendToStageStudents,
  formatStudentSeasonActivity,
  formatAdminStudentDetails,
  buttonStyle,
  studentUiMessageKind,
};
