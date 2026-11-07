'use strict';
// عرض سؤال الامتحان: الخيارات القصيرة تظهر على الأزرار نفسها، أما إن كان أي خيار طويلًا
// فتُكتب كل الخيارات كاملة في نص الرسالة، وتبقى الأزرار حروفًا قصيرة (أ، ب، ج، د) تُضغط للاختيار.
const LONG_OPTION_LENGTH = 28;
const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز', 'ح', 'ط', 'ي'];

function buildExamQuestionView({ header, prompt, options, callbackFor, limitText }) {
  const long = options.some((o) => String(o).length > LONG_OPTION_LENGTH);
  if (!long) {
    return {
      text: `${header}\n\n${prompt}`,
      rows: options.map((o, i) => [{ text: limitText(o, 50), callback_data: callbackFor(i) }]),
    };
  }
  const list = options.map((o, i) => `${LETTERS[i] || i + 1}) ${o}`).join('\n\n');
  const buttons = options.map((_, i) => ({ text: LETTERS[i] || String(i + 1), callback_data: callbackFor(i) }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return { text: `${header}\n\n${prompt}\n\n${list}\n\n👇 اضغط حرف الإجابة الصحيحة:`, rows };
}
module.exports = { buildExamQuestionView, LONG_OPTION_LENGTH };
