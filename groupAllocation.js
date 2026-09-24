'use strict';
const {appError,positiveInt}=require('./integrity');

// Memberships remain per subject. This row remembers the cohort even after
// removing the last membership; a new stage-season gets a new cohort.
async function initGroupAllocation(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS student_group_numbers (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    stage_season_id INTEGER NOT NULL REFERENCES stage_seasons(id) ON DELETE CASCADE,
    group_number INTEGER NOT NULL CHECK(group_number>0),
    PRIMARY KEY(student_id,stage_season_id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_numbers_season_number ON student_group_numbers(stage_season_id,group_number,student_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_student_season ON group_memberships(student_id,stage_season_id);
  CREATE OR REPLACE FUNCTION group_reserved_count(ssid INTEGER, gnumber INTEGER) RETURNS INTEGER
  LANGUAGE SQL STABLE AS $$
    SELECT COUNT(*)::int FROM (
      SELECT student_id FROM student_group_numbers WHERE stage_season_id=ssid AND group_number=gnumber
      UNION
      SELECT m.student_id FROM group_memberships m JOIN mubahatha_groups g ON g.id=m.group_id
      WHERE m.stage_season_id=ssid AND g.group_number=gnumber
    ) reserved
  $$;`);
}

function createGroupAllocation(pool) {
  async function transaction(studentId,subjectId,seasonId,run) {
    [studentId,subjectId,seasonId].forEach(positiveInt);
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      const season=(await c.query('SELECT discussion_grouping FROM stage_seasons WHERE id=$1 AND is_active=true FOR SHARE',[seasonId])).rows[0];
      // A seat belongs to the cohort across subjects; serialize reservations by season.
      await c.query('SELECT pg_advisory_xact_lock(734222,$1::int)',[seasonId]);
      // Shared by assignment and moves across ALL subjects, not subject locks.
      const student=(await c.query('SELECT id FROM students WHERE id=$1 FOR UPDATE',[studentId])).rows[0];
      if(!student)throw appError('الطالب غير موجود.');
      const eligible=await c.query(`SELECT 1 FROM students st JOIN enrollments e ON e.student_id=st.id
        JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
        JOIN subjects sub ON sub.stage_id=ss.stage_id
        WHERE st.id=$1 AND st.is_active=true AND e.status='active' AND sub.id=$2 AND ss.id=$3 AND participation_enabled(sub.id,ss.id)`,[studentId,subjectId,seasonId]);
      if(!eligible.rows[0])throw appError('الطالب غير مسجل في هذه المادة والموسم.');
      const result=await run(c,season);
      await c.query('COMMIT');
      return result;
    } catch(e) {await c.query('ROLLBACK');throw e;} finally {c.release();}
  }
  const memberships=async(c,studentId,seasonId)=>(await c.query(`SELECT g.*,m.assigned_at FROM group_memberships m
    JOIN mubahatha_groups g ON g.id=m.group_id WHERE m.student_id=$1 AND m.stage_season_id=$2 ORDER BY g.subject_id`,[studentId,seasonId])).rows;
  const saveNumber=(c,studentId,seasonId,number)=>c.query(`INSERT INTO student_group_numbers(student_id,stage_season_id,group_number)
    VALUES($1,$2,$3) ON CONFLICT(student_id,stage_season_id) DO UPDATE SET group_number=EXCLUDED.group_number`,[studentId,seasonId,number]);
  const unavailable=(reason,number)=>({group:null,created:false,full:reason==='GROUP_FULL',reason,groupNumber:number,
    message:reason==='GROUP_NUMBER_CONFLICT'?'توجد أرقام مجموعات مختلفة في سجلك. راجع الإدارة لتوحيدها.':
      number?`المجموعة رقم ${number} في هذه المادة ${reason==='GROUP_FULL'?'ممتلئة':'غير متاحة'}. راجع الإدارة لتوفيرها مع الحفاظ على رقم مجموعتك.`:'لا توجد مجموعة متاحة لهذه المادة. راجع الإدارة.'});

  async function assignStudentToGroup(studentId,subjectId,seasonId) {
    return transaction(studentId,subjectId,seasonId,async (c,season)=>{
      if(season.discussion_grouping===false){
        const group=await require('./participationSettings').ensureWholeStageGroup(c,subjectId,seasonId);
        if(!group.is_active)return unavailable('GROUP_UNAVAILABLE');
        const inserted=await c.query(`INSERT INTO group_memberships(group_id,student_id,subject_id,stage_season_id)
          VALUES($1,$2,$3,$4) ON CONFLICT(student_id,subject_id,stage_season_id) DO NOTHING RETURNING id`,[group.id,studentId,subjectId,seasonId]);
        return {group:{...group,title:'المرحلة كاملة',group_number:null,discussion_grouping:false},created:inserted.rowCount>0};
      }
      const current=await memberships(c,studentId,seasonId);
      const saved=(await c.query('SELECT group_number FROM student_group_numbers WHERE student_id=$1 AND stage_season_id=$2',[studentId,seasonId])).rows[0];
      const numbers=new Set(current.map(g=>Number(g.group_number)));
      if(saved)numbers.add(Number(saved.group_number));
      // Never silently rewrite old memberships or their historical reports.
      if(numbers.size>1)return unavailable('GROUP_NUMBER_CONFLICT');
      const number=[...numbers][0];
      if(number)await saveNumber(c,studentId,seasonId,number);
      const existing=current.find(g=>g.subject_id===subjectId);
      if(existing)return existing.is_active?{group:existing,created:false}:unavailable('GROUP_UNAVAILABLE',number);
      const candidates=(await c.query(`SELECT id FROM mubahatha_groups WHERE subject_id=$1 AND stage_season_id=$2
        AND is_active=true AND merged_into_id IS NULL AND ($3::int IS NULL OR group_number=$3) ORDER BY group_number`,[subjectId,seasonId,number??null])).rows;
      for(const candidate of candidates) {
        const g=(await c.query('SELECT * FROM mubahatha_groups WHERE id=$1 AND is_active=true FOR UPDATE',[candidate.id])).rows[0];
        if(!g)continue;
        const capacity=(await c.query(`SELECT MIN(capacity)::int AS minimum,
          group_reserved_count($1,$2) AS reserved
          FROM mubahatha_groups WHERE stage_season_id=$1 AND group_number=$2
            AND merged_into_id IS NULL AND participation_enabled(subject_id,stage_season_id)`,
          [seasonId,g.group_number])).rows[0];
        if(Number(capacity.reserved)+(number?0:1)>Number(capacity.minimum))continue;
        const count=Number((await c.query('SELECT COUNT(*) AS n FROM group_memberships WHERE group_id=$1',[g.id])).rows[0].n);
        if(count>=g.capacity)continue;
        await c.query('INSERT INTO group_memberships(group_id,student_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)',[g.id,studentId,subjectId,seasonId]);
        await saveNumber(c,studentId,seasonId,g.group_number);
        return {group:g,created:true};
      }
      return unavailable(candidates.length?'GROUP_FULL':'GROUP_UNAVAILABLE',number);
    });
  }

  async function moveStudentToGroup(studentId,subjectId,seasonId,targetId) {
    positiveInt(targetId);
    return transaction(studentId,subjectId,seasonId,async (c,season)=>{
      if(!season.discussion_grouping)throw appError('هذه المرحلة غير مقسمة؛ جميع الطلبة في مباحثة المادة نفسها.');
      const target=(await c.query(`SELECT * FROM mubahatha_groups WHERE id=$1 AND subject_id=$2 AND stage_season_id=$3 AND is_active=true`,[targetId,subjectId,seasonId])).rows[0];
      if(!target)throw appError('المجموعة غير موجودة أو غير نشطة.');
      const current=await memberships(c,studentId,seasonId);
      const saved=(await c.query('SELECT group_number FROM student_group_numbers WHERE student_id=$1 AND stage_season_id=$2',[studentId,seasonId])).rows[0];
      const subjects=[...new Set([subjectId,...current.map(g=>g.subject_id)])];
      // Deterministic group lock order prevents opposing student moves deadlocking.
      const targets=(await c.query(`SELECT * FROM mubahatha_groups WHERE stage_season_id=$1 AND group_number=$2
        AND subject_id=ANY($3::int[]) AND is_active=true ORDER BY id FOR UPDATE`,[seasonId,target.group_number,subjects])).rows;
      if(targets.length!==subjects.length)throw appError(`تعذر توحيد الرقم: أنشئ أو فعّل المجموعة رقم ${target.group_number} في جميع مواد الطالب أولًا.`,'GROUP_UNAVAILABLE');
      const capacity=(await c.query(`SELECT MIN(capacity)::int AS minimum,
        group_reserved_count($1,$2) AS reserved FROM mubahatha_groups
        WHERE stage_season_id=$1 AND group_number=$2 AND merged_into_id IS NULL
          AND participation_enabled(subject_id,stage_season_id)`,[seasonId,target.group_number])).rows[0];
      const alreadyReserved=Number(saved?.group_number)===target.group_number||current.some(g=>g.group_number===target.group_number);
      if(Number(capacity.reserved)+(alreadyReserved?0:1)>Number(capacity.minimum))
        throw appError(`تعذر النقل: المقاعد المحجوزة للمجموعة رقم ${target.group_number} ممتلئة في إحدى المواد. لم تتغير أي مجموعة.`,'GROUP_FULL');
      const changed=targets.filter(g=>!current.some(old=>old.id===g.id));
      for(const g of changed) {
        const n=Number((await c.query('SELECT COUNT(*) AS n FROM group_memberships WHERE group_id=$1',[g.id])).rows[0].n);
        if(n>=g.capacity)throw appError(`تعذر النقل: «${g.title||g.group_number}» ممتلئة. لم تتغير أي مجموعة.`,'GROUP_FULL');
      }
      for(const g of changed) {
        await c.query(`INSERT INTO group_memberships(group_id,student_id,subject_id,stage_season_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(student_id,subject_id,stage_season_id) DO UPDATE SET group_id=EXCLUDED.group_id,assigned_at=now()`,[g.id,studentId,g.subject_id,seasonId]);
        await c.query('UPDATE participation_modes SET joined_mubahatha_at=now() WHERE student_id=$1 AND subject_id=$2 AND stage_season_id=$3',[studentId,g.subject_id,seasonId]);
      }
      await saveNumber(c,studentId,seasonId,target.group_number);
      return {...targets.find(g=>g.id===targetId),moved_subject_ids:changed.map(g=>g.subject_id),
        previous_groups:current.map(g=>({subject_id:g.subject_id,group_id:g.id,group_number:g.group_number}))};
    });
  }
  return {assignStudentToGroup,moveStudentToGroup};
}
module.exports={initGroupAllocation,createGroupAllocation};
