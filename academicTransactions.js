'use strict';
const {appError,validScore}=require('./integrity');
const {examWindowSql,enrollmentSql}=require('./examAccess');

function createAcademicTransactions(pool) {
  async function isExamAvailable(examId,studentId) {
    return Boolean((await pool.query(`SELECT 1 FROM exams e
      JOIN stage_seasons ss ON ss.id=e.stage_season_id
      JOIN enrollments en ON en.stage_season_id=ss.id AND en.student_id=$2
      JOIN students st ON st.id=en.student_id
      WHERE e.id=$1 AND e.status='published' AND ${enrollmentSql} AND ${examWindowSql('e','$2')}`,[examId,studentId])).rowCount);
  }
  async function transaction(work) {
    const c=await pool.connect();
    try {await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async function startOrResumeAttempt(examId,studentId) {
    return transaction(async c=>{
      const exam=(await c.query(`SELECT e.* FROM exams e JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
        WHERE e.id=$1 AND e.status='published' AND ${examWindowSql('e','$2')} FOR SHARE OF e,ss`,[examId,studentId])).rows[0];
      if(!exam)throw appError('الامتحان مغلق حاليًا.','EXAM_CLOSED');
      const enrolled=(await c.query(`SELECT 1 FROM enrollments en JOIN students st ON st.id=en.student_id
        JOIN stage_seasons ss ON ss.id=en.stage_season_id
        WHERE en.student_id=$1 AND en.stage_season_id=$2 AND ${enrollmentSql} FOR SHARE OF en,st`,[studentId,exam.stage_season_id])).rows[0];
      if(!enrolled)throw appError('هذا الامتحان ليس لمرحلتك.','NOT_ENROLLED');
      const r=await c.query(`INSERT INTO exam_attempts(exam_id,student_id,total_questions)
        VALUES($1,$2,(SELECT COUNT(*) FROM exam_questions WHERE exam_id=$1))
        ON CONFLICT(exam_id,student_id) DO UPDATE SET student_id=EXCLUDED.student_id
        WHERE exam_attempts.submitted_at IS NULL RETURNING *`,[examId,studentId]);
      if(!r.rows[0])throw appError('سبق أن سلّمت هذا الامتحان.','ALREADY_SUBMITTED');
      return r.rows[0];
    });
  }
  async function submitAnswer(attemptId,questionId,answer) {
    return transaction(async c=>{
      // Lock parent before attempt, consistently with reopening and finalization.
      await c.query('SELECT e.id FROM exams e JOIN exam_attempts a ON a.exam_id=e.id WHERE a.id=$1 FOR SHARE OF e',[attemptId]);
      const a=(await c.query(`SELECT a.* FROM exam_attempts a JOIN exams e ON e.id=a.exam_id
        JOIN stage_seasons ss ON ss.id=e.stage_season_id AND ss.is_active=true
        JOIN enrollments en ON en.student_id=a.student_id AND en.stage_season_id=ss.id AND en.status='active'
        JOIN students st ON st.id=a.student_id AND st.is_active=true
        WHERE a.id=$1 AND a.submitted_at IS NULL AND e.status='published'
        AND ${enrollmentSql} AND ${examWindowSql('e','a.student_id')} FOR UPDATE OF a FOR SHARE OF e,ss,en,st`,[attemptId])).rows[0];
      if(!a)throw appError('انتهت مهلة الامتحان أو سُلّمت المحاولة.','EXAM_CLOSED');
      const q=(await c.query('SELECT * FROM exam_questions WHERE id=$1 AND exam_id=$2',[questionId,a.exam_id])).rows[0];
      if(!q)throw appError('السؤال لا ينتمي لهذه المحاولة.');
      const value=String(answer).trim();
      const allowed=q.question_type==='tf'?['صح','خطأ']:q.options;
      if(!Array.isArray(allowed)||!allowed.includes(value))throw appError('الإجابة ليست من الخيارات المتاحة.');
      return (await c.query(`INSERT INTO exam_answers(attempt_id,question_id,answer,is_correct)
        VALUES($1,$2,$3,$4) ON CONFLICT(attempt_id,question_id) DO NOTHING RETURNING *`,
      [attemptId,questionId,value,value===String(q.correct_answer).trim()])).rows[0];
    });
  }
  async function finalizeAttempt(attemptId,{onlyIfClosed=false}={}) {
    return transaction(async c=>{
      await c.query('SELECT e.id FROM exams e JOIN exam_attempts a ON a.exam_id=e.id WHERE a.id=$1 FOR SHARE OF e',[attemptId]);
      const a=(await c.query('SELECT * FROM exam_attempts WHERE id=$1 FOR UPDATE',[attemptId])).rows[0];
      if(!a)throw appError('المحاولة غير موجودة.');
      if(onlyIfClosed){
        const mayResume=(await c.query(`SELECT 1 FROM exams e WHERE e.id=$1 AND e.status='published'
          AND (${examWindowSql('e','$2')} OR EXISTS(SELECT 1 FROM exam_student_windows w
            WHERE w.exam_id=e.id AND w.student_id=$2 AND w.closes_at>now()))`,[a.exam_id,a.student_id])).rowCount;
        if(mayResume)return null;
      }
      if(a.submitted_at)return a;
      const stats=(await c.query(`SELECT (SELECT COUNT(*) FROM exam_questions WHERE exam_id=e.id)::int AS total,
        (SELECT COUNT(*) FROM exam_answers ans JOIN exam_questions q ON q.id=ans.question_id AND q.exam_id=e.id
          WHERE ans.attempt_id=$1 AND ans.is_correct=true)::int AS correct,e.max_score FROM exams e WHERE id=$2`,[attemptId,a.exam_id])).rows[0];
      const score=stats.total?Math.round(stats.correct/stats.total*Number(stats.max_score)):0;
      return (await c.query(`UPDATE exam_attempts SET submitted_at=now(),score=$2,correct_count=$3,total_questions=$4
        WHERE id=$1 RETURNING *`,[attemptId,score,stats.correct,stats.total])).rows[0];
    });
  }
  async function overrideStudentGrade(studentId,subjectId,seasonId,fields,actor) {
    const ex=fields.examsScore===undefined?null:validScore(fields.examsScore,15);
    const part=fields.participationScore===undefined?null:validScore(fields.participationScore,15);
    return (await pool.query(`INSERT INTO final_grades(student_id,subject_id,stage_season_id,exams_score,participation_score,total_score,edited_by,edited_at,finalized_at)
      SELECT $1,$2,$3,COALESCE($4::numeric,0),COALESCE($5::numeric,0),COALESCE($4,0)+COALESCE($5,0),$6,now(),now()
      WHERE EXISTS(SELECT 1 FROM enrollments en JOIN stage_seasons ss ON ss.id=en.stage_season_id AND ss.is_active=true
        JOIN subjects sub ON sub.stage_id=ss.stage_id WHERE en.student_id=$1 AND en.stage_season_id=$3 AND sub.id=$2 AND en.status='active')
      ON CONFLICT(student_id,subject_id,stage_season_id) DO UPDATE SET
        exams_score=COALESCE($4,final_grades.exams_score),participation_score=COALESCE($5,final_grades.participation_score),
        total_score=COALESCE($4,final_grades.exams_score)+COALESCE($5,final_grades.participation_score),edited_by=$6,edited_at=now()
      RETURNING *`,[studentId,subjectId,seasonId,ex,part,actor])).rows[0];
  }
  return {startOrResumeAttempt,submitAnswer,finalizeAttempt,isExamAvailable,overrideStudentGrade};
}
module.exports={createAcademicTransactions};
