import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';

// ─── GET /api/flyers (public — carrousel accueil mobile) ───────────────────
export const getActiveFlyers = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, image_url, link_url
       FROM flyers
       WHERE is_active = TRUE
       ORDER BY display_order ASC, created_at DESC`
    );
    return successResponse(res, { flyers: result.rows }, 'Flyers récupérés');
  } catch (error) {
    console.error('Erreur getActiveFlyers:', error);
    // Ne casse jamais l'accueil mobile pour un souci de flyers -- liste
    // vide plutôt qu'une erreur, le carrousel se masque simplement.
    return successResponse(res, { flyers: [] }, 'Flyers indisponibles (secours)');
  }
};

// ─── GET /api/admin/flyers (tous, y compris inactifs) ──────────────────────
export const getAllFlyers = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM flyers ORDER BY display_order ASC, created_at DESC`
    );
    return successResponse(res, { flyers: result.rows }, 'Flyers récupérés');
  } catch (error) {
    console.error('Erreur getAllFlyers:', error);
    return errorResponse(res, 'Erreur lors de la récupération des flyers', 500);
  }
};

// ─── POST /api/admin/flyers ─────────────────────────────────────────────────
export const createFlyer = async (req, res) => {
  try {
    const { image_url, link_url, display_order } = req.body;
    if (!image_url || !image_url.trim()) {
      return errorResponse(res, "URL de l'image requise", 400);
    }

    const result = await db.query(
      `INSERT INTO flyers (image_url, link_url, display_order)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [image_url.trim(), link_url?.trim() || null, display_order ?? 0]
    );
    return successResponse(res, { flyer: result.rows[0] }, 'Flyer créé', 201);
  } catch (error) {
    console.error('Erreur createFlyer:', error);
    return errorResponse(res, 'Erreur lors de la création du flyer', 500);
  }
};

// ─── PATCH /api/admin/flyers/:id ────────────────────────────────────────────
// Utilisé pour éditer l'URL/le lien, activer/désactiver, ou réordonner --
// un seul endpoint générique plutôt que 3 endpoints dédiés.
export const updateFlyer = async (req, res) => {
  try {
    const { id } = req.params;
    const { image_url, link_url, is_active, display_order } = req.body;

    const fields = [];
    const values = [];
    let i = 1;

    if (image_url !== undefined) { fields.push(`image_url = $${i++}`); values.push(image_url.trim()); }
    if (link_url !== undefined) { fields.push(`link_url = $${i++}`); values.push(link_url?.trim() || null); }
    if (is_active !== undefined) { fields.push(`is_active = $${i++}`); values.push(is_active); }
    if (display_order !== undefined) { fields.push(`display_order = $${i++}`); values.push(display_order); }

    if (fields.length === 0) {
      return errorResponse(res, 'Aucune modification fournie', 400);
    }
    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await db.query(
      `UPDATE flyers SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!result.rows[0]) return errorResponse(res, 'Flyer introuvable', 404);

    return successResponse(res, { flyer: result.rows[0] }, 'Flyer mis à jour');
  } catch (error) {
    console.error('Erreur updateFlyer:', error);
    return errorResponse(res, 'Erreur lors de la mise à jour du flyer', 500);
  }
};

// ─── DELETE /api/admin/flyers/:id ───────────────────────────────────────────
export const deleteFlyer = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`DELETE FROM flyers WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows[0]) return errorResponse(res, 'Flyer introuvable', 404);
    return successResponse(res, {}, 'Flyer supprimé');
  } catch (error) {
    console.error('Erreur deleteFlyer:', error);
    return errorResponse(res, 'Erreur lors de la suppression du flyer', 500);
  }
};