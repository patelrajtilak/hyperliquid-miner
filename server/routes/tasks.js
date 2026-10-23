const express = require('express');
const router = express.Router();
const { db, getSetting, transaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/tasks
 * List active tasks + user completion status
 */
router.get('/', requireAuth, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, ut.status as user_status, ut.claimed_at
    FROM tasks t
    LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = ?
    WHERE t.is_active = 1
    ORDER BY t.sort_order ASC, t.id ASC
  `).all(req.user.id);

  res.json({
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      reward: t.reward,
      type: t.type,
      targetUrl: t.target_url,
      status: t.user_status || 'available',
      claimedAt: t.claimed_at
    }))
  });
});

/**
 * POST /api/tasks/:id/complete
 * Mark task as completed (for channel/twitter we trust client + optional verification)
 * For production channel verify use Telegram Bot API getChatMember
 */
router.post('/:id/complete', requireAuth, (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND is_active = 1').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const existing = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(req.user.id, taskId);
  if (existing && (existing.status === 'completed' || existing.status === 'claimed')) {
    return res.status(400).json({ error: 'Task already completed' });
  }

  // For channel type – in production call Telegram API. Here we accept completion
  // and mark as completed. Admin can later verify.
  if (!existing) {
    db.prepare(`
      INSERT INTO user_tasks (user_id, task_id, status, completed_at)
      VALUES (?, ?, 'completed', datetime('now'))
    `).run(req.user.id, taskId);
  } else {
    db.prepare(`
      UPDATE user_tasks SET status = 'completed', completed_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);
  }

  res.json({ success: true, status: 'completed' });
});

/**
 * POST /api/tasks/:id/claim
 * Claim reward after completion
 */
router.post('/:id/claim', requireAuth, (req, res) => {
  try {
    const result = transaction(() => {
      const taskId = parseInt(req.params.id, 10);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND is_active = 1').get(taskId);
      if (!task) throw new Error('Task not found');

      const ut = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(req.user.id, taskId);
      if (!ut || ut.status !== 'completed') {
        throw new Error('Task not completed yet');
      }
      if (ut.status === 'claimed') {
        throw new Error('Reward already claimed');
      }

      db.prepare(`
        UPDATE user_tasks SET status = 'claimed', claimed_at = datetime('now') WHERE id = ?
      `).run(ut.id);

      db.prepare(`
        UPDATE users SET balance = balance + ?, total_mined = total_mined + ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(task.reward, task.reward, req.user.id);

      db.prepare(`
        INSERT INTO activity_log (user_id, action, details) VALUES (?, 'task_claim', ?)
      `).run(req.user.id, JSON.stringify({ taskId, reward: task.reward }));

      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
      return { reward: task.reward, balance: Number(user.balance.toFixed(4)) };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
