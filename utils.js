'use strict';

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma)(?:$|[?#])/i;

function normalizeHashtag(value = '') {
  return String(value)
    .normalize('NFKC')
    .trim()
    .replace(/^#+/u, '')
    .replace(/[\s\u0640]+/gu, '')
    .replace(/[^\p{L}\p{N}_]+/gu, '')
    .toLocaleLowerCase('ar');
}

function messageText(message = {}) {
  return message.caption || message.text || '';
}

function messageEntities(message = {}) {
  return message.caption_entities || message.entities || [];
}

function extractHashtags(message = {}) {
  const text = messageText(message);
  const tags = [];

  for (const entity of messageEntities(message)) {
    if (entity.type !== 'hashtag') continue;
    const tag = normalizeHashtag(text.substring(entity.offset, entity.offset + entity.length));
    if (tag) tags.push(tag);
  }

  if (tags.length === 0 && text.includes('#')) {
    const matches = text.match(/#[\p{L}\p{N}_\u0640]+/gu) || [];
    for (const match of matches) {
      const tag = normalizeHashtag(match);
      if (tag) tags.push(tag);
    }
  }

  return [...new Set(tags)];
}

function trimUrl(url = '') {
  return url.replace(/[\])}>،؛,.!?]+$/u, '');
}

function extractFirstUrl(message = {}) {
  const text = messageText(message);

  for (const entity of messageEntities(message)) {
    if (entity.type === 'text_link' && entity.url) return trimUrl(entity.url);
    if (entity.type === 'url') {
      const url = text.substring(entity.offset, entity.offset + entity.length);
      return trimUrl(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    }
  }

  const match = text.match(/(?:https?:\/\/|www\.)[^\s<>()]+/iu);
  if (!match) return null;
  const url = trimUrl(match[0]);
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function hasAudioContent(message = {}) {
  if (message.audio || message.voice) return true;
  const document = message.document;
  if (!document) return false;
  if (document.mime_type && document.mime_type.toLowerCase().startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.test(document.file_name || '');
}

function hasLessonContent(message = {}) {
  return Boolean(
    hasAudioContent(message) ||
      message.video ||
      message.video_note ||
      extractFirstUrl(message)
  );
}

// مضيفات روابط تُستخدم عادةً لنشر الدروس (صوت أو فيديو)
const MEDIA_HOSTS =
  /(?:^|\.)(?:youtube\.com|youtu\.be|drive\.google\.com|soundcloud\.com|vimeo\.com|dropbox\.com|mega\.nz|archive\.org|t\.me|telegram\.me)$/i;

// هل يبدو المنشور درسًا فعليًا (مرفق صوتي/مرئي أو رابط لمضيف وسائط)؟
// تُستخدم للتنبيه على منشور درس بلا هاشتاغ، من دون إزعاج الأدمن بكل إعلان يحتوي رابطًا عاديًا.
function looksLikeLessonMedia(message = {}) {
  if (hasAudioContent(message) || message.video || message.video_note) return true;
  const url = extractFirstUrl(message);
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    if (MEDIA_HOSTS.test(host)) return true;
  } catch (_) {
    return false;
  }
  return AUDIO_EXTENSIONS.test(url);
}

function telegramMessageLink(message = {}) {
  const chat = message.chat || {};
  if (!message.message_id) return null;
  if (chat.username) return `https://t.me/${chat.username}/${message.message_id}`;

  const chatId = String(chat.id || '');
  if (chatId.startsWith('-100')) {
    return `https://t.me/c/${chatId.slice(4)}/${message.message_id}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// تسمية مواسم المرحلة:
// - اسم الموسم يكتبه الأدمن كاملًا (مثل «الموسم الأول 2026»)، ويُحفظ كما هو.
// - البوت يضيف عند العرض فقط: وسمًا نسبيًا (الحالي/السابق) والتاريخ.
// - «الحالي» للموسم النشط، و«السابق» للموسم الذي أُغلق قبله مباشرة فقط.
//   المواسم الأقدم تُعرض باسمها وتاريخها دون وسم نسبي قد يلتبس بمرور السنين.
// ---------------------------------------------------------------------------
const SEASON_ORDINALS = [
  'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس',
  'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر',
];

// مساعد اختياري لاقتراح اسم افتراضي على الأدمن عند بدء موسم جديد.
function ordinalSeasonName(seasonNumber) {
  const n = Number(seasonNumber);
  if (!Number.isInteger(n) || n < 1) return 'الموسم';
  return SEASON_ORDINALS[n - 1] ? `الموسم ${SEASON_ORDINALS[n - 1]}` : `الموسم رقم ${n}`;
}

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

// row: { season_name, is_active, recency_rank, started_at, ended_at }
function formatSeasonLabel(row = {}) {
  const name = (row.season_name || '').trim() || 'موسم';
  const status = row.is_active ? ' (الحالي)' : Number(row.recency_rank) === 2 ? ' (السابق)' : '';
  const range = row.ended_at
    ? `${formatDate(row.started_at)} → ${formatDate(row.ended_at)}`
    : `منذ ${formatDate(row.started_at)}`;
  return `${name}${status} — ${range}`;
}

module.exports = {
  extractFirstUrl,
  extractHashtags,
  formatSeasonLabel,
  hasAudioContent,
  hasLessonContent,
  looksLikeLessonMedia,
  normalizeHashtag,
  ordinalSeasonName,
  telegramMessageLink,
};
