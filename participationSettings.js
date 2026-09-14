'use strict';
const {appError,positiveInt}=require('./integrity');
async function initParticipationSettings(pool){
  await pool.query(`ALTER TABLE stage_seasons ADD COLUMN IF NOT EXISTS discussion_grouping BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE mubahatha_groups ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES mubahatha_groups(id);
    CREATE TABLE IF NOT EXISTS group_membership_history (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES mubahatha_groups(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP NOT NULL, ended_at TIMESTAMP NOT NULL,
      UNIQUE(student_id,group_id,assigned_at)
    );
    CREATE INDEX IF NOT EXISTS idx_membership_history_student ON group_membership_history(student_id,subject_id,stage_season_id);
    CREATE TABLE IF NOT EXISTS subject_study_settings (
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY(subject_id,stage_season_id)
    );
    CREATE OR REPLACE FUNCTION participation_enabled(sid INTEGER, ssid INTEGER) RETURNS BOOLEAN
    LANGUAGE SQL STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM subjects sub JOIN stage_seasons ss ON ss.stage_id=sub.stage_id
        JOIN stages st ON st.id=ss.stage_id
        LEFT JOIN subject_study_settings cfg ON cfg.subject_id=sub.id AND cfg.stage_season_id=ss.id
        WHERE sub.id=sid AND ss.id=ssid AND st.stage_type<>'lessons_only' AND COALESCE(cfg.enabled,true))
    $$;
    CREATE OR REPLACE FUNCTION discussion_group_root(gid INTEGER) RETURNS INTEGER LANGUAGE SQL STABLE AS $$
      WITH RECURSIVE chain AS (
        SELECT id,merged_into_id FROM mubahatha_groups WHERE id=gid
        UNION SELECT g.id,g.merged_into_id FROM mubahatha_groups g JOIN chain c ON g.id=c.merged_into_id
      ) SELECT id FROM chain WHERE merged_into_id IS NULL LIMIT 1
    $$;
    CREATE OR REPLACE FUNCTION discussion_group_label(gid INTEGER) RETURNS TEXT LANGUAGE SQL STABLE AS $$
      SELECT CASE WHEN ss.discussion_grouping OR g.merged_into_id IS NOT NULL THEN g.title ELSE 'المرحلة كاملة' END
      FROM mubahatha_groups g JOIN stage_seasons ss ON ss.id=g.stage_season_id WHERE g.id=gid
    $$;`);
}
// Caller holds a stage-season lock. Reuse the existing sole group: historical
// sessions, memberships, timestamps and report snapshots must never be recreated.
async function ensureWholeStageGroup(c,subjectId,seasonId){
  await c.query('SELECT pg_advisory_xact_lock($1::int,$2::int)',[subjectId,seasonId]);
  const groups=(await c.query('SELECT * FROM mubahatha_groups WHERE subject_id=$1 AND stage_season_id=$2 AND merged_into_id IS NULL ORDER BY id',[subjectId,seasonId])).rows;
  if(groups.length>1)throw appError('توجد عدة مجموعات لهذه المادة في الموسم. لا يمكن تحويلها تلقائيًا إلى مرحلة كاملة مع دمج سجلاتها.','GROUPS_EXIST',409);
  if(groups.length)return groups[0];
  return (await c.query(`INSERT INTO mubahatha_groups(subject_id,stage_season_id,group_number,title,capacity)
    VALUES($1,$2,1,'المرحلة كاملة',10000) RETURNING *`,[subjectId,seasonId])).rows[0];
}
function createParticipationSettings(pool){
  async function save(seasonId,{grouped,enabledSubjectIds},actor){
    positiveInt(seasonId);
    if(typeof grouped!=='boolean'||!Array.isArray(enabledSubjectIds)||enabledSubjectIds.length>500)throw appError('حدد تنظيم المباحثات والمواد المشمولة.');
    const ids=[...new Set(enabledSubjectIds.map(id=>positiveInt(id)))];
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const season=(await c.query(`SELECT ss.*,st.stage_type FROM stage_seasons ss JOIN stages st ON st.id=ss.stage_id
        WHERE ss.id=$1 FOR UPDATE OF ss`,[seasonId])).rows[0];
      if(!season?.is_active)throw appError('إعدادات الموسم المؤرشف متاحة للاطلاع فقط.','ARCHIVED',409);
      if(season.stage_type==='lessons_only'&&ids.length)throw appError('هذه المرحلة مخصصة للدروس فقط.');
      const subjects=(await c.query('SELECT id FROM subjects WHERE stage_id=$1',[season.stage_id])).rows;
      if(ids.some(id=>!subjects.some(s=>s.id===id)))throw appError('إحدى المواد لا تنتمي إلى المرحلة.');
      const previous=(await c.query('SELECT * FROM subject_study_settings WHERE stage_season_id=$1',[seasonId])).rows;
      // Do not remove participation in the middle of a live attendance window.
      const live=(await c.query(`SELECT 1 FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
        WHERE g.stage_season_id=$1 AND NOT(g.subject_id=ANY($2::int[]))
          AND ((s.is_closed=false AND s.closes_at>now()) OR s.end_closes_at>now()) LIMIT 1`,[seasonId,ids])).rows[0];
      if(live)throw appError('انتظر انتهاء تسجيل حضور المباحثة الجارية قبل استبعاد مادتها.','SESSION_OPEN',409);
      let mergedGroups=0, movedMemberships=0, pausedSlots=0;
      if(!grouped){
        if(season.discussion_grouping){
          const running=(await c.query(`SELECT 1 FROM mubahatha_sessions s JOIN mubahatha_groups g ON g.id=s.group_id
            WHERE g.stage_season_id=$1 AND ((s.is_closed=false AND s.closes_at>now()) OR s.end_closes_at>now()) LIMIT 1`,[seasonId])).rows[0];
          if(running)throw appError('انتظر انتهاء المباحثة الجارية ومهلة حضور النهاية قبل دمج المجموعات.','SESSION_OPEN',409);
        }
        // Consistent lock order with allocation: stage, students, groups.
        await c.query(`SELECT id FROM students WHERE id IN (SELECT student_id FROM group_memberships WHERE stage_season_id=$1) ORDER BY id FOR UPDATE`,[seasonId]);
        for(const sub of subjects){
          const groups=(await c.query(`SELECT * FROM mubahatha_groups WHERE subject_id=$1 AND stage_season_id=$2 AND merged_into_id IS NULL ORDER BY id FOR UPDATE`,[sub.id,seasonId])).rows;
          if(groups.length>1){
            const target=groups.find(g=>g.is_active)||groups[0],oldIds=groups.filter(g=>g.id!==target.id).map(g=>g.id);
            await c.query(`INSERT INTO group_membership_history(student_id,group_id,subject_id,stage_season_id,assigned_at,ended_at)
              SELECT student_id,group_id,subject_id,stage_season_id,assigned_at,now() FROM group_memberships WHERE group_id=ANY($1::int[])
              ON CONFLICT DO NOTHING`,[oldIds]);
            movedMemberships+=(await c.query('UPDATE group_memberships SET group_id=$2,assigned_at=now() WHERE group_id=ANY($1::int[]) RETURNING id',[oldIds,target.id])).rowCount;
            await c.query('UPDATE mubahatha_groups SET is_active=false,merged_into_id=$2 WHERE id=ANY($1::int[])',[oldIds,target.id]);
            await c.query('UPDATE mubahatha_groups SET is_active=true WHERE id=$1',[target.id]);
            // Different group timetables must not become multiple compulsory meetings.
            pausedSlots+=(await c.query('UPDATE schedule_slots SET is_active=false WHERE subject_id=$1 AND stage_season_id=$2 AND is_active=true RETURNING id',[sub.id,seasonId])).rowCount;
            mergedGroups+=oldIds.length;
          }else if(!groups.length&&ids.includes(sub.id))await ensureWholeStageGroup(c,sub.id,seasonId);
        }
      }
      // Re-enabling numbered capacity cannot leave an already overfilled group.
      if(grouped&&!season.discussion_grouping){
        const mixed=(await c.query(`SELECT m.student_id FROM group_memberships m JOIN mubahatha_groups g ON g.id=m.group_id WHERE m.stage_season_id=$1 GROUP BY m.student_id HAVING COUNT(DISTINCT g.group_number)>1 LIMIT 1`,[seasonId])).rows[0];
        if(mixed)throw appError('المواد الحالية تحمل أرقام مجموعات مختلفة. أبقِ تنظيم المرحلة كاملًا لهذا الموسم أو أنشئ تقسيمًا موحدًا في الموسم الجديد.','GROUP_NUMBER_CONFLICT',409);
        await c.query('DELETE FROM student_group_numbers WHERE stage_season_id=$1',[seasonId]);
        const full=(await c.query(`SELECT 1 FROM mubahatha_groups g WHERE g.stage_season_id=$1
          AND g.capacity<(SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id) LIMIT 1`,[seasonId])).rows[0];
        if(full)throw appError('ارفع سعة المجموعات لتناسب أعداد الطلبة قبل تفعيل التقسيم.','GROUP_CAPACITY',409);
      }
      await c.query('UPDATE stage_seasons SET discussion_grouping=$2 WHERE id=$1',[seasonId,grouped]);
      for(const sub of subjects)await c.query(`INSERT INTO subject_study_settings(subject_id,stage_season_id,enabled) VALUES($1,$2,$3)
        ON CONFLICT(subject_id,stage_season_id) DO UPDATE SET enabled=EXCLUDED.enabled`,[sub.id,seasonId,ids.includes(sub.id)]);
      await c.query(`INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data)
        VALUES($1,'participation_settings','stage_season',$2,$3::jsonb,$4::jsonb)`,[actor,seasonId,
        JSON.stringify({grouped:season.discussion_grouping,subjects:previous}),JSON.stringify({grouped,enabledSubjectIds:ids,mergedGroups,movedMemberships,pausedSlots})]);
      await c.query('COMMIT');return {grouped,enabledSubjectIds:ids,mergedGroups,movedMemberships,pausedSlots};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return {save};
}
module.exports={initParticipationSettings,createParticipationSettings,ensureWholeStageGroup};
