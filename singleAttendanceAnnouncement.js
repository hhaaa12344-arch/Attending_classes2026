'use strict';
// إشعار لمرة واحدة بعد نشر التعديل: حضور المباحثات صار مرة واحدة.
// يصل لطلبة المباحثات فقط (من اختاروا نمط المباحثات في موسم نشط) ولجميع الأساتذة الفعّالين.
// مفتاح الإزالة المكرر ثابت، فلا يتكرر الإرسال عند إعادة تشغيل البوت.
const {enqueueNotification}=require('./outbox');
const TAG='single-attendance-2026-11';
const START_DELAY=Number(process.env.START_ATTENDANCE_DELAY_MINUTES||5);
const WINDOW=60-START_DELAY;

const studentText=()=>`📢 تحديث: تسجيل حضور المباحثات صار مرة واحدة

السلام عليكم ورحمة الله وبركاته،

تخفيفًا عليكم وتسهيلًا لكم، ألغينا تسجيل الحضور مرتين (البداية والنهاية)، وصار حضور المباحثة بضغطة واحدة فقط.

⏱ كيف يعمل الآن:
• يفتح زر «✅ تسجيل الحضور» بعد ${START_DELAY} دقائق من موعد المباحثة.
• يبقى متاحًا ${WINDOW} دقيقة، أي حتى نهاية وقت المباحثة.
• اضغطه مرة واحدة في أي لحظة ضمن هذه المدة، فيُحتسب حضورك كاملًا، ولا يوجد حضور ثانٍ ولا زر نهاية.

وفقكم الله وسدد خطاكم. 🌿`;

const teacherText=()=>`📢 تحديث على آلية حضور المباحثات

السلام عليكم ورحمة الله وبركاته،

تخفيفًا عن الطلبة وتسهيلًا عليهم، صار تسجيل الحضور في المباحثات مرة واحدة بدل مرتين.

ما الذي تغيّر:
• يفتح زر تسجيل الحضور للطلبة تلقائيًا بعد ${START_DELAY} دقائق من موعد المباحثة، ويبقى ${WINDOW} دقيقة حتى نهاية وقتها.
• يُحتسب حضور الطالب كاملًا بضغطة واحدة، وأُلغي حضور البداية وحضور النهاية المنفصلان.
• لم يعد هناك زر «إنهاء المباحثة وفتح حضور النهاية»، ولا حاجة لأي إجراء منكم لفتح الحضور أو إغلاقه.
• ستصلكم عند فتح الحضور رسالة تذكير بالموعد كالمعتاد.

شكرًا لجهودكم وتعاونكم. 🌿`;

async function queueSingleAttendanceAnnouncement(pool,{now=new Date()}={}) {
  const expires=new Date(now.getTime()+3*24*3600*1000);
  const students=(await pool.query(`SELECT DISTINCT st.telegram_id
    FROM students st
    JOIN enrollments e ON e.student_id=st.id AND e.status='active'
    JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
    JOIN participation_modes pm ON pm.student_id=st.id AND pm.stage_season_id=ss.id AND pm.mode='mubahatha'
    WHERE st.is_active=true AND st.telegram_id IS NOT NULL AND participation_enabled(pm.subject_id,ss.id)`)).rows;
  const teachers=(await pool.query(`SELECT DISTINCT telegram_id FROM teachers WHERE is_active=true AND telegram_id IS NOT NULL`)).rows;
  let queued=0;
  for(const [rows,text,who] of [[students,studentText(),'s'],[teachers,teacherText(),'t']]){
    for(const r of rows){
      const res=await enqueueNotification(pool,{key:`announce:${TAG}:${who}:${r.telegram_id}`,chatId:r.telegram_id,text,expiresAt:expires});
      queued+=res.rowCount;
    }
  }
  return {students:students.length,teachers:teachers.length,queued};
}
module.exports={queueSingleAttendanceAnnouncement,studentText,teacherText,TAG};
