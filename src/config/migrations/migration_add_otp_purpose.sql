-- Migration : ajoute la colonne purpose à otp_codes (distingue inscription
-- et récupération de compte, nécessaire pour la limite de 3 récupérations
-- OTP par semaine).
-- À exécuter une seule fois sur la base de prod (VPS) :
--   sudo -u postgres psql -d skyrecharge < migration_add_otp_purpose.sql

ALTER TABLE otp_codes
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) DEFAULT 'register';

-- Toute ligne existante sans valeur valide (NULL, ou autre chose que
-- 'register'/'recovery') est forcément une ancienne ligne d'inscription
-- -- la fonctionnalité "recovery" n'existait pas avant cette migration.
UPDATE otp_codes
  SET purpose = 'register'
  WHERE purpose IS NULL OR purpose NOT IN ('register', 'recovery');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'otp_codes_purpose_check'
  ) THEN
    ALTER TABLE otp_codes
      ADD CONSTRAINT otp_codes_purpose_check CHECK (purpose IN ('register', 'recovery'));
  END IF;
END $$;