'use strict';
const {positiveInt,pageOptions,appError}=require('./integrity');
function createDiscussionAttendance(pool){
  const eligibility=`FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
    JOIN group_memberships m ON m.group_id=g.id AND m.assigned_at<=s.opened_at
    JOIN students st ON st.id=m.student_id AND st.is_active=true
    JOIN enrollments en ON en.student_id=st.id AND en.stage_season_id=g.stage_season_id AND en.status='active'
    JOIN participation_modes pm ON pm.student_id=st.id AND pm.subject_id=g.subject_id AND pm.stage_season_id=g.stage_season_id
      AND pm.mode='mubahatha' AND pm.joined_mubahatha_at<=s.opened_at WHERE s.id=$1`;
  async function session(c,id,lock=false){
    const item=(await c.query(`SELECT s.*,g.subject_id,g.stage_season_id,sub.name AS subject_name,discussion_group_label(g.id) AS group_title,
      ss.is_active AS season_active,sg.is_active AS stage_active,g.is_active AS group_active,
      participation_enabled(g.subject_id,g.stage_season_id) AS enabled,s.opened_at<=now() AS started
      FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id JOIN subjects sub ON sub.id=g.subject_id
      JOIN stage_seasons ss ON ss.id=g.stage_season_id JOIN stages sg ON sg.id=ss.stage_id
      WHERE s.id=$1 ${lock?'FOR UPDATE OF s FOR SHARE OF g,ss,sg':''}`,[positiveInt(id)])).rows[0];
    if(!item)throw appError('المباحثة غير موجودة.','NOT_FOUND',404);
    if(lock&&(!item.season_active||!item.stage_active||!item.group_active||!item.enabled))throw appError('المباحثة في مرحلة أو مجموعة أو موسم غير نشط.','ARCHIVED',409);
    if(lock&&!item.started)throw appError('لا يمكن تسجيل حضور مباحثة قبل موعدها.','NOT_STARTED',409);
    return item;
  }
  async function options(id,q={}){
    const item=await session(pool,id),p=pageOptions(q.page||0,25),search=String(q.q||'').trim();
    if(search.length>150)throw appError('عبارة البحث طويلة.');
    const args=[item.id,'%'+search.replace(/[\\%_]/g,'\\$&')+'%'],filter=eligibility+' AND st.full_name ILIKE $2';
    const total=(await pool.query(`SELECT COUNT(*)::int AS total ${filter}`,args)).rows[0].total;
    const rows=(await pool.query(`SELECT st.id,st.full_name,
      EXISTS(SELECT 1 FROM mubahatha_attendance a WHERE a.session_id=s.id AND a.student_id=st.id AND a.phase='start') AS attended_start,
      EXISTS(SELECT 1 FROM mubahatha_attendance a WHERE a.session_id=s.id AND a.student_id=st.id AND a.phase='end') AS attended_end
      ${filter} ORDER BY st.full_name,st.id LIMIT $3 OFFSET $4`,[...args,p.size,p.offset])).rows;
    return {item,rows,total,page:p.page,size:p.size};
  }
  async function mark(id,body,actor){
    id=positiveInt(id);actor=positiveInt(actor);
    if(!Array.isArray(body.studentIds)||!body.studentIds.length||body.studentIds.length>500)throw appError('اختر من طالب واحد إلى 500 طالب.');
    const ids=[...new Set(body.studentIds.map(positiveInt))].sort((a,b)=>a-b);
    if(body.note!=null&&(typeof body.note!=='string'||body.note.length>500))throw appError('الملاحظة لا تتجاوز 500 حرف.');
    const c=await pool.connect();
    try{
      await c.query('BEGIN');const item=await session(c,id,true);
      if(positiveInt(body.subjectId)!==item.subject_id)throw appError('المادة لا تطابق المباحثة. حدّث القائمة.','CONFLICT',409);
      const students=(await c.query(`SELECT st.id ${eligibility} AND st.id=ANY($2::int[]) ORDER BY st.id FOR SHARE OF st,en,m,pm`,[id,ids])).rows;
      if(students.length!==ids.length)throw appError('أحد الطلبة ليس من طلبة المباحثات المؤهلين لهذه المجموعة وقت المباحثة. لم يُحفظ أي تغيير.','NOT_ELIGIBLE',409);
      const rows=(await c.query(`INSERT INTO mubahatha_attendance(session_id,student_id,phase,marked_by,admin_note)
        SELECT $1,student_id,phase,$3,$4 FROM unnest($2::int[]) AS student_id CROSS JOIN unnest(ARRAY['start','end']) AS phase
        ON CONFLICT(session_id,student_id,phase) DO NOTHING RETURNING student_id,phase`,[id,ids,'admin:'+actor,body.note?.trim()||null])).rows;
      if(rows.length)await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,after_data)
        VALUES($1,'selected_discussion_attendance','session',$2,$3::jsonb)`,[actor,id,JSON.stringify({subject_id:item.subject_id,group_id:item.group_id,records:rows,note:body.note?.trim()||null})]);
      await c.query('COMMIT');return {added:new Set(rows.map(r=>r.student_id)).size,records:rows.length,existing:ids.length-new Set(rows.map(r=>r.student_id)).size};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {options,mark};
}
module.exports={createDiscussionAttendance};
