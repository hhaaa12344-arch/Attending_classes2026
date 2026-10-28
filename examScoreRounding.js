'use strict';
// One-time migration; backups and changes commit atomically. Manual final grades stay intact.
async function roundExistingExamScores(pool) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE TABLE IF NOT EXISTS exam_score_rounding_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS exam_score_rounding_backup (kind TEXT NOT NULL, row_id INTEGER NOT NULL, original_data JSONB NOT NULL, PRIMARY KEY(kind,row_id));`);
    const marker=await c.query("INSERT INTO exam_score_rounding_migrations(name) VALUES('nearest-integer-v1') ON CONFLICT DO NOTHING RETURNING name");
    if(!marker.rowCount){await c.query('COMMIT');return {applied:false};}
    // Block exam submissions and corrections until the snapshot and recalculation are complete.
    await c.query('SELECT id FROM exams ORDER BY id FOR UPDATE');
    await c.query('SELECT id FROM final_grades ORDER BY id FOR UPDATE');
    await c.query(`INSERT INTO exam_score_rounding_backup(kind,row_id,original_data)
      SELECT 'attempt',a.id,to_jsonb(a) FROM exam_attempts a WHERE a.submitted_at IS NOT NULL AND a.score IS NOT NULL AND a.score<>round(a.score)`);
    await c.query(`INSERT INTO exam_score_rounding_backup(kind,row_id,original_data)
      SELECT 'final_grade',fg.id,to_jsonb(fg) FROM final_grades fg
      WHERE fg.finalized_at IS NOT NULL AND fg.edited_at IS NULL AND EXISTS (
        SELECT 1 FROM exam_attempts a JOIN exams e ON e.id=a.exam_id
        JOIN exam_score_rounding_backup b ON b.kind='attempt' AND b.row_id=a.id
        WHERE a.student_id=fg.student_id AND e.subject_id=fg.subject_id AND e.stage_season_id=fg.stage_season_id)`);
    const attempts=await c.query(`UPDATE exam_attempts SET score=round(score) WHERE id IN
      (SELECT row_id FROM exam_score_rounding_backup WHERE kind='attempt') RETURNING id`);
    const grades=await c.query(`UPDATE final_grades fg SET exams_score=t.score,total_score=t.score+fg.participation_score
      FROM (SELECT a.student_id,e.subject_id,e.stage_season_id,LEAST(15::numeric,SUM(a.score)) AS score
        FROM exam_attempts a JOIN exams e ON e.id=a.exam_id WHERE a.submitted_at IS NOT NULL
        GROUP BY a.student_id,e.subject_id,e.stage_season_id) t
      WHERE fg.id IN (SELECT row_id FROM exam_score_rounding_backup WHERE kind='final_grade')
        AND fg.student_id=t.student_id AND fg.subject_id=t.subject_id AND fg.stage_season_id=t.stage_season_id RETURNING fg.id`);
    await c.query('COMMIT');return {applied:true,attempts:attempts.rowCount,grades:grades.rowCount};
  } catch(err){await c.query('ROLLBACK');throw err;} finally{c.release();}
}
module.exports={roundExistingExamScores};
