import bcrypt from 'bcryptjs';
import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { assignOrderToAgent } from '../services/queue.service.js';
import { io } from '../server.js';

// ─── DASHBOARD ────────────────────────────────────────

// GET /api/admin/dashboard
export const getDashboard = async (req, res) => {
  try {
    // Stats commandes du jour
    const ordersToday = await db.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'queued') as queued,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COALESCE(SUM(fees) FILTER (WHERE status = 'completed'), 0) as revenue_today
       FROM orders
       WHERE DATE(created_at) = CURRENT_DATE`
    );

    // Stats commandes ce mois
    const ordersMonth = await db.query(
      `SELECT
        COUNT(*) as total,
        COALESCE(SUM(fees) FILTER (WHERE status = 'completed'), 0) as revenue_month
       FROM orders
       WHERE EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())
         AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())`
    );

    // Stats agents
    const agentsStats = await db.query(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_online = TRUE) as online,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'suspended') as suspended,
        COUNT(*) FILTER (WHERE status = 'blocked') as blocked
       FROM agents`
    );

    // Stats clients
    const usersStats = await db.query(
      `SELECT COUNT(*) as total FROM users WHERE is_active = TRUE`
    );

    // Agents en ligne avec leur statut temps réel
    const agentsOnline = await db.query(
      `SELECT
        a.id, a.name, a.phone, a.balance, a.score,
        a.status, a.is_online, a.commission_rate,
        COUNT(am.id) FILTER (WHERE am.status IN ('assigned','accepted','in_progress')) as active_missions,
        COUNT(am.id) FILTER (WHERE am.status = 'completed' AND DATE(am.created_at) = CURRENT_DATE) as completed_today
       FROM agents a
       LEFT JOIN agent_missions am ON a.id = am.agent_id
       GROUP BY a.id
       ORDER BY a.is_online DESC, a.score DESC`
    );

    // Dernières commandes (10)
    const recentOrders = await db.query(
      `SELECT
        o.id, o.order_type, o.beneficiary_phone, o.operator,
        o.amount, o.fees, o.total_amount, o.status, o.created_at,
        u.first_name as client_name,
        a.name as agent_name
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       LEFT JOIN agent_missions am ON am.order_id = o.id
         AND am.status NOT IN ('timeout', 'refused')
       LEFT JOIN agents a ON am.agent_id = a.id
       ORDER BY o.created_at DESC
       LIMIT 10`
    );

    // Alertes actives
    const alerts = await db.query(
      `SELECT
        'score_low' as type,
        id as entity_id,
        name,
        score as value
       FROM agents
       WHERE score < 20 AND status = 'active'
       UNION ALL
       SELECT
        'order_stuck' as type,
        id as entity_id,
        beneficiary_phone as name,
        EXTRACT(EPOCH FROM (NOW() - created_at))::int as value
       FROM orders
       WHERE status = 'queued'
         AND created_at < NOW() - INTERVAL '5 minutes'
       ORDER BY value DESC
       LIMIT 10`
    );

    return successResponse(res, {
      stats: {
        today: ordersToday.rows[0],
        month: ordersMonth.rows[0],
        agents: agentsStats.rows[0],
        users: usersStats.rows[0],
      },
      agentsOnline: agentsOnline.rows,
      recentOrders: recentOrders.rows,
      alerts: alerts.rows,
    });
  } catch (error) {
    console.error('Erreur getDashboard:', error);
    return errorResponse(res, 'Erreur dashboard', 500);
  }
};

// ─── GESTION AGENTS ───────────────────────────────────

// GET /api/admin/agents
export const getAgents = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params = [];
    let paramCount = 1;

    if (status) {
      whereClause = `WHERE a.status = $${paramCount++}`;
      params.push(status);
    }

    params.push(limit, offset);

    const result = await db.query(
      `SELECT
        a.id, a.name, a.phone, a.balance, a.score,
        a.status, a.is_online, a.commission_rate,
        a.total_missions, a.successful_missions, a.failed_missions,
        a.created_at,
        COALESCE(SUM(ae.amount + ae.bonus), 0) as total_earnings
       FROM agents a
       LEFT JOIN agent_earnings ae ON a.id = ae.agent_id
       ${whereClause}
       GROUP BY a.id
       ORDER BY a.created_at DESC
       LIMIT $${paramCount++} OFFSET $${paramCount}`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM agents ${whereClause}`,
      params.slice(0, -2)
    );

    return successResponse(res, {
      agents: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error('Erreur getAgents:', error);
    return errorResponse(res, 'Erreur récupération agents', 500);
  }
};

// GET /api/admin/agents/:id
export const getAgentDetail = async (req, res) => {
  try {
    const { id } = req.params;

    const agentResult = await db.query(
      `SELECT
        a.*,
        COALESCE(SUM(ae.amount + ae.bonus), 0) as total_earnings
       FROM agents a
       LEFT JOIN agent_earnings ae ON a.id = ae.agent_id
       WHERE a.id = $1
       GROUP BY a.id`,
      [id]
    );

    if (!agentResult.rows[0]) {
      return errorResponse(res, 'Agent introuvable', 404);
    }

    // Historique des missions (10 dernières)
    const missions = await db.query(
      `SELECT
        am.id, am.status, am.processing_time_seconds,
        am.created_at, am.completed_at,
        o.order_type, o.amount, o.beneficiary_phone
       FROM agent_missions am
       JOIN orders o ON am.order_id = o.id
       WHERE am.agent_id = $1
       ORDER BY am.created_at DESC
       LIMIT 10`,
      [id]
    );

    // Historique score (10 derniers)
    const scoreHistory = await db.query(
      `SELECT action, points, score_before, score_after, note, created_at
       FROM agent_score_history
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [id]
    );

    // Gains par semaine (4 dernières semaines)
    const weeklyEarnings = await db.query(
      `SELECT
        period_week, period_year,
        SUM(amount + bonus) as total
       FROM agent_earnings
       WHERE agent_id = $1
         AND created_at > NOW() - INTERVAL '4 weeks'
       GROUP BY period_week, period_year
       ORDER BY period_year DESC, period_week DESC`,
      [id]
    );

    return successResponse(res, {
      agent: agentResult.rows[0],
      missions: missions.rows,
      scoreHistory: scoreHistory.rows,
      weeklyEarnings: weeklyEarnings.rows,
    });
  } catch (error) {
    console.error('Erreur getAgentDetail:', error);
    return errorResponse(res, 'Erreur récupération agent', 500);
  }
};

// POST /api/admin/agents
export const createAgent = async (req, res) => {
  try {
    const { name, phone, password, commission_rate = 40 } = req.body;

    if (!name || !phone || !password) {
      return errorResponse(res, 'Nom, téléphone et mot de passe requis', 400);
    }

    const existing = await db.query(
      'SELECT id FROM agents WHERE phone = $1',
      [phone]
    );
    if (existing.rows.length > 0) {
      return errorResponse(res, 'Ce numéro est déjà utilisé', 409);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      `INSERT INTO agents (name, phone, password_hash, commission_rate, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, balance, score, status, commission_rate, created_at`,
      [name, phone, passwordHash, commission_rate, req.admin.id]
    );

    io.emit('agent:created', { agent: result.rows[0] });

    return successResponse(res, { agent: result.rows[0] }, 'Agent créé avec succès', 201);
  } catch (error) {
    console.error('Erreur createAgent:', error);
    return errorResponse(res, 'Erreur création agent', 500);
  }
};

// PATCH /api/admin/agents/:id/balance
export const updateAgentBalance = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note } = req.body;

    if (!amount || amount <= 0) {
      return errorResponse(res, 'Montant invalide', 400);
    }

    const result = await db.query(
      `UPDATE agents
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, balance`,
      [amount, id]
    );

    if (!result.rows[0]) return errorResponse(res, 'Agent introuvable', 404);

    io.emit('agent:balance_updated', {
      agentId: id,
      newBalance: result.rows[0].balance,
      amount,
    });

    return successResponse(res, {
      agent: result.rows[0],
    }, `Solde rechargé de ${amount} unités`);
  } catch (error) {
    console.error('Erreur updateAgentBalance:', error);
    return errorResponse(res, 'Erreur mise à jour solde', 500);
  }
};

// PATCH /api/admin/agents/:id/status
export const updateAgentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'suspended', 'blocked'].includes(status)) {
      return errorResponse(res, 'Statut invalide', 400);
    }

    const result = await db.query(
      `UPDATE agents
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, status`,
      [status, id]
    );

    if (!result.rows[0]) return errorResponse(res, 'Agent introuvable', 404);

    io.emit('agent:status_updated', {
      agentId: id,
      status,
    });

    return successResponse(res, { agent: result.rows[0] }, `Statut mis à jour : ${status}`);
  } catch (error) {
    console.error('Erreur updateAgentStatus:', error);
    return errorResponse(res, 'Erreur mise à jour statut', 500);
  }
};

// PATCH /api/admin/agents/:id/score
export const updateAgentScore = async (req, res) => {
  try {
    const { id } = req.params;
    const { points, note } = req.body;

    if (points === undefined) return errorResponse(res, 'Points requis', 400);

    const agentResult = await db.query(
      'SELECT score FROM agents WHERE id = $1',
      [id]
    );

    if (!agentResult.rows[0]) return errorResponse(res, 'Agent introuvable', 404);

    const currentScore = agentResult.rows[0].score;
    const newScore = currentScore + points;

    await db.query(
      `UPDATE agents SET score = $1, updated_at = NOW() WHERE id = $2`,
      [newScore, id]
    );

    await db.query(
      `INSERT INTO agent_score_history
       (agent_id, action, points, score_before, score_after, note)
       VALUES ($1, 'admin_adjustment', $2, $3, $4, $5)`,
      [id, points, currentScore, newScore, note || 'Ajustement manuel admin']
    );

    io.emit('agent:score_updated', { agentId: id, newScore, points });

    return successResponse(res, { newScore }, 'Score mis à jour');
  } catch (error) {
    console.error('Erreur updateAgentScore:', error);
    return errorResponse(res, 'Erreur mise à jour score', 500);
  }
};

// ─── GESTION COMMANDES ────────────────────────────────

// GET /api/admin/orders
export const getOrders = async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    let conditions = [];
    const params = [];
    let paramCount = 1;

    if (status) {
      conditions.push(`o.status = $${paramCount++}`);
      params.push(status);
    }
    if (type) {
      conditions.push(`o.order_type = $${paramCount++}`);
      params.push(type);
    }
    if (search) {
      conditions.push(`(o.beneficiary_phone ILIKE $${paramCount++} OR u.first_name ILIKE $${paramCount++})`);
      params.push(`%${search}%`, `%${search}%`);
      paramCount++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const result = await db.query(
      `SELECT
        o.id, o.order_type, o.beneficiary_phone, o.beneficiary_name,
        o.operator, o.amount, o.fees, o.total_amount, o.status,
        o.created_at, o.completed_at, o.failure_reason,
        u.first_name as client_name, u.phone as client_phone,
        a.name as agent_name
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       LEFT JOIN agent_missions am ON am.order_id = o.id
         AND am.status NOT IN ('timeout', 'refused')
       LEFT JOIN agents a ON am.agent_id = a.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${paramCount++} OFFSET $${paramCount}`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${whereClause}`,
      params.slice(0, -2)
    );

    return successResponse(res, {
      orders: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error('Erreur getOrders:', error);
    return errorResponse(res, 'Erreur récupération commandes', 500);
  }
};

// PATCH /api/admin/orders/:id/retry
export const retryOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );

    const order = orderResult.rows[0];
    if (!order) return errorResponse(res, 'Commande introuvable', 404);

    if (!['failed', 'queued'].includes(order.status)) {
      return errorResponse(res, 'Cette commande ne peut pas être relancée', 400);
    }

    await db.query(
      `UPDATE orders SET status = 'queued', failure_reason = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    assignOrderToAgent(id);

    return successResponse(res, {}, 'Commande relancée');
  } catch (error) {
    console.error('Erreur retryOrder:', error);
    return errorResponse(res, 'Erreur relance commande', 500);
  }
};

// PATCH /api/admin/orders/:id/refund
export const refundOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );

    const order = orderResult.rows[0];
    if (!order) return errorResponse(res, 'Commande introuvable', 404);

    if (order.status === 'refunded') {
      return errorResponse(res, 'Commande déjà remboursée', 400);
    }

    await db.query(
      `UPDATE orders SET status = 'refunded', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    io.emit('order:refunded', { orderId: id });

    return successResponse(res, {}, 'Commande marquée comme remboursée');
  } catch (error) {
    console.error('Erreur refundOrder:', error);
    return errorResponse(res, 'Erreur remboursement', 500);
  }
};

// ─── CONFIGURATION ────────────────────────────────────

// GET /api/admin/config
export const getConfig = async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM config ORDER BY key');
    const config = {};
    result.rows.forEach(row => { config[row.key] = row.value; });
    return successResponse(res, { config });
  } catch (error) {
    return errorResponse(res, 'Erreur récupération config', 500);
  }
};

// PATCH /api/admin/config
export const updateConfig = async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || typeof updates !== 'object') {
      return errorResponse(res, 'Updates requis', 400);
    }

    for (const [key, value] of Object.entries(updates)) {
      await db.query(
        `UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2`,
        [String(value), key]
      );
    }

    io.emit('config:updated', { updates });

    return successResponse(res, {}, 'Configuration mise à jour');
  } catch (error) {
    console.error('Erreur updateConfig:', error);
    return errorResponse(res, 'Erreur mise à jour config', 500);
  }
};

// ─── OFFRES OPÉRATEURS ────────────────────────────────

// GET /api/admin/offers
export const getAdminOffers = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM operator_offers ORDER BY operator, offer_type, price'
    );
    return successResponse(res, { offers: result.rows });
  } catch (error) {
    return errorResponse(res, 'Erreur récupération offres', 500);
  }
};

// POST /api/admin/offers
export const createOffer = async (req, res) => {
  try {
    const { operator, offer_type, name, description, price, validity, is_popular, is_new } = req.body;

    if (!operator || !offer_type || !name || !price) {
      return errorResponse(res, 'Données manquantes', 400);
    }

    const result = await db.query(
      `INSERT INTO operator_offers
       (operator, offer_type, name, description, price, validity, is_popular, is_new)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [operator, offer_type, name, description, price, validity, is_popular || false, is_new || false]
    );

    return successResponse(res, { offer: result.rows[0] }, 'Offre créée', 201);
  } catch (error) {
    console.error('Erreur createOffer:', error);
    return errorResponse(res, 'Erreur création offre', 500);
  }
};

// PATCH /api/admin/offers/:id
export const updateOffer = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, validity, is_active, is_popular, is_new } = req.body;

    const result = await db.query(
      `UPDATE operator_offers
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           price = COALESCE($3, price),
           validity = COALESCE($4, validity),
           is_active = COALESCE($5, is_active),
           is_popular = COALESCE($6, is_popular),
           is_new = COALESCE($7, is_new),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [name, description, price, validity, is_active, is_popular, is_new, id]
    );

    if (!result.rows[0]) return errorResponse(res, 'Offre introuvable', 404);

    return successResponse(res, { offer: result.rows[0] }, 'Offre mise à jour');
  } catch (error) {
    console.error('Erreur updateOffer:', error);
    return errorResponse(res, 'Erreur mise à jour offre', 500);
  }
};

// ─── STATISTIQUES ─────────────────────────────────────

// GET /api/admin/stats
export const getStats = async (req, res) => {
  try {
    const { period = '7days' } = req.query;

    let interval = '7 days';
    if (period === '30days') interval = '30 days';
    if (period === '90days') interval = '90 days';

    // Revenus par jour
    const revenueByDay = await db.query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_orders,
        COALESCE(SUM(fees) FILTER (WHERE status = 'completed'), 0) as revenue
       FROM orders
       WHERE created_at > NOW() - INTERVAL '${interval}'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`
    );

    // Répartition par type
    const byType = await db.query(
      `SELECT
        order_type,
        COUNT(*) as total,
        COALESCE(SUM(fees) FILTER (WHERE status = 'completed'), 0) as revenue
       FROM orders
       WHERE created_at > NOW() - INTERVAL '${interval}'
       GROUP BY order_type`
    );

    // Top agents
    const topAgents = await db.query(
      `SELECT
        a.name,
        COUNT(am.id) as missions,
        AVG(am.processing_time_seconds) as avg_time,
        a.score
       FROM agents a
       JOIN agent_missions am ON a.id = am.agent_id
       WHERE am.status = 'completed'
         AND am.created_at > NOW() - INTERVAL '${interval}'
       GROUP BY a.id
       ORDER BY missions DESC
       LIMIT 5`
    );

    return successResponse(res, {
      revenueByDay: revenueByDay.rows,
      byType: byType.rows,
      topAgents: topAgents.rows,
    });
  } catch (error) {
    console.error('Erreur getStats:', error);
    return errorResponse(res, 'Erreur stats', 500);
  }
};