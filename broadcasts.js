'use strict';

const { appError, positiveInt } = require('./integrity');

function createBroadcasts(pool) {
  async function recipients(client, actor, scope) {
    if (!['admin', 'teacher'].includes(actor.role)) throw appError('غير مصرح.','FORBIDDEN',403);
    if (!['all', 'subject', 'group'].includes(scope.kind)) throw appError('نطاق الإرسال غير صالح.');
    if (scope.kind === 'all') {
      if (actor.role !== 'admin') throw appError('الإرسال إلى جميع الطلبة متاح للإدارة فقط.','FORBIDDEN',403);
      const rows=(await client.query(`SELECT DISTINCT st.id,st.telegram_id FROM students st
        JOIN enrollments e ON e.student_id=st.id AND e.status='active'
        JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
        WHERE st.is_active=true AND st.telegram_id IS NOT NULL ORDER BY st.id`)).rows;
      return {rows,label:'جميع الطلبة في المواسم النشطة'};
    }
    const subjectId=positiveInt(scope.subjectId),seasonId=positiveInt(scope.seasonId);
    const subject=(await client.query(`SELECT sub.name,ss.id FROM subjects sub
      JOIN stage_seasons ss ON ss.stage_id=sub.stage_id AND ss.id=$2 AND ss.is_active=true
      WHERE sub.id=$1`,[subjectId,seasonId])).rows[0];
    if(!subject)throw appError('المادة أو الموسم غير متاح.','NOT_FOUND',404);
    if(actor.role==='teacher'){
      const allowed=(await client.query(`SELECT 1 FROM teaching_assignments ta
        JOIN teachers t ON t.id=ta.teacher_id AND t.is_active=true
        WHERE ta.teacher_id=$1 AND ta.subject_id=$2 AND ta.stage_season_id=$3`,
        [positiveInt(actor.teacherId),subjectId,seasonId])).rows[0];
      if(!allowed)throw appError('هذه المادة ليست ضمن موادك.','FORBIDDEN',403);
    }
    if(scope.kind==='subject'){
      const rows=(await client.query(`SELECT DISTINCT st.id,st.telegram_id FROM enrollments e
        JOIN students st ON st.id=e.student_id AND st.is_active=true
        WHERE e.stage_season_id=$1 AND e.status='active' AND st.telegram_id IS NOT NULL ORDER BY st.id`,[seasonId])).rows;
      return {rows,label:`مادة «${subject.name}»`};
    }
    const groupId=positiveInt(scope.groupId);
    const group=(await client.query(`SELECT discussion_group_label(g.id) AS title FROM mubahatha_groups g
      WHERE g.id=$1 AND g.subject_id=$2 AND g.stage_season_id=$3 AND g.is_active=true`,
      [groupId,subjectId,seasonId])).rows[0];
    if(!group)throw appError('المجموعة غير متاحة لهذه المادة.','NOT_FOUND',404);
    const rows=(await client.query(`SELECT DISTINCT st.id,st.telegram_id FROM group_memberships gm
      JOIN students st ON st.id=gm.student_id AND st.is_active=true
      JOIN enrollments e ON e.student_id=st.id AND e.stage_season_id=gm.stage_season_id AND e.status='active'
      WHERE gm.group_id=$1 AND gm.subject_id=$2 AND gm.stage_season_id=$3
        AND st.telegram_id IS NOT NULL ORDER BY st.id`,[groupId,subjectId,seasonId])).rows;
    return {rows,label:`مجموعة «${group.title}» في مادة «${subject.name}»`};
  }

  async function preview(actor,scope) {
    const target=await recipients(pool,actor,scope);
    return {recipientCount:target.rows.length,label:target.label};
  }

  async function send(actor,scope,message,requestKey) {
    const text=String(message||'').trim();
    if(!text||text.length>3000)throw appError('اكتب رسالة من 1 إلى 3000 حرف.');
    if(!requestKey||String(requestKey).length>150)throw appError('معرّف الطلب غير صالح.');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const target=await recipients(client,actor,scope);
      if(!target.rows.length)throw appError('لا يوجد طلبة مستلمون في هذا النطاق.','CONFLICT',409);
      const inserted=(await client.query(`INSERT INTO message_broadcasts
        (request_key,actor_id,actor_role,scope_kind,subject_id,stage_season_id,group_id,message_text,recipient_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(request_key) DO NOTHING RETURNING id,recipient_count`,
        [requestKey,actor.id,actor.role,scope.kind,scope.subjectId||null,scope.seasonId||null,
          scope.groupId||null,text,target.rows.length])).rows[0];
      if(!inserted){
        const prior=(await client.query('SELECT id,recipient_count FROM message_broadcasts WHERE request_key=$1 AND actor_id=$2',
          [requestKey,actor.id])).rows[0];
        if(!prior)throw appError('تعارض في معرّف الإرسال.','CONFLICT',409);
        await client.query('COMMIT');
        return {id:prior.id,recipientCount:Number(prior.recipient_count),repeated:true};
      }
      const header=actor.role==='admin'?'📣 رسالة من إدارة المعهد':'📣 رسالة من أستاذ المادة';
      const payload=JSON.stringify([`${header}\nإلى: ${target.label}\n\n${text}`,{}]);
      await client.query(`INSERT INTO notification_outbox(dedupe_key,chat_id,payload,priority,expires_at)
        SELECT 'broadcast:'||$1::text||':'||r.student_id::text,r.chat_id,$2::jsonb,9,now()+interval '7 days'
        FROM unnest($3::integer[],$4::bigint[]) AS r(student_id,chat_id)
        ON CONFLICT(dedupe_key) DO NOTHING`,[inserted.id,payload,
        target.rows.map(r=>Number(r.id)),target.rows.map(r=>Number(r.telegram_id))]);
      await client.query('COMMIT');
      return {id:inserted.id,recipientCount:target.rows.length,repeated:false};
    }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  }

  return {preview,send};
}

module.exports={createBroadcasts};
