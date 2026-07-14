import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const migrate = async () => {
  try {
    console.log('🚀 Démarrage de la migration...');
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    await pool.query(sql);
    console.log('✅ Migration terminée avec succès !');
    console.log('✅ Tables créées : users, admins, agents, orders, agent_missions,');
    console.log('✅ Données initiales insérées (config + offres opérateurs)');
  } catch (error) {
    console.error('❌ Erreur de migration:', error.message);
  } finally {
    await pool.end();
  }
};

migrate();