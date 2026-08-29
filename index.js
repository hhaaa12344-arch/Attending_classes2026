// index.js — بوت تسجيل حضور الطلبة عبر تليجرام
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// كل درس مفعّل (يدويًا أو تلقائيًا من القناة) يبقى متاحًا لتسجيل الحضور لهذه المدة
const LESSON_ACTIVE_HOURS = Number(process.env.LESSON_ACTIVE_HOURS || 24);
// نافذة منع التكرار: تجاهل تفعيل نفس المادة تلقائيًا مرتين خلال هذه الدقائق (منشورات متعددة لنفس الدرس)
const DEDUPE_MINUTES = 15;

if (!BOT_TOKEN) {
  console.error('خطأ: يجب ضبط متغير البيئة BOT_TOKEN');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// حالة مؤقتة في الذاكرة لكل مستخدم لإدارة خطوات الإدخال المتعددة (تسجيل، إضافة، تعديل...)
// يعمل بشكل صحيح طالما البوت يعمل على نسخة تشغيل واحدة (الوضع الافتراضي على Railway)
const userState = new Map();

const isAdmin = (ctx) => ADMIN_IDS.includes(ctx.from.id);

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
function stagesKeyboard(stages, prefix) {
  return Markup.inlineKeyboard(stages.map((s) => [Markup.button.callback(s.name, `${prefix}:${s.id}`)]));
}

function subjectsKeyboard(subjects, prefix) {
  return Markup.inlineKeyboard(subjects.map((s) => [Markup.button.callback(s.name, `${prefix}:${s.id}`)]));
}

function studentMainMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback('📚 دروس اليوم', 'menu_today')]]);
}

function adminMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ إضافة مرحلة دراسية', 'admin_add_stage')],
    [Markup.button.callback('➕ إضافة مادة', 'admin_add_subject')],
    [Markup.button.callback('🟢 تفعيل درس يدويًا', 'admin_activate')],
    [Markup.button.callback('📊 تقرير الحضور', 'admin_reports')],
    [Markup.button.callback('🎓 إدارة الطلبة', 'admin_students')],
    [Markup.button.callback('🔗 ربط قناة بمرحلة', 'admin_link_channel')],
    [Markup.button.callback('📡 القنوات المرتبطة', 'admin_list_channels')],
  ]);
}

function studentActionsKeyboard(studentId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ تعديل الاسم', `stu_edit_name:${studentId}`)],
    [Markup.button.callback('🔁 تغيير المرحلة', `stu_edit_stage:${studentId}`)],
    [Markup.button.callback('🗑️ حذف الطالب', `stu_delete_confirm:${studentId}`)],
  ]);
}

const YOUTUBE_REGEX = /(youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)[\w-]+/i;

function extractHashtags(message) {
  const text = message.caption || message.text || '';
  const entities = message.caption_entities || message.entities || [];
  const tags = [];
  for (const e of entities) {
    if (e.type === 'hashtag') {
      tags.push(text.substring(e.offset + 1, e.offset + e.length).trim());
    }
  }
  if (tags.length === 0 && text.includes('#')) {
    const matches = text.match(/#([^\s#]+)/g) || [];
    for (const m of matches) tags.push(m.slice(1));
  }
  return tags;
}

function hasAudioContent(message) {
  if (message.audio || message.voice) return true;
  if (message.document && message.document.mime_type && message.document.mime_type.startsWith('audio/')) {
    return true;
  }
  return false;
}

function extractYoutubeLink(message) {
  const text = message.caption || message.text || '';
  const match = text.match(YOUTUBE_REGEX);
  return match ? match[0] : null;
}

async function sendToStageStudents(stageId, text, excludeStudentIds = new Set()) {
  const students = await db.getStudentsByStage(stageId);
  for (const st of students) {
    if (excludeStudentIds.has(st.id)) continue;
    try {
      await bot.telegram.sendMessage(st.telegram_id, text);
    } catch (err) {
      // تجاهل الطلبة الذين حظروا البوت أو حذفوا حسابهم
    }
    await new Promise((r) => setTimeout(r, 40)); // احترام حدود تليجرام لعدد الرسائل بالثانية
  }
}

// ---------------------------------------------------------------------------
// تسجيل الدخول للطالب
// ---------------------------------------------------------------------------
bot.start(async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (student) {
    return ctx.reply(`أهلًا بعودتك ${student.full_name} 👋`, studentMainMenu());
  }
  userState.set(ctx.from.id, { action: 'awaiting_full_name' });
  return ctx.reply('أهلًا بك 👋\nالرجاء إدخال اسمك الرباعي الكامل:');
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('هذا الأمر متاح للأدمن فقط.');
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
bot.on('text', async (ctx) => {
  const state = userState.get(ctx.from.id);
  if (!state) return;

  // -------- تسجيل اسم الطالب --------
  if (state.action === 'awaiting_full_name') {
    const fullName = ctx.message.text.trim();
    if (fullName.split(/\s+/).length < 2) {
      return ctx.reply('الرجاء إدخال الاسم الرباعي كاملًا (على الأقل اسمين).');
    }
    const stages = await db.listStages();
    if (stages.length === 0) {
      userState.delete(ctx.from.id);
      return ctx.reply('لم يتم إضافة أي مرحلة دراسية بعد من قبل الأدمن. حاول لاحقًا.');
    }
    userState.set(ctx.from.id, { action: 'awaiting_stage_choice', fullName });
    return ctx.reply('اختر مرحلتك الدراسية:', stagesKeyboard(stages, 'reg_stage'));
  }

  if (!isAdmin(ctx)) return; // كل الحالات التالية خاصة بالأدمن فقط

  // -------- إضافة مرحلة --------
  if (state.action === 'admin_awaiting_stage_name') {
    const name = ctx.message.text.trim();
    await db.addStage(name);
    userState.delete(ctx.from.id);
    return ctx.reply(`تمت إضافة المرحلة: ${name} ✅`, adminMainMenu());
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
    const hashtag = input === 'تخطي' ? state.name.replace(/\s+/g, '') : input.replace(/^#/, '').replace(/\s+/g, '');
    try {
      await db.addSubject(state.stageId, state.name, hashtag);
    } catch (err) {
      userState.delete(ctx.from.id);
      return ctx.reply('هذا الهاشتاغ مستخدم بالفعل لمادة أخرى في نفس المرحلة. حاول إضافة المادة من جديد بهاشتاغ مختلف.', adminMainMenu());
    }
    userState.delete(ctx.from.id);
    return ctx.reply(`تمت إضافة المادة: ${state.name} (هاشتاغ: #${hashtag}) ✅`, adminMainMenu());
  }

  // -------- بحث عن طالب --------
  if (state.action === 'admin_awaiting_student_search') {
    const q = ctx.message.text.trim();
    const results = await db.searchStudents(q, 10);
    userState.delete(ctx.from.id);
    if (results.length === 0) return ctx.reply('لا توجد نتائج مطابقة.', adminMainMenu());
    const rows = results.map((s) => [Markup.button.callback(`${s.full_name} — ${s.stage_name}`, `stu_select:${s.id}`)]);
    return ctx.reply('نتائج البحث:', Markup.inlineKeyboard(rows));
  }

  // -------- تعديل اسم طالب --------
  if (state.action === 'admin_awaiting_new_name') {
    const name = ctx.message.text.trim();
    await db.updateStudentName(state.studentId, name);
    userState.delete(ctx.from.id);
    return ctx.reply(`تم تحديث الاسم إلى: ${name} ✅`, adminMainMenu());
  }
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
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) {
    await ctx.answerCbQuery();
    return ctx.reply('الرجاء التسجيل أولًا عبر /start');
  }
  const lessons = await db.getActiveLessonsForStudent(student.stage_id, student.id);
  await ctx.answerCbQuery();
  if (lessons.length === 0) {
    return ctx.reply('لا توجد دروس مفعّلة حاليًا لمرحلتك. تحقق لاحقًا.');
  }
  const rows = lessons.map((l) =>
    l.attended
      ? [Markup.button.callback(`✔️ ${l.subject_name} — تم التسجيل`, 'noop')]
      : [Markup.button.callback(`✅ تم الاستماع — ${l.subject_name}`, `attend:${l.lesson_id}`)]
  );
  return ctx.reply('دروس اليوم المتاحة لمرحلتك:', Markup.inlineKeyboard(rows));
});

bot.action('noop', (ctx) => ctx.answerCbQuery('تم تسجيل حضورك مسبقًا لهذا الدرس ✅'));

bot.action(/attend:(\d+)/, async (ctx) => {
  const student = await db.getStudentByTelegramId(ctx.from.id);
  if (!student) return ctx.answerCbQuery('الرجاء التسجيل أولًا عبر /start');
  const lessonId = Number(ctx.match[1]);
  const lesson = await db.getLessonById(lessonId);
  if (!lesson) return ctx.answerCbQuery('الدرس غير موجود.');
  if (lesson.stage_id !== student.stage_id) return ctx.answerCbQuery('هذا الدرس ليس لمرحلتك.');
  if (new Date(lesson.active_until) < new Date()) {
    return ctx.answerCbQuery(`انتهت مدة تسجيل الحضور لهذا الدرس (${LESSON_ACTIVE_HOURS} ساعة).`);
  }
  const inserted = await db.markAttendance(student.id, lessonId);
  if (!inserted) {
    return ctx.answerCbQuery('تم تسجيل حضورك مسبقًا لهذا الدرس ✅');
  }
  await ctx.answerCbQuery('تم تسجيل حضورك ✅');
  return ctx.editMessageText('تم تسجيل حضورك بنجاح ✅\nيمكنك العودة للقائمة عبر /start');
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إضافة مرحلة
// ---------------------------------------------------------------------------
bot.action('admin_add_stage', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id, { action: 'admin_awaiting_stage_name' });
  await ctx.answerCbQuery();
  return ctx.reply('أدخل اسم المرحلة الدراسية الجديدة:');
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إضافة مادة
// ---------------------------------------------------------------------------
bot.action('admin_add_subject', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stages = await db.listStages();
  await ctx.answerCbQuery();
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد. أضف مرحلة أولًا.');
  return ctx.reply('اختر المرحلة التي ستضيف لها المادة:', stagesKeyboard(stages, 'admin_subj_stage'));
});

bot.action(/admin_subj_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  userState.set(ctx.from.id, { action: 'admin_awaiting_subject_name', stageId });
  await ctx.answerCbQuery();
  return ctx.reply('أدخل اسم المادة:');
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — تفعيل درس يدويًا
// ---------------------------------------------------------------------------
bot.action('admin_activate', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stages = await db.listStages();
  await ctx.answerCbQuery();
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  return ctx.reply('اختر المرحلة:', stagesKeyboard(stages, 'admin_act_stage'));
});

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
  const subjectId = Number(ctx.match[1]);
  await db.activateLesson(subjectId, LESSON_ACTIVE_HOURS, 'manual', null);
  await ctx.answerCbQuery('تم التفعيل ✅');
  return ctx.editMessageText(`تم تفعيل الدرس لهذه المادة، وسيبقى متاحًا لتسجيل الحضور لمدة ${LESSON_ACTIVE_HOURS} ساعة ✅`);
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — التقارير (CSV)
// ---------------------------------------------------------------------------
bot.action('admin_reports', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stages = await db.listStages();
  await ctx.answerCbQuery();
  if (stages.length === 0) return ctx.reply('لا توجد مراحل بعد.');
  return ctx.reply('اختر المرحلة لعرض تقرير الحضور:', stagesKeyboard(stages, 'admin_report_stage'));
});

bot.action(/admin_report_stage:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const stageId = Number(ctx.match[1]);
  const rows = await db.getStageReport(stageId);
  await ctx.answerCbQuery();

  if (rows.length === 0) {
    return ctx.reply('لا توجد بيانات كافية بعد لهذه المرحلة (تأكد من وجود طلبة ومواد ودروس مفعّلة).');
  }

  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, { name: r.full_name, subjects: [] });
    byStudent.get(r.student_id).subjects.push({
      name: r.subject_name,
      total: Number(r.total_lessons),
      attended: Number(r.attended_lessons),
    });
  }

  const subjectNames = [...new Set(rows.map((r) => r.subject_name))];
  const header = ['ت', 'اسم الطالب', ...subjectNames.flatMap((s) => [`${s} - حضر`, `${s} - الإجمالي`])];
  const lines = [header.join(',')];

  let i = 1;
  for (const { name, subjects } of byStudent.values()) {
    const cells = [i++, `"${name}"`];
    for (const sName of subjectNames) {
      const found = subjects.find((s) => s.name === sName);
      cells.push(found ? found.attended : 0, found ? found.total : 0);
    }
    lines.push(cells.join(','));
  }

  const csv = '\uFEFF' + lines.join('\n');
  return ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf-8'),
    filename: `تقرير_حضور_مرحلة_${stageId}.csv`,
  });
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — إدارة الطلبة (بحث / تعديل / حذف)
// ---------------------------------------------------------------------------
bot.action('admin_students', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id, { action: 'admin_awaiting_student_search' });
  await ctx.answerCbQuery();
  return ctx.reply('أرسل اسم الطالب (كليًا أو جزئيًا) للبحث عنه:');
});

bot.action(/stu_select:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  const student = await db.getStudentById(studentId);
  await ctx.answerCbQuery();
  if (!student) return ctx.reply('الطالب غير موجود (ربما حُذف).');
  return ctx.reply(`الطالب: ${student.full_name}\nالمرحلة: ${student.stage_name}`, studentActionsKeyboard(studentId));
});

bot.action(/stu_edit_name:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  userState.set(ctx.from.id, { action: 'admin_awaiting_new_name', studentId });
  await ctx.answerCbQuery();
  return ctx.reply('أدخل الاسم الجديد للطالب:');
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

bot.action(/stu_delete_confirm:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  return ctx.reply(
    'هل أنت متأكد من حذف هذا الطالب؟ سيُحذف معه كامل سجل حضوره ولا يمكن التراجع.',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ نعم، احذف', `stu_delete:${studentId}`)],
      [Markup.button.callback('إلغاء', 'noop')],
    ])
  );
});

bot.action(/stu_delete:(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const studentId = Number(ctx.match[1]);
  await db.deleteStudent(studentId);
  await ctx.answerCbQuery('تم الحذف ✅');
  return ctx.editMessageText('تم حذف الطالب وكامل سجله ✅');
});

// ---------------------------------------------------------------------------
// لوحة الأدمن — ربط قناة بمرحلة
// ---------------------------------------------------------------------------
bot.action('admin_link_channel', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  userState.set(ctx.from.id, { action: 'admin_awaiting_channel_forward' });
  await ctx.answerCbQuery();
  return ctx.reply(
    'الخطوات:\n' +
      '1) أضِف هذا البوت كأدمن داخل قناة تليجرام الخاصة بالمرحلة (صلاحية نشر الرسائل كافية).\n' +
      '2) حوّل (Forward) أي منشور من داخل تلك القناة إلى هذا الشات الآن.\n\n' +
      'سأتعرف على القناة تلقائيًا من الرسالة المُحوَّلة.'
  );
});

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
      'من الآن، أي منشور في القناة يحتوي على مقطع صوتي أو رابط يوتيوب مع هاشتاغ اسم المادة (مثل #المحاسبة) سيُفعّل الدرس تلقائيًا لهذه المادة، ويصل إشعار لطلبة المرحلة.'
  );
});

bot.action('admin_list_channels', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('غير مصرح.');
  const channels = await db.listChannelsWithStage();
  await ctx.answerCbQuery();
  if (channels.length === 0) return ctx.reply('لا توجد قنوات مرتبطة بعد.');
  const lines = channels.map((c) => `• ${c.title || c.telegram_chat_id} → ${c.stage_name}`);
  return ctx.reply('القنوات المرتبطة حاليًا:\n' + lines.join('\n'));
});

// ---------------------------------------------------------------------------
// الاستماع لمنشورات القنوات وتفعيل الدروس تلقائيًا
// ---------------------------------------------------------------------------
bot.on('channel_post', async (ctx) => {
  try {
    const message = ctx.channelPost;
    const chatId = message.chat.id;
    const channel = await db.getChannelByChatId(chatId);
    if (!channel) return; // قناة غير مرتبطة بأي مرحلة — تجاهل

    const audio = hasAudioContent(message);
    const youtubeLink = extractYoutubeLink(message);
    if (!audio && !youtubeLink) return; // منشور عادي (إعلان نصي مثلًا) وليس درسًا

    const hashtags = extractHashtags(message);
    if (hashtags.length === 0) return; // لا يمكن تحديد المادة بدون هاشتاغ

    let subject = null;
    for (const tag of hashtags) {
      subject = await db.findSubjectByHashtag(channel.stage_id, tag);
      if (subject) break;
    }
    if (!subject) return; // لم يُطابَق الهاشتاغ أي مادة معروفة في هذه المرحلة

    const recent = await db.getRecentLessonForSubject(subject.id, DEDUPE_MINUTES);
    if (recent) return; // منع تكرار تفعيل نفس الدرس بسبب منشورات متعددة عنه

    await db.activateLesson(subject.id, LESSON_ACTIVE_HOURS, 'channel', youtubeLink || null);

    await sendToStageStudents(
      channel.stage_id,
      `📢 تم نشر درس جديد في مادة "${subject.name}".\nافتح البوت واضغط "📚 دروس اليوم" ثم "✅ تم الاستماع" بعد الاستماع للدرس.\nمتاح لمدة ${LESSON_ACTIVE_HOURS} ساعة من الآن.`
    );
  } catch (err) {
    console.error('خطأ أثناء معالجة منشور القناة:', err);
  }
});

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
            `⏰ تذكير: لم تسجّل حضورك بعد في مادة "${lesson.subject_name}". تبقّى حوالي ${hoursLeft} ساعة قبل انتهاء المهلة.`
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
async function main() {
  await db.initSchema();
  console.log('تم تجهيز قاعدة البيانات ✅');
  await bot.launch();
  console.log('البوت يعمل الآن ✅');

  setInterval(checkReminders, 10 * 60 * 1000); // فحص كل 10 دقائق
  checkReminders();
}

main().catch((err) => {
  console.error('فشل تشغيل البوت:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
