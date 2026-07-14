import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// NB : le seul seed qui existait ici (agent de test) a été retiré avec le
// système agent humain. Ce fichier ne fait plus rien pour l'instant —
// à compléter avec de vraies données de test si besoin (ex: offres
// opérateurs, admin de test...).
const seed = async () => {
  try {
    console.log('ℹ️  Aucun seed à exécuter pour le moment.');
  } catch (error) {
    console.error('❌ Erreur seed:', error.message);
  } finally {
    await pool.end();
  }
};

seed();