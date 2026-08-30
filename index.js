// index.js — بوت تسجيل حضور الطلبة عبر تليجرام
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
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
  STUDENT_ACTIVITY_BUTTON,
  LEGACY_STUDENT_ACTIVITY_BUTTON,
  LEGACY_STUDENT_ACTIVITY_BUTTON_2,
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

function studentMainMenu() {
  return Markup.keyboard([
    [replyButton('📚 دروس اليوم'), replyButton('📊 تقريري')],
    [replyButton('🌴 طلب إجازة'), replyButton(STUDENT_ACTIVITY_BUTTON)],
    [replyButton(BACK_BUTTON)],
  ]).resize().persistent();
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

function adminMainMenu() {
  const rows = [
    ['➕ إضافة مرحلة دراسية', '➕ إضافة مادة'],
    ['🟢 تفعيل درس يدويًا', '📊 تقرير الحضور'],
    ['🎓 إدارة الطلبة', '🔗 ربط قناة بمرحلة'],
    ['📡 القنوات المرتبطة', '🏷️ المواد والهاشتاغات'],
    ['⚙️ إدارة المراحل', '🗓️ بدء موسم جديد'],
    ['🗂️ أرشيف المواسم', '🌴 طلبات الإجازة'],
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
    rows.push([callbackButton('🗄️ أرشفة الطالب (مع حفظ بياناته)', `stu_archive_confirm:${studentId}`)]);
  } else {
    rows.push([callbackButton('♻️ إعادة تفعيل الطالب', `stu_restore:${studentId}`)]);
  }
  rows.push([callbackButton('🗑️ حذف نهائي (مع كل بياناته)', `stu_hard_confirm:${studentId}`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendToStageStudents(stageId, text, extra = undefined, options = {}) {
  const { excludeStudentIds = new Set(), skipOnLeave = false } = options;
  const students = await db.getStudentsByStage(stageId);
  const today = currentDateInTimeZone(ATTENDANCE_TIME_ZONE);
  let delivered = 0;
  let skippedOnLeave = 0;
  for (const st of students) {
    if (excludeStudentIds.has(st.id)) continue;
    // أثناء الإجازة: لا تصل إشعارات الدروس للطالب المجاز في هذا اليوم.
    if (skipOnLeave && (await db.isStudentOnLeave(st.id, today))) {
      skippedOnLeave += 1;
      continue;
    }
    try {
      await bot.telegram.sendMessage(st.telegram_id, text, extra);
      delivered += 1;
    } catch (err) {
      console.warn(`تعذر إرسال إشعار للطالب ${st.id}:`, err.description || err.message);
    }
    await new Promise((r) => setTimeout(r, 40)); // احترام حدود تليجرام لعدد الرسائل بالثانية
  }
  return { delivered, total: students.length, skippedOnLeave };
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
  return Number.isInteger(days) && days >= 1 && days <= 60 ? days : null;
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
  let text =
    `${STUDENT_ACTIVITY_BUTTON}\n` +
    `المرحلة: ${activity.stageName || '—'}\n` +
    `الموسم: ${activity.seasonName || '—'}\n\n` +
    `🌴 الإجازات المعتمدة (${leaves.length}):\n${leaveLines.join('\n')}`;
  if (warnings.length) {
    const notificationLines = warnings.map(
      (warning, index) =>
        `${index + 1}. تنبيه غياب متتالٍ حتى يوم ${dateOnly(warning.attendance_date)}`
    );
    text += `\n\n⚠️ التنبيهات المستلمة (${warnings.length}):\n${notificationLines.join('\n')}`;
  }
  return text;
}

function lessonKeyboard(lessons) {
  const rows = [];
  for (const lesson of lessons) {
    const number = Number(lesson.lesson_number);
    const title = `${lesson.subject_name} — الدرس ${number}`;
    const sourceUrl = clickableUrl(lesson.source_url);
    if (sourceUrl) {
      rows.push([urlButton(limitButtonText(`📢 انتقال إلى دروس اليوم — ${title}`), sourceUrl)]);
    }
    rows.push([
      lesson.attended
        ? callbackButton(limitButtonText(`✔️ تم الاستماع — ${title}`), 'noop', 'success')
        : callbackButton(
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

function singleLessonKeyboard(lesson) {
  const rows = [];
  const sourceUrl = clickableUrl(lesson.source_url);
  if (sourceUrl) {
    rows.push([
      urlButton(
        `📢 انتقال إلى دروس اليوم — الدرس ${Number(lesson.lesson_number)}`,
        sourceUrl
      ),
    ]);
  }
  rows.push([
    callbackButton(
      `✅ تم الاستماع — الدرس ${Number(lesson.lesson_number)}`,
      `attend:${lesson.id}`,
      'success'
    ),
  ]);
  return Markup.inlineKeyboard(rows);
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
      'لا توجد دروس مفعّلة حاليًا لمرحلتك. تحقق لاحقًا.',
      studentMainMenu()
    );
  }

  const heading = options.confirmation
    ? `${options.confirmation}\n\nدروس اليوم المتاحة لمرحلتك:`
    : 'دروس اليوم المتاحة لمرحلتك:\nانتقل إلى منشور الدرس في قناة مرحلتك، ثم أشّر «تم الاستماع».';
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
    return `📘 ${group.seasonName}\nالمرحلة: ${group.stageName}\n${subjectLines.join('\n')}`;
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

function buildStudentReportCsv(rows) {
  const header = ['الموسم', 'المرحلة', 'المادة', 'الحضور', 'إجمالي الدروس'];
  return (
    '\uFEFF' +
    [
      header,
      ...rows.map((row) => [
        formatSeasonLabel(row),
        row.stage_name,
        row.subject_name,
        Number(row.attended_lessons),
        Number(row.total_lessons),
      ]),
    ]
      .map((line) => line.map(csvCell).join(','))
      .join('\n')
  );
}

function buildStageSeasonCsv(rows) {
  const byStudent = new Map();
  for (const row of rows) {
    if (!byStudent.has(row.student_id)) {
      byStudent.set(row.student_id, { name: row.full_name, subjects: [] });
    }
    byStudent.get(row.student_id).subjects.push({
      name: row.subject_name,
      total: Number(row.total_lessons),
      attended: Number(row.attended_lessons),
    });
  }
  const subjectNames = [...new Set(rows.map((row) => row.subject_name))];
  const header = [
    'ت',
    'اسم الطالب',
    'الموسم',
    'المرحلة',
    ...subjectNames.flatMap((name) => [`${name} - حضر`, `${name} - الإجمالي`]),
  ];
  const lines = [header.map(csvCell).join(',')];
  let index = 1;
  for (const { name, subjects } of byStudent.values()) {
    const cells = [index++, name, formatSeasonLabel(rows[0]), rows[0].stage_name];
    for (const subjectName of subjectNames) {
      const found = subjects.find((subject) => subject.name === subjectName);
      cells.push(found ? found.attended : 0, found ? found.total : 0);
    }
    lines.push(cells.map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

async function sendStudentReportMessages(ctx, studentId, stageSeasonId = null, options = {}) {
  const rows = await db.getStudentSeasonReport(studentId, stageSeasonId);
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
  userState.set(ctx.from.id, { action: 'awaiting_full_name' });
  return ctx.reply('أهلًا بك 👋\nالرجاء إدخال اسمك الرباعي الكامل:', backOnlyMenu());
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
      STUDENT_MENU_BUTTONS.has(inputText)
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
    STUDENT_MENU_BUTTONS.has(inputText)
  ) {
    userState.delete(ctx.from.id);
    return next();
  }

  const state = userState.get(ctx.from.id);
  if (!state) return next();

  // -------- تسجيل اسم الطالب --------
  if (state.action === 'awaiting_full_name') {
    const fullName = ctx.message.text.trim();
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
        `أرسل عدد أيام الإجازة فقط، مثال: 1 أو ١. يجب أن يكون العدد بين 1 و60.\nللرجوع اضغط «${BACK_BUTTON}».`,
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
          'سيصلك إشعار عند قبول الأدمن للطلب. عند الموافقة لا تُحسب أيام الإجازة غيابًا، ' +
          'ويبقى التأشير ممكنًا خلال مهلة كل درس فقط.',
        studentMainMenu()
      );
      // إشعار الأدمن مع أزرار الموافقة/الرفض
      await notifyAdmins(
        `🌴 طلب إجازة جديد\nالطالب: ${student.full_name}\nالمرحلة: ${student.stage_name || '—'}\n` +
          `المدة: ${days} يومًا (${leave.start_date.toISOString().slice(0, 10)} → ${leave.end_date
            .toISOString()
            .slice(0, 10)})`,
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

  if (!isAdmin(ctx)) return next(); // كل الحالات التالية خاصة بالأدمن فقط

  // -------- إضافة مرحلة --------
  if (state.action === 'admin_awaiting_stage_name') {
    const name = ctx.message.text.trim();
    if (!name) return ctx.reply('أرسل اسمًا غير فارغ للمرحلة أو اضغط «↩️ رجوع».');
    try {
      await db.addStage(name);
    } catch (err) {
      if (err.code === '23505') return ctx.reply('هذه المرحلة موجودة مسبقًا. أرسل اسمًا مختلفًا أو ألغِ العملية.');
      throw err;
    }
    userState.delete(ctx.from.id);
    return ctx.reply(`تمت إضافة المرحلة: ${name} ✅`, adminMainMenu());
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

  const active = await db.getActiveOrUpcomingLeave(
    student.id,
    currentDateInTimeZone(ATTENDANCE_TIME_ZONE)
  );
  const pending = await db.getPendingLeave(student.id);
  if (active) {
    return replyStudentScreen(
      ctx,
      student,
      `لديك إجازة معتمدة من ${active.start_date.toISOString().slice(0, 10)} ` +
        `إلى ${active.end_date.toISOString().slice(0, 10)}.`,
      Markup.inlineKeyboard([[callbackButton('إلغاء الإجازة والعودة للدروس', `leave_cancel:${active.id}`, 'danger')]])
    );
  }
  if (pending) {
    return replyStudentScreen(
      ctx,
      student,
      `لديك طلب إجازة قيد المراجعة من ${pending.start_date.toISOString().slice(0, 10)} ` +
        `إلى ${pending.end_date.toISOString().slice(0, 10)}.`,
      Markup.inlineKeyboard([[callbackButton('سحب الطلب', `leave_cancel:${pending.id}`, 'danger')]])
    );
  }
  userState.set(ctx.from.id, { action: 'leave_awaiting_days' });
  return replyStudentScreen(
    ctx,
    student,
    'طلب إجازة 🌴\nأرسل عدد أيام الإجازة المطلوبة، مثال: 1 أو ١.\n' +
      'ستبدأ الإجازة تلقائيًا من اليوم بعد موافقة الأدمن.\n' +
      `للرجوع اضغط «${BACK_BUTTON}».`,
    studentMainMenu()
  );
}

bot.hears('🌴 طلب إجازة', openLeaveRequest);

bot.action(/leave_cancel:(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا.');
  const cancelled = await db.cancelLeave(student.id, Number(ctx.match[1]));
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
  const notification =
    `📢 تم تفعيل درس جديد في مادة «${subject.name}» — الدرس رقم ${Number(lesson.lesson_number)}.\n` +
    `افتح «📚 دروس اليوم» بعد الاستماع لتسجيل حضورك.\n` +
    `متاح لمدة ${LESSON_ACTIVE_HOURS} ساعة.`;
  await notifyReturningFromLeave(subject.stage_id);
  const delivery = await sendToStageStudents(
    subject.stage_id,
    notification,
    singleLessonKeyboard(lesson),
    { skipOnLeave: true }
  );
  return ctx.editMessageText(
    `تم تفعيل الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» لمدة ${LESSON_ACTIVE_HOURS} ساعة ✅\n` +
      `وصل الإشعار إلى ${delivery.delivered} من ${delivery.total} طالب` +
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
  const rows = await db.getStageSeasonReport(stageSeasonId);
  await ctx.answerCbQuery();
  if (rows.length === 0) {
    return ctx.reply('لا توجد بيانات كافية لهذا الموسم (تأكد من وجود طلبة ومواد).');
  }
  const csv = buildStageSeasonCsv(rows);
  return ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf-8'),
    filename: `تقرير_${safeFilePart(rows[0].stage_name)}_${safeFilePart(formatSeasonLabel(rows[0]))}.csv`,
  });
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
  return ctx.reply(
    `الطالب: ${student.full_name}\nالمرحلة: ${student.stage_name}\nالحالة: ${
      student.is_active ? 'نشط' : 'مؤرشف'
    }`,
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
  const csv = buildStudentReportCsv(rows);
  return ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf-8'),
    filename: `تقرير_الطالب_${studentId}.csv`,
  });
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

bot.action('admin_cancel_noop', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
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
  await db.linkChannel(stageId, state.chatId, state.title);
  userState.delete(ctx.from.id);
  await ctx.answerCbQuery('تم الربط ✅');
  return ctx.editMessageText(
    `تم ربط قناة "${state.title}" بهذه المرحلة بنجاح ✅\n\n` +
      'من الآن، أي منشور في القناة يحتوي على صوت أو ملف صوتي أو فيديو أو رابط مع هاشتاغ اسم المادة (مثل #المحاسبة) سيُفعّل الدرس تلقائيًا، حتى لو أُضيف الهاشتاغ بتعديل المنشور لاحقًا.'
  );
});

async function showLinkedChannels(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const channels = await db.listChannelsWithStage();
  await answerIfCallback(ctx);
  if (channels.length === 0) return ctx.reply('لا توجد قنوات مرتبطة بعد.');
  const lines = channels.map((c) => `• ${c.title || c.telegram_chat_id} → ${c.stage_name}`);
  return ctx.reply('القنوات المرتبطة حاليًا:\n' + lines.join('\n'));
}

bot.action('admin_list_channels', showLinkedChannels);
bot.hears('📡 القنوات المرتبطة', showLinkedChannels);

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

    const delivery = await sendToStageStudents(
      channel.stage_id,
      `📢 تم نشر درس جديد في مادة «${subject.name}» — الدرس رقم ${Number(lesson.lesson_number)}.\n` +
        `${sourceUrl ? 'اضغط «انتقال إلى دروس اليوم» لفتح منشور الدرس في قناة مرحلتك، ثم أشّر «تم الاستماع».' : 'افتح «📚 دروس اليوم» ثم أشّر «تم الاستماع».'}\n` +
        `متاح لمدة ${LESSON_ACTIVE_HOURS} ساعة من الآن.`,
      singleLessonKeyboard(lesson),
      { skipOnLeave: true }
    );

    await notifyAdmins(
      `✅ فُعّل تلقائيًا الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» من قناة «${
        channel.title || chatId
      }». وصل الإشعار إلى ${delivery.delivered} من ${delivery.total} طالب` +
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
  console.log('تم تجهيز قاعدة البيانات ✅');
  await bot.launch();
  console.log('البوت يعمل الآن ✅');

  setInterval(checkReminders, 10 * 60 * 1000); // فحص كل 10 دقائق
  setInterval(checkConsecutiveAbsence, 10 * 60 * 1000); // تثبيت الأيام وإرسال تنبيهي 3 و10 أيام
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
  buildStageSeasonCsv,
  buildStudentReportCsv,
  formatStudentReport,
  groupStudentReport,
  parseLeaveDays,
  currentDateInTimeZone,
  buildAdminAbsenceMessages,
  lessonKeyboard,
  singleLessonKeyboard,
  formatStudentSeasonActivity,
  buttonStyle,
  studentUiMessageKind,
};
