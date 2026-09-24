'use strict';
const {appError}=require('./integrity');

// This repair is tied to the stage named in the supplied 2026-09-24 backup.
const STAGE_NAME='المرحلة التمهيدية الدورة 22';
const ACTION='one_time_preliminary_22_group_1_to_2';
const MOVE_COUNT=13;

function createOneTimeCohortMove(pool){
  async function context(c){
    return (await c.query(`SELECT ss.id AS season_id,st.id AS stage_id
      FROM stages st JOIN stage_seasons ss ON ss.stage_id=st.id AND ss.is_active=true
      WHERE st.name=$1 AND ss.discussion_grouping=true`,[STAGE_NAME])).rows[0];
  }
  async function candidates(c,seasonId){
    return (await c.query(`WITH reserved AS (
      SELECT student_id FROM student_group_numbers WHERE stage_season_id=$1 AND group_number=1
      UNION
      SELECT m.student_id FROM group_memberships m JOIN mubahatha_groups g ON g.id=m.group_id
        WHERE m.stage_season_id=$1 AND g.group_number=1
    )
    SELECT st.id,st.full_name,COUNT(m.id)::int AS subject_count,
      COALESCE(string_agg(sub.name,'، ' ORDER BY sub.name),'لم يسجل في مادة') AS subjects
    FROM reserved r JOIN students st ON st.id=r.student_id AND st.is_active=true
      JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=$1 AND e.status='active'
      LEFT JOIN group_memberships m ON m.student_id=st.id AND m.stage_season_id=$1
      LEFT JOIN subjects sub ON sub.id=m.subject_id
    GROUP BY st.id,st.full_name ORDER BY st.full_name,st.id`,[seasonId])).rows;
  }
  async function status(){
    const stage=await context(pool);
    if(!stage)return {available:false,completed:false};
    const completed=Boolean((await pool.query(`SELECT 1 FROM admin_audit_log WHERE action=$1 AND entity_type='stage' AND entity_id=$2 LIMIT 1`,[ACTION,stage.stage_id])).rows[0]);
    if(completed)return {available:false,completed:true};
    const [students,groups]=await Promise.all([
      candidates(pool,stage.season_id),
      pool.query(`SELECT g.subject_id,g.group_number,g.capacity,g.is_active,participation_enabled(g.subject_id,g.stage_season_id) AS enabled
        FROM mubahatha_groups g WHERE g.stage_season_id=$1 AND g.group_number IN (1,2) AND g.merged_into_id IS NULL`,[stage.season_id])
    ]);
    const source=groups.rows.filter(g=>Number(g.group_number)===1&&g.enabled);
    const target=groups.rows.filter(g=>Number(g.group_number)===2&&g.enabled&&g.is_active);
    return {available:students.length>=MOVE_COUNT&&source.length>0&&source.every(g=>target.some(t=>t.subject_id===g.subject_id)),
      completed:false,sourceCount:students.length,targetCapacity:Math.min(...target.map(g=>Number(g.capacity))),students};
  }
  async function execute(studentIds,actorId){
    if(!Array.isArray(studentIds)||studentIds.length!==MOVE_COUNT||studentIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(studentIds).size!==MOVE_COUNT)
      throw appError('اختر 13 طالبًا مختلفًا من المجموعة 1.');
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const stage=await context(c);
      if(!stage)throw appError('المرحلة التمهيدية الدورة 22 غير متاحة الآن.','CONFLICT',409);
      await c.query('SELECT pg_advisory_xact_lock(734222,$1::int)',[stage.season_id]);
      if((await c.query(`SELECT 1 FROM admin_audit_log WHERE action=$1 AND entity_type='stage' AND entity_id=$2 LIMIT 1`,[ACTION,stage.stage_id])).rows[0])
        throw appError('استُخدم زر النقل لمرة واحدة سابقًا.','CONFLICT',409);
      const eligible=await candidates(c,stage.season_id);
      if(eligible.length<MOVE_COUNT||studentIds.some(id=>!eligible.some(st=>Number(st.id)===id)))
        throw appError('تغيّرت قائمة طلبة المجموعة 1. أعد تحميلها.','CONFLICT',409);
      const groups=(await c.query(`SELECT g.id,g.subject_id,g.group_number,g.capacity,g.is_active,
        participation_enabled(g.subject_id,g.stage_season_id) AS enabled
        FROM mubahatha_groups g WHERE g.stage_season_id=$1 AND g.group_number IN (1,2)
          AND g.merged_into_id IS NULL ORDER BY g.id FOR UPDATE`,[stage.season_id])).rows;
      const source=groups.filter(g=>Number(g.group_number)===1&&g.enabled);
      const target=groups.filter(g=>Number(g.group_number)===2&&g.enabled&&g.is_active);
      if(!source.length||source.some(g=>!target.some(t=>t.subject_id===g.subject_id)))
        throw appError('يجب توفير مجموعة 2 نشطة في جميع مواد المجموعة 1 أولًا.','GROUP_UNAVAILABLE',409);
      if(eligible.length-MOVE_COUNT>Math.min(...source.map(g=>Number(g.capacity))))
        throw appError('ازداد عدد حجوزات المجموعة 1؛ نقل 13 طالبًا وحده لن يكفي لسعتها الحالية. أعد فحص التوزيع.','GROUP_CAPACITY',409);
      const saved=(await c.query(`SELECT student_id,group_number FROM student_group_numbers
        WHERE stage_season_id=$1 AND student_id=ANY($2::int[])`,[stage.season_id,studentIds])).rows;
      if(saved.some(row=>Number(row.group_number)!==1))throw appError('تغيّر رقم مجموعة أحد الطلبة. أعد تحميل القائمة.','CONFLICT',409);
      const memberships=(await c.query(`SELECT m.*,g.group_number FROM group_memberships m
        JOIN mubahatha_groups g ON g.id=m.group_id
        WHERE m.stage_season_id=$1 AND m.student_id=ANY($2::int[]) ORDER BY m.id`,[stage.season_id,studentIds])).rows;
      if(memberships.some(m=>Number(m.group_number)!==1||!target.some(g=>g.subject_id===m.subject_id)))
        throw appError('سجل أحد الطلبة يتضمن مجموعة مختلفة أو مادة بلا مجموعة 2. لم يُنقل أحد.','CONFLICT',409);
      const count=(await c.query('SELECT group_reserved_count($1,2) AS n',[stage.season_id])).rows[0].n;
      if(Number(count)+MOVE_COUNT>Math.min(...target.map(g=>Number(g.capacity))))
        throw appError('المجموعة 2 لا تتسع للطلبة الثلاثة عشر في كل المواد.','GROUP_FULL',409);
      for(const g of target){
        const members=Number((await c.query('SELECT COUNT(*) AS n FROM group_memberships WHERE group_id=$1',[g.id])).rows[0].n);
        if(members+memberships.filter(m=>m.subject_id===g.subject_id).length>Number(g.capacity))
          throw appError('إحدى مجموعات المادة رقم 2 ممتلئة. لم يُنقل أحد.','GROUP_FULL',409);
      }
      for(const m of memberships){
        const destination=target.find(g=>g.subject_id===m.subject_id);
        await c.query(`INSERT INTO group_membership_history(student_id,group_id,subject_id,stage_season_id,assigned_at,ended_at)
          VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(student_id,group_id,assigned_at) DO NOTHING`,
          [m.student_id,m.group_id,m.subject_id,m.stage_season_id,m.assigned_at]);
        await c.query('UPDATE group_memberships SET group_id=$2,assigned_at=now() WHERE id=$1',[m.id,destination.id]);
        await c.query(`UPDATE participation_modes SET joined_mubahatha_at=now()
          WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3 AND mode='mubahatha'`,
          [m.student_id,m.subject_id,stage.season_id]);
      }
      for(const id of studentIds)await c.query(`INSERT INTO student_group_numbers(student_id,stage_season_id,group_number)
        VALUES($1,$2,2) ON CONFLICT(student_id,stage_season_id) DO UPDATE SET group_number=2`,[id,stage.season_id]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,$2,'stage',$3,$4::jsonb,$5::jsonb)`,[actorId,ACTION,stage.stage_id,
        JSON.stringify({season_id:stage.season_id,group_number:1,student_ids:studentIds}),
        JSON.stringify({season_id:stage.season_id,group_number:2,moved_count:MOVE_COUNT})]);
      await c.query('COMMIT');
      return {moved:MOVE_COUNT,sourceRemaining:eligible.length-MOVE_COUNT};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {status,execute};
}
module.exports={createOneTimeCohortMove};
