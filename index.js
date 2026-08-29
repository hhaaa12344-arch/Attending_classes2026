// index.js — بوت تسجيل حضور الطلبة عبر تليجرام
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const {
  extractFirstUrl,
  extractHashtags,
  hasAudioContent,
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
// نافذة منع التكرار: تجاهل تفعيل نفس المادة تلقائيًا مرتين خلال هذه الدقائق (منشورات متعددة لنفس الدرس)
const DEDUPE_MINUTES = 15;

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
if (ADMIN_IDS.length === 0) {
  console.warn('تحذير: لم يتم ضبط أي معرف صحيح داخل ADMIN_IDS؛ لن تعمل لوحة الأدمن.');
}

const bot = new Telegraf(BOT_TOKEN);

// حالة مؤقتة في الذاكرة لكل مستخدم لإدارة خطوات الإدخال المتعددة (تسجيل، إضافة، تعديل...)
// يعمل بشكل صحيح طالما البوت يعمل على نسخة تشغيل واحدة (الوضع الافتراضي على Railway)
const userState = new Map();

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
]);

const isAdmin = (ctx) => ADMIN_IDS.includes(ctx.from.id);

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
function stagesKeyboard(stages, prefix) {
  return Markup.inlineKeyboard(
    stages.map((s) => [Markup.button.callback(limitButtonText(s.name), `${prefix}:${s.id}`)])
  );
}

function subjectsKeyboard(subjects, prefix) {
  return Markup.inlineKeyboard(
    subjects.map((s) => [Markup.button.callback(limitButtonText(s.name), `${prefix}:${s.id}`)])
  );
}

function studentMainMenu() {
  return Markup.keyboard([['📚 دروس اليوم', '📊 تقريري']]).resize().persistent();
}

function adminMainMenu() {
  return Markup.keyboard([
    ['➕ إضافة مرحلة دراسية', '➕ إضافة مادة'],
    ['🟢 تفعيل درس يدويًا', '📊 تقرير الحضور'],
    ['🎓 إدارة الطلبة', '🔗 ربط قناة بمرحلة'],
    ['📡 القنوات المرتبطة', '🏷️ المواد والهاشتاغات'],
    ['⚙️ إدارة المراحل', '🗓️ بدء موسم جديد'],
    ['🗂️ أرشيف المواسم'],
    ['❌ إلغاء العملية'],
  ]).resize().persistent();
}

function studentActionsKeyboard(studentId, isActive = true) {
  const rows = [
    [Markup.button.callback('✏️ تعديل الاسم', `stu_edit_name:${studentId}`)],
    [Markup.button.callback('🔁 تغيير المرحلة', `stu_edit_stage:${studentId}`)],
    [Markup.button.callback('📊 تقرير كل المواسم', `stu_report:${studentId}`)],
  ];
  rows.push([
    isActive
      ? Markup.button.callback('🗄️ أرشفة الطالب', `stu_delete_confirm:${studentId}`)
      : Markup.button.callback('♻️ إعادة تفعيل الطالب', `stu_restore:${studentId}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function sendToStageStudents(stageId, text, extra = undefined, excludeStudentIds = new Set()) {
  const students = await db.getStudentsByStage(stageId);
  let delivered = 0;
  for (const st of students) {
    if (excludeStudentIds.has(st.id)) continue;
    try {
      await bot.telegram.sendMessage(st.telegram_id, text, extra);
      delivered += 1;
    } catch (err) {
      console.warn(`تعذر إرسال إشعار للطالب ${st.id}:`, err.description || err.message);
    }
    await new Promise((r) => setTimeout(r, 40)); // احترام حدود تليجرام لعدد الرسائل بالثانية
  }
  return { delivered, total: students.length };
}

async function notifyAdmins(text) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text);
    } catch (err) {
      console.warn(`تعذر إرسال تنبيه للأدمن ${adminId}:`, err.description || err.message);
    }
  }
}

function lessonKeyboard(lessons) {
  const rows = [];
  for (const lesson of lessons) {
    const number = Number(lesson.lesson_number);
    const title = `${lesson.subject_name} — الدرس ${number}`;
    const sourceUrl = clickableUrl(lesson.source_url);
    if (sourceUrl) {
      rows.push([Markup.button.url(limitButtonText(`🎧 اضغط هنا للاستماع — ${title}`), sourceUrl)]);
    }
    rows.push([
      lesson.attended
        ? Markup.button.callback(limitButtonText(`✔️ تم الاستماع — ${title}`), 'noop')
        : Markup.button.callback(
            limitButtonText(`✅ تأشير تم الاستماع — ${title}`),
            `attend:${lesson.lesson_id}`
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
      Markup.button.url(
        `🎧 اضغط هنا للاستماع — الدرس ${Number(lesson.lesson_number)}`,
        sourceUrl
      ),
    ]);
  }
  rows.push([
    Markup.button.callback(
      `✅ تم الاستماع — الدرس ${Number(lesson.lesson_number)}`,
      `attend:${lesson.id}`
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function showTodayLessons(ctx, options = {}) {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const transition = await db.getPendingTransition(student.id);
  if (transition) {
    await ctx.reply('يجب أولًا اختيار وضعك للموسم الجديد.');
    return showTransitionPrompt(ctx);
  }

  const lessons = await db.getActiveLessonsForStudent(student.stage_id, student.id);
  if (lessons.length === 0) {
    return ctx.reply('لا توجد دروس مفعّلة حاليًا لمرحلتك. تحقق لاحقًا.', studentMainMenu());
  }

  const heading = options.confirmation
    ? `${options.confirmation}\n\nدروس اليوم المتاحة لمرحلتك:`
    : 'دروس اليوم المتاحة لمرحلتك:\nاضغط أولًا على رابط الاستماع، ثم أشّر «تم الاستماع».';
  const keyboard = lessonKeyboard(lessons);

  if (options.edit) {
    try {
      return await ctx.editMessageText(heading, keyboard);
    } catch (err) {
      if (!String(err.description || err.message).includes('message is not modified')) throw err;
      return undefined;
    }
  }
  return ctx.reply(heading, keyboard);
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
        seasonName: row.season_name,
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
        row.season_name,
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
    const cells = [index++, name, rows[0].season_name, rows[0].stage_name];
    for (const subjectName of subjectNames) {
      const found = subjects.find((subject) => subject.name === subjectName);
      cells.push(found ? found.attended : 0, found ? found.total : 0);
    }
    lines.push(cells.map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\n');
}

async function sendStudentReportMessages(ctx, studentId) {
  const rows = await db.getStudentSeasonReport(studentId);
  for (const message of formatStudentReport(rows)) await ctx.reply(message);
  return rows;
}

function transitionKeyboard(transition) {
  const rows = [[Markup.button.callback(`🔁 إعادة ${transition.source_stage_name}`, 'season_choice:repeat')]];
  if (transition.next_stage_id) {
    rows.push([
      Markup.button.callback(`✅ نجحت — الانتقال إلى ${transition.next_stage_name}`, 'season_choice:promote'),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

async function showTransitionPrompt(ctx, options = {}) {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  const transition = await db.getPendingTransition(student.id);
  if (!transition) return ctx.reply('لا يوجد اختيار موسم جديد مطلوب منك حاليًا.', studentMainMenu());
  const text =
    `🆕 بدأ موسم «${transition.repeat_season_name}» للمرحلة «${transition.source_stage_name}».\n` +
    'اختر حالتك بدقة؛ سيُحفظ تقرير موسمك السابق كما هو:';
  if (options.edit) return ctx.editMessageText(text, transitionKeyboard(transition));
  return ctx.reply(text, transitionKeyboard(transition));
}

function seasonSelectionKeyboard(stages, selectedIds) {
  const selected = new Set(selectedIds.map(Number));
  const rows = stages.map((stage) => [
    Markup.button.callback(
      `${selected.has(stage.id) ? '✅' : '◻️'} ${limitButtonText(stage.name, 50)}`,
      `season_toggle:${stage.id}`
    ),
  ]);
  rows.push([Markup.button.callback('🚀 بدء الموسم للمراحل المحددة', 'season_confirm')]);
  rows.push([Markup.button.callback('إلغاء', 'season_cancel')]);
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
    await ctx.reply(`أهلًا بعودتك ${student.full_name} 👋`, studentMainMenu());
    const transition = await db.getPendingTransition(student.id);
    if (transition) return showTransitionPrompt(ctx);
    return undefined;
  }
  userState.set(ctx.from.id, { action: 'awaiting_full_name' });
  return ctx.reply('أهلًا بك 👋\nالرجاء إدخال اسمك الرباعي الكامل:');
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

  if (inputText === '❌ إلغاء العملية' && isAdmin(ctx)) {
    userState.delete(ctx.from.id);
    return ctx.reply('تم إلغاء العملية الحالية.', adminMainMenu());
  }

  // الضغط على زر رئيسي يجب أن يلغي أي إدخال قديم، لا أن يُسجَّل كاسم مرحلة أو مادة.
  if (ADMIN_MENU_BUTTONS.has(inputText) || ['📚 دروس اليوم', '📊 تقريري'].includes(inputText)) {
    userState.delete(ctx.from.id);
    return next();
  }

  const state = userState.get(ctx.from.id);
  if (!state) return next();

  // -------- تسجيل اسم الطالب --------
  if (state.action === 'awaiting_full_name') {
    const fullName = ctx.message.text.trim();
    if (fullName.split(/\s+/).length < 4) {
      return ctx.reply('الرجاء إدخال الاسم الرباعي كاملًا (أربعة أسماء على الأقل).');
    }
    const stages = await db.listStages();
    if (stages.length === 0) {
      userState.delete(ctx.from.id);
      return ctx.reply('لم يتم إضافة أي مرحلة دراسية بعد من قبل الأدمن. حاول لاحقًا.');
    }
    userState.set(ctx.from.id, { action: 'awaiting_stage_choice', fullName });
    return ctx.reply('اختر مرحلتك الدراسية:', stagesKeyboard(stages, 'reg_stage'));
  }

  if (!isAdmin(ctx)) return next(); // كل الحالات التالية خاصة بالأدمن فقط

  // -------- إضافة مرحلة --------
  if (state.action === 'admin_awaiting_stage_name') {
    const name = ctx.message.text.trim();
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
    userState.set(ctx.from.id, { action: 'admin_awaiting_subject_hashtag', stageId: state.stageId, name });
    return ctx.reply(
      'أدخل الهاشتاغ الذي سيُستخدم لهذه المادة داخل منشورات القناة (بدون # وبدون مسافات)، أو أرسل "تخطي" لتوليده تلقائيًا من الاسم:'
    );
  }

  // -------- إضافة مادة: الهاشتاغ --------
  if (state.action === 'admin_awaiting_subject_hashtag') {
    const input = ctx.message.text.trim();
    const hashtag = normalizeHashtag(input === 'تخطي' ? state.name : input);
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
      Markup.button.callback(
        limitButtonText(`${s.is_active ? '' : '🗄️ '}${s.full_name} — ${s.stage_name}`),
        `stu_select:${s.id}`
      ),
    ]);
    return ctx.reply('نتائج البحث:', Markup.inlineKeyboard(rows));
  }

  // -------- تعديل اسم طالب --------
  if (state.action === 'admin_awaiting_new_name') {
    const name = ctx.message.text.trim();
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
  await ctx.answerCbQuery('تم التسجيل بنجاح');
  await ctx.editMessageText('تم تسجيلك بنجاح ✅');
  return ctx.reply(`أهلًا بك ${state.fullName} 👋`, studentMainMenu());
});

// ---------------------------------------------------------------------------
// دروس اليوم للطالب
// ---------------------------------------------------------------------------
bot.action('menu_today', async (ctx) => {
  await ctx.answerCbQuery();
  return showTodayLessons(ctx);
});

bot.hears('📚 دروس اليوم', (ctx) => showTodayLessons(ctx));

bot.hears('📊 تقريري', async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  return sendStudentReportMessages(ctx, student.id);
});

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
    return ctx.reply('قائمتك الدراسية جاهزة:', studentMainMenu());
  } catch (err) {
    return ctx.reply(`تعذر حفظ الاختيار: ${err.message}`);
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
    Markup.button.callback(
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
    [Markup.button.callback('✏️ تعديل اسم المرحلة', `admin_stage_rename:${stage.id}`)],
    [Markup.button.callback('⬆️ تحديد المرحلة الأعلى', `admin_stage_next:${stage.id}`)],
    [Markup.button.callback('📊 مواسم وتقارير المرحلة', `admin_report_stage:${stage.id}`)],
    [
      stage.is_active
        ? Markup.button.callback('🗄️ حذف/أرشفة المرحلة', `admin_stage_archive:${stage.id}`)
        : Markup.button.callback('♻️ استعادة المرحلة', `admin_stage_restore:${stage.id}`),
    ],
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
    Markup.button.callback(limitButtonText(stage.name), `admin_stage_next_pick:${sourceId}:${stage.id}`),
  ]);
  rows.push([Markup.button.callback('بدون مرحلة أعلى', `admin_stage_next_pick:${sourceId}:0`)]);
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
      [Markup.button.callback('نعم، أرشف المرحلة', `admin_stage_archive_confirm:${stage.id}`)],
      [Markup.button.callback('إلغاء', 'admin_cancel_noop')],
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

async function openStartSeason(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  userState.set(ctx.from.id, { action: 'admin_awaiting_season_name' });
  await answerIfCallback(ctx);
  return ctx.reply(
    'أرسل اسم الموسم الجديد، مثل: «الموسم الثاني 2026».\n' +
      'بعدها ستختار المراحل التي يبدأ لها الموسم؛ بقية المراحل لن تتغير.'
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
        Markup.inlineKeyboard([[Markup.button.callback('اختيار وضعي للموسم الجديد', 'season_open')]])
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
    Markup.button.callback(
      limitButtonText(`${subject.name} — #${subject.hashtag || normalizeHashtag(subject.name)}`),
      `admin_edit_tag:${subject.id}`
    ),
  ]);
  return ctx.reply('المواد والهاشتاغات الحالية (اضغط على مادة لتعديل هاشتاغها):', Markup.inlineKeyboard(rows));
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
  const delivery = await sendToStageStudents(subject.stage_id, notification, singleLessonKeyboard(lesson));
  return ctx.editMessageText(
    `تم تفعيل الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» لمدة ${LESSON_ACTIVE_HOURS} ساعة ✅\n` +
      `وصل الإشعار إلى ${delivery.delivered} من ${delivery.total} طالب.`
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
    Markup.button.callback(
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
    Markup.button.callback(
      `${season.is_active ? '🟢' : '📘'} ${limitButtonText(season.season_name, 42)} — ${Number(
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
    filename: `تقرير_${safeFilePart(rows[0].stage_name)}_${safeFilePart(rows[0].season_name)}.csv`,
  });
});

async function openSeasonArchive(ctx) {
  if (!isAdmin(ctx)) return denyUnauthorized(ctx);
  const seasons = await db.listSeasons();
  await answerIfCallback(ctx);
  if (seasons.length === 0) return ctx.reply('لا توجد مواسم مسجلة.');
  const rows = seasons.map((season) => [
    Markup.button.callback(
      `${Number(season.active_stage_count) ? '🟢' : '📘'} ${limitButtonText(season.name, 46)}`,
      `admin_season_view:${season.id}`
    ),
  ]);
  return ctx.reply('أرشيف المواسم (🟢 يحتوي مراحل ما زالت نشطة):', Markup.inlineKeyboard(rows));
}

bot.hears('🗂️ أرشيف المواسم', openSeasonArchive);

bot.action(/admin_season_view:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const details = await db.getSeasonDetails(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (details.length === 0) return ctx.reply('الموسم غير موجود.');
  const season = details[0];
  const lines = details
    .filter((row) => row.stage_season_id)
    .map(
      (row) =>
        `• ${row.stage_name} ${row.is_active ? '(نشط)' : '(مغلق)'} — ` +
        `${Number(row.student_count)} طالب، ${Number(row.lesson_count)} درس`
    );
  const buttons = details
    .filter((row) => row.stage_season_id)
    .map((row) => [
      Markup.button.callback(
        `📥 تقرير ${limitButtonText(row.stage_name, 42)}`,
        `admin_report_season:${row.stage_season_id}`
      ),
    ]);
  return ctx.reply(`الموسم: ${season.season_name}\n${lines.join('\n') || 'لا توجد مراحل.'}`, Markup.inlineKeyboard(buttons));
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
  const rows = await sendStudentReportMessages(ctx, studentId);
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

bot.action(/stu_delete_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  return ctx.reply(
    'هل تريد أرشفة هذا الطالب؟ سيُمنع من الدخول وتبقى كل تقارير مواسمه وحضوره محفوظة.',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ نعم، أرشف', `stu_delete:${studentId}`)],
      [Markup.button.callback('إلغاء', 'admin_cancel_noop')],
    ])
  );
});

bot.action('admin_cancel_noop', async (ctx) => {
  await ctx.answerCbQuery('تم الإلغاء');
  return ctx.editMessageText('تم إلغاء الحذف.');
});

bot.action(/stu_delete:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  await db.deleteStudent(studentId);
  await ctx.answerCbQuery('تمت الأرشفة ✅');
  return ctx.editMessageText('تمت أرشفة الطالب مع الاحتفاظ بكامل سجل مواسمه وحضوره ✅');
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

    // منع تكرار تفعيل نفس الدرس عند نشره بأكثر من منشور (صوت + رابط مثلًا).
    // لا يُهمَل المنشور بصمت: يُبلَّغ الأدمن حتى لا يضيع درس مستقل نُشر بعد الأول مباشرة.
    const recent = await db.getRecentLessonForSubject(subject.id, DEDUPE_MINUTES);
    if (recent) {
      await notifyAdmins(
        `⚠️ لم يُفعَّل منشور جديد لمادة «${subject.name}» في قناة «${channel.title || chatId}»، ` +
          `لأن درسًا لنفس المادة فُعّل قبل أقل من ${DEDUPE_MINUTES} دقيقة.\n` +
          `إن كان المنشوران لدرس واحد فتجاهل هذه الرسالة. ` +
          `وإن كان درسًا مستقلًا فعّله من «🟢 تفعيل درس يدويًا»، أو أعد نشره بعد ${DEDUPE_MINUTES} دقيقة.`
      );
      return;
    }

    const postLink = telegramMessageLink(message);
    const externalUrl = extractFirstUrl(message);
    const sourceUrl =
      (hasAudioContent(message) || message.video || message.video_note ? postLink : externalUrl) ||
      externalUrl ||
      postLink;
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

    const delivery = await sendToStageStudents(
      channel.stage_id,
      `📢 تم نشر درس جديد في مادة «${subject.name}» — الدرس رقم ${Number(lesson.lesson_number)}.\n` +
        `${sourceUrl ? 'اضغط الزر أدناه للاستماع، ثم أشّر «تم الاستماع».' : 'افتح «📚 دروس اليوم» ثم أشّر «تم الاستماع».'}\n` +
        `متاح لمدة ${LESSON_ACTIVE_HOURS} ساعة من الآن.`,
      singleLessonKeyboard(lesson)
    );

    await notifyAdmins(
      `✅ فُعّل تلقائيًا الدرس رقم ${Number(lesson.lesson_number)} لمادة «${subject.name}» من قناة «${
        channel.title || chatId
      }». وصل الإشعار إلى ${delivery.delivered} من ${delivery.total} طالب.`
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
async function checkReminders() {
  try {
    const lessons = await db.getLessonsNeedingReminder();
    for (const lesson of lessons) {
      const students = await db.getNonAttendedStudentsForLesson(lesson.id, lesson.stage_id);
      const hoursLeft = Math.max(1, Math.round((new Date(lesson.active_until) - new Date()) / 3600000));
      for (const st of students) {
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
  checkReminders();
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
};
