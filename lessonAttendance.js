'use strict';
const {positiveInt,pageOptions,appError}=require('./integrity');
function createLessonAttendance(pool){
  async function matrix({stageId,seasonId=null,q='',page=0,size=50,status='all'}={}){
    positiveInt(stageId);if(seasonId!=null)positiveInt(seasonId);
    if(!['all','active','archived'].includes(status)||String(q).length>150)throw appError('مرشحات حضور الدروس غير صالحة.');
    const p=pageOptions(page,size),c=await pool.connect();
    try{
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const season=(await c.query(`SELECT ss.id,ss.stage_id,COALESCE(ss.stage_name_snapshot,st.name) AS stage_name,se.name AS season_name,
        (now() AT TIME ZONE 'UTC') AS as_of FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id JOIN seasons se ON se.id=ss.season_id
        WHERE ss.stage_id=$1 AND (($2::int IS NULL AND ss.is_active=true) OR ss.season_id=$2)`,[stageId,seasonId])).rows[0];
      if(!season)throw appError('لا يوجد موسم لهذه المرحلة ضمن الاختيار الحالي.','NOT_FOUND',404);
      const subjects=(await c.query(`SELECT sub.id,sub.name,COUNT(l.id)::int AS total_lessons FROM subjects sub
        LEFT JOIN lessons l ON l.subject_id=sub.id AND l.stage_season_id=$1
          AND l.active_until <= $2::timestamp
        WHERE sub.stage_id=$3 GROUP BY sub.id ORDER BY sub.name,sub.id`,[season.id,season.as_of,stageId])).rows;
      const where=`FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.stage_season_id=$1
        AND st.full_name ILIKE $2 AND ($3='all' OR ($3='active' AND e.status='active') OR ($3='archived' AND e.status<>'active'))`;
      const args=[season.id,`%${String(q).replace(/[\\%_]/g,'\\$&')}%`,status];
      const total=Number((await c.query('SELECT COUNT(*) AS n '+where,args)).rows[0].n);
      const students=(await c.query(`SELECT st.id,st.full_name,e.status ${where} ORDER BY st.full_name,st.id LIMIT $4 OFFSET $5`,[...args,p.size,p.offset])).rows;
      const attended=(await c.query(`SELECT a.student_id,l.subject_id,COUNT(*)::int AS attended FROM attendance a JOIN lessons l ON l.id=a.lesson_id
        WHERE a.student_id=ANY($1::int[]) AND l.stage_season_id=$2
          AND l.active_until <= $3::timestamp
          AND a.listened_at >= l.activated_at AND a.listened_at <= l.active_until
        GROUP BY a.student_id,l.subject_id`,[students.map(s=>s.id),season.id,season.as_of])).rows;
      const counts=new Map(attended.map(r=>[r.student_id+':'+r.subject_id,r.attended]));
      const rows=students.map((s,i)=>({...s,sequence:p.offset+i+1,attendance:subjects.map(sub=>({subject_id:sub.id,attended:counts.get(s.id+':'+sub.id)||0,total:sub.total_lessons}))}));
      await c.query('COMMIT');return {season,subjects,rows,total,page:p.page,size:p.size};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {matrix};
}
module.exports={createLessonAttendance};
