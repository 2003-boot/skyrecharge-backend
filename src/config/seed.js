import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const seed = async () => {
  try {
    // Agent de test
    const agentPasswordHash = await bcrypt.hash('Agent@2026!', 12);
    await pool.query(
    `INSERT INTO agents (name, phone, password_hash, balance, score)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone) DO NOTHING`,
    ['Agent Test', '+22507000001', agentPasswordHash, 10000, 100]
    );
    console.log('✅ Agent test créé !');
    console.log('📱 Téléphone: +22507000001');
    console.log('🔑 Mot de passe: Agent@2026!');
  } catch (error) {
    console.error('❌ Erreur seed:', error.message);
  } finally {
    await pool.end();
  }
};

seed();