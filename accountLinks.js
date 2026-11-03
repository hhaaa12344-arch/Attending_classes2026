'use strict';
// ربط حساب تليجرام جديد بسجل طالب موجود مباشرة من الأدمن، بلا كود نقل.
// السجل كله مرتبط بـ students.id لا بمعرّف تليجرام، فتغيير telegram_id ينقل كل شيء (حضور، مباحثات، امتحانات، درجات).
const {appError,positiveInt}=require('./integrity');

const idOf=(v)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw appError('معرّف الحساب غير صالح.');return n;};

function createAccountLinks(pool) {
  // تسجيل كل حساب غير مسجَّل يفتح البوت، ليختاره الأدمن من قائمة بدل أن يبحث عن معرّفه.
  const noteUnknown=(telegramId,displayName,username)=>pool.query(
    `INSERT INTO recent_unknown_accounts(telegram_id,display_name,username,last_seen) VALUES($1,$2,$3,now())
     ON CONFLICT(telegram_id) DO UPDATE SET display_name=EXCLUDED.display_name,username=EXCLUDED.username,last_seen=now()`,
    [telegramId,String(displayName||'').slice(0,200)||null,username||null]);

  const listRecent=()=>pool.query(
    `SELECT u.telegram_id,u.display_name,u.username,u.last_seen FROM recent_unknown_accounts u
     WHERE u.last_seen>now()-interval '3 days'
       AND NOT EXISTS(SELECT 1 FROM students s WHERE s.telegram_id=u.telegram_id)
       AND NOT EXISTS(SELECT 1 FROM teachers t WHERE t.telegram_id=u.telegram_id)
     ORDER BY u.last_seen DESC LIMIT 8`).then((r)=>r.rows);

  const describe=async(telegramId)=>(await pool.query(
    'SELECT display_name,username FROM recent_unknown_accounts WHERE telegram_id=$1',[telegramId])).rows[0]||null;

  // يتحقق من إمكانية الربط ويعيد بيانات المعاينة دون تعديل.
  async function check(studentId,newTelegramId,db=pool) {
    studentId=positiveInt(studentId);newTelegramId=idOf(newTelegramId);
    const student=(await db.query('SELECT id,full_name,telegram_id,is_active FROM students WHERE id=$1',[studentId])).rows[0];
    if(!student)throw appError('الطالب غير موجود.','NOT_FOUND',404);
    if(!student.is_active)throw appError('الطالب مؤرشف. أعد تفعيله أولًا.','CONFLICT',409);
    if(Number(student.telegram_id)===newTelegramId)throw appError('هذا الحساب مرتبط بالطالب أصلًا.','CONFLICT',409);
    const other=(await db.query('SELECT id,full_name FROM students WHERE telegram_id=$1',[newTelegramId])).rows[0];
    if(other)throw appError(`هذا الحساب مسجَّل لطالب آخر («${other.full_name}»). أرشف ذلك السجل أو عالجه أولًا.`,'ACCOUNT_IN_USE',409);
    const teacher=(await db.query('SELECT full_name FROM teachers WHERE telegram_id=$1',[newTelegramId])).rows[0];
    if(teacher)throw appError(`هذا الحساب مسجَّل كأستاذ («${teacher.full_name}»).`,'ACCOUNT_IN_USE',409);
    return student;
  }

  async function link(studentId,newTelegramId,actorId) {
    studentId=positiveInt(studentId);newTelegramId=idOf(newTelegramId);actorId=positiveInt(actorId);
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT id FROM students WHERE id=$1 FOR UPDATE',[studentId]);
      const student=await check(studentId,newTelegramId,c);
      await c.query(`UPDATE students SET telegram_id=$2,transfer_code=NULL,transfer_code_at=NULL WHERE id=$1`,[studentId,newTelegramId]);
      await c.query('DELETE FROM recent_unknown_accounts WHERE telegram_id=$1',[newTelegramId]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'link_student_account','student',$2,$3::jsonb,$4::jsonb)`,
        [actorId,studentId,JSON.stringify({telegram_id:Number(student.telegram_id)}),JSON.stringify({telegram_id:newTelegramId})]);
      await c.query('COMMIT');
      return {studentId,fullName:student.full_name,oldTelegramId:Number(student.telegram_id),newTelegramId};
    }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
  }
  return {noteUnknown,listRecent,describe,check,link};
}
module.exports={createAccountLinks};
