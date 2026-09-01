// index.js — بوت تسجيل حضور الطلبة عبر تليجرام
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const studies = require('./studies');
const {
  extractFirstUrl,
  extractHashtags,
  formatSeasonLabel,
  hasLessonContent,
  looksLikeLessonMedia,
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

// حالة مؤقتة في الذاكرة لكل مستخدم لإدارة خطوات الإدخال المتعددة (تسجيل، إضافة، تعديل...)
// يعمل بشكل صحيح طالما البوت يعمل على نسخة تشغيل واحدة (الوضع الافتراضي على Railway)
const userState = new Map();

const BACK_BUTTON = '↩️ رجوع';
const STUDENT_ACTIVITY_BUTTON = '📋 المتغيرات';
const LEGACY_STUDENT_ACTIVITY_BUTTON = '📋 إجازاتي وإنذاراتي';
const LEGACY_STUDENT_ACTIVITY_BUTTON_2 = '📋 إجازاتي وتنبيهاتي';
const STUDENT_MENU_BUTTONS = new Set([
  '📚 دروس اليوم',
  '📊 تقريري',
  '🌴 طلب إجازة',
  '🗓️ جدول المباحثات',
  '📝 الامتحانات الشهرية',
  '🎯 درجاتي',
  '📖 مشاركتي',
  '📄 إرسال تقرير',
  STUDENT_ACTIVITY_BUTTON,
  LEGACY_STUDENT_ACTIVITY_BUTTON,
  LEGACY_STUDENT_ACTIVITY_BUTTON_2,
]);

// أزرار لوحة الأستاذ — تُعامل كأزرار قوائم فلا تُفسَّر كإدخال نصي
const TEACHER_MENU_BUTTONS = new Set([
  '📚 موادي', '📊 حضور موادي', '👥 المجموعات',
  '🗓️ جدول المباحثات', '📝 الامتحانات', '🏁 إنهاء الموسم', '✏️ تحرير الدرجات',
]);

const ADMIN_MENU_BUTTONS = new Set([
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
]);

const isAdmin = (ctx) => ADMIN_IDS.includes(ctx.from.id);

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
    [replyButton('📚 دروس اليوم'), replyButton('📊 تقريري')],
    [replyButton('🌴 طلب إجازة'), replyButton(STUDENT_ACTIVITY_BUTTON)],
  ];
  if (!lessonsOnly) {
    rows.push([replyButton('🗓️ جدول المباحثات'), replyButton('📝 الامتحانات الشهرية')]);
    rows.push([replyButton('🎯 درجاتي'), replyButton('📖 مشاركتي')]);
    rows.push([replyButton('📄 إرسال تقرير')]);
  }
  rows.push([replyButton(BACK_BUTTON)]);
  return Markup.keyboard(rows).resize().persistent();
}

// حارس مشترك: يمنع ميزات المباحثات في مرحلة «حضور دروس فقط»
function stageSupportsStudies(student) {
  return !student || student.stage_type !== 'lessons_only';
}

function backOnlyMenu() {
  return Markup.keyboard([[replyButton(BACK_BUTTON)]]).resize().persistent();
}

function officialConfirmationKeyboard() {
  return Markup.inlineKeyboard([
    [callbackButton('✅ أؤكد أنني مسجّل بصفة طالب رسمي', 'confirm_official_student')],
  ]);
}

async function sendOfficialConfirmationPrompt(ctx) {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
    [replyButton('✏️ تحرير الدرجات')],
  ]).resize().persistent();
}

function adminMainMenu() {
  const rows = [
    ['➕ إضافة مرحلة دراسية', '➕ إضافة مادة'],
    ['🟢 تفعيل درس يدويًا', '📊 تقرير الحضور'],
    ['🎓 إدارة الطلبة', '🔗 ربط قناة بمرحلة'],
    ['📡 القنوات المرتبطة', '🏷️ المواد والهاشتاغات'],
    ['⚙️ إدارة المراحل', '🗓️ بدء موسم جديد'],
    ['🗂️ أرشيف المواسم', '🌴 طلبات الإجازة'],
    ['👨‍🏫 إدارة الأساتذة', '🔄 تغيير أستاذ مادة'],
    ['📈 لوحة المعهد'],
    ['👥 المجموعات', '🗓️ جدول المباحثات'],
    ['📝 الامتحانات', '🏁 إنهاء الموسم'],
    ['✏️ تحرير الدرجات'],
    [BACK_BUTTON, '❌ إلغاء العملية'],
  ];
  return Markup.keyboard(rows.map((row) => row.map((text) => replyButton(text)))).resize().persistent();
}

function studentActionsKeyboard(studentId, isActive = true) {
  const rows = [
    [callbackButton('✏️ تعديل الاسم', `stu_edit_name:${studentId}`)],
    [callbackButton('🔁 تغيير المرحلة', `stu_edit_stage:${studentId}`)],
    [callbackButton('📊 تقرير كل المواسم', `stu_report:${studentId}`)],
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
  } = options;
  const students = await db.getStudentsByStage(stageId);
  const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  let delivered = 0;
  let skippedOnLeave = 0;
  let alreadyNotifiedToday = 0;
  for (const st of students) {
    if (excludeStudentIds.has(st.id)) continue;
    // أثناء الإجازة: لا تصل إشعارات الدروس للطالب المجاز في هذا اليوم.
    if (skipOnLeave && (await db.isStudentOnLeave(st.id, today))) {
      skippedOnLeave += 1;
      continue;
    }
    let dailyNotificationClaimed = false;
    if (dailyLessonNotificationDate) {
      dailyNotificationClaimed = await db.claimDailyLessonNotification(
        st.id,
        stageId,
        dailyLessonNotificationDate
      );
      if (!dailyNotificationClaimed) {
        alreadyNotifiedToday += 1;
        continue;
      }
    }
    try {
      await bot.telegram.sendMessage(st.telegram_id, text, extra);
      delivered += 1;
    } catch (err) {
      console.warn(`تعذر إرسال إشعار للطالب ${st.id}:`, err.description || err.message);
      if (dailyNotificationClaimed) {
        try {
          await db.releaseDailyLessonNotification(st.id, stageId, dailyLessonNotificationDate);
        } catch (releaseError) {
          console.warn(`تعذر تحرير حجز التنبيه اليومي للطالب ${st.id}:`, releaseError.message);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 40)); // احترام حدود تليجرام لعدد الرسائل بالثانية
  }
  return { delivered, total: students.length, skippedOnLeave, alreadyNotifiedToday };
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
  const messageKind = studentUiMessageKind(extra);
  if (options.clear !== false) {
    await beginStudentScreen(ctx, student, { includeMenu: messageKind === 'menu' });
  }
  const message = await ctx.reply(text, extra);
  return trackStudentUiMessage(student, message, messageKind);
}

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
        limitButtonText(`✅ تأشير تم الاستماع — ${title}`),
        `attend:${lesson.lesson_id}`,
        'success'
      ),
    ]);
  }
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const transition = await db.getPendingTransition(student.id);
  if (transition) {
    return showTransitionPrompt(ctx);
  }

  const lessons = await db.getActiveLessonsForStudent(student.stage_id, student.id);
  if (lessons.length === 0) {
    return replyStudentScreen(
      ctx,
      student,
      options.confirmation
        ? `${options.confirmation}\n\nلا توجد دروس أخرى غير مؤشَّرة حاليًا لمرحلتك.`
        : 'لا توجد دروس غير مؤشَّرة حاليًا لمرحلتك. تحقق لاحقًا.',
      studentMainMenu()
    );
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

// يبني جدول Markdown من ترويسة وصفوف. اخترنا md بدل csv لأنه يُقرأ مباشرة
// على الهاتف وفي تليجرام دون برنامج جداول، ويحافظ على اتجاه النص العربي.
function mdCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')   // الشرطة العمودية تكسر أعمدة الجدول
    .replace(/\r?\n/g, ' ');
}

function buildMarkdownTable(header, rows) {
  const head = `| ${header.map(mdCell).join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

// يُنشئ مستند Markdown بعنوان وسطر تاريخ ثم جدول
function buildMarkdownDoc(title, header, rows, note = '') {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return (
    `# ${title}\n\n` +
    `_تاريخ التوليد: ${stamp}_\n\n` +
    (note ? `${note}\n\n` : '') +
    buildMarkdownTable(header, rows) +
    '\n'
  );
}

function sendMarkdownDoc(ctx, filename, content) {
  return ctx.replyWithDocument({
    source: Buffer.from(content, 'utf-8'),
    filename: `${filename}.md`,
  });
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
  const note = `**الموسم:** ${formatSeasonLabel(rows[0])}`;
  return buildMarkdownDoc(title, header, body, note);
}

async function sendStudentReportMessages(ctx, studentId, stageSeasonId = null, options = {}) {
  const rows = await db.getStudentSeasonReport(studentId, stageSeasonId, ATTENDANCE_TIME_ZONE);
  const student = options.cleanUi === false ? null : options.student || (await db.getStudentById(studentId));
  if (student) await beginStudentScreen(ctx, student);
  for (const text of formatStudentReport(rows)) {
    const message = await ctx.reply(text);
    if (student) await trackStudentUiMessage(student, message);
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const transition = await db.getPendingTransition(student.id);
  if (!transition) {
    return replyStudentScreen(
      ctx,
      student,
      'لا يوجد اختيار موسم جديد مطلوب منك حاليًا.',
      studentMainMenu()
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
bot.start(async (ctx) => {
  userState.delete(ctx.from.id);
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (student) {
    if (!student.is_active) {
      return ctx.reply('حسابك مؤرشف حاليًا. تواصل مع الأدمن إذا كنت تريد العودة للدراسة.');
    }
    if (!student.official_confirmed_at) return sendOfficialConfirmationPrompt(ctx);
    await replyStudentScreen(ctx, student, `أهلًا بعودتك ${student.full_name} 👋`, studentMainMenu());
    const transition = await db.getPendingTransition(student.id);
    if (transition) return showTransitionPrompt(ctx);
    return undefined;
  }
  // الأستاذ المرتبط يرى لوحته مباشرة، ولا يمر بتسجيل الطلبة
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
  if (teacher) {
    return ctx.reply(`أهلًا بك أستاذ ${teacher.full_name} 👋`, teacherMainMenu());
  }

  userState.set(ctx.from.id, { action: 'awaiting_full_name' });
  return ctx.reply(
    'أهلًا بك 👋\nالرجاء إدخال اسمك الرباعي الكامل.\n\n' +
      'إن كنت أستاذًا فأرسل كود التفعيل الذي زوّدك به المعهد بدل الاسم.\n' +
      'وإن كنت طالبًا مسجَّلًا سابقًا وغيّرت هاتفك أو حساب تليجرام، فاطلب من الإدارة كود نقل الحساب وأرسله هنا.',
    backOnlyMenu()
  );
});

bot.command('teacher', async (ctx) => {
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
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

bot.on('text', requireOfficialConfirmation);
bot.on('callback_query', requireOfficialConfirmation);

bot.action('confirm_official_student', async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
  return replyStudentScreen(ctx, student, `أهلًا بك ${student.full_name} 👋`, studentMainMenu());
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
    `التاريخ: ${new Date().toISOString().slice(0, 10)}`;

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

  // إن لم يكن للمادة أستاذ مرتبط بحساب، يُبلَّغ الأدمن حتى لا يضيع التقرير
  if (recipients.length === 0) {
    await notifyAdmins(
      `⚠️ وصل تقرير من «${student.full_name}» في مادة «${subjectName}»، ` +
        'لكن لا يوجد أستاذ مرتبط بحساب تليجرام لهذه المادة. التقرير محفوظ في النظام.'
    );
  }
  return { delivered, total: recipients.length };
}

// استقبال ملف التقرير (مستند أو صورة) عندما يكون الطالب في خطوة الإرسال
bot.on(['document', 'photo'], async (ctx, next) => {
  const state = userState.get(ctx.from.id);
  if (!state || state.action !== 'student_report_upload') return next();
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) {
    userState.delete(ctx.from.id);
    return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  }
  const msg = ctx.message;
  const fileId = msg.document
    ? msg.document.file_id
    : msg.photo[msg.photo.length - 1].file_id; // أعلى دقة متاحة
  const kind = msg.document ? 'document' : 'photo';
  await studies.submitReport(student.id, state.subjectId, state.ssId, {
    fileId,
    kind,
    note: msg.caption || null,
  });
  const sent = await deliverReportToTeachers(student, state.subjectId, state.subjectName, {
    kind,
    fileId,
    note: msg.caption || null,
  });
  userState.delete(ctx.from.id);
  return ctx.reply(
    `✅ استُلم تقرير مادة «${state.subjectName}».` +
      (sent.delivered > 0 ? '\nوصل إلى الأستاذ.' : '\nمحفوظ في النظام وسيطّلع عليه الأستاذ.'),
    studentMainMenu()
  );
});

bot.on('text', async (ctx, next) => {
  const inputText = ctx.message.text.trim();

  if (inputText === BACK_BUTTON) {
    const hadStep = userState.delete(ctx.from.id);
    if (isAdmin(ctx)) {
      return ctx.reply(hadStep ? 'تم الرجوع عن الخطوة الحالية.' : 'أنت في القائمة الرئيسية.', adminMainMenu());
    }
    const student = await db.getStudentByTelegramId(ctx.from.id);
    if (!student) return ctx.reply('تم الرجوع. أرسل /start لبدء التسجيل من جديد.');
    return replyStudentScreen(
      ctx,
      student,
      hadStep ? 'تم الرجوع عن الخطوة الحالية.' : 'أنت في القائمة الرئيسية.',
      studentMainMenu()
    );
  }

  if (inputText === '❌ إلغاء العملية' && isAdmin(ctx)) {
    userState.delete(ctx.from.id);
    return ctx.reply('تم إلغاء العملية الحالية.', adminMainMenu());
  }

  // الضغط على زر رئيسي يجب أن يلغي أي إدخال قديم، لا أن يُسجَّل كاسم مرحلة أو مادة.
  if (
    ADMIN_MENU_BUTTONS.has(inputText) ||
    STUDENT_MENU_BUTTONS.has(inputText) ||
    TEACHER_MENU_BUTTONS.has(inputText)
  ) {
    userState.delete(ctx.from.id);
    return next();
  }

  const state = userState.get(ctx.from.id);
  if (!state) return next();

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
            studentMainMenu()
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
      // ليس كود تفعيل صالحًا — يُكمل كاسم عادي
    }

    if (fullName.split(/\s+/).length < 4) {
      return ctx.reply('الرجاء إدخال الاسم الرباعي كاملًا (أربعة أسماء على الأقل).', backOnlyMenu());
    }
    const stages = await db.listStages();
    if (stages.length === 0) {
      userState.delete(ctx.from.id);
      return ctx.reply('لم يتم إضافة أي مرحلة دراسية بعد من قبل الأدمن. حاول لاحقًا.');
    }
    userState.set(ctx.from.id, { action: 'awaiting_stage_choice', fullName });
    return ctx.reply('اختر مرحلتك الدراسية:', stagesKeyboard(stages, 'reg_stage'));
  }

  // -------- طلب إجازة: إدخال عدد الأيام --------
  if (state.action === 'leave_awaiting_days') {
    const days = parseLeaveDays(ctx.message.text);
    if (days === null) {
      const student = await db.getStudentByTelegramId(ctx.from.id);
      if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
      return replyStudentScreen(
        ctx,
        student,
        `أرسل عدد أيام الإجازة فقط، مثال: 1 أو ١. يجب أن يكون العدد بين 1 و${MAX_LEAVE_DAYS_PER_SEASON}.\n` +
          `للرجوع اضغط «${BACK_BUTTON}».`,
        studentMainMenu()
      );
    }
    const student = await db.getStudentByTelegramId(ctx.from.id);
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
        studentMainMenu()
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
      return replyStudentScreen(ctx, student, `تعذّر تسجيل الإجازة: ${err.message}`, studentMainMenu());
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
        title: `الامتحان الشهري ${state.number}`,
        dateIso: state.dateIso,
        hours,
      });
      await ctx.reply(
        `✅ أُنشئ الامتحان الشهري ${state.number} كمسودة.\n` +
          `يفتح ${state.dateIso} ويبقى متاحًا ${hours} ساعة.\n` +
          'أضف الأسئلة ثم انشره ليصل الطلبة.',
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
      // إشعار الطلبة بالموعد الجديد
      const students = await studies.listSeasonStudents(exam.stage_season_id);
      let sent = 0;
      for (const st of students) {
        try {
          await bot.telegram.sendMessage(
            Number(st.telegram_id),
            `🕓 أُجِّل امتحان «${exam.subject_name}» — ` +
              `${updated.title || 'الامتحان الشهري ' + updated.exam_number}\n` +
              `الموعد الجديد: ${state.dateIso}\nمدة الإتاحة: ${hours} ساعة`
          );
          sent += 1;
        } catch (err) {
          console.warn('تعذر إشعار طالب بتأجيل الامتحان:', err.description || err.message);
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      return ctx.reply(`📤 أُبلغ ${sent} من ${students.length} طالبًا بالموعد الجديد.`);
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
    const student = await db.getStudentByTelegramId(ctx.from.id);
    if (!student) {
      userState.delete(ctx.from.id);
      return ctx.reply('الرجاء التسجيل أولًا عبر /start');
    }
    const text = ctx.message.text.trim();
    if (text.length < 10) {
      return ctx.reply('التقرير النصي قصير جدًا. أرسل نصًا أوفى أو أرسل ملفًا.');
    }
    await studies.submitReport(student.id, state.subjectId, state.ssId, {
      fileId: null,
      kind: 'text',
      note: text,
    });
    const sent = await deliverReportToTeachers(student, state.subjectId, state.subjectName, {
      kind: 'text',
      fileId: null,
      note: text,
    });
    userState.delete(ctx.from.id);
    return ctx.reply(
      `✅ استُلم تقرير مادة «${state.subjectName}».` +
        (sent.delivered > 0 ? '\nوصل إلى الأستاذ.' : '\nمحفوظ في النظام وسيطّلع عليه الأستاذ.'),
      studentMainMenu()
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

  if (!isAdmin(ctx)) return next(); // كل الحالات التالية خاصة بالأدمن فقط

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
    const results = await db.searchStudents(q, 10);
    userState.delete(ctx.from.id);
    if (results.length === 0) return ctx.reply('لا توجد نتائج مطابقة.', adminMainMenu());
    const rows = results.map((s) => [
      callbackButton(
        limitButtonText(`${s.is_active ? '' : '🗄️ '}${s.full_name} — ${s.stage_name}`),
        `stu_select:${s.id}`
      ),
    ]);
    return ctx.reply('نتائج البحث:', Markup.inlineKeyboard(rows));
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

async function openMyReport(ctx) {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const seasons = await db.listStudentSeasons(student.id);
  if (seasons.length === 0) return replyStudentScreen(ctx, student, 'لا توجد بيانات دراسية مسجلة حتى الآن.');
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
  return replyStudentScreen(ctx, student, 'اختر الموسم الذي تريد عرض تقريره:', Markup.inlineKeyboard(rows));
}

bot.hears('📊 تقريري', openMyReport);

bot.action(/my_report_season:(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  await ctx.answerCbQuery();
  const rows = await sendStudentReportMessages(ctx, student.id, Number(ctx.match[1]), { student });
  if (rows.length === 0) return replyStudentScreen(ctx, student, 'لا توجد بيانات لهذا الموسم.');
  return undefined;
});

async function openStudentSeasonActivity(ctx) {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const activity = await db.getStudentCurrentSeasonActivity(
    student.id,
    currentDateInTimeZone(ATTENDANCE_TIME_ZONE)
  );
  return replyStudentScreen(ctx, student, formatStudentSeasonActivity(activity), studentMainMenu());
}

bot.hears(STUDENT_ACTIVITY_BUTTON, openStudentSeasonActivity);
// توافق مؤقت مع لوحة المفاتيح القديمة؛ بعد أول ضغط تظهر تسمية «المتغيرات» الجديدة.
bot.hears(LEGACY_STUDENT_ACTIVITY_BUTTON, openStudentSeasonActivity);
bot.hears(LEGACY_STUDENT_ACTIVITY_BUTTON_2, openStudentSeasonActivity);

// ---------------------------------------------------------------------------
// الطالب — طلب إجازة / إلغاؤها
// ---------------------------------------------------------------------------
async function openLeaveRequest(ctx) {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!student.is_active) return ctx.reply('حسابك مؤرشف حاليًا.');

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
      'لا يوجد موسم دراسي نشط في حسابك حاليًا، لذلك لا يمكن تقديم طلب إجازة.',
      studentMainMenu()
    );
  }
  if (active) {
    return replyStudentScreen(
      ctx,
      student,
      `لديك إجازة معتمدة من ${active.start_date.toISOString().slice(0, 10)} ` +
        `إلى ${active.end_date.toISOString().slice(0, 10)}.\n` +
        `الرصيد المتبقي في الموسم: ${usage.remainingDays} من ${usage.maxDays} أيام.`,
      Markup.inlineKeyboard([[callbackButton('إلغاء الإجازة والعودة للدروس', `leave_cancel:${active.id}`, 'danger')]])
    );
  }
  if (pending) {
    return replyStudentScreen(
      ctx,
      student,
      `لديك طلب إجازة قيد المراجعة من ${pending.start_date.toISOString().slice(0, 10)} ` +
        `إلى ${pending.end_date.toISOString().slice(0, 10)}.\n` +
        `الرصيد المتبقي بعد احتساب الطلب المعلّق: ${usage.remainingDays} من ${usage.maxDays} أيام.`,
      Markup.inlineKeyboard([[callbackButton('سحب الطلب', `leave_cancel:${pending.id}`, 'danger')]])
    );
  }
  if (usage.remainingDays <= 0) {
    return replyStudentScreen(
      ctx,
      student,
      `استنفدت رصيد الإجازات للموسم الحالي (${usage.maxDays} أيام)، ولا يمكن تقديم طلب جديد حتى الموسم القادم.`,
      studentMainMenu()
    );
  }
  userState.set(ctx.from.id, { action: 'leave_awaiting_days' });
  return replyStudentScreen(
    ctx,
    student,
    'طلب إجازة 🌴\nأرسل عدد أيام الإجازة المطلوبة، مثال: 1 أو ١.\n' +
      `المتبقي لك في هذا الموسم: ${usage.remainingDays} من ${usage.maxDays} أيام.\n` +
      'ستبدأ الإجازة تلقائيًا من اليوم بعد موافقة الأدمن.\n' +
      `للرجوع اضغط «${BACK_BUTTON}».`,
    studentMainMenu()
  );
}

bot.hears('🌴 طلب إجازة', openLeaveRequest);

bot.action(/leave_cancel:(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
      ])
    );
  }
  return undefined;
}

bot.hears('🌴 طلبات الإجازة', openLeaveRequests);

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
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
    return replyStudentScreen(ctx, updated, 'قائمتك الدراسية جاهزة:', studentMainMenu());
  } catch (err) {
    return replyStudentScreen(ctx, student, `تعذر حفظ الاختيار: ${err.message}`);
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery('تم تسجيل حضورك مسبقًا لهذا الدرس ✅'));

bot.action(/attend:(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
    { skipOnLeave: true, dailyLessonNotificationDate: notificationDate }
  );
  return ctx.editMessageText(
    `تم تفعيل الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» لمدة ${LESSON_ACTIVE_HOURS} ساعة ✅\n` +
      `وصل تنبيه دروس اليوم إلى ${delivery.delivered} من ${delivery.total} طالب` +
      (delivery.alreadyNotifiedToday ? `، وسبق تنبيه ${delivery.alreadyNotifiedToday} اليوم` : '') +
      (delivery.skippedOnLeave ? `، وتُخطّي ${delivery.skippedOnLeave} في إجازة.` : '.')
  );
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — التقارير (CSV)
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
bot.hears('📊 تقرير الحضور', openReports);

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
  return sendMarkdownDoc(
    ctx,
    `تقرير_${safeFilePart(rows[0].stage_name)}_${safeFilePart(formatSeasonLabel(rows[0]))}`,
    buildStageSeasonMd(rows)
  );
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
  userState.set(ctx.from.id, { action: 'admin_awaiting_student_search' });
  await answerIfCallback(ctx);
  return ctx.reply('أرسل اسم الطالب (كليًا أو جزئيًا) للبحث عنه:');
}

bot.action('admin_students', openStudentManagement);
bot.hears('🎓 إدارة الطلبة', openStudentManagement);

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
  return ctx.reply(
    formatAdminStudentDetails(student, activity, attendanceRows),
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
  } catch (err) {
    userState.delete(ctx.from.id);
    await ctx.answerCbQuery('تعذر الربط');
    return ctx.editMessageText(`تعذر ربط القناة: ${err.message}`);
  }
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تم الربط ✅');
  return ctx.editMessageText(
    `تم ربط قناة "${state.title}" بموسم هذه المرحلة الحالي بنجاح ✅\n\n` +
      'من الآن، أي منشور في القناة يحتوي على صوت أو ملف صوتي أو فيديو أو رابط مع هاشتاغ اسم المادة (مثل #المحاسبة) سيُفعّل الدرس تلقائيًا، حتى لو أُضيف الهاشتاغ بتعديل المنشور لاحقًا.\n\n' +
      'ملاحظة: عند بدء موسم جديد لهذه المرحلة ستتوقف هذه القناة تلقائيًا، وتربط قناة الموسم الجديد.'
  );
});

// ---------------------------------------------------------------------------
// لوحة الأستاذ
// ---------------------------------------------------------------------------
async function requireTeacher(ctx) {
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
  if (teacher) return teacher;
  // الأدمن يملك صلاحيات الأستاذ كاملة حتى لو لم يكن مسجَّلًا كأستاذ
  if (isAdmin(ctx)) return { id: null, full_name: 'الأدمن', isAdmin: true };
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
  return ctx.reply('اختر المادة لعرض حضور طلبتها:', Markup.inlineKeyboard(rows));
}

bot.hears('📊 حضور موادي', showTeacherAttendanceMenu);

bot.action(/teacher_att:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const stageSeasonId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, stageSeasonId))) {
    return ctx.answerCbQuery('هذه المادة ليست ضمن موادك.');
  }

  await ctx.answerCbQuery();
  const rows = await db.getSubjectAttendanceForTeacher(subjectId, stageSeasonId);
  if (rows.length === 0) return ctx.reply('لا يوجد طلبة مسجّلون في هذا الموسم.');

  const total = Number(rows[0].total_lessons);
  // إدارة الاستثناءات: يُبرَز المتأخرون أولًا بدل استعراض كل الطلبة
  const weak = rows.filter((r) => Number(r.attended_lessons) < total);
  const header = `📊 ${rows.length} طالبًا | عدد الدروس: ${total}`;
  if (total === 0) return ctx.reply(`${header}\nلم تُنشر دروس لهذه المادة بعد.`);
  const lines = weak
    .slice(0, 40)
    .map((r) => `• ${r.full_name}: ${Number(r.attended_lessons)}/${total}`);
  const body = weak.length === 0
    ? '✅ جميع الطلبة أكملوا كل الدروس.'
    : `⚠️ لم يكملوا (${weak.length}):\n${lines.join('\n')}` +
      (weak.length > 40 ? `\n… و${weak.length - 40} آخرون في الملف.` : '');

  return sendMarkdownDoc(
    ctx,
    `حضور_المادة_${subjectId}`,
    buildMarkdownDoc('حضور طلبة المادة', ['الطالب', 'الحضور', 'إجمالي الدروس'],
      rows.map((r) => [r.full_name, Number(r.attended_lessons), total]))
  );
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
      [
        teacher.is_active
          ? Markup.button.callback('🗄️ تعطيل الأستاذ', `admin_teacher_toggle:${teacher.id}:0`)
          : Markup.button.callback('♻️ إعادة تفعيل', `admin_teacher_toggle:${teacher.id}:1`),
      ],
      [Markup.button.callback('🗑️ حذف نهائي', `admin_teacher_del:${teacher.id}`)],
    ])
  );
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
  // 1) سؤال الأستاذ قبل الموعد بخمس دقائق: هل توجد محاضرة اليوم؟
  try {
    const pending = await studies.getSlotsNeedingPrompt(SLOT_PROMPT_LEAD_MINUTES);
    for (const slot of pending) {
      const date = slot.scheduled_date.toISOString().slice(0, 10);
      // يُسجَّل السؤال أولًا حتى لا يتكرر لو فشل الإرسال
      await studies.recordSlotPrompt(slot.id, date);
      if (!slot.teacher_telegram_id) continue;
      try {
        await bot.telegram.sendMessage(
          Number(slot.teacher_telegram_id),
          `⏰ بعد ${SLOT_PROMPT_LEAD_MINUTES} دقائق: مباحثة «${slot.subject_name}»` +
            ` — ${slot.group_title || 'المجموعة ' + slot.group_number}\n` +
            `الموعد: ${studies.formatHour(slot.hour, slot.minute)}\n\nهل توجد محاضرة اليوم؟`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ نعم، ابدأ المباحثة', `slot_yes:${slot.id}:${date}`)],
            [Markup.button.callback('🕓 تأجيل اليوم', `slot_no:${slot.id}:${date}`)],
          ])
        );
      } catch (err) {
        console.warn(`تعذر سؤال الأستاذ عن الموعد ${slot.id}:`, err.description || err.message);
      }
    }
  } catch (err) {
    console.error('خطأ في سؤال الأساتذة عن المواعيد:', err);
  }

  // 2) المواعيد المؤكَّدة التي حان وقتها: تُفتح جلستها ويُنبَّه طلبتها
  try {
    const ready = await studies.getSlotsReadyToStart();
    for (const slot of ready) {
      const session = await studies.startSessionFromSlot(slot);
      const students = await studies.listGroupStudents(slot.group_id);
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ حضرتُ المباحثة', `mub_attend:${session.id}`)],
      ]);
      for (const st of students) {
        try {
          await bot.telegram.sendMessage(
            Number(st.telegram_id),
            `🟢 بدأت مباحثة «${slot.subject_name}» الآن.\n` +
              `المجموعة: ${slot.group_title || 'المجموعة ' + slot.group_number}\n\n` +
              'بعد حضورك المباحثة فعلًا اضغط الزر أدناه لتسجيل حضورك.',
            keyboard
          );
        } catch (err) {
          console.warn(`تعذر تنبيه الطالب ${st.id} ببدء المباحثة:`, err.description || err.message);
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (slot.teacher_id) {
        const teacher = await db.getTeacherById(slot.teacher_id);
        if (teacher && teacher.telegram_id) {
          try {
            await bot.telegram.sendMessage(
              Number(teacher.telegram_id),
              `🟢 فُتحت مباحثة «${slot.subject_name}» وأُرسل التنبيه إلى ${students.length} طالبًا.`
            );
          } catch (err) {
            console.warn('تعذر إبلاغ الأستاذ ببدء الجلسة:', err.description || err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('خطأ في فتح جلسات المباحثات:', err);
  }
}

bot.action(/slot_yes:(\d+):(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
  if (!teacher) return ctx.answerCbQuery('غير مصرح.');
  await studies.recordSlotDecision(Number(ctx.match[1]), ctx.match[2], 'confirmed', ctx.from.id);
  await ctx.answerCbQuery('تم التأكيد ✅');
  return ctx.editMessageText('✅ تم تأكيد المباحثة. ستُفتح في وقتها ويصل التنبيه للطلبة تلقائيًا.');
});

bot.action(/slot_no:(\d+):(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
  if (!teacher) return ctx.answerCbQuery('غير مصرح.');
  await studies.recordSlotDecision(Number(ctx.match[1]), ctx.match[2], 'postponed', ctx.from.id);
  await ctx.answerCbQuery('تم التأجيل');
  return ctx.editMessageText('🕓 تم تأجيل مباحثة اليوم. لن يصل أي تنبيه للطلبة، ولن تُحتسب جلسة اليوم.');
});

bot.action(/mub_attend:(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا عبر /start');
  const sessionId = Number(ctx.match[1]);
  const session = await studies.getSessionById(sessionId);
  if (!session) return ctx.answerCbQuery('الجلسة غير موجودة.');
  if (session.is_closed || new Date(session.closes_at) < new Date()) {
    return ctx.answerCbQuery('انتهى وقت تسجيل الحضور لهذه المباحثة.');
  }
  const member = await studies.isStudentInGroup(student.id, session.group_id);
  if (!member) return ctx.answerCbQuery('هذه المباحثة ليست لمجموعتك.');

  const marked = await studies.markSessionAttendance(sessionId, student.id);
  if (!marked) return ctx.answerCbQuery('سُجّل حضورك مسبقًا ✅');
  await ctx.answerCbQuery('تم تسجيل حضورك ✅');
  return ctx.editMessageText('✅ تم تسجيل حضورك في المباحثة. بارك الله فيك.');
});

// ---------------------------------------------------------------------------
// الأستاذ — إدارة مجموعات المباحثات
// ---------------------------------------------------------------------------
// الأدمن يملك صلاحيات الأستاذ كاملة: يرى كل مواد المعهد ويعمل عليها،
// بينما يرى الأستاذ المواد المسنَدة إليه فقط.
async function getActorSubjects(ctx) {
  if (isAdmin(ctx)) return db.listAllActiveSubjects();
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
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
  if (isAdmin(ctx)) {
    const teacher = await db.getTeacherByTelegramId(ctx.from.id);
    return { id: teacher ? teacher.id : null, isAdmin: true };
  }
  const teacher = await db.getTeacherByTelegramId(ctx.from.id);
  if (!teacher) return null;
  const owns = (await db.listTeacherSubjects(teacher.id)).some(
    (s) => s.subject_id === subjectId && s.stage_season_id === stageSeasonId
  );
  return owns ? { id: teacher.id, isAdmin: false } : null;
}

bot.hears('👥 المجموعات', (ctx) => pickTeacherSubject(ctx, 'tg_groups', 'اختر المادة لإدارة مجموعاتها:'));

async function renderGroups(ctx, subjectId, stageSeasonId, edit = false) {
  const groups = await studies.listGroups(subjectId, stageSeasonId);
  const lines = groups.length
    ? groups
        .map(
          (g) =>
            `${g.group_number}) ${g.title} — ${Number(g.member_count)}/${g.capacity}` +
            `${Number(g.member_count) >= g.capacity ? ' (ممتلئة)' : ''}` +
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
        '1) أضِف البوت إلى مجموعة تليجرام.\n' +
        '2) عُد إلى هنا واختر المجموعة.'
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
  const slots = isAdmin(ctx) ? await studies.listAllSlots() : await studies.listTeacherSlots(actor.id);
  const lines = slots.length
    ? slots
        .map(
          (s) =>
            `• ${studies.formatSlot(s)} — ${s.subject_name} (${s.stage_name}) — مجموعة ${s.group_number}`
        )
        .join('\n')
    : 'لا توجد مواعيد في جدولك بعد.';
  return ctx.reply(
    `جدول مباحثاتك الأسبوعي:\n${lines}`,
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
    const { slot, conflicts } = await studies.addScheduleSlot(groupId, {
      dayOfWeek: day, hour, teacherId: teacher.id || null,
    });
    await ctx.answerCbQuery('تمت الإضافة ✅');
    let text = `✅ أُضيف الموعد: ${studies.formatSlot(slot)}`;
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
  const byNumber = new Map(exams.map((e) => [e.exam_number, e]));
  const rows = [];
  for (let n = 1; n <= studies.GRADE_WEIGHTS.examsPerSeason; n += 1) {
    const e = byNumber.get(n);
    rows.push([
      e
        ? Markup.button.callback(
            `${e.status === 'published' ? '📤' : '📝'} الشهري ${n} — ${Number(e.question_count)} سؤال` +
              `${e.status === 'published' ? ` (${Number(e.submitted_count)} سلّموا)` : ' (مسودة)'}`,
            `ex_view:${e.id}`
          )
        : Markup.button.callback(`➕ إنشاء الامتحان الشهري ${n}`, `ex_new:${subjectId}:${ssId}:${n}`),
    ]);
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
    action: 'teacher_exam_hours',
    subjectId: Number(subjectId),
    ssId: Number(ssId),
    number: Number(number),
    dateIso: iso,
  });
  await ctx.answerCbQuery();
  return ctx.reply(
    `تاريخ الامتحان: ${iso}\n\nكم ساعة يبقى الامتحان متاحًا؟ (أرسل رقمًا، مثال: 24)`
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
  if (exam.status === 'draft') {
    rows.push([Markup.button.callback('➕ سؤال صح/خطأ', `ex_qtf:${examId}`)]);
    rows.push([Markup.button.callback('➕ سؤال اختيار من متعدد', `ex_qmcq:${examId}`)]);
    if (questions.length > 0) {
      rows.push([Markup.button.callback('📤 نشر الامتحان للطلبة', `ex_pub:${examId}`)]);
    }
  } else {
    rows.push([Markup.button.callback('📊 النتائج', `ex_res:${examId}`)]);
    rows.push([Markup.button.callback('🕓 تأجيل الامتحان', `ex_pp:${examId}`)]);
  }
  const text =
    `📝 ${exam.title || 'الامتحان الشهري ' + exam.exam_number} — ${exam.subject_name}\n` +
    `الحالة: ${exam.status === 'published' ? 'منشور 📤' : 'مسودة 📝'}\n` +
    `يفتح: ${new Date(exam.opens_at).toISOString().slice(0, 16).replace('T', ' ')}\n` +
    `يُغلق: ${new Date(exam.closes_at).toISOString().slice(0, 16).replace('T', ' ')}\n` +
    `الدرجة: ${Number(exam.max_score)}\n\nالأسئلة:\n${lines}`;
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
    const published = await studies.publishExam(exam.id);
    await ctx.answerCbQuery('نُشر ✅');
    // إشعار طلبة المرحلة بموعد الامتحان
    const students = await studies.listSeasonStudents(exam.stage_season_id);
    let sent = 0;
    for (const st of students) {
      try {
        await bot.telegram.sendMessage(
          Number(st.telegram_id),
          `📝 امتحان جديد في مادة «${exam.subject_name}»\n` +
            `${published.title || 'الامتحان الشهري ' + published.exam_number}\n` +
            `يفتح: ${new Date(published.opens_at).toISOString().slice(0, 10)}\n` +
            `مدة الإتاحة: ${published.available_hours} ساعة\n` +
            `الدرجة: ${Number(published.max_score)}\n\n` +
            'ستجده في «📝 امتحاناتي» عند فتحه.'
        );
        sent += 1;
      } catch (err) {
        console.warn('تعذر إشعار طالب بالامتحان:', err.description || err.message);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    return ctx.editMessageText(`📤 نُشر الامتحان ووصل الإشعار إلى ${sent} من ${students.length} طالبًا.`);
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
      'تُلغى المحاولات التي لم تُسلَّم ليبدأ الجميع في الموعد الجديد.\n\nاختر التاريخ الجديد:',
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
  const ungraded = pending.filter((p) => p.report_score === null);
  return ctx.reply(
    `طلبة التقارير في هذه المادة: ${pending.length}\n` +
      `بانتظار التقييم: ${ungraded.length}\n\n` +
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
  const pending = await studies.listReportStudentsForGrading(subjectId, ssId);
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
      ['الطالب', 'النمط', 'حضر', 'من', 'المباحثات', 'التقارير', 'المشاركة', 'الامتحانات', 'المجموع'],
      grades.map((g) => [
        g.fullName, g.mode === 'report' ? 'تقارير' : 'مباحثات',
        g.attendedSessions, g.eligibleSessions, g.mubahathaScore, g.reportScore,
        g.participationScore, g.examsScore, g.totalScore,
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
bot.hears('🗓️ جدول المباحثات', async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
  for (let d = 0; d < 7; d += 1) {
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return ctx.reply('مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.');

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

  return ctx.reply(
    `📝 الامتحانات الشهرية\n\nالمتاحة الآن: ${open.length}\n\nدرجاتك السابقة:\n${doneLines}`,
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
      studentMainMenu()
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const attemptId = Number(ctx.match[1]);
  const questionId = Number(ctx.match[2]);
  const index = Number(ctx.match[3]);

  const attempt = await studies.getAttemptById(attemptId);
  if (!attempt || attempt.student_id !== student.id) return ctx.answerCbQuery('غير مصرح.');
  if (attempt.submitted_at) return ctx.answerCbQuery('سبق أن سلّمت هذا الامتحان.');

  // يُفحص وقت الإغلاق عند كل إجابة، فلا تُقبل إجابة بعد انتهاء مهلة الامتحان
  const examNow = await studies.getExamById(attempt.exam_id);
  if (!examNow || new Date() > new Date(examNow.closes_at)) {
    await studies.finalizeAttempt(attemptId);
    await ctx.answerCbQuery('انتهت مهلة الامتحان.', { show_alert: true });
    const done = await studies.getAttemptById(attemptId);
    return ctx.reply(
      `⏰ انتهت مهلة الامتحان وسُلّم بما أجبت عنه.\n` +
        `درجتك: ${Number(done.score)} من ${Number(examNow ? examNow.max_score : 5)}`,
      studentMainMenu()
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

  await studies.submitAnswer(attemptId, questionId, answer);
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
    `اختر المادة التي تريد نقله في مجموعتها:\nالطالب: ${student.full_name}`,
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
  const available = groups.filter((g) => Number(g.member_count) < Number(g.capacity));
  if (available.length === 0) return ctx.reply('لا توجد مجموعة فيها متسع. أنشئ مجموعة جديدة أولًا.');
  return ctx.reply(
    'اختر المجموعة الجديدة (سيبدأ فيها من جديد بلا احتساب جلسات مجموعته السابقة):',
    Markup.inlineKeyboard(
      available.map((g) => [
        callbackButton(
          `${g.title} (${Number(g.member_count)}/${g.capacity})`,
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
      `✅ نُقل الطالب إلى «${group.title}».\nيبدأ فيها من جديد، ولا تُحسب عليه جلسات مجموعته السابقة.`
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
// البوت لا يفرض أي قيود على الأعضاء ولا يحظر أحدًا؛ دوره هنا التعرّف على المجموعة
// فقط ليربطها الأستاذ أو الأدمن بمجموعة مباحثة. ضبط صلاحيات الأعضاء يبقى يدويًا
// من إعدادات المجموعة نفسها.
const pendingGroupChats = new Map();

bot.on('my_chat_member', async (ctx) => {
  const upd = ctx.myChatMember;
  const chat = upd.chat;
  if (!['group', 'supergroup'].includes(chat.type)) return;
  const status = upd.new_chat_member && upd.new_chat_member.status;
  if (!['administrator', 'member'].includes(status)) return;

  pendingGroupChats.set(chat.id, { id: chat.id, title: chat.title, at: Date.now() });
  await notifyAdmins(
    `👥 أُضيف البوت إلى مجموعة «${chat.title}».\n` +
      'اربطها بمادة من «👥 المجموعات» ← المادة ← «💬 ربط مجموعة تليجرام».'
  );
});

// ---------------------------------------------------------------------------
// الطالب — درجاته المحفوظة عبر كل المواسم
// ---------------------------------------------------------------------------
bot.hears('🎯 درجاتي', async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return ctx.reply('مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.');
  const grades = await studies.getStudentFinalGrades(student.id);
  if (grades.length === 0) {
    return ctx.reply('لم تُعتمد درجاتك بعد. تظهر هنا بعد أن يعتمد الأستاذ درجات الموسم.');
  }
  const bySeason = new Map();
  for (const g of grades) {
    const key = `${g.season_name} — ${g.stage_name}`;
    if (!bySeason.has(key)) bySeason.set(key, []);
    bySeason.get(key).push(g);
  }
  const parts = [];
  for (const [season, rows] of bySeason) {
    const lines = rows.map(
      (g) =>
        `  • ${g.subject_name}: ${Number(g.total_score)} من ${
          studies.GRADE_WEIGHTS.examsTotal + studies.GRADE_WEIGHTS.participationTotal
        }\n` +
        `     الامتحانات الشهرية: ${Number(g.exams_score)} من ${studies.GRADE_WEIGHTS.examsTotal}` +
        ` | ${g.mode === 'report' ? 'التقارير' : 'المباحثات'}: ${Number(g.participation_score)} من ${
          studies.GRADE_WEIGHTS.participationTotal
        }`
    );
    parts.push(`📘 ${season}\n${lines.join('\n')}`);
  }
  return ctx.reply(`🎯 درجاتك:\n\n${parts.join('\n\n')}`);
});

// ---------------------------------------------------------------------------
// الأستاذ/الأدمن — تحرير الدرجة النهائية لطالب
// ---------------------------------------------------------------------------
bot.hears('✏️ تحرير الدرجات', (ctx) =>
  pickTeacherSubject(ctx, 'gr_subj', 'اختر المادة لتحرير درجات طلبتها:')
);

bot.action(/gr_subj:(\d+):(\d+)/, async (ctx) => {
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const rows = await studies.listSubjectGrades(subjectId, ssId);
  if (rows.length === 0) return ctx.reply('لا يوجد طلبة في هذه المادة.');
  return ctx.reply(
    'اختر الطالب لتحرير درجته:',
    Markup.inlineKeyboard(
      rows
        .slice(0, 40)
        .map((r) => [
          callbackButton(
            `${limitButtonText(r.full_name, 28)} — ${
              r.total_score === null ? 'بلا درجة' : Number(r.total_score)
            }${r.edited_at ? ' ✏️' : ''}`,
            `gr_stu:${r.student_id}:${subjectId}:${ssId}`
          ),
        ])
    )
  );
});

bot.action(/gr_stu:(\d+):(\d+):(\d+)/, async (ctx) => {
  const [, studentId, subjectId, ssId] = ctx.match.map(Number);
  if (!(await teacherOwnsSubject(ctx, subjectId, ssId))) return ctx.answerCbQuery('غير مصرح.');
  await ctx.answerCbQuery();
  const student = await db.getStudentById(studentId);
  const rows = await studies.listSubjectGrades(subjectId, ssId);
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return ctx.reply('مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.');
  const subjects = await studies.listStudentSubjects(student.id);
  if (subjects.length === 0) {
    return ctx.reply('لا توجد مواد في مرحلتك بعد. راجع إدارة المعهد.');
  }
  const lines = subjects.map((s) => `• ${s.subject_name}: ${modeLabel(s)}`);
  return ctx.reply(
    `📖 مشاركتك في مواد ${subjects[0].stage_name}:\n${lines.join('\n')}\n\n` +
      'اختر المادة لتحديد نمط مشاركتك أو تغييره:',
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

bot.hears('📖 مشاركتي', showMyParticipation);

bot.action(/pm_subj:(\d+):(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
    rows.push([callbackButton('👥 انضمّ إلى مجموعتك', `pm_join:${subjectId}:${ssId}`)]);
  } else {
    rows.push([callbackButton('🔗 رابط مجموعتي', `pm_join:${subjectId}:${ssId}`)]);
  }

  const note =
    row.mode === 'report'
      ? '\n\nملاحظة: التحويل إلى المباحثات لا يحاسبك على الجلسات التي سبقت تحويلك، وتبقى درجة تقاريرك محسوبة لك.'
      : '';
  return ctx.reply(`📘 ${row.subject_name}\nنمطك الحالي: ${modeLabel(row)}${note}`, Markup.inlineKeyboard(rows));
});

bot.action(/pm_set:(\d+):(\d+):(mubahatha|report)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const mode = ctx.match[3];

  const subjects = await studies.listStudentSubjects(student.id);
  const row = subjects.find((s) => s.subject_id === subjectId && s.stage_season_id === ssId);
  if (!row) return ctx.answerCbQuery('هذه المادة ليست ضمن موادك.');
  if (row.mode) return ctx.answerCbQuery('اخترت نمطك مسبقًا لهذه المادة.');

  await studies.setParticipationMode(student.id, subjectId, ssId, mode);
  await ctx.answerCbQuery('تم الحفظ ✅');
  if (mode === 'report') {
    return ctx.editMessageText(
      `📄 اخترت نظام التقارير في «${row.subject_name}».\n` +
        'أرسل تقاريرك من «📖 مشاركتي» ← المادة ← «إرسال تقرير».\n' +
        'وأنت مشمول بالامتحانات الشهرية كبقية الطلبة.'
    );
  }
  await ctx.editMessageText(`👥 اخترت نظام المباحثات في «${row.subject_name}». جارٍ توزيعك على مجموعة...`);
  return joinMubahathaGroup(ctx, student, subjectId, ssId);
});

// التوزيع التلقائي: أول مجموعة فيها متسع، فإن امتلأت كلها يُنبَّه الأدمن لإنشاء مجموعة جديدة.
async function joinMubahathaGroup(ctx, student, subjectId, ssId) {
  // لا ينضم لمجموعة مادة إلا من اختار المباحثات فيها فعلًا
  const mode = await studies.getParticipationMode(student.id, subjectId, ssId);
  if (!mode || mode.mode !== 'mubahatha') {
    return ctx.reply('لست في نظام المباحثات في هذه المادة. اخترها أولًا من «📖 مشاركتي».');
  }
  const result = await studies.assignStudentToGroup(student.id, subjectId, ssId);
  if (!result.group) {
    await notifyAdmins(
      `⚠️ امتلأت كل مجموعات المباحثة لإحدى المواد، والطالب «${student.full_name}» ينتظر التوزيع.\n` +
        'أنشئ مجموعة جديدة من «👥 المجموعات».'
    );
    return ctx.reply(
      'مجموعات هذه المادة ممتلئة حاليًا. أُبلغت الإدارة، وسيصلك رابط مجموعتك فور إنشاء مجموعة جديدة.'
    );
  }
  const group = result.group;
  if (!group.invite_link) {
    await notifyAdmins(`⚠️ «${group.title}» بلا رابط دعوة، وطالب ينتظر الانضمام إليها.`);
    return ctx.reply(
      `تم تسجيلك في «${group.title}»، لكن رابط الدعوة غير متوفر بعد. أُبلغت الإدارة وسيصلك قريبًا.`
    );
  }
  return ctx.reply(
    `👥 مجموعتك: ${group.title}\n\nانضم إليها من الرابط أدناه، وستصلك تنبيهات بدء المباحثات في وقتها.`,
    Markup.inlineKeyboard([[Markup.button.url('🔗 الانضمام إلى المجموعة', group.invite_link)]])
  );
}

bot.action(/pm_join:(\d+):(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  await ctx.answerCbQuery();
  return joinMubahathaGroup(ctx, student, Number(ctx.match[1]), Number(ctx.match[2]));
});

bot.action(/pm_switch:(\d+):(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const subjectId = Number(ctx.match[1]);
  const ssId = Number(ctx.match[2]);
  const switched = await studies.switchToMubahatha(student.id, subjectId, ssId);
  if (!switched) return ctx.answerCbQuery('لست في نظام التقارير لهذه المادة.');
  await ctx.answerCbQuery('تم التحويل ✅');
  await ctx.editMessageText('✅ تم تحويلك إلى نظام المباحثات. جارٍ توزيعك على مجموعة...');
  return joinMubahathaGroup(ctx, student, subjectId, ssId);
});

// ---------------------------------------------------------------------------
// الطالب — إرسال التقارير
// ---------------------------------------------------------------------------
bot.hears('📄 إرسال تقرير', async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  if (!stageSupportsStudies(student)) return ctx.reply('مرحلتك مخصصة لحضور الدروس فقط، ولا تشمل المباحثات أو التقارير أو الامتحانات.');
  const subjects = await studies.listStudentSubjects(student.id);
  const reportSubjects = subjects.filter((s) => s.mode === 'report');
  if (reportSubjects.length === 0) {
    return ctx.reply(
      'لست في نظام التقارير في أي مادة.\nاختر نظام التقارير من «📖 مشاركتي» أولًا.'
    );
  }
  return ctx.reply(
    'اختر المادة التي تريد إرسال تقريرها:',
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
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
  return ctx.reply(
    `📄 أرسل الآن تقرير مادة «${row.subject_name}»:\n` +
      'يمكنك إرسال ملف (PDF أو Word) أو صورة أو نص مكتوب.\nللإلغاء أرسل /start.'
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

bot.action(/admin_unlink_channel:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  await db.unlinkChannel(Number(ctx.match[1]));
  await ctx.answerCbQuery('تم فكّ الربط ✅');
  return ctx.editMessageText('تم فكّ ربط القناة. لن تُفعّل أي دروس بعد الآن.');
});

// ---------------------------------------------------------------------------
// الاستماع لمنشورات القنوات (وكذلك تعديلاتها) وتفعيل الدروس تلقائيًا
// ---------------------------------------------------------------------------
async function handleChannelLesson(ctx) {
  try {
    const message = ctx.channelPost || ctx.editedChannelPost;
    if (!message) return;
    const chatId = message.chat.id;
    const channel = await db.getChannelByChatId(chatId);
    if (!channel) return; // قناة غير مرتبطة بأي مرحلة — تجاهل

    if (!hasLessonContent(message)) return; // إعلان نصي عادي وليس درسًا

    const hashtags = extractHashtags(message);
    if (hashtags.length === 0) {
      // ينبَّه الأدمن فقط إذا كان المنشور يبدو درسًا فعليًا (مرفق صوتي/مرئي أو رابط وسائط)،
      // حتى لا يتحول كل إعلان عادي يحتوي رابطًا إلى تنبيه متكرر.
      if (looksLikeLessonMedia(message)) {
        await notifyAdmins(
          `⚠️ لم يُفعَّل منشور في قناة «${channel.title || chatId}» لأنه يحتوي درسًا بلا هاشتاغ مادة.\n` +
            'أضف الهاشتاغ بتعديل المنشور نفسه ليُفعَّل الدرس تلقائيًا.'
        );
      }
      return;
    }

    let subject = null;
    for (const tag of hashtags) {
      subject = await db.findSubjectByHashtag(channel.stage_id, tag);
      if (subject) break;
    }
    if (!subject) {
      await notifyAdmins(
        `⚠️ لم يُفعَّل منشور في قناة «${channel.title || chatId}». الهاشتاغات الموجودة (${hashtags
          .map((tag) => `#${tag}`)
          .join('، ')}) لا تطابق مواد المرحلة.`
      );
      return;
    }

    // التعديل المتكرر لنفس منشور القناة لا ينشئ درسًا جديدًا ولا يكرر الإشعار.
    const existing = await db.getLessonBySource(chatId, message.message_id);
    if (existing) return;

    const postLink = telegramMessageLink(message);
    const externalUrl = extractFirstUrl(message);
    // وجهة الطالب هي منشور الدرس نفسه داخل قناة مرحلته، حتى إن احتوى المنشور رابطًا خارجيًا.
    const sourceUrl = postLink || externalUrl;
    const activated = await db.activateLesson(
      subject.id,
      LESSON_ACTIVE_HOURS,
      'channel',
      sourceUrl,
      chatId,
      message.message_id
    );
    if (!activated) throw new Error('المرحلة مؤرشفة أو لا يوجد لها موسم نشط.');
    const lesson = await db.getLessonById(activated.id);

    // نبّه أولًا من انتهت إجازتهم توًّا (أول درس بعد الإجازة) بضرورة متابعة الدروس الفائتة.
    await notifyReturningFromLeave(channel.stage_id);

    const notificationDate = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
    const hasChannelLink = Boolean(channelEntryUrl(sourceUrl));
    const delivery = await sendToStageStudents(
      channel.stage_id,
      dailyLessonNotificationText(hasChannelLink),
      dailyLessonNotificationKeyboard(lesson),
      { skipOnLeave: true, dailyLessonNotificationDate: notificationDate }
    );

    await notifyAdmins(
      `✅ فُعّل تلقائيًا الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» من قناة «${
        channel.title || chatId
      }». وصل تنبيه دروس اليوم إلى ${delivery.delivered} من ${delivery.total} طالب` +
        (delivery.alreadyNotifiedToday ? `، وسبق تنبيه ${delivery.alreadyNotifiedToday} اليوم` : '') +
        (delivery.skippedOnLeave ? ` (تُخطّي ${delivery.skippedOnLeave} في إجازة).` : '.')
    );
  } catch (err) {
    console.error('خطأ أثناء معالجة منشور القناة:', err);
    await notifyAdmins(`❌ حدث خطأ أثناء معالجة منشور قناة: ${err.message || 'خطأ غير معروف'}`);
  }
}

bot.on('channel_post', handleChannelLesson);
bot.on('edited_channel_post', handleChannelLesson);

// ---------------------------------------------------------------------------
// تذكير تلقائي للطلبة الذين لم يسجلوا حضورًا قبل انتهاء المهلة
// ---------------------------------------------------------------------------
let reminderCheckRunning = false;

async function checkReminders() {
  if (reminderCheckRunning) return;
  reminderCheckRunning = true;
  try {
    const lessons = await db.getLessonsNeedingReminder();
    const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
    for (const lesson of lessons) {
      const students = await db.getNonAttendedStudentsForLesson(lesson.id, lesson.stage_id);
      const hoursLeft = Math.max(1, Math.round((new Date(lesson.active_until) - new Date()) / 3600000));
      for (const st of students) {
        if (await db.isStudentOnLeave(st.id, today)) continue;
        try {
          await bot.telegram.sendMessage(
            st.telegram_id,
            `⏰ تذكير: لم تسجّل استماعك للدرس رقم ${Number(lesson.lesson_number)} من مادة «${
              lesson.subject_name
            }». تبقّى حوالي ${hoursLeft} ساعة قبل انتهاء المهلة.`,
            singleLessonKeyboard(lesson)
          );
        } catch (err) {
          // تجاهل الطلبة الذين حظروا البوت
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      await db.markReminderSent(lesson.id);
    }
  } catch (err) {
    console.error('خطأ أثناء فحص التذكيرات:', err);
  } finally {
    reminderCheckRunning = false;
  }
}

let absenceCheckRunning = false;

async function checkConsecutiveAbsence() {
  if (absenceCheckRunning) return;
  absenceCheckRunning = true;
  try {
    await db.processCompletedAttendanceDays(ATTENDANCE_TIME_ZONE);

    // تنبيه الطالب عند اليوم الثالث مرة واحدة لكل سلسلة غياب.
    const studentCandidates = await db.getStudentAbsenceAlertCandidates();
    for (const student of studentCandidates) {
      try {
        await bot.telegram.sendMessage(
          student.telegram_id,
          '⚠️ تنبيه غياب\n' +
            'لم تسجّل أي حضور ضمن مهلة الدروس لمدة 3 أيام دراسية متتالية ' +
            `(${dateOnly(student.streak_start_date)} → ${dateOnly(student.streak_end_date)}).\n` +
            'يرجى متابعة دروسك والالتزام بتأشير الحضور بعد الاستماع الفعلي.'
        );
        await db.markStudentAbsenceAlertSent(student.attendance_day_id);
      } catch (err) {
        console.warn(`تعذر إرسال تنبيه الغياب للطالب ${student.student_id}:`, err.description || err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    // قائمة مستقلة للأدمن عند اليوم العاشر، مجمعة من جميع المراحل.
    const adminCandidates = await db.getAdminAbsenceAlertCandidates();
    for (const message of buildAdminAbsenceMessages(adminCandidates)) {
      const delivered = await notifyAdmins(message.text);
      if (delivered > 0) await db.markAdminAbsenceAlertsSent(message.attendanceDayIds);
    }
  } catch (err) {
    console.error('خطأ أثناء فحص الغياب المتتالي:', err);
  } finally {
    absenceCheckRunning = false;
  }
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
  console.log('تم تجهيز قاعدة البيانات ✅');
  await bot.launch();
  console.log('البوت يعمل الآن ✅');

  setInterval(checkReminders, 10 * 60 * 1000); // فحص كل 10 دقائق
  setInterval(checkConsecutiveAbsence, 10 * 60 * 1000); // تثبيت الأيام وإرسال تنبيهي 3 و10 أيام
  setInterval(runScheduleTick, 60 * 1000); // مواعيد المباحثات: سؤال الأستاذ وفتح الجلسات
  runScheduleTick();
  checkReminders();
  checkConsecutiveAbsence();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('فشل تشغيل البوت:', err);
    process.exit(1);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = {
  bot,
  buildStageSeasonMd,
  buildStudentReportMd,
  buildMarkdownTable,
  formatStudentReport,
  groupStudentReport,
  parseLeaveDays,
  currentDateInTimeZone,
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
