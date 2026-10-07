// Migración previa al arranque: cifra en kyc_records los datos que sigan en
// texto plano (documento, fechas, teléfono) y llena sus índices ciegos.
//
// Corre ANTES de que TypeORM sincronice el esquema porque las fechas pasan de
// 'date' a 'varchar': si lo hiciera TypeORM, borraría la columna con sus datos.
// Todo ocurre en una transacción: o se migra completo o no cambia nada.
// Es idempotente: lo ya cifrado ('v1:...') no se vuelve a tocar.
const { Client } = require('pg');
const { blindIndex, decryptField, encryptField, isEncrypted } = require('../dist/common/crypto/field-crypto');

async function main() {
  if (!process.env.KYC_ENCRYPTION_KEY) {
    console.log('[kyc-crypto] KYC_ENCRYPTION_KEY no configurada: kyc-service no arrancará sin ella.');
    return;
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const { rows: exists } = await db.query(`SELECT to_regclass('public.kyc_records') AS t`);
    if (!exists[0].t) return; // base nueva: TypeORM crea la tabla ya con el esquema cifrado

    await db.query('BEGIN');
    for (const col of ['fecha_nacimiento', 'fecha_expedicion']) {
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'kyc_records' AND column_name = $1`,
        [col],
      );
      if (rows[0]?.data_type === 'date') {
        await db.query(`ALTER TABLE kyc_records ALTER COLUMN ${col} TYPE varchar USING to_char(${col}, 'YYYY-MM-DD')`);
      }
    }
    await db.query('ALTER TABLE kyc_records ADD COLUMN IF NOT EXISTS numero_documento_hash varchar(64)');
    await db.query('ALTER TABLE kyc_records ADD COLUMN IF NOT EXISTS telefono_hash varchar(64)');

    const { rows } = await db.query(
      `SELECT id, numero_documento, fecha_nacimiento, fecha_expedicion, telefono
         FROM kyc_records
        WHERE numero_documento NOT LIKE 'v1:%' OR fecha_nacimiento NOT LIKE 'v1:%'
           OR fecha_expedicion NOT LIKE 'v1:%' OR (telefono IS NOT NULL AND telefono NOT LIKE 'v1:%')
           OR numero_documento_hash IS NULL OR (telefono IS NOT NULL AND telefono_hash IS NULL)
        FOR UPDATE`,
    );
    for (const r of rows) {
      const plain = (v) => (v === null ? null : isEncrypted(v) ? decryptField(v) : v);
      const doc = plain(r.numero_documento);
      const tel = plain(r.telefono);
      await db.query(
        `UPDATE kyc_records
            SET numero_documento = $2, numero_documento_hash = $3, fecha_nacimiento = $4,
                fecha_expedicion = $5, telefono = $6, telefono_hash = $7
          WHERE id = $1`,
        [r.id, encryptField(doc), blindIndex(doc), encryptField(plain(r.fecha_nacimiento)),
         encryptField(plain(r.fecha_expedicion)), encryptField(tel), blindIndex(tel)],
      );
    }
    await db.query('COMMIT');
    if (rows.length) console.log(`[kyc-crypto] ${rows.length} registro(s) cifrado(s).`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('[kyc-crypto] No se pudo cifrar los datos existentes:', err.message);
  process.exit(1);
});
