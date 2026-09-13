'use strict';

const DEFAULT_LINKS = [
  ['website', '🌐 الموقع الرسمي للمعهد', 'https://edu.turathalanbiaa.com/'],
  ['assistant', '🤖 بوت المعهد الذكي', 'https://t.me/assistant_turath_ai_bot'],
  ['library', '📚 مكتبة المعهد الإلكترونية', 'https://t.me/Library_of_Institute_bot'],
];
const PAGE_SIZE = 12;
const label = text => Array.from(String(text || '').replace(/[\r\n\t]/g, ' ')).slice(0, 60).join('');

function validateUrl(value, telegramOnly = false) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(raw)) throw Error('أرسل رابط HTTPS صالحًا دون مسافات.');
  let url;
  try { url = new URL(raw); } catch (_) { throw Error('الرابط غير صحيح.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('يجب أن يبدأ الرابط بـ https:// دون بيانات دخول أو منفذ.');
  if (telegramOnly && (!['t.me', 'telegram.me'].includes(url.hostname) || url.pathname === '/')) {
    throw Error('أرسل رابط القناة أو المجموعة على https://t.me/');
  }
  return url.href;
}

function createInstituteLinks(pool) {
  async function initSchema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS institute_links (
      key TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT,
      updated_by BIGINT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    ); ALTER TABLE channels ADD COLUMN IF NOT EXISTS public_link TEXT;`);
    for (const [key, title, url] of DEFAULT_LINKS) {
      await pool.query('INSERT INTO institute_links(key,title,url) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING', [key, title, url]);
    }
  }

  async function general() {
    return (await pool.query("SELECT * FROM institute_links ORDER BY CASE key WHEN 'website' THEN 1 WHEN 'assistant' THEN 2 ELSE 3 END, key")).rows;
  }

  // Membership and assignments are resolved again on each request, including page navigation.
  async function related(actor, kind, page = 0) {
    const args = [actor.studentId || 0, actor.teacherId || 0, Boolean(actor.admin), PAGE_SIZE + 1, page * PAGE_SIZE];
    const sql = kind === 'channels' ? `
      SELECT c.id::text AS id, c.telegram_chat_id, c.public_link AS url,
        concat_ws(' — ', st.name, c.title) AS title
      FROM channels c JOIN stage_seasons ss ON ss.id=c.stage_season_id AND ss.is_active=true
      JOIN stages st ON st.id=ss.stage_id AND st.is_active=true
      WHERE c.stage_id=ss.stage_id AND ($3 OR EXISTS (
        SELECT 1 FROM enrollments e JOIN students s ON s.id=e.student_id AND s.is_active=true
        WHERE e.student_id=$1 AND e.stage_season_id=ss.id AND e.status='active'
      ) OR EXISTS (
        SELECT 1 FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.teacher_id=$2 AND ta.stage_season_id=ss.id
      )) ORDER BY st.sort_order NULLS LAST, st.id, c.id LIMIT $4 OFFSET $5` : `
      SELECT g.id::text AS id, g.telegram_chat_id, g.invite_link AS url,
        concat_ws(' — ', st.name, sub.name, g.title) AS title
      FROM mubahatha_groups g JOIN subjects sub ON sub.id=g.subject_id
      JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
      JOIN stages st ON st.id=ss.stage_id AND st.is_active=true
      WHERE g.is_active=true AND sub.stage_id=ss.stage_id AND ($3 OR EXISTS (
        SELECT 1 FROM group_memberships m JOIN students s ON s.id=m.student_id AND s.is_active=true
        JOIN enrollments e ON e.student_id=m.student_id AND e.stage_season_id=m.stage_season_id AND e.status='active'
        WHERE m.student_id=$1 AND m.group_id=g.id AND m.subject_id=g.subject_id AND m.stage_season_id=g.stage_season_id
      ) OR EXISTS (
        SELECT 1 FROM teaching_assignments ta JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.teacher_id=$2 AND ta.subject_id=g.subject_id AND ta.stage_season_id=g.stage_season_id
      )) ORDER BY st.sort_order NULLS LAST, st.id, sub.id, g.group_number, g.id LIMIT $4 OFFSET $5`;
    const rows = (await pool.query(sql, args)).rows;
    return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
  }

  async function target(kind, id) {
    if (kind === 'general') return (await pool.query('SELECT key AS id,title,url FROM institute_links WHERE key=$1', [id])).rows[0];
    if (!/^[1-9]\d{0,9}$/.test(String(id))) return null;
    const sql = kind === 'channels'
      ? `SELECT c.id,c.title,c.public_link AS url FROM channels c JOIN stage_seasons ss ON ss.id=c.stage_season_id AND ss.is_active=true WHERE c.id=$1`
      : `SELECT g.id,concat_ws(' — ',sub.name,g.title) AS title,g.invite_link AS url FROM mubahatha_groups g
         JOIN subjects sub ON sub.id=g.subject_id JOIN stage_seasons ss ON ss.id=g.stage_season_id AND ss.is_active=true
         WHERE g.id=$1 AND g.is_active=true`;
    return (await pool.query(sql, [id])).rows[0];
  }

  async function save(kind, id, input, adminId) {
    let url = input === '-' ? null : validateUrl(input, kind !== 'general');
    let result;
    if (kind === 'general') {
      result = await pool.query('UPDATE institute_links SET url=$2,updated_by=$3,updated_at=now() WHERE key=$1 RETURNING key', [id, url, adminId]);
    } else if (kind === 'channels') {
      // Empty means explicitly hidden; NULL means discover the existing Telegram link.
      if (input === '-') url = '';
      result = await pool.query(`UPDATE channels c SET public_link=$2 FROM stage_seasons ss
        WHERE c.id=$1 AND ss.id=c.stage_season_id AND ss.is_active=true RETURNING c.id`, [id, url]);
    } else if (kind === 'groups') {
      result = await pool.query(`UPDATE mubahatha_groups g SET invite_link=$2 FROM stage_seasons ss
        WHERE g.id=$1 AND g.is_active=true AND ss.id=g.stage_season_id AND ss.is_active=true RETURNING g.id`, [id, url]);
    } else throw Error('نوع رابط غير صالح.');
    if (!result.rows.length) throw Error('لم يعد هذا الرابط متاحًا؛ افتح قائمة الروابط من جديد.');
  }

  // Read existing metadata only: never create or rotate invitation links.
  const chatCache = new Map();
  async function channelUrl(row, telegram) {
    if (row.url === '') return null;
    if (row.url) { try { return validateUrl(row.url, true); } catch (_) { return null; } }
    const key = String(row.telegram_chat_id);
    const cached = chatCache.get(key);
    if (cached && cached.until > Date.now()) return cached.url;
    let url = null;
    try {
      const chat = await telegram.getChat(row.telegram_chat_id);
      const candidate = chat.username ? `https://t.me/${chat.username}` : chat.invite_link;
      if (candidate) url = validateUrl(candidate, true);
    } catch (_) { /* A missing permission must not prevent the other links from appearing. */ }
    if (chatCache.size >= 500) chatCache.delete(chatCache.keys().next().value);
    chatCache.set(key, { url, until: Date.now() + (url ? 300000 : 30000) });
    return url;
  }

  function install(h) {
    const { bot, Markup, userState } = h;
    const cb = (text, data) => ({ ...Markup.button.callback(label(text), data), style: 'primary' });
    const link = (text, url) => ({ ...Markup.button.url(label(text), url), style: 'success' });
    const adminAllowed = ctx => ctx.chat?.type === 'private' && h.isAdmin(ctx) && !h.isInPreview(ctx);
    async function actorFor(ctx) {
      if (ctx.chat?.type !== 'private') return null;
      const preview = h.getPreview(ctx);
      const student = preview?.role === 'teacher' ? null : await h.effectiveStudent(ctx);
      const teacher = preview?.role === 'student' ? null : await h.effectiveTeacher(ctx);
      const admin = h.isAdmin(ctx) && !h.isInPreview(ctx);
      if (!admin && !student?.is_active && !teacher?.is_active) return null;
      return { student, studentId: student?.is_active ? student.id : 0,
        teacherId: teacher?.is_active ? teacher.id : 0, admin };
    }
    async function render(ctx, text, buttons, actor) {
      const extra = { ...Markup.inlineKeyboard(buttons), link_preview_options: { is_disabled: true } };
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery();
        try { return await ctx.editMessageText(text, extra); }
        catch (err) { if (String(err.description || err.message).includes('message is not modified')) return; throw err; }
      }
      if (actor?.student) return h.replyStudentScreen(ctx, actor.student, text, extra);
      return ctx.reply(text, extra);
    }
    async function home(ctx) {
      const actor = await actorFor(ctx);
      if (!actor) return ctx.reply('افتح البوت من حسابك المسجّل في المحادثة الخاصة.');
      userState.delete(ctx.from.id);
      const buttons = [];
      for (const item of await general()) {
        if (!item.url) continue;
        try { buttons.push([link(item.title, validateUrl(item.url))]); } catch (_) { /* Skip legacy invalid URL. */ }
      }
      buttons.push([cb('📡 قنواتي الدراسية', 'il_view:channels:0')],
        [cb('👥 مجموعات مباحثاتي', 'il_view:groups:0')], [cb('↩️ القائمة الرئيسية', 'il_view:menu:0')]);
      return render(ctx, '🔗 روابط المعهد\nاختر الخدمة أو اعرض القنوات والمجموعات المرتبطة بحسابك.', buttons, actor);
    }
    async function view(ctx, kind, page) {
      const actor = await actorFor(ctx);
      if (!actor) return ctx.answerCbQuery('غير مصرح.', { show_alert: true });
      if (kind === 'home') return home(ctx);
      if (kind === 'menu') {
        userState.delete(ctx.from.id);
        await ctx.answerCbQuery();
        const menu = actor.admin ? h.adminMainMenu() : actor.teacherId ? h.teacherMainMenu() : h.studentMainMenu(actor.student);
        if (actor.student) return h.replyStudentScreen(ctx, actor.student, 'القائمة الرئيسية:', menu);
        await ctx.deleteMessage().catch(() => {});
        return ctx.reply('القائمة الرئيسية:', menu);
      }
      const result = await related(actor, kind, page);
      const buttons = [], missing = [];
      for (const row of result.rows) {
        let url = null;
        if (kind === 'channels') url = await channelUrl(row, ctx.telegram);
        else if (row.url) { try { url = validateUrl(row.url, true); } catch (_) {} }
        if (url) buttons.push([link(row.title, url)]);
        else missing.push(`• ${label(row.title)}`);
      }
      const nav = [];
      if (page) nav.push(cb('السابق', `il_view:${kind}:${page - 1}`));
      if (result.more) nav.push(cb('التالي', `il_view:${kind}:${page + 1}`));
      if (nav.length) buttons.push(nav);
      buttons.push([cb('↩️ روابط المعهد', 'il_view:home:0')]);
      let text = `${kind === 'channels' ? '📡 قنواتي الدراسية' : '👥 مجموعات مباحثاتي'} — الصفحة ${page + 1}`;
      if (!result.rows.length) text += '\nلا توجد ارتباطات في هذه الصفحة ضمن المواسم الحالية.';
      if (missing.length) text += '\n\nلم تُضف روابط متاحة لهذه الارتباطات بعد؛ راجع الإدارة:\n' + missing.join('\n');
      return render(ctx, text, buttons, actor);
    }
    async function adminHome(ctx) {
      if (!adminAllowed(ctx)) return ctx.callbackQuery ? ctx.answerCbQuery('غير مصرح.') : ctx.reply('هذه الإدارة متاحة للأدمن في المحادثة الخاصة وخارج المعاينة.');
      userState.delete(ctx.from.id);
      return render(ctx, '⚙️ إدارة روابط المعهد\nاختر نوع الروابط لتعديله:', [
        [cb('🌐 الروابط العامة', 'il_admin:general:0')],
        [cb('📡 روابط القنوات الدراسية', 'il_admin:channels:0')],
        [cb('👥 روابط مجموعات المباحثات', 'il_admin:groups:0')],
      ]);
    }
    bot.hears('🔗 روابط المعهد', home);
    bot.hears('⚙️ إدارة روابط المعهد', adminHome);
    bot.action(/^il_view:(home|menu|channels|groups):(\d{1,6})$/, ctx => view(ctx, ctx.match[1], Number(ctx.match[2])));
    bot.action(/^il_admin:(home|general|channels|groups):(\d{1,6})$/, async ctx => {
      if (!adminAllowed(ctx)) return ctx.answerCbQuery('غير مصرح.');
      const kind = ctx.match[1], page = Number(ctx.match[2]);
      userState.delete(ctx.from.id);
      if (kind === 'home') return adminHome(ctx);
      const result = kind === 'general' ? { rows: (await general()).map(r => ({ ...r, id: r.key })) } : await related({ admin: true }, kind, page);
      const buttons = result.rows.map(row => [cb(`✏️ ${row.title}`, `il_edit:${kind}:${row.id}:${page}`)]);
      const nav = [];
      if (page) nav.push(cb('السابق', `il_admin:${kind}:${page - 1}`));
      if (result.more) nav.push(cb('التالي', `il_admin:${kind}:${page + 1}`));
      if (nav.length) buttons.push(nav);
      buttons.push([cb('↩️ أنواع الروابط', 'il_admin:home:0')]);
      return render(ctx, `اختر الرابط لتعديله — الصفحة ${page + 1}` + (!result.rows.length ? '\nلا توجد ارتباطات حالية.' : ''), buttons);
    });
    bot.action(/^il_edit:(general|channels|groups):([a-z]+|\d{1,10}):(\d{1,6})$/, async ctx => {
      if (!adminAllowed(ctx)) return ctx.answerCbQuery('غير مصرح.');
      const [, kind, id, page] = ctx.match;
      const item = await target(kind, id);
      if (!item) return ctx.answerCbQuery('لم يعد الرابط متاحًا.');
      userState.set(ctx.from.id, { action: 'institute_link_edit', kind, id, page });
      return render(ctx, `تعديل: ${label(item.title)}\nالرابط الحالي: ${item.url || 'غير محدد'}\n\nأرسل الرابط الجديد فقط، أو أرسل - لإخفاء الرابط.\nهذا يعدّل رابط الانتقال؛ تغيير ربط القناة بالمرحلة يتم من «ربط قناة بمرحلة».`,
        [[cb('↩️ رجوع / إلغاء التعديل', `il_admin:${kind}:${page}`)]]);
    });
    bot.on('text', async (ctx, next) => {
      const state = userState.get(ctx.from?.id);
      if (state?.action !== 'institute_link_edit') return next();
      const text = ctx.message.text.trim();
      if (text.startsWith('/') || ['↩️ رجوع', '❌ إلغاء العملية'].includes(text) || h.menus.some(m => m.has(text))) {
        userState.delete(ctx.from.id); return next();
      }
      if (!adminAllowed(ctx)) { userState.delete(ctx.from.id); return ctx.reply('لم تعد لديك صلاحية تعديل الروابط.'); }
      try { await save(state.kind, state.id, text, ctx.from.id); }
      catch (err) { return ctx.reply(`لم يُحفظ التعديل: ${err.message}\nأعد إرسال الرابط أو اضغط رجوع.`); }
      userState.delete(ctx.from.id);
      return render(ctx, '✅ حُفظ التعديل. سيظهر عند فتح قائمة الروابط مجددًا.',
        [[cb('↩️ قائمة الروابط', `il_admin:${state.kind}:${state.page}`)]]);
    });
  }
  return { initSchema, general, related, save, target, channelUrl, install };
}
module.exports = { createInstituteLinks, validateUrl };
