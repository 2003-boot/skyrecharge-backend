-- Migration corrective : la colonne purpose existait déjà en base avant la
-- première migration (essai précédent), avec DEFAULT 'general' -- comme
-- ADD COLUMN IF NOT EXISTS ne touche jamais une colonne déjà présente, ce
-- mauvais défaut n'a jamais été corrigé, ce qui fait planter toute
-- insertion qui ne précise pas purpose explicitement (register, login...).
-- À exécuter une seule fois sur la base de prod (VPS) :
--   sudo -u postgres psql -d skyrecharge < migration_fix_otp_purpose_default.sql

ALTER TABLE otp_codes ALTER COLUMN purpose SET DEFAULT 'register';

-- Corrige aussi les lignes déjà en base avec l'ancienne valeur par défaut
-- fautive -- ce sont forcément d'anciennes lignes d'inscription (la
-- fonctionnalité "recovery" n'existait pas avant tout ça).
UPDATE otp_codes SET purpose = 'register' WHERE purpose = 'general';
