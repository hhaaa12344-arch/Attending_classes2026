// telegramQueue.js — طابور إرسال عام لكل رسائل تليجرام.
// السبب: عند تزامن عدة حلقات بث (نشر درس لمرحلتين + تذكير + مباحثة) قد يتجاوز
// مجموعها حد تليجرام (~30 رسالة/ثانية) فيعيد الخطأ 429 وتضيع الرسائل. الطابور
// المركزي ينظّم المعدل مهما تعددت الحلقات، ويعطي رسائل المستخدم المباشرة أولوية على البث.

const DEFAULT_RATE = Number(process.env.TELEGRAM_RATE_PER_SEC || 25);
const MIN_INTERVAL_MS = Math.ceil(1000 / DEFAULT_RATE);
const MAX_RETRIES = 3;

// أولويات أصغر رقمًا تُرسل أولًا: 1 رسائل المستخدم المباشرة، 5 الإشعارات، 9 البث الجماعي.
const PRIORITY = { high: 1, normal: 5, low: 9 };

function createTelegramQueue(telegram) {
  const queue = [];
  let seq = 0;
  let draining = false;
  let pausedUntil = 0; // يُضبط عند 429 لاحترام retry_after

  function enqueue(method, args, { priority = PRIORITY.normal } = {}) {
    return new Promise((resolve, reject) => {
      // seq يحفظ ترتيب الوصول ضمن الأولوية الواحدة (FIFO)
      queue.push({ method, args, priority, seq: seq++, resolve, reject, attempts: 0 });
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      drain();
    });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const now = Date.now();
      if (pausedUntil > now) {
        await sleep(pausedUntil - now);
        continue;
      }
      const job = queue.shift();
      try {
        const result = await telegram[job.method](...job.args);
        job.resolve(result);
      } catch (err) {
        const code = err && err.response && err.response.error_code;
        const retryAfter = err && err.response && err.response.parameters
          && err.response.parameters.retry_after;

        if (code === 429) {
          // تجاوزنا الحد: نوقف الطابور كله المدة التي يطلبها تليجرام ثم نعيد المهمة
          pausedUntil = Date.now() + ((retryAfter || 1) * 1000);
          queue.unshift(job);
          continue;
        }
        // 403 حظر البوت / 400 محادثة غير موجودة: خطأ دائم لا يُعاد
        if (code === 403 || code === 400) {
          job.reject(err);
        } else if (job.attempts < MAX_RETRIES) {
          // خطأ شبكة مؤقت: إعادة محاولة محدودة
          job.attempts += 1;
          queue.unshift(job);
          await sleep(500 * job.attempts);
          continue;
        } else {
          job.reject(err);
        }
      }
      await sleep(MIN_INTERVAL_MS);
    }
    draining = false;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    PRIORITY,
    sendMessage: (chatId, text, extra, opts) =>
      enqueue('sendMessage', [chatId, text, extra], opts),
    sendDocument: (chatId, doc, extra, opts) =>
      enqueue('sendDocument', [chatId, doc, extra], opts),
    sendPhoto: (chatId, photo, extra, opts) =>
      enqueue('sendPhoto', [chatId, photo, extra], opts),
    pendingCount: () => queue.length,
  };
}

module.exports = { createTelegramQueue, PRIORITY };
